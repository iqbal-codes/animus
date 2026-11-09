import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  GATE_PROFILE_VERSION,
  type DeliveryGateState,
  type ExecutionCheckKind,
  type ExecutionObservationSubmissionInput,
  type ExecutionStage,
  type PlanDispatchRun,
  type PlanGateProfile,
  type ProducerRole,
} from "@animus/contracts/operator";
import { resolveAnimusStateDir } from "@animus/contracts/paths";
import { processRun } from "../../../../scripts/loop/process";
import { runBoundedRole } from "../../../../scripts/loop/role-runner";
import { resolveRoleBudgets } from "../../../../scripts/loop/deadlines";
import {
  resolveEffortForRole,
  resolveModelForRole,
  resolveProviderForRole,
} from "../../../../scripts/loop/config";
import { readHarnessChecks } from "../../../../scripts/loop/worktree";
import type { AgentTransport, LoopRole, RoleBudget } from "../../../../scripts/loop/types";
import type { DispatchService } from "../dispatch";
import { assertInstallationNotHeld } from "@animus/contracts/installation-hold";
import type { ExecutionObservationService } from "../evidence";
import type { ExecutionBudgetService } from "../work/budget";
import type { PublicationService } from "../publication";
import type { ChildIntegrationService } from "../integration";
import { DeliveryGateService } from "./service";
import {
  DeliveryRoleClaimService,
  type DeliveryClaimStage,
  type DeliveryRoleClaim,
} from "./claims";

export interface DeliveryRuntimeRoleRequest {
  projectId: string;
  runId: string;
  lap: number;
  gateProfile: PlanGateProfile;
  stage: "independent_review" | "final_acceptance";
  projectRoot: string;
  worktreePath: string;
  branch: string;
  candidateHeadSha: string;
  baseSha: string;
  targetBranch: string;
  contractBody: string;
  acceptanceCriteria: string[];
  findings: DeliveryRuntimeFinding[];
  runDirectory: string;
  /** Observer for the spawned bounded role process group (claim fencing). */
  onSpawn?: (pid: number) => void;
}

export interface DeliveryRuntimeFinding {
  id: string;
  severity: "blocking" | "conditional";
  acKey: string | null;
  fileContext: string;
  summary: string;
  /** Actor of the run that opened the finding; a fix must be attributed to it. */
  actor: string;
}

export interface DeliveryRuntimeCheck {
  name: string;
  command: string;
  result: "PASS" | "FAIL";
  kind: ExecutionCheckKind;
  criterionKey?: string;
  detail?: string;
}

export interface DeliveryRuntimeRoleResult {
  status: "passed" | "failed" | "inconclusive";
  summary: string;
  checks: DeliveryRuntimeCheck[];
  findings: Array<{
    severity: "blocking" | "conditional";
    acKey?: string;
    fileContext: string;
    summary: string;
  }>;
  rawReport: unknown;
}

export type DeliveryRuntimeRoleExecutor = (
  request: DeliveryRuntimeRoleRequest,
) => Promise<DeliveryRuntimeRoleResult>;

export interface DeliveryRuntimeEngine {
  /** External model/process transport. Production defaults to the owned process runner. */
  transport?: AgentTransport;
  provider?: string;
  model?: string;
  effort?: string;
  roleBudgets?: Partial<Record<"qa" | "reviewer", RoleBudget>>;
  maxContinuations?: number;
}

export interface DeliveryRuntimeCorrectionRequest {
  projectId: string;
  runId: string;
  deliveryId: string;
  planId: string;
  workId: string;
  actor: string;
  findings: DeliveryRuntimeFinding[];
}

/**
 * A final-spec repair cycle is not a child dispatch: it re-materializes the
 * combined candidate after a bounded repair. The final coordinator owns that
 * transition while this runtime keeps the same verification/correction loop.
 */
export interface DeliveryRuntimeCorrection {
  dispatch(request: DeliveryRuntimeCorrectionRequest): Promise<{ id: string } | null>;
}

export interface DeliveryRuntimeOptions {
  gate: DeliveryGateService;
  observations: ExecutionObservationService;
  dispatch: DispatchService;
  budget: ExecutionBudgetService;
  publication: PublicationService;
  /** Child-profile integration (publish child PR, read remote CI, safe auto-merge). */
  integration?: ChildIntegrationService;
  /** Root holding project-scoped finalized artifacts; must match the observation service. */
  artifactRoot?: string;
  /**
   * Scratch root for role sessions/checkpoints/attempt transcripts. It must stay
   * outside the immutable artifact root so the cutover/backup artifact digest is
   * a stable closure of registered evidence only.
   */
  roleScratchRoot?: string;
  /** Production role execution engine (real provider/process transport by default). */
  engine?: DeliveryRuntimeEngine;
  /** Override for narrower tests; production uses the bounded role runner below. */
  executor?: DeliveryRuntimeRoleExecutor;
  /** Declared ordinary regression commands. Production reads harness/harness.config.json. */
  regressionChecks?: string[];
  /** Declared child technical/contract commands. Production reads harness/harness.config.json. */
  technicalChecks?: string[];
  /** Replacement for the child-profile correction dispatch (final-spec repair). */
  correction?: DeliveryRuntimeCorrection;
  /** Durable run/stage ownership shared by every supported tick. */
  claims?: DeliveryRoleClaimService;
  maxCorrections?: number;
  clock?: () => number;
}

export interface DeliveryRuntimeResult {
  projectId: string;
  runId: string;
  action:
    | "skipped"
    | "verification_recorded"
    | "findings_resolved"
    | "correction_dispatched"
    | "published"
    | "already_claimed"
    | "stopped"
    | "failed";
  state: DeliveryGateState | null;
  reasons: string[];
  correctionRunId?: string;
}

