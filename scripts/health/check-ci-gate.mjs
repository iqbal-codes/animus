import { fileURLToPath } from "node:url";

export const DEFAULT_REQUIRED_JOBS = ["gate-static", "gate-verify", "gate-build"];

/**
 * Checks whether a given job was authorized to be skipped.
 * A skip is authorized ONLY if:
 * 1. Gates configuration or job output explicitly evaluated to "false" (or false)
 * 2. Or the run is an authorized draft pull request skip (gates.isDraft / draft)
 *
 * @param {string} jobName
 * @param {any} jobResult
 * @param {any} gates
 * @returns {boolean}
 */
function isAuthorizedSkip(jobName, jobResult, gates) {
  // Check if draft PR skip
  if (gates && typeof gates === "object") {
    if (gates.isDraft === true || gates.draft === true || gates.is_draft === true) {
      return true;
    }
  }
  if (process.env.GITHUB_EVENT_PULL_REQUEST_DRAFT === "true") {
    return true;
  }

  // Check job need outputs if present
  if (jobResult && typeof jobResult === "object" && jobResult.outputs) {
    for (const [, val] of Object.entries(jobResult.outputs)) {
      if (val === "false" || val === false) {
        return true;
      }
    }
  }

  // Check gates parameter
  if (!gates) return false;

  if (typeof gates === "boolean") {
    return gates === false;
  }
  if (typeof gates === "string") {
    return gates.toLowerCase().trim() === "false";
  }

  if (typeof gates === "object") {
    // 1. Direct key match: gates["gate-build"] === "false" | false
    const direct = gates[jobName];
    if (direct === "false" || direct === false) return true;
    if (direct && typeof direct === "object") {
      if (
        direct.shouldRun === false ||
        direct.shouldRun === "false" ||
        direct.should_run === false ||
        direct.should_run === "false" ||
        direct.enabled === false ||
        direct.enabled === "false" ||
        direct.run === false ||
        direct.run === "false" ||
        direct.output === false ||
        direct.output === "false"
      ) {
        return true;
      }
    }

    // 2. Normalized key match (e.g. gate_build, gateBuild, run_gate_build, run-gate-build)
    const normalizedJob = jobName.toLowerCase().replace(/[-_]/g, "");
    for (const [k, v] of Object.entries(gates)) {
      if (k === "requiredJobs") continue;
      const normalizedKey = k.toLowerCase().replace(/[-_]/g, "");
      if (
        normalizedKey === normalizedJob ||
        normalizedKey === `run${normalizedJob}` ||
        normalizedKey === `gate${normalizedJob}` ||
        normalizedKey === `shouldrun${normalizedJob}` ||
        normalizedKey === `${normalizedJob}enabled`
      ) {
        if (v === "false" || v === false) return true;
        if (v && typeof v === "object") {
          if (
            v.shouldRun === false ||
            v.shouldRun === "false" ||
            v.should_run === false ||
            v.should_run === "false" ||
            v.enabled === false ||
            v.enabled === "false" ||
            v.run === false ||
            v.run === "false" ||
            v.output === false ||
            v.output === "false"
          ) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Pure, fail-closed aggregate CI gate evaluator.
 *
 * @param {Record<string, any> | string | null} [needs] - GitHub Actions `needs` context (or JSON string).
 * @param {Record<string, any> | string[] | string | boolean} [gates] - Gate decisions or required jobs override.
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function evaluateCiGateOutcome(needs, gates) {
  const failures = [];

  // Parse needs if provided as string
  let parsedNeeds = needs;
  if (typeof parsedNeeds === "string") {
    try {
      parsedNeeds = JSON.parse(parsedNeeds);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        failures: [`Invalid JSON passed for needs context: ${msg}`],
      };
    }
  }

  // Parse gates if provided as string
  let parsedGates = gates;
  if (typeof parsedGates === "string") {
    try {
      parsedGates = JSON.parse(parsedGates);
    } catch {
      // Keep as string if not valid JSON (e.g. "false")
    }
  }

  if (!parsedNeeds || typeof parsedNeeds !== "object" || Array.isArray(parsedNeeds)) {
    return {
      ok: false,
      failures: ["Upstream needs context is missing or invalid"],
    };
  }

  // Determine required jobs
  let requiredJobs = DEFAULT_REQUIRED_JOBS;
  if (Array.isArray(parsedGates)) {
    requiredJobs = parsedGates;
  } else if (
    parsedGates &&
    typeof parsedGates === "object" &&
    Array.isArray(parsedGates.requiredJobs)
  ) {
    requiredJobs = parsedGates.requiredJobs;
  }

  for (const job of requiredJobs) {
    const jobEntry = parsedNeeds[job];
    if (jobEntry === undefined) {
      failures.push(`Job '${job}' is missing from upstream needs context`);
      continue;
    }

    let status = "";
    if (typeof jobEntry === "string") {
      status = jobEntry.toLowerCase().trim();
    } else if (jobEntry && typeof jobEntry === "object") {
      status = typeof jobEntry.result === "string" ? jobEntry.result.toLowerCase().trim() : "";
    }

    if (!status) {
      failures.push(`Job '${job}' result status is missing or undefined`);
      continue;
    }

    if (status === "success") {
      continue;
    }

    if (status === "failure") {
      failures.push(`Job '${job}' failed with result 'failure'`);
      continue;
    }

    if (status === "cancelled") {
      failures.push(`Job '${job}' was cancelled`);
      continue;
    }

    if (status === "skipped") {
      if (isAuthorizedSkip(job, jobEntry, parsedGates)) {
        continue;
      }
      failures.push(`Job '${job}' was unexpectedly skipped without an explicit false gate output`);
      continue;
    }

    failures.push(`Job '${job}' finished with unexpected result '${status}'`);
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

const isMain =
  (typeof Bun !== "undefined" && Boolean(import.meta.main)) ||
  (process.argv[1] !== undefined &&
    (process.argv[1].endsWith("check-ci-gate.mjs") ||
      fileURLToPath(import.meta.url) === process.argv[1]));

if (isMain) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: node scripts/health/check-ci-gate.mjs [--needs '<json>'] [--gates '<json>']",
    );
    console.log("Evaluates aggregate CI gate outcomes from upstream jobs.");
    process.exit(0);
  }

  let needsInput = process.env.NEEDS_CONTEXT || process.env.CI_NEEDS;
  let gatesInput = process.env.GATES_CONTEXT || process.env.CI_GATES;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--needs" && process.argv[i + 1]) {
      needsInput = process.argv[++i];
    } else if (arg.startsWith("--needs=")) {
      needsInput = arg.slice("--needs=".length);
    } else if (arg === "--gates" && process.argv[i + 1]) {
      gatesInput = process.argv[++i];
    } else if (arg.startsWith("--gates=")) {
      gatesInput = arg.slice("--gates=".length);
    } else if (arg.startsWith("{")) {
      if (!needsInput) needsInput = arg;
      else if (!gatesInput) gatesInput = arg;
    }
  }

  const evaluation = evaluateCiGateOutcome(needsInput, gatesInput);
  if (evaluation.ok) {
    console.log("CI aggregate gate evaluation passed: all required upstream jobs succeeded.");
    process.exit(0);
  } else {
    console.error("CI aggregate gate evaluation failed:");
    for (const f of evaluation.failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }
}
