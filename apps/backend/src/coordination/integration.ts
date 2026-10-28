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

    // Remember the branch currently checked out in repoRoot to restore it afterwards
    let initialBranchOrHead = "";
    try {
      initialBranchOrHead = this.runner(["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot });
    } catch {
      try {
        initialBranchOrHead = this.runner(["rev-parse", "HEAD"], { cwd: repoRoot });
      } catch {}
    }

    // Checkout integration branch
    try {
      this.runner(["checkout", integrationBranch], { cwd: repoRoot });
    } catch (err: any) {
      throw new CoordinationError(
        "checkout_failed",
        `Failed to checkout integration branch ${integrationBranch}: ${err.message}`,
      );
    }

    // 3. Attempt merge
    try {
      this.runner(
        [
          "merge",
          "--no-ff",
          childBranch,
          "-m",
          `feat(coordination): integrate child #${childIssueNumber} into ${integrationBranch}`,
        ],
        { cwd: repoRoot },
      );
    } catch (err: any) {
      // Conflict or merge error detected: abort merge to keep branch uncorrupted
      try {
        this.runner(["merge", "--abort"], { cwd: repoRoot });
      } catch {}

      // Restore initial branch if different
      if (initialBranchOrHead && initialBranchOrHead !== integrationBranch) {
        try {
          this.runner(["checkout", initialBranchOrHead], { cwd: repoRoot });
        } catch {}
      }

      throw new CoordinationError(
        "integration_conflict",
        `Integration conflict while merging ${childBranch} into ${integrationBranch}: ${err.message}`,
        {
          childIssueNumber,
          childBranch,
          integrationBranch,
          preservedSha: currentSha,
        },
      );
    }

    // 4. Resolve new SHA after merge
    let newSha = "";
    try {
      newSha = this.runner(["rev-parse", "HEAD"], { cwd: repoRoot });
    } catch (err: any) {
      throw new CoordinationError(
        "rev_parse_failed",
        `Failed to get post-merge SHA for ${integrationBranch}: ${err.message}`,
      );
    }

    // Restore initial branch if different
    if (initialBranchOrHead && initialBranchOrHead !== integrationBranch) {
      try {
        this.runner(["checkout", initialBranchOrHead], { cwd: repoRoot });
      } catch {}
    }

    return {
      success: true,
      previousSha: currentSha,
      newSha,
      childIssueNumber,
    };
  }
}
