export type DraftErrorCode =
  | "draft_work_not_found"
  | "draft_not_found"
  | "draft_invalid_plan"
  | "draft_answers_required"
  | "draft_answer_mismatch"
  | "draft_stale_revision"
  | "draft_concurrent_update"
  | "draft_not_approvable"
  | "draft_planning_unavailable"
  | "draft_planning_failed"
  | "draft_storage_failed";

export class DraftError extends Error {
  constructor(
    public readonly code: DraftErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DraftError";
  }
}

export function invalidPlan(detail: string): never {
  throw new DraftError("draft_invalid_plan", detail);
}

export function storageFailure(error: unknown): DraftError {
  return new DraftError(
    "draft_storage_failed",
    error instanceof Error ? error.message : String(error),
  );
}
