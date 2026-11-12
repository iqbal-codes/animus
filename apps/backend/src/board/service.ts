import { loadScheduleConfig } from "@animus/contracts/paths";
import type {
  DeliveryGateState,
  DeliveryGateStatus,
  DispatchRunDetail,
  DispatchRunState,
  ExecutionControlStatus,
  FinalDeliveryState,
  FinalDeliveryStatus,
  IntegrationState,
  IntegrationStatus,
  OperatorBoard,
  OperatorBoardCard,
  OperatorBoardLane,
  OperatorBoardLaneId,
  OperatorBoardParent,
  OperatorBoardProcess,
  OperatorCardKind,
  OperatorExecutionStep,
  OperatorRealtimeLogLine,
  OperatorSpecProgress,
  OperatorWorkerUsage,
  OperatorWorkDetail,
  OperatorWorkLogEntry,
  PlanAuthority,
  PlanDispatchRun,
  PlanGateProfile,
  PlanMember,
  PlanMemberRole,
  PlanRecord,
  Project,
  PublicationStatus,
  RunEvidenceReport,
  WorkRecord,
} from "@animus/contracts/operator";
import {
  operatorBoardLaneIdSchema,
  operatorBoardSchema,
  operatorWorkDetailSchema,
} from "@animus/contracts/operator";
import type { DeliveryGateService } from "../delivery";
import type { DispatchService } from "../dispatch";
import type { ExecutionObservationService } from "../evidence";
import type { FinalDeliveryService } from "../final";
import type { ChildIntegrationService } from "../integration";
import type { PlanService } from "../plans";
import type { PublicationService } from "../publication";
import type { ProjectRegistryService } from "../registry";
import type { WorkService } from "../work";
import type { IntakeService } from "../intake";
import type { DraftService } from "../draft";
import type { DraftRecord } from "@animus/contracts/operator";
import { BoardError } from "./errors";

/**
 * Explicit placement precedence. The first matching rule wins; every card also
 * carries the rules that matched so the operator can see why it sits in a lane.
 *
 * `merged` for a child ticket means verified inclusion in the spec integration
 * branch, never parent delivery. A parent only reaches `merged` after the final
 * delivery target merge is verified.
 */
export const BOARD_PRECEDENCE: readonly string[] = [
  "needs-owner: attempt budget exhausted or final delivery escalated to the owner",
  "parked: the operator held, stopped or is stopping the run",
  "failed: run failed/interrupted, delivery gate closed/invalidated, or final blocked/unavailable",
  "merged: verified final delivery, or verified child integration (integration is not parent delivery)",
  "approval: awaiting publication, operator review, manual merge, or child integration ready",
  "working: active run, final verification, integration in progress, or correction required",
  "ready: admitted and dispatchable work with dependency blockers shown inline",
  "triage: held, revoked or unplanned work awaiting planning",
];

export const BOARD_LANE_ORDER: readonly OperatorBoardLaneId[] = [
  "triage",
  "ready",
  "working",
  "approval",
  "needs-owner",
  "parked",
  "merged",
  "failed",
];

const ACTIVE_RUN_STATES: readonly DispatchRunState[] = [
  "claimed",
  "dispatched",
  "running",
  "interrupted",
];

export interface OperatorBoardServiceOptions {
  projects: ProjectRegistryService;
  work: WorkService;
  plans: PlanService;
  dispatch: DispatchService;
  observations: ExecutionObservationService;
  publication: PublicationService;
  integration: ChildIntegrationService;
  gate: DeliveryGateService;
  final: FinalDeliveryService;
  intake?: IntakeService;
  drafts?: DraftService;
}

interface PlanMembership {
  plan: PlanRecord;
  member: PlanMember;
}

interface Snapshot {
  project: Project;
  plans: PlanRecord[];
  work: WorkRecord[];
  workById: Map<string, WorkRecord>;
  runs: PlanDispatchRun[];
  runsByWork: Map<string, PlanDispatchRun[]>;
  latestRunByWork: Map<string, PlanDispatchRun>;
  runDetailByRun: Map<string, DispatchRunDetail>;
  integrationByRun: Map<string, IntegrationStatus>;
  finalByPlan: Map<string, FinalDeliveryStatus>;
  gateByRun: Map<string, DeliveryGateStatus>;
  publicationByRun: Map<string, PublicationStatus>;
  membershipByWork: Map<string, PlanMembership>;
  satisfiedWorkIds: Set<string>;
  activeWorkIds: Set<string>;
}

interface PlacementFacts {
  kind: OperatorCardKind;
  role: PlanMemberRole | null;
  planAuthority: PlanAuthority | null;
  planned: boolean;
  dispatchable: boolean;
  gateProfile: PlanGateProfile | null;
  latestRunState: DispatchRunState | null;
  latestRunError: string | null;
  budgetStatus: "active" | "exhausted" | null;
  controlStatus: ExecutionControlStatus | null;
  integrationState: IntegrationState | null;
  gateState: DeliveryGateState | null;
  gateVerified: boolean;
  finalState: FinalDeliveryState | null;
  finalDelivered: boolean;
  finalHaltReason: string | null;
  publicationPresent: boolean;
  publicationAuditComplete: boolean;
  dependencyBlocked: number[];
  integrationBranch: string | null;
  deliveryBranch: string | null;
  childrenActive: boolean;
  specProgress: OperatorSpecProgress | null;
}

interface Placement {
  lane: OperatorBoardLaneId;
  stageLabel: string;
  detail: string;
  precedence: string[];
}

