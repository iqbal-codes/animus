export type DeliveryErrorCode =
  | "delivery_run_not_found"
  | "delivery_project_not_found"
  | "delivery_forged_ownership"
  | "delivery_profile_unsupported"
  | "delivery_merge_not_verified"
  | "delivery_gate_unsatisfied"
  | "delivery_remote_unreadable"
  | "delivery_storage_failed";

export class DeliveryError extends Error {
  constructor(
    public readonly code: DeliveryErrorCode,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "DeliveryError";
  }
}
