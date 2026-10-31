import type { OperatorErrorCode } from "@animus/contracts/operator";

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