interface CardSeed {
  workId: string;
  issueNumber: number;
  title: string;
  kind: OperatorCardKind;
  workUpdatedAt: number;
  role: PlanMemberRole | null;
  plan: PlanRecord | null;
  member: PlanMember | null;
  parent: OperatorBoardParent | null;
  latestRun: PlanDispatchRun | null;
  detail: DispatchRunDetail | null;
  integration: IntegrationStatus | null;
  final: FinalDeliveryStatus | null;
  gate: DeliveryGateStatus | null;
  publication: PublicationStatus | null;
  dependencyBlocked: number[];
  childrenActive: boolean;
  specProgress: OperatorSpecProgress | null;
}

function unavailableUsage(
  detail = "Token and cost records are not stored for local plan dispatches.",
): OperatorWorkerUsage {
  return {
    available: false,
    tokensIn: null,
    tokensOut: null,
    cacheReadTokens: null,
    costMicros: null,
    detail,
  };
}

function boardError(error: unknown): BoardError {
  if (error instanceof BoardError) return error;
  return new BoardError(
    "board_storage_failed",
    error instanceof Error ? error.message : String(error),
  );
}

function sortRunsDesc(runs: PlanDispatchRun[]): PlanDispatchRun[] {
  return [...runs].sort(
    (left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id),
  );
}

function isActiveState(state: DispatchRunState): boolean {
  return ACTIVE_RUN_STATES.includes(state);
}

function parentOf(plan: PlanRecord | null, member: PlanMember | null): OperatorBoardParent | null {
  if (!plan || plan.kind !== "spec" || !member || member.role !== "ticket") return null;
  const root = plan.members.find((candidate) => candidate.role === "spec");
  if (!root) return null;
  return {
    workId: root.work_id,
    issueNumber: root.issue_number,
    title: root.title,
  };
}

function specProgressOf(final: FinalDeliveryStatus | null): OperatorSpecProgress | null {
  if (!final) return null;
  return {
    integrated: final.integratedCount,
    required: final.requiredCount,
    delivered: final.delivered || final.state === "delivered",
    finalState: final.state,
  };
}

function blockedDependencies(
  plan: PlanRecord | null,
  workId: string,
  satisfied: Set<string>,
): number[] {
  if (!plan) return [];
  const workByIssue = new Map(plan.members.map((member) => [member.issue_number, member.work_id]));
  return plan.dependencies
    .filter((dependency) => dependency.work_id === workId)
    .filter((dependency) => {
      if (dependency.target_role !== "internal") return false;
      const targetWorkId =
        dependency.target_work_id ?? workByIssue.get(dependency.target_issue_number) ?? null;
      return targetWorkId !== null && !satisfied.has(targetWorkId);
    })
    .map((dependency) => dependency.target_issue_number);
}

function controlStage(status: ExecutionControlStatus): string {
  switch (status) {
    case "held":
      return "Held";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    default:
      return "Active";
  }
}

function describeDependencies(issueNumbers: number[]): string {
  return `Blocked by ${issueNumbers.map((number) => `#${number}`).join(", ")}`;
}

/**
 * Derive lane placement from canonical facts. Placement is a projection: the
 * board never stores manual column truth.
 */
export function deriveBoardPlacement(facts: PlacementFacts): Placement {
  return derivePlacement(facts);
}

