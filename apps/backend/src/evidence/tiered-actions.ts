import type {
  TieredActionSubmission,
  TieredActionResult,
  ConsequentialActionType,
} from "@labq/contracts/operator";
import { EvidenceError } from "./errors";

export interface FreshnessResolver {
  resolveBranchSha(targetBranch: string): Promise<string> | string;
  checkPrerequisite?(key: string): Promise<string | undefined> | string | undefined;
}

export class TieredActionMatrix {
  private static readonly MAX_FRESHNESS_MS = 10_000; // ≤ 10s freshness rule

  private consequentialActions = new Set<ConsequentialActionType>([
    "launch",
    "cancel",
    "gate_approval",
    "promotion_pr",
    "merge",
    "deploy",
  ]);

  isConsequential(action: string): boolean {
    return this.consequentialActions.has(action as ConsequentialActionType);
  }

  async validateAndExecute(
    submission: TieredActionSubmission,
    resolver: FreshnessResolver,
    executeFn?: () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
  ): Promise<TieredActionResult> {
    // 1. Consequential actions require explicit modal confirmation
    if (!submission.confirmed) {
      throw new EvidenceError(
        "confirmation_required",
        `Consequential action '${submission.action}' requires explicit confirmation with target branch and candidate SHA.`,
        { action: submission.action, targetBranch: submission.targetBranch },
      );
    }

    // 2. Measure live freshness check execution time (≤ 10s rule)
    const startTime = Date.now();
    let liveBranchSha: string;
    try {
      liveBranchSha = await resolver.resolveBranchSha(submission.targetBranch);
    } catch (err: any) {
      throw new EvidenceError(
        "freshness_check_failed",
        `Failed to resolve live branch SHA for ${submission.targetBranch}: ${err?.message || String(err)}`,
        { targetBranch: submission.targetBranch },
      );
    }

    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > TieredActionMatrix.MAX_FRESHNESS_MS) {
      throw new EvidenceError(
        "freshness_check_failed",
        `Live freshness check exceeded maximum 10-second threshold (${elapsedMs}ms). Fails closed.`,
        { durationMs: elapsedMs, maxAllowedMs: TieredActionMatrix.MAX_FRESHNESS_MS },
      );
    }

    // 3. Verify Branch SHA freshness / drift
    if (liveBranchSha !== submission.expectedBranchSha) {
      throw new EvidenceError(
        "action_drift_detected",
        `Target branch ${submission.targetBranch} SHA drifted between confirmation and execution: expected ${submission.expectedBranchSha}, but found live ${liveBranchSha}.`,
        {
          expectedSha: submission.expectedBranchSha,
          actualSha: liveBranchSha,
          targetBranch: submission.targetBranch,
        },
      );
    }

    // 4. Verify prerequisite states freshness
    if (submission.prerequisiteStates && resolver.checkPrerequisite) {
      for (const [key, expectedValue] of Object.entries(submission.prerequisiteStates)) {
        const liveValue = await resolver.checkPrerequisite(key);
        if (liveValue !== expectedValue) {
          throw new EvidenceError(
            "prerequisite_drift_detected",
            `Prerequisite state drifted for '${key}': expected '${expectedValue}', but found live '${liveValue}'.`,
            { key, expected: expectedValue, actual: liveValue },
          );
        }
      }
    }

    // 5. Execute action if callback provided
    let details: Record<string, unknown> | undefined;
    if (executeFn) {
      const res = await executeFn();
      if (res && typeof res === "object") {
        details = res;
      }
    }

    return {
      success: true,
      action: submission.action,
      freshnessVerified: true,
      freshnessDurationMs: elapsedMs,
      targetBranch: submission.targetBranch,
      branchSha: liveBranchSha,
      executedAt: new Date().toISOString(),
      details,
    };
  }
}
