import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git, inspectLocalLoop } from "./worktree";
import { computeExternalBlastRadius } from "./blast-radius";
import { annotateDiffWithLineNumbers, assembleRolePromptContext } from "./prompt-context";
import {
  resolveProviderForRole,
  resolveModelForRole,
  resolveEffortForRole,
} from "./config";
import { loadIssueDossier, type LapAttemptRecord } from "./dossier";
import { resolveVerificationProfile, getProfileInstructions } from "./profiles";
import {
  resolveAllowedSkills,
  resolveLoopExtensions,
  buildCuratedAppendPrompts,
} from "./harness-memory";
import { buildProviderArgv } from "./providers";
import { renderPrompt } from "./prompts";
import { interruptionReport, RoleInterrupted } from "./deadlines";
import { extractReport } from "./artifacts";
import type {
  LoopRole,
  LocalIssue,
  LocalLoopResult,
  LocalLoopOptions,
  RoleBudget,
  AgentTransport,
  VerificationProfile,
} from "./types";

export interface InvokeRoleWithDeadlinesOptions {
  role: LoopRole;
  root: string;
  issue: LocalIssue;
  state: LocalLoopResult;
  stateRoot: string;
  runDirectory: string;
  artifactsDir: string;
  handoffDir: string;
  route: "simple" | "continue";
  base: string;
  candidate?: string;
  extraVars?: Record<string, string>;
  cwdOverride?: string;
  optionsOverride?: { requiredAcIds?: string[] };
  template: string;
  options: LocalLoopOptions;
  roleBudgets: Record<LoopRole, RoleBudget>;
  transport: AgentTransport;
  acceptedRef: string;
  holdoutPath: string;
  protectedPaths: string[];
  maxRejections: number;
  initialProfile: VerificationProfile;
  recoveries: NonNullable<LapAttemptRecord["recoveries"]>;
  save: () => Promise<void>;
}

/**
 * Executes a single role with strict deadline enforcement, session isolation,
 * and checkpointing upon timeout or interruption.
 *
 * Enforces:
 * - Runtime profile instructions and changed files detection
 * - External blast-radius scanning (for QA and Reviewer)
 * - Line-annotated diff and diff stat (for Reviewer)
 * - Model tiering and argv compilation from .animus/config.yaml
 * - Attempt continuation loop up to maxContinuations
 * - Durable checkpoint writing before soft deadline
 * - Honest interruption detection (RoleInterrupted)
 * - Artifact persistence and report extraction
 */
export async function invokeRoleWithDeadlines(
  opts: InvokeRoleWithDeadlinesOptions,
): Promise<any> {
  const {
    role,
    root,
    issue,
    state,
    stateRoot,
    runDirectory,
    artifactsDir,
    handoffDir,
    route,
    base,
    candidate,
    extraVars = {},
    cwdOverride,
    optionsOverride,
    template,
    options,
    roleBudgets,
    transport,
    acceptedRef,
    holdoutPath,
    protectedPaths,
    maxRejections,
    initialProfile,
    recoveries,
    save,
  } = opts;

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
  const maxContinuations = options.maxContinuations ?? 1;

  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
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
      if (attempt < maxContinuations) {
        recoveries.push({ role, artifact, reason });
        continue;
      }
      throw new RoleInterrupted(
        `${role} interrupted: ${reason}; continuation budget exhausted; see ${checkpointPath}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(`${roleProvider} ${role} process failed; see ${artifact}`);
    }

    const expectedIdentity = candidate ?? head;
    return extractReport(result.stdout, expectedIdentity, role, artifactsDir, optionsOverride);
  }

  throw new RoleInterrupted(`${role} continuation budget exhausted`);
}
