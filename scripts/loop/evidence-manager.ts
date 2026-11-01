import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processRun } from "./process";
import { getProjectSlug, resolveAnimusHome } from "../../packages/contracts/src/paths";
import { findRun } from "../loop-watch";
import { validateEvidenceCitations } from "./artifacts";
import {
  evidenceUrlMappingSchema,
  type CaptureRecord,
  type EvidenceUrlMapping,
  type HostBoundIdentities,
} from "./report-schema";
import { renderEvidenceContent } from "./pr-reporting";
import { publishPrEvidenceUpdate, type GhRunner } from "./pr-publication";

const RECOGNIZED_HOSTS = new Set([
  "github.com",
  "githubusercontent.com",
  "user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "avatars.githubusercontent.com",
  "media.githubusercontent.com",
]);

/**
 * Validates a hosted asset URL syntax, scheme, and destination safety.
 */
export function validateHostedAssetUrl(urlStr: string): { ok: boolean; reason?: string } {
  if (!urlStr || typeof urlStr !== "string") {
    return { ok: false, reason: "URL string is missing or empty" };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, reason: `Malformed URL: '${urlStr}'` };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `Insecure URL protocol '${parsed.protocol}'; https: required` };
  }

  if (parsed.username || parsed.password || parsed.port || /[\s<>"()]/.test(urlStr)) {
    return {
      ok: false,
      reason: "Asset URL contains credentials, a port, or unsafe Markdown characters",
    };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".local") ||
    !hostname.includes(".")
  ) {
    return { ok: false, reason: `Unsafe or local hostname rejected: '${hostname}'` };
  }

  // Check recognized asset destinations
  const isRecognized =
    RECOGNIZED_HOSTS.has(hostname) ||
    hostname.endsWith(".githubusercontent.com") ||
    hostname.endsWith(".github.com");

  if (!isRecognized) {
    return {
      ok: false,
      reason: `Only manually hosted GitHub assets (e.g., github.com/user-attachments/assets or *.githubusercontent.com) are supported; domain '${hostname}' rejected.`,
    };
  }

  if (
    hostname === "github.com" &&
    !/^\/(?:user-attachments\/assets\/|[^/]+\/[^/]+\/assets\/)/.test(parsed.pathname)
  ) {
    return {
      ok: false,
      reason: "GitHub URL must identify an uploaded image asset, not a repository page",
    };
  }
  return { ok: true };
}

/**
 * Resolves a run directory by runId or issue number.
 */
export async function resolveRunDirectory(
  repoRoot: string,
  options: { runId?: string; issue?: number },
): Promise<string> {
  const commonRes = await processRun(["git", "rev-parse", "--git-common-dir"], repoRoot, 10_000);
  const common =
    commonRes.exitCode === 0
      ? resolve(repoRoot, commonRes.stdout.trim())
      : resolve(repoRoot, ".git");
  const stateRoot = process.env.ANIMUS_HOME || process.env.ANIMUS_STATE_DIR || process.env.ANIMUS_RUNS_DIR
    ? join(resolveAnimusHome(), "projects", getProjectSlug(repoRoot))
    : join(common, "factory-local-loop");
  const runsDir = join(stateRoot, "runs");

  if (!existsSync(runsDir)) {
    throw new Error(`Runs directory not found: ${runsDir}`);
  }

  if (options.runId) {
    const directPath = join(runsDir, options.runId);
    if (existsSync(directPath)) return directPath;
  }

  if (options.issue !== undefined) return findRun(runsDir, options.issue);
  const entries = readdirSync(runsDir);
  for (const entry of entries) {
    const runPath = join(runsDir, entry);
    const stateFile = join(runPath, "state.json");
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf-8"));
        if (options.runId && (state.runId === options.runId || entry === options.runId)) {
          return runPath;
        }
        if (
          options.issue !== undefined &&
          (String(state.issue).match(/\/issues\/(\d+)\/?$/)?.[1] === String(options.issue) ||
            String(state.issue) === String(options.issue) ||
            state.issue === `#${options.issue}` ||
            state.branch?.includes(`issue-${options.issue}`))
        ) {
          return runPath;
        }
      } catch {}
    }
  }

  throw new Error(
    `No run matching ${options.runId ? `runId '${options.runId}'` : `issue #${options.issue}`} found in ${runsDir}`,
  );
}