interface RuntimeRunRow {
  id: string;
  project_id: string;
  delivery_id: string;
  plan_id: string;
  work_id: string;
  revision_id: string;
  issue_number: number;
  gate_profile: PlanGateProfile;
  target_branch: string;
  branch: string;
  head_sha: string | null;
  base_sha: string;
  state: string;
  lap: number;
  actor: string;
  checkout_path: string;
  graph_hash: string;
  contract_body: string | null;
}

type ClaimedStageOutcome =
  | {
      status: "recorded";
      stage: DeliveryClaimStage;
      observationId: string;
      result: DeliveryRuntimeRoleResult;
    }
  | {
      status: "already_running";
      stage: DeliveryClaimStage;
      reason: "already_running" | "owner_unverified";
    }
  | { status: "terminal"; stage: DeliveryClaimStage; observationId: string | null }
  | { status: "stale"; stage: DeliveryClaimStage }
  | { status: "stopped"; stage: DeliveryClaimStage }
  | { status: "unavailable"; stage: DeliveryClaimStage; reason: string };

interface RawCommandRun {
  command: string;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const MAX_RAW_STREAM_CHARS = 200_000;

function boundRawStream(value: string): string {
  if (value.length <= MAX_RAW_STREAM_CHARS) return value;
  const omitted = value.length - MAX_RAW_STREAM_CHARS;
  return `${value.slice(0, MAX_RAW_STREAM_CHARS)}\n...[truncated ${omitted} chars]`;
}

const REVIEW_ROLE: ProducerRole = "peer_reviewer";
const ACCEPTANCE_ROLE: ProducerRole = "independent_evaluator";
const GATE_ROLE: ProducerRole = "automated_gate";

/**
 * Normal production producer for standalone/final delivery. It drives the real
 * bounded role runner (reviewer + black-box QA), runs the repository's declared
 * regression checks, persists immutable candidate-bound observations/artifacts,
 * and turns failures into bounded correction laps dispatched through the existing
 * dispatch/budget/Stop ownership path.
 *
 * The gate remains the only consumer that decides readiness; this coordinator
 * never marks a merge, never fabricates a pass and never writes an observation
 * with a caller-supplied identity.
 */
export class DeliveryRuntimeCoordinator {
  private readonly executor: DeliveryRuntimeRoleExecutor;
  private readonly artifactRoot: string;
  private readonly roleScratchRoot: string;
  private readonly maxCorrections: number;
  private readonly claims: DeliveryRoleClaimService;

  /** Fail closed before any reviewer/QA transport, evidence write or publication. */
  private assertInstallationReady(): void {
    assertInstallationNotHeld(this.db);
  }

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: DeliveryRuntimeOptions,
  ) {
    this.executor = options.executor ?? createDeliveryRoleExecutor(options.engine ?? {});
    this.artifactRoot = options.artifactRoot ?? join(resolveAnimusStateDir(), "artifacts");
    this.roleScratchRoot =
      options.roleScratchRoot ?? join(dirname(this.artifactRoot), "role-runtime");
    this.maxCorrections = options.maxCorrections ?? 2;
    this.claims = options.claims ?? new DeliveryRoleClaimService(db);
  }

  /**
   * Advance one run through independent verification, bounded correction and
   * publication. Idempotent: the next tick observes recorded stages and continues
   * from where the previous tick stopped.
   */
  async process(projectId: string, runId: string): Promise<DeliveryRuntimeResult> {
    // Reviewer/QA transports, evidence writes, correction dispatch and
    // publication all happen below; a held installation must reach none of them.
    this.assertInstallationReady();
    const initial = this.loadRun(projectId, runId);
    if (initial.gate_profile === "child") {
      return this.processChild(projectId, runId);
    }
    let currentRunId = runId;
    let corrections = 0;
    let iterations = 0;
    const reasons: string[] = [];
    while (true) {
      iterations += 1;
      if (iterations > 20) {
        break;
      }
      const run = this.loadRun(projectId, currentRunId);
      if (run.state !== "succeeded" || !run.head_sha) {
        return {
          projectId,
          runId: run.id,
          action: "skipped",
          state: null,
          reasons: [`run_not_succeeded:${run.state}`],
        };
      }
      if (this.isStopped(run)) {
        return { projectId, runId: run.id, action: "stopped", state: null, reasons };
      }

      const gate = await this.options.gate.getGate(projectId, run.id);
      if (
        gate.state === "ready_for_operator_review" ||
        gate.state === "awaiting_manual_merge" ||
        gate.state === "awaiting_merge_verification" ||
        gate.state === "delivered"
      ) {
        return {
          projectId,
          runId: run.id,
          action: "skipped",
          state: gate.state,
          reasons: gate.reasons,
        };
      }

      const openFindings = this.openBlockingFindings(run);
      const review = this.options.observations.latestObservation(
        projectId,
        run.id,
        "independent_review",
      );
      const acceptance = this.options.observations.latestObservation(
        projectId,
        run.id,
        "final_acceptance",
      );
      const reviewPassed = review?.status === "passed";
      const acceptancePassed = acceptance?.status === "passed";
      const bothPassed = reviewPassed && acceptancePassed;
      const currentFailed =
        (review !== null && review.status !== "passed") ||
        (acceptance !== null && acceptance.status !== "passed");

      if (openFindings.length > 0 && bothPassed) {
        // A fresh independent pass already exists for the corrected candidate.
        this.resolveFindings(run, openFindings);
        reasons.push("findings_resolved");
        continue;
      }
      if (openFindings.length > 0 && currentFailed) {
        if (corrections >= this.maxCorrections) {
          return {
            projectId,
            runId: run.id,
            action: "failed",
            state: gate.state,
            reasons: [...reasons, "correction_budget_exhausted"],
          };
        }
        corrections += 1;
        const correctionRun = await this.dispatchCorrection(run, openFindings);
        if (!correctionRun) {
          return {
            projectId,
            runId: run.id,
            action: "failed",
            state: gate.state,
            reasons: [...reasons, ...gate.reasons],
          };
        }
        reasons.push(`correction_dispatched:${correctionRun.id}`);
        currentRunId = correctionRun.id;
        continue;
      }

      if (!bothPassed) {
        if (!reviewPassed) {
          const outcome = await this.runClaimedStage(run, "independent_review", (claim) =>
            this.runRole(run, "independent_review", claim),
          );
          const terminal = this.claimOutcomeResult(run, outcome, reasons, gate.state);
          if (terminal) return terminal;
          if (outcome.status !== "recorded") continue;
          reasons.push(`independent_review:${outcome.result.status}`);
        }
        if (!acceptancePassed) {
          const outcome = await this.runClaimedStage(run, "final_acceptance", (claim) =>
            this.runAcceptance(run, claim),
          );
          const terminal = this.claimOutcomeResult(run, outcome, reasons, gate.state);
          if (terminal) return terminal;
          if (outcome.status !== "recorded") continue;
          reasons.push(`final_acceptance:${outcome.result.status}`);
        }
        const refreshed = await this.options.gate.getGate(projectId, run.id);
        if (refreshed.state === "ready_for_operator_review") {
          return {
            projectId,
            runId: run.id,
            action: "verification_recorded",
            state: refreshed.state,
            reasons: refreshed.reasons,
          };
        }
        reasons.push(...refreshed.reasons);
        continue;
      }

      this.assertInstallationReady();
      if (this.isStopped(run)) {
        return {
          projectId,
          runId: run.id,
          action: "stopped",
          state: gate.state,
          reasons: [...reasons, "stopped_before_publication"],
        };
      }
      await this.publishIfNeeded(run);
      const finalGate = await this.options.gate.getGate(projectId, run.id);
      return {
        projectId,
        runId: run.id,
        action: "published",
        state: finalGate.state,
        reasons: finalGate.reasons,
      };
    }

    const last = this.loadRun(projectId, currentRunId);
    const gate = await this.options.gate.getGate(projectId, last.id);
    return {
      projectId,
      runId: last.id,
      action: "failed",
      state: gate.state,
      reasons: [...reasons, "correction_budget_exhausted"],
    };
  }

