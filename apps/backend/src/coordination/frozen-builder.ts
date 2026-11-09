import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runBoundedRole, RoleInterrupted } from "../../../../scripts/loop/role-runner";
import { processRun } from "../../../../scripts/loop/process";
import {
  resolveEffortForRole,
  resolveModelForRole,
  resolveProviderForRole,
} from "../../../../scripts/loop/config";
import { resolveRoleBudgets } from "../../../../scripts/loop/deadlines";
import { git } from "../../../../scripts/loop/worktree";
import type { AgentTransport, RoleBudget } from "../../../../scripts/loop/types";

export type { AgentTransport, RoleBudget } from "../../../../scripts/loop/types";

export interface FrozenBuilderOptions {
  /** Repository root used for loop/config inspection; the worktree is the execution cwd. */
  projectRoot: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  issueNumber: number;
  specIssueNumber: number;
  contractBody: string;
  findings?: Array<{ summary: string; fileContext: string; acKey?: string }>;
  runId: string;
  runDirectory: string;
  /** External model/process transport. Production defaults to the owned process runner. */
  transport?: AgentTransport;
  provider?: string;
  model?: string;
  effort?: string;
  budget?: RoleBudget;
  maxContinuations?: number;
  onWorkerSpawn?: (pid: number) => void;
}

export interface FrozenBuilderResult {
  success: boolean;
  headSha?: string;
  error?: string;
  exitCode?: number;
}

const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function builderPrompt(options: FrozenBuilderOptions): string {
  return [
    "# Frozen ticket implementation",
    "",
    "You are the bounded builder for a locally admitted ticket. The dispatcher has",
    "already frozen this contract; do not fetch, edit or reinterpret GitHub issue",
    "content. Implement the contract below in the current worktree.",
    "",
    `- Ticket: #${options.issueNumber}`,
    `- Parent spec: #${options.specIssueNumber}`,
    `- Branch: ${options.branch}`,
    `- Base commit: ${options.baseSha}`,
    "",
    "## Frozen contract",
    "",
    options.contractBody.trim(),
    "",
    ...(options.findings && options.findings.length > 0
      ? [
          "## Blocking findings from the previous lap",
          "",
          "Correct every finding below with a fresh commit; do not re-litigate the contract.",
          "",
          ...options.findings.map(
            (finding) =>
              `- ${finding.acKey ? `[${finding.acKey}] ` : ""}${finding.fileContext}: ${finding.summary}`,
          ),
          "",
        ]
      : []),
    "## Execution rules",
    "",
    "- Work only inside this worktree and on the branch above.",
    "- Implement every acceptance criterion in the frozen contract.",
    "- Commit your changes with a conventional commit message before finishing.",
    "- Do not push, open pull requests, merge, or modify the frozen contract.",
    "- If the contract cannot be completed, leave the worktree intact and report",
    '  {"verdict":"interrupted"} with the concrete blocker.',
    "",
    "When finished, report the committed HEAD commit id in your final JSON report.",
  ].join("\n");
}

/**
 * Execute the real bounded builder role against a frozen contract.
 *
 * This deliberately does not use `runAnimusLoop`: that orchestrator re-reads
 * the live forge contract. Dispatch execution must remain bound to the frozen
 * admission-time revision. The only injectable seam is the external model /
 * process transport, which lets offline tests drive a real commit.
 */
export async function runFrozenBuilder(
  options: FrozenBuilderOptions,
): Promise<FrozenBuilderResult> {
  const handoffDir = join(options.runDirectory, "handoff");
  const sessionDir = join(options.runDirectory, "builder-session");
  const checkpointPath = join(handoffDir, "checkpoint.md");
  await mkdir(handoffDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const provider = options.provider ?? resolveProviderForRole(options.projectRoot, "builder");
  const model = options.model ?? resolveModelForRole(options.projectRoot, "builder") ?? "small";
  const effort = options.effort ?? resolveEffortForRole(options.projectRoot, "builder");

  const roleBudgets = resolveRoleBudgets({
    maxContinuations: options.maxContinuations ?? 1,
    ...(options.budget ? { roleBudgets: { builder: options.budget } } : {}),
  });
  const budget = roleBudgets.builder;

  const transport: AgentTransport =
    options.transport ??
    ((request) =>
      processRun(request.argv, request.cwd, request.timeoutMs, request.env, {
        manageSignals: false,
        onSpawn: options.onWorkerSpawn,
      }));

  try {
    const result = await runBoundedRole({
      role: "builder",
      root: options.projectRoot,
      cwd: options.worktreePath,
      prompt: builderPrompt(options),
      sessionDir,
      checkpointPath,
      handoffDir,
      runDirectory: options.runDirectory,
      budget,
      maxContinuations: options.maxContinuations ?? 1,
      provider,
      model,
      effort,
      skills: ["animus-implement"],
      transport,
      rawOutput: true,
    });

    const currentBranch = await git(options.worktreePath, "rev-parse", "--abbrev-ref", "HEAD");
    if (currentBranch.trim() !== options.branch) {
      return {
        success: false,
        error: `builder left worktree on ${currentBranch.trim()} instead of ${options.branch}`,
        exitCode: result.result.exitCode,
      };
    }

    const head = (await git(options.worktreePath, "rev-parse", "HEAD")).trim();
    if (!COMMIT_SHA.test(head)) {
      return {
        success: false,
        error: `builder produced an invalid candidate head: ${head || "(empty)"}`,
        exitCode: result.result.exitCode,
      };
    }
    try {
      await git(options.worktreePath, "cat-file", "-e", `${head}^{commit}`);
    } catch {
      return {
        success: false,
        error: `builder candidate ${head} is not a committed object`,
        exitCode: result.result.exitCode,
      };
    }
    if (head === options.baseSha) {
      return {
        success: false,
        error: "builder finished without committing a candidate",
        exitCode: result.result.exitCode,
      };
    }

    return {
      success: true,
      headSha: head,
      exitCode: result.result.exitCode,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof RoleInterrupted
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
      exitCode: error instanceof RoleInterrupted ? 124 : 1,
    };
  }
}
