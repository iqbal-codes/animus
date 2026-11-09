import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveAnimusStateDir } from "@animus/contracts/paths";
import {
  type FrozenContract,
  type TargetedImplementSubmission,
  type TargetedImplementResult,
  targetedImplementSubmissionSchema,
  targetedImplementResultSchema,
} from "@animus/contracts/operator";
import { parseTicketSections } from "../intake/parser";
import { runFrozenBuilder } from "./frozen-builder";
import { CoordinationError } from "./errors";

export type ImplementRunner = (
  submission: TargetedImplementSubmission,
) => Promise<TargetedImplementResult>;

export function freezeContract(rawMarkdown: string): FrozenContract {
  const sections = parseTicketSections(rawMarkdown);
  const digest = createHash("sha256").update(rawMarkdown.trim()).digest("hex");

  return {
    sourceAndProblem: sections.sourceProblem,
    outcome: sections.outcome,
    invariants: sections.invariants,
    acceptanceCriteria: sections.acceptanceCriteria,
    boundary: sections.boundary,
    rawBody: rawMarkdown,
    digest,
  };
}

export function validateTargetedPrimitive(primitiveName: string): void {
  if (primitiveName !== "animus-implement") {
    throw new CoordinationError(
      "invalid_primitive",
      `Only targeted 'animus-implement' primitive is permitted. Unbound pickers ('${primitiveName}') are strictly prohibited by Invariant 1.`,
      { prohibitedPrimitive: primitiveName },
    );
  }
}

export async function executeTargetedImplement(
  submission: TargetedImplementSubmission,
  runner?: ImplementRunner,
): Promise<TargetedImplementResult> {
  const parsed = targetedImplementSubmissionSchema.safeParse(submission);
  if (!parsed.success) {
    throw new CoordinationError(
      "invalid_targeted_submission",
      "Submission does not conform to targetedImplementSubmissionSchema",
      { errors: parsed.error.issues },
    );
  }

  // Invariant 1: Targeted primitives only
  validateTargetedPrimitive(submission.primitive);

  // Validate contract digest integrity
  const recomputedDigest = createHash("sha256")
    .update(submission.contract.rawBody.trim())
    .digest("hex");
  if (recomputedDigest !== submission.contract.digest) {
    throw new CoordinationError(
      "contract_digest_mismatch",
      `Contract digest mismatch: expected ${submission.contract.digest}, recomputed ${recomputedDigest}`,
    );
  }

  if (runner) {
    const res = await runner(submission);
    const parsed = targetedImplementResultSchema.parse(res);
    return Object.assign(parsed, {
      ...((res as any).autoMergeJudgement
        ? { autoMergeJudgement: (res as any).autoMergeJudgement }
        : {}),
      ...((res as any).reviewerReport ? { reviewerReport: (res as any).reviewerReport } : {}),
    });
  }

  // Default execution through the real bounded builder role. The legacy
  // `bun animus workflow` subprocess never existed in this repository; a
  // fabricated success with no commit is not a valid targeted result.
  const runId = `targeted_${randomUUID()}`;
  const result = await runFrozenBuilder({
    projectRoot: submission.worktreePath,
    worktreePath: submission.worktreePath,
    branch: submission.branch,
    baseSha: submission.startSha,
    issueNumber: submission.childIssueNumber,
    specIssueNumber: submission.specIssueNumber,
    contractBody: submission.contract.rawBody,
    runId,
    runDirectory: join(resolveAnimusStateDir(), "dispatch", runId),
  });

  return {
    success: result.success,
    childIssueNumber: submission.childIssueNumber,
    ...(result.headSha ? { headSha: result.headSha } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  };
}
