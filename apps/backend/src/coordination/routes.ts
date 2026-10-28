import {
  specCoordinationPlanSchema,
  targetedImplementResultSchema,
  coordinationFinalPrResultSchema,
  coordinationFinalPrSubmissionSchema,
} from "@labq/contracts/operator";
import { z } from "zod";
import { SpecCoordinatorService } from "./service";
import { CoordinationError } from "./errors";

const planSubmissionSchema = z.object({
  specIssueNumber: z.number().int().positive(),
  baseBranch: z.string().optional(),
});

const dispatchSubmissionSchema = z.object({
  specIssueNumber: z.number().int().positive(),
  childIssueNumber: z.number().int().positive(),
  actor: z.string().optional(),
});

export async function handleProjectCoordinationRoute(
  request: Request,
  projectId: string,
  parts: string[],
  coordinationService: SpecCoordinatorService,
): Promise<Response | null> {
  // Subroutes under /api/v1/projects/:projectId/coordination/...
  // parts[0] = projectId, parts[1] = "coordination"

  // POST /api/v1/projects/:projectId/coordination/plan
  if (parts.length === 3 && parts[2] === "plan") {
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
    const parsed = planSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    try {
      const plan = await coordinationService.planSpec(projectId, parsed.data.specIssueNumber, {
        baseBranch: parsed.data.baseBranch,
      });
      const validated = specCoordinationPlanSchema.parse(plan);
      return Response.json(validated);
    } catch (err: any) {
      if (err instanceof CoordinationError) {
        const status =
          err.code === "spec_not_found" || err.code === "project_not_found"
            ? 404
            : err.code === "coordination_pipeline_halted"
              ? 409
              : 400;
        return Response.json(
          { error: err.code, message: err.message, details: err.details },
          { status },
        );
      }
      return Response.json({ error: "coordination_failed", message: err.message }, { status: 500 });
    }
  }

  // GET /api/v1/projects/:projectId/coordination/plan/:specNumber
  if (parts.length === 4 && parts[2] === "plan") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    const specNum = parseInt(parts[3], 10);
    if (isNaN(specNum) || specNum <= 0) {
      return Response.json({ error: "invalid_spec_number" }, { status: 400 });
    }
    const plan = coordinationService.getPlan(projectId, specNum);
    if (!plan) {
      return Response.json({ error: "plan_not_found" }, { status: 404 });
    }
    return Response.json(specCoordinationPlanSchema.parse(plan));
  }

  // POST /api/v1/projects/:projectId/coordination/dispatch
  if (parts.length === 3 && parts[2] === "dispatch") {
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
    const parsed = dispatchSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    try {
      const result = await coordinationService.dispatchChild({
        projectId,
        specIssueNumber: parsed.data.specIssueNumber,
        childIssueNumber: parsed.data.childIssueNumber,
        actor: parsed.data.actor,
      });
      return Response.json(targetedImplementResultSchema.parse(result));
    } catch (err: any) {
      if (err instanceof CoordinationError) {
        const status =
          err.code === "child_not_in_plan" || err.code === "plan_not_found"
            ? 404
            : err.code === "prerequisites_not_satisfied" ||
                err.code === "coordination_pipeline_halted" ||
                err.code === "integration_conflict" ||
                err.code === "integration_drift" ||
                err.code === "worktree_lock_conflict"
              ? 409
              : err.code === "starting_sha_mismatch" || err.code === "worktree_dirty"
                ? 422
                : 400;
        return Response.json(
          { error: err.code, message: err.message, details: err.details },
          { status },
        );
      }
      return Response.json({ error: "dispatch_failed", message: err.message }, { status: 500 });
    }
  }

  // POST /api/v1/projects/:projectId/coordination/final-pr
  if (parts.length === 3 && parts[2] === "final-pr") {
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
    const parsed = coordinationFinalPrSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    try {
      const result = await coordinationService.createFinalPullRequest({
        projectId,
        specIssueNumber: parsed.data.specIssueNumber,
        baseBranch: parsed.data.baseBranch,
        title: parsed.data.title,
        body: parsed.data.body,
      });
      return Response.json(coordinationFinalPrResultSchema.parse(result));
    } catch (err: any) {
      if (err instanceof CoordinationError) {
        const status =
          err.code === "plan_not_found"
            ? 404
            : err.code === "unintegrated_children_remain"
              ? 409
              : 400;
        return Response.json(
          { error: err.code, message: err.message, details: err.details },
          { status },
        );
      }
      return Response.json({ error: "final_pr_failed", message: err.message }, { status: 500 });
    }
  }

  return null;
}
