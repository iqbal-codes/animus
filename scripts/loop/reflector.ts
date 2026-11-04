import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { IssueDossier } from "./dossier";
import { shouldTriggerReflection, saveIssueDossier } from "./dossier";
import type { LessonEntry } from "./harness-memory";
import { isHarnessSafeMode, resolveAllowedSkills, resolveLoopExtensions } from "./harness-memory";
import { parseAgentReport } from "./artifacts";
import { loadPrompt, renderPrompt } from "./prompts";
import { resolveRoleConfig } from "./config";
import { buildProviderArgv } from "./providers";
import type { AgentTransport, LocalLoopStatus, LoopEvidence } from "./types";
import { learningProposalSchema, learningVerdictSchema, type LearningEvaluator, type LearningCommandRecord, type LearningProposalArtifact } from "./learning-schema";
import { evaluateLearningWithHarness, resolveLearningEvidence, validateLearningMutation } from "./learning-gates";
import { git } from "./worktree";
import { deliverLearningProposal, type LearningDeliveryTransport } from "./learning-delivery";
import { interruptionReport, RoleInterrupted } from "./deadlines";

export interface CandidateLessonDraft {
  topic: string;
  trigger_patterns: string[];
  rule: string;
  evidence: string;
}

export interface SkillPromotionDraft {
  skill_name: string;
  description: string;
  agents_md_pointer: string;
  skill_markdown: string;
}

export interface CodebaseRuleDraft {
  id: string;
  description: string;
  file_glob: string;
  forbid_regex?: string;
  require_regex?: string;
  replacement_hint: string;
  mode?: "warn" | "block";
}

export interface ReflectionProposal {
  attribution: "helped" | "hurt" | "no_observed_effect" | "confounded";
  tool_guidance_updates?: Record<string, string>;
  pattern_registry_updates?: Record<string, string>;
  component_registry_updates?: Record<string, string>;
  codebase_rule_updates?: CodebaseRuleDraft[];
  candidate_lessons?: CandidateLessonDraft[];
  skill_promotion?: SkillPromotionDraft | null;
}

export interface ReflectionOutcome {
  triggered: boolean;
  status: "held" | "proposed" | "no_entry" | "skipped" | "error";
  proposalPath?: string;
  reasons?: string[];
  attribution?: string;
  persistedLessons: LessonEntry[];
  rejectedLessons: Array<{ draft: CandidateLessonDraft; reason: string }>;
  updatedTools: string[];
  updatedComponents?: string[];
  updatedRules?: string[];
  promotedSkill?: {
    skillName: string;
    skillPath: string;
    agentsMdUpdated: boolean;
    prUrl?: string;
  };
}

export function persistCodebaseRulesUpdates(
  root: string,
  patternUpdates?: Record<string, string>,
  ruleUpdates?: CodebaseRuleDraft[],
): { updatedComponents: string[]; updatedRules: string[] } {
  const filePath = join(root, ".factory/codebase-rules.json");
  let current: {
    schema_version?: number;
    description?: string;
    rules?: CodebaseRuleDraft[];
    pattern_registry?: Record<string, string>;
    component_registry?: Record<string, string>;
  } = {
    schema_version: 1,
    description:
      "Domain-agnostic codebase conventions & shared pattern registry enforced by loop-guard.ts",
    rules: [],
    pattern_registry: {},
  };

  if (existsSync(filePath)) {
    try {
      current = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {}
  }

  current.pattern_registry = current.pattern_registry ?? current.component_registry ?? {};
  current.rules = Array.isArray(current.rules) ? current.rules : [];

  const updatedComponents: string[] = [];
  for (const [k, v] of Object.entries(patternUpdates ?? {})) {
    if (typeof k === "string" && k.trim() && typeof v === "string" && v.trim()) {
      current.pattern_registry[k.trim()] = v.trim();
      updatedComponents.push(k.trim());
    }
  }

  const updatedRules: string[] = [];
  for (const rule of ruleUpdates ?? []) {
    if (!rule?.id || !rule?.file_glob || !rule?.replacement_hint) continue;
    const normalized: CodebaseRuleDraft = {
      ...rule,
      mode: rule.mode ?? "warn",
    };
    const existingIdx = current.rules.findIndex((r) => r.id === normalized.id);
    if (existingIdx >= 0) {
      current.rules[existingIdx] = normalized;
    } else {
      current.rules.push(normalized);
    }
    updatedRules.push(normalized.id);
  }

  if (updatedComponents.length > 0 || updatedRules.length > 0) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, filePath);
  }

  return { updatedComponents, updatedRules };
}

export interface RunPostIssueReflectionOptions {
  root: string;
  worktree: string;
  dossier: IssueDossier;
  artifactsDir: string;
  transport: AgentTransport;
  proposalEvaluator?: LearningEvaluator;
  evidenceRoots?: Record<string, string>;
  commandRecords?: LearningCommandRecord[];
  timeoutMs?: number;
  acceptedRef?: string;
}

