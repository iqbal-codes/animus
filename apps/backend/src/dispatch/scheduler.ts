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
  | "delivery_already_claimed"
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
  delivery?: unknown;
}

export interface LocalDispatchDeliveryRuntime {
  process(projectId: string, runId: string): Promise<unknown>;
}

export interface LocalDispatchFinalRuntime {
  advance(projectId: string, planId: string): Promise<unknown>;
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
  /** Normal delivery runtime: independent QA/review and bounded correction after a standalone/final build. */
  deliveryRuntime?: LocalDispatchDeliveryRuntime;
  /** Final-spec coordination: runs once every required child is integrated. */
  finalDeliveryRuntime?: LocalDispatchFinalRuntime;
}

function planSkipReason(error: DispatchError): LocalDispatchSkipReason | "continue" {
  switch (error.code) {
    case "claim_conflict":
    case "no_dispatchable_member":
    case "already_succeeded":
    case "dependency_pending_integration":
    case "plan_not_dispatchable":
    case "parent_not_dispatchable":
    case "budget_exhausted":
    case "work_held":
    case "work_stopping":
    case "work_stopped":
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

const ACTIVE_RUN_STATES = new Set(["claimed", "dispatched", "running", "interrupted"]);
const RESUMABLE_DELIVERY_ACTIONS = new Set([
  "published",
  "verification_recorded",
  "findings_resolved",
  "correction_dispatched",
]);

/**
 * Resume gate processing for a run that already succeeded (for example after a
 * CLI-only build or a process restart). Without this, `dispatch()` reports
 * `already_succeeded` forever and the candidate never gets its child PR, review,
 * required CI read-back or verified integration.
 */
function deliveryClaimDetail(delivery: unknown): string | null {
  if (!delivery || typeof delivery !== "object") return null;
  const record = delivery as { action?: unknown; reasons?: unknown };
  if (record.action !== "already_claimed") return null;
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  return reasons.length > 0 ? reasons.join(", ") : "delivery_stage_already_claimed";
}

interface ResumeDeliveryResult {
  tick: LocalDispatchTickResult | null;
  claimed: string | null;
}

async function resumeDelivery(
  options: LocalDispatchTickOptions,
  projectId: string,
  planId: string,
): Promise<ResumeDeliveryResult> {
  if (!options.deliveryRuntime) return { tick: null, claimed: null };
  const runs = options.dispatch.listRuns(projectId, { plan_id: planId });
  const activeWorks = new Set(
    runs.filter((run) => ACTIVE_RUN_STATES.has(run.state)).map((run) => run.work_id),
  );
  const seenWorks = new Set<string>();
  let claimed: string | null = null;
  for (const run of runs) {
    // listRuns is newest-first: only the latest attempt for each work item counts.
    if (seenWorks.has(run.work_id)) continue;
    seenWorks.add(run.work_id);
    if (activeWorks.has(run.work_id)) continue;
    if (run.state !== "succeeded") continue;
    // The final coordinator materializes and drives its own combined-candidate run.
    if (run.gate_profile === "final") continue;
    try {
      const delivery = await options.deliveryRuntime.process(projectId, run.id);
      const claim = deliveryClaimDetail(delivery);
      if (claim !== null) {
        // A supported competing tick owns this run/stage. It is not a verification
        // failure; keep looking for genuinely independent work in this plan.
        claimed = claim;
        continue;
      }
      if (
        delivery &&
        typeof delivery === "object" &&
        "action" in delivery &&
        RESUMABLE_DELIVERY_ACTIONS.has(String((delivery as { action: unknown }).action))
      ) {
        return {
          tick: {
            action: "launched",
            reason: "launch_successful",
            projectId,
            planId,
            runId: run.id,
            issueNumber: run.issue_number,
            delivery,
          },
          claimed,
        };
      }
    } catch (error) {
      // Unexpected delivery failures are not claim conflicts. Surface them instead
      // of silently swallowing the reason and pretending the run was unavailable.
      const message = error instanceof Error ? error.message : String(error);
      return {
        tick: {
          action: "skipped",
          reason: "launch_failed",
          projectId,
          planId,
          runId: run.id,
          issueNumber: run.issue_number,
          error: message,
          delivery: { action: "failed", reasons: [message] },
        },
        claimed,
      };
    }
  }
  return { tick: null, claimed };
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
  let claimedDetail: string | null = null;

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

      const resumed = await resumeDelivery(options, project.id, plan.id);
      if (resumed.claimed) claimedDetail = resumed.claimed;
      if (resumed.tick) return resumed.tick;

      if (options.dispatch.countTotalActiveRuns() >= options.dispatch.getMachineCapacity()) {
        return {
          action: "skipped",
          reason: "capacity_full",
          projectId: project.id,
          planId: plan.id,
          error: `Machine capacity is full (${options.dispatch.countTotalActiveRuns()}/${options.dispatch.getMachineCapacity()})`,
        };
      }

      try {
        const run = await options.dispatch.dispatch(project.id, {
          plan_id: plan.id,
          actor: options.actor ?? "scheduler",
          scheduled: true,
        });
        let delivery: unknown;
        if (options.deliveryRuntime) {
          try {
            delivery = await options.deliveryRuntime.process(project.id, run.id);
          } catch (error) {
            delivery = {
              action: "failed",
              reasons: [error instanceof Error ? error.message : String(error)],
            };
          }
        }
        return {
          action: "launched",
          reason: "launch_successful",
          projectId: project.id,
          planId: plan.id,
          runId: run.id,
          issueNumber: run.issue_number,
          ...(delivery !== undefined ? { delivery } : {}),
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
        if (reason === "continue") {
          if (
            options.finalDeliveryRuntime &&
            plan.kind === "spec" &&
            (error.code === "no_dispatchable_member" || error.code === "already_succeeded")
          ) {
            try {
              const final = await options.finalDeliveryRuntime.advance(project.id, plan.id);
              return {
                action: "launched",
                reason: "launch_successful",
                projectId: project.id,
                planId: plan.id,
                delivery: final,
              };
            } catch (finalError) {
              return {
                action: "skipped",
                reason: "launch_failed",
                projectId: project.id,
                planId: plan.id,
                error: finalError instanceof Error ? finalError.message : String(finalError),
              };
            }
          }
          continue;
        }
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

  if (claimedDetail !== null) {
    return {
      action: "skipped",
      reason: "delivery_already_claimed",
      detail: claimedDetail,
    };
  }
  return {
    action: "skipped",
    reason: sawAdmittedPlan ? "no_eligible_work" : "no_admitted_plans",
  };
}