  /**
   * Child profile: the builder already produced a candidate. This runs the
   * applicable technical/contract checks and an independent standards/contract
   * review, then publishes the child PR, reads required remote CI and merges only
   * through the existing serialized lineage-verified integration service. Full
   * parent black-box QA is deliberately not part of this profile.
   */
  private async processChild(projectId: string, runId: string): Promise<DeliveryRuntimeResult> {
    this.assertInstallationReady();
    if (!this.options.integration) {
      return {
        projectId,
        runId,
        action: "skipped",
        state: null,
        reasons: ["child_integration_runtime_unavailable"],
      };
    }
    let currentRunId = runId;
    let corrections = 0;
    const reasons: string[] = [];
    for (let iterations = 0; iterations < 20; iterations += 1) {
      const run = this.loadRun(projectId, currentRunId);
      if (run.state !== "succeeded" || !run.head_sha) {
        return {
          projectId,
          runId: run.id,
          action: "skipped",
          state: null,
          reasons: [...reasons, `run_not_succeeded:${run.state}`],
        };
      }
      if (this.isStopped(run)) {
        return { projectId, runId: run.id, action: "stopped", state: null, reasons };
      }
      const integrationStatus = this.options.integration.getStatus(projectId, run.id);
      if (integrationStatus.state === "integrated") {
        return {
          projectId,
          runId: run.id,
          action: "skipped",
          state: null,
          reasons: [...reasons, "child_integrated"],
        };
      }

      const technical = this.options.observations.latestObservation(
        projectId,
        run.id,
        "technical_checks",
      );
      const review = this.options.observations.latestObservation(
        projectId,
        run.id,
        "independent_review",
      );
      const technicalPassed = technical?.status === "passed";
      const reviewPassed = review?.status === "passed";
      const openFindings = this.openBlockingFindings(run);

      // A fresh independent pass for the corrected candidate resolves the earlier
      // blocking findings; the builder's own fix claim cannot.
      if (openFindings.length > 0 && technicalPassed && reviewPassed) {
        this.resolveFindings(run, openFindings);
        reasons.push("findings_resolved");
        continue;
      }

      const failedStage =
        (technical !== null && technical.status !== "passed") ||
        (review !== null && review.status !== "passed");
      if (failedStage) {
        if (corrections >= this.maxCorrections) {
          return {
            projectId,
            runId: run.id,
            action: "failed",
            state: null,
            reasons: [...reasons, "correction_budget_exhausted"],
          };
        }
        corrections += 1;
        const correctionRun = await this.dispatchCorrection(
          run,
          openFindings.length > 0 ? openFindings : this.failingStageFindings(run),
        );
        if (!correctionRun) {
          return {
            projectId,
            runId: run.id,
            action: "failed",
            state: null,
            reasons: [...reasons, "correction_unavailable"],
          };
        }
        reasons.push(`correction_dispatched:${correctionRun.id}`);
        currentRunId = correctionRun.id;
        continue;
      }

      if (!technicalPassed) {
        const outcome = await this.runClaimedStage(run, "technical_checks", (claim) =>
          this.runTechnicalChecks(run, claim),
        );
        const terminal = this.claimOutcomeResult(run, outcome, reasons, null);
        if (terminal) return terminal;
        if (outcome.status !== "recorded") continue;
        reasons.push(`technical_checks:${outcome.result.status}`);
        continue;
      }
      if (!reviewPassed) {
        const outcome = await this.runClaimedStage(run, "independent_review", (claim) =>
          this.runRole(run, "independent_review", claim),
        );
        const terminal = this.claimOutcomeResult(run, outcome, reasons, null);
        if (terminal) return terminal;
        if (outcome.status !== "recorded") continue;
        reasons.push(`independent_review:${outcome.result.status}`);
        continue;
      }

      // Both child-profile stages passed for this candidate. Publish the child PR,
      // read required remote CI and merge only when the fresh target/lineage proof
      // succeeds. Conflicts, drift, missing/failed CI and unverified merges hold.
      this.assertInstallationReady();
      if (this.isStopped(run)) {
        return {
          projectId,
          runId: run.id,
          action: "stopped",
          state: null,
          reasons: [...reasons, "stopped_before_integration"],
        };
      }
      const landed = await this.options.integration.land(projectId, run.id, {
        actor: "delivery-runtime",
      });
      if (landed.state === "integrated") {
        return {
          projectId,
          runId: run.id,
          action: "published",
          state: null,
          reasons: [...reasons, "child_integrated"],
        };
      }
      return {
        projectId,
        runId: run.id,
        action: "failed",
        state: null,
        reasons: [
          ...reasons,
          ...(landed.blockers.length > 0
            ? landed.blockers.map((blocker) => blocker.code)
            : landed.acceptance.reasons),
        ],
      };
    }
    return {
      projectId,
      runId: currentRunId,
      action: "failed",
      state: null,
      reasons: [...reasons, "correction_budget_exhausted"],
    };
  }

