import { createHash } from "node:crypto";
import {
  type FrozenContract,
  type TargetedImplementSubmission,
  type TargetedImplementResult,
  targetedImplementSubmissionSchema,
  targetedImplementResultSchema,
} from "@labq/contracts/operator";
import { parseTicketSections } from "../intake/parser";
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
  if (primitiveName !== "archon-implement") {
    throw new CoordinationError(
      "invalid_primitive",
      `Only targeted 'archon-implement' primitive is permitted. Unbound pickers ('${primitiveName}') are strictly prohibited by Invariant 1.`,
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
    return targetedImplementResultSchema.parse(res);
  }

  // Default execution via Bun subprocess if runner is not provided
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "archon",
        "workflow",
        "run",
        "archon-implement",
        "--cwd",
        submission.worktreePath,
        "--branch",
        submission.branch,
        "--input",
        `contract_digest=${submission.contract.digest}`,
        "--input",
        `child_issue=${submission.childIssueNumber}`,
        "--",
        submission.contract.rawBody,
      ],
      {
        cwd: submission.worktreePath,
        env: process.env,
      },
    );

    if (proc.exitCode !== 0) {
      return {
        success: false,
        childIssueNumber: submission.childIssueNumber,
        error: `Subprocess exited with code ${proc.exitCode}: ${proc.stderr.toString()}`,
        exitCode: proc.exitCode,
      };
    }

    return {
      success: true,
      childIssueNumber: submission.childIssueNumber,
      commitMessage: `feat: implement child #${submission.childIssueNumber}`,
      exitCode: 0,
    };
  } catch (err: any) {
    return {
      success: false,
      childIssueNumber: submission.childIssueNumber,
      error: err.message || "Failed to spawn targeted execution primitive",
    };
  }
}
