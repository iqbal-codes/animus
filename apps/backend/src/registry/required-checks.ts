import type { ForgeAdapter, ForgeCheckRun } from "./forge";

export interface RequiredCheckObservation {
  name: string;
  status: string;
  conclusion: string | null;
}

export type RequiredCheckBlockerCode = "missing" | "pending" | "failed" | "unreadable";

export interface RequiredCheckBlocker {
  code: RequiredCheckBlockerCode;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  message: string;
}

export interface RequiredCheckReadback {
  /** True when the forge cannot read branch protection or check runs at all. */
  unreadable: boolean;
  required: string[];
  checks: RequiredCheckObservation[];
  blockers: RequiredCheckBlocker[];
}

/**
 * Single remote required-CI readback used by every gate. It reads the target
 * branch's branch-protection contexts and the check runs reported for the exact
 * candidate head. Missing, pending, failed or unknown conclusions are blockers;
 * an empty protected-check list means there is no remote CI to verify.
 */
export async function readRequiredChecks(
  forge: ForgeAdapter,
  repo: string,
  branch: string,
  ref: string | null,
): Promise<RequiredCheckReadback> {
  if (
    typeof forge.getRequiredStatusChecks !== "function" ||
    typeof forge.listCheckRuns !== "function"
  ) {
    return {
      unreadable: true,
      required: [],
      checks: [],
      blockers: [
        {
          code: "unreadable",
          name: null,
          status: null,
          conclusion: null,
          message: "The forge transport cannot read required status checks",
        },
      ],
    };
  }

  let required: string[];
  try {
    required = await forge.getRequiredStatusChecks(repo, branch);
  } catch (error) {
    return {
      unreadable: true,
      required: [],
      checks: [],
      blockers: [
        {
          code: "unreadable",
          name: null,
          status: null,
          conclusion: null,
          message: `Could not read required checks for ${branch}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }

  if (required.length === 0) {
    return { unreadable: false, required, checks: [], blockers: [] };
  }
  if (!ref) {
    return {
      unreadable: false,
      required,
      checks: [],
      blockers: required.map((name) => ({
        code: "missing",
        name,
        status: "missing",
        conclusion: null,
        message: `Required check '${name}' has no candidate head to report for`,
      })),
    };
  }

  let runs: ForgeCheckRun[];
  try {
    runs = await forge.listCheckRuns(repo, ref);
  } catch (error) {
    return {
      unreadable: true,
      required,
      checks: [],
      blockers: [
        {
          code: "unreadable",
          name: null,
          status: null,
          conclusion: null,
          message: `Could not read check runs for ${ref}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }

  const checks: RequiredCheckObservation[] = [];
  const blockers: RequiredCheckBlocker[] = [];
  for (const name of required) {
    const matches = runs.filter((item) => item.name === name);
    const latest = matches.length > 0 ? matches[matches.length - 1]! : null;
    checks.push({
      name,
      status: latest?.status ?? "missing",
      conclusion: latest?.conclusion ?? null,
    });
    if (!latest) {
      blockers.push({
        code: "missing",
        name,
        status: "missing",
        conclusion: null,
        message: `Required check '${name}' has not reported for candidate ${ref}`,
      });
      continue;
    }
    if (latest.status !== "completed") {
      blockers.push({
        code: "pending",
        name,
        status: latest.status,
        conclusion: latest.conclusion,
        message: `Required check '${name}' is still ${latest.status}`,
      });
      continue;
    }
    const conclusion = (latest.conclusion ?? "").toLowerCase();
    if (!["success", "neutral", "skipped"].includes(conclusion)) {
      blockers.push({
        code: "failed",
        name,
        status: latest.status,
        conclusion: latest.conclusion,
        message: `Required check '${name}' concluded ${latest.conclusion ?? "unknown"}`,
      });
    }
  }
  return { unreadable: false, required, checks, blockers };
}