  /**
   * Execute one delivery stage under a durable run/stage/lap claim. The claim is
   * written before the external role transport or check process starts, so a
   * second supported tick observes it and returns without executing. The result
   * observation is fenced by the claim's unique attempt key; the claim is
   * completed only after the observation is durable.
   */
  private async runClaimedStage(
    run: RuntimeRunRow,
    stage: DeliveryClaimStage,
    execute: (claim: DeliveryRoleClaim) => Promise<DeliveryRuntimeRoleResult | null>,
  ): Promise<ClaimedStageOutcome> {
    const acquired = this.claims.acquire({
      projectId: run.project_id,
      deliveryId: run.delivery_id,
      runId: run.id,
      lap: run.lap,
      stage,
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    if (acquired.status === "already_running") {
      return { status: "already_running", stage, reason: acquired.reason };
    }
    if (acquired.status === "terminal") {
      return {
        status: "terminal",
        stage,
        observationId: acquired.claim.resultObservationId,
      };
    }

    const claim = acquired.claim;
    const stopHeartbeat = this.claims.startHeartbeat(claim, (error) => {
      this.claims.noteHeartbeatError(claim, error instanceof Error ? error.message : String(error));
    });
    let artifactPath: string | null = null;
    let observationCommitted = false;
    try {
      // Revalidate the gate inputs before the external effect, not only at entry.
      this.assertInstallationReady();
      if (this.isStopped(run)) {
        this.claims.interrupt(claim, "stopped_before_stage_effect");
        return { status: "stopped", stage };
      }
      const result = await execute(claim);
      if (result === null) {
        this.claims.interrupt(claim, "stage_prerequisite_unavailable");
        return { status: "unavailable", stage, reason: "stage_prerequisite_unavailable" };
      }
      // A role may run for a long time: revalidate the fence and control state
      // before recording or releasing anything.
      this.assertInstallationReady();
      const stillOwned = this.claims.isCurrent(claim);
      const prepared = await this.prepareRoleResult(run, stage, result, {
        attemptKey: claim.attemptKey,
        claimCandidateHeadSha: claim.candidateHeadSha,
      });
      artifactPath = prepared.artifactPath;

      // The observation receipt and the claim CAS completion are one durable
      // SQLite transaction: a crash cannot leave a recorded result with a claim
      // that still looks owned. A stale owner still commits its late result (so a
      // late failure revokes an older pass) but the claim CAS is a no-op.
      let recorded: { observationId: string };
      let completed: boolean;
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        recorded = this.recordRoleObservation(run, prepared.submission, {
          attemptKey: claim.attemptKey,
        });
        completed = this.claims.completeWithinTransaction(
          claim,
          result.status === "passed" ? "completed" : "failed",
          recorded.observationId,
          result.status === "passed" ? null : result.summary || `${stage} ${result.status}`,
        );
        this.db.exec("COMMIT;");
        observationCommitted = true;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {}
        throw error;
      }
      if (!completed || !stillOwned) {
        // A stale owner's result is still persisted (so a late failure revokes an
        // older pass), but this tick must not advance publication/merge.
        return { status: "stale", stage };
      }
      if (this.isStopped(run)) {
        return { status: "stopped", stage };
      }
      return { status: "recorded", stage, observationId: recorded.observationId, result };
    } catch (error) {
      if (artifactPath && !observationCommitted) {
        // The transaction rolled back, so this file has no owning row. Remove it
        // rather than leaving unregistered state under the immutable artifact root.
        try {
          await unlink(join(this.artifactRoot, run.project_id, artifactPath));
        } catch {}
      }
      this.claims.interrupt(claim, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      stopHeartbeat();
    }
  }

  private claimOutcomeResult(
    run: RuntimeRunRow,
    outcome: ClaimedStageOutcome,
    reasons: string[],
    state: DeliveryGateState | null,
  ): DeliveryRuntimeResult | null {
    switch (outcome.status) {
      case "recorded":
      case "terminal":
        return null;
      case "already_running":
        return {
          projectId: run.project_id,
          runId: run.id,
          action: "already_claimed",
          state,
          reasons: [...reasons, `stage_claimed:${outcome.stage}:${outcome.reason}`],
        };
      case "stale":
        return {
          projectId: run.project_id,
          runId: run.id,
          action: "skipped",
          state,
          reasons: [...reasons, `stage_claim_stale:${outcome.stage}`],
        };
      case "stopped":
        return {
          projectId: run.project_id,
          runId: run.id,
          action: "stopped",
          state,
          reasons: [...reasons, `stopped_during_stage:${outcome.stage}`],
        };
      case "unavailable":
        return {
          projectId: run.project_id,
          runId: run.id,
          action: "failed",
          state,
          reasons: [...reasons, `${outcome.stage}_unavailable`],
        };
    }
  }

  private failingStageFindings(run: RuntimeRunRow): DeliveryRuntimeFinding[] {
    const findings: DeliveryRuntimeFinding[] = [];
    for (const stage of ["technical_checks", "independent_review"] as const) {
      const observation = this.options.observations.latestObservation(
        run.project_id,
        run.id,
        stage,
      );
      if (!observation || observation.status === "passed") continue;
      findings.push({
        id: `stage-${stage}`,
        severity: "blocking",
        acKey: null,
        fileContext: stage,
        summary: `${stage} did not pass (${observation.status})`,
        actor: run.actor,
      });
    }
    return findings;
  }

  private isStopped(run: RuntimeRunRow): boolean {
    const control = this.options.budget.getControl({
      projectId: run.project_id,
      deliveryId: run.delivery_id,
      workId: run.work_id,
    });
    return (
      control?.status === "held" || control?.status === "stopping" || control?.status === "stopped"
    );
  }

  private openBlockingFindings(run: RuntimeRunRow): DeliveryRuntimeFinding[] {
    return this.options.observations
      .listFindings(run.project_id, {
        deliveryId: run.delivery_id,
        workId: run.work_id,
        status: "open",
      })
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => {
        const runActor = this.db
          .prepare("SELECT actor FROM dispatch_runs WHERE id = ?")
          .get(finding.runId) as { actor: string } | undefined;
        return {
          id: finding.id,
          severity: finding.severity,
          acKey: finding.acKey,
          fileContext: finding.fileContext,
          summary: finding.summary,
          actor: runActor?.actor ?? run.actor,
        };
      });
  }

  private resolveFindings(run: RuntimeRunRow, findings: DeliveryRuntimeFinding[]): void {
    const evaluator = this.ensureProducer(run, ACCEPTANCE_ROLE);
    for (const finding of findings) {
      this.options.observations.recordFindingFix(run.project_id, finding.id, {
        actor: finding.actor,
        detail: `Builder corrected the finding in lap ${run.lap}`,
      });
      this.options.observations.recordFindingRecheck(run.project_id, finding.id, {
        runId: run.id,
        producer: evaluator,
        status: "passed",
        stage: "technical_checks",
        checks: [
          {
            name: `recheck ${finding.acKey ?? finding.id}`,
            command: "independent fresh recheck",
            result: "PASS",
            kind: finding.acKey ? "acceptance" : "review",
            ...(finding.acKey ? { criterionKey: finding.acKey } : {}),
          },
        ],
      });
    }
  }

  private async dispatchCorrection(
    run: RuntimeRunRow,
    findings: DeliveryRuntimeFinding[],
  ): Promise<{ id: string } | null> {
    try {
      if (this.options.correction && run.gate_profile === "final") {
        return await this.options.correction.dispatch({
          projectId: run.project_id,
          runId: run.id,
          deliveryId: run.delivery_id,
          planId: run.plan_id,
          workId: run.work_id,
          actor: "delivery-runtime",
          findings,
        });
      }
      const correction: PlanDispatchRun = await this.options.dispatch.dispatch(run.project_id, {
        plan_id: run.plan_id,
        work_id: run.work_id,
        actor: "delivery-runtime",
        findings: findings.map((finding) => ({
          summary: finding.summary,
          fileContext: finding.fileContext,
          ...(finding.acKey ? { acKey: finding.acKey } : {}),
        })),
      });
      return correction;
    } catch {
      return null;
    }
  }

  private async publishIfNeeded(run: RuntimeRunRow): Promise<void> {
    this.assertInstallationReady();
    const status = this.options.publication.getStatusByRun(run.project_id, run.id);
    const hasActive = status.pullRequests.some((pullRequest) => pullRequest.active);
    if (status.target.state !== "published" || !hasActive) {
      await this.options.publication.publishByRun(run.project_id, run.id);
    }
  }

  private async runRole(
    run: RuntimeRunRow,
    stage: "independent_review",
    claim?: DeliveryRoleClaim,
  ): Promise<DeliveryRuntimeRoleResult> {
    this.assertInstallationReady();
    const request = this.roleRequest(run, stage, claim);
    return this.executor(request);
  }

  private async runAcceptance(
    run: RuntimeRunRow,
    claim?: DeliveryRoleClaim,
  ): Promise<DeliveryRuntimeRoleResult> {
    this.assertInstallationReady();
    const request = this.roleRequest(run, "final_acceptance", claim);
    const result = await this.executor(request);
    const regression = await this.runRegressionChecks(run, claim);
    const checks = [...result.checks, regression.check];
    const findings = [...result.findings];
    if (regression.check.result === "FAIL") {
      findings.push({
        severity: "blocking",
        fileContext: "regression",
        summary: `Declared regression checks failed: ${regression.detail}`,
      });
    }
    const status =
      result.status === "passed" && regression.check.result === "PASS" ? "passed" : "failed";
    return {
      ...result,
      status,
      checks,
      findings: status === "passed" ? [] : findings,
      rawReport: { report: result.rawReport, regression: regression.raw },
    };
  }

  private async runRegressionChecks(
    run: RuntimeRunRow,
    claim?: DeliveryRoleClaim,
  ): Promise<{
    check: DeliveryRuntimeCheck;
    detail: string;
    raw: { commands: string[]; runs: RawCommandRun[] };
  }> {
    this.assertInstallationReady();
    let commands = this.options.regressionChecks;
    if (!commands) {
      try {
        commands = readHarnessChecks(run.checkout_path).checks;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          check: {
            name: "relevant regression",
            command: "harness/harness.config.json",
            result: "FAIL",
            kind: "regression",
            detail,
          },
          detail,
          raw: { commands: [], runs: [] },
        };
      }
    }
    const failures: string[] = [];
    const runs: RawCommandRun[] = [];
    const worktreePath = this.worktreePath(run);
    for (const command of commands) {
      const executed = await this.runCheckCommand(command, worktreePath, claim);
      runs.push(executed);
      if (executed.exitCode !== 0 || executed.timedOut) {
        failures.push(
          `${command} (exit ${executed.exitCode}${executed.timedOut ? ", timed out" : ""})`,
        );
      }
    }
    return {
      check: {
        name: "relevant regression",
        command: commands.join(" && "),
        result: failures.length === 0 ? "PASS" : "FAIL",
        kind: "regression",
        ...(failures.length > 0 ? { detail: failures.join("; ") } : {}),
      },
      detail: failures.join("; "),
      raw: { commands, runs },
    };
  }

