export type IntegrationErrorCode =
  | "integration_project_not_found"
  | "integration_run_not_found"
  | "integration_run_not_child"
  | "integration_run_not_succeeded"
  | "integration_merge_policy_manual"
  | "integration_acceptance_blocked"
  | "integration_publication_missing"
  | "integration_publication_incomplete"
  | "integration_remote_unreadable"
  | "integration_remote_binding_mismatch"
  | "integration_pull_request_closed"
  | "integration_ci_missing"
  | "integration_ci_pending"
  | "integration_ci_failed"
  | "integration_target_missing"
  | "integration_target_drift"
  | "integration_conflict"
  | "integration_merge_rejected"
  | "integration_merge_unknown"
  | "integration_lineage_unverified"
  | "integration_storage_failed"
  | "integration_installation_held";

export class IntegrationError extends Error {
  constructor(
    public readonly code: IntegrationErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "IntegrationError";
  }
}
