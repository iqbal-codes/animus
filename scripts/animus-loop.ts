import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeExternalBlastRadius } from "./loop/blast-radius";
import {
  extractRequiredAcIds,
  validateIssue,
  formatEscalationHandoff,
  annotateDiffWithLineNumbers,
  assembleRolePromptContext,
} from "./loop/prompt-context";
import { processRun } from "./loop/process";
import { resolveRoleBudgets } from "./loop/deadlines";
import type {
  LocalIssue,
  LoopRole,
  AgentTransport,
  LocalLoopOptions,
  LocalLoopResult,
} from "./loop/types";
import { type IssueDossier, type LapAttemptRecord } from "./loop/dossier";
import {
  executeTerminalReflection,
  createBoundedReflectionTransport,
  type ExecuteTerminalReflectionOptions,
  type BoundedReflectionTransportOptions,
} from "./loop/reflector";
import type { LearningCommandRecord, LearningEvaluator } from "./loop/learning-schema";
import type { LearningDeliveryTransport } from "./loop/learning-delivery";
import { renderPrompt, resolveAnimusCommandsDir } from "./loop/prompts";
import { parseAgentReport, extractReport } from "./loop/artifacts";
import { formatBuilderComment } from "./loop/pr-reporting";
import {
  executeSubticketAutoMerge,
  type ExecuteSubticketAutoMergeOptions,
} from "./loop/merge-queue";
import {
  git,
  inspectLocalLoop,
  findExistingWorktreeForBranch,
  acquireIssueLock,
  prepareLoopWorktree,
  assertCandidate as assertCandidateInWorktree,
  DEFAULT_PROTECTED_PATHS,
} from "./loop/worktree";
import { setupLoopLifecycle } from "./loop/lifecycle";
import { invokeRoleWithDeadlines } from "./loop/role-runner";
import {
  runOrdinaryChecks,
  verifyPrCiGate,
  handleCiFastFail,
} from "./loop/ci";
import {
  executeBlackBoxQa,
  handleQaFastFail,
} from "./loop/qa-runner";
import {
  evaluateReviewReadiness,
  finalizeReviewAndPublish,
  handleLoopCatch,
} from "./loop/review-gate";
import { recordLapAndReflect } from "./loop/pr-publication";
import { LoopPublisher } from "./loop/publisher";

// Re-export all domain types for full backward compatibility across all consumers
export { LoopPublisher } from "./loop/publisher";
export type * from "./loop/types";
export type * from "./loop/prompt-context";
export type * from "./loop/blast-radius";
export type * from "./loop/worktree";
export type * from "./loop/lifecycle";
export type * from "./loop/role-runner";
export type * from "./loop/qa-runner";
export type * from "./loop/review-gate";
export type * from "./loop/ci";
export type {
  RecordLapAndReflectOptions,
  PublicationRecord,
  PublicationErrorRecord,
} from "./loop/pr-publication";
export type {
  ExecuteSubticketAutoMergeOptions,
  ExecuteTerminalReflectionOptions,
  BoundedReflectionTransportOptions,
};

// Re-export domain utilities preserved from pre-existing local-loop public contract
export {
  resolveAnimusCommandsDir,
  renderPrompt,
  parseAgentReport,
  extractReport,
  formatBuilderComment,
  extractRequiredAcIds,
  validateIssue,
  formatEscalationHandoff,
  annotateDiffWithLineNumbers,
  assembleRolePromptContext,
  git,
  inspectLocalLoop,
  findExistingWorktreeForBranch,
  acquireIssueLock,
  prepareLoopWorktree,
  assertCandidateInWorktree as assertCandidate,
  DEFAULT_PROTECTED_PATHS,
  executeSubticketAutoMerge,
  executeTerminalReflection,
  createBoundedReflectionTransport,
  computeExternalBlastRadius,
  setupLoopLifecycle,
  invokeRoleWithDeadlines,
  runOrdinaryChecks,
  executeBlackBoxQa,
  handleQaFastFail,
  handleCiFastFail,
  verifyPrCiGate,
  evaluateReviewReadiness,
  finalizeReviewAndPublish,
  handleLoopCatch,
  recordLapAndReflect,
};

