import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { processRun } from "./process";
import { evaluateCodebaseRulesOnEdit } from "../../.factory/hooks/loop-guard";
import { CoordinationError } from "../../apps/backend/src/coordination/errors";

export const DEFAULT_PROTECTED_PATHS = [
  ".factory/holdout/**",
  ".factory/hooks/**",
  ".claude/settings.json",
  "harness/**",
];

export interface PrepareLoopWorktreeOptions {
  root: string;
  worktreePath: string;
  branch: string;
  base: string;
  route?: "simple" | "continue";
  hasOrigin?: boolean;
  baseBranch?: string;
  isReused?: boolean;
  existingWorktree?: string | null;
}

export interface AssertCandidateOptions {
  root: string;
  worktree: string;
  base: string;
  expectedCandidate?: string;
  protectedPaths?: string[];
}

/**
 * Execute a git command within a repository directory, returning trimmed stdout on success
 * or throwing with command details and stderr on non-zero exit.
 */
export async function git(root: string, ...args: string[]): Promise<string> {
  const result = await processRun(["git", ...args], root, 30_000);
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Inspect local loop git environment: resolves common and primary roots,
 * and asserts that no STOP or PAUSE filesystem brakes are active.
 */
export async function inspectLocalLoop(root: string): Promise<{ common: string; primary: string }> {
  const common = resolve(root, await git(root, "rev-parse", "--git-common-dir"));
  const primary = (await git(root, "worktree", "list", "--porcelain"))
    .split("\n")[0]!
    .replace(/^worktree /, "");
  for (const directory of new Set([root, primary, common])) {
    for (const brake of ["STOP", "PAUSE"]) {
      if (existsSync(join(directory, ".factory", brake)))
        throw new Error(`${brake} brake is active`);
    }
  }
  return { common, primary };
}

/**
 * Query existing git worktrees to find a worktree checkout holding the target branch ref.
 * Returns the worktree path if found, or null otherwise.
 */
export async function findExistingWorktreeForBranch(
  root: string,
  branch: string,
): Promise<string | null> {
  try {
    const stdout = await git(root, "worktree", "list", "--porcelain");
    const blocks = stdout.split("\n\n");
    for (const block of blocks) {
      let worktreePath = "";
      let isTargetBranch = false;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice("worktree ".length).trim();
        } else if (line === `branch refs/heads/${branch}`) {
          isTargetBranch = true;
        }
      }
      if (isTargetBranch && worktreePath && existsSync(worktreePath)) {
        return worktreePath;
      }
    }
  } catch {}
  return null;
}

/**
 * Check if an operating system process with the given PID is currently alive.
 * Invariant: 'age never proves dead, EPERM alive, only ESRCH proves dead'.
 * Returns false only if process.kill(pid, 0) throws with err.code === 'ESRCH'.
 */
export function isPidAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") {
      return false; // dead
    }
    // EPERM or other error indicates process exists in OS process table
    return true;
  }
}

/**
 * Acquire an issue directory lock with stale PID reclamation.
 * Writes owner.json with PID and metadata payload, and returns a release callback.
 */
export async function acquireIssueLock(
  stateRoot: string,
  issueNumber: number,
  ownerPayload: object = {},
): Promise<() => Promise<void>> {
  const lock = join(stateRoot, "locks", `issue-${issueNumber}`);
  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch {
    const ownerFile = join(lock, "owner.json");
    let stale = false;
    if (existsSync(ownerFile)) {
      try {
        const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
        if (typeof owner.pid === "number") {
          if (!isPidAlive(owner.pid)) {
            stale = true;
          }
        }
      } catch {}
    }
    if (stale) {
      await rm(lock, { recursive: true, force: true });
      await mkdir(lock);
    } else {
      throw new Error(`Issue ${issueNumber} is locked; inspect ${lock} before manual release`);
    }
  }

  const ownerFile = join(lock, "owner.json");
  const payload = {
    pid: process.pid,
    ...ownerPayload,
  };
  await Bun.write(ownerFile, JSON.stringify(payload, null, 2));

  return async () => {
    try {
      await rm(lock, { recursive: true, force: true });
    } catch {}
  };
}

