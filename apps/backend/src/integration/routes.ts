import {
  integrationLandSubmissionSchema,
  integrationStatusListSchema,
  integrationStatusSchema,
} from "@animus/contracts/operator";
import { IntegrationError } from "./errors";
import { integrationErrorStatus, type ChildIntegrationService } from "./service";

function failure(error: unknown): Response {
  if (error instanceof IntegrationError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status: integrationErrorStatus(error.code) },
    );
  }
  return Response.json(
    {
      error: "integration_failed",
      message: error instanceof Error ? error.message : String(error),
    },
    { status: 500 },
  );
}

export async function handleProjectIntegrationRoute(
  request: Request,
  projectId: string,
  parts: string[],
  service: ChildIntegrationService,
): Promise<Response | null> {
  if (parts[1] !== "integration") return null;

  if (parts.length === 2 && request.method === "GET") {
    const url = new URL(request.url);
    const statuses = service.listStatuses(projectId, {
      workId: url.searchParams.get("work_id") ?? undefined,
      deliveryId: url.searchParams.get("delivery_id") ?? undefined,
      planId: url.searchParams.get("plan_id") ?? undefined,
    });
    return Response.json(integrationStatusListSchema.parse(statuses));
  }

  if (parts.length === 4 && parts[2] === "runs" && parts[3] && request.method === "GET") {
    try {
      return Response.json(
        integrationStatusSchema.parse(service.getStatus(projectId, decodeURIComponent(parts[3]))),
      );
    } catch (error) {
      return failure(error);
    }
  }

  if (
    parts.length === 5 &&
    parts[2] === "runs" &&
    parts[3] &&
    parts[4] === "land" &&
    request.method === "POST"
  ) {
    const raw = await request.text();
    let body: unknown = {};
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
    }
    const parsed = integrationLandSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const status = await service.land(projectId, decodeURIComponent(parts[3]), parsed.data);
      return Response.json(integrationStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}
