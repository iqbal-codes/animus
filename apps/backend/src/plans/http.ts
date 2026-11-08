import {
  planDecisionSubmissionSchema,
  planImportSubmissionSchema,
  planListSchema,
  planRecordSchema,
} from "@animus/contracts/operator";
import { PlanError, PlanService } from "./service";

function errorStatus(code: PlanError["code"]): number {
  switch (code) {
    case "project_not_found":
    case "work_not_found":
    case "issue_not_found":
    case "plan_not_found":
      return 404;
    case "project_not_active":
      return 409;
    case "intake_unavailable":
    case "plan_storage_failed":
      return 503;
    case "plan_import_failed":
      return 500;
    default:
      return 500;
  }
}

function failure(error: unknown): Response {
  if (error instanceof PlanError) {
    return Response.json({ error: error.code }, { status: errorStatus(error.code) });
  }
  return Response.json({ error: "plan_import_failed" }, { status: 500 });
}

export async function handleProjectPlanRoute(
  request: Request,
  projectId: string,
  parts: string[],
  planService: PlanService,
): Promise<Response | null> {
  if (parts[1] !== "plans") return null;

  if (parts.length === 2) {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    try {
      return Response.json(planListSchema.parse(planService.listPlans(projectId)));
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 3 && parts[2] === "import") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const parsed = planImportSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const plan = await planService.importPlan(projectId, parsed.data);
      return Response.json(planRecordSchema.parse(plan));
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 3) {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    try {
      const planId = decodeURIComponent(parts[2]!);
      return Response.json(planRecordSchema.parse(planService.getPlan(projectId, planId)));
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 4 && (parts[3] === "approve" || parts[3] === "revoke")) {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    let body: unknown = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
    }
    const parsed = planDecisionSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const planId = decodeURIComponent(parts[2]!);
      const result =
        parts[3] === "approve"
          ? planService.approvePlan(projectId, planId, parsed.data)
          : planService.revokePlan(projectId, planId, parsed.data);
      return Response.json(planRecordSchema.parse(result));
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}
