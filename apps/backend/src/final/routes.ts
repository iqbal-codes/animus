import {
  finalDeliveryAdvanceSubmissionSchema,
  finalDeliveryStatusListSchema,
  finalDeliveryStatusSchema,
  finalDeliveryVerifySubmissionSchema,
} from "@animus/contracts/operator";
import { FinalDeliveryError } from "./errors";
import type { FinalDeliveryService } from "./service";

function errorStatus(code: FinalDeliveryError["code"]): number {
  switch (code) {
    case "final_project_not_found":
    case "final_plan_not_found":
    case "final_run_not_found":
      return 404;
    case "final_plan_not_spec":
    case "final_plan_not_admitted":
    case "final_manifest_mismatch":
    case "final_delivery_not_established":
    case "final_gate_unsatisfied":
      return 409;
    case "final_remote_unavailable":
      return 502;
    default:
      return 500;
  }
}

function failure(error: unknown): Response {
  if (error instanceof FinalDeliveryError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status: errorStatus(error.code) },
    );
  }
  return Response.json(
    {
      error: "final_delivery_failed",
      message: error instanceof Error ? error.message : String(error),
    },
    { status: 500 },
  );
}

async function readJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim() === "") return {};
  return JSON.parse(raw);
}

export async function handleProjectFinalRoute(
  request: Request,
  projectId: string,
  parts: string[],
  service: FinalDeliveryService,
): Promise<Response | null> {
  if (parts[1] !== "final") return null;

  if (parts.length === 2 && request.method === "GET") {
    try {
      const url = new URL(request.url);
      const planId = url.searchParams.get("plan_id");
      if (planId) {
        return Response.json(
          finalDeliveryStatusSchema.parse(await service.getStatus(projectId, planId)),
        );
      }
      return Response.json(finalDeliveryStatusListSchema.parse(await service.list(projectId)));
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 3 && parts[2] && request.method === "GET") {
    try {
      return Response.json(
        finalDeliveryStatusSchema.parse(
          await service.getStatus(projectId, decodeURIComponent(parts[2])),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 4 && parts[2] && parts[3] === "advance" && request.method === "POST") {
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const parsed = finalDeliveryAdvanceSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      return Response.json(
        finalDeliveryStatusSchema.parse(
          await service.advance(projectId, decodeURIComponent(parts[2]), parsed.data),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 4 && parts[2] && parts[3] === "verify-merge" && request.method === "POST") {
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const parsed = finalDeliveryVerifySubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      return Response.json(
        finalDeliveryStatusSchema.parse(
          await service.verifyMerge(
            projectId,
            decodeURIComponent(parts[2]),
            parsed.data.actor ?? "operator",
          ),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}
