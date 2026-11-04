import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  computeExternalBlastRadius,
  type ExternalBlastRadiusOptions,
} from "./loop/blast-radius";
import {
  extractRequiredAcIds,
  validateIssue,
  formatEscalationHandoff,
  annotateDiffWithLineNumbers,
  assembleRolePromptContext,
  type BuilderCommentReport,
  type EscalationReviewReport,
  type AssembleRolePromptContextOptions,
} from "./loop/prompt-context";
import { processRun } from "./loop/process";
import { resolveRoleBudgets, interruptionReport, RoleInterrupted } from "./loop/deadlines";
import type {
  LocalIssue,
  LoopRole,
  ProcessResult,
  AgentTransport,
  PiTransport,
  LocalLoopOptions,
  LoopEvidence,
  LocalLoopResult,
  LocalLoopStatus,
  LocalLoopRoute,
  DiffImpactAnalysis,
  AutoMergeEvaluationResult,
  AutoMergeExecutionResult,
  ModelTier,
  BacklogTicket,
  HoldoutScenario,
  MergeQueuePlan,
} from "./loop/types";
import {
  readAnimusConfig,
  resolveModelForRole,
  resolveProviderForRole,
  resolveEffortForRole,
} from "./loop/config";
import { loadScheduleConfig } from "./loop/scheduler";
import { buildProviderArgv } from "./loop/providers";
import {
  resolveAllowedSkills,
  resolveLoopExtensions,
  buildCuratedAppendPrompts,
} from "./loop/harness-memory";
import { resolveVerificationProfile, getProfileInstructions } from "./loop/profiles";
import {
  recordLapAttempt,
  saveIssueDossier,
  loadIssueDossier,
  syncDossierFindings,
  type IssueDossier,
  type LapAttemptRecord,
} from "./loop/dossier";
import {
  runPostIssueReflection,
  executeTerminalReflection,
  createBoundedReflectionTransport,
  type ExecuteTerminalReflectionOptions,
  type BoundedReflectionTransportOptions,
} from "./loop/reflector";
import type { LearningDeliveryTransport } from "./loop/learning-delivery";
import type { LearningCommandRecord, LearningEvaluator } from "./loop/learning-schema";
import { loadPrompt, renderPrompt, resolveAnimusCommandsDir } from "./loop/prompts";
import { resolveAnimusHome, getProjectSlug } from "../packages/contracts/src/paths";
import { pollPrCiStatus } from "./loop/ci";
import {
  setupArtifactDirectories,
  parseAgentReport,
  extractReport,
  validateEvidenceCitations,
  evaluateHostReadiness,
} from "./loop/artifacts";
import {
  formatBuilderComment,
  formatCiCheckComment,
  formatQaFailureComment,
  formatReviewComment,
  renderCanonicalPrBody,
  renderEvidenceContent,
} from "./loop/pr-reporting";
import {
  publishPrEvidenceUpdate,
  publishComment,
  publishPrReview,
  syncExistingEvidenceBindings,
} from "./loop/pr-publication";
import {
  evaluateSubticketAutoMerge,
  executeSubticketAutoMerge,
  type ExecuteSubticketAutoMergeOptions,
} from "./loop/merge-queue";
import { parsePartOf } from "../apps/backend/src/intake/parser";
import {
  git,
  inspectLocalLoop,
  findExistingWorktreeForBranch,
  acquireIssueLock,
  prepareLoopWorktree,
  assertCandidate as assertCandidateInWorktree,
  DEFAULT_PROTECTED_PATHS,
  type PrepareLoopWorktreeOptions,
  type AssertCandidateOptions,
} from "./loop/worktree";

// Re-export all domain types for full backward compatibility across all consumers
export type {
  LocalIssue,
  LoopRole,
  ProcessResult,
  AgentTransport,
  PiTransport,
  LocalLoopOptions,
  LoopEvidence,
  LocalLoopResult,
  LocalLoopRoute,
  LocalLoopStatus,
  DiffImpactAnalysis,
  AutoMergeEvaluationResult,
  AutoMergeExecutionResult,
  ModelTier,
  BacklogTicket,
  HoldoutScenario,
  MergeQueuePlan,
  BuilderCommentReport,
  EscalationReviewReport,
  AssembleRolePromptContextOptions,
  PrepareLoopWorktreeOptions,
  AssertCandidateOptions,
  ExecuteSubticketAutoMergeOptions,
  ExecuteTerminalReflectionOptions,
  BoundedReflectionTransportOptions,
  ExternalBlastRadiusOptions,
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
};

// ---------------------------------------------------------------------------
// Orchestrator Helper Functions
// ---------------------------------------------------------------------------

