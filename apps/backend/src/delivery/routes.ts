import {
  deliveryGateStatusSchema,
  deliveryClaimReconcileSubmissionSchema,
  deliveryRoleClaimSchema,
} from "@animus/contracts/operator";
import type { DatabaseSync } from "node:sqlite";
import { DeliveryError } from "./errors";
import type { DeliveryGateService } from "./service";
import { reconcileDeliveryClaim, toDeliveryRoleClaimRecord } from "./claims";

function errorStatus(code: DeliveryError["code"]): number {
  switch (code) {
    case "delivery_run_not_found":
    case "delivery_project_not_found":
      return 404;
    case "delivery_forged_ownership":
    case "delivery_profile_unsupported":
    case "delivery_merge_not_verified":
    case "delivery_gate_unsatisfied":
      return 409;
    case "delivery_remote_unreadable":
      return 502;
    default:
      return 500;
  }
}

function failure(error: unknown): Response {
  if (error instanceof DeliveryError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status: errorStatus(error.code) },
    );
  }
  return Response.json(
    {
      error: "delivery_failed",
      message: error instanceof Error ? error.message : String(error),
    },
    { status: 500 },
  );
}

export async function handleProjectDeliveryRoute(
  request: Request,
  projectId: string,
  parts: string[],
  service: DeliveryGateService,
  db: DatabaseSync,
): Promise<Response | null> {
  if (parts[1] !== "delivery") return null;

  if (
    parts.length === 7 &&
    parts[2] === "runs" &&
    parts[4] === "claims" &&
    parts[6] === "reconcile" &&
    request.method === "POST"
  ) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const parsed = deliveryClaimReconcileSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const claim = reconcileDeliveryClaim(db, {
        projectId,
        runId: decodeURIComponent(parts[3]!),
        stage: decodeURIComponent(parts[5]!) as
          | "technical_checks"
          | "independent_review"
          | "final_acceptance",
        lap: parsed.data.lap,
        action: parsed.data.action,
        actor: parsed.data.actor,
        reason: parsed.data.reason,
        ...(parsed.data.observationId ? { observationId: parsed.data.observationId } : {}),
      });
      return Response.json(deliveryRoleClaimSchema.parse(toDeliveryRoleClaimRecord(claim)));
    } catch (error) {
      return Response.json(
        {
          error: "delivery_claim_reconcile_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 409 },
      );
    }
  }

  if (parts.length === 4 && parts[2] === "runs" && request.method === "GET") {
    try {
      const status = await service.getGate(projectId, decodeURIComponent(parts[3]!));
      return Response.json(deliveryGateStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  if (
    parts.length === 5 &&
    parts[2] === "runs" &&
    parts[4] === "verify-merge" &&
    request.method === "POST"
  ) {
    let actor = "operator";
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        const body = JSON.parse(raw) as { actor?: unknown };
        if (typeof body.actor === "string" && body.actor.trim() !== "") {
          actor = body.actor.trim().slice(0, 200);
        }
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
    }
    try {
      const status = await service.verifyMerge(projectId, decodeURIComponent(parts[3]!), actor);
      return Response.json(deliveryGateStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}
