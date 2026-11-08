export type PublicationErrorCode =
  | "publication_not_found"
  | "publication_target_not_found"
  | "publication_run_not_found"
  | "publication_no_candidate"
  | "publication_candidate_mismatch"
  | "publication_transport_unsupported"
  | "publication_wrong_binding"
  | "publication_summary_binding_ambiguous"
  | "publication_evidence_not_found"
  | "publication_invalid_url";

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
