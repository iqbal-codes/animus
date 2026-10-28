import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoordinationError } from "./errors";

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

export class WorktreeManager {
  private runner: (cmd: string[], options: { cwd: string }) => string;

  constructor(runner?: (cmd: string[], options: { cwd: string }) => string) {
    this.runner = runner ?? defaultGitRunner;
  }

  allocateWorktree(options: WorktreeAllocationOptions): WorktreeAllocation {
    const { repoRoot, worktreeDir, branch, startSha, issueNumber } = options;
    const runId = options.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const lockPath = join(worktreeDir, ".worktree.lock");

    // Check existing lock if worktree dir exists
    if (existsSync(worktreeDir) && existsSync(lockPath)) {
      try {
        const lockContent = readFileSync(lockPath, "utf-8");
        const lock = JSON.parse(lockContent) as WorktreeLockInfo;
        throw new CoordinationError(
          "worktree_lock_conflict",
          `Worktree ${worktreeDir} is exclusively locked by run ${lock.runId} (pid ${lock.pid})`,
          { existingLock: lock },
        );
      } catch (err: any) {
        if (err instanceof CoordinationError) throw err;
        throw new CoordinationError(
          "worktree_lock_conflict",
          `Worktree ${worktreeDir} contains an existing lock file`,
        );
      }
    }

    // Allocate worktree if it does not exist
    if (!existsSync(worktreeDir)) {
      mkdirSync(join(worktreeDir, ".."), { recursive: true });
      try {
        this.runner(["worktree", "add", "-b", branch, worktreeDir, startSha], {
          cwd: repoRoot,
        });
      } catch (err: any) {
        // If branch already exists (e.g. from prior checkout or restart), try checking it out
        try {
          this.runner(["worktree", "add", worktreeDir, branch], { cwd: repoRoot });
        } catch {
          throw err;
        }
      }
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

    // AC2: Validate starting SHA before execution starts
    let currentHead = "";
    try {
      currentHead = this.runner(["rev-parse", "HEAD"], { cwd: worktreeDir });
    } catch (err: any) {
      this.releaseLock(worktreeDir);
      throw new CoordinationError(
        "starting_sha_unresolvable",
        `Failed to resolve HEAD in worktree ${worktreeDir}: ${err.message}`,
      );
    }

    // Compare resolved currentHead with expected startSha (using rev-parse on startSha to resolve symbolic refs like main)
    let resolvedExpectedSha = startSha;
    try {
      resolvedExpectedSha = this.runner(["rev-parse", startSha], { cwd: repoRoot });
    } catch {
      resolvedExpectedSha = startSha;
    }

    if (currentHead !== resolvedExpectedSha) {
      this.releaseLock(worktreeDir);
      throw new CoordinationError(
        "starting_sha_mismatch",
        `Starting SHA mismatch: expected ${resolvedExpectedSha} (${startSha}), but worktree HEAD is ${currentHead}`,
        { expectedSha: resolvedExpectedSha, actualSha: currentHead },
      );
    }

    // AC2: Validate branch cleanliness before execution starts
    let statusOutput = "";
    try {
      statusOutput = this.runner(["status", "--porcelain"], { cwd: worktreeDir });
    } catch (err: any) {
      this.releaseLock(worktreeDir);
      throw new CoordinationError(
        "branch_cleanliness_check_failed",
        `Failed to check branch cleanliness in worktree ${worktreeDir}: ${err.message}`,
      );
    }

    // Ignore the lockfile itself if it appears in porcelain status
    const dirtyLines = statusOutput
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.endsWith(".worktree.lock"));

    if (dirtyLines.length > 0) {
      this.releaseLock(worktreeDir);
      throw new CoordinationError(
        "worktree_dirty",
        `Worktree ${worktreeDir} is not clean: uncommitted changes or untracked files detected`,
        { dirtyFiles: dirtyLines },
      );
    }

    const allocation: WorktreeAllocation = {
      worktreeDir,
      branch,
      startSha: currentHead,
      issueNumber,
      runId,
      releaseLock: () => this.releaseLock(worktreeDir),
      removeWorktree: () => {
        this.releaseLock(worktreeDir);
        try {
          this.runner(["worktree", "remove", "--force", worktreeDir], { cwd: repoRoot });
        } catch {}
      },
    };

    return allocation;
  }

  releaseLock(worktreeDir: string): void {
    const lockPath = join(worktreeDir, ".worktree.lock");
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}