function derivePlacement(facts: PlacementFacts): Placement {
  const finish = (placement: Placement): Placement => placement;
  if (facts.budgetStatus === "exhausted") {
    return finish({
      lane: "needs-owner",
      stageLabel: "Needs owner",
      detail: "Attempt budget exhausted; grant an explicit additional attempt to continue.",
      precedence: ["budget_exhausted"],
    });
  }
  if (facts.kind === "spec" && facts.finalState === "needs_owner") {
    return finish({
      lane: "needs-owner",
      stageLabel: "Needs owner",
      detail: facts.finalHaltReason ?? "Final delivery escalated to the operator.",
      precedence: ["final_needs_owner"],
    });
  }
  if (facts.controlStatus !== null && facts.controlStatus !== "active") {
    return finish({
      lane: "parked",
      stageLabel: controlStage(facts.controlStatus),
      detail:
        facts.controlStatus === "stopping"
          ? "Stop requested; the worker is not shown as stopped until termination is reconciled."
          : `Operator control: ${facts.controlStatus}.`,
      precedence: [`control_${facts.controlStatus}`],
    });
  }
  if (facts.latestRunState === "failed") {
    return finish({
      lane: "failed",
      stageLabel: "Failed",
      detail: facts.latestRunError ?? "The last builder run failed.",
      precedence: ["run_failed"],
    });
  }
  if (facts.latestRunState === "interrupted") {
    return finish({
      lane: "failed",
      stageLabel: "Interrupted",
      detail: facts.latestRunError ?? "The last builder run was interrupted.",
      precedence: ["run_interrupted"],
    });
  }
  if (
    facts.kind === "spec" &&
    (facts.finalState === "blocked" || facts.finalState === "remote_unavailable")
  ) {
    return finish({
      lane: "failed",
      stageLabel: facts.finalState === "blocked" ? "Final blocked" : "Remote unavailable",
      detail:
        facts.finalState === "blocked"
          ? "Final acceptance is blocked; review the retained reasons."
          : "The remote delivery branch is unreadable; delivery is unconfirmed.",
      precedence: [`final_${facts.finalState}`],
    });
  }
  if (facts.gateState === "closed_unmerged" || facts.gateState === "invalidated") {
    return finish({
      lane: "failed",
      stageLabel: facts.gateState === "closed_unmerged" ? "Closed unmerged" : "Evidence stale",
      detail:
        facts.gateState === "closed_unmerged"
          ? "The pull request closed without a merge."
          : "Candidate evidence is stale; re-run the applicable checks before merging.",
      precedence: [`gate_${facts.gateState}`],
    });
  }
  if (facts.gateState === "remote_unavailable") {
    return finish({
      lane: "failed",
      stageLabel: "Remote unavailable",
      detail: "The remote pull request is unreadable; delivery is unconfirmed.",
      precedence: ["gate_remote_unavailable"],
    });
  }
  if (facts.kind === "spec" && facts.finalDelivered) {
    return finish({
      lane: "merged",
      stageLabel: "Delivered",
      detail: `Delivered to ${facts.deliveryBranch ?? "the delivery branch"}.`,
      precedence: ["final_delivered"],
    });
  }
  if (
    facts.kind === "ticket" &&
    facts.gateProfile === "standalone" &&
    (facts.gateState === "delivered" || facts.gateVerified)
  ) {
    return finish({
      lane: "merged",
      stageLabel: "Delivered",
      detail: `Delivered to ${facts.deliveryBranch ?? "the delivery branch"}.`,
      precedence: ["standalone_delivered"],
    });
  }
  if (
    facts.kind === "ticket" &&
    facts.gateProfile === "child" &&
    facts.integrationState === "integrated"
  ) {
    return finish({
      lane: "merged",
      stageLabel: "Integrated",
      detail: `Integrated to ${facts.integrationBranch ?? "the integration branch"}; parent delivery is separate.`,
      precedence: ["child_integrated"],
    });
  }
  if (
    facts.kind === "spec" &&
    (facts.finalState === "awaiting_manual_merge" ||
      facts.finalState === "awaiting_merge_verification")
  ) {
    return finish({
      lane: "approval",
      stageLabel:
        facts.finalState === "awaiting_manual_merge"
          ? "Awaiting manual merge"
          : "Awaiting merge verification",
      detail: "The final PR requires an operator merge; delivery is not complete.",
      precedence: [`final_${facts.finalState}`],
    });
  }
  if (facts.gateState === "ready_for_operator_review") {
    return finish({
      lane: "approval",
      stageLabel: "Ready for review",
      detail: "Full delivery gates passed; the operator merge remains manual.",
      precedence: ["gate_ready_for_operator_review"],
    });
  }
  if (
    facts.gateState === "awaiting_manual_merge" ||
    facts.gateState === "awaiting_merge_verification"
  ) {
    return finish({
      lane: "approval",
      stageLabel:
        facts.gateState === "awaiting_manual_merge"
          ? "Awaiting manual merge"
          : "Awaiting merge verification",
      detail: "The pull request requires an operator merge; delivery is not complete.",
      precedence: [`gate_${facts.gateState}`],
    });
  }
  if (facts.gateState === "awaiting_publication") {
    return finish({
      lane: "approval",
      stageLabel: "Awaiting publication",
      detail: "The required publication audit is incomplete.",
      precedence: ["gate_awaiting_publication"],
    });
  }
  if (facts.integrationState === "ready") {
    return finish({
      lane: "approval",
      stageLabel: "Ready to integrate",
      detail: "The child candidate passed its gates and is ready for integration.",
      precedence: ["integration_ready"],
    });
  }
  if (facts.publicationPresent && !facts.publicationAuditComplete) {
    return finish({
      lane: "approval",
      stageLabel: "Awaiting publication",
      detail: "Candidate results are not fully published to the ticket PR.",
      precedence: ["publication_incomplete"],
    });
  }
  if (facts.kind === "spec" && facts.finalState === "verifying") {
    return finish({
      lane: "working",
      stageLabel: "Final verification",
      detail: "Final acceptance, regression and review are running on the combined candidate.",
      precedence: ["final_verifying"],
    });
  }
  if (
    facts.latestRunState === "claimed" ||
    facts.latestRunState === "dispatched" ||
    facts.latestRunState === "running"
  ) {
    return finish({
      lane: "working",
      stageLabel: "Running",
      detail: `Builder run is ${facts.latestRunState}.`,
      precedence: [`run_${facts.latestRunState}`],
    });
  }
  if (facts.integrationState === "integrating") {
    return finish({
      lane: "working",
      stageLabel: "Integrating",
      detail: "The verified child candidate is being merged into the integration branch.",
      precedence: ["integration_integrating"],
    });
  }
  if (facts.gateState === "correction_required") {
    return finish({
      lane: "working",
      stageLabel: "Correction required",
      detail: "A failed stage returned actionable findings to the builder.",
      precedence: ["gate_correction_required"],
    });
  }
  if (facts.integrationState === "blocked") {
    return finish({
      lane: "working",
      stageLabel: "Correction required",
      detail: "Integration is blocked; resolve the listed acceptance findings.",
      precedence: ["integration_blocked"],
    });
  }
  if (facts.kind === "spec" && facts.finalState === "waiting_children" && facts.childrenActive) {
    return finish({
      lane: "working",
      stageLabel: "Integrating children",
      detail: "Required child tickets are still running.",
      precedence: ["children_active"],
    });
  }
  if (facts.integrationState === "not_ready" && facts.latestRunState === "succeeded") {
    return finish({
      lane: "working",
      stageLabel: "Checks pending",
      detail: "The builder finished; technical checks and review are not recorded yet.",
      precedence: ["integration_not_ready"],
    });
  }
  if (facts.gateState === "blocked" && facts.latestRunState === "succeeded") {
    return finish({
      lane: "working",
      stageLabel: "Checks pending",
      detail: "Full-delivery checks are incomplete for the succeeded candidate.",
      precedence: ["gate_blocked"],
    });
  }
  if (facts.integrationState === "unknown") {
    return finish({
      lane: "working",
      stageLabel: "Integration unknown",
      detail: "Integration state is unknown; reconcile before merging.",
      precedence: ["integration_unknown"],
    });
  }
  if (facts.planAuthority === "admitted" && facts.dispatchable) {
    if (facts.kind === "spec" && facts.finalState === "waiting_children") {
      return finish({
        lane: "ready",
        stageLabel: "Waiting for children",
        detail: "Final acceptance starts after every required child is integrated.",
        precedence: ["children_pending"],
      });
    }
    if (facts.dependencyBlocked.length > 0) {
      return finish({
        lane: "ready",
        stageLabel: "Blocked by dependency",
        detail: describeDependencies(facts.dependencyBlocked),
        precedence: ["dependency_blocked"],
      });
    }
    if (facts.kind === "spec") {
      return finish({
        lane: "ready",
        stageLabel: "Spec",
        detail: "Planning record; parent specs are never dispatched as executable tickets.",
        precedence: ["spec_ready"],
      });
    }
    return finish({
      lane: "ready",
      stageLabel: "Ready",
      detail: "Admitted and eligible for dispatch.",
      precedence: ["admitted_ready"],
    });
  }
  if (facts.planAuthority === "revoked") {
    return finish({
      lane: "triage",
      stageLabel: "Revoked",
      detail: "Authorization was revoked; the work cannot dispatch.",
      precedence: ["authority_revoked"],
    });
  }
  if (facts.planAuthority === "held") {
    return finish({
      lane: "triage",
      stageLabel: "Needs triage",
      detail: "The plan is held; resolve holds before dispatch.",
      precedence: ["authority_held"],
    });
  }
  if (!facts.planned) {
    return finish({
      lane: "triage",
      stageLabel: "Needs triage",
      detail: "Imported work is not part of an approved plan.",
      precedence: ["unplanned"],
    });
  }
  return finish({
    lane: "triage",
    stageLabel: "Needs triage",
    detail: "Awaiting an approved plan.",
    precedence: ["awaiting_plan"],
  });
}

