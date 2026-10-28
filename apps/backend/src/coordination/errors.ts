export class CoordinationError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message || code);
    this.name = "CoordinationError";
  }
}
