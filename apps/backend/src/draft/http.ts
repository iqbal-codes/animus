import {
  draftDecisionSubmissionSchema,
  draftListSchema,
  draftRecordSchema,
  draftRefineSubmissionSchema,
  draftRevisionSubmissionSchema,
} from "@animus/contracts/operator";
import { DraftError } from "./errors";
import type { DraftService } from "./service";

function failure(error: unknown): Response {
  if (error instanceof DraftError) {
    const status =
      error.code === "draft_not_found" || error.code === "draft_work_not_found"
        ? 404
        : error.code === "draft_stale_revision" ||
            error.code === "draft_concurrent_update" ||
            error.code === "draft_not_approvable"
          ? 409
          : error.code === "draft_planning_unavailable" || error.code === "draft_storage_failed"
            ? 503
            : error.code === "draft_planning_failed"
              ? 502
              : 400;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  return Response.json({ error: "draft_storage_failed" }, { status: 503 });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleProjectDraftRoute(
  request: Request,
  projectId: string,
  parts: string[],
  draftService: DraftService,
): Promise<Response | null> {
  if (parts[1] !== "drafts") return null;

  try {
    if (parts.length === 2) {
      if (request.method === "GET") {
        return Response.json(draftListSchema.parse(draftService.list(projectId)));
      }
      if (request.method === "POST") {
        const parsed = draftRefineSubmissionSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          return Response.json(
            { error: "invalid_payload", message: parsed.error.message },
            { status: 400 },
          );
        }
        return Response.json(
          draftRecordSchema.parse(await draftService.refine(projectId, parsed.data)),
        );
      }
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET, POST" } },
      );
    }

    if (parts.length === 4 && parts[2] === "by-work") {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      const record = draftService.getByWork(projectId, decodeURIComponent(parts[3]!));
      if (!record) {
        return Response.json({ error: "draft_not_found" }, { status: 404 });
      }
      return Response.json(draftRecordSchema.parse(record));
    }

    const draftId = decodeURIComponent(parts[2]!);
    if (parts.length === 3) {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      return Response.json(draftRecordSchema.parse(draftService.get(projectId, draftId)));
    }

    if (parts.length === 4 && parts[3] === "revisions") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      const parsed = draftRevisionSubmissionSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        return Response.json(
          { error: "invalid_payload", message: parsed.error.message },
          { status: 400 },
        );
      }
      return Response.json(
        draftRecordSchema.parse(await draftService.revise(projectId, draftId, parsed.data)),
      );
    }

    if (parts.length === 4 && parts[3] === "decisions") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      const parsed = draftDecisionSubmissionSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        return Response.json(
          { error: "invalid_payload", message: parsed.error.message },
          { status: 400 },
        );
      }
      return Response.json(
        draftRecordSchema.parse(draftService.decide(projectId, draftId, parsed.data)),
      );
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return failure(error);
  }
}
