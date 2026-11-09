export type PublicationErrorCode =
  | "publication_not_found"
  | "publication_target_not_found"
  | "publication_run_not_found"
  | "publication_no_candidate"
  | "publication_candidate_mismatch"
  | "publication_transport_unsupported"
  | "publication_wrong_binding"
  | "publication_push_failed"
  | "publication_push_unknown"
  | "publication_remote_unverified"
  | "publication_remote_ref_mismatch"
  | "publication_head_unverified"
  | "publication_head_mismatch"
  | "publication_summary_binding_ambiguous"
  | "publication_evidence_not_found"
  | "publication_invalid_url"
  | "publication_installation_held";

export class PublicationError extends Error {
  constructor(
    public readonly code: PublicationErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "PublicationError";
  }
}
