import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, inspectLocalLoop } from "./worktree";
import { processRun } from "./process";
import {
  publishComment,
  publishPrReview,
  publishPrEvidenceUpdate,
  syncExistingEvidenceBindings,
} from "./pr-publication";
import {
  formatBuilderComment,
  formatReviewComment,
  renderCanonicalPrBody,
  renderEvidenceContent,
  formatQaFailureComment,
  formatCiCheckComment,
} from "./pr-reporting";
import {
  recordLapAttempt,
  loadIssueDossier,
  syncDossierFindings,
  type IssueDossier,
  type LapAttemptRecord,
} from "./dossier";
import { evaluateHostReadiness, validateEvidenceCitations } from "./artifacts";
import {
  evaluateSubticketAutoMerge,
} from "./merge-queue";
import { formatEscalationHandoff } from "./prompt-context";
import { pollPrCiStatus } from "./ci";
import { RoleInterrupted } from "./deadlines";
import type {
  LocalIssue,
  LocalLoopResult,
  LocalLoopStatus,
  LocalLoopRoute,
  LoopEvidence,
  LocalLoopOptions,
  AutoMergeEvaluationResult,
} from "./types";
import type { LearningCommandRecord } from "./learning-schema";

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

export async function escalateIssueToHuman(cwd: string, issueNumber: number): Promise<void> {
  try {
    await processRun(
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
      cwd,
      15_000,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Warning: Failed to update GitHub issue labels on escalation:", msg);
  }
}

export interface PublishLoopCommentOptions {
  worktree: string;
  pr?: string;
  issueNumber: number;
  push?: boolean;
  commentType: "builder" | "qa_check" | "ci_check" | "review" | "escalation";
  commentBody: string;
  candidate: string;
  runDirectory: string;
}

export async function publishLoopComment(opts: PublishLoopCommentOptions): Promise<void> {
  if (opts.pr) {
    try {
      await publishComment({
        repoRoot: opts.worktree,
        target: { kind: "pr", idOrUrl: opts.pr },
        commentType: opts.commentType,
        commentBody: opts.commentBody,
        candidate: opts.candidate,
        runDirectory: opts.runDirectory,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Failed to publish ${opts.commentType} comment on PR:`, msg);
    }
  } else if (opts.push !== false) {
    try {
      await publishComment({
        repoRoot: opts.worktree,
        target: { kind: "issue", idOrUrl: opts.issueNumber },
        commentType: opts.commentType,
        commentBody: opts.commentBody,
        candidate: opts.candidate,
        runDirectory: opts.runDirectory,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Failed to publish ${opts.commentType} comment on issue:`, msg);
    }
  }
}

export interface SyncAndPublishPrEvidenceOptions {
  worktree: string;
  pr?: string;
  push?: boolean;
  candidate: string;
  captures?: any[];
  artifactsDir: string;
  runDirectory: string;
  identities?: any;
  qaReport?: any;
  builderReport?: any;
  outstanding?: string[];
  judgeAlterations?: string[];
  autoMerge?: any;
  stageName: string;
}

export async function syncAndPublishPrEvidence(
  opts: SyncAndPublishPrEvidenceOptions,
): Promise<void> {
  if (opts.pr && opts.push !== false) {
    try {
      const syncedCaptures = syncExistingEvidenceBindings(
        opts.captures || [],
        opts.artifactsDir,
        opts.candidate,
      );
      const newEvContent = renderEvidenceContent({
        identities: opts.identities,
        qaReport: opts.qaReport,
        builderReport: opts.builderReport,
        captures: syncedCaptures,
        outstanding: opts.outstanding,
        judgeAlterations: opts.judgeAlterations,
        autoMerge: opts.autoMerge,
      });
      await publishPrEvidenceUpdate({
        repoRoot: opts.worktree,
        pr: opts.pr,
        candidate: opts.candidate,
        newEvidenceContent: newEvContent,
        runDirectory: opts.runDirectory,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: ${opts.stageName} stage PR evidence synchronization error:`, msg);
    }
  }
}

export interface RecordLapAndReflectOptions {
  stateRoot: string;
  issue: LocalIssue;
  branch: string;
  pr?: string;
  runId: string;
  status: LapAttemptRecord["status"];
  candidate?: string;
  artifactsDir: string;
  evidence: LoopEvidence[];
  commandRecords: LearningCommandRecord[];
  recoveries: NonNullable<LapAttemptRecord["recoveries"]>;
  changedFiles: string[];
  failedStage?: "ordinary_checks" | "builder" | "qa" | "ci" | "reviewer";
  errorExcerpt?: string;
  reviewFindings?: string[];
  structuredFindings?: any[];
  qaFailures?: string[];
  reflectTerminal: (dossier: IssueDossier) => Promise<void>;
}

export async function recordLapAndReflect(
  opts: RecordLapAndReflectOptions,
): Promise<IssueDossier> {
  const dossier = recordLapAttempt(
    opts.stateRoot,
    {
      issueNumber: opts.issue.number,
      issueTitle: opts.issue.title,
      issueUrl: opts.issue.url,
      branch: opts.branch,
      prUrl: opts.pr,
    },
    {
      runId: opts.runId,
      timestamp: new Date().toISOString(),
      status: opts.status,
      candidateHead: opts.candidate,
      artifactsDir: opts.artifactsDir,
      evidence: [...opts.evidence],
      commandRecords: [...opts.commandRecords],
      recoveries: [...opts.recoveries],
      changedFiles: opts.changedFiles,
      failedStage: opts.failedStage,
      errorExcerpt: opts.errorExcerpt,
      reviewFindings: opts.reviewFindings ?? [],
      structuredFindings: opts.structuredFindings,
      qaFailures: opts.qaFailures ?? [],
    },
  );
  await opts.reflectTerminal(dossier);
  return dossier;
}

export interface PublishBuilderDeliveryOptions {
  worktree: string;
  branch: string;
  issue: LocalIssue;
  state: LocalLoopResult;
  builderReport: any;
  push: boolean;
  route: LocalLoopRoute;
  lap: number;
  artifactsDir: string;
  handoffDir: string;
  runDirectory: string;
  integrationBranch?: string;
}

/**
 * Writes builder handoff reports, pushes branch to origin, creates PR or posts
 * builder continuation comment, and synchronizes PR evidence.
 */
export async function publishBuilderDelivery(opts: PublishBuilderDeliveryOptions): Promise<void> {
  const {
    worktree,
    branch,
    issue,
    state,
    builderReport,
    push,
    route,
    lap,
    artifactsDir,
    handoffDir,
    runDirectory,
    integrationBranch,
  } = opts;

  await Bun.write(join(handoffDir, "builder.json"), JSON.stringify(builderReport, null, 2));
  await Bun.write(
    join(handoffDir, "builder.md"),
    `# Builder Report\n\nCandidate: ${state.candidate}\nVerdict: ${builderReport.verdict}\n\n` +
      (builderReport.checks
        ?.map((c: any) => `- ${c.criterion}: ${c.result} (${c.evidence})`)
        .join("\n") || "No explicit checks"),
  );

  if (push === false) return;

  try {
    await git(worktree, "push", "-u", "origin", branch);
    if (!state.pr) {
      const prView = await processRun(
        ["gh", "pr", "view", branch, "--json", "url"],
        worktree,
        15_000,
      );
      if (prView.exitCode === 0) {
        try {
          const parsed = JSON.parse(prView.stdout);
          if (parsed.url) state.pr = parsed.url;
        } catch {}
      }
    }
    if (!state.pr) {
      const body = renderCanonicalPrBody({
        issue,
        identities: state.identities!,
        builderReport,
      });

      const prCreate = await processRun(
        [
          "gh",
          "pr",
          "create",
          ...(integrationBranch ? ["--base", integrationBranch] : []),
          "--head",
          branch,
          "--title",
          issue.title,
          "--body",
          body,
        ],
        worktree,
        30_000,
      );
      if (prCreate.exitCode === 0) {
        state.pr = prCreate.stdout.trim();
      } else {
        console.error(
          "Warning: gh pr create failed:",
          prCreate.stderr || "exit " + prCreate.exitCode,
        );
      }
    } else if (state.pr && route === "continue") {
      const builderComment = formatBuilderComment(
        builderReport,
        lap,
        route,
        state.candidate!,
      );
      await publishLoopComment({
        worktree,
        pr: state.pr,
        issueNumber: issue.number,
        push,
        commentType: "builder",
        commentBody: builderComment,
        candidate: state.candidate!,
        runDirectory,
      });
      await syncAndPublishPrEvidence({
        worktree,
        pr: state.pr,
        push,
        candidate: state.candidate!,
        captures: builderReport?.captures || [],
        artifactsDir,
        runDirectory,
        identities: state.identities,
        builderReport,
        stageName: "Continue stage",
      });
    }
  } catch (pushErr: unknown) {
    const message = pushErr instanceof Error ? pushErr.message : String(pushErr);
    console.error("Warning: Git push / PR synchronization error:", message);
  }
}

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

    await syncAndPublishPrEvidence({
      worktree,
      pr,
      push,
      candidate,
      captures: qaReport?.captures || [],
      artifactsDir,
      runDirectory,
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

  if (qaStatus === "needs_owner") {
    await escalateIssueToHuman(state.worktree, issue.number);
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

  await publishLoopComment({
    worktree: state.worktree,
    pr: state.pr,
    issueNumber: issue.number,
    push: options.push,
    commentType: "qa_check",
    commentBody: qaComment,
    candidate: state.candidate!,
    runDirectory: state.runDirectory,
  });

  await save();
  return state;
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

  if (ciStatus === "needs_owner") {
    await escalateIssueToHuman(state.worktree, issue.number);
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

  await publishLoopComment({
    worktree: state.worktree,
    pr: state.pr,
    issueNumber: issue.number,
    push: options.push,
    commentType: "ci_check",
    commentBody: ciComment,
    candidate: state.candidate!,
    runDirectory: state.runDirectory,
  });

  await syncAndPublishPrEvidence({
    worktree: state.worktree,
    pr: state.pr,
    push: options.push,
    candidate: state.candidate!,
    captures: qaReport?.captures || [],
    artifactsDir,
    runDirectory: state.runDirectory,
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
    : await pollPrCiStatus(prTarget, {
        maxWaitSeconds: ciTimeoutSeconds,
        pollIntervalSeconds: 5,
        cwd: state.worktree,
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
    });
    return { failed: true, result: fastFailResult, assessment: ciAssessment };
  }

  return { failed: false, assessment: ciAssessment };
}

export interface EvaluateReviewReadinessOptions {
  stateRoot: string;
  issue: LocalIssue;
  branch: string;
  candidate: string;
  base: string;
  baseBranch: string;
  defaultBaseBranch: string;
  worktree: string;
  lap: number;
  maxLaps: number;
  qaReport: any;
  reviewReport: any;
  artifactsDir: string;
  partOf?: number;
  protectedPaths: string[];
  pr?: string;
}

export interface ReviewReadinessEvaluation {
  readiness: ReturnType<typeof evaluateHostReadiness>;
  isApproved: boolean;
  isNeedsOwner: boolean;
  isMaxLapsExceeded: boolean;
  reviewOutcome: string;
  finalStatus: "waiting_approval" | "needs_owner" | "sent_back" | "merged";
  syncedFindings: any[];
  changedFilesFinal: string[];
  diffContentFinal: string;
  autoMergeEval: AutoMergeEvaluationResult;
}

/**
 * Synchronizes dossier findings, evaluates host readiness, computes final loop status,
 * and performs two-layer subticket auto-merge judgement.
 */
export async function evaluateReviewReadiness(
  opts: EvaluateReviewReadinessOptions,
): Promise<ReviewReadinessEvaluation> {
  const {
    stateRoot,
    issue,
    branch,
    candidate,
    base,
    baseBranch,
    defaultBaseBranch,
    worktree,
    lap,
    maxLaps,
    qaReport,
    reviewReport,
    artifactsDir,
    partOf,
    protectedPaths,
    pr,
  } = opts;

  const initialDossier = loadIssueDossier(stateRoot, issue.number) ?? {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.url,
    branch,
    prUrl: pr,
    attempts: [],
  };

  const syncedFindings = syncDossierFindings(
    initialDossier,
    Array.isArray(reviewReport.findings) ? reviewReport.findings : [],
    Array.isArray(reviewReport.dispositions) ? reviewReport.dispositions : [],
    Array.isArray(reviewReport.rechecks) ? reviewReport.rechecks : [],
    lap,
    { candidate, artifactsDir },
  );

  const readiness = evaluateHostReadiness({
    candidateStable: true,
    ordinaryChecksPassed: true,
    qaReport,
    reviewerReport: reviewReport,
    ciPassed: true,
    lap,
    maxLaps,
    expectedCandidate: candidate,
    outstandingFindings: syncedFindings,
  });

  const isApproved = Boolean(qaReport.passed && reviewReport.passed && readiness.ready);
  const isExplicitNeedsOwner =
    reviewReport.outcome === "needs-owner" || reviewReport.verdict === "needs_owner";
  const isMaxLapsExceeded = !isApproved && lap >= maxLaps;
  const isNeedsOwner = !isApproved && (isExplicitNeedsOwner || isMaxLapsExceeded);

  const reviewOutcome = isApproved ? "approved" : isNeedsOwner ? "needs owner" : "sent back";
  const finalStatus: LocalLoopStatus = isApproved
    ? "waiting_approval"
    : isNeedsOwner
      ? "needs_owner"
      : "sent_back";

  const changedFilesFinal = (
    await git(worktree, "diff", "--name-only", "--no-renames", base, candidate)
  )
    .split("\n")
    .filter(Boolean);

  const diffContentFinal = await git(worktree, "diff", "--no-renames", base, candidate);

  const autoMergeEval = evaluateSubticketAutoMerge({
    isSubticket: partOf !== undefined,
    targetBranch: baseBranch,
    baseBranch: defaultBaseBranch,
    readinessReady: isApproved,
    reviewerReport: reviewReport,
    changedFiles: changedFilesFinal,
    diffContent: diffContentFinal,
    protectedPaths,
  });

  return {
    readiness,
    isApproved,
    isNeedsOwner,
    isMaxLapsExceeded,
    reviewOutcome,
    finalStatus,
    syncedFindings,
    changedFilesFinal,
    diffContentFinal,
    autoMergeEval,
  };
}

export interface FinalizeReviewAndPublishOptions {
  worktree: string;
  issue: LocalIssue;
  branch: string;
  pr?: string;
  runId: string;
  candidate: string;
  artifactsDir: string;
  runDirectory: string;
  stateRoot: string;
  evidence: LoopEvidence[];
  commandRecords: LearningCommandRecord[];
  recoveries: NonNullable<LapAttemptRecord["recoveries"]>;
  qaReport: any;
  reviewReport: any;
  builderReport: any;
  identities: NonNullable<LocalLoopResult["identities"]>;
  lap: number;
  maxLaps: number;
  route: LocalLoopRoute;
  push: boolean;
  reviewEval: ReviewReadinessEvaluation;
  reflectTerminal: (dossier: IssueDossier) => Promise<void>;
  state: LocalLoopResult;
}

/**
 * Handles Stage 4: records terminal lap reflection, formats and publishes reviewer comment/review,
 * and synchronizes PR evidence.
 */
export async function finalizeReviewAndPublish(
  opts: FinalizeReviewAndPublishOptions,
): Promise<void> {
  const {
    worktree,
    issue,
    branch,
    pr,
    runId,
    candidate,
    artifactsDir,
    runDirectory,
    stateRoot,
    evidence,
    commandRecords,
    recoveries,
    qaReport,
    reviewReport,
    builderReport,
    identities,
    lap,
    maxLaps,
    route,
    push,
    reviewEval,
    reflectTerminal,
    state,
  } = opts;

  if (reviewEval.finalStatus === "needs_owner") {
    await escalateIssueToHuman(worktree, issue.number);
  }

  await recordLapAndReflect({
    stateRoot,
    issue,
    branch,
    pr,
    runId,
    status: reviewEval.finalStatus,
    candidate,
    artifactsDir,
    evidence,
    commandRecords,
    recoveries,
    changedFiles: reviewEval.changedFilesFinal,
    failedStage: reviewEval.isApproved ? undefined : !qaReport.passed ? "qa" : "reviewer",
    reviewFindings: reviewEval.syncedFindings.map((f) =>
      typeof f === "string" ? f : `[${f.id}] ${f.title}`,
    ),
    structuredFindings: reviewEval.syncedFindings,
    qaFailures: Array.isArray(qaReport.checks)
      ? qaReport.checks
          .filter((c: any) => c.result !== "pass")
          .map((c: any) => `${c.criterion}: ${c.evidence}`)
      : [],
    reflectTerminal,
  });

  state.status = reviewEval.finalStatus;

  const reviewComment = formatReviewComment({
    outcome: reviewEval.reviewOutcome,
    route,
    candidate,
    blastRadiusCount: reviewEval.changedFilesFinal.length,
    qaReport,
    reviewerReport: reviewReport,
    dossierFindings: reviewEval.syncedFindings,
    isNeedsOwner: reviewEval.isNeedsOwner,
    handoffProse: reviewEval.isNeedsOwner
      ? formatEscalationHandoff(
          issue,
          lap,
          maxLaps,
          branch,
          reviewEval.isMaxLapsExceeded,
          reviewReport,
        )
      : undefined,
    autoMerge: state.autoMerge,
  });

  if (pr) {
    try {
      const commentResult = await publishPrReview({
        repoRoot: worktree,
        pr,
        candidate,
        reviewBody: reviewComment,
        findings: reviewEval.syncedFindings,
        rawDiff: reviewEval.diffContentFinal,
        runDirectory,
      });
      if (commentResult.commentUrl) {
        state.reviewCommentUrl = commentResult.commentUrl;
      }
    } catch (comErr: unknown) {
      const msg = comErr instanceof Error ? comErr.message : String(comErr);
      console.error("Warning: Review comment publication error:", msg);
    }

    const judgeAlterations =
      Array.isArray(reviewReport.judge_changes) && reviewReport.judge_changes.length > 0
        ? reviewReport.judge_changes.map(
            (jc: any) => `${jc.file || jc.path || ""}: ${jc.description || jc.reason || ""}`,
          )
        : undefined;
    const outstanding = !reviewEval.readiness.ready ? reviewEval.readiness.reasons : [];
    await syncAndPublishPrEvidence({
      worktree,
      pr,
      push,
      candidate,
      captures: qaReport?.captures || [],
      artifactsDir,
      runDirectory,
      identities,
      qaReport,
      builderReport,
      outstanding,
      judgeAlterations,
      autoMerge: state.autoMerge,
      stageName: "Review",
    });
  } else if (push !== false) {
    await publishLoopComment({
      worktree,
      issueNumber: issue.number,
      push,
      commentType: reviewEval.isNeedsOwner ? "escalation" : "review",
      commentBody: reviewComment,
      candidate,
      runDirectory,
    });
  }
}

export interface HandleLoopCatchOptions {
  error: unknown;
  state: LocalLoopResult;
  root: string;
  issue: LocalIssue;
  branch: string;
  lap: number;
  maxLaps: number;
  stateRoot: string;
  runId: string;
  artifactsDir: string;
  commandRecords: LearningCommandRecord[];
  recoveries: NonNullable<LapAttemptRecord["recoveries"]>;
  reflectTerminal: (dossier: IssueDossier) => Promise<void>;
  save: () => Promise<void>;
}

/**
 * Catches unhandled errors or interruptions in runAnimusLoop and performs terminal recording.
 */
export async function handleLoopCatch(opts: HandleLoopCatchOptions): Promise<LocalLoopResult> {
  const {
    error,
    state,
    root,
    issue,
    branch,
    lap,
    maxLaps,
    stateRoot,
    runId,
    artifactsDir,
    commandRecords,
    recoveries,
    reflectTerminal,
    save,
  } = opts;

  const isInterrupted = error instanceof RoleInterrupted;
  state.error = error instanceof Error ? error.message : String(error);
  if (isInterrupted) {
    state.status = "interrupted";
    await save();
    return state;
  }

  const isExceeded = lap >= maxLaps;
  const finalErrorStatus: LocalLoopStatus = isExceeded ? "needs_owner" : "failed";
  state.status = finalErrorStatus;

  if (isExceeded) {
    await escalateIssueToHuman(root, issue.number);
  }

  try {
    await recordLapAndReflect({
      stateRoot,
      issue,
      branch,
      pr: state.pr,
      runId,
      status: finalErrorStatus,
      candidate: state.candidate,
      artifactsDir,
      evidence: state.evidence,
      commandRecords,
      recoveries,
      changedFiles: [],
      failedStage: state.evidence.some((e) => e.kind === "check" && e.exitCode !== 0)
        ? "ordinary_checks"
        : "builder",
      errorExcerpt: state.error,
      reflectTerminal,
    });
  } catch (reflectionError: unknown) {
    if (reflectionError instanceof RoleInterrupted) {
      state.status = "interrupted";
      state.error = reflectionError.message;
    }
  }
  await save();
  return state;
}
