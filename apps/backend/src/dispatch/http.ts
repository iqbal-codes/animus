import {
  planDispatchReconcileSubmissionSchema,
  planDispatchReconciliationSchema,
  planDispatchRunListSchema,
  planDispatchRunSchema,
  planDispatchSubmissionSchema,
} from "@animus/contracts/operator";
import { DispatchError, type DispatchService } from "./service";

function errorStatus(code: DispatchError["code"]): number {
  switch (code) {
    case "project_not_found":
    case "plan_not_found":
    case "member_not_in_plan":
    case "run_not_found":
      return 404;
    case "invalid_submission":
      return 400;
    case "storage_failed":
      return 500;
    case "dispatch_failed":
    case "worktree_allocation_failed":
    case "external_effect_unverified":
      return 502;
    default:
      return 409;
  }
}

function failure(error: unknown): Response {
  if (error instanceof DispatchError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status: errorStatus(error.code) },
    );
  }
  return Response.json(
    { error: "dispatch_failed", message: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

export async function handleProjectDispatchRoute(
  request: Request,
  projectId: string,
  parts: string[],
  dispatchService: DispatchService,
): Promise<Response | null> {
  if (parts[1] !== "dispatch") return null;

  if (parts.length === 2) {
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
    const parsed = planDispatchSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const run = await dispatchService.dispatch(projectId, parsed.data);
      return Response.json(planDispatchRunSchema.parse(run), { status: 201 });
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 3 && parts[2] === "runs") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    const planId = new URL(request.url).searchParams.get("plan_id") ?? undefined;
    return Response.json(
      planDispatchRunListSchema.parse(dispatchService.listRuns(projectId, { plan_id: planId })),
    );
  }

  if (parts.length === 3 && parts[2] === "reconcile") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const raw = await request.text();
    let body: unknown = {};
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
    }
    const parsed = planDispatchReconcileSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    return Response.json(
      planDispatchReconciliationSchema.parse(dispatchService.reconcile(projectId)),
    );
  }

  if (parts.length === 4 && parts[2] === "runs") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    try {
      const run = dispatchService.getRun(projectId, decodeURIComponent(parts[3]!));
      return Response.json(planDispatchRunSchema.parse(run));
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 5 && parts[2] === "runs" && parts[4] === "reconcile") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const raw = await request.text();
    let body: unknown = {};
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
    }
    const parsed = planDispatchReconcileSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const run = dispatchService.reconcileRun(projectId, decodeURIComponent(parts[3]!));
      return Response.json(planDispatchRunSchema.parse(run));
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}
