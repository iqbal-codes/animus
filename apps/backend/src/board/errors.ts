export type BoardErrorCode =
  | "board_project_not_found"
  | "board_work_not_found"
  | "board_storage_failed";

export class BoardError extends Error {
  constructor(
    public readonly code: BoardErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BoardError";
  }
}
