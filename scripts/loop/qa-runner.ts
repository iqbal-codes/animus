import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./worktree";
import { validateEvidenceCitations } from "./artifacts";
import { formatQaFailureComment } from "./pr-reporting";
import { recordLapAndReflect } from "./pr-publication";
import { LoopPublisher } from "./publisher";
import type {
  LocalIssue,
  LocalLoopResult,
  LocalLoopRoute,
  LocalLoopStatus,
  LocalLoopOptions,
  LoopEvidence,
  GhRunner,
} from "./types";
import type { IssueDossier, LapAttemptRecord } from "./dossier";
import type { LearningCommandRecord } from "./learning-schema";

export interface ExecuteBlackBoxQaOptions {
  root: string;
  candidate: string;
  identities: NonNullable<LocalLoopResult["identities"]>;
  runDirectory: string;
  artifactsDir?: string;
  handoffDir?: string;
  worktree: string;
  pr?: string;
  push?: boolean;
  builderReport?: any;
  publisher?: LoopPublisher;
  issueNumber?: number;
  ghRunner?: GhRunner;
  invokeQa: (
    qaCwd: string,
    extraVars: Record<string, string>,
    testedHead: string,
  ) => Promise<any>;
}

export interface BlackBoxQaResult {
  qaReport: any;
  evidenceOk: string;
  qaWorktreeDir: string;
  testedIntegrationHead: string;
}

/**
 * Prepares an isolated detached worktree for Black-Box QA, tests candidate integration
 * against target base tip, executes QA evaluation, persists reports, and syncs PR evidence.
 */
export async function executeBlackBoxQa(opts: ExecuteBlackBoxQaOptions): Promise<BlackBoxQaResult> {
  const {
    root,
    candidate,
    identities,
    runDirectory,
    artifactsDir,
    handoffDir,
    worktree,
    pr,
    push = false,
    builderReport,
    invokeQa,
  } = opts;
  const qaWorktreeDir = join(runDirectory, "qa-worktree");
  let testedIntegrationHead = candidate;
  let mergeConflictOccurred = false;

  try {
    await git(root, "worktree", "add", "--detach", qaWorktreeDir, candidate);
    if (
      identities.targetBaseTip &&
      identities.mergeBase &&
      identities.targetBaseTip !== identities.mergeBase
    ) {
      try {
        await git(qaWorktreeDir, "merge", "--no-edit", identities.targetBaseTip);
        testedIntegrationHead = (await git(qaWorktreeDir, "rev-parse", "HEAD")).trim();
      } catch (mergeErr) {
        mergeConflictOccurred = true;
        console.error(
          "Warning: Merge conflict with base branch during host integration merge:",
          mergeErr,
        );
      }
    }
  } catch (worktreeErr) {
    console.error(
      "Warning: Could not create isolated QA worktree, falling back to delivery worktree:",
      worktreeErr,
    );
  }
  identities.testedHead = testedIntegrationHead;

  let qaReport: any;
  if (mergeConflictOccurred) {
    qaReport = {
      head: testedIntegrationHead,
      overall: "FAIL",
      summary: "Merge conflict encountered integrating candidate with default base branch",
      lines: [
        {
          id: "C0",
          kind: "criterion",
          verdict: "FAIL",
          text: "Merge conflict with base branch",
          evidence: [],
        },
      ],
      noticed: [],
      captures: [],
      passed: false,
    };
  } else {
    const activeQaCwd = existsSync(qaWorktreeDir) ? qaWorktreeDir : worktree;
    qaReport = await invokeQa(
      activeQaCwd,
      {
        tested_head: testedIntegrationHead,
        base_tip: identities.targetBaseTip,
        merge_base: identities.mergeBase,
        merged_with: identities.targetBaseTip,
      },
      testedIntegrationHead,
    );
  }

  if (existsSync(qaWorktreeDir)) {
    try {
      const qaHeadAfter = (await git(qaWorktreeDir, "rev-parse", "HEAD")).trim();
      const qaDirty = (await git(qaWorktreeDir, "status", "--porcelain")).trim();
      if (!qaDirty && qaHeadAfter === testedIntegrationHead) {
        await git(root, "worktree", "remove", "--force", qaWorktreeDir).catch(() => {});
      } else {
        console.log(`Preserving QA worktree at ${qaWorktreeDir} for diagnosis`);
      }
    } catch {}
  }

  let evidenceOk = "true";
  if (handoffDir && artifactsDir) {
    await Bun.write(join(handoffDir, "app-check.json"), JSON.stringify(qaReport, null, 2));
    await Bun.write(join(artifactsDir, "app-check.json"), JSON.stringify(qaReport, null, 2));

    const { ok: evidenceOkBool, problems: evidenceProblems } = validateEvidenceCitations(
      qaReport,
      artifactsDir,
    );
    await Bun.write(join(handoffDir, "evidence-problems.txt"), evidenceProblems.join("\n"));
    evidenceOk = evidenceOkBool ? "true" : "false";

    const pub =
      opts.publisher ??
      new LoopPublisher({
        worktree,
        runDirectory,
        artifactsDir: artifactsDir || join(runDirectory, "artifacts"),
        issueNumber: opts.issueNumber ?? 0,
        push,
        runner: opts.ghRunner,
      });

    await pub.syncAndPublishPrEvidence({
      pr,
      candidate,
      captures: qaReport?.captures || [],
      identities,
      qaReport,
      builderReport,
      stageName: "QA",
    });
  }

  return { qaReport, evidenceOk, qaWorktreeDir, testedIntegrationHead };
}