export class OperatorBoardService {
  constructor(private readonly options: OperatorBoardServiceOptions) {}

  async getBoard(projectId: string): Promise<OperatorBoard> {
    try {
      const snapshot = await this.snapshot(projectId);
      const seeds = this.seeds(snapshot);
      const cards = seeds.map((seed) => this.card(snapshot, seed));
      cards.sort(
        (left, right) => left.issueNumber - right.issueNumber || left.id.localeCompare(right.id),
      );
      const lanes: OperatorBoardLane[] = BOARD_LANE_ORDER.map((id) => {
        const laneCards = cards.filter((card) => card.lane === id);
        return { id, count: laneCards.length, cards: laneCards };
      });
      const workers = this.activeWorkerCount(snapshot);
      let capacity = 1;
      try {
        capacity = loadScheduleConfig(snapshot.project.checkout_path).parallel ?? 1;
      } catch {
        capacity = 1;
      }
      return operatorBoardSchema.parse({
        projectId: snapshot.project.id,
        repository: snapshot.project.repo_name,
        generatedAt: Date.now(),
        precedence: [...BOARD_PRECEDENCE],
        counts: {
          specs: cards.filter((card) => card.kind === "spec").length,
          tickets: cards.filter((card) => card.kind === "ticket").length,
          unplanned: cards.filter((card) => card.kind === "unplanned").length,
          workers,
          capacity: Math.max(1, capacity),
        },
        lanes,
        usage: unavailableUsage(),
      });
    } catch (error) {
      throw boardError(error);
    }
  }

  async getWorkDetail(projectId: string, workId: string): Promise<OperatorWorkDetail> {
    try {
      const snapshot = await this.snapshot(projectId);
      const seed = this.seeds(snapshot).find((candidate) => candidate.workId === workId);
      const work = snapshot.workById.get(workId);
      if (!seed || !work) {
        throw new BoardError("board_work_not_found", `Work ${workId} not found`);
      }
      const card = this.card(snapshot, seed);
      const runs = snapshot.runsByWork.get(workId) ?? [];
      const latestRun = snapshot.latestRunByWork.get(workId) ?? null;
      const latestDetail = latestRun ? (snapshot.runDetailByRun.get(latestRun.id) ?? null) : null;
      const evidence = this.evidence(projectId, latestRun);
      const retained = this.retained(seed, latestRun, latestDetail);
      const draft = this.options.drafts?.getByWork(projectId, workId) ?? null;
      const { executionSteps, realtimeLogs } = this.buildExecutionStepsAndLogs(
        work,
        draft,
        seed.plan,
        runs,
        latestDetail,
        evidence,
        card.lane,
        seed.integration,
        seed.final,
      );
      return operatorWorkDetailSchema.parse({
        projectId,
        generatedAt: Date.now(),
        work,
        kind: seed.kind,
        lane: card.lane,
        stageLabel: card.stageLabel,
        detail: card.detail,
        precedence: card.precedence,
        role: seed.role,
        planId: seed.plan?.id ?? null,
        planKind: seed.plan?.kind ?? null,
        parent: seed.parent,
        specProgress: seed.specProgress,
        contract: {
          title: work.revision.source.title,
          body: work.revision.source.body,
          labels: work.revision.source.labels,
          state: work.revision.source.state,
          revisionNumber: work.revision.revision_number,
          contentHash: work.revision.content_hash,
          sourceUrl: work.revision.provenance.source_url,
        },
        plan: seed.plan,
        draft,
        final: seed.final,
        runs,
        latestRun: latestDetail,
        evidence,
        integration: seed.integration,
        gate: seed.gate,
        publication: seed.publication,
        retained,
        process: latestDetail?.process ?? null,
        usage: unavailableUsage(),
        executionSteps,
        realtimeLogs,
      });
    } catch (error) {
      throw boardError(error);
    }
  }