  /**
   * Execute the repository's declared technical/contract checks against the real
   * candidate worktree. Exit status is the only pass signal; a missing declaration
   * returns null so the caller holds instead of inventing a pass. Each configured
   * command gets a deterministic ordinal+kind check identity so two commands (or two
   * intentionally identical commands) remain distinct rows under the observation's
   * `UNIQUE(observation_id, name)` key instead of aborting the whole observation.
   */
  private async runTechnicalChecks(
    run: RuntimeRunRow,
    claim?: DeliveryRoleClaim,
  ): Promise<DeliveryRuntimeRoleResult | null> {
    this.assertInstallationReady();
    let commands = this.options.technicalChecks;
    if (!commands) {
      try {
        commands = readHarnessChecks(run.checkout_path).checks;
      } catch {
        return null;
      }
    }
    if (commands.length === 0) return null;

    const worktreePath = this.worktreePath(run);
    const checks: DeliveryRuntimeCheck[] = [];
    const failures: string[] = [];
    const runs: RawCommandRun[] = [];
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index]!;
      const executed = await this.runCheckCommand(command, worktreePath, claim);
      runs.push(executed);
      const passed = executed.exitCode === 0 && !executed.timedOut;
      const detail = passed
        ? undefined
        : `exit ${executed.exitCode}${executed.timedOut ? ", timed out" : ""}`;
      checks[index] = {
        name: `declared technical/contract check #${index + 1}`,
        command,
        result: passed ? "PASS" : "FAIL",
        kind: "contract",
        ...(detail ? { detail } : {}),
      };
      if (!passed) {
        failures.push(`${command} (${detail})`);
      }
    }
    const status = failures.length === 0 ? "passed" : "failed";
    return {
      status,
      summary:
        status === "passed" ? "Declared technical/contract checks passed" : failures.join("; "),
      checks,
      findings:
        status === "passed"
          ? []
          : [
              {
                severity: "blocking",
                fileContext: "technical_checks",
                summary: `Declared technical/contract checks failed: ${failures.join("; ")}`,
              },
            ],
      rawReport: { commands, checks, runs },
    };
  }

  private async runCheckCommand(
    command: string,
    cwd: string,
    claim?: DeliveryRoleClaim,
  ): Promise<RawCommandRun> {
    const result = await processRun(["sh", "-c", command], cwd, 30_000, undefined, {
      manageSignals: false,
      ...(claim
        ? {
            onSpawn: (pid: number) => {
              this.claims.recordRoleProcess(claim, pid, pid);
            },
          }
        : {}),
    });
    return {
      command,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      stdout: boundRawStream(result.stdout),
      stderr: boundRawStream(result.stderr),
    };
  }

  private async prepareRoleResult(
    run: RuntimeRunRow,
    stage: "technical_checks" | "independent_review" | "final_acceptance",
    result: DeliveryRuntimeRoleResult,
    options: {
      finalizedArtifact?: boolean;
      attemptKey?: string;
      claimCandidateHeadSha?: string;
    } = {},
  ): Promise<{ submission: ExecutionObservationSubmissionInput; artifactPath: string | null }> {
    this.assertInstallationReady();
    const candidateHeadSha = run.head_sha ?? run.base_sha;
    if (
      options.claimCandidateHeadSha !== undefined &&
      options.claimCandidateHeadSha !== candidateHeadSha
    ) {
      throw new Error(
        `delivery role result candidate ${candidateHeadSha} does not match the claim candidate ${options.claimCandidateHeadSha}`,
      );
    }
    const producer = this.ensureProducer(
      run,
      stage === "independent_review"
        ? REVIEW_ROLE
        : stage === "technical_checks"
          ? GATE_ROLE
          : ACCEPTANCE_ROLE,
    );
    const withArtifact = options.finalizedArtifact !== false;
    const relativePath = withArtifact
      ? ["runtime", run.id, `${stage}-${run.lap}-${randomUUID()}.json`].join("/")
      : null;
    if (relativePath) {
      const absolute = join(this.artifactRoot, run.project_id, relativePath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(
        absolute,
        JSON.stringify(
          {
            stage,
            runId: run.id,
            lap: run.lap,
            candidateHeadSha: run.head_sha,
            gateProfileVersion: GATE_PROFILE_VERSION,
            attemptKey: options.attemptKey ?? null,
            report: result.rawReport,
          },
          null,
          2,
        ),
      );
    }

    const submission: ExecutionObservationSubmissionInput = {
      stage: stage as ExecutionStage,
      status: result.status,
      producer,
      checks: result.checks.map((check) => ({
        name: check.name,
        command: check.command,
        result: check.result,
        kind: check.kind,
        ...(check.criterionKey ? { criterionKey: check.criterionKey } : {}),
        ...(check.detail ? { detail: check.detail } : {}),
        ...(relativePath ? { artifactPath: relativePath } : {}),
      })),
      findings:
        result.status === "passed"
          ? []
          : result.findings.length > 0
            ? result.findings.map((finding) => ({
                severity: finding.severity,
                ...(finding.acKey ? { acKey: finding.acKey } : {}),
                fileContext: finding.fileContext,
                summary: finding.summary,
                workId: run.work_id,
              }))
            : [
                {
                  severity: "blocking",
                  fileContext: stage,
                  summary: result.summary || `${stage} did not pass (${result.status})`,
                  workId: run.work_id,
                },
              ],
      artifacts: relativePath
        ? [
            {
              ownerType: "observation",
              name: `${stage} report`,
              relativePath,
              mediaType: "application/json",
            },
          ]
        : [],
    };
    return { submission, artifactPath: relativePath };
  }

  private recordRoleObservation(
    run: RuntimeRunRow,
    submission: ExecutionObservationSubmissionInput,
    options: { attemptKey?: string } = {},
  ): { observationId: string } {
    const observation = this.options.observations.recordRunObservation(
      run.project_id,
      run.id,
      submission,
      options.attemptKey ? { attemptKey: options.attemptKey } : {},
    );
    return { observationId: observation.id };
  }

  private ensureProducer(
    run: RuntimeRunRow,
    role: ProducerRole,
  ): { id: string; role: ProducerRole } {
    const suffix = role === REVIEW_ROLE ? "reviewer" : role === GATE_ROLE ? "gate" : "evaluator";
    return this.options.observations.ensureTrustedProducer(run.project_id, {
      id: `runtime-${suffix}-${run.id}`,
      role,
    });
  }

  private roleRequest(
    run: RuntimeRunRow,
    stage: "independent_review" | "final_acceptance",
    claim?: DeliveryRoleClaim,
  ): DeliveryRuntimeRoleRequest {
    return {
      projectId: run.project_id,
      runId: run.id,
      lap: run.lap,
      gateProfile: run.gate_profile,
      stage,
      projectRoot: run.checkout_path,
      worktreePath: this.worktreePath(run),
      branch: run.branch,
      candidateHeadSha: run.head_sha!,
      baseSha: run.base_sha,
      targetBranch: run.target_branch,
      contractBody: run.contract_body ?? "",
      acceptanceCriteria: this.acceptanceCriteria(run),
      findings: this.openBlockingFindings(run),
      runDirectory: join(this.roleScratchRoot, run.project_id, run.id),
      ...(claim
        ? {
            onSpawn: (pid: number) => {
              this.claims.recordRoleProcess(claim, pid, pid);
            },
          }
        : {}),
    };
  }

  private worktreePath(run: RuntimeRunRow): string {
    const row = this.db
      .prepare("SELECT worktree_path FROM dispatch_runs WHERE project_id = ? AND id = ?")
      .get(run.project_id, run.id) as { worktree_path: string } | undefined;
    return row?.worktree_path ?? run.checkout_path;
  }

  private acceptanceCriteria(run: RuntimeRunRow): string[] {
    return (
      this.db
        .prepare(
          `SELECT ac_key FROM plan_acceptance_criteria
           WHERE plan_id = ? AND work_id = ? ORDER BY ordinal ASC`,
        )
        .all(run.plan_id, run.work_id) as Array<{ ac_key: string }>
    ).map((row) => row.ac_key);
  }

  private loadRun(projectId: string, runId: string): RuntimeRunRow {
    const row = this.db
      .prepare(
        `SELECT r.id, r.project_id, r.delivery_id, r.plan_id, r.work_id, r.revision_id,
                r.issue_number, r.gate_profile, r.target_branch, r.branch, r.head_sha,
                r.base_sha, r.state, r.lap, r.actor, p.checkout_path, d.graph_hash,
                w.source_body AS contract_body
         FROM dispatch_runs r
         JOIN projects p ON p.id = r.project_id
         JOIN deliveries d ON d.id = r.delivery_id AND d.project_id = r.project_id
         LEFT JOIN work_revisions w
           ON w.id = r.revision_id AND w.work_id = r.work_id AND w.project_id = r.project_id
         WHERE r.project_id = ? AND r.id = ?`,
      )
      .get(projectId, runId) as unknown as RuntimeRunRow | undefined;
    if (!row) throw new Error(`Run ${runId} not found for project ${projectId}`);
    return row;
  }
}