export async function runPostIssueReflection(options: RunPostIssueReflectionOptions): Promise<ReflectionOutcome> {
  const { root, worktree, dossier, artifactsDir, transport } = options;
  const empty = { persistedLessons: [], rejectedLessons: [], updatedTools: [], updatedComponents: [], updatedRules: [] };
  if (isHarnessSafeMode(root)) return { ...empty, triggered: false, status: "skipped", reasons: ["harness_safe_mode"] };
  try {
    const config = resolveRoleConfig(root, "reflector");
    let template: string;
    try { template = loadPrompt("loop-reflect", root); }
    catch { template = "Return a schema_version:1 learning proposal with attribution and mutations. Never write files. Dossier: $INPUTS.dossier_json"; }
    const prompt = renderPrompt(template, { target: dossier.issueUrl, reason: dossier.issueTitle, dossier_json: JSON.stringify(dossier) }, artifactsDir);
    const response = await transport({ argv: buildProviderArgv(config.provider, { model: config.model, effort: config.effort, prompt, skills: resolveAllowedSkills(root, "reflector", options.acceptedRef), extensions: resolveLoopExtensions(root, options.acceptedRef) }), cwd: worktree, role: "reflector", provider: config.provider, timeoutMs: options.timeoutMs ?? 300000 });
    if (response.exitCode !== 0) return { ...empty, triggered: true, status: "error", reasons: ["reflector_transport_failed"] };
    let raw = response.stdout;
    for (const line of response.stdout.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && Array.isArray(event.message?.content)) raw = event.message.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
      } catch { /* Direct JSON is parsed below. */ }
    }
    const parsed = learningProposalSchema.safeParse(parseAgentReport(raw));
    if (!parsed.success) return { ...empty, triggered: true, status: "held", reasons: ["invalid_proposal_schema"] };
    const proposal = parsed.data;
    const defaultEvaluator: LearningEvaluator = (m, ev) =>
      evaluateLearningWithHarness(m, ev, {
        root: options.root,
        cwd: options.worktree,
        transport: options.transport,
        timeoutMs: options.timeoutMs,
      });
    const evaluator = options.proposalEvaluator ?? defaultEvaluator;
    const artifact: LearningProposalArtifact = { schema_version: 1, status: "held", issueNumber: dossier.issueNumber, accepted: [], held: [] };
    for (const mutation of proposal.mutations) {
      try {
        if (proposal.attribution === "confounded") throw new Error("confounded_attribution");
        const evidence = mutation.evidence.map(ref => resolveLearningEvidence(ref, dossier, options.evidenceRoots ?? {}));
        validateLearningMutation(mutation, options.commandRecords ?? [], dossier, options.evidenceRoots ?? {});
        const verdict = learningVerdictSchema.parse(await evaluator(mutation, evidence));
        if (!verdict.grounding.approved || verdict.grounding.confidence < .7 || !verdict.quality.approved || verdict.quality.confidence < .7 || verdict.hallucinationRisk !== "grounded_in_logs") throw new Error("evaluation_rejected");
        artifact.accepted.push({ mutation, evidence, verdict });
      } catch (error) { artifact.held.push({ key: mutation.key, reason: error instanceof Error ? error.message : "evaluation_failed" }); }
    }
    artifact.status = artifact.accepted.length ? "proposed" : artifact.held.length ? "held" : "no_entry";
    // Exclusive creation prevents following a pre-existing proposal-file symlink.
    const proposalPath = join(artifactsDir, `learning-proposal-${crypto.randomUUID()}.json`);
    writeFileSync(proposalPath, JSON.stringify(artifact, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return { ...empty, triggered: true, status: artifact.status, attribution: proposal.attribution, proposalPath, reasons: artifact.held.map(item => item.key + ":" + item.reason) };
  } catch (error) {
    return { ...empty, triggered: true, status: "error", reasons: [error instanceof Error ? error.message : "reflection_failed"] };
  }
}

export interface BoundedReflectionTransportOptions {
  transport: AgentTransport;
  budget: { softMs: number; hardMs: number };
  handoffDir: string;
  runDirectory: string;
  maxContinuations?: number;
  onEvidence?: (evidence: LoopEvidence) => Promise<void> | void;
  onSave?: () => Promise<void> | void;
  getStage?: () => string;
  gitFn?: typeof git;
}

/**
 * Creates an agent transport wrapped with bounded execution invariants:
 * - Injects soft & hard deadlines into prompt argv and environment.
 * - Handles continuation attempts up to maxContinuations.
 * - Persists attempt records and checkpoints in handoffDir.
 * - Throws RoleInterrupted when the continuation budget is exhausted.
 */
