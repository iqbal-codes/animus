import type { OperatorErrorCode } from "@labq/contracts/operator";

export class EvidenceError extends Error {
  constructor(
    public readonly code: OperatorErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EvidenceError";
  }
}