/**
 * Production executor: real bounded reviewer/QA roles through the same role
 * runner used by the factory loop. Only the external model/process transport is
 * injectable for offline proof.
 */
export function createDeliveryRoleExecutor(
  engine: DeliveryRuntimeEngine,
): DeliveryRuntimeRoleExecutor {
  const baseTransport: AgentTransport =
    engine.transport ??
    ((request) =>
      processRun(request.argv, request.cwd, request.timeoutMs, request.env, {
        manageSignals: false,
        ...(request.onSpawn ? { onSpawn: request.onSpawn } : {}),
      }));

  return async (request) => {
    const transport: AgentTransport = request.onSpawn
      ? (transportRequest) => baseTransport({ ...transportRequest, onSpawn: request.onSpawn })
      : baseTransport;
    const role: LoopRole = request.stage === "independent_review" ? "reviewer" : "qa";
    const provider = engine.provider ?? resolveProviderForRole(request.projectRoot, role);
    const model = engine.model ?? resolveModelForRole(request.projectRoot, role) ?? "small";
    const effort = engine.effort ?? resolveEffortForRole(request.projectRoot, role);
    const budgets = resolveRoleBudgets({
      maxContinuations: engine.maxContinuations ?? 1,
      ...(engine.roleBudgets ? { roleBudgets: engine.roleBudgets } : {}),
    });
    const runDirectory = join(request.runDirectory, request.stage);
    const result = await runBoundedRole({
      role,
      root: request.projectRoot,
      cwd: request.worktreePath,
      prompt:
        request.stage === "independent_review" ? reviewPrompt(request) : acceptancePrompt(request),
      sessionDir: join(runDirectory, "session"),
      checkpointPath: join(runDirectory, "checkpoint.md"),
      handoffDir: join(runDirectory, "handoff"),
      runDirectory,
      budget: budgets[role],
      maxContinuations: engine.maxContinuations ?? 1,
      provider,
      model,
      effort,
      transport,
      candidate: request.candidateHeadSha,
      optionsOverride: { requiredAcIds: request.acceptanceCriteria },
    });
    const rawReport = {
      report: result.report,
      // The finalized artifact is the immutable local record: keep the full raw
      // stdout/stderr and the attempt/exit identity so a reviewer can audit the
      // exact process that produced the verdict. PR inlining re-verifies and
      // bounds this payload separately.
      rawStdout: result.rawStdout,
      rawStderr: typeof result.result?.stderr === "string" ? result.result.stderr : "",
      exitCode: typeof result.result?.exitCode === "number" ? result.result.exitCode : null,
      timedOut: result.result?.timedOut === true,
      attempt: result.attempt,
      sessionId: result.sessionId ?? null,
      head: result.head,
    };
    if (request.stage === "independent_review") {
      return { ...reviewResult(result.report), rawReport };
    }
    return { ...acceptanceResult(request, result.report), rawReport };
  };
}