/**
 * Loads the run state, existing captures, and any existing evidence mapping.
 */
export function loadRunEvidenceCaptures(runDirectory: string): {
  candidate: string;
  pr?: string;
  captures: CaptureRecord[];
  identities?: HostBoundIdentities;
} {
  const statePath = join(runDirectory, "state.json");
  if (!existsSync(statePath)) {
    throw new Error(`Run state file missing: ${statePath}`);
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  const candidate: string = state.candidate || state.candidateHead || "unknown";
  const pr: string | undefined = state.pr;

  let captures: CaptureRecord[] = [];

  // Check QA report captures
  const appCheckPath = join(runDirectory, "artifacts", "app-check.json");
  if (existsSync(appCheckPath)) {
    try {
      const qa = JSON.parse(readFileSync(appCheckPath, "utf-8"));
      if (Array.isArray(qa.captures)) {
        captures = qa.captures;
      }
    } catch {}
  }

  // Ingress validation: Both before/after state semantics validated at ingress, no N/A After for new UI
  for (const cap of captures) {
    if (cap.applicability === "applicable" || cap.applicability === "na_new_feature") {
      if (cap.afterStatus === "na") {
        throw new Error(
          `Invalid capture record '${cap.id}': After state cannot be N/A for new UI or applicable captures.`,
        );
      }
    }
  }

  // Load existing bound mapping if present
  const mappingPath = join(runDirectory, "artifacts", "evidence-mapping.json");
  if (existsSync(mappingPath)) {
    try {
      const boundMapping: EvidenceUrlMapping = JSON.parse(readFileSync(mappingPath, "utf-8"));
      for (const cap of captures) {
        const bound = boundMapping.mappings[cap.id];
        if (bound) {
          if (bound.beforeUrl) {
            cap.beforeHostedUrl = bound.beforeUrl;
          }
          if (bound.afterUrl) {
            cap.afterHostedUrl = bound.afterUrl;
          }
          cap.hostedUrlStatus = "supplied_unverified";
        }
      }
    } catch {}
  }

  return {
    candidate,
    pr,
    captures,
    identities: state.identities,
  };
}

/**
 * Binds a mapping file of evidence IDs -> hosted asset URLs to an explicit run/candidate.
 */
export function bindEvidenceMapping(params: {
  runDirectory: string;
  mappingFilePath: string;
  explicitCandidate?: string;
  submitter?: string;
}): { candidate: string; boundCount: number; mapping: EvidenceUrlMapping } {
  const { runDirectory, mappingFilePath, explicitCandidate, submitter } = params;

  if (!existsSync(mappingFilePath)) {
    throw new Error(`Mapping file does not exist: ${mappingFilePath}`);
  }

  const raw = readFileSync(mappingFilePath, "utf-8");
  let parsedJson: any;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Failed to parse mapping JSON file: ${err.message}`);
  }

  const runInfo = loadRunEvidenceCaptures(runDirectory);
  const targetCandidate = runInfo.candidate;

  // Validate candidate if supplied in mapping or parameter
  const mappingCandidate = parsedJson.candidate || explicitCandidate;
  if (
    !mappingCandidate ||
    mappingCandidate !== targetCandidate ||
    (explicitCandidate && explicitCandidate !== targetCandidate)
  ) {
    throw new Error(
      `Refusing stale-head mapping: mapping candidate '${mappingCandidate}' does not match run candidate '${targetCandidate}'.`,
    );
  }

  const rawMappings = parsedJson.mappings || parsedJson;
  const validatedMappings: EvidenceUrlMapping["mappings"] = {};
  let boundCount = 0;

  for (const [key, value] of Object.entries(rawMappings)) {
    if (key === "candidate") continue;

    const cap = runInfo.captures.find((c) => c.id === key);
    if (!cap) {
      throw new Error(
        `Unknown evidence ID '${key}' in mapping; not registered in run captures (${runInfo.captures.map((c) => c.id).join(", ") || "none"}).`,
      );
    }

    let beforeUrl: string | undefined;
    let afterUrl: string | undefined;

    if (typeof value === "string") {
      afterUrl = value;
    } else if (typeof value === "object" && value !== null) {
      const v = value as { beforeUrl?: string; afterUrl?: string };
      beforeUrl = v.beforeUrl;
      afterUrl = v.afterUrl;
    }

    for (const [side, url, status, artifact] of [
      ["Before", beforeUrl, cap.beforeStatus, cap.beforeArtifact],
      ["After", afterUrl, cap.afterStatus, cap.afterArtifact],
    ] as const) {
      if (!url) continue;
      if (status === "na")
        throw new Error(`Cannot bind ${side} URL to '${key}': ${side} state is N/A`);
      if (status !== "captured" || !artifact)
        throw new Error(`Cannot bind ${side} URL to '${key}': readable local capture required`);
      const check = validateEvidenceCitations(
        { lines: [{ id: key, evidence: [artifact] }] },
        join(runDirectory, "artifacts"),
      );
      if (!check.ok) throw new Error(`Cannot bind ${side} URL: ${check.problems.join("; ")}`);
    }

    if (!beforeUrl && !afterUrl) {
      throw new Error(`Mapping entry for '${key}' must supply at least beforeUrl or afterUrl.`);
    }

    if (beforeUrl) {
      const check = validateHostedAssetUrl(beforeUrl);
      if (!check.ok) {
        throw new Error(`Invalid beforeUrl for '${key}': ${check.reason}`);
      }
      if (
        cap.applicability === "na_new_feature" ||
        cap.applicability === "na_nonvisual" ||
        cap.beforeStatus === "na"
      ) {
        throw new Error(
          `Cannot bind beforeUrl to '${key}': Before state is N/A (${cap.applicability || cap.beforeStatus}).`,
        );
      }
      if (cap.beforeStatus === "captured") {
        if (!cap.beforeArtifact) {
          throw new Error(
            `Cannot bind beforeUrl to '${key}': capture has no beforeArtifact local capture.`,
          );
        }
        const beforeFilePath = resolve(runDirectory, "artifacts", cap.beforeArtifact);
        if (!existsSync(beforeFilePath)) {
          throw new Error(
            `Cannot bind beforeUrl to '${key}': local capture file '${cap.beforeArtifact}' does not exist at '${beforeFilePath}'.`,
          );
        }
      }
    }

    if (afterUrl) {
      const check = validateHostedAssetUrl(afterUrl);
      if (!check.ok) {
        throw new Error(`Invalid afterUrl for '${key}': ${check.reason}`);
      }
      if (cap.afterStatus === "na") {
        throw new Error(
          `Cannot bind afterUrl to '${key}': After state cannot be N/A for UI captures.`,
        );
      }
      if (!cap.afterArtifact) {
        throw new Error(
          `Cannot bind afterUrl to '${key}': capture has no afterArtifact local capture.`,
        );
      }
      const afterFilePath = resolve(runDirectory, "artifacts", cap.afterArtifact);
      if (!existsSync(afterFilePath)) {
        throw new Error(
          `Cannot bind afterUrl to '${key}': local capture file '${cap.afterArtifact}' does not exist at '${afterFilePath}'.`,
        );
      }
    }

    validatedMappings[key] = {
      beforeUrl,
      afterUrl,
      submitter: submitter || "operator",
      recordedAt: new Date().toISOString(),
    };
    boundCount++;
  }

  const mappingData: EvidenceUrlMapping = {
    candidate: targetCandidate,
    mappings: validatedMappings,
  };

  evidenceUrlMappingSchema.parse(mappingData);

  const destPath = join(runDirectory, "artifacts", "evidence-mapping.json");
  writeFileSync(destPath, JSON.stringify(mappingData, null, 2), "utf-8");

  return {
    candidate: targetCandidate,
    boundCount,
    mapping: mappingData,
  };
}

/**
 * Returns formatted preview of evidence captures and binding checklist.
 */
export function previewEvidenceCaptures(runDirectory: string): {
  candidate: string;
  captures: CaptureRecord[];
  checklist: string[];
} {
  const { candidate, captures } = loadRunEvidenceCaptures(runDirectory);

  const checklist: string[] = [
    `Evidence Checklist for Candidate: \`${candidate}\``,
    `Total Captures: ${captures.length}`,
    "",
  ];

  if (captures.length === 0) {
    checklist.push("No visual UI capture records registered for this run.");
  } else {
    for (const cap of captures) {
      const beforeDesc = cap.beforeHostedUrl
        ? `Hosted: ${cap.beforeHostedUrl}`
        : cap.beforeStatus === "na"
          ? "N/A"
          : cap.beforeStatus === "unavailable"
            ? "Unavailable"
            : `Local: ${cap.beforeArtifact || "pending upload"}`;

      const afterDesc = cap.afterHostedUrl
        ? `Hosted: ${cap.afterHostedUrl}`
        : `Local: ${cap.afterArtifact || "pending upload"}`;

      const statusIcon = cap.afterHostedUrl ? "✅ BOUND" : "⏳ PENDING UPLOAD";

      checklist.push(`- [${statusIcon}] **${cap.id}**: ${cap.scenario} (${cap.route})`);
      checklist.push(`    Before: ${beforeDesc}`);
      checklist.push(`    After:  ${afterDesc}`);
    }
  }

  return {
    candidate,
    captures,
    checklist,
  };
}

