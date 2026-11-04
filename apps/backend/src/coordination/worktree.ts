import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  allocateWorktree,
  type WorktreeAllocation,
  type WorktreeAllocationOptions,
  type WorktreeLockInfo,
} from "../../../../scripts/loop/worktree";

export type { WorktreeAllocation, WorktreeAllocationOptions, WorktreeLockInfo };

export class WorktreeManager {
  private runner?: (cmd: string[], options: { cwd: string }) => string;

  constructor(runner?: (cmd: string[], options: { cwd: string }) => string) {
    this.runner = runner;
  }

  allocateWorktree(options: WorktreeAllocationOptions): WorktreeAllocation {
    return allocateWorktree({
      ...options,
      gitRunner: options.gitRunner ?? this.runner,
    });
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
