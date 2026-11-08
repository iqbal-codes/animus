import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git, inspectLocalLoop, findExistingWorktreeForBranch, acquireIssueLock, prepareLoopWorktree, assertCandidate as assertCandidateInWorktree, DEFAULT_PROTECTED_PATHS, readHarnessChecks } from "./worktree";
import { computeExternalBlastRadius } from "./blast-radius";
import { extractRequiredAcIds, validateIssue, formatEscalationHandoff, annotateDiffWithLineNumbers, assembleRolePromptContext } from "./prompt-context";
import { processRun } from "./process";
import { resolveRoleBudgets, RoleInterrupted } from "./deadlines";
import { loadIssueDossier, recordLapAttempt, syncDossierFindings, shouldTriggerReflection, type IssueDossier, type LapAttemptRecord } from "./dossier";
import { executeTerminalReflection } from "./reflector";
import { renderPrompt, loadPrompt } from "./prompts";
import { extractReport, validateEvidenceCitations, setupArtifactDirectories, evaluateHostReadiness } from "./artifacts";
import { formatBuilderComment, formatQaFailureComment, formatCiCheckComment, formatReviewComment } from "./pr-reporting";
import { executeSubticketAutoMerge, evaluateSubticketAutoMerge } from "./merge-queue";
import { readAnimusConfig, resolveProviderForRole, resolveModelForRole, resolveEffortForRole, resolveResumeBuilderSession } from "./config";
import { providerSessionExists } from "./providers";
import { resolveVerificationProfile, getProfileInstructions } from "./profiles";
import { resolveAllowedSkills, resolveLoopExtensions, buildCuratedAppendPrompts } from "./harness-memory";
import { loadScheduleConfig } from "./scheduler";
import { LoopPublisher } from "./publisher";
import { runBoundedRole } from "./role-runner";
import { resolveProjectWorkspace } from "../../packages/contracts/src/paths";
import { assertInstallationNotHeldAtStateDir } from "@animus/contracts/installation-hold";
import type {
  LocalIssue,
  LocalLoopOptions,
  LocalLoopResult,
  LocalLoopStatus,
  LocalLoopRoute,
  LoopRole,
  AgentTransport,
  RoleBudget,
  VerificationProfile,
  LoopEvidence,
} from "./types";
import type { LearningCommandRecord, LearningEvaluator } from "./learning-schema";
import type { LearningDeliveryTransport } from "./learning-delivery";
import type { BuilderReport, QaReport, ReviewerReport, ReviewFinding } from "./report-schema";
import type { PrCheckItem, PrCiAssessment } from "./ci";