export interface HandleQaFastFailOptions {
  qaReport: any;
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
  publisher?: LoopPublisher;
}

/**
 * Handles QA Fast-Fail gate: short-circuits Code Review when Black-Box QA fails.
 */
export async function handleQaFastFail(opts: HandleQaFastFailOptions): Promise<LocalLoopResult> {
  const {
    qaReport,
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
  } = opts;

  const isMaxLapsExceeded = lap >= maxLaps;
  const qaStatus: LocalLoopStatus = isMaxLapsExceeded ? "needs_owner" : "sent_back";
  state.status = qaStatus;

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

  if (qaStatus === "needs_owner") {
    await pub.escalateToHuman(state.candidate);
  }

  const changedFilesFinal = (
    await git(state.worktree, "diff", "--name-only", "--no-renames", base, state.candidate!)
  )
    .split("\n")
    .filter(Boolean);

  const qaFailures = Array.isArray(qaReport.lines)
    ? qaReport.lines
        .filter((l: any) => l.verdict !== "PASS" && l.verdict !== "OK")
        .map((l: any) => `${l.id}: ${l.observed || l.text || l.verdict}`)
    : Array.isArray(qaReport.checks)
      ? qaReport.checks
          .filter((c: any) => c.result !== "pass")
          .map((c: any) => `${c.criterion}: ${c.evidence}`)
      : [];

  await recordLapAndReflect({
    stateRoot,
    issue,
    branch,
    pr: state.pr,
    runId,
    status: qaStatus,
    candidate: state.candidate,
    artifactsDir,
    evidence: state.evidence,
    commandRecords,
    recoveries,
    changedFiles: changedFilesFinal,
    failedStage: "qa",
    qaFailures,
    reflectTerminal,
  });

  const qaComment = formatQaFailureComment({
    route,
    candidate: state.candidate!,
    qaReport,
    isMaxLapsExceeded,
  });

  await pub.publishLoopComment({
    pr: state.pr,
    commentType: "qa_check",
    commentBody: qaComment,
    candidate: state.candidate!,
  });

  await save();
  return state;
}

export interface DeploymentVerificationResult {
  healthy: boolean;
  status: number;
  buildId?: string;
  matchedHead: boolean;
  error?: string;
}

/**
 * Probes candidate HTTP deployment health and build-id endpoint.
 * Acts as a reusable candidate HTTP probe helper for black-box QA.
 */
export async function verifyDeployment(
  baseUrl: string,
  expectedCandidateSha: string,
  timeoutMs = 15_000,
): Promise<DeploymentVerificationResult> {
  const url = baseUrl.replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. Probe health endpoint
    const healthRes = await fetch(`${url}/health`, { signal: controller.signal });
    if (!healthRes.ok) {
      clearTimeout(timer);
      return {
        healthy: false,
        status: healthRes.status,
        matchedHead: false,
        error: `Health endpoint returned status ${healthRes.status}`,
      };
    }

    // 2. Probe build-id endpoint
    let buildId: string | undefined;
    try {
      const buildRes = await fetch(`${url}/build-id`, { signal: controller.signal });
      if (buildRes.ok) {
        buildId = (await buildRes.text()).trim();
      }
    } catch {}

    clearTimeout(timer);
    const matchedHead =
      !expectedCandidateSha || !buildId || buildId.startsWith(expectedCandidateSha.slice(0, 7));

    return {
      healthy: true,
      status: 200,
      buildId,
      matchedHead,
    };
  } catch (err: any) {
    clearTimeout(timer);
    return {
      healthy: false,
      status: 0,
      matchedHead: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