// ---------------------------------------------------------------------------
// Canonical Animus Loop Orchestrator
// ---------------------------------------------------------------------------

/**
 * Executes exactly ONE autonomous lap following the canonical Animus SDLC lifecycle:
 * Stage 1: Builder (loop-work) -> Deterministic Pre-commit CI Gate & Checks ->
 * Stage 2: Black-Box QA (loop-check-app) with QA Fast-Fail ->
 * Stage 2.5: PR CI Gate -> Stage 3: Code Review (1-axis line-by-line) ->
 * Stage 3.5: Subticket Auto-Merge -> Stage 4: Finalization & Terminal Reflection.
 */
export async function runAnimusLoop(
  root: string,
  issue: LocalIssue,
  options: LocalLoopOptions & {
    reflection?: {
      proposalEvaluator?: LearningEvaluator;
      deliveryTransport?: LearningDeliveryTransport;
    };
  } = {},
): Promise<LocalLoopResult> {
  const roleBudgets = resolveRoleBudgets(options);
  const lc = await setupLoopLifecycle(root, issue, options);
  const { state, save, releaseLock } = lc;

  const publisher = new LoopPublisher({
    worktree: state.worktree,
    runDirectory: lc.runDirectory,
    artifactsDir: lc.artifactsDir,
    issueNumber: issue.number,
    push: options.push !== false,
    runner: options.ghRunner,
  });

  const transport =
    options.transport ??
    options.pi ??
    ((req) => processRun(req.argv, req.cwd, req.timeoutMs, req.env));

  const recoveries: NonNullable<LapAttemptRecord["recoveries"]> = [];
  const commandRecords: LearningCommandRecord[] = [];
  const acceptedRef = lc.defaultBaseSha;

  let reflectTerminal: (targetDossier: IssueDossier) => Promise<void> = async () => {};

  try {
    reflectTerminal = async (targetDossier: IssueDossier) => {
      await executeTerminalReflection({
        root,
        stateRoot: lc.stateRoot,
        runDirectory: lc.runDirectory,
        artifactsDir: lc.artifactsDir,
        handoffDir: lc.handoffDir,
        worktree: state.worktree,
        candidate: state.candidate,
        defaultBaseBranch: lc.defaultBaseBranch,
        dossier: targetDossier,
        transport,
        budget: roleBudgets.reflector,
        maxContinuations: options.maxContinuations,
        push: options.push,
        pr: state.pr,
        acceptedRef,
        commandRecords,
        proposalEvaluator: options.reflection?.proposalEvaluator,
        deliveryTransport: options.reflection?.deliveryTransport,
        currentStatus: state.status,
        setStatus: (status) => {
          state.status = status;
        },
        onEvidence: async (ev) => {
          state.evidence.push(ev);
        },
        onSave: async () => {
          await save();
        },
      });
    };

    const invoke = (
      role: LoopRole,
      candidate?: string,
      extraVars: Record<string, string> = {},
      cwdOverride?: string,
      optionsOverride?: { requiredAcIds?: string[] },
    ) =>
      invokeRoleWithDeadlines({
        role,
        root,
        issue,
        state,
        stateRoot: lc.stateRoot,
        runDirectory: lc.runDirectory,
        artifactsDir: lc.artifactsDir,
        handoffDir: lc.handoffDir,
        route: lc.route,
        base: lc.base,
        candidate,
        extraVars,
        cwdOverride,
        optionsOverride,
        template:
          role === "builder"
            ? lc.builderTemplate
            : role === "qa"
              ? lc.qaTemplate
              : lc.reviewerTemplate,
        options,
        roleBudgets,
        transport,
        acceptedRef,
        holdoutPath: existsSync(join(root, ".factory/holdout/HOLDOUT.md"))
          ? join(root, ".factory/holdout/HOLDOUT.md")
          : "",
        protectedPaths: lc.protectedPaths,
        maxRejections: lc.maxRejections,
        initialProfile: lc.initialProfile,
        recoveries,
        save,
      });

    // Worktree allocation / reuse
    await prepareLoopWorktree({
      root,
      worktreePath: state.worktree,
      branch: lc.branch,
      base: lc.base,
      route: lc.route,
      hasOrigin: lc.hasOrigin,
      baseBranch: lc.baseBranch,
      existingWorktree: lc.existingWorktree,
    });

    const assertCandidate = (expectedCandidate?: string) =>
      assertCandidateInWorktree({
        root,
        worktree: state.worktree,
        base: lc.base,
        expectedCandidate,
        protectedPaths: lc.protectedPaths,
      });

    const targetBaseTip = (await git(root, "rev-parse", lc.base)).trim();
    const currentHead = (await git(state.worktree, "rev-parse", "HEAD")).trim();
    const mergeBase = (await git(state.worktree, "merge-base", lc.base, currentHead)).trim();

    state.identities = {
      targetBaseTip,
      mergeBase,
      prHead: currentHead,
      testedHead: currentHead,
      environment: `Darwin ${process.arch} Bun ${Bun.version}`,
    };

    // -------------------------------------------------------------
    // STAGE 1: BUILDER (loop-work)
    // -------------------------------------------------------------
    const builderReport = await invoke("builder");
    state.candidate = await assertCandidate(builderReport.candidate);
    state.builderReport = builderReport;
    state.identities.prHead = state.candidate;
    state.identities.testedHead = state.candidate;

    await publisher.publishBuilderDelivery({
      branch: lc.branch,
      issue,
      state,
      builderReport,
      route: lc.route,
      lap: lc.lap,
      handoffDir: lc.handoffDir,
      integrationBranch: lc.integrationBranch,
    });

    // -------------------------------------------------------------
    // DETERMINISTIC PRE-COMMIT CI GATE & ORDINARY CHECKS
    // -------------------------------------------------------------
    state.status = "checking";
    await save();
    await runOrdinaryChecks({
      root,
      worktree: state.worktree,
      checks: lc.checks,
      timeoutMs: lc.timeout,
      runId: lc.runId,
      candidate: state.candidate,
      runDirectory: lc.runDirectory,
      artifactsDir: lc.artifactsDir,
      commandRecords,
      evidence: state.evidence,
    });
    await assertCandidate(state.candidate);

    // -------------------------------------------------------------
    // STAGE 2: BLACK-BOX QA (loop-check-app) & QA FAST-FAIL GATE
    // -------------------------------------------------------------
    const requiredAcIds = extractRequiredAcIds(issue);
    const { qaReport, evidenceOk } = await executeBlackBoxQa({
      root,
      candidate: state.candidate,
      identities: state.identities,
      runDirectory: lc.runDirectory,
      artifactsDir: lc.artifactsDir,
      handoffDir: lc.handoffDir,
      worktree: state.worktree,
      pr: state.pr,
      push: options.push !== false,
      builderReport,
      publisher,
      invokeQa: (qaCwd, extraVars, testedHead) =>
        invoke("qa", testedHead, extraVars, qaCwd, { requiredAcIds }),
    });
    state.qaReport = qaReport;
    await assertCandidate(state.candidate);

    // QA Fast-Fail: short-circuit reviewer when black-box QA fails
    if (!qaReport.passed) {
      return await handleQaFastFail({
        qaReport,
        lap: lc.lap,
        maxLaps: lc.maxLaps,
        state,
        issue,
        branch: lc.branch,
        stateRoot: lc.stateRoot,
        runId: lc.runId,
        artifactsDir: lc.artifactsDir,
        commandRecords,
        recoveries,
        base: lc.base,
        route: lc.route,
        options,
        reflectTerminal,
        save,
        publisher,
      });
    }

    // -------------------------------------------------------------
    // STAGE 2.5: PR CI CHECK GATE (Fail-fast if remote CI failed)
    // -------------------------------------------------------------
    const ciResult = await verifyPrCiGate({
      state,
      options,
      lap: lc.lap,
      maxLaps: lc.maxLaps,
      issue,
      branch: lc.branch,
      stateRoot: lc.stateRoot,
      runId: lc.runId,
      artifactsDir: lc.artifactsDir,
      commandRecords,
      recoveries,
      base: lc.base,
      route: lc.route,
      reflectTerminal,
      save,
      qaReport,
      builderReport,
      publisher,
    });

    if (ciResult.failed) {
      return ciResult.result!;
    }

    // -------------------------------------------------------------
    // STAGE 3: CODE REVIEW (loop-review)
    // -------------------------------------------------------------
    const reviewReport = await invoke("reviewer", state.candidate, { evidence_ok: evidenceOk });
    state.reviewerReport = reviewReport;
    await assertCandidate(state.candidate);
    await Bun.write(join(lc.artifactsDir, "review.json"), JSON.stringify(reviewReport, null, 2));

    let reviewEval = await evaluateReviewReadiness({
      stateRoot: lc.stateRoot,
      issue,
      branch: lc.branch,
      candidate: state.candidate,
      base: lc.base,
      baseBranch: lc.baseBranch,
      defaultBaseBranch: lc.defaultBaseBranch,
      worktree: state.worktree,
      lap: lc.lap,
      maxLaps: lc.maxLaps,
      qaReport,
      reviewReport,
      artifactsDir: lc.artifactsDir,
      partOf: lc.partOf,
      protectedPaths: lc.protectedPaths,
      pr: state.pr,
    });
    state.findings = reviewEval.syncedFindings;
    state.autoMerge = reviewEval.autoMergeEval;
    await Bun.write(
      join(lc.artifactsDir, "auto-merge-judgement.json"),
      JSON.stringify(reviewEval.autoMergeEval, null, 2),
    );

    // -------------------------------------------------------------
    // STAGE 3.5: SUBTICKET AUTO-MERGE EXECUTION
    // -------------------------------------------------------------
    if (reviewEval.isApproved && reviewEval.autoMergeEval.authorized && lc.integrationBranch) {
      const mergeRes = await executeSubticketAutoMerge({
        root,
        candidate: state.candidate!,
        integrationBranch: lc.integrationBranch,
        targetBaseTip: state.identities.targetBaseTip!,
        worktree: state.worktree,
        issueNumber: issue.number,
        partOf: lc.partOf,
        defaultBaseBranch: lc.defaultBaseBranch,
        pr: state.pr,
        hasOrigin: lc.hasOrigin,
        push: options.push !== false,
        autoMergeEval: reviewEval.autoMergeEval,
        assertCandidateFn: assertCandidateInWorktree,
      });
      reviewEval = {
        ...reviewEval,
        autoMergeEval: mergeRes.evaluation,
        finalStatus: mergeRes.finalStatus,
        reviewOutcome: mergeRes.reviewOutcome,
      };
      state.autoMerge = mergeRes.evaluation;
      await Bun.write(
        join(lc.artifactsDir, "auto-merge-judgement.json"),
        JSON.stringify(mergeRes.evaluation, null, 2),
      );
      if (mergeRes.finalIntegrationPr) {
        state.finalIntegrationPr = mergeRes.finalIntegrationPr;
      }
    }

    // -------------------------------------------------------------
    // STAGE 4: FINALIZATION & TERMINAL REFLECTION
    // -------------------------------------------------------------
    await finalizeReviewAndPublish({
      worktree: state.worktree,
      issue,
      branch: lc.branch,
      pr: state.pr,
      runId: lc.runId,
      candidate: state.candidate,
      artifactsDir: lc.artifactsDir,
      runDirectory: lc.runDirectory,
      stateRoot: lc.stateRoot,
      evidence: state.evidence,
      commandRecords,
      recoveries,
      qaReport,
      reviewReport,
      builderReport,
      identities: state.identities,
      lap: lc.lap,
      maxLaps: lc.maxLaps,
      route: lc.route,
      push: options.push !== false,
      reviewEval,
      reflectTerminal,
      state,
      publisher,
      ghRunner: options?.ghRunner,
    });

    await save();
    return state;
  } catch (error) {
    return await handleLoopCatch({
      error,
      state,
      root,
      issue,
      branch: lc.branch,
      lap: lc.lap,
      maxLaps: lc.maxLaps,
      stateRoot: lc.stateRoot,
      runId: lc.runId,
      artifactsDir: lc.artifactsDir,
      commandRecords,
      recoveries,
      reflectTerminal,
      save,
      publisher,
      push: options.push !== false,
      ghRunner: options?.ghRunner,
    });
  } finally {
    try {
      await releaseLock();
    } catch {}
  }
}

/**
 * Backward compatibility alias for the canonical runAnimusLoop orchestrator.
 */
export const runLocalLoop = runAnimusLoop;