function parsePartOf(text: string): number | null {
  const match = text.match(/Part of #(\d+)/i);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

async function findExistingRunForWorktree(
  runsDir: string,
  worktreePath: string,
): Promise<{ runId: string; state: LocalLoopResult } | null> {
  const { readdir } = await import("node:fs/promises");
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const stateFile = join(runsDir, entry, "state.json");
    if (existsSync(stateFile)) {
      try {
        const content = readFileSync(stateFile, "utf8");
        const parsed = JSON.parse(content) as LocalLoopResult;
        if (parsed.worktree === worktreePath) {
          return { runId: entry, state: parsed };
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Unified Terminal Disposition transition shape.
 * Encapsulates all terminal state transitions (QA fast-fail, CI fast-fail,
 * peer review completion, and unhandled catch / interruption).
 */
export interface TerminalDispositionInput {
  stage: "builder" | "ordinary_checks" | "qa" | "ci" | "reviewer";
  outcome: "approved" | "merged" | "waiting_approval" | "sent_back" | "needs_owner" | "failed" | "interrupted";
  candidate?: string;
  changedFiles?: string[];
  qaReport?: QaReport;
  reviewReport?: ReviewerReport;
  builderReport?: BuilderReport;
  failedChecks?: PrCheckItem[];
  syncedFindings?: (ReviewFinding | string)[];
  errorExcerpt?: string;
  diffContentFinal?: string;
  isApproved?: boolean;
  isNeedsOwner?: boolean;
  reviewOutcome?: string;
  comment?: {
    type: "qa_check" | "ci_check" | "review" | "escalation";
    body: string;
    rawDiff?: string;
  };
}

/**
 * Stateful LapSession encapsulating all lap execution state behind runAnimusLoop/runLocalLoop.
 * Eliminates 16-to-29-field option bags across stage transitions and unifies terminal
 * disposition into a single method.
 */
export class LapSession {
  readonly root: string;
  readonly issue: LocalIssue;
  readonly options: LocalLoopOptions & {
    reflection?: {
      proposalEvaluator?: LearningEvaluator;
      deliveryTransport?: LearningDeliveryTransport;
    };
  };
  readonly roleBudgets: Record<LoopRole, RoleBudget>;
  readonly transport: AgentTransport;
  readonly publisher: LoopPublisher;
  readonly state: LocalLoopResult;
  readonly runId: string;
  readonly runDirectory: string;
  readonly artifactsDir: string;
  readonly handoffDir: string;
  readonly stateRoot: string;
  private readonly installationStateDir: string | undefined;
  readonly branch: string;
  readonly base: string;
  readonly baseBranch: string;
  readonly defaultBaseBranch: string;
  readonly defaultBaseSha: string;
  readonly route: LocalLoopRoute;
  readonly lap: number;
  readonly maxLaps: number;
  readonly hasOrigin: boolean;
  readonly partOf?: number;
  readonly integrationBranch?: string;
  readonly protectedPaths: string[];
  readonly maxRejections: number;
  readonly initialProfile: VerificationProfile;
  readonly checks: string[];
  readonly timeout: number;
  readonly builderTemplate: string;
  readonly qaTemplate: string;
  readonly reviewerTemplate: string;
  readonly commandRecords: LearningCommandRecord[] = [];
  readonly recoveries: NonNullable<LapAttemptRecord["recoveries"]> = [];
  readonly sessions: NonNullable<LapAttemptRecord["sessions"]> = {};
  readonly releaseLock: () => Promise<void>;
  readonly save: () => Promise<void>;
  readonly existingWorktree?: string;
  readonly resumeBuilderSessionId?: string;
  private terminalDisposed = false;

  constructor(init: {
    root: string;
    issue: LocalIssue;
    options: LocalLoopOptions & {
      reflection?: {
        proposalEvaluator?: LearningEvaluator;
        deliveryTransport?: LearningDeliveryTransport;
      };
    };
    roleBudgets: Record<LoopRole, RoleBudget>;
    transport: AgentTransport;
    publisher: LoopPublisher;
    state: LocalLoopResult;
    save: () => Promise<void>;
    releaseLock: () => Promise<void>;
    runId: string;
    runDirectory: string;
    artifactsDir: string;
    handoffDir: string;
    stateRoot: string;
    installationStateDir?: string;
    branch: string;
    base: string;
    baseBranch: string;
    defaultBaseBranch: string;
    defaultBaseSha: string;
    route: LocalLoopRoute;
    lap: number;
    maxLaps: number;
    hasOrigin: boolean;
    partOf?: number;
    integrationBranch?: string;
    protectedPaths: string[];
    maxRejections: number;
    initialProfile: VerificationProfile;
    checks: string[];
    timeout: number;
    builderTemplate: string;
    qaTemplate: string;
    reviewerTemplate: string;
    existingWorktree?: string;
    resumeBuilderSessionId?: string;
  }) {
    this.root = init.root;
    this.issue = init.issue;
    this.options = init.options;
    this.roleBudgets = init.roleBudgets;
    this.transport = init.transport;
    this.publisher = init.publisher;
    this.state = init.state;
    this.save = init.save;
    this.releaseLock = init.releaseLock;
    this.runId = init.runId;
    this.runDirectory = init.runDirectory;
    this.artifactsDir = init.artifactsDir;
    this.handoffDir = init.handoffDir;
    this.stateRoot = init.stateRoot;
    this.installationStateDir = init.installationStateDir;
    this.branch = init.branch;
    this.base = init.base;
    this.baseBranch = init.baseBranch;
    this.defaultBaseBranch = init.defaultBaseBranch;
    this.defaultBaseSha = init.defaultBaseSha;
    this.route = init.route;
    this.lap = init.lap;
    this.maxLaps = init.maxLaps;
    this.hasOrigin = init.hasOrigin;
    this.partOf = init.partOf;
    this.integrationBranch = init.integrationBranch;
    this.protectedPaths = init.protectedPaths;
    this.maxRejections = init.maxRejections;
    this.initialProfile = init.initialProfile;
    this.checks = init.checks;
    this.timeout = init.timeout;
    this.builderTemplate = init.builderTemplate;
    this.qaTemplate = init.qaTemplate;
    this.reviewerTemplate = init.reviewerTemplate;
    this.existingWorktree = init.existingWorktree;
    this.resumeBuilderSessionId = init.resumeBuilderSessionId;
  }

  static async init(
    root: string,
    issue: LocalIssue,
    options: LocalLoopOptions & {
      reflection?: {
        proposalEvaluator?: LearningEvaluator;
        deliveryTransport?: LearningDeliveryTransport;
      };
    } = {},
  ): Promise<LapSession> {
    validateIssue(issue);
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

    const workspace = resolveProjectWorkspace(root, {
      stateRoot: options.stateRoot ?? options.stateDirectory,
      customRunsDir: options.runsDir,
    });
    const stateRoot = workspace.stateRoot;
    const runsDir = workspace.runsDir;
    const dossiersDir = workspace.dossiersDir;
    const worktreesDir = workspace.worktreesDir;
    await mkdir(runsDir, { recursive: true });
    await mkdir(dossiersDir, { recursive: true });

    // Acquire issue lock; fail closed if already held
    const releaseLock = await acquireIssueLock(stateRoot, issue.number);

    try {
      const branch = `local-loop/issue-${issue.number}`;
      const existingWorktree = await findExistingWorktreeForBranch(root, branch);

      let runId: string = crypto.randomUUID();
      let route: LocalLoopRoute = "simple";
      let lap = 1;
      let existingPr: string | undefined;

      if (existingWorktree) {
        const found = await findExistingRunForWorktree(runsDir, existingWorktree);
        if (found) {
          runId = found.runId;
          route = "continue";
          lap = (found.state.lap ?? 0) + 1;
          existingPr = found.state.pr;
        }
      }

      if (route === "simple") {
        const dossier = loadIssueDossier(stateRoot, issue.number);
        lap = (dossier?.attempts.length ?? 0) + 1;
      }

      const runDirectory = join(runsDir, runId);
      await mkdir(runDirectory, { recursive: true });
      const { artifactsDir, handoffDir } = await setupArtifactDirectories(runDirectory);

      const issuePath = join(runDirectory, "issue.json");
      if (!existsSync(issuePath)) {
        await Bun.write(issuePath, JSON.stringify(issue, null, 2) + "\n");
      }

      const scheduleConfig = loadScheduleConfig(root);
      const maxLaps = scheduleConfig.max_laps ?? 3;

      const resumeBuilderSessionId = resolveResumeBuilderSessionIdForLap({
        root,
        stateRoot,
        issueNumber: issue.number,
        route,
        runDirectory,
        providerOverride: options.provider,
      });

      const harnessChecks = readHarnessChecks(root);
      const checks = harnessChecks.checks;
      const protectedPaths = harnessChecks.protectedPaths;

      const initialProfile = resolveVerificationProfile(issue);

      const state: LocalLoopResult = {
        runId,
        pid: process.pid,
        lap,
        issue: issue.url,
        route,
        status: "preparing",
        runDirectory,
        worktree: existingWorktree ?? join(worktreesDir, `issue-${issue.number}`),
        branch,
        base,
        pr: existingPr,
        partOf,
        integrationBranch,
        verificationProfile: initialProfile,
        evidence: [],
      };

      const save = async () => {
        const tempPath = join(runDirectory, `state.${crypto.randomUUID()}.tmp`);
        await Bun.write(tempPath, JSON.stringify(state, null, 2) + "\n");
        const { rename } = await import("node:fs/promises");
        await rename(tempPath, join(runDirectory, "state.json"));
      };

      await save();

      const builderTemplate = loadPrompt("loop-work", root);
      const qaTemplate = loadPrompt("loop-check-app", root);
      const reviewerTemplate = loadPrompt("loop-review", root);

      const roleBudgets = resolveRoleBudgets(options);

      const publisher = new LoopPublisher({
        worktree: state.worktree,
        runDirectory,
        artifactsDir,
        issueNumber: issue.number,
        push: options.push !== false,
        runner: options.ghRunner,
      });

      const transport =
        options.transport ??
        options.pi ??
        ((req) => processRun(req.argv, req.cwd, req.timeoutMs, req.env));

      return new LapSession({
        root,
        issue,
        options,
        roleBudgets,
        transport,
        publisher,
        state,
        save,
        releaseLock,
        runId,
        runDirectory,
        artifactsDir,
        handoffDir,
        stateRoot,
        installationStateDir: options.installationStateDir,
        branch,
        base,
        baseBranch,
        defaultBaseBranch,
        defaultBaseSha,
        route,
        lap,
        maxLaps,
        hasOrigin,
        partOf,
        integrationBranch,
        protectedPaths,
        maxRejections: 2,
        initialProfile,
        checks,
        timeout,
        builderTemplate,
        qaTemplate,
        reviewerTemplate,
        existingWorktree: existingWorktree ?? undefined,
        resumeBuilderSessionId,
      });
    } catch (err) {
      // Release lock on post-acquisition failure
      await releaseLock().catch(() => {});
      throw err;
    }
  }

  /**
   * Executes candidate identity assertion in worktree.
   */
  async assertCandidate(expectedCandidate?: string): Promise<string> {
    return assertCandidateInWorktree({
      root: this.root,
      worktree: this.state.worktree,
      base: this.base,
      expectedCandidate,
      protectedPaths: this.protectedPaths,
    });
  }

  /**
   * Bounded role execution through unified runner with deadlines and honest checkpoints.
   */
  async invokeRole(
    role: LoopRole,
    candidate?: string,
    extraVars: Record<string, string> = {},
    cwdOverride?: string,
    optionsOverride?: { requiredAcIds?: string[] },
  ): Promise<any> {
    // Re-check immediately before any role transport spawns. A hold installed
    // while this lap was being prepared must still stop the builder/QA/reviewer.
    this.assertInstallationReady();
    await inspectLocalLoop(this.root);
    this.state.status = role === "builder" ? "building" : role === "qa" ? "qa" : "reviewing";
    await this.save();

    const activeCwd = cwdOverride ?? this.state.worktree;
    const changedFilesList = candidate
      ? (await git(activeCwd, "diff", "--name-only", "--no-renames", this.base, candidate)).trim()
      : "";

    const currentFiles = changedFilesList
      ? changedFilesList
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const effectiveProfile = candidate
      ? resolveVerificationProfile(
          { ...this.issue, verificationProfile: this.issue.verificationProfile },
          currentFiles,
        )
      : this.initialProfile;
    this.state.verificationProfile = effectiveProfile;
    const profileInstructions = getProfileInstructions(effectiveProfile, this.root);

    let blastRadius = "";
    if (role === "qa" || role === "reviewer") {
      blastRadius = await computeExternalBlastRadius(activeCwd, currentFiles);
    }

    let diffStat = "";
    let boundedDiff = "";
    if (role === "reviewer" && candidate) {
      try {
        diffStat = (await git(activeCwd, "diff", "--stat", this.base, candidate)).trim();
        const rawDiff = await git(activeCwd, "diff", "--no-renames", this.base, candidate);
        boundedDiff = annotateDiffWithLineNumbers(rawDiff, 400);
      } catch {
        diffStat = "(Unavailable)";
        boundedDiff = "(Unavailable)";
      }
    }

    const promptVars: Record<string, string> = {
      route: this.route,
      target: this.issue.url,
      pr: this.state.pr ?? "",
      reason: `Autonomous delivery for issue #${this.issue.number}: ${this.issue.title} [profile: ${effectiveProfile}]`,
      runtime: profileInstructions.runtimeInstructions,
      head: candidate ?? "HEAD",
      base: this.base,
      files: changedFilesList || "(all files in commit)",
      depth: profileInstructions.depth,
      profile: effectiveProfile,
      skip_app_launch: profileInstructions.skipAppLaunch ? "true" : "false",
      checks_status: existsSync(join(this.artifactsDir, "builder-checks.log")) ? "passed" : "pending",
      holdout: existsSync(join(this.root, ".factory/holdout/HOLDOUT.md"))
        ? join(this.root, ".factory/holdout/HOLDOUT.md")
        : "",
      protected_paths: this.protectedPaths.join(", "),
      handoff: this.handoffDir,
      evidence_ok: extraVars.evidence_ok ?? "true",
      merge: "approve",
      rejections: String(this.maxRejections),
      ...extraVars,
    };

    const template =
      role === "builder"
        ? this.builderTemplate
        : role === "qa"
          ? this.qaTemplate
          : this.reviewerTemplate;

    const ledger = loadIssueDossier(this.stateRoot, this.issue.number)?.findings ?? [];
    const lifecycleContext = assembleRolePromptContext({
      role,
      issue: this.issue,
      root: this.root,
      handoffDir: this.handoffDir,
      blastRadius,
      diffStat,
      boundedDiff,
      ledger,
    });

    const resumeNotice =
      this.resumeBuilderSessionId && role === "builder"
        ? [
            "## Resumed session (host-verified)",
            "This conversation continues your previous builder session for this issue.",
            "The worktree was reset to origin state: re-verify live files and HEAD before acting.",
            "Treat your own earlier claims as unverified hints, not facts.",
          ].join("\n")
        : "";

    const prompt = [
      renderPrompt(template, promptVars, this.artifactsDir),
      lifecycleContext,
      resumeNotice,
    ]
      .filter(Boolean)
      .join("\n\n");

    const roleProvider = this.options.provider ?? resolveProviderForRole(this.root, role);
    const roleModel = this.options.model ?? resolveModelForRole(this.root, role) ?? "small";
    const roleEffort = this.options.effort ?? resolveEffortForRole(this.root, role);

    const checkpointPath = join(this.handoffDir, "checkpoint.md");
    const budget = this.roleBudgets[role];

    const skills = resolveAllowedSkills(this.root, role, this.defaultBaseSha);
    const extensions = resolveLoopExtensions(this.root, this.defaultBaseSha);
    const appendSystemPrompts = buildCuratedAppendPrompts(
      this.root,
      this.issue,
      changedFilesList,
      this.defaultBaseSha,
    );

    const stepNum = role === "builder" ? 0 : role === "qa" ? 1 : 2;
    const sessionDir = join(this.runDirectory, `${stepNum}-${role}-session`);

    const result = await runBoundedRole({
      role,
      root: this.root,
      cwd: activeCwd,
      prompt,
      sessionDir,
      checkpointPath,
      handoffDir: this.handoffDir,
      runDirectory: this.runDirectory,
      budget,
      maxContinuations: this.options.maxContinuations,
      provider: roleProvider,
      model: roleModel,
      effort: roleEffort,
      skills,
      extensions,
      appendSystemPrompts,
      transport: this.transport,
      candidate,
      optionsOverride,
      onEvidence: (ev) => {
        this.state.evidence.push(ev);
      },
      onSave: async () => {
        await this.save();
      },
      recoveries: this.recoveries,
      getStage: () => this.state.status,
      resumeSessionId: role === "builder" ? this.resumeBuilderSessionId : undefined,
    });

    if (role === "builder" && result.sessionId) {
      this.sessions.builder = { sessionId: result.sessionId, provider: roleProvider };
    }

    return result.report;
  }

  /**
   * Deterministic pre-commit CI gate and ordinary checks in worktree.
   */
  async runOrdinaryChecks(): Promise<void> {
    const checkOutputs: string[] = [];
    const candidate = this.state.candidate ?? "HEAD";
    for (let i = 0; i < this.checks.length; i++) {
      await inspectLocalLoop(this.root);
      const startedAt = new Date().toISOString();
      const result = await processRun(["sh", "-c", this.checks[i]!], this.state.worktree, this.timeout);
      const completedAt = new Date().toISOString();
      const artifact = join(this.runDirectory, `check-${i}.json`);
      const recordPath = `command-${i}.json`;
      const recordContent = JSON.stringify({ command: this.checks[i], ...result });
      await Bun.write(artifact, recordContent);
      await Bun.write(join(this.artifactsDir, recordPath), recordContent);
      this.commandRecords.push({
        executionId: `${this.runId}:check-${i}`,
        runId: this.runId,
        candidate,
        command: this.checks[i]!,
        cwd: this.state.worktree,
        exitCode: result.exitCode,
        startedAt,
        completedAt,
        artifact: {
          runId: this.runId,
          candidate,
          path: recordPath,
          lineStart: 1,
          lineEnd: 1,
          quote: recordContent,
        },
      });
      await Bun.write(
        join(this.artifactsDir, "host-command-records.json"),
        JSON.stringify(this.commandRecords, null, 2),
      );
      checkOutputs.push(
        `Check [${this.checks[i]}]: exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
      );
      this.state.evidence.push({
        kind: "check",
        round: 0,
        candidate,
        artifact,
        exitCode: result.exitCode,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Ordinary project check failed: ${this.checks[i]}`);
      }
    }
    if (!existsSync(join(this.artifactsDir, "builder-checks.log"))) {
      await Bun.write(
        join(this.artifactsDir, "builder-checks.log"),
        checkOutputs.join("\n\n") ||
          "Verified: deterministic pre-commit CI gates executed cleanly (--no-verify prohibited).\n",
      );
    }
  }

  /**
   * Stage 2: Black-Box QA in isolated worktree.
   */
  async executeQa(builderReport: BuilderReport): Promise<{ qaReport: QaReport; evidenceOk: string }> {
    const requiredAcIds = extractRequiredAcIds(this.issue);
    const qaWorktreeDir = join(this.runDirectory, "qa-worktree");
    let testedIntegrationHead = this.state.candidate;
    let mergeConflictOccurred = false;

    try {
      await git(this.root, "worktree", "add", "--detach", qaWorktreeDir, this.state.candidate!);
      if (
        this.state.identities?.targetBaseTip &&
        this.state.identities?.mergeBase &&
        this.state.identities.targetBaseTip !== this.state.identities.mergeBase
      ) {
        try {
          await git(qaWorktreeDir, "merge", "--no-edit", this.state.identities.targetBaseTip);
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
    if (this.state.identities) {
      this.state.identities.testedHead = testedIntegrationHead ?? "";
    }

    let qaReport: any;
    if (mergeConflictOccurred) {
      qaReport = {
        head: testedIntegrationHead ?? "",
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
      const activeQaCwd = existsSync(qaWorktreeDir) ? qaWorktreeDir : this.state.worktree;
      qaReport = await this.invokeRole(
        "qa",
        testedIntegrationHead,
        {
          tested_head: testedIntegrationHead ?? "",
          base_tip: this.state.identities?.targetBaseTip ?? "",
          merge_base: this.state.identities?.mergeBase ?? "",
          merged_with: this.state.identities?.targetBaseTip ?? "",
        },
        activeQaCwd,
        { requiredAcIds },
      );
    }

    if (existsSync(qaWorktreeDir)) {
      try {
        const qaHeadAfter = (await git(qaWorktreeDir, "rev-parse", "HEAD")).trim();
        const qaDirty = (await git(qaWorktreeDir, "status", "--porcelain")).trim();
        if (!qaDirty && qaHeadAfter === testedIntegrationHead) {
          await git(this.root, "worktree", "remove", "--force", qaWorktreeDir).catch(() => {});
        } else {
          console.log(`Preserving QA worktree at ${qaWorktreeDir} for diagnosis`);
        }
      } catch {}
    }

    let evidenceOk = "true";
    await Bun.write(join(this.handoffDir, "app-check.json"), JSON.stringify(qaReport, null, 2));
    await Bun.write(join(this.artifactsDir, "app-check.json"), JSON.stringify(qaReport, null, 2));

    const { ok: evidenceOkBool, problems: evidenceProblems } = validateEvidenceCitations(
      qaReport,
      this.artifactsDir,
    );
    await Bun.write(join(this.handoffDir, "evidence-problems.txt"), evidenceProblems.join("\n"));
    evidenceOk = evidenceOkBool ? "true" : "false";

    await this.publisher.syncAndPublishPrEvidence({
      pr: this.state.pr,
      candidate: this.state.candidate!,
      captures: qaReport?.captures || [],
      identities: this.state.identities,
      qaReport,
      builderReport,
      outstanding: !(qaReport.passed ?? qaReport.overall === "PASS")
        ? [
            `QA Verification ${qaReport.overall}: ${
              qaReport.summary ||
              (qaReport.lines || [])
                .filter((l: any) => l.verdict !== "PASS")
                .map((l: any) => l.id)
                .join(", ")
            }`,
          ]
        : [],
      stageName: "QA",
    });

    return { qaReport, evidenceOk };
  }

  /**
   * Stage 2.5: PR CI check verification gate.
   */
  async verifyPrCi(): Promise<{ failed: boolean; failedChecks?: PrCheckItem[] }> {
    const prTarget = this.state.pr ?? (this.options.checkPrCi ? "mock-pr" : undefined);
    if (!prTarget || (this.options.push === false && !this.options.checkPrCi)) {
      return { failed: false };
    }

    if (!this.state.pr && this.options.checkPrCi) {
      this.state.pr = prTarget;
    }
    const ciTimeoutSeconds = this.options.ciWaitSeconds ?? 15;
    const ciAssessment: PrCiAssessment = this.options.checkPrCi
      ? await this.options.checkPrCi(prTarget, { cwd: this.state.worktree })
      : await this.publisher.pollPrCiStatus(prTarget, {
          maxWaitSeconds: ciTimeoutSeconds,
          pollIntervalSeconds: 5,
        });

    await Bun.write(join(this.artifactsDir, "pr-ci.json"), JSON.stringify(ciAssessment, null, 2));

    if (ciAssessment.status === "fail") {
      return { failed: true, failedChecks: ciAssessment.failedChecks };
    }

    return { failed: false };
  }

  /**
   * Stage 3: Code review readiness evaluation.
   */
  async evaluateReview(reviewReport: ReviewerReport, qaReport: QaReport) {
    const initialDossier = loadIssueDossier(this.stateRoot, this.issue.number) ?? {
      issueNumber: this.issue.number,
      issueTitle: this.issue.title,
      issueUrl: this.issue.url,
      branch: this.branch,
      prUrl: this.state.pr,
      attempts: [],
    };

    const candidateHead = this.state.candidate ?? "";
    const syncedFindings = syncDossierFindings(
      initialDossier,
      Array.isArray(reviewReport.findings) ? reviewReport.findings : [],
      Array.isArray(reviewReport.dispositions) ? reviewReport.dispositions : [],
      Array.isArray(reviewReport.rechecks) ? reviewReport.rechecks : [],
      this.lap,
      { candidate: candidateHead, artifactsDir: this.artifactsDir },
    );

    const qaPassed = Boolean((qaReport as any).passed ?? qaReport.overall === "PASS");
    const reviewPassed = Boolean(
      (reviewReport as any).passed ??
        (reviewReport.outcome === "approved" || reviewReport.outcome === "merge"),
    );

    const readiness = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport: {
        passed: qaPassed,
        overall: qaReport.overall,
        problems: (qaReport as any).problems,
        lines: qaReport.lines,
      },
      reviewerReport: {
        passed: reviewPassed,
        outcome: reviewReport.outcome,
        sha: reviewReport.sha,
        axes: reviewReport.axes,
        findings: reviewReport.findings,
        dispositions: reviewReport.dispositions,
        rechecks: reviewReport.rechecks,
        problems: (reviewReport as any).problems,
      },
      ciPassed: true,
      lap: this.lap,
      maxLaps: this.maxLaps,
      expectedCandidate: candidateHead,
      outstandingFindings: syncedFindings,
    });

    const isApproved = Boolean(qaPassed && reviewPassed && readiness.ready);
    const isExplicitNeedsOwner =
      reviewReport.outcome === "needs-owner" || (reviewReport as any).verdict === "needs_owner";
    const isMaxLapsExceeded = !isApproved && this.lap >= this.maxLaps;
    const isNeedsOwner = !isApproved && (isExplicitNeedsOwner || isMaxLapsExceeded);

    const reviewOutcome = isApproved ? "approved" : isNeedsOwner ? "needs owner" : "sent back";
    const finalStatus: "waiting_approval" | "needs_owner" | "sent_back" | "merged" = isApproved
      ? "waiting_approval"
      : isNeedsOwner
        ? "needs_owner"
        : "sent_back";

    const changedFilesFinal = (
      await git(this.state.worktree, "diff", "--name-only", "--no-renames", this.base, candidateHead)
    )
      .split("\n")
      .filter(Boolean);

    const diffContentFinal = await git(this.state.worktree, "diff", "--no-renames", this.base, candidateHead);

    const autoMergeEval = evaluateSubticketAutoMerge({
      isSubticket: this.partOf !== undefined,
      targetBranch: this.baseBranch,
      baseBranch: this.defaultBaseBranch,
      readinessReady: isApproved,
      reviewerReport: reviewReport,
      changedFiles: changedFilesFinal,
      diffContent: diffContentFinal,
      protectedPaths: this.protectedPaths,
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

  /**
   * Unified terminal disposition transition.
   * Handles escalation, human labeling, dossier recording, reflection, publication,
   * and atomic state.json persistence across ALL exit paths.
   */
  async terminalDisposition(input: TerminalDispositionInput): Promise<LocalLoopResult> {
    if (this.terminalDisposed) {
      try {
        await this.save();
      } catch {}
      return this.state;
    }
    this.terminalDisposed = true;

    const isExceeded = this.lap >= this.maxLaps;
    let finalStatus: LocalLoopStatus;

    if (input.outcome === "approved") {
      finalStatus = "waiting_approval";
    } else if (input.outcome === "sent_back" || input.outcome === "failed") {
      finalStatus = isExceeded ? "needs_owner" : input.outcome;
    } else {
      finalStatus = input.outcome;
    }

    this.state.status = finalStatus;
    if (input.errorExcerpt) {
      this.state.error = input.errorExcerpt;
    }

    if (finalStatus === "interrupted") {
      await this.save();
      return this.state;
    }

    const candidate = input.candidate ?? this.state.candidate;

    if (finalStatus === "needs_owner") {
      await this.publisher.escalateToHuman(candidate);
    }

    let changedFiles = input.changedFiles;
    if (!changedFiles && candidate && this.state.worktree) {
      try {
        changedFiles = (
          await git(this.state.worktree, "diff", "--name-only", "--no-renames", this.base, candidate)
        )
          .split("\n")
          .filter(Boolean);
      } catch {
        changedFiles = [];
      }
    }
    changedFiles = changedFiles ?? [];

    let qaFailures: string[] = [];
    if (input.qaReport) {
      if (Array.isArray(input.qaReport.lines)) {
        qaFailures = input.qaReport.lines
          .filter((l: any) => l.verdict !== "PASS" && l.verdict !== "OK")
          .map((l: any) => `${l.id}: ${l.observed || l.text || l.verdict}`);
      } else if (Array.isArray((input.qaReport as any).checks)) {
        qaFailures = (input.qaReport as any).checks
          .filter((c: any) => c.result !== "pass")
          .map((c: any) => `${c.criterion}: ${c.evidence}`);
      }
    }

    let reviewFindings: string[] = [];
    if (input.failedChecks) {
      reviewFindings = input.failedChecks.map(
        (c: any) =>
          `CI Check [${c.workflow ? c.workflow + " / " : ""}${c.name}] failed: ${c.link || c.state}`,
      );
    } else if (input.syncedFindings) {
      reviewFindings = input.syncedFindings.map((f) =>
        typeof f === "string" ? f : `[${f.id}] ${f.title}`,
      );
    }

    const dossier = recordLapAttempt(
      this.stateRoot,
      {
        issueNumber: this.issue.number,
        issueTitle: this.issue.title,
        issueUrl: this.issue.url,
        branch: this.branch,
        prUrl: this.state.pr,
      },
      {
        runId: this.runId,
        timestamp: new Date().toISOString(),
        status: finalStatus as "failed" | "merged" | "needs_owner" | "sent_back" | "waiting_approval",
        candidateHead: candidate,
        artifactsDir: this.artifactsDir,
        evidence: [...this.state.evidence],
        commandRecords: [...this.commandRecords],
        recoveries: [...this.recoveries],
        sessions: { ...this.sessions },
        changedFiles,
        failedStage:
          input.stage === "reviewer" && input.isApproved ? undefined : input.stage,
        errorExcerpt: input.errorExcerpt,
        reviewFindings,
        structuredFindings: input.syncedFindings as any,
        qaFailures,
      },
    );

    if (shouldTriggerReflection(dossier)) {
      try {
        await executeTerminalReflection({
          root: this.root,
          stateRoot: this.stateRoot,
          runDirectory: this.runDirectory,
          artifactsDir: this.artifactsDir,
          handoffDir: this.handoffDir,
          worktree: this.state.worktree,
          candidate,
          defaultBaseBranch: this.defaultBaseBranch,
          dossier,
          transport: this.transport,
          budget: this.roleBudgets.reflector,
          maxContinuations: this.options.maxContinuations,
          push: this.options.push,
          pr: this.state.pr,
          acceptedRef: this.defaultBaseSha,
          commandRecords: this.commandRecords,
          proposalEvaluator: this.options.reflection?.proposalEvaluator,
          deliveryTransport: this.options.reflection?.deliveryTransport,
          currentStatus: this.state.status,
          setStatus: (status) => {
            this.state.status = status;
          },
          onEvidence: async (ev) => {
            this.state.evidence.push(ev);
          },
          onSave: async () => {
            await this.save();
          },
        });
      } catch (reflectionError: unknown) {
        if (reflectionError instanceof RoleInterrupted) {
          this.state.status = "interrupted";
          this.state.error = reflectionError.message;
        } else {
          this.state.status = "failed";
          this.state.error =
            reflectionError instanceof Error ? reflectionError.message : String(reflectionError);
        }
      }
    }

    if (input.comment) {
      if (input.comment.type === "review" && this.state.pr) {
        try {
          const commentResult = await this.publisher.publishReview({
            pr: this.state.pr,
            candidate: candidate!,
            reviewBody: input.comment.body,
            findings: input.syncedFindings as any,
            rawDiff: input.comment.rawDiff,
          });
          if (commentResult.commentUrl) {
            this.state.reviewCommentUrl = commentResult.commentUrl;
          }
        } catch (comErr: unknown) {
          const msg = comErr instanceof Error ? comErr.message : String(comErr);
          console.error("Warning: Review comment publication error:", msg);
        }

        const judgeAlterations =
          input.reviewReport &&
          Array.isArray(input.reviewReport.judge_changes) &&
          input.reviewReport.judge_changes.length > 0
            ? input.reviewReport.judge_changes.map(
                (jc: any) => `${jc.file || jc.path || ""}: ${jc.description || jc.reason || ""}`,
              )
            : undefined;

        await this.publisher.syncAndPublishPrEvidence({
          pr: this.state.pr,
          candidate: candidate!,
          captures: input.qaReport?.captures || [],
          identities: this.state.identities,
          qaReport: input.qaReport,
          builderReport: input.builderReport,
          outstanding: (input.syncedFindings ?? []).map((f: any) =>
            typeof f === "string" ? f : `[${f.id}] ${f.title}`,
          ),
          judgeAlterations,
          autoMerge: this.state.autoMerge,
          stageName: "Review",
        });
      } else if (this.state.pr) {
        await this.publisher.publishLoopComment({
          pr: this.state.pr,
          commentType: input.comment.type,
          commentBody: input.comment.body,
          candidate: candidate!,
        });

        if (input.stage === "ci") {
          await this.publisher.syncAndPublishPrEvidence({
            pr: this.state.pr,
            candidate: candidate!,
            captures: input.qaReport?.captures || [],
            identities: this.state.identities,
            qaReport: input.qaReport,
            builderReport: input.builderReport,
            outstanding: (input.failedChecks ?? []).map((c: any) => `CI Check [${c.name}] failed`),
            stageName: "CI",
          });
        }
      } else if (this.options.push !== false) {
        try {
          const commentType =
            input.comment.type === "review"
              ? "review"
              : input.comment.type === "qa_check"
                ? "qa_check"
                : input.comment.type === "ci_check"
                  ? "ci_check"
                  : "escalation";
          await this.publisher.publishComment({
            target: { kind: "issue", idOrUrl: this.issue.number },
            commentType,
            commentBody: input.comment.body,
            candidate: candidate!,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("Warning: Failed to publish comment on issue:", msg);
        }
      }
    }

    if (input.reviewReport) {
      try {
        await Bun.write(
          join(this.artifactsDir, "review.json"),
          JSON.stringify(input.reviewReport, null, 2),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Warning: Failed to write review.json artifact:", msg);
      }
    }

    try {
      await this.save();
    } catch (saveErr: unknown) {
      const msg = saveErr instanceof Error ? saveErr.message : String(saveErr);
      console.error("Warning: Failed to persist terminal state.json:", msg);
    }
    return this.state;
  }

  /**
   * Runs the full autonomous lap lifecycle through the public seam.
   */
  private assertInstallationReady(): void {
    assertInstallationNotHeldAtStateDir(this.installationStateDir);
  }

  async run(): Promise<LocalLoopResult> {
    try {
      // No worktree allocation, checker or role transport may run while the
      // installation is held by a restore.
      this.assertInstallationReady();
      // Worktree allocation / reuse
      await prepareLoopWorktree({
        root: this.root,
        worktreePath: this.state.worktree,
        branch: this.branch,
        base: this.base,
        route: this.route as "simple" | "continue",
        hasOrigin: this.hasOrigin,
        baseBranch: this.baseBranch,
        existingWorktree: this.existingWorktree,
      });

      const targetBaseTip = (await git(this.root, "rev-parse", this.base)).trim();
      const currentHead = (await git(this.state.worktree, "rev-parse", "HEAD")).trim();
      const mergeBase = (await git(this.state.worktree, "merge-base", this.base, currentHead)).trim();

      this.state.identities = {
        targetBaseTip,
        mergeBase,
        prHead: currentHead,
        testedHead: currentHead,
        environment: `Darwin ${process.arch} Bun ${Bun.version}`,
      };

      // -------------------------------------------------------------
      // STAGE 1: BUILDER (loop-work)
      // -------------------------------------------------------------
      const builderReport = await this.invokeRole("builder");
      this.state.candidate = await this.assertCandidate(builderReport.candidate);
      this.state.builderReport = builderReport;
      this.state.identities.prHead = this.state.candidate;
      this.state.identities.testedHead = this.state.candidate;

      await this.publisher.publishBuilderDelivery({
        branch: this.branch,
        issue: this.issue,
        state: this.state,
        builderReport,
        route: this.route,
        lap: this.lap,
        handoffDir: this.handoffDir,
        integrationBranch: this.integrationBranch,
      });

      // -------------------------------------------------------------
      // DETERMINISTIC PRE-COMMIT CI GATE & ORDINARY CHECKS
      // -------------------------------------------------------------
      this.state.status = "checking";
      await this.save();
      await this.runOrdinaryChecks();
      await this.assertCandidate(this.state.candidate);

      // -------------------------------------------------------------
      // STAGE 2: BLACK-BOX QA (loop-check-app) & QA FAST-FAIL GATE
      // -------------------------------------------------------------
      const { qaReport, evidenceOk } = await this.executeQa(builderReport);
      this.state.qaReport = qaReport;
      await this.assertCandidate(this.state.candidate);

      // QA Fast-Fail: short-circuit reviewer when black-box QA fails
      const qaPassed = Boolean((qaReport as any).passed ?? qaReport.overall === "PASS");
      if (!qaPassed) {
        const qaComment = formatQaFailureComment({
          route: this.route,
          candidate: this.state.candidate!,
          qaReport,
          isMaxLapsExceeded: this.lap >= this.maxLaps,
        });

        return await this.terminalDisposition({
          stage: "qa",
          outcome: "sent_back",
          candidate: this.state.candidate,
          qaReport,
          comment: {
            type: "qa_check",
            body: qaComment,
          },
        });
      }

      // -------------------------------------------------------------
      // STAGE 2.5: PR CI CHECK GATE (Fail-fast if remote CI failed)
      // -------------------------------------------------------------
      const ciResult = await this.verifyPrCi();
      if (ciResult.failed) {
        const ciComment = formatCiCheckComment({
          route: this.route,
          candidate: this.state.candidate!,
          failedChecks: ciResult.failedChecks ?? [],
          isMaxLapsExceeded: this.lap >= this.maxLaps,
        });

        return await this.terminalDisposition({
          stage: "ci",
          outcome: "sent_back",
          candidate: this.state.candidate,
          qaReport,
          builderReport,
          failedChecks: ciResult.failedChecks,
          comment: {
            type: "ci_check",
            body: ciComment,
          },
        });
      }

      // -------------------------------------------------------------
      // STAGE 3: CODE REVIEW (loop-review)
      // -------------------------------------------------------------
      const reviewReport = await this.invokeRole("reviewer", this.state.candidate, { evidence_ok: evidenceOk });
      this.state.reviewerReport = reviewReport;
      await this.assertCandidate(this.state.candidate);
      await Bun.write(join(this.artifactsDir, "review.json"), JSON.stringify(reviewReport, null, 2));
      const reviewerDir = join(this.runDirectory, "reviewer");
      await mkdir(reviewerDir, { recursive: true });
      await Bun.write(
        join(reviewerDir, "report.md"),
        reviewReport.summary ?? "Review approved",
      );

      let reviewEval: {
        readiness: any;
        isApproved: boolean;
        isNeedsOwner: boolean;
        isMaxLapsExceeded: boolean;
        reviewOutcome: string;
        finalStatus: "waiting_approval" | "needs_owner" | "sent_back" | "merged";
        syncedFindings: any[];
        changedFilesFinal: string[];
        diffContentFinal: string;
        autoMergeEval: any;
      } = await this.evaluateReview(reviewReport, qaReport);
      this.state.findings = reviewEval.syncedFindings;
      this.state.autoMerge = reviewEval.autoMergeEval;
      await Bun.write(
        join(this.artifactsDir, "auto-merge-judgement.json"),
        JSON.stringify(reviewEval.autoMergeEval, null, 2),
      );

      // -------------------------------------------------------------
      // STAGE 3.5: SUBTICKET AUTO-MERGE EXECUTION
      // -------------------------------------------------------------
      if (reviewEval.isApproved && reviewEval.autoMergeEval.authorized && this.integrationBranch) {
        const mergeRes = await executeSubticketAutoMerge({
          root: this.root,
          candidate: this.state.candidate!,
          integrationBranch: this.integrationBranch,
          targetBaseTip: this.state.identities.targetBaseTip!,
          worktree: this.state.worktree,
          issueNumber: this.issue.number,
          partOf: this.partOf,
          defaultBaseBranch: this.defaultBaseBranch,
          pr: this.state.pr,
          hasOrigin: this.hasOrigin,
          push: this.options.push !== false,
          autoMergeEval: reviewEval.autoMergeEval,
          assertCandidateFn: assertCandidateInWorktree,
          db: (this.options as any).db,
          dbPath: (this.options as any).dbPath,
          projectId: (this.options as any).projectId,
        });
        const sessionFinalStatus: "waiting_approval" | "needs_owner" | "sent_back" | "merged" =
          mergeRes.finalStatus === "merged"
            ? "merged"
            : mergeRes.finalStatus === "manual_intervention_required"
              ? "needs_owner"
              : "waiting_approval";

        reviewEval = {
          ...reviewEval,
          autoMergeEval: mergeRes.evaluation,
          finalStatus: sessionFinalStatus,
          reviewOutcome: mergeRes.reviewOutcome,
        };
        if (mergeRes.error) {
          this.state.error = mergeRes.error;
        }
        this.state.autoMerge = mergeRes.evaluation;
        await Bun.write(
          join(this.artifactsDir, "auto-merge-judgement.json"),
          JSON.stringify(mergeRes.evaluation, null, 2),
        );
        if (mergeRes.finalIntegrationPr) {
          this.state.finalIntegrationPr = mergeRes.finalIntegrationPr;
        }
      }

      // -------------------------------------------------------------
      // STAGE 4: FINALIZATION & TERMINAL DISPOSITION
      // -------------------------------------------------------------
      const reviewComment = formatReviewComment({
        outcome: reviewEval.reviewOutcome,
        route: this.route,
        candidate: this.state.candidate!,
        blastRadiusCount: reviewEval.changedFilesFinal.length,
        qaReport,
        reviewerReport: reviewReport,
        dossierFindings: reviewEval.syncedFindings,
        isNeedsOwner: reviewEval.isNeedsOwner,
        handoffProse: reviewEval.isNeedsOwner
          ? formatEscalationHandoff(
              this.issue,
              this.lap,
              this.maxLaps,
              this.branch,
              reviewEval.isMaxLapsExceeded,
              reviewReport,
            )
          : undefined,
        autoMerge: this.state.autoMerge,
      });

      return await this.terminalDisposition({
        stage: "reviewer",
        outcome: reviewEval.finalStatus,
        candidate: this.state.candidate,
        changedFiles: reviewEval.changedFilesFinal,
        qaReport,
        reviewReport,
        builderReport,
        syncedFindings: reviewEval.syncedFindings,
        diffContentFinal: reviewEval.diffContentFinal,
        isApproved: reviewEval.isApproved,
        isNeedsOwner: reviewEval.isNeedsOwner,
        reviewOutcome: reviewEval.reviewOutcome,
        comment: {
          type: "review",
          body: reviewComment,
          rawDiff: reviewEval.diffContentFinal,
        },
      });
    } catch (error) {
      return await this.terminalDisposition({
        stage: this.state.evidence.some((e) => e.kind === "check" && e.exitCode !== 0)
          ? "ordinary_checks"
          : "builder",
        outcome: error instanceof RoleInterrupted ? "interrupted" : "failed",
        errorExcerpt: error instanceof Error ? error.message : String(error),
        candidate: this.state.candidate,
      });
    } finally {
      try {
        await this.releaseLock();
      } catch {}
    }
  }
}

/**
 * Resolves an explicit builder session id to resume for a `continue` lap.
 *
 * Fails closed to a fresh session unless every precondition holds: the toggle is
 * enabled, this is a `continue` lap, the previous attempt was `sent_back` with a
 * recorded candidate, that attempt captured a builder session id, the provider is
 * unchanged, and the provider transcript still exists on disk. Never falls back to
 * `--continue`, which would pick up whichever session last ran in this directory.
 */
export function resolveResumeBuilderSessionIdForLap(input: {
  root: string;
  stateRoot: string;
  issueNumber: number;
  route: LocalLoopRoute;
  runDirectory: string;
  providerOverride?: string;
}): string | undefined {
  const { root, stateRoot, issueNumber, route, runDirectory } = input;
  if (route !== "continue") return undefined;
  if (!resolveResumeBuilderSession(root)) return undefined;

  const dossier = loadIssueDossier(stateRoot, issueNumber);
  const previous = dossier?.attempts.at(-1);
  if (!previous || previous.status !== "sent_back" || !previous.candidateHead) return undefined;

  const recorded = previous.sessions?.builder;
  if (!recorded?.sessionId) return undefined;

  const provider = input.providerOverride ?? resolveProviderForRole(root, "builder");
  if (recorded.provider !== provider) return undefined;

  const sessionDir = join(runDirectory, "0-builder-session");
  if (!providerSessionExists(provider, sessionDir, recorded.sessionId)) return undefined;

  return recorded.sessionId;
}

/**
 * Executes exactly ONE autonomous lap following the canonical Animus SDLC lifecycle
 * through the internal stateful LapSession.
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
  // A restored installation is held: no native builder lap may start until the
  // installation hold is released through verified reconciliation. Always resolve
  // the canonical installation state directory (explicit embedder override or the
  // environment default) and never the per-project worktree stateRoot, which has
  // no console.db.
  assertInstallationNotHeldAtStateDir(options.installationStateDir);
  const session = await LapSession.init(root, issue, options);
  return await session.run();
}

/**
 * Backward compatibility alias for the canonical runAnimusLoop orchestrator.
 */
export const runLocalLoop = runAnimusLoop;
