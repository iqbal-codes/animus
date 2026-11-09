export type FinalDeliveryErrorCode =
  | "final_project_not_found"
  | "final_project_not_active"
  | "final_plan_not_found"
  | "final_plan_not_spec"
  | "final_plan_not_admitted"
  | "final_manifest_mismatch"
  | "final_delivery_not_established"
  | "final_run_not_found"
  | "final_gate_unsatisfied"
  | "final_remote_unavailable"
  | "final_installation_held"
  | "final_storage_failed";

export class FinalDeliveryError extends Error {
  constructor(
    public readonly code: FinalDeliveryErrorCode,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "FinalDeliveryError";
  }
}