  private buildExecutionStepsAndLogs(
    work: WorkRecord,
    draft: DraftRecord | null,
    plan: PlanRecord | null,
    runs: PlanDispatchRun[],
    latestDetail: DispatchRunDetail | null,
    evidence: RunEvidenceReport | null,
    lane: string,
    integration: IntegrationStatus | null,
    final: FinalDeliveryStatus | null,
  ): {
    executionSteps: OperatorExecutionStep[];
    realtimeLogs: OperatorRealtimeLogLine[];
  } {
    const formatLogTime = (ts: number): string => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    };

    const steps: OperatorExecutionStep[] = [];

    // 1. Created
    steps.push({
      id: "step-created",
      label: "Created",
      status: "completed",
      time: formatLogTime(work.created_at),
      logs: [
        {
          timestamp: formatLogTime(work.created_at),
          event: "created",
          message: `Issue imported as #${work.issue_number ?? work.id}: ${work.revision.source.title}`,
        },
      ],
    });

    // 2. Triage
    if (draft) {
      const isTriageActive =
        !plan && (draft.status === "needs_clarification" || draft.status === "needs_review");
      const triageLogs: OperatorWorkLogEntry[] = [
        {
          timestamp: formatLogTime(draft.created_at),
          event: "triage",
          message: `Draft created in state '${draft.status}'`,
        },
      ];
      if (draft.latest_revision?.planner_metadata) {
        triageLogs.push({
          timestamp: formatLogTime(draft.latest_revision.created_at),
          event: "planner",
          message: `Planner (${draft.latest_revision.planner_metadata.model ?? "default"}): ${draft.latest_revision.planner_metadata.prompt.slice(0, 90)}`,
        });
      }
      if (draft.latest_decision) {
        triageLogs.push({
          timestamp: formatLogTime(draft.latest_decision.decided_at),
          event: "decision",
          message: `Decision '${draft.latest_decision.decision}' by ${draft.latest_decision.actor ?? "operator"}${draft.latest_decision.reason ? `: ${draft.latest_decision.reason}` : ""}`,
        });
      }
      steps.push({
        id: "step-triage",
        label: "Triage",
        status: isTriageActive ? "active" : "completed",
        time: formatLogTime(draft.updated_at),
        logs: triageLogs,
      });
    } else {
      steps.push({
        id: "step-triage",
        label: "Triage",
        status: plan || runs.length > 0 || lane !== "triage" ? "completed" : "active",
        time: formatLogTime(work.updated_at),
        logs: [
          {
            timestamp: formatLogTime(work.updated_at),
            event: "triage",
            message: "Triage evaluation completed",
          },
        ],
      });
    }

    // 3. Ready
    const isReadyCompleted =
      runs.length > 0 || lane === "working" || lane === "approval" || lane === "merged";
    const isReadyActive = lane === "ready";
    steps.push({
      id: "step-ready",
      label: "Ready",
      status: isReadyCompleted ? "completed" : isReadyActive ? "active" : "pending",
      time: plan ? formatLogTime(plan.created_at) : undefined,
      logs: plan
        ? [
            {
              timestamp: formatLogTime(plan.created_at),
              event: "admitted",
              message: `Plan admitted with ${plan.acceptance_criteria.length} acceptance criteria into ${plan.delivery_branch}`,
            },
          ]
        : [],
    });

