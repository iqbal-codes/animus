import type { DatabaseSync } from "node:sqlite";
import type { PlanService } from "../plans";
import type { ProjectRegistryService } from "../registry";
import { DispatchError, type DispatchService } from "./service";

export type LocalDispatchSkipReason =
  | "no_active_projects"
  | "no_admitted_plans"
  | "no_eligible_work"
  | "authority_not_activated"
  | "stop_brake_set"
  | "pause_brake_set"
  | "capacity_full"
  | "launch_failed"
  | "dry_run";

export interface LocalDispatchTickResult {
  action: "launched" | "skipped";
  reason: "launch_successful" | LocalDispatchSkipReason;
  projectId?: string;
  planId?: string;
  runId?: string;
  issueNumber?: number;
  detail?: string;
  error?: string;
}

export interface LocalDispatchTickOptions {
  db: DatabaseSync;
  registry: ProjectRegistryService;
  plans: PlanService;
  dispatch: DispatchService;
  actor?: string;
  dryRun?: boolean;
  /** Restrict the tick to one project (the monitor ticks per project). */
  projectId?: string;
}

function planSkipReason(error: DispatchError): LocalDispatchSkipReason | "continue" {
  switch (error.code) {
    case "claim_conflict":
    case "no_dispatchable_member":
    case "already_succeeded":
    case "dependency_pending_integration":
    case "plan_not_dispatchable":
    case "parent_not_dispatchable":
      return "continue";
    case "capacity_full":
      return "capacity_full";
    case "authority_not_activated":
      return "authority_not_activated";
    case "launch_brake_set":
      return "stop_brake_set";
    case "schedule_paused":
      return "pause_brake_set";
    default:
      return "launch_failed";
  }
}

/**
 * Scheduler tick over locally admitted plans. It never fetches GitHub backlog:
 * eligibility comes from the frozen plan manifest and durable dispatch state.
 */
export async function runLocalDispatchTick(
  options: LocalDispatchTickOptions,
): Promise<LocalDispatchTickResult> {
  const projects = options.registry
    .listProjects()
    .filter((project) => project.status === "active")
    .filter((project) => !options.projectId || project.id === options.projectId)
    .sort((left, right) => {
      const byCreated = String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
      return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
    });
  if (projects.length === 0) {
    return { action: "skipped", reason: "no_active_projects" };
  }

  let sawAdmittedPlan = false;

  for (const project of projects) {
    const summaries = options.plans
      .listPlans(project.id)
      .filter((summary) => summary.authority === "admitted")
      .sort((left, right) => left.root_issue_number - right.root_issue_number);
    for (const summary of summaries) {
      sawAdmittedPlan = true;
      let plan;
      try {
        plan = options.plans.getPlan(project.id, summary.id);
      } catch {
        continue;
      }
      if (!plan.dispatchable) continue;

      if (options.dryRun) {
        return {
          action: "skipped",
          reason: "dry_run",
          projectId: project.id,
          planId: plan.id,
          detail: `Plan ${plan.id} (${plan.kind}) is eligible for local dispatch`,
        };
      }

      try {
        const run = await options.dispatch.dispatch(project.id, {
          plan_id: plan.id,
          actor: options.actor ?? "scheduler",
          scheduled: true,
        });
        return {
          action: "launched",
          reason: "launch_successful",
          projectId: project.id,
          planId: plan.id,
          runId: run.id,
          issueNumber: run.issue_number,
        };
      } catch (error) {
        if (!(error instanceof DispatchError)) {
          return {
            action: "skipped",
            reason: "launch_failed",
            projectId: project.id,
            planId: plan.id,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        const reason = planSkipReason(error);
        if (reason === "continue") continue;
        return {
          action: "skipped",
          reason,
          projectId: project.id,
          planId: plan.id,
          error: error.message,
        };
      }
    }
  }

  return {
    action: "skipped",
    reason: sawAdmittedPlan ? "no_eligible_work" : "no_admitted_plans",
  };
}