export const acquireWorktreeIssueLock = acquireIssueLock;

/**
 * Prepare an isolated loop worker git worktree:
 * - When reused: fetches remotes (if origin exists), checks out and resets hard to target branch, cleans untracked files.
 * - When newly allocated: adds worktree with --no-checkout, applies sparse-checkout (!/.factory/holdout/), checks out target branch.
 * - In both cases: binds core.hooksPath if .githooks exists in repo root.
 */
export async function prepareLoopWorktree(
  options: PrepareLoopWorktreeOptions,
): Promise<{ worktreePath: string; isReused: boolean }> {
  const { root, worktreePath, branch, base } = options;
  const route = options.route ?? "simple";
  const baseBranch = options.baseBranch ?? "main";

  let hasOrigin = options.hasOrigin;
  if (hasOrigin === undefined) {
    try {
      const remotes = await git(root, "remote");
      hasOrigin = remotes
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean)
        .includes("origin");
    } catch {
      hasOrigin = false;
    }
  }

  let isReused = options.isReused;
  if (isReused === undefined) {
    if (options.existingWorktree !== undefined) {
      isReused = !!options.existingWorktree;
    } else {
      const existing = await findExistingWorktreeForBranch(root, branch);
      isReused = !!existing && resolve(existing) === resolve(worktreePath);
    }
  }

  if (isReused) {
    if (hasOrigin) {
      await git(worktreePath, "fetch", "origin", branch).catch(() => {});
      await git(worktreePath, "fetch", "origin", baseBranch).catch(() => {});
      await git(
        worktreePath,
        "checkout",
        "-B",
        branch,
        `origin/${branch}`,
        "--ignore-other-worktrees",
      );
      await git(worktreePath, "reset", "--hard", `origin/${branch}`);
    } else {
      await git(
        worktreePath,
        "checkout",
        "-B",
        branch,
        branch,
        "--ignore-other-worktrees",
      ).catch(() => {});
    }
    await git(
      worktreePath,
      "sparse-checkout",
      "set",
      "--no-cone",
      "/*",
      "!/.factory/holdout/",
    ).catch(() => {});
    await git(worktreePath, "clean", "-fd");
  } else {
    await mkdir(dirname(worktreePath), { recursive: true });
    if (route === "continue") {
      if (hasOrigin) {
        await git(root, "fetch", "origin", branch);
        await git(root, "fetch", "origin", baseBranch).catch(() => {});
      }
      await git(root, "worktree", "add", "--no-checkout", worktreePath, `origin/${branch}`);
      await git(
        worktreePath,
        "sparse-checkout",
        "set",
        "--no-cone",
        "/*",
        "!/.factory/holdout/",
      );
      await git(
        worktreePath,
        "checkout",
        "-B",
        branch,
        `origin/${branch}`,
        "--ignore-other-worktrees",
      );
    } else {
      await git(root, "worktree", "add", "--no-checkout", "-b", branch, worktreePath, base);
      await git(
        worktreePath,
        "sparse-checkout",
        "set",
        "--no-cone",
        "/*",
        "!/.factory/holdout/",
      );
      await git(worktreePath, "checkout", "--ignore-other-worktrees", branch);
    }
  }

  if (existsSync(join(root, ".githooks"))) {
    await git(worktreePath, "config", "core.hooksPath", join(root, ".githooks")).catch(() => {});
  }

  return { worktreePath, isReused };
}

/**
 * Asserts candidate integrity:
 * 1. Checks that repository and worktree have no active brakes.
 * 2. Confirms worktree is clean (no uncommitted or untracked files).
 * 3. Confirms worktree HEAD matches expected candidate (if provided).
 * 4. Confirms worktree HEAD descends from base.
 * 5. Asserts changed files against base do not touch protected paths.
 * 6. Evaluates codebase convention rules on changed files.
 */