    // 4. Implement & Verification laps
    if (runs.length > 0) {
      const sortedRuns = [...runs].sort((a, b) => a.lap - b.lap);
      for (const run of sortedRuns) {
        const isRunActive = run.state === "running";
        const runStatus = isRunActive
          ? "active"
          : run.state === "succeeded"
            ? "completed"
            : run.state === "failed"
              ? "failed"
              : "completed";
        const runLogs: OperatorWorkLogEntry[] = [];
        if (run.launched_at) {
          runLogs.push({
            timestamp: formatLogTime(run.launched_at),
            event: "dispatch",
            message: `Dispatched lap ${run.lap} on branch ${run.branch}`,
          });
        }
        if (latestDetail?.attempts) {
          const attempts = latestDetail.attempts.filter((a) => a.lap === run.lap);
          for (const attempt of attempts) {
            if (attempt.headSha) {
              runLogs.push({
                timestamp: formatLogTime(attempt.createdAt),
                event: "candidate",
                message: `Candidate commit: ${attempt.headSha.slice(0, 7)}`,
              });
            }
            if (attempt.finishedAt) {
              runLogs.push({
                timestamp: formatLogTime(attempt.finishedAt),
                event: "attempt",
                message: `Attempt ${attempt.state}${attempt.error ? `: ${attempt.error}` : ""}`,
              });
            }
          }
        }
        if (run.finished_at) {
          runLogs.push({
            timestamp: formatLogTime(run.finished_at),
            event: "finish",
            message: `Run lap ${run.lap} finished (${run.state})${run.error ? `: ${run.error}` : ""}`,
          });
        }

        steps.push({
          id: `step-implement-lap-${run.lap}`,
          label: `Implement · lap ${run.lap}`,
          status: runStatus,
          time: run.launched_at ? formatLogTime(run.launched_at) : undefined,
          duration:
            run.launched_at && run.finished_at
              ? `${Math.max(1, Math.round((run.finished_at - run.launched_at) / 1000))}s`
              : undefined,
          meta: isRunActive ? "running" : run.state,
          logs: runLogs,
        });

        // Verification for this lap
        const obs = evidence?.observations?.find((o) => o.runId === run.id || o.lap === run.lap);
        const verifyLogs: OperatorWorkLogEntry[] = [];
        if (obs) {
          for (const check of obs.checks) {
            verifyLogs.push({
              timestamp: formatLogTime(check.createdAt),
              event: check.result === "PASS" ? "PASS" : "FAIL",
              message: `${check.name}${check.command ? ` ($ ${check.command})` : ""}: ${check.detail || check.result}`,
            });
          }
        }
        const verifyStatus = obs
          ? obs.checks.every((c) => c.result === "PASS")
            ? "completed"
            : "failed"
          : isRunActive
            ? "pending"
            : lane === "working"
              ? "active"
              : "pending";

        steps.push({
          id: `step-verification-lap-${run.lap}`,
          label: `Verification · lap ${run.lap}`,
          status: verifyStatus,
          time: obs ? formatLogTime(obs.createdAt) : undefined,
          meta: obs
            ? `${obs.checks.filter((c) => c.result === "PASS").length}/${obs.checks.length} passed`
            : undefined,
          logs: verifyLogs,
        });
      }
    } else if (lane === "working") {
      steps.push({
        id: "step-implement-lap-1",
        label: "Implement · lap 1",
        status: "active",
        meta: "running",
        logs: [
          {
            timestamp: formatLogTime(Date.now()),
            event: "running",
            message: "Worker dispatch in progress",
          },
        ],
      });
    }

    if (integration?.state === "integrated") {
      steps.push({
        id: "step-integrated",
        label: `Integrated · ${integration.targetBranch}`,
        status: "completed",
        time: formatLogTime(Date.now()),
        logs: [
          {
            timestamp: formatLogTime(Date.now()),
            event: "integrated",
            message: `Child sub-ticket integrated into ${integration.targetBranch}`,
          },
        ],
      });
    }

    if (lane === "merged") {
      steps.push({
        id: "step-merged",
        label: "Merged",
        status: "completed",
        time: final?.updatedAt ? formatLogTime(final.updatedAt) : undefined,
        logs: [
          {
            timestamp: formatLogTime(final?.updatedAt ?? Date.now()),
            event: "merged",
            message: "Delivery target merge verified",
          },
        ],
      });
    } else if (lane === "needs-owner") {
      steps.push({
        id: "step-needs-owner",
        label: "Needs owner",
        status: "failed",
        logs: [
          {
            timestamp: formatLogTime(Date.now()),
            event: "escalated",
            message: "Attention required: lap limit or blocker escalated to owner",
          },
        ],
      });
    } else if (lane === "failed") {
      steps.push({
        id: "step-failed",
        label: "Failed",
        status: "failed",
        logs: [
          {
            timestamp: formatLogTime(Date.now()),
            event: "failed",
            message: "Work item terminated with failure",
          },
        ],
      });
    }

    const allLogs: OperatorRealtimeLogLine[] = [];
    let logSeq = 1;
    for (const step of steps) {
      for (const log of step.logs) {
        allLogs.push({
          id: `log-${logSeq++}`,
          timestamp: log.timestamp,
          event: log.event,
          message: log.message,
          stepId: step.id,
        });
      }
    }

    allLogs.reverse();
    const realtimeLogs = allLogs.slice(0, 100);