function reviewPrompt(request: DeliveryRuntimeRoleRequest): string {
  const findings =
    request.findings.length === 0
      ? "(none)"
      : request.findings
          .map(
            (finding) =>
              `- ${finding.id}${finding.acKey ? ` [${finding.acKey}]` : ""} ${finding.fileContext}: ${finding.summary}`,
          )
          .join("\n");
  return [
    "# Independent delivery review",
    "",
    "You are the independent reviewer for a standalone delivery. You did not write",
    "this change. Judge what the candidate does, not what anyone claims.",
    "",
    `- Ticket: #${request.runId}`,
    `- Branch: ${request.branch}`,
    `- Candidate: ${request.candidateHeadSha}`,
    `- Base: ${request.baseSha}`,
    `- Target: ${request.targetBranch}`,
    "",
    "## Frozen contract",
    "",
    request.contractBody.trim(),
    "",
    "## Open blocking findings",
    "",
    findings,
    "",
    "## Rules",
    "",
    "- Inspect `git diff` and the candidate files line by line.",
    "- Enforce the repository's AGENTS.md, CODING_STANDARDS.md and security rules.",
    "- Reject shallow wrappers, dead code, tautological tests and missing negative cases.",
    "- Verification runs in this worktree; do not push, merge or edit and commit source.",
    "- Return sent-back whenever any blocking defect remains.",
    "",
    "## Report format",
    "",
    'Return one JSON object: {"outcome":"approved"|"sent-back","sha":"<candidate>","summary":"...","findings":[{"id":"F1","axis":"standards","classification":"defect","blocking":true,"title":"...","description":"...","location":{"file":"path","line":1},"evidence":"...","status":"open"}]}',
  ].join("\n");
}

