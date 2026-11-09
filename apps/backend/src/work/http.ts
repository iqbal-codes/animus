import { workListSchema, workRecordSchema } from "@animus/contracts/operator";
import { WorkPersistenceError, WorkService } from "./service";

export async function handleProjectWorkRoute(
  request: Request,
  projectId: string,
  parts: string[],
  workService: WorkService,
): Promise<Response | null> {
  if (parts[1] !== "work" || (parts.length !== 2 && parts.length !== 3)) return null;

  if (request.method !== "GET") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "GET" } },
    );
  }

  if (parts.length === 2) {
    try {
      return Response.json(workListSchema.parse(workService.listWork(projectId)));
    } catch {
      return Response.json({ error: "storage_failed" }, { status: 503 });
    }
  }

  try {
    const workId = decodeURIComponent(parts[2]!);
    return Response.json(workRecordSchema.parse(workService.getWorkById(projectId, workId)));
  } catch (error) {
    if (error instanceof WorkPersistenceError && error.code === "work_not_found") {
      return Response.json({ error: "work_not_found" }, { status: 404 });
    }
    return Response.json({ error: "storage_failed" }, { status: 503 });
  }
}