    return { executionSteps: steps, realtimeLogs };
  }

  private async snapshot(projectId: string): Promise<Snapshot> {
    let project: Project;
    try {
      project = this.options.projects.getProject(projectId);
    } catch {
      throw new BoardError("board_project_not_found", `Project ${projectId} not found`);
    }
    const planSummaries = this.options.plans.listPlans(projectId);
    const plans: PlanRecord[] = [];
    for (const summary of planSummaries) {
      try {
        plans.push(this.options.plans.getPlan(projectId, summary.id));
      } catch {
        // A plan that cannot be read is not presented as board truth.
      }
    }
    plans.sort((left, right) => {
      const leftAdmitted = left.authority === "admitted" ? 0 : 1;
      const rightAdmitted = right.authority === "admitted" ? 0 : 1;
      return leftAdmitted - rightAdmitted || left.created_at - right.created_at;
    });

    let work = this.options.work.listWork(projectId);
    if (this.options.intake && work.length === 0) {
      try {
        await this.options.intake.evaluateProjectBacklog(projectId);
        work = this.options.work.listWork(projectId);
      } catch {
        // Fall back to existing work
      }
    }
    const workById = new Map(work.map((record) => [record.id, record]));

    const runs = sortRunsDesc(this.options.dispatch.listRuns(projectId));
    const runsByWork = new Map<string, PlanDispatchRun[]>();
    const latestRunByWork = new Map<string, PlanDispatchRun>();
    for (const run of runs) {
      const list = runsByWork.get(run.work_id) ?? [];
      list.push(run);
      runsByWork.set(run.work_id, list);
      if (!latestRunByWork.has(run.work_id)) latestRunByWork.set(run.work_id, run);
    }

    const runDetailByRun = new Map<string, DispatchRunDetail>();
    for (const run of runs) {
      try {
        runDetailByRun.set(run.id, this.options.dispatch.getRunDetail(projectId, run.id));
      } catch {
        // Detail is optional for placement; a missing detail never invents state.
      }
    }

    const integrationByRun = new Map<string, IntegrationStatus>();
    let integrationStatuses: IntegrationStatus[] = [];
    try {
      integrationStatuses = this.options.integration.listStatuses(projectId);
    } catch {
      integrationStatuses = [];
    }
    for (const status of integrationStatuses) integrationByRun.set(status.runId, status);

    const finalByPlan = new Map<string, FinalDeliveryStatus>();
    for (const plan of plans) {
      if (plan.kind !== "spec") continue;
      try {
        finalByPlan.set(plan.id, await this.options.final.getStatus(projectId, plan.id));
      } catch {
        // Final coordination state is absent until a delivery exists; the plan
        // still appears with its admitted children.
      }
    }

    const gateByRun = new Map<string, DeliveryGateStatus>();
    for (const [workId, run] of latestRunByWork) {
      if (run.gate_profile === "child") continue;
      try {
        gateByRun.set(run.id, await this.options.gate.getGate(projectId, run.id));
      } catch {
        // A gate that cannot be evaluated stays unknown rather than successful.
      }
      void workId;
    }

    const publicationByRun = new Map<string, PublicationStatus>();
    for (const status of integrationStatuses) {
      if (status.publication) publicationByRun.set(status.runId, status.publication);
    }
    for (const [runId, gate] of gateByRun) {
      if (gate.publication.targetId) {
        try {
          publicationByRun.set(runId, this.options.publication.getStatusByRun(projectId, runId));
        } catch {
          // Publication audit is unavailable; not treated as complete.
        }
      }
    }

    const membershipByWork = new Map<string, PlanMembership>();
    for (const plan of plans) {
      for (const member of plan.members) {
        if (!membershipByWork.has(member.work_id)) {
          membershipByWork.set(member.work_id, { plan, member });
        }
      }
    }

    const satisfiedWorkIds = new Set<string>();
    for (const status of integrationStatuses) {
      if (status.state === "integrated") satisfiedWorkIds.add(status.workId);
    }
    for (const final of finalByPlan.values()) {
      if (final.delivered || final.state === "delivered") {
        for (const child of final.children) {
          if (child.integrated) satisfiedWorkIds.add(child.workId);
        }
      }
    }

    const activeWorkIds = new Set<string>();
    for (const [workId, run] of latestRunByWork) {
      if (isActiveState(run.state)) activeWorkIds.add(workId);
    }

    return {
      project,
      plans,
      work,
      workById,
      runs,
      runsByWork,
      latestRunByWork,
      runDetailByRun,
      integrationByRun,
      finalByPlan,
      gateByRun,
      publicationByRun,
      membershipByWork,
      satisfiedWorkIds,
      activeWorkIds,
    };
  }

  private seeds(snapshot: Snapshot): CardSeed[] {
    const seeds: CardSeed[] = [];
    for (const record of snapshot.work) {
      const membership = snapshot.membershipByWork.get(record.id);
      const plan = membership?.plan ?? null;
      const member = membership?.member ?? null;
      const kind: OperatorCardKind = membership
        ? member!.role === "spec"
          ? "spec"
          : "ticket"
        : "unplanned";
      const latestRun = snapshot.latestRunByWork.get(record.id) ?? null;
      const detail = latestRun ? (snapshot.runDetailByRun.get(latestRun.id) ?? null) : null;
      const integration =
        latestRun?.gate_profile === "child"
          ? (snapshot.integrationByRun.get(latestRun.id) ?? null)
          : null;
      const isSpecParent = plan?.kind === "spec" && member?.role === "spec";
      const final = isSpecParent ? (snapshot.finalByPlan.get(plan!.id) ?? null) : null;
      const gate =
        latestRun && latestRun.gate_profile !== "child"
          ? (snapshot.gateByRun.get(latestRun.id) ?? null)
          : null;
      const publication =
        (latestRun ? snapshot.publicationByRun.get(latestRun.id) : undefined) ??
        integration?.publication ??
        null;
      const childrenActive = Boolean(
        plan?.kind === "spec" &&
        plan.members.some(
          (candidate) =>
            candidate.role === "ticket" && snapshot.activeWorkIds.has(candidate.work_id),
        ),
      );
      seeds.push({
        workId: record.id,
        issueNumber: record.issue_number,
        title: record.revision.source.title,
        kind,
        workUpdatedAt: record.updated_at,
        role: member?.role ?? null,
        plan,
        member,
        parent: parentOf(plan, member),
        latestRun,
        detail,
        integration,
        final,
        gate,
        publication,
        dependencyBlocked: blockedDependencies(plan, record.id, snapshot.satisfiedWorkIds),
        childrenActive,
        specProgress: isSpecParent ? specProgressOf(final) : null,
      });
    }
    return seeds;
  }

  private card(snapshot: Snapshot, seed: CardSeed): OperatorBoardCard {
    const detail = seed.detail;
    const process = detail?.process ?? null;
    const placement = deriveBoardPlacement({
      kind: seed.kind,
      role: seed.role,
      planAuthority: seed.plan?.authority ?? null,
      planned: seed.plan !== null,
      dispatchable: seed.plan?.dispatchable ?? false,
      gateProfile: seed.member?.gate_profile ?? null,
      latestRunState: seed.latestRun?.state ?? null,
      latestRunError: seed.latestRun?.error ?? null,
      budgetStatus: detail?.budget?.status ?? null,
      controlStatus: detail?.control?.status ?? null,
      integrationState: seed.integration?.state ?? null,
      gateState: seed.gate?.state ?? null,
      gateVerified: seed.gate?.merge.verified ?? false,
      finalState: seed.final?.state ?? null,
      finalDelivered: Boolean(seed.final?.delivered || seed.final?.state === "delivered"),
      finalHaltReason: seed.final?.haltReason ?? null,
      publicationPresent: seed.publication !== null,
      publicationAuditComplete: seed.publication?.auditComplete ?? false,
      dependencyBlocked: seed.dependencyBlocked,
      integrationBranch: seed.final?.integrationBranch ?? seed.plan?.integration_branch ?? null,
      deliveryBranch: seed.final?.deliveryBranch ?? seed.plan?.delivery_branch ?? null,
      childrenActive: seed.childrenActive,
      specProgress: seed.specProgress,
    });
    const pullRequest = this.pullRequest(seed);
    return {
      id: seed.workId,
      kind: seed.kind,
      lane: placement.lane,
      workId: seed.workId,
      issueNumber: seed.issueNumber,
      title: seed.title,
      ref: `#${seed.issueNumber}`,
      updatedAt: Math.max(
        seed.latestRun?.updated_at ?? 0,
        seed.final?.updatedAt ?? 0,
        seed.workUpdatedAt,
      ),
      role: seed.role,
      gateProfile: seed.member?.gate_profile ?? null,
      planId: seed.plan?.id ?? null,
      planKind: seed.plan?.kind ?? null,
      parent: seed.parent,
      stageLabel: placement.stageLabel,
      detail: placement.detail,
      precedence: placement.precedence,
      specProgress: seed.specProgress,
      latestRun: seed.latestRun
        ? {
            id: seed.latestRun.id,
            lap: seed.latestRun.lap,
            state: seed.latestRun.state,
            headSha: seed.latestRun.head_sha,
            error: seed.latestRun.error,
          }
        : null,
      budgetStatus: detail?.budget?.status ?? null,
      controlStatus: detail?.control?.status ?? null,
      integrationState: seed.integration?.state ?? null,
      gateState: seed.gate?.state ?? null,
      finalState: seed.final?.state ?? null,
      pullRequest,
      process: process ? this.process(process) : null,
      usage: unavailableUsage(),
    };
  }

  private pullRequest(seed: CardSeed): OperatorBoardCard["pullRequest"] {
    const fromFinal = seed.final?.pullRequest;
    if (fromFinal) {
      return {
        number: fromFinal.number,
        url: fromFinal.url,
        state: fromFinal.state,
        draft: fromFinal.draft,
      };
    }
    const active = seed.publication?.pullRequests.find((candidate) => candidate.active);
    if (active && active.number !== null) {
      return {
        number: active.number,
        url: active.url,
        state: active.state === "superseded" ? "superseded" : active.state,
        draft: active.draft,
      };
    }
    const integration = seed.integration?.integration;
    if (integration?.remotePullRequestNumber) {
      return {
        number: integration.remotePullRequestNumber,
        url: integration.remotePullRequestUrl,
        state: "merged",
        draft: false,
      };
    }
    return null;
  }

  private process(process: NonNullable<DispatchRunDetail["process"]>): OperatorBoardProcess {
    return {
      ownerPid: process.ownerPid,
      ownerAlive: process.ownerAlive,
      workerPid: process.workerPid,
      workerAlive: process.workerAlive,
      worktreeLockPid: process.worktreeLockPid,
      worktreeLockAlive: process.worktreeLockAlive,
    };
  }

  private evidence(projectId: string, run: PlanDispatchRun | null): RunEvidenceReport | null {
    if (!run) return null;
    try {
      return this.options.observations.getRunEvidence(projectId, run.id);
    } catch {
      return null;
    }
  }

  private retained(
    seed: CardSeed,
    latestRun: PlanDispatchRun | null,
    detail: DispatchRunDetail | null,
  ): OperatorWorkDetail["retained"] {
    const budget = detail?.budget;
    if (budget?.retainedWorktreePath && budget.retainedBranch) {
      return {
        worktreePath: budget.retainedWorktreePath,
        branch: budget.retainedBranch,
        runId: budget.retainedRunId,
        headSha: budget.retainedHeadSha,
      };
    }
    if (
      latestRun &&
      (latestRun.state === "failed" ||
        latestRun.state === "interrupted" ||
        detail?.control?.status === "held" ||
        detail?.control?.status === "stopped")
    ) {
      return {
        worktreePath: latestRun.worktree_path,
        branch: latestRun.branch,
        runId: latestRun.id,
        headSha: latestRun.head_sha,
      };
    }
    void seed;
    return null;
  }

  private activeWorkerCount(snapshot: Snapshot): number {
    const workers = new Set<string>();
    for (const run of snapshot.runs) {
      if (!isActiveState(run.state)) continue;
      const detail = snapshot.runDetailByRun.get(run.id);
      if (!detail) continue;
      const process = detail.process;
      if (!process.ownerAlive && !process.workerAlive && !process.worktreeLockAlive) continue;
      workers.add(process.workerPid !== null ? `worker:${process.workerPid}` : `run:${run.id}`);
    }
    return workers.size;
  }
}

export function isOperatorBoardLaneId(value: string): value is OperatorBoardLaneId {
  return operatorBoardLaneIdSchema.safeParse(value).success;
}