export async function assertCandidate(options: AssertCandidateOptions): Promise<string> {
  const { root, worktree, base, expectedCandidate } = options;
  const protectedPatterns = options.protectedPaths ?? DEFAULT_PROTECTED_PATHS;

  await inspectLocalLoop(root);
  await inspectLocalLoop(worktree);
  if (await git(worktree, "status", "--porcelain", "--untracked-files=all"))
    throw new Error("Candidate has uncommitted or untracked changes");
  const head = await git(worktree, "rev-parse", "HEAD");
  if (expectedCandidate && expectedCandidate !== head)
    throw new Error("Candidate changed during verification");
  await git(worktree, "merge-base", "--is-ancestor", base, head);
  const changed = (await git(worktree, "diff", "--name-only", "--no-renames", base, head))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (changed.some((p) => protectedPatterns.some((pattern) => new Bun.Glob(pattern).match(p))))
    throw new Error("Candidate changed protected paths");

  // Deterministic codebase rules enforcement across all harnesses (Pi, Claude, Codex, OpenCode)
  for (const relPath of changed) {
    const fullPath = join(worktree, relPath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const ruleCheck = evaluateCodebaseRulesOnEdit(worktree, relPath, content);
        if (ruleCheck.blocked) {
          throw new Error(`Candidate violated codebase rules: ${ruleCheck.reasons.join("; ")}`);
        }
      } catch (err: any) {
        if (err.message?.includes("Candidate violated codebase rules")) throw err;
      }
    }
  }

  return head;
}

export interface WorktreeLockInfo {
  runId: string;
  branch: string;
  startSha: string;
  issueNumber: number;
  lockedAt: string;
  pid: number;
}

export interface WorktreeAllocationOptions {
  repoRoot: string;
  worktreeDir: string;
  branch: string;
  startSha: string;
  issueNumber: number;
  runId?: string;
  gitRunner?: (cmd: string[], options: { cwd: string }) => string;
}

export interface WorktreeAllocation {
  worktreeDir: string;
  branch: string;
  startSha: string;
  issueNumber: number;
  runId: string;
  releaseLock: () => void;
  removeWorktree: () => void;
}