function acceptancePrompt(request: DeliveryRuntimeRoleRequest): string {
  const criteria =
    request.acceptanceCriteria.length === 0
      ? "(no criteria recorded)"
      : request.acceptanceCriteria.map((key) => `- ${key}`).join("\n");
  return [
    "# Black-box delivery acceptance",
    "",
    "You are the independent black-box tester for a standalone delivery. Test the",
    "product through its real supported transports; do not inspect the builder's",
    "narrative as proof.",
    "",
    `- Candidate: ${request.candidateHeadSha}`,
    `- Base: ${request.baseSha}`,
    `- Worktree: ${request.worktreePath}`,
    "",
    "## Acceptance criteria",
    "",
    criteria,
    "",
    "## Rules",
    "",
    "- Exercise each criterion against the running product or its public CLI/HTTP surface.",
    "- Run the relevant existing test suites and report regressions honestly.",
    "- Record concrete command output/evidence under the artifacts directory.",
    "- Do not edit source, commit, push or merge.",
    "- Return FAIL when any criterion is unverified or any regression remains.",
    "",
    "## Report format",
    "",
    'Return one JSON object: {"head":"<candidate>","overall":"PASS"|"FAIL","summary":"...","lines":[{"id":"AC1","kind":"criterion","verdict":"PASS"|"FAIL","text":"...","evidence":["file"]}],"noticed":[]}',
  ].join("\n");
}

function reviewResult(report: any): DeliveryRuntimeRoleResult {
  const outcome = String(report?.outcome ?? "").toLowerCase();
  const passed = report?.passed === true || ["approved", "merge"].includes(outcome);
  const rawFindings: any[] = Array.isArray(report?.findings) ? report.findings : [];
  const findings = rawFindings
    .filter((finding) => finding?.blocking !== false)
    .map((finding) => ({
      severity: "blocking" as const,
      fileContext: finding.location?.file
        ? `${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""}`
        : "review",
      summary: [finding.title, finding.description].filter(Boolean).join(": ") || "Review finding",
    }));
  return {
    status: passed && findings.length === 0 ? "passed" : "failed",
    summary: String(report?.summary ?? outcome),
    checks: [
      {
        name: "independent standards and contract review",
        command: "review candidate diff",
        result: passed && findings.length === 0 ? "PASS" : "FAIL",
        kind: "review",
      },
    ],
    findings: passed && findings.length === 0 ? [] : findings,
    rawReport: report,
  };
}

function acceptanceResult(
  request: DeliveryRuntimeRoleRequest,
  report: any,
): DeliveryRuntimeRoleResult {
  const lines: any[] = Array.isArray(report?.lines) ? report.lines : [];
  const checks: DeliveryRuntimeCheck[] = request.acceptanceCriteria.map((criterion) => {
    const line = lines.find((item) => item?.id === criterion);
    const passed = String(line?.verdict ?? "").toUpperCase() === "PASS";
    return {
      name: `AC ${criterion} black-box`,
      command: "black-box acceptance",
      result: passed ? "PASS" : "FAIL",
      kind: "acceptance",
      criterionKey: criterion,
      ...(line?.text ? { detail: String(line.text) } : {}),
    };
  });
  const failedLines = lines.filter((line) => String(line?.verdict ?? "").toUpperCase() !== "PASS");
  const passed =
    String(report?.overall ?? "").toUpperCase() === "PASS" &&
    checks.every((check) => check.result === "PASS") &&
    failedLines.length === 0;
  const findings = failedLines.map((line) => ({
    severity: "blocking" as const,
    ...(request.acceptanceCriteria.includes(line?.id) ? { acKey: String(line.id) } : {}),
    fileContext: "black-box acceptance",
    summary: `${line?.id ?? "QA"}: ${line?.text ?? "criterion did not pass"}`,
  }));
  return {
    status: passed ? "passed" : "failed",
    summary: String(report?.summary ?? ""),
    checks,
    findings,
    rawReport: report,
  };
}