/**
 * Refreshes only the owned PR evidence region through an explicit publish option.
 */
export async function publishBoundEvidence(params: {
  repoRoot: string;
  runDirectory: string;
  noPush?: boolean;
  runner?: GhRunner;
}): Promise<{ ok: boolean; prUrl?: string; message: string }> {
  const { repoRoot, runDirectory, noPush, runner } = params;
  const runInfo = loadRunEvidenceCaptures(runDirectory);

  if (!runInfo.pr) {
    return {
      ok: false,
      message: "No pull request URL associated with this run in state.json",
    };
  }

  if (noPush) {
    const preview = previewEvidenceCaptures(runDirectory);
    return {
      ok: true,
      prUrl: runInfo.pr,
      message: `[NO-PUSH] Local preview generated cleanly; no forge writes performed.\n${preview.checklist.join("\n")}`,
    };
  }

  // Load QA report
  let qaReport: any = undefined;
  const appCheckPath = join(runDirectory, "artifacts", "app-check.json");
  if (existsSync(appCheckPath)) {
    try {
      qaReport = JSON.parse(readFileSync(appCheckPath, "utf-8"));
      qaReport.captures = runInfo.captures;
    } catch {}
  }

  if (!runInfo.identities)
    throw new Error("Cannot publish evidence without host-recorded Git identities");
  const identities: HostBoundIdentities = runInfo.identities;

  // Render new evidence block with bound hosted URLs
  const newEvidenceBlock = renderEvidenceContent({
    identities,
    qaReport,
    captures: runInfo.captures,
  });

  const pubResult = await publishPrEvidenceUpdate({
    repoRoot,
    pr: runInfo.pr,
    candidate: runInfo.candidate,
    newEvidenceContent: newEvidenceBlock,
    runDirectory,
    runner,
  });

  return {
    ok: pubResult.ok,
    prUrl: runInfo.pr,
    message: pubResult.message,
  };
}