function defaultGitRunner(cmd: string[], options: { cwd: string }): string {
  try {
    return execFileSync("git", cmd, {
      cwd: options.cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error: any) {
    const stderr = error.stderr ? String(error.stderr).trim() : error.message;
    throw new CoordinationError(
      "git_command_failed",
      `Git command failed [git ${cmd.join(" ")}]: ${stderr}`,
      { cmd, stderr },
    );
  }
}

/**
 * Allocate an isolated git worktree with:
 * 1. Sparse-checkout Holdout fencing (!/.factory/holdout/).
 * 2. .githooks binding (core.hooksPath).
 * 3. Exclusive PID-verified lock file (.worktree.lock) with ESRCH-only stale reclamation.
 * 4. Verification of starting SHA and branch cleanliness.
 */
export function allocateWorktree(options: WorktreeAllocationOptions): WorktreeAllocation {
  const { repoRoot, worktreeDir, branch, startSha, issueNumber } = options;
  const runner = options.gitRunner ?? defaultGitRunner;
  const runId = options.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const lockPath = join(worktreeDir, ".worktree.lock");

  // Check existing lock if worktree dir exists
  if (existsSync(worktreeDir) && existsSync(lockPath)) {
    try {
      const lockContent = readFileSync(lockPath, "utf-8");
      const lock = JSON.parse(lockContent) as WorktreeLockInfo;
      if (typeof lock.pid === "number") {
        if (isPidAlive(lock.pid)) {
          throw new CoordinationError(
            "worktree_lock_conflict",
            `Worktree ${worktreeDir} is exclusively locked by run ${lock.runId} (pid ${lock.pid})`,
            { existingLock: lock },
          );
        }
        // Stale lock: owning PID is dead (ESRCH), reclaim it
        try {
          unlinkSync(lockPath);
        } catch {}
      } else {
        throw new CoordinationError(
          "worktree_lock_conflict",
          `Worktree ${worktreeDir} contains an invalid lock file`,
        );
      }
    } catch (err: any) {
      if (err instanceof CoordinationError) throw err;
      throw new CoordinationError(
        "worktree_lock_conflict",
        `Worktree ${worktreeDir} contains an existing lock file`,
      );
    }
  }

  // Allocate worktree if it does not exist as a git worktree
  const isGitWorktree = existsSync(worktreeDir) && existsSync(join(worktreeDir, ".git"));
  if (!isGitWorktree) {
    if (existsSync(worktreeDir)) {
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {}
    }
    mkdirSync(join(worktreeDir, ".."), { recursive: true });
    try {
      runner(["worktree", "add", "--no-checkout", "-b", branch, worktreeDir, startSha], {
        cwd: repoRoot,
      });
    } catch (err: any) {
      // If branch already exists (e.g. from prior checkout or restart), try checking it out
      try {
        runner(["worktree", "add", "--no-checkout", worktreeDir, branch], { cwd: repoRoot });
      } catch {
        throw err;
      }
    }
    // Enforce sparse-checkout Holdout fencing (!/.factory/holdout/)
    runner(["sparse-checkout", "set", "--no-cone", "/*", "!/.factory/holdout/"], {
      cwd: worktreeDir,
    });
    // Checkout target branch into fenced worktree
    runner(["checkout", "--ignore-other-worktrees", branch], { cwd: worktreeDir });
  } else {
    // Existing worktree: ensure sparse-checkout holdout fencing is applied
    try {
      runner(["sparse-checkout", "set", "--no-cone", "/*", "!/.factory/holdout/"], {
        cwd: worktreeDir,
      });
    } catch {}
  }

  // Enforce .githooks binding if .githooks exists in repoRoot
  if (existsSync(join(repoRoot, ".githooks"))) {
    try {
      runner(["config", "core.hooksPath", join(repoRoot, ".githooks")], { cwd: worktreeDir });
    } catch {}
  }

  // Write exclusive lock file immediately before validation
  const lockInfo: WorktreeLockInfo = {
    runId,
    branch,
    startSha,
    issueNumber,
    lockedAt: new Date().toISOString(),
    pid: process.pid,
  };
  writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2));

  // Validate starting SHA before execution starts
  let currentHead = "";
  try {
    currentHead = runner(["rev-parse", "HEAD"], { cwd: worktreeDir });
  } catch (err: any) {
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
    throw new CoordinationError(
      "starting_sha_unresolvable",
      `Failed to resolve HEAD in worktree ${worktreeDir}: ${err.message}`,
    );
  }

  let resolvedExpectedSha = startSha;
  try {
    resolvedExpectedSha = runner(["rev-parse", startSha], { cwd: repoRoot });
  } catch {
    resolvedExpectedSha = startSha;
  }

  if (currentHead !== resolvedExpectedSha) {
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
    throw new CoordinationError(
      "starting_sha_mismatch",
      `Starting SHA mismatch: expected ${resolvedExpectedSha} (${startSha}), but worktree HEAD is ${currentHead}`,
      { expectedSha: resolvedExpectedSha, actualSha: currentHead },
    );
  }

  // Validate branch cleanliness
  let statusOutput = "";
  try {
    statusOutput = runner(["status", "--porcelain"], { cwd: worktreeDir });
  } catch (err: any) {
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
    throw new CoordinationError(
      "branch_cleanliness_check_failed",
      `Failed to check branch cleanliness in worktree ${worktreeDir}: ${err.message}`,
    );
  }

  const dirtyLines = statusOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith(".worktree.lock"));

  if (dirtyLines.length > 0) {
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
    throw new CoordinationError(
      "worktree_dirty",
      `Worktree ${worktreeDir} is not clean: uncommitted changes or untracked files detected`,
      { dirtyFiles: dirtyLines },
    );
  }

  return {
    worktreeDir,
    branch,
    startSha: currentHead,
    issueNumber,
    runId,
    releaseLock: () => {
      if (existsSync(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    },
    removeWorktree: () => {
      if (existsSync(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {}
      }
      try {
        runner(["worktree", "remove", "--force", worktreeDir], { cwd: repoRoot });
      } catch {}
    },
  };
}
