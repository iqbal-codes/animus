import { execFileSync } from "node:child_process";
import { CoordinationError } from "./errors";

export interface IntegrationParams {
  repoRoot: string;
  integrationBranch: string;
  expectedIntegrationSha: string;
  childBranch: string;
  childIssueNumber: number;
  childHeadSha?: string;
  gitRunner?: (cmd: string[], options: { cwd: string }) => string;
}

export interface IntegrationResult {
  success: boolean;
  previousSha: string;
  newSha: string;
  childIssueNumber: number;
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
    const stdout = error.stdout ? String(error.stdout).trim() : "";
    throw new CoordinationError(
      "git_command_failed",
      `Git command failed [git ${cmd.join(" ")}]: ${stderr || stdout}`,
      { cmd, stderr, stdout },
    );
  }
}

export class SerializedIntegrationManager {
  private runner: (cmd: string[], options: { cwd: string }) => string;
  // Mutex per repo root to serialize git integration operations and prevent index.lock collisions
  private repoLocks = new Map<string, Promise<void>>();

  constructor(runner?: (cmd: string[], options: { cwd: string }) => string) {
    this.runner = runner ?? defaultGitRunner;
  }

  async integrateChildSerialized(params: IntegrationParams): Promise<IntegrationResult> {
    const lockKey = params.repoRoot;

    // Acquire serialized lock
    while (this.repoLocks.has(lockKey)) {
      await this.repoLocks.get(lockKey);
    }

    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.repoLocks.set(lockKey, lockPromise);

    try {
      return this.executeCompareAndSwapMerge(params);
    } finally {
      this.repoLocks.delete(lockKey);
      releaseLock();
    }
  }

  private executeCompareAndSwapMerge(params: IntegrationParams): IntegrationResult {
    const { repoRoot, integrationBranch, expectedIntegrationSha, childBranch, childIssueNumber } =
      params;

    // 1. Resolve current integration branch SHA
    let currentSha = "";
    try {
      currentSha = this.runner(["rev-parse", integrationBranch], { cwd: repoRoot });
    } catch (err: any) {
      throw new CoordinationError(
        "integration_branch_unresolvable",
        `Could not resolve integration branch ${integrationBranch}: ${err.message}`,
      );
    }

    // Resolve expected SHA if it was a ref like HEAD or branch
    let resolvedExpectedSha = expectedIntegrationSha;
    try {
      resolvedExpectedSha = this.runner(["rev-parse", expectedIntegrationSha], { cwd: repoRoot });
    } catch {
      resolvedExpectedSha = expectedIntegrationSha;
    }

    // 2. Compare-and-Swap verification: Check for drift
    if (currentSha !== resolvedExpectedSha) {
      throw new CoordinationError(
        "integration_drift",
        `Integration drift detected on ${integrationBranch}: expected ${resolvedExpectedSha}, but found ${currentSha}`,
        { expectedSha: resolvedExpectedSha, actualSha: currentSha },
      );
    }

    // 3. Resolve child branch SHA
    let childSha = params.childHeadSha ?? "";
    if (!childSha) {
      try {
        childSha = this.runner(["rev-parse", childBranch], { cwd: repoRoot });
      } catch (err: any) {
        throw new CoordinationError(
          "child_branch_unresolvable",
          `Could not resolve child branch ${childBranch}: ${err.message}`,
        );
      }
    }

    // 4. Checkout-free 3-way merge via git merge-tree --write-tree
    let treeSha = "";
    try {
      const mergeTreeOut = this.runner(["merge-tree", "--write-tree", currentSha, childSha], {
        cwd: repoRoot,
      });
      treeSha = mergeTreeOut.trim().split("\n")[0]!.trim();
      if (!treeSha || treeSha.length !== 40) {
        throw new Error(`Unexpected merge-tree output: ${mergeTreeOut}`);
      }
    } catch (err: any) {
      throw new CoordinationError(
        "integration_conflict",
        `Integration conflict while merging ${childBranch} into ${integrationBranch}: ${err.message}`,
        {
          childIssueNumber,
          childBranch,
          integrationBranch,
          preservedSha: currentSha,
          error: err.message,
        },
      );
    }

    // 5. Create merge commit object via git commit-tree without touching index or working tree
    let newCommitSha = "";
    try {
      const commitMsg = `feat(coordination): integrate child #${childIssueNumber} into ${integrationBranch}`;
      newCommitSha = this.runner(
        ["commit-tree", treeSha, "-p", currentSha, "-p", childSha, "-m", commitMsg],
        { cwd: repoRoot },
      );
      newCommitSha = newCommitSha.trim().split("\n")[0]!.trim();
    } catch (err: any) {
      throw new CoordinationError(
        "commit_tree_failed",
        `Failed to create merge commit for child #${childIssueNumber}: ${err.message}`,
      );
    }

    // 6. Compare-and-swap ref update via git update-ref
    const cleanRef = integrationBranch.startsWith("refs/heads/")
      ? integrationBranch
      : `refs/heads/${integrationBranch}`;
    try {
      this.runner(["update-ref", cleanRef, newCommitSha, currentSha], { cwd: repoRoot });
    } catch (err: any) {
      throw new CoordinationError(
        "integration_drift",
        `Integration drift detected during update-ref on ${integrationBranch}: ${err.message}`,
        { expectedSha: currentSha, error: err.message },
      );
    }

    return {
      success: true,
      previousSha: currentSha,
      newSha: newCommitSha,
      childIssueNumber,
    };
  }
}
