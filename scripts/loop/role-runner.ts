import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git, inspectLocalLoop } from "./worktree";
import { buildProviderArgv, supportsSessionResume } from "./providers";
import { interruptionReport, RoleInterrupted } from "./deadlines";
import { extractReport } from "./artifacts";
import type {
  LoopRole,
  RoleBudget,
  AgentTransport,
  LoopEvidence,
} from "./types";
import type { LapAttemptRecord } from "./dossier";

export { RoleInterrupted } from "./deadlines";

export interface BoundedRoleOptions {
  role: LoopRole;
  root: string;
  cwd: string;
  prompt: string;
  sessionDir?: string;
  checkpointPath: string;
  handoffDir: string;
  runDirectory: string;
  budget: RoleBudget;
  maxContinuations?: number;
  provider: string;
  model?: string;
  effort?: string;
  skills?: string[];
  extensions?: string[];
  appendSystemPrompts?: string[];
  transport: AgentTransport;
  candidate?: string;
  optionsOverride?: { requiredAcIds?: string[] };
  onEvidence?: (evidence: LoopEvidence) => Promise<void> | void;
  onSave?: () => Promise<void>;
  recoveries?: NonNullable<LapAttemptRecord["recoveries"]>;
  getStage?: () => string;
  gitCmd?: typeof git;
  rawOutput?: boolean;
  /** Explicit provider session id to resume. Absent means start a fresh session. */
  resumeSessionId?: string;
}

export interface BoundedRoleResult {
  report?: any;
  result: any;
  rawStdout: string;
  artifact: string;
  head: string;
  /** Provider-issued session id observed in this attempt's stdout, when reported. */
  sessionId?: string;
}

function extractSessionId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const frame = event.type === "event" && event.event ? event.event : event;
      const candidates = [event, frame];
      for (const node of candidates) {
        if (node.type === "session" && typeof node.id === "string" && node.id) return node.id;
        if (node.type === "result" && typeof node.sessionId === "string" && node.sessionId) {
          return node.sessionId;
        }
        if (node.type === "result" && typeof node.session_id === "string" && node.session_id) {
          return node.session_id;
        }
      }
    } catch {}
  }
  return undefined;
}

/**
 * Unified bounded role execution runner used identically across builder, QA,
 * reviewer, and reflector.
 *
 * Enforces:
 * - Absolute soft and hard deadline prompt formatting without mutating input argv
 * - FACTORY_LOOP_SOFT_DEADLINE_MS, FACTORY_LOOP_HARD_DEADLINE_MS, and FACTORY_LOOP_CHECKPOINT_PATH env injection
 * - Continuation attempts up to maxContinuations (with "Continuation N: ..." instructions)
 * - Durable checkpoint writing to checkpoint.md and ${role}-attempt-${attempt}-checkpoint.md
 * - Honest RoleInterrupted detection and throwing upon budget exhaustion
 * - Process exit code validation
 * - JSONL message_end report extraction via extractReport
 */