export function createBoundedReflectionTransport(
  options: BoundedReflectionTransportOptions,
): AgentTransport {
  const { transport, budget, handoffDir, runDirectory } = options;
  const gitCmd = options.gitFn ?? git;
  const role = "reflector";
  const checkpointPath = join(handoffDir, "reflector-checkpoint.md");

  return async (request) => {
    for (let attempt = 0; attempt <= (options.maxContinuations ?? 1); attempt++) {
      const startedAt = Date.now();
      const softDeadline = startedAt + budget.softMs;
      const hardDeadline = startedAt + budget.hardMs;
      const argv = [...request.argv];
      // All supported provider argv builders put the user prompt last.
      argv[argv.length - 1] += [
        "",
        "## Bounded role execution (overrides completion instructions above)",
        `Soft deadline (absolute Unix milliseconds): ${softDeadline}.`,
        `Hard deadline (absolute Unix milliseconds): ${hardDeadline}; the host terminates the owned process group then.`,
        `Write a durable checkpoint to ${checkpointPath} before the soft deadline: completed work, HEAD, dirty files, evidence, blockers, and exact next steps. Preserve this worktree.`,
        "After soft deadline the Pi guard permits only write/edit of that exact checkpoint path and simple read-only git status/diff/rev-parse. No git add/commit, publication, or other work is allowed.",
        "Bash defaults to 90 seconds; explicitly longer budgets are clipped to remaining hard time.",
        'If incomplete, return {"verdict":"interrupted"}; never report completed reflection for incomplete work.',
        ...(attempt
          ? [
              `Continuation ${attempt}: resume the SAME role in the SAME worktree. Read ${checkpointPath} and prior attempt artifacts first; retain all existing work.`,
            ]
          : []),
      ].join("\n");

      const result = await transport({
        ...request,
        argv,
        timeoutMs: Math.max(1, hardDeadline - Date.now()),
        env: {
          ...request.env,
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

      const head = await gitCmd(request.cwd, "rev-parse", "HEAD");
      if (options.onEvidence) {
        await options.onEvidence({
          kind: (request.provider as any) ?? "agent",
          role,
          round: attempt,
          candidate: head,
          artifact,
          exitCode: result.exitCode,
          provider: request.provider,
        });
      }
      if (options.onSave) {
        await options.onSave();
      }

      const timedOut =
        result.timedOut === true || result.exitCode === 124 || finishedAt >= hardDeadline;
      if (!timedOut && !interruptionReport(result.stdout)) return result;

      const reason = timedOut ? "hard deadline exceeded" : "agent checkpoint/interrupted report";
      const dirty = await gitCmd(request.cwd, "status", "--porcelain", "--untracked-files=all");
      const previous = existsSync(checkpointPath)
        ? readFileSync(checkpointPath, "utf8")
        : "# Interrupted reflector checkpoint";
      const currentStage = options.getStage ? options.getStage() : "reflecting";
      const checkpoint =
        previous +
        `\n\n## Host checkpoint: reflector attempt ${attempt}\nReason: ${reason}\nHEAD: ${head}\nStage: ${currentStage}\nArtifact: ${artifact}\nWorktree: ${request.cwd}\nDirty status:\n\`\`\`\n${dirty || "(clean)"}\n\`\`\`\n`;
      await Bun.write(checkpointPath, checkpoint);
      await Bun.write(join(handoffDir, `${role}-attempt-${attempt}-checkpoint.md`), checkpoint);

      if (attempt === (options.maxContinuations ?? 1)) {
        throw new RoleInterrupted(
          `reflector interrupted: ${reason}; continuation budget exhausted; see ${checkpointPath}`,
        );
      }
    }
    throw new RoleInterrupted("reflector continuation budget exhausted");
  };
}

export interface ExecuteTerminalReflectionOptions {
  root: string;
  stateRoot: string;
  runDirectory: string;
  artifactsDir: string;
  handoffDir: string;
  worktree: string;
  candidate?: string;
  defaultBaseBranch: string;
  dossier: IssueDossier;
  transport: AgentTransport;
  budget: { softMs: number; hardMs: number };
  maxContinuations?: number;
  push?: boolean;
  pr?: string;
  acceptedRef?: string;
  commandRecords?: LearningCommandRecord[];
  proposalEvaluator?: LearningEvaluator;
  deliveryTransport?: LearningDeliveryTransport;
  currentStatus?: LocalLoopStatus;
  setStatus?: (status: LocalLoopStatus) => void;
  onEvidence?: (evidence: LoopEvidence) => Promise<void> | void;
  onSave?: () => Promise<void> | void;
  gitFn?: typeof git;
}

/**
 * Execute terminal reflection sandboxing:
 * 1. Verifies shouldTriggerReflection(dossier).
 * 2. Takes detached reflection worktree snapshot at pinnedHead.
 * 3. Fingerprints candidate worktree state before/after to detect unauthorized mutations.
 * 4. Executes post-issue reflection under bounded deadlines and durable checkpoints.
 * 5. Triggers deliverLearningProposal on clean candidate when proposal status is "proposed".
 * 6. Reverts/removes reflection worktree in finally block and updates dossier.
 * 7. Fails closed and holds delivery if candidate or dirty state was mutated.
 */
export async function executeTerminalReflection(
  options: ExecuteTerminalReflectionOptions,
): Promise<void> {
  const {
    root,
    stateRoot,
    runDirectory,
    artifactsDir,
    handoffDir,
    worktree,
    candidate,
    defaultBaseBranch,
    dossier,
    transport,
    budget,
    maxContinuations,
    push,
    pr,
    acceptedRef,
    commandRecords,
    proposalEvaluator,
    deliveryTransport,
    currentStatus,
    setStatus,
    onEvidence,
    onSave,
  } = options;

  if (!shouldTriggerReflection(dossier)) return;

  const terminalStatus = currentStatus ?? "reflecting";
  const reflectionWorktree = join(runDirectory, "reflection-worktree");
  const gitCmd = options.gitFn ?? git;

  const fingerprint = async () => {
    const untracked = (
      await gitCmd(worktree, "ls-files", "--others", "--exclude-standard", "-z")
    )
      .split("\0")
      .filter(Boolean)
      .map((path) => [
        path,
        createHash("sha256")
          .update(readFileSync(join(worktree, path)))
          .digest("hex"),
      ]);
    return JSON.stringify([
      await gitCmd(worktree, "rev-parse", "HEAD"),
      await gitCmd(worktree, "status", "--porcelain=v1", "--untracked-files=all"),
      await gitCmd(worktree, "diff", "HEAD", "--binary"),
      untracked,
    ]);
  };

  let before: string | undefined;
  try {
    before = await fingerprint();
    const pinnedHead = await gitCmd(worktree, "rev-parse", "HEAD");
    await gitCmd(root, "worktree", "add", "--detach", reflectionWorktree, pinnedHead);
    if (setStatus) setStatus("reflecting");
    if (onSave) await onSave();

    const evidenceRoots = Object.fromEntries(
      dossier.attempts
        .filter((attempt) => attempt.artifactsDir)
        .map((attempt) => [attempt.runId, attempt.artifactsDir!]),
    );
    const historicalCommands =
      commandRecords ?? dossier.attempts.flatMap((attempt) => attempt.commandRecords ?? []);

    const reflectionTransport = createBoundedReflectionTransport({
      transport,
      budget,
      handoffDir,
      runDirectory,
      maxContinuations,
      onEvidence,
      onSave,
      getStage: () => "reflecting",
      gitFn: gitCmd,
    });

    const reflection = await runPostIssueReflection({
      root,
      worktree: reflectionWorktree,
      dossier,
      artifactsDir,
      transport: reflectionTransport,
      timeoutMs: budget.hardMs,
      evidenceRoots,
      commandRecords: historicalCommands,
      acceptedRef,
      proposalEvaluator,
    });
    await Bun.write(join(artifactsDir, "reflection.json"), JSON.stringify(reflection, null, 2));

    let delivered = false;
    if (reflection.status === "proposed" && reflection.proposalPath && candidate) {
      const delivery = await deliverLearningProposal({
        root,
        proposalPath: reflection.proposalPath,
        verifiedCandidate: candidate,
        baseBranch: defaultBaseBranch,
        dossier,
        evidenceRoots,
        commandRecords: historicalCommands,
        proposalEvaluator,
        sourceDeliveryPr: pr,
        transport: deliveryTransport,
        publish: push !== false,
      });
      await Bun.write(
        join(artifactsDir, "learning-delivery.json"),
        JSON.stringify(delivery, null, 2),
      );
      delivered =
        delivery.status === "proposed" && (push === false || Boolean(delivery.prUrl));
    }

    if (before !== (await fingerprint())) {
      throw new Error("Reflection changed the verified candidate or dirty state; delivery held");
    }

    if (delivered || reflection.status === "no_entry") {
      dossier.reflectedAt = new Date().toISOString();
      saveIssueDossier(stateRoot, dossier);
    }
  } catch (error) {
    await Bun.write(
      join(artifactsDir, "reflection.json"),
      JSON.stringify(
        {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
  } finally {
    if (setStatus) setStatus(terminalStatus);
    // Git refuses removal of dirty/interrupted reflection worktrees; preserve their evidence.
    await gitCmd(root, "worktree", "remove", reflectionWorktree).catch(() => {});
  }

  if (before !== undefined && before !== (await fingerprint())) {
    throw new Error("Reflection changed the verified candidate or dirty state; delivery held");
  }
}
