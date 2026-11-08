import { operatorBoardSchema, operatorWorkDetailSchema } from "@animus/contracts/operator";
import { BoardError } from "./errors";
import type { OperatorBoardService } from "./service";

function errorStatus(code: BoardError["code"]): number {
  switch (code) {
    case "board_project_not_found":
    case "board_work_not_found":
      return 404;
    default:
      return 503;
  }
}

function failure(error: unknown): Response {
  if (error instanceof BoardError) {
    return Response.json({ error: error.code }, { status: errorStatus(error.code) });
  }
  return Response.json({ error: "board_storage_failed" }, { status: 503 });
}

export async function handleProjectBoardRoute(
  request: Request,
  projectId: string,
  parts: string[],
  boardService: OperatorBoardService,
): Promise<Response | null> {
  if (parts[1] !== "board") return null;

  if (request.method !== "GET") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "GET" } },
    );
  }

  try {
    if (parts.length === 2) {
      return Response.json(operatorBoardSchema.parse(await boardService.getBoard(projectId)));
    }
    if (parts.length === 4 && parts[2] === "work") {
      return Response.json(
        operatorWorkDetailSchema.parse(
          await boardService.getWorkDetail(projectId, decodeURIComponent(parts[3]!)),
        ),
      );
    }
  } catch (error) {
    return failure(error);
  }

  return null;
}