export async function runBoundedRole(opts: BoundedRoleOptions): Promise<BoundedRoleResult> {
  const {
    role,
    root,
    cwd,
    prompt,
    sessionDir,
    checkpointPath,
    handoffDir,
    runDirectory,
    budget,
    maxContinuations = 1,
    provider,
    model,
    effort,
    skills,
    extensions,
    appendSystemPrompts,
    transport,
    candidate,
    optionsOverride,
    onEvidence,
    onSave,
    recoveries,
    getStage,
    gitCmd = git,
    rawOutput = false,
  } = opts;

  let resumeSessionId = opts.resumeSessionId;
  let sessionDirInUse: string | undefined;

  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
    await inspectLocalLoop(root);
    const startedAt = Date.now();
    const softDeadline = startedAt + budget.softMs;
    const hardDeadline = startedAt + budget.hardMs;

    // Continuations stay in one session directory: a resumed id must resolve against
    // the transcript the previous attempt wrote, or it silently starts a new session.
    // This applies to every role, because "continuation" means resuming that role's
    // own prior attempt rather than re-deriving it from scratch.
    const attemptSessionDir = sessionDirInUse ?? sessionDir ?? join(runDirectory, `${role}-session`);
    sessionDirInUse = attemptSessionDir;
    await mkdir(attemptSessionDir, { recursive: true });

    const canResume = Boolean(resumeSessionId) && supportsSessionResume(provider);
    const continuationBase =
      role === "reflector"
        ? `Read ${checkpointPath} and prior attempt artifacts first; retain all existing work.`
        : `Read ${checkpointPath} and prior attempt artifacts first, run the baseline check yourself before editing, skip any failed approaches recorded in the checkpoint, and retain all verified work.`;
    const continuationText =
      attempt > 0
        ? `Continuation ${attempt}: resume the SAME role in the SAME worktree. ${
            canResume
              ? "Your previous conversation in this role is resumed above; treat its claims as unverified hints and confirm live state."
              : "No prior conversation was resumed; re-derive state from the checkpoint and the worktree."
          } ${continuationBase}`
        : "";

    const deadlineSection = [
      "",
      "## Bounded role execution (overrides completion instructions above)",
      `Soft deadline (absolute Unix milliseconds): ${softDeadline} (${new Date(softDeadline).toISOString()}).`,
      `Hard deadline (absolute Unix milliseconds): ${hardDeadline}; the host terminates the owned process group then.`,
      `Write a durable checkpoint to ${checkpointPath} before the soft deadline: completed work, HEAD, dirty files, evidence, ${role === "reflector" ? "" : "failed approaches/disproved assumptions (with probe evidence so they are never repeated), "}blockers, and exact next steps. Preserve this worktree.`,
      "After soft deadline the Pi guard permits only write/edit of that exact checkpoint path and simple read-only git status/diff/rev-parse. No git add/commit, publication, or other work is allowed.",
      "Bash defaults to 90 seconds; explicitly longer budgets are clipped to remaining hard time. Do not start work that cannot finish before the deadline.",
      `If incomplete, return {"verdict":"interrupted"}; never report ${role === "reflector" ? "completed reflection" : "pass"} for incomplete work.`,
      continuationText,
    ]
      .filter(Boolean)
      .join("\n");

    const deadlinePrompt = `${prompt}\n\n${deadlineSection}`;

    // Fresh argv array constructed without in-place mutation of any caller argv
    const argv = buildProviderArgv(provider, {
      model,
      effort: effort as any,
      prompt: deadlinePrompt,
      sessionDir: attemptSessionDir,
      skills,
      extensions,
      appendSystemPrompts,
      sessionId: canResume ? resumeSessionId : undefined,
    });

    const timeoutMs = Math.max(1, hardDeadline - Date.now());
    const result = await transport({
      argv,
      cwd,
      role,
      provider,
      timeoutMs,
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

    const head = (await gitCmd(cwd, "rev-parse", "HEAD")).trim();
    if (onEvidence) {
      await onEvidence({
        kind: provider === "pi" ? "pi" : (provider as any),
        role,
        round: attempt,
        candidate: head,
        artifact,
        exitCode: result.exitCode,
        provider,
        effort: effort as any,
      });
    }
    if (onSave) {
      await onSave();
    }

    // Carry the observed session id into the next attempt so a continuation resumes
    // the transcript this attempt just wrote instead of starting over.
    const observedSessionId = extractSessionId(result.stdout);
    if (observedSessionId && supportsSessionResume(provider)) {
      resumeSessionId = observedSessionId;
    }

    const timedOut =
      result.timedOut === true || result.exitCode === 124 || finishedAt >= hardDeadline;
    if (timedOut || interruptionReport(result.stdout)) {
      const reason = timedOut
        ? "hard deadline exceeded"
        : "agent checkpoint/interrupted report";
      const dirty = await gitCmd(cwd, "status", "--porcelain", "--untracked-files=all");
      const currentStage = getStage ? getStage() : role;
      const facts = `\n\n## Host checkpoint: ${role} attempt ${attempt}\nReason: ${reason}\nHEAD: ${head}\nStage: ${currentStage}\nArtifact: ${artifact}\nWorktree: ${cwd}\nDirty status:\n\`\`\`\n${dirty || "(clean)"}\n\`\`\`\n`;
      const previous = existsSync(checkpointPath)
        ? readFileSync(checkpointPath, "utf8")
        : `# Interrupted ${role} checkpoint`;
      await Bun.write(checkpointPath, previous + facts);
      await Bun.write(
        join(handoffDir, `${role}-attempt-${attempt}-checkpoint.md`),
        previous + facts,
      );
      if (attempt < maxContinuations) {
        if (recoveries) recoveries.push({ role, artifact, reason });
        continue;
      }
      throw new RoleInterrupted(
        `${role} interrupted: ${reason}; continuation budget exhausted; see ${checkpointPath}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(`${provider} ${role} process failed; see ${artifact}`);
    }

    let report: any;
    if (!rawOutput) {
      const artifactsDir = join(runDirectory, "artifacts");
      report = extractReport(result.stdout, candidate ?? head, role, artifactsDir, optionsOverride);
    }

    return {
      report,
      result,
      rawStdout: result.stdout,
      artifact,
      head,
      sessionId: extractSessionId(result.stdout),
    };
  }

  throw new RoleInterrupted(`${role} continuation budget exhausted`);
}
