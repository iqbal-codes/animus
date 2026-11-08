import {
  cutoverAbortResultSchema,
  cutoverAbortSubmissionSchema,
  cutoverActivateResultSchema,
  cutoverActivateSubmissionSchema,
  cutoverMappingsResultSchema,
  cutoverStageResultSchema,
  cutoverStageSubmissionSchema,
  cutoverStatusSchema,
} from "@animus/contracts/cutover";
import { AuthorityCutoverError, type AuthorityCutoverService } from "./service";

function statusFor(code: string): number {
  switch (code) {
    case "cutover_already_active":
    case "cutover_writers_active":
    case "cutover_state_changed":
    case "cutover_inconsistent":
    case "cutover_not_abortable":
      return 409;
    case "cutover_not_staged":
    case "cutover_expected_mismatch":
    case "cutover_backup_invalid":
    case "cutover_restore_invalid":
      return 400;
    default:
      return 500;
  }
}

function failure(error: unknown): Response {
  if (error instanceof AuthorityCutoverError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status: statusFor(error.code) },
    );
  }
  return Response.json(
    { error: "cutover_failed", message: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleAuthorityRoute(
  request: Request,
  path: string,
  service: AuthorityCutoverService,
): Promise<Response | null> {
  if (path === "/api/v1/authority" || path === "/api/v1/authority/status") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    try {
      return Response.json(cutoverStatusSchema.parse(service.status()));
    } catch (error) {
      return failure(error);
    }
  }

  if (path === "/api/v1/authority/mappings") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    const url = new URL(request.url);
    const cutoverId = url.searchParams.get("cutover_id");
    if (!cutoverId) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      return Response.json(cutoverMappingsResultSchema.parse(service.mappings(cutoverId)));
    } catch (error) {
      return failure(error);
    }
  }

  if (path === "/api/v1/authority/stage") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const parsed = cutoverStageSubmissionSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      return Response.json(cutoverStageResultSchema.parse(await service.stage(parsed.data)), {
        status: 201,
      });
    } catch (error) {
      return failure(error);
    }
  }

  if (path === "/api/v1/authority/activate") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const parsed = cutoverActivateSubmissionSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      return Response.json(cutoverActivateResultSchema.parse(await service.activate(parsed.data)));
    } catch (error) {
      return failure(error);
    }
  }

  if (path === "/api/v1/authority/abort") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const parsed = cutoverAbortSubmissionSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      return Response.json(cutoverAbortResultSchema.parse(await service.abort(parsed.data)));
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}