async function escalateIssueToHuman(cwd: string, issueNumber: number): Promise<void> {
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

async function publishLoopComment(opts: {
  worktree: string;
  pr?: string;
  issueNumber: number;
  push?: boolean;
  commentType: "builder" | "qa_check" | "ci_check" | "review" | "escalation";
  commentBody: string;
  candidate: string;
  runDirectory: string;
}): Promise<void> {
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

async function syncAndPublishPrEvidence(opts: {
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
}): Promise<void> {
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

async function recordLapAndReflect(opts: {
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
}): Promise<IssueDossier> {
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
  validateIssue(issue);
  const roleBudgets = resolveRoleBudgets(options);
  const timeout = options.timeoutMs ?? 20 * 60_000;
  const { common } = await inspectLocalLoop(root);
  const animusConfig = readAnimusConfig(root);
  const defaultBaseBranch = options.baseBranch ?? animusConfig.worktree?.baseBranch ?? "main";
  const parsedPartOf = parsePartOf([issue.body, ...(issue.comments ?? [])].join("\n"));
  const partOf =
    parsedPartOf !== null && parsedPartOf > 0 && parsedPartOf !== issue.number
      ? parsedPartOf
      : undefined;
  const integrationBranch = partOf !== undefined ? `factory/spec-${partOf}-integration` : undefined;
  const baseBranch = integrationBranch ?? defaultBaseBranch;

  let remotes: string[] = [];
  try {
    const remotesOut = await git(root, "remote");
    remotes = remotesOut
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
  } catch {}
  const hasOrigin = remotes.includes("origin");

  let defaultBaseSha = "";
  if (hasOrigin) {
    try {
      await git(root, "fetch", "origin", defaultBaseBranch);
      defaultBaseSha = await git(root, "rev-parse", `origin/${defaultBaseBranch}`);

      // Fast-forward root defaultBaseBranch if root is clean and on defaultBaseBranch
      try {
        const currentBranch = await git(root, "symbolic-ref", "--short", "HEAD");
        if (currentBranch === defaultBaseBranch) {
          const status = await git(root, "status", "--porcelain");
          if (!status.trim()) {
            await git(root, "merge", "--ff-only", `origin/${defaultBaseBranch}`);
          }
        }
      } catch {}
    } catch {}
  }

  if (!defaultBaseSha) {
    try {
      defaultBaseSha = await git(root, "rev-parse", defaultBaseBranch);
    } catch {
      defaultBaseSha = await git(root, "rev-parse", "HEAD");
    }
  }

  let base = "";
  if (integrationBranch) {
    if (hasOrigin) {
      try {
        await git(root, "fetch", "origin", integrationBranch);
        base = await git(root, "rev-parse", `origin/${integrationBranch}`);
        await git(root, "update-ref", `refs/heads/${integrationBranch}`, base);
      } catch {}
    }
    if (!base) {
      try {
        base = await git(root, "rev-parse", "--verify", `refs/heads/${integrationBranch}`);
      } catch {
        await git(root, "update-ref", `refs/heads/${integrationBranch}`, defaultBaseSha);
        base = defaultBaseSha;
      }
    }
    if (hasOrigin && options.push !== false) {
      try {
        await git(root, "push", "-u", "origin", `${integrationBranch}:${integrationBranch}`);
      } catch {}
    }
  } else {
    base = defaultBaseSha;
  }
  const config = await Bun.file(join(root, "harness/harness.config.json")).json();
  const checks = [config.static, config.unit].filter(
    (s): s is string => typeof s === "string" && !!s.trim(),
  );
  if (!checks.length) throw new Error("No declared ordinary project checks");
  const protectedPaths = [
    ".factory/holdout/**",
    ".factory/hooks/**",
    ".claude/settings.json",
    "harness/**",
    ...String(config.protected_paths ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  ];

  // DISCOVERY & ROUTING: Check if an open PR already exists for this issue
  let existingPr: { url: string; number: number; headRefName: string } | null = null;
  const prSearch = await processRun(
    ["gh", "pr", "list", "--state", "open", "--json", "number,url,headRefName,body"],
    root,
    30_000,
  );
  if (prSearch.exitCode === 0) {
    try {
      const openPrs = JSON.parse(prSearch.stdout);
      for (const pr of openPrs) {
        if (
          pr.headRefName?.includes(`issue-${issue.number}`) ||
          pr.body?.includes(`Closes #${issue.number}`) ||
          pr.body?.includes(`Refs #${issue.number}`)
        ) {
          existingPr = { url: pr.url, number: pr.number, headRefName: pr.headRefName };
          break;
        }
      }
    } catch {}
  }

  const route: "simple" | "continue" = existingPr ? "continue" : "simple";
  if (route === "continue" && hasOrigin && existingPr) {
    try {
      await git(root, "fetch", "origin", existingPr.headRefName);
      base = await git(
        root,
        "merge-base",
        `origin/${baseBranch}`,
        `origin/${existingPr.headRefName}`,
      );
    } catch {}
  }

  const runId = randomUUID();
  const stateRoot =
    process.env.ANIMUS_HOME || process.env.ANIMUS_STATE_DIR || process.env.ANIMUS_RUNS_DIR
      ? join(resolveAnimusHome(), "projects", getProjectSlug(root))
      : join(common, "factory-local-loop");
  const runDirectory = join(stateRoot, "runs", runId);
  const { artifactsDir, handoffDir } = await setupArtifactDirectories(runDirectory);
  const releaseLock = await acquireIssueLock(stateRoot, issue.number, {
    runId,
    pid: process.pid,
    issue: issue.url,
    route,
    pr: existingPr?.url ?? existingPr?.headRefName,
    runDirectory,
    startedAt: new Date().toISOString(),
  });

  const branch = existingPr
    ? existingPr.headRefName
    : `local-loop/issue-${issue.number}-${runId.slice(0, 8)}`;
  const existingWorktree = await findExistingWorktreeForBranch(root, branch);
  const dossier = loadIssueDossier(stateRoot, issue.number);
  const lap = (dossier?.attempts.length ?? 0) + 1;
  const initialProfile = issue.verificationProfile ?? resolveVerificationProfile(issue);
  const state: LocalLoopResult = {
    runId,
    pid: process.pid,
    lap,
    issue: issue.url,
    route,
    status: "preparing",
    runDirectory,
    worktree: existingWorktree ?? join(stateRoot, "worktrees", runId),
    branch,
    base,
    partOf,
    integrationBranch,
    pr: existingPr?.url,
    verificationProfile: initialProfile,
    evidence: [],
  };

  const save = async () => {
    await Bun.write(join(runDirectory, "state.tmp"), JSON.stringify(state, null, 2));
    await rename(join(runDirectory, "state.tmp"), join(runDirectory, "state.json"));
  };

  const transport =
    options.transport ??
    options.pi ??
    ((req) => processRun(req.argv, req.cwd, req.timeoutMs, req.env));

  const recoveries: NonNullable<LapAttemptRecord["recoveries"]> = [];
  const commandRecords: LearningCommandRecord[] = [];
  const acceptedRef = defaultBaseSha;

  const reflectTerminal = async (targetDossier: IssueDossier) => {
    await executeTerminalReflection({
      root,
      stateRoot,
      runDirectory,
      artifactsDir,
      handoffDir,
      worktree: state.worktree,
      candidate: state.candidate,
      defaultBaseBranch,
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

  try {
    await Bun.write(join(runDirectory, "issue.json"), JSON.stringify(issue, null, 2));
    await save();

    // Worktree allocation / reuse
    await prepareLoopWorktree({
      root,
      worktreePath: state.worktree,
      branch,
      base,
      route,
      hasOrigin,
      baseBranch,
      existingWorktree,
    });

    const assertCandidate = (expectedCandidate?: string) =>
      assertCandidateInWorktree({
        root,
        worktree: state.worktree,
        base,
        expectedCandidate,
        protectedPaths,
      });

    // Dynamic prompt loading with modular fallback
    const builderTemplate = loadPrompt("loop-work", root);
    const qaTemplate = loadPrompt("loop-check-app", root);
    const reviewerTemplate = loadPrompt("loop-review", root);

    const targetBaseTip = (await git(root, "rev-parse", base)).trim();
    const currentHead = (await git(state.worktree, "rev-parse", "HEAD")).trim();
    const mergeBase = (await git(state.worktree, "merge-base", base, currentHead)).trim();

    state.identities = {
      targetBaseTip,
      mergeBase,
      prHead: currentHead,
      testedHead: currentHead,
      environment: `Darwin ${process.arch} Bun ${Bun.version}`,
    };

    const holdoutPath = existsSync(join(root, ".factory/holdout/HOLDOUT.md"))
      ? join(root, ".factory/holdout/HOLDOUT.md")
      : "";

    const scheduleCfg = loadScheduleConfig(root);
    const maxLaps = scheduleCfg.max_laps ?? 3;
    const maxRejections = Math.max(1, maxLaps - 1);

    const invoke = async (
      role: LoopRole,
      candidate?: string,
      extraVars: Record<string, string> = {},
      cwdOverride?: string,
      optionsOverride?: { requiredAcIds?: string[] },
    ) => {
      await inspectLocalLoop(root);
      state.status = role === "builder" ? "building" : role === "qa" ? "qa" : "reviewing";
      await save();

      const activeCwd = cwdOverride ?? state.worktree;
      const changedFilesList = candidate
        ? (await git(activeCwd, "diff", "--name-only", "--no-renames", base, candidate)).trim()
        : "";

      const currentFiles = changedFilesList
        ? changedFilesList
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const effectiveProfile = candidate
        ? resolveVerificationProfile(
            { ...issue, verificationProfile: issue.verificationProfile },
            currentFiles,
          )
        : initialProfile;
      state.verificationProfile = effectiveProfile;
      const profileInstructions = getProfileInstructions(effectiveProfile, root);

      const template =
        role === "builder" ? builderTemplate : role === "qa" ? qaTemplate : reviewerTemplate;

      let blastRadius = "";
      if (role === "qa" || role === "reviewer") {
        blastRadius = await computeExternalBlastRadius(activeCwd, currentFiles);
      }

      let diffStat = "";
      let boundedDiff = "";
      if (role === "reviewer" && candidate) {
        try {
          diffStat = (await git(activeCwd, "diff", "--stat", base, candidate)).trim();
          const rawDiff = await git(activeCwd, "diff", "--no-renames", base, candidate);
          boundedDiff = annotateDiffWithLineNumbers(rawDiff, 400);
        } catch {
          diffStat = "(Unavailable)";
          boundedDiff = "(Unavailable)";
        }
      }

      const promptVars: Record<string, string> = {
        route,
        target: issue.url,
        pr: state.pr ?? "",
        reason: `Autonomous delivery for issue #${issue.number}: ${issue.title} [profile: ${effectiveProfile}]`,
        runtime: profileInstructions.runtimeInstructions,
        head: candidate ?? "HEAD",
        base,
        files: changedFilesList || "(all files in commit)",
        depth: profileInstructions.depth,
        profile: effectiveProfile,
        skip_app_launch: profileInstructions.skipAppLaunch ? "true" : "false",
        checks_status: existsSync(join(artifactsDir, "builder-checks.log")) ? "passed" : "pending",
        holdout: holdoutPath,
        protected_paths: protectedPaths.join(", "),
        handoff: handoffDir,
        evidence_ok: extraVars.evidence_ok ?? "true",
        merge: "approve",
        rejections: String(maxRejections),
        ...extraVars,
      };

      const ledger = loadIssueDossier(stateRoot, issue.number)?.findings ?? [];
      const lifecycleContext = assembleRolePromptContext({
        role,
        issue,
        root,
        handoffDir,
        blastRadius,
        diffStat,
        boundedDiff,
        ledger,
      });

      const prompt = [renderPrompt(template, promptVars, artifactsDir), lifecycleContext]
        .filter(Boolean)
        .join("\n\n");

      // Provider, Model, & Effort Tiering from .animus/config.yaml or option override
      const roleProvider = options.provider ?? resolveProviderForRole(root, role);
      const roleModel = options.model ?? resolveModelForRole(root, role);
      const roleEffort = options.effort ?? resolveEffortForRole(root, role);

      const checkpointPath = join(handoffDir, "checkpoint.md");
      const budget = roleBudgets[role];
      for (let attempt = 0; attempt <= (options.maxContinuations ?? 1); attempt++) {
        await inspectLocalLoop(root);
        const skills = resolveAllowedSkills(root, role, acceptedRef);
        const extensions = resolveLoopExtensions(root, acceptedRef);
        const appendSystemPrompts = buildCuratedAppendPrompts(
          root,
          issue,
          changedFilesList,
          acceptedRef,
        );
        const stepNum = role === "builder" ? 0 : role === "qa" ? 1 : 2;
        const sessionDirectory = join(
          runDirectory,
          attempt === 0
            ? `${stepNum}-${role}-session`
            : `${stepNum}-${role}-attempt-${attempt}-session`,
        );
        await mkdir(sessionDirectory, { recursive: true });

        const startedAt = Date.now();
        const softDeadline = startedAt + budget.softMs;
        const hardDeadline = startedAt + budget.hardMs;
        const deadlinePrompt = [
          prompt,
          "",
          "## Bounded role execution (overrides completion instructions above)",
          `Soft deadline (absolute Unix milliseconds): ${softDeadline} (${new Date(softDeadline).toISOString()}).`,
          `Hard deadline (absolute Unix milliseconds): ${hardDeadline}; the host terminates the owned process group then.`,
          `Write a durable checkpoint to ${checkpointPath} before the soft deadline: completed work, HEAD, dirty files, evidence, failed approaches/disproved assumptions (with probe evidence so they are never repeated), blockers, and exact next steps. Preserve this worktree.`,
          "After soft deadline the Pi guard permits only write/edit of that exact checkpoint path and simple read-only git status/diff/rev-parse. No git add/commit, publication, or other work is allowed.",
          "Bash defaults to 90 seconds; explicitly longer budgets are clipped to remaining hard time. Do not start work that cannot finish before the deadline.",
          'If incomplete, return {"verdict":"interrupted"}; never report pass for incomplete work.',
          ...(attempt
            ? [
                `Continuation ${attempt}: resume the SAME role in the SAME worktree. Read ${checkpointPath} and prior attempt artifacts first, run the baseline check yourself before editing, skip any failed approaches recorded in the checkpoint, and retain all verified work.`,
              ]
            : []),
        ].join("\n");
        const argv = buildProviderArgv(roleProvider, {
          model: roleModel,
          effort: roleEffort,
          prompt: deadlinePrompt,
          sessionDir: sessionDirectory,
          skills,
          extensions,
          appendSystemPrompts,
        });
        const result = await transport({
          argv,
          cwd: activeCwd,
          role,
          provider: roleProvider,
          timeoutMs: Math.max(1, hardDeadline - Date.now()),
          env: {
            FACTORY_LOOP_SOFT_DEADLINE_MS: String(softDeadline),
            FACTORY_LOOP_HARD_DEADLINE_MS: String(hardDeadline),
            FACTORY_LOOP_CHECKPOINT_PATH: checkpointPath,
          },
        });
        const finishedAt = Date.now();
        const artifact = join(runDirectory, `${role}-attempt-${attempt}.json`);
        await Bun.write(
          artifact,
          JSON.stringify({ ...result, attempt, softDeadline, hardDeadline, finishedAt }),
        );
        const head = (await git(activeCwd, "rev-parse", "HEAD")).trim();
        state.evidence.push({
          kind: roleProvider === "pi" ? "pi" : (roleProvider as any),
          role,
          round: attempt,
          candidate: head,
          artifact,
          exitCode: result.exitCode,
          provider: roleProvider,
          effort: roleEffort,
        });
        await save();
        const timedOut =
          result.timedOut === true || result.exitCode === 124 || finishedAt >= hardDeadline;
        if (timedOut || interruptionReport(result.stdout)) {
          const reason = timedOut
            ? "hard deadline exceeded"
            : "agent checkpoint/interrupted report";
          const dirty = await git(activeCwd, "status", "--porcelain", "--untracked-files=all");
          const facts = `\n\n## Host checkpoint: ${role} attempt ${attempt}\nReason: ${reason}\nHEAD: ${head}\nStage: ${state.status}\nArtifact: ${artifact}\nWorktree: ${activeCwd}\nDirty status:\n\`\`\`\n${dirty || "(clean)"}\n\`\`\`\n`;
          const previous = existsSync(checkpointPath)
            ? readFileSync(checkpointPath, "utf8")
            : "# Interrupted role checkpoint";
          await Bun.write(checkpointPath, previous + facts);
          await Bun.write(
            join(handoffDir, `${role}-attempt-${attempt}-checkpoint.md`),
            previous + facts,
          );
          if (attempt < (options.maxContinuations ?? 1)) {
            recoveries.push({ role, artifact, reason });
            continue;
          }
          throw new RoleInterrupted(
            `${role} interrupted: ${reason}; continuation budget exhausted; see ${checkpointPath}`,
          );
        }
        if (result.exitCode !== 0)
          throw new Error(`${roleProvider} ${role} process failed; see ${artifact}`);
        const expectedIdentity = candidate ?? head;
        return extractReport(result.stdout, expectedIdentity, role, artifactsDir, optionsOverride);
      }
      throw new RoleInterrupted(`${role} continuation budget exhausted`);
    };

    // -------------------------------------------------------------
    // STAGE 1: BUILDER (loop-work)
    // -------------------------------------------------------------
    const builderReport = await invoke("builder");
    state.candidate = await assertCandidate(builderReport.candidate);
    state.builderReport = builderReport;
    state.identities.prHead = state.candidate;
    state.identities.testedHead = state.candidate;

    await Bun.write(join(handoffDir, "builder.json"), JSON.stringify(builderReport, null, 2));
    await Bun.write(
      join(handoffDir, "builder.md"),
      `# Builder Report\n\nCandidate: ${state.candidate}\nVerdict: ${builderReport.verdict}\n\n` +
        (builderReport.checks
          ?.map((c: any) => `- ${c.criterion}: ${c.result} (${c.evidence})`)
          .join("\n") || "No explicit checks"),
    );

    if (options.push !== false) {
      try {
        await git(state.worktree, "push", "-u", "origin", branch);
        if (!state.pr) {
          const prView = await processRun(
            ["gh", "pr", "view", branch, "--json", "url"],
            state.worktree,
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
            identities: state.identities,
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
            state.worktree,
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
          const builderComment = formatBuilderComment(builderReport, lap, route, state.candidate);
          await publishLoopComment({
            worktree: state.worktree,
            pr: state.pr,
            issueNumber: issue.number,
            push: options.push,
            commentType: "builder",
            commentBody: builderComment,
            candidate: state.candidate,
            runDirectory,
          });
          await syncAndPublishPrEvidence({
            worktree: state.worktree,
            pr: state.pr,
            push: options.push,
            candidate: state.candidate,
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

    // -------------------------------------------------------------
    // DETERMINISTIC PRE-COMMIT CI GATE & ORDINARY CHECKS
    // -------------------------------------------------------------
    state.status = "checking";
    await save();
    const checkOutputs: string[] = [];
    for (let i = 0; i < checks.length; i++) {
      await inspectLocalLoop(root);
      const startedAt = new Date().toISOString();
      const result = await processRun(["sh", "-c", checks[i]!], state.worktree, timeout);
      const completedAt = new Date().toISOString();
      const artifact = join(runDirectory, `check-${i}.json`);
      const recordPath = `command-${i}.json`;
      const recordContent = JSON.stringify({ command: checks[i], ...result });
      await Bun.write(artifact, recordContent);
      await Bun.write(join(artifactsDir, recordPath), recordContent);
      commandRecords.push({
        executionId: `${runId}:check-${i}`,
        runId,
        candidate: state.candidate!,
        command: checks[i]!,
        cwd: state.worktree,
        exitCode: result.exitCode,
        startedAt,
        completedAt,
        artifact: {
          runId,
          candidate: state.candidate!,
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
      state.evidence.push({
        kind: "check",
        round: 0,
        candidate: state.candidate,
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
    await assertCandidate(state.candidate);

    // -------------------------------------------------------------
    // STAGE 2: BLACK-BOX QA (loop-check-app) & QA FAST-FAIL GATE
    // -------------------------------------------------------------
    const qaWorktreeDir = join(runDirectory, "qa-worktree");
    let testedIntegrationHead = state.candidate;
    let mergeConflictOccurred = false;

    try {
      await git(root, "worktree", "add", "--detach", qaWorktreeDir, state.candidate);
      if (
        state.identities.targetBaseTip &&
        state.identities.mergeBase &&
        state.identities.targetBaseTip !== state.identities.mergeBase
      ) {
        try {
          await git(qaWorktreeDir, "merge", "--no-edit", state.identities.targetBaseTip);
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
    state.identities.testedHead = testedIntegrationHead;

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
      const requiredAcIds = extractRequiredAcIds(issue);
      const activeQaCwd = existsSync(qaWorktreeDir) ? qaWorktreeDir : state.worktree;
      qaReport = await invoke(
        "qa",
        testedIntegrationHead,
        {
          tested_head: testedIntegrationHead,
          base_tip: state.identities.targetBaseTip,
          merge_base: state.identities.mergeBase,
          merged_with: state.identities.targetBaseTip,
        },
        activeQaCwd,
        { requiredAcIds },
      );
    }
    state.qaReport = qaReport;

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

    await assertCandidate(state.candidate);

    await Bun.write(join(handoffDir, "app-check.json"), JSON.stringify(qaReport, null, 2));
    await Bun.write(join(artifactsDir, "app-check.json"), JSON.stringify(qaReport, null, 2));

    const { ok: evidenceOkBool, problems: evidenceProblems } = validateEvidenceCitations(
      qaReport,
      artifactsDir,
    );
    await Bun.write(join(handoffDir, "evidence-problems.txt"), evidenceProblems.join("\n"));
    const evidenceOk = evidenceOkBool ? "true" : "false";

    await syncAndPublishPrEvidence({
      worktree: state.worktree,
      pr: state.pr,
      push: options.push,
      candidate: state.candidate,
      captures: qaReport?.captures || [],
      artifactsDir,
      runDirectory,
      identities: state.identities,
      qaReport,
      builderReport,
      stageName: "QA",
    });

    // QA Fast-Fail: short-circuit reviewer when black-box QA fails
    if (!qaReport.passed) {
      const isMaxLapsExceeded = lap >= maxLaps;
      const qaStatus: LocalLoopStatus = isMaxLapsExceeded ? "needs_owner" : "sent_back";
      state.status = qaStatus;

      if (qaStatus === "needs_owner") {
        await escalateIssueToHuman(state.worktree, issue.number);
      }

      const changedFilesFinal = (
        await git(state.worktree, "diff", "--name-only", "--no-renames", base, state.candidate)
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
        candidate: state.candidate,
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
        candidate: state.candidate,
        runDirectory,
      });

      await save();
      return state;
    }

    // -------------------------------------------------------------
    // STAGE 2.5: PR CI CHECK GATE (Fail-fast if remote CI failed)
    // -------------------------------------------------------------
    const prTarget = state.pr ?? (options.checkPrCi ? "mock-pr" : undefined);
    if (prTarget && (options.push !== false || options.checkPrCi)) {
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
        const isMaxLapsExceeded = lap >= maxLaps;
        const ciStatus: LocalLoopStatus = isMaxLapsExceeded ? "needs_owner" : "sent_back";
        state.status = ciStatus;

        if (ciStatus === "needs_owner") {
          await escalateIssueToHuman(state.worktree, issue.number);
        }

        const changedFilesFinal = (
          await git(state.worktree, "diff", "--name-only", "--no-renames", base, state.candidate)
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
          reviewFindings: ciAssessment.failedChecks.map(
            (c: any) =>
              `CI Check [${c.workflow ? c.workflow + " / " : ""}${c.name}] failed: ${c.link || c.state}`,
          ),
          reflectTerminal,
        });

        const ciComment = formatCiCheckComment({
          route,
          candidate: state.candidate,
          failedChecks: ciAssessment.failedChecks,
          isMaxLapsExceeded,
        });

        await publishLoopComment({
          worktree: state.worktree,
          pr: state.pr,
          issueNumber: issue.number,
          push: options.push,
          commentType: "ci_check",
          commentBody: ciComment,
          candidate: state.candidate,
          runDirectory,
        });

        await syncAndPublishPrEvidence({
          worktree: state.worktree,
          pr: state.pr,
          push: options.push,
          candidate: state.candidate,
          captures: qaReport?.captures || [],
          artifactsDir,
          runDirectory,
          identities: state.identities,
          qaReport,
          builderReport,
          outstanding: ciAssessment.failedChecks.map((c: any) => `CI Check [${c.name}] failed`),
          stageName: "CI",
        });

        await save();
        return state;
      }
    }

    // -------------------------------------------------------------
    // STAGE 3: CODE REVIEW (loop-review)
    // -------------------------------------------------------------
    const reviewReport = await invoke("reviewer", state.candidate, { evidence_ok: evidenceOk });
    state.reviewerReport = reviewReport;
    await assertCandidate(state.candidate);
    await Bun.write(join(artifactsDir, "review.json"), JSON.stringify(reviewReport, null, 2));

    const initialDossier = loadIssueDossier(stateRoot, issue.number) ?? {
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      branch,
      prUrl: state.pr,
      attempts: [],
    };
    const syncedFindings = syncDossierFindings(
      initialDossier,
      Array.isArray(reviewReport.findings) ? reviewReport.findings : [],
      Array.isArray(reviewReport.dispositions) ? reviewReport.dispositions : [],
      Array.isArray(reviewReport.rechecks) ? reviewReport.rechecks : [],
      lap,
      { candidate: state.candidate, artifactsDir },
    );

    const readiness = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport,
      reviewerReport: reviewReport,
      ciPassed: true,
      lap,
      maxLaps,
      expectedCandidate: state.candidate,
      outstandingFindings: syncedFindings,
    });

    const isApproved = Boolean(qaReport.passed && reviewReport.passed && readiness.ready);
    const isExplicitNeedsOwner =
      reviewReport.outcome === "needs-owner" || reviewReport.verdict === "needs_owner";
    const isMaxLapsExceeded = !isApproved && lap >= maxLaps;
    const isNeedsOwner = !isApproved && (isExplicitNeedsOwner || isMaxLapsExceeded);

    let reviewOutcome = isApproved ? "approved" : isNeedsOwner ? "needs owner" : "sent back";
    let finalStatus: LocalLoopStatus = isApproved
      ? "waiting_approval"
      : isNeedsOwner
        ? "needs_owner"
        : "sent_back";
    state.findings = syncedFindings;

    const changedFilesFinal = (
      await git(state.worktree, "diff", "--name-only", "--no-renames", base, state.candidate)
    )
      .split("\n")
      .filter(Boolean);

    const diffContentFinal = await git(
      state.worktree,
      "diff",
      "--no-renames",
      base,
      state.candidate,
    );

    let autoMergeEval = evaluateSubticketAutoMerge({
      isSubticket: partOf !== undefined,
      targetBranch: baseBranch,
      baseBranch: defaultBaseBranch,
      readinessReady: isApproved,
      reviewerReport: reviewReport,
      changedFiles: changedFilesFinal,
      diffContent: diffContentFinal,
      protectedPaths,
    });
    state.autoMerge = autoMergeEval;
    await Bun.write(
      join(artifactsDir, "auto-merge-judgement.json"),
      JSON.stringify(autoMergeEval, null, 2),
    );

    // -------------------------------------------------------------
    // STAGE 3.5: SUBTICKET AUTO-MERGE EXECUTION
    // -------------------------------------------------------------
    if (isApproved && autoMergeEval.authorized && integrationBranch) {
      const mergeRes = await executeSubticketAutoMerge({
        root,
        candidate: state.candidate!,
        integrationBranch,
        targetBaseTip: state.identities.targetBaseTip!,
        worktree: state.worktree,
        issueNumber: issue.number,
        partOf,
        defaultBaseBranch,
        pr: state.pr,
        hasOrigin,
        push: options.push !== false,
        autoMergeEval,
        assertCandidateFn: assertCandidate,
      });
      autoMergeEval = mergeRes.evaluation;
      state.autoMerge = autoMergeEval;
      await Bun.write(
        join(artifactsDir, "auto-merge-judgement.json"),
        JSON.stringify(autoMergeEval, null, 2),
      );
      if (mergeRes.success) {
        finalStatus = mergeRes.finalStatus;
        reviewOutcome = mergeRes.reviewOutcome;
        if (mergeRes.finalIntegrationPr) {
          state.finalIntegrationPr = mergeRes.finalIntegrationPr;
        }
      }
    }

    // -------------------------------------------------------------
    // STAGE 4: FINALIZATION & TERMINAL REFLECTION
    // -------------------------------------------------------------
    if (finalStatus === "needs_owner") {
      await escalateIssueToHuman(state.worktree, issue.number);
    }

    await recordLapAndReflect({
      stateRoot,
      issue,
      branch,
      pr: state.pr,
      runId,
      status: finalStatus,
      candidate: state.candidate,
      artifactsDir,
      evidence: state.evidence,
      commandRecords,
      recoveries,
      changedFiles: changedFilesFinal,
      failedStage: isApproved ? undefined : !qaReport.passed ? "qa" : "reviewer",
      reviewFindings: syncedFindings.map((f) =>
        typeof f === "string" ? f : `[${f.id}] ${f.title}`,
      ),
      structuredFindings: syncedFindings,
      qaFailures: Array.isArray(qaReport.checks)
        ? qaReport.checks
            .filter((c: any) => c.result !== "pass")
            .map((c: any) => `${c.criterion}: ${c.evidence}`)
        : [],
      reflectTerminal,
    });

    state.status = finalStatus;

    const reviewComment = formatReviewComment({
      outcome: reviewOutcome,
      route,
      candidate: state.candidate,
      blastRadiusCount: changedFilesFinal.length,
      qaReport,
      reviewerReport: reviewReport,
      dossierFindings: syncedFindings,
      isNeedsOwner,
      handoffProse: isNeedsOwner
        ? formatEscalationHandoff(issue, lap, maxLaps, branch, isMaxLapsExceeded, reviewReport)
        : undefined,
      autoMerge: state.autoMerge,
    });

    if (state.pr) {
      try {
        const commentResult = await publishPrReview({
          repoRoot: state.worktree,
          pr: state.pr,
          candidate: state.candidate,
          reviewBody: reviewComment,
          findings: syncedFindings,
          rawDiff: diffContentFinal,
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
      const outstanding = !readiness.ready ? readiness.reasons : [];
      await syncAndPublishPrEvidence({
        worktree: state.worktree,
        pr: state.pr,
        push: options.push,
        candidate: state.candidate,
        captures: qaReport?.captures || [],
        artifactsDir,
        runDirectory,
        identities: state.identities,
        qaReport,
        builderReport,
        outstanding,
        judgeAlterations,
        autoMerge: state.autoMerge,
        stageName: "Review",
      });
    } else if (options.push !== false) {
      await publishLoopComment({
        worktree: state.worktree,
        issueNumber: issue.number,
        push: options.push,
        commentType: isNeedsOwner ? "escalation" : "review",
        commentBody: reviewComment,
        candidate: state.candidate,
        runDirectory,
      });
    }

    await save();
    return state;
  } catch (error) {
    const isInterrupted = error instanceof RoleInterrupted;
    state.error = error instanceof Error ? error.message : String(error);
    if (isInterrupted) {
      state.status = "interrupted";
      await save();
      return state;
    }

    const scheduleCfg = loadScheduleConfig(root);
    const maxLaps = scheduleCfg.max_laps ?? 3;
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
