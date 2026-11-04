import { join } from "node:path";
import { git } from "./worktree";
import { loadIssueDossier, syncDossierFindings } from "./dossier";
import { evaluateHostReadiness } from "./artifacts";
import { evaluateSubticketAutoMerge } from "./merge-queue";
import { formatReviewComment } from "./pr-reporting";
import { formatEscalationHandoff } from "./prompt-context";
import {
  publishPrReview,
  publishComment,
  syncAndPublishPrEvidence,
  recordLapAndReflect,
  escalateIssueToHuman,
} from "./pr-publication";
import { LoopPublisher } from "./publisher";
import { RoleInterrupted } from "./deadlines";
import type {
  LocalIssue,
  LocalLoopResult,
  LocalLoopRoute,
  LocalLoopStatus,
  LoopEvidence,
  AutoMergeEvaluationResult,
} from "./types";
import type { IssueDossier, LapAttemptRecord } from "./dossier";
import type { LearningCommandRecord } from "./learning-schema";

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
  publisher?: LoopPublisher;
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
    publisher,
  } = opts;

  const pub =
    publisher ??
    new LoopPublisher({
      worktree,
      runDirectory,
      artifactsDir,
      issueNumber: issue.number,
      push,
    });

  if (reviewEval.finalStatus === "needs_owner") {
    await pub.escalateToHuman(candidate);
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
      const commentResult = await pub.publishReview({
        pr,
        candidate: candidate!,
        reviewBody: reviewComment,
        findings: reviewEval.syncedFindings,
        rawDiff: reviewEval.diffContentFinal,
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

    await pub.syncAndPublishPrEvidence({
      pr,
      candidate: candidate!,
      captures: qaReport?.captures || [],
      identities,
      qaReport,
      builderReport,
      outstanding: reviewEval.syncedFindings.map((f: any) =>
        typeof f === "string" ? f : `[${f.id}] ${f.title}`,
      ),
      judgeAlterations,
      autoMerge: state.autoMerge,
      stageName: "Review",
    });
  } else if (push !== false) {
    try {
      await pub.publishComment({
        target: { kind: "issue", idOrUrl: issue.number },
        commentType: "review",
        commentBody: reviewComment,
        candidate: candidate!,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Warning: Failed to publish review on issue:", msg);
    }
  }

  await Bun.write(join(artifactsDir, "review.json"), JSON.stringify(reviewReport, null, 2));
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
  publisher?: LoopPublisher;
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

  const pub =
    opts.publisher ??
    new LoopPublisher({
      worktree: root,
      runDirectory: join(stateRoot, "runs", runId),
      artifactsDir,
      issueNumber: issue.number,
      push: true,
    });

  if (isExceeded) {
    await pub.escalateToHuman(state.candidate);
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
