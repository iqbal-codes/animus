import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processRun } from "./process";
import { loadIssueDossier, recordLapAttempt } from "./dossier";
import type { LocalLoopResult, LocalLoopStatus } from "./types";

export interface PrCheckItem {
  name: string;
  workflow?: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  state: string;
  link?: string;
  description?: string;
}

export interface PrCiAssessment {
  status: "pass" | "fail" | "pending" | "no_checks" | "error";
  checks: PrCheckItem[];
  failedChecks: PrCheckItem[];
  summary: string;
}

export type GhRunner = (
  cmd: string[],
  cwd?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export function parseGhChecksOutput(stdout: string, stderr = ""): PrCiAssessment {
  const trimmedOut = stdout.trim();
  if (!trimmedOut) {
    if (/no checks reported|no commit found/i.test(stderr)) {
      return {
        status: "no_checks",
        checks: [],
        failedChecks: [],
        summary: "No CI checks reported on PR.",
      };
    }
    if (stderr.trim()) {
      return {
        status: "error",
        checks: [],
        failedChecks: [],
        summary: stderr.trim(),
      };
    }
    return {
      status: "no_checks",
      checks: [],
      failedChecks: [],
      summary: "No CI checks reported on PR.",
    };
  }

  let rawList: any[];
  try {
    rawList = JSON.parse(trimmedOut);
    if (!Array.isArray(rawList)) {
      throw new Error("Expected JSON array of checks");
    }
  } catch {
    return {
      status: "error",
      checks: [],
      failedChecks: [],
      summary: stderr.trim() || "Failed to parse CI checks JSON output",
    };
  }

  if (rawList.length === 0) {
    return {
      status: "no_checks",
      checks: [],
      failedChecks: [],
      summary: "No CI checks found for PR.",
    };
  }

  const checks: PrCheckItem[] = rawList.map((item) => {
    const rawBucket = String(item.bucket ?? "").toLowerCase();
    let bucket: PrCheckItem["bucket"] = "pending";
    if (rawBucket === "pass" || rawBucket === "success") bucket = "pass";
    else if (rawBucket === "fail" || rawBucket === "failure") bucket = "fail";
    else if (rawBucket === "cancel" || rawBucket === "cancelled") bucket = "cancel";
    else if (rawBucket === "skipping" || rawBucket === "skipped") bucket = "skipping";
    else bucket = "pending";

    return {
      name: String(item.name ?? "unnamed_check"),
      workflow: item.workflow ? String(item.workflow) : undefined,
      bucket,
      state: String(item.state ?? item.status ?? bucket.toUpperCase()),
      link: item.link ? String(item.link) : undefined,
      description: item.description ? String(item.description) : undefined,
    };
  });

  const failedChecks = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
  const pendingChecks = checks.filter((c) => c.bucket === "pending");

  if (failedChecks.length > 0) {
    return {
      status: "fail",
      checks,
      failedChecks,
      summary: `CI checks failed: ${failedChecks.map((c) => c.name).join(", ")}`,
    };
  }

  if (pendingChecks.length > 0) {
    return {
      status: "pending",
      checks,
      failedChecks: [],
      summary: `CI checks pending (${pendingChecks.length}/${checks.length}): ${pendingChecks.map((c) => c.name).join(", ")}`,
    };
  }

  return {
    status: "pass",
    checks,
    failedChecks: [],
    summary: `All ${checks.length} CI checks passed cleanly.`,
  };
}

export async function checkPrCiStatus(
  pr: string | number,
  options: { cwd?: string; run?: GhRunner } = {},
): Promise<PrCiAssessment> {
  const runner =
    options.run ??
    ((cmd, cwd) => processRun(cmd, cwd ?? process.cwd(), 30_000));

  const result = await runner(
    ["gh", "pr", "checks", String(pr), "--json", "bucket,name,state,workflow,link,description"],
    options.cwd,
  );

  return parseGhChecksOutput(result.stdout, result.stderr);
}

export async function pollPrCiStatus(
  pr: string | number,
  options: {
    maxWaitSeconds?: number;
    pollIntervalSeconds?: number;
    cwd?: string;
    run?: GhRunner;
  } = {},
): Promise<PrCiAssessment> {
  const maxWaitSeconds = options.maxWaitSeconds ?? 0;
  const pollIntervalSeconds = options.pollIntervalSeconds ?? 5;

  if (maxWaitSeconds <= 0) {
    return checkPrCiStatus(pr, options);
  }

  const deadline = Date.now() + maxWaitSeconds * 1000;
  let lastAssessment = await checkPrCiStatus(pr, options);

  while (Date.now() < deadline) {
    if (lastAssessment.status === "fail" || lastAssessment.status === "pass") {
      return lastAssessment;
    }
    const sleepMs = Math.min(
      pollIntervalSeconds * 1000,
      Math.max(100, deadline - Date.now()),
    );
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    lastAssessment = await checkPrCiStatus(pr, options);
  }

  return lastAssessment;
}

export interface ReconciledCiResult {
  issueNumber: number;
  runId: string;
  previousStatus: "waiting_approval";
  newStatus: "sent_back" | "needs_owner";
  failedChecks: string[];
}

export interface ReconcileWaitingApprovalOptions {
  ghRun?: GhRunner;
  maxLaps?: number;
  checkPrCi?: typeof checkPrCiStatus;
}

export async function reconcileWaitingApprovalPrCi(
  runsDir: string,
  root: string,
  options: ReconcileWaitingApprovalOptions = {},
): Promise<ReconciledCiResult[]> {
  const results: ReconciledCiResult[] = [];
  if (!existsSync(runsDir)) return results;

  const runner =
    options.ghRun ??
    ((cmd, cwd) => processRun(cmd, cwd ?? root, 30_000));
  const checkCi = options.checkPrCi ?? checkPrCiStatus;
  const stateRoot = resolve(runsDir, "..");
  const maxLaps = options.maxLaps ?? 3;

  let entries: string[] = [];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const statePath = join(runsDir, entry, "state.json");
    if (!existsSync(statePath)) continue;

    let state: LocalLoopResult;
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      continue;
    }

    if (state.status !== "waiting_approval" || !state.pr) continue;

    const issueMatch = /\/issues\/(\d+)$/.exec(state.issue ?? "");
    if (!issueMatch || !issueMatch[1]) continue;
    const issueNumber = Number(issueMatch[1]);

    // Verify PR is still OPEN before evaluating CI
    try {
      const prView = await runner(["gh", "pr", "view", String(state.pr), "--json", "state"], root);
      if (prView.exitCode === 0) {
        const prData = JSON.parse(prView.stdout);
        if (prData.state && String(prData.state).toUpperCase() !== "OPEN") {
          continue;
        }
      }
    } catch {
      // If PR view fails, continue conservatively
    }

    const assessment = await checkCi(state.pr, { cwd: root, run: runner });
    if (assessment.status === "fail") {
      const dossier = loadIssueDossier(stateRoot, issueNumber);
      const currentLap = state.lap ?? (dossier?.attempts.length ?? 1);
      const isExceeded = currentLap >= maxLaps;
      const newStatus: LocalLoopStatus = isExceeded ? "needs_owner" : "sent_back";

      state.status = newStatus;
      const tmpPath = `${statePath}.tmp-${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
      renameSync(tmpPath, statePath);

      if (newStatus === "needs_owner") {
        try {
          await runner(
            [
              "gh",
              "issue",
              "edit",
              String(issueNumber),
              "--add-label",
              "ready-for-human",
              "--remove-label",
              "ready-for-agent",
            ],
            root,
          );
        } catch {}
      }

      const failedList = assessment.failedChecks.map((c) => c.name);
      const commentLines = [
        `### Loop CI Watcher: CI checks failed on candidate \`${state.candidate || "HEAD"}\``,
        "",
        "⚠️ **Remote CI checks failed after initial review.**",
        "",
        "#### ❌ Failed Checks:",
        ...assessment.failedChecks.map(
          (c) => `- **${c.workflow ? c.workflow + " / " : ""}${c.name}** (\`${c.state}\`): ${c.link || c.description || "Failed"}`,
        ),
        "",
        newStatus === "needs_owner"
          ? "⛔ **Exceeded maximum laps.** Escalating to human owner (`ready-for-human`)."
          : "🔄 **Automatically returning this PR to the loop for builder auto-fix.**",
      ];

      try {
        await runner(["gh", "pr", "comment", String(state.pr), "--body", commentLines.join("\n")], root);
      } catch {}

      recordLapAttempt(
        stateRoot,
        {
          issueNumber,
          issueTitle: dossier?.issueTitle ?? `Issue #${issueNumber}`,
          issueUrl: state.issue,
          branch: state.branch,
          prUrl: state.pr,
        },
        {
          runId: state.runId,
          timestamp: new Date().toISOString(),
          status: newStatus,
          candidateHead: state.candidate,
          changedFiles: [],
          failedStage: "ci",
          reviewFindings: assessment.failedChecks.map(
            (c) => `CI Check [${c.workflow ? c.workflow + " / " : ""}${c.name}] failed: ${c.link || c.state}`,
          ),
          qaFailures: [],
        },
      );

      results.push({
        issueNumber,
        runId: state.runId,
        previousStatus: "waiting_approval",
        newStatus: newStatus as "sent_back" | "needs_owner",
        failedChecks: failedList,
      });
    }
  }

  return results;
}
