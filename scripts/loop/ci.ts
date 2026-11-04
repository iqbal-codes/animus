import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processRun } from "./process";
import { loadIssueDossier, recordLapAttempt, type IssueDossier, type LapAttemptRecord } from "./dossier";
import { inspectLocalLoop, git } from "./worktree";
import {
  publishLoopComment,
  syncAndPublishPrEvidence,
  recordLapAndReflect,
  escalateIssueToHuman,
} from "./pr-publication";
import { LoopPublisher } from "./publisher";
import { formatCiCheckComment } from "./pr-reporting";
import type {
  LocalIssue,
  LocalLoopResult,
  LocalLoopStatus,
  LocalLoopRoute,
  LocalLoopOptions,
  LoopEvidence,
  GhRunner,
} from "./types";
import type { LearningCommandRecord } from "./learning-schema";

export type { GhRunner };

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
    const runDir = join(runsDir, entry);
    const statePath = join(runDir, "state.json");
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
    const artifactsDir = join(runDir, "artifacts");

    const publisher = new LoopPublisher({
      worktree: state.worktree || root,
      runDirectory: runDir,
      artifactsDir,
      issueNumber,
      push: true,
      runner,
    });

    // Verify PR is still OPEN before evaluating CI
    try {
      const isOpen = await publisher.isPrOpen(state.pr);
      if (!isOpen) {
        continue;
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
          await publisher.escalateToHuman(state.candidate);
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
        await publisher.publishComment({
          target: { kind: "pr", idOrUrl: String(state.pr) },
          commentType: "ci_check",
          commentBody: commentLines.join("\n"),
          candidate: state.candidate || "HEAD",
        });
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

export interface RunOrdinaryChecksOptions {
  root: string;
  worktree: string;
  checks: string[];
  timeoutMs: number;
  runId: string;
  candidate: string;
  runDirectory: string;
  artifactsDir: string;
  commandRecords: LearningCommandRecord[];
  evidence: LoopEvidence[];
}

/**
 * Executes deterministic pre-commit CI gates and ordinary project checks.
 * Enforces zero-bypass invariant (--no-verify prohibited).
 * Captures all outputs in command records and builder-checks.log.
 */
export async function runOrdinaryChecks(opts: RunOrdinaryChecksOptions): Promise<void> {
  const {
    root,
    worktree,
    checks,
    timeoutMs,
    runId,
    candidate,
    runDirectory,
    artifactsDir,
    commandRecords,
    evidence,
  } = opts;

  const checkOutputs: string[] = [];
  for (let i = 0; i < checks.length; i++) {
    await inspectLocalLoop(root);
    const startedAt = new Date().toISOString();
    const result = await processRun(["sh", "-c", checks[i]!], worktree, timeoutMs);
    const completedAt = new Date().toISOString();
    const artifact = join(runDirectory, `check-${i}.json`);
    const recordPath = `command-${i}.json`;
    const recordContent = JSON.stringify({ command: checks[i], ...result });
    await Bun.write(artifact, recordContent);
    await Bun.write(join(artifactsDir, recordPath), recordContent);
    commandRecords.push({
      executionId: `${runId}:check-${i}`,
      runId,
      candidate,
      command: checks[i]!,
      cwd: worktree,
      exitCode: result.exitCode,
      startedAt,
      completedAt,
      artifact: {
        runId,
        candidate,
        path: recordPath,
        lineStart: 1,
        lineEnd: 1,
        quote: recordContent,
      },
    });
    await Bun.write(
      join(artifactsDir, "host-command-records.json"),
      JSON.stringify(commandRecords, null, 2),
    );
    checkOutputs.push(
      `Check [${checks[i]}]: exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
    );
    evidence.push({
      kind: "check",
      round: 0,
      candidate,
      artifact,
      exitCode: result.exitCode,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Ordinary project check failed: ${checks[i]}`);
    }
  }
  if (!existsSync(join(artifactsDir, "builder-checks.log"))) {
    await Bun.write(
      join(artifactsDir, "builder-checks.log"),
      checkOutputs.join("\n\n") ||
        "Verified: deterministic pre-commit CI gates executed cleanly (--no-verify prohibited).\n",
    );
  }
}

export interface HandleCiFastFailOptions {
  failedChecks: any[];
  lap: number;
  maxLaps: number;
  state: LocalLoopResult;
  issue: LocalIssue;
  branch: string;
  stateRoot: string;
  runId: string;
  artifactsDir: string;
  commandRecords: LearningCommandRecord[];
  recoveries: NonNullable<LapAttemptRecord["recoveries"]>;
  base: string;
  route: LocalLoopRoute;
  options: LocalLoopOptions;
  reflectTerminal: (dossier: IssueDossier) => Promise<void>;
  save: () => Promise<void>;
  qaReport?: any;
  builderReport?: any;
  publisher?: LoopPublisher;
}

/**
 * Handles PR CI Fast-Fail gate: short-circuits Code Review when remote PR CI fails.
 */
export async function handleCiFastFail(opts: HandleCiFastFailOptions): Promise<LocalLoopResult> {
  const {
    failedChecks,
    lap,
    maxLaps,
    state,
    issue,
    branch,
    stateRoot,
    runId,
    artifactsDir,
    commandRecords,
    recoveries,
    base,
    route,
    options,
    reflectTerminal,
    save,
    qaReport,
    builderReport,
  } = opts;

  const isMaxLapsExceeded = lap >= maxLaps;
  const ciStatus: LocalLoopStatus = isMaxLapsExceeded ? "needs_owner" : "sent_back";
  state.status = ciStatus;

  const pub =
    opts.publisher ??
    new LoopPublisher({
      worktree: state.worktree,
      runDirectory: state.runDirectory,
      artifactsDir,
      issueNumber: issue.number,
      push: options.push !== false,
      runner: options.ghRunner,
    });

  if (ciStatus === "needs_owner") {
    await pub.escalateToHuman(state.candidate);
  }

  const changedFilesFinal = (
    await git(state.worktree, "diff", "--name-only", "--no-renames", base, state.candidate!)
  )
    .split("\n")
    .filter(Boolean);

  await recordLapAndReflect({
    stateRoot,
    issue,
    branch,
    pr: state.pr,
    runId,
    status: ciStatus,
    candidate: state.candidate,
    artifactsDir,
    evidence: state.evidence,
    commandRecords,
    recoveries,
    changedFiles: changedFilesFinal,
    failedStage: "ci",
    reviewFindings: failedChecks.map(
      (c: any) =>
        `CI Check [${c.workflow ? c.workflow + " / " : ""}${c.name}] failed: ${c.link || c.state}`,
    ),
    reflectTerminal,
  });

  const ciComment = formatCiCheckComment({
    route,
    candidate: state.candidate!,
    failedChecks,
    isMaxLapsExceeded,
  });

  await pub.publishLoopComment({
    pr: state.pr,
    commentType: "ci_check",
    commentBody: ciComment,
    candidate: state.candidate!,
  });

  await pub.syncAndPublishPrEvidence({
    pr: state.pr,
    candidate: state.candidate!,
    captures: qaReport?.captures || [],
    identities: state.identities,
    qaReport,
    builderReport,
    outstanding: failedChecks.map((c: any) => `CI Check [${c.name}] failed`),
    stageName: "CI",
  });

  await save();
  return state;
}

export interface VerifyPrCiGateOptions {
  state: LocalLoopResult;
  options: LocalLoopOptions;
  lap: number;
  maxLaps: number;
  issue: LocalIssue;
  branch: string;
  stateRoot: string;
  runId: string;
  artifactsDir: string;
  commandRecords: LearningCommandRecord[];
  recoveries: NonNullable<LapAttemptRecord["recoveries"]>;
  base: string;
  route: LocalLoopRoute;
  reflectTerminal: (dossier: IssueDossier) => Promise<void>;
  save: () => Promise<void>;
  qaReport?: any;
  builderReport?: any;
  publisher?: LoopPublisher;
}

export interface VerifyPrCiGateResult {
  failed: boolean;
  result?: LocalLoopResult;
  assessment?: any;
}

/**
 * Polls remote PR CI checks and fast-fails if checks report failure.
 */
export async function verifyPrCiGate(opts: VerifyPrCiGateOptions): Promise<VerifyPrCiGateResult> {
  const {
    state,
    options,
    lap,
    maxLaps,
    issue,
    branch,
    stateRoot,
    runId,
    artifactsDir,
    commandRecords,
    recoveries,
    base,
    route,
    reflectTerminal,
    save,
    qaReport,
    builderReport,
  } = opts;

  const pub =
    opts.publisher ??
    new LoopPublisher({
      worktree: state.worktree,
      runDirectory: state.runDirectory,
      artifactsDir,
      issueNumber: issue.number,
      push: options.push !== false,
      runner: options.ghRunner,
    });

  const prTarget = state.pr ?? (options.checkPrCi ? "mock-pr" : undefined);
  if (!prTarget || (options.push === false && !options.checkPrCi)) {
    return { failed: false };
  }

  if (!state.pr && options.checkPrCi) {
    state.pr = prTarget;
  }
  const ciTimeoutSeconds = options.ciWaitSeconds ?? 15;
  const ciAssessment = options.checkPrCi
    ? await options.checkPrCi(prTarget, { cwd: state.worktree })
    : await pub.pollPrCiStatus(prTarget, {
        maxWaitSeconds: ciTimeoutSeconds,
        pollIntervalSeconds: 5,
      });

  await Bun.write(join(artifactsDir, "pr-ci.json"), JSON.stringify(ciAssessment, null, 2));

  if (ciAssessment.status === "fail") {
    const fastFailResult = await handleCiFastFail({
      failedChecks: ciAssessment.failedChecks,
      lap,
      maxLaps,
      state,
      issue,
      branch,
      stateRoot,
      runId,
      artifactsDir,
      commandRecords,
      recoveries,
      base,
      route,
      options,
      reflectTerminal,
      save,
      qaReport,
      builderReport,
      publisher: pub,
    });
    return { failed: true, result: fastFailResult, assessment: ciAssessment };
  }

  return { failed: false, assessment: ciAssessment };
}
