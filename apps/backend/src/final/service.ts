import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  finalDeliveryStatusSchema,
  type BudgetGrantList,
  type DeliveryGateStatus,
  type FinalDeliveryChild,
  type FinalDeliveryState,
  type FinalDeliveryStatus,
  type PlanMember,
  type PlanRecord,
  type PublicationStatus,
} from "@animus/contracts/operator";
import { getProjectWorktreesDir } from "@animus/contracts/paths";
import {
  InstallationHeldError,
  assertInstallationNotHeld,
} from "@animus/contracts/installation-hold";
import { assertExternalWriterAllowed } from "../authority/guard";
import { SerializedIntegrationManager } from "../coordination/integration";
import {
  DeliveryGateService,
  type DeliveryRuntimeCoordinator,
  type DeliveryRuntimeCorrectionRequest,
} from "../delivery";
import type { DispatchFinding, DispatchService } from "../dispatch";
import type { ExecutionObservationService } from "../evidence";
import type { PlanService } from "../plans";
import {
  defaultGitRemote,
  type PublicationRemoteRunner,
  type PublicationService,
} from "../publication";
import { ExecutionBudgetService, type BudgetScopeKey } from "../work/budget";
import { FinalDeliveryError } from "./errors";

const FINAL_ACTOR = "final-coordinator";
const REPAIR_ACTOR = "final-repair";
const LEASE_MS = 120_000;

interface ProjectRow {
  id: string;
  repo_name: string;
  checkout_path: string;
  status: "active" | "held" | "tombstone";
}

interface DeliveryRow {
  id: string;
  manifest_id: string;
  graph_hash: string;
  integration_branch: string | null;
  delivery_branch: string;
  final_pr_base: string;
}

interface FinalRow {
  status: FinalDeliveryState;
  candidate_head_sha: string | null;
  final_run_id: string | null;
  required_count: number;
  integrated_count: number;
  pull_request_number: number | null;
  pull_request_url: string | null;
  halt_reason: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  updated_at: number;
}

interface IntegrationRow {
  work_id: string;
  issue_number: number;
  candidate_head_sha: string;
  merge_sha: string;
  target_tip_before_sha: string;
  target_tip_after_sha: string;
  target_branch: string;
  remote_pull_request_number: number;
  remote_pull_request_url: string | null;
}

interface MaterializeResult {
  runId: string | null;
  exhausted: boolean;
  reasons: string[];
}

export interface FinalDeliveryServiceOptions {
  plans: PlanService;
  dispatch: DispatchService;
  observations: ExecutionObservationService;
  publication: PublicationService;
  gate: DeliveryGateService;
  budget?: ExecutionBudgetService;
  /** Lazy to avoid a construction cycle with the correction callback. */
  runtime: () => DeliveryRuntimeCoordinator;
  gitRunner?: (cmd: string[], cwd: string) => string;
  gitRemote?: PublicationRemoteRunner;
  clock?: () => number;
  leaseMs?: number;
}

/**
 * Final-spec delivery coordinator. It owns only the durable transition from
 * "all approved children verified on the integration lineage" to "one final
 * integration-to-delivery PR", then hands verification to the shared full-delivery
 * gate/runtime. Candidate evidence, PR audit, budgets, dispatches and merges stay
 * in their existing stores.
 */
export class FinalDeliveryService {
  private readonly budget: ExecutionBudgetService;
  private readonly gitRunner: (cmd: string[], cwd: string) => string;
  private readonly gitRemote: PublicationRemoteRunner;
  private readonly clock: () => number;
  private readonly leaseMs: number;
  private readonly integration: SerializedIntegrationManager;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: FinalDeliveryServiceOptions,
  ) {
    this.budget = options.budget ?? new ExecutionBudgetService(db);
    this.gitRunner =
      options.gitRunner ??
      ((cmd, cwd) =>
        execFileSync("git", cmd, {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim());
    this.gitRemote = options.gitRemote ?? defaultGitRemote;
    this.clock = options.clock ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.integration = new SerializedIntegrationManager((cmd, options) =>
      this.gitRunner(cmd, options.cwd),
    );
  }

  async list(projectId: string): Promise<FinalDeliveryStatus[]> {
    const summaries = this.options.plans
      .listPlans(projectId)
      .filter((summary) => summary.kind === "spec" && summary.authority === "admitted")
      .sort((left, right) => left.root_issue_number - right.root_issue_number);
    const statuses: FinalDeliveryStatus[] = [];
    for (const summary of summaries) {
      statuses.push(await this.getStatus(projectId, summary.id));
    }
    return statuses;
  }

  async getStatus(projectId: string, planId: string): Promise<FinalDeliveryStatus> {
    this.loadProject(projectId);
    const plan = this.loadSpecPlan(projectId, planId);
    const delivery = this.loadDelivery(projectId, plan.id);
    const required = this.requiredChildren(plan);
    const branch = this.integrationBranch(plan);
    const integrations = delivery
      ? this.integrationRows(projectId, delivery.id, required, branch)
      : new Map<string, IntegrationRow>();
    const row = this.loadRow(projectId, plan.id);
    const gate = row?.final_run_id
      ? await this.options.gate
          .getGate(projectId, row.final_run_id)
          .catch(() => null as DeliveryGateStatus | null)
      : null;
    const budget = delivery ? this.budget.getScope(this.scopeKey(projectId, delivery, plan)) : null;
    const grants: BudgetGrantList = delivery
      ? this.options.dispatch.listGrants(projectId, { workId: plan.root_work_id })
      : [];
    const children = this.childStatuses(plan, required, integrations);
    const integratedCount = children.filter((child) => child.integrated).length;
    const delivered =
      row?.status === "delivered" || gate?.state === "delivered" || gate?.merge.verified === true;
    const state = this.deriveState(row, gate, delivered, integratedCount, required.length);
    const pullRequest = this.pullRequestSummary(projectId, row, gate);
    const reasons = this.statusReasons(row, gate, children, integratedCount, required.length);

    return finalDeliveryStatusSchema.parse({
      projectId,
      planId: plan.id,
      deliveryId: delivery?.id ?? null,
      kind: "spec",
      graphHash: plan.graph_hash,
      manifestId: delivery?.manifest_id ?? null,
      integrationBranch: branch,
      deliveryBranch: plan.delivery_branch,
      state,
      requiredCount: required.length,
      integratedCount,
      delivered,
      candidateHeadSha: gate?.candidateHeadSha ?? row?.candidate_head_sha ?? null,
      targetTipSha: gate?.targetTipSha ?? null,
      runId: row?.final_run_id ?? null,
      reasons,
      children,
      gate,
      budget,
      grants,
      pullRequest,
      merge: gate?.merge ?? null,
      haltReason: row?.halt_reason ?? null,
      updatedAt: row?.updated_at ?? this.clock(),
    });
  }

  /**
   * Durable, idempotent final coordination step. It never invents a graph,
   * never re-runs children and never merges the final PR.
   */
  async advance(
    projectId: string,
    planId: string,
    submission: { actor?: string; reason?: string } = {},
  ): Promise<FinalDeliveryStatus> {
    this.assertInstallationReady();
    const project = this.loadProject(projectId);
    const plan = this.loadAdmittedSpec(projectId, planId);
    const manifest = plan.manifest!;
    const required = this.requiredChildren(plan);
    const branch = this.integrationBranch(plan);
    const delivery = this.loadDelivery(projectId, plan.id);
    if (!delivery) {
      return this.getStatus(projectId, plan.id);
    }

    const ownerToken = randomUUID();
    const lease = this.acquireLease(project, plan, delivery, required.length, ownerToken);
    if (!lease.acquired) {
      return this.getStatus(projectId, plan.id);
    }

    try {
      const current = this.loadRow(projectId, plan.id);
      if (current?.status === "delivered") {
        return this.getStatus(projectId, plan.id);
      }
      const integrations = this.integrationRows(projectId, delivery.id, required, branch);
      const missing = required.filter((member) => !integrations.has(member.work_id));
      if (missing.length > 0) {
        this.persistStatus(projectId, delivery, plan, {
          status: "waiting_children",
          integratedCount: required.length - missing.length,
          requiredCount: required.length,
          candidate: null,
          runId: null,
          reason: `children_pending:${missing.map((member) => `#${member.issue_number}`).join(",")}`,
        });
        this.recordEvent(project, delivery, plan, {
          kind: "waiting",
          reasons: missing.map((member) => `child_not_integrated:#${member.issue_number}`),
          detail: "Final acceptance cannot start before every required child is integrated",
        });
        return this.getStatus(projectId, plan.id);
      }

      const remoteTip = await this.fetchRemoteBranch(project.checkout_path, branch);
      if (!remoteTip) {
        return this.block(
          project,
          plan,
          delivery,
          "remote_unavailable",
          ["final_integration_remote_unavailable"],
          required.length,
          "The remote integration lineage is unreadable",
        );
      }
      const lineageReasons = this.childLineageReasons(
        project.checkout_path,
        integrations,
        remoteTip,
      );
      if (lineageReasons.length > 0) {
        return this.block(
          project,
          plan,
          delivery,
          "blocked",
          lineageReasons,
          required.length,
          "A required child is not verifiably included in the remote integration lineage",
        );
      }

      this.syncLocalBranch(project.checkout_path, branch, remoteTip);
      const targetTip = await this.fetchAndSyncTarget(
        project.checkout_path,
        delivery.delivery_branch,
      );
      if (!targetTip) {
        return this.block(
          project,
          plan,
          delivery,
          "remote_unavailable",
          ["final_delivery_target_unavailable"],
          required.length,
          "The configured delivery target is unreadable",
        );
      }

      let candidate = remoteTip;
      if (!this.isAncestor(project.checkout_path, targetTip, remoteTip)) {
        const merged = await this.mergeTargetIntoIntegration(
          project,
          delivery,
          remoteTip,
          targetTip,
        );
        if (!merged) {
          return this.block(
            project,
            plan,
            delivery,
            "needs_owner",
            ["final_target_conflict"],
            required.length,
            `The integration candidate does not merge cleanly with ${delivery.delivery_branch}`,
          );
        }
        candidate = merged;
        this.syncLocalBranch(project.checkout_path, branch, merged);
      }

      const materialized = this.materializeRun(
        project,
        plan,
        delivery,
        manifest,
        candidate,
        targetTip,
        required,
        integrations,
        submission.actor ?? FINAL_ACTOR,
      );
      if (!materialized.runId) {
        this.persistStatus(projectId, delivery, plan, {
          status: "needs_owner",
          integratedCount: required.length,
          requiredCount: required.length,
          candidate,
          runId: null,
          reason: materialized.reasons.join(", ") || "final_budget_exhausted",
        });
        this.recordEvent(project, delivery, plan, {
          kind: "needs_owner",
          candidate,
          reasons: materialized.reasons,
          detail: "Final delivery exhausted its bounded attempt scope",
        });
        return this.getStatus(projectId, plan.id);
      }

      this.persistStatus(projectId, delivery, plan, {
        status: "verifying",
        integratedCount: required.length,
        requiredCount: required.length,
        candidate,
        runId: materialized.runId,
        reason: null,
      });
      this.recordEvent(project, delivery, plan, {
        kind: "final_run",
        candidate,
        runId: materialized.runId,
        reasons: [`children_integrated:${required.length}`],
        detail: "Combined candidate materialized for independent final verification",
      });

      const runtime = this.options.runtime();
      const result = await runtime.process(projectId, materialized.runId);
      // A bounded repair materializes a newer combined candidate inside the same
      // runtime tick; the durable row is authoritative for the latest run.
      const currentRow = this.loadRow(projectId, plan.id);
      const currentRunId = currentRow?.final_run_id ?? materialized.runId;
      const currentCandidate = currentRow?.candidate_head_sha ?? candidate;
      const finalGate = await this.options.gate
        .getGate(projectId, currentRunId)
        .catch(() => null as DeliveryGateStatus | null);
      const exhausted = this.finalBudgetExhausted(projectId, delivery, plan);
      const delivered =
        result.action === "skipped" &&
        (finalGate?.state === "delivered" || finalGate?.merge.verified === true);

      if (delivered) {
        this.persistStatus(projectId, delivery, plan, {
          status: "delivered",
          integratedCount: required.length,
          requiredCount: required.length,
          candidate: currentCandidate,
          runId: currentRunId,
          reason: null,
        });
        this.recordEvent(project, delivery, plan, {
          kind: "delivered",
          candidate: currentCandidate,
          runId: currentRunId,
          reasons: ["final_merge_verified"],
          detail: "Verified final merge into the configured delivery target",
        });
        return this.getStatus(projectId, plan.id);
      }

      const state = this.nextState(finalGate, exhausted, result.action, result.reasons);
      this.persistStatus(projectId, delivery, plan, {
        status: state,
        integratedCount: required.length,
        requiredCount: required.length,
        candidate: currentCandidate,
        runId: currentRunId,
        reason:
          state === "needs_owner"
            ? finalGate?.reasons.join(", ") || result.reasons.join(", ") || "final_needs_owner"
            : null,
      });
      this.recordEvent(project, delivery, plan, {
        kind: state === "needs_owner" ? "needs_owner" : "verification",
        candidate: currentCandidate,
        runId: currentRunId,
        reasons: finalGate?.reasons ?? result.reasons,
        detail: `Final verification state ${state}`,
      });
      return this.getStatus(projectId, plan.id);
    } finally {
      this.releaseLease(projectId, delivery.id, ownerToken);
    }
  }

  async verifyMerge(
    projectId: string,
    planId: string,
    actor = "operator",
  ): Promise<FinalDeliveryStatus> {
    this.assertInstallationReady();
    const project = this.loadProject(projectId);
    const plan = this.loadSpecPlan(projectId, planId);
    const delivery = this.loadDelivery(projectId, plan.id);
    const row = this.loadRow(projectId, plan.id);
    if (!delivery || !row?.final_run_id) {
      throw new FinalDeliveryError(
        "final_gate_unsatisfied",
        "No final delivery run exists to verify",
      );
    }
    const gate = await this.options.gate.verifyMerge(projectId, row.final_run_id, actor);
    if (gate.state === "delivered") {
      const required = this.requiredChildren(plan);
      this.persistStatus(projectId, delivery, plan, {
        status: "delivered",
        integratedCount: required.length,
        requiredCount: required.length,
        candidate: gate.candidateHeadSha,
        runId: row.final_run_id,
        reason: null,
      });
      this.recordEvent(project, delivery, plan, {
        kind: "delivered",
        candidate: gate.candidateHeadSha,
        runId: row.final_run_id,
        reasons: ["final_merge_verified"],
        detail: `Verified by ${actor}`,
      });
    } else {
      this.persistStatus(projectId, delivery, plan, {
        status: this.nextState(gate, false, "verification_recorded", gate.reasons),
        integratedCount: this.requiredChildren(plan).length,
        requiredCount: this.requiredChildren(plan).length,
        candidate: gate.candidateHeadSha,
        runId: row.final_run_id,
        reason: gate.reasons.join(", ") || null,
      });
    }
    return this.getStatus(projectId, plan.id);
  }

  /**
   * DeliveryRuntimeCorrection implementation for final runs. It builds an isolated
   * bounded repair, verifies its merge into the frozen integration branch, then
   * materializes a fresh combined candidate for renewed QA/review.
   */
  async dispatchCorrection(
    request: DeliveryRuntimeCorrectionRequest,
  ): Promise<{ id: string } | null> {
    this.assertInstallationReady();
    const project = this.loadProject(request.projectId);
    const plan = this.loadSpecPlan(request.projectId, request.planId);
    const manifest = plan.manifest;
    if (!manifest) return null;
    const delivery = this.loadDelivery(request.projectId, plan.id);
    if (!delivery) return null;

    const findings: DispatchFinding[] = request.findings.map((finding) => ({
      summary: finding.summary,
      fileContext: finding.fileContext,
      ...(finding.acKey ? { acKey: finding.acKey } : {}),
    }));

    let repair;
    try {
      repair = await this.options.dispatch.dispatchFinalRepair(request.projectId, {
        plan_id: plan.id,
        actor: REPAIR_ACTOR,
        findings,
      });
    } catch (error) {
      this.recordEvent(project, delivery, plan, {
        kind: "correction",
        candidate: null,
        runId: request.runId,
        reasons: ["final_repair_refused"],
        detail: `Bounded final repair could not be dispatched: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return null;
    }

    if (!repair.head_sha) return null;

    const branch = this.integrationBranch(plan);
    let mergeSha: string;
    try {
      const result = await this.integration.integrateChildSerialized({
        repoRoot: project.checkout_path,
        integrationBranch: branch,
        expectedIntegrationSha: repair.base_sha,
        childBranch: repair.branch,
        childIssueNumber: plan.members.find((member) => member.role === "spec")!.issue_number,
        childHeadSha: repair.head_sha,
      });
      mergeSha = result.newSha;
    } catch {
      this.recordEvent(project, delivery, plan, {
        kind: "blocked",
        candidate: repair.head_sha,
        runId: repair.id,
        reasons: ["final_repair_conflict"],
        detail: "The final repair branch did not merge cleanly into the integration lineage",
      });
      return null;
    }

    this.syncLocalBranch(project.checkout_path, branch, mergeSha);
    this.assertInstallationReady();
    const pushed = await this.remoteRunner(project.checkout_path, [
      "push",
      "origin",
      `refs/heads/${branch}`,
    ]);
    const remoteTip = await this.fetchRemoteBranch(project.checkout_path, branch);
    if (!remoteTip || (!pushed && !this.isAncestor(project.checkout_path, mergeSha, remoteTip))) {
      this.recordEvent(project, delivery, plan, {
        kind: "blocked",
        candidate: mergeSha,
        runId: repair.id,
        reasons: ["final_repair_push_unverified"],
        detail: "The verified repair merge is not readable on the remote integration lineage",
      });
      return null;
    }
    if (!this.isAncestor(project.checkout_path, mergeSha, remoteTip)) {
      this.recordEvent(project, delivery, plan, {
        kind: "blocked",
        candidate: mergeSha,
        runId: repair.id,
        reasons: ["final_repair_lineage_unverified"],
        detail: "The repair merge is not included in the remote integration lineage",
      });
      return null;
    }

    this.syncLocalBranch(project.checkout_path, branch, remoteTip);
    const targetTip = await this.fetchAndSyncTarget(
      project.checkout_path,
      delivery.delivery_branch,
    );
    if (!targetTip) return null;

    this.recordEvent(project, delivery, plan, {
      kind: "repair_merged",
      candidate: remoteTip,
      runId: repair.id,
      reasons: [`repair_merge:${mergeSha}`],
      detail: "Bounded final repair merged into the verified integration lineage",
    });

    const materialized = this.materializeRun(
      project,
      plan,
      delivery,
      manifest,
      remoteTip,
      targetTip,
      this.requiredChildren(plan),
      this.integrationRows(
        request.projectId,
        delivery.id,
        this.requiredChildren(plan),
        this.integrationBranch(plan),
      ),
      FINAL_ACTOR,
    );
    if (!materialized.runId) {
      this.persistStatus(request.projectId, delivery, plan, {
        status: "needs_owner",
        integratedCount: this.requiredChildren(plan).length,
        requiredCount: this.requiredChildren(plan).length,
        candidate: remoteTip,
        runId: null,
        reason: materialized.reasons.join(", ") || "final_budget_exhausted",
      });
      return null;
    }
    this.persistStatus(request.projectId, delivery, plan, {
      status: "verifying",
      integratedCount: this.requiredChildren(plan).length,
      requiredCount: this.requiredChildren(plan).length,
      candidate: remoteTip,
      runId: materialized.runId,
      reason: null,
    });
    this.recordEvent(project, delivery, plan, {
      kind: "correction",
      candidate: remoteTip,
      runId: materialized.runId,
      reasons: ["renewed_verification"],
      detail: "Fresh combined candidate materialized after the bounded final repair",
    });
    return { id: materialized.runId };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /** Fail closed before any remote read, dispatch, push or forge effect. */
  private assertInstallationReady(): void {
    try {
      assertInstallationNotHeld(this.db);
    } catch (error) {
      if (error instanceof InstallationHeldError) {
        throw new FinalDeliveryError("final_installation_held", error.message);
      }
      throw error;
    }
    // Final advance/merge verification/correction are external writers. Fence
    // them during migration and when a local marker is not yet DB-verified.
    assertExternalWriterAllowed(this.db);
  }

  private acquireLease(
    project: ProjectRow,
    plan: PlanRecord,
    delivery: DeliveryRow,
    requiredCount: number,
    ownerToken: string,
  ): { acquired: boolean } {
    const now = this.clock();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.loadRow(project.id, plan.id);
      if (!existing) {
        this.db
          .prepare(
            `UPDATE deliveries
             SET final_status = 'waiting_children', required_count = ?, integrated_count = 0,
                 lease_owner = ?, lease_expires_at = ?, updated_at = ?
             WHERE project_id = ? AND id = ?`,
          )
          .run(requiredCount, ownerToken, now + this.leaseMs, now, project.id, delivery.id);
      } else {
        if (
          existing.lease_owner &&
          existing.lease_owner !== ownerToken &&
          existing.lease_expires_at !== null &&
          existing.lease_expires_at > now
        ) {
          this.db.exec("COMMIT;");
          return { acquired: false };
        }
        this.db
          .prepare(
            `UPDATE deliveries
             SET lease_owner = ?, lease_expires_at = ?, required_count = ?, updated_at = ?
             WHERE project_id = ? AND id = ?`,
          )
          .run(ownerToken, now + this.leaseMs, requiredCount, now, project.id, delivery.id);
      }
      this.db.exec("COMMIT;");
      return { acquired: true };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw new FinalDeliveryError(
        "final_storage_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private releaseLease(projectId: string, deliveryId: string, ownerToken: string): void {
    try {
      this.db
        .prepare(
          `UPDATE deliveries
           SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE project_id = ? AND id = ? AND lease_owner = ?`,
        )
        .run(this.clock(), projectId, deliveryId, ownerToken);
    } catch {
      // A released lease is recoverable by expiry; never mask the advance outcome.
    }
  }

  private persistStatus(
    projectId: string,
    delivery: DeliveryRow,
    plan: PlanRecord,
    input: {
      status: FinalDeliveryState;
      integratedCount: number;
      requiredCount: number;
      candidate: string | null;
      runId: string | null;
      reason: string | null;
    },
  ): void {
    const now = this.clock();
    const pullRequest = input.runId
      ? this.safePullRequest(projectId, input.runId)
      : { number: null, url: null };
    this.db
      .prepare(
        `UPDATE deliveries
         SET final_status = ?, candidate_head_sha = ?, final_run_id = ?, required_count = ?,
             integrated_count = ?, pull_request_number = ?, pull_request_url = ?,
             halt_reason = ?, updated_at = ?
         WHERE project_id = ? AND plan_id = ?`,
      )
      .run(
        input.status,
        input.candidate,
        input.runId,
        input.requiredCount,
        input.integratedCount,
        pullRequest.number,
        pullRequest.url,
        input.reason,
        now,
        projectId,
        plan.id,
      );
  }

  private recordEvent(
    project: ProjectRow,
    delivery: DeliveryRow,
    plan: PlanRecord,
    input: {
      kind: string;
      candidate?: string | null;
      runId?: string | null;
      reasons: string[];
      detail: string;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO delivery_events
           (id, project_id, delivery_id, plan_id, work_id, run_id, kind, candidate_head_sha,
            target_tip_sha, merge_sha, reasons, detail, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        `devt_${randomUUID()}`,
        project.id,
        delivery.id,
        plan.id,
        input.runId ?? null,
        input.kind,
        input.candidate ?? null,
        JSON.stringify(input.reasons),
        input.detail,
        this.clock(),
      );
  }

  private block(
    project: ProjectRow,
    plan: PlanRecord,
    delivery: DeliveryRow,
    status: FinalDeliveryState,
    reasons: string[],
    requiredCount: number,
    detail: string,
  ): Promise<FinalDeliveryStatus> {
    this.persistStatus(project.id, delivery, plan, {
      status,
      integratedCount: this.requiredChildren(plan).length,
      requiredCount,
      candidate: null,
      runId: this.loadRow(project.id, plan.id)?.final_run_id ?? null,
      reason: reasons.join(", "),
    });
    this.recordEvent(project, delivery, plan, {
      kind: status === "needs_owner" ? "needs_owner" : "blocked",
      reasons,
      detail,
    });
    return this.getStatus(project.id, plan.id);
  }

  // ---------------------------------------------------------------------------
  // Candidate materialization
  // ---------------------------------------------------------------------------

  private materializeRun(
    project: ProjectRow,
    plan: PlanRecord,
    delivery: DeliveryRow,
    manifest: NonNullable<PlanRecord["manifest"]>,
    candidate: string,
    targetTip: string,
    required: PlanMember[],
    integrations: Map<string, IntegrationRow>,
    actor: string,
  ): MaterializeResult {
    const existing = this.db
      .prepare(
        `SELECT id FROM dispatch_runs
         WHERE project_id = ? AND delivery_id = ? AND gate_profile = 'final'
           AND head_sha = ? AND actor = ? AND state = 'succeeded'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(project.id, delivery.id, candidate, actor) as { id: string } | undefined;
    if (existing) {
      this.ensureBuilderObservation(project.id, existing.id, actor, required, integrations);
      return { runId: existing.id, exhausted: false, reasons: [] };
    }

    const worktreePath = join(
      getProjectWorktreesDir(project.checkout_path),
      "dispatch",
      delivery.id,
      `final-${candidate.slice(0, 12)}`,
    );
    this.ensureFinalWorktree(project.checkout_path, worktreePath, candidate);

    const now = this.clock();
    const runId = `run_${randomUUID()}`;
    const requestId = `cmd_final_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const scope = this.budget.ensureScope(
        {
          ...this.scopeKey(project.id, delivery, plan),
          baseLimit: manifest.budgets.final_max_laps,
          now,
        },
        true,
      );
      if (scope.status === "exhausted") {
        this.db.exec("COMMIT;");
        return { runId: null, exhausted: true, reasons: ["budget_exhausted"] };
      }
      const lapRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(lap), 0) AS lap FROM dispatch_runs
           WHERE project_id = ? AND delivery_id = ? AND work_id = ? AND gate_profile = 'final'`,
        )
        .get(project.id, delivery.id, plan.root_work_id) as { lap: number };
      const lap = lapRow.lap + 1;
      if (lap > scope.allowedAttempts) {
        this.budget.markExhausted(
          project.id,
          scope.scopeId,
          {
            runId,
            worktreePath,
            branch: this.integrationBranch(plan),
            headSha: candidate,
            reason: "final_budget_exhausted",
          },
          now,
        );
        this.db.exec("COMMIT;");
        return { runId: null, exhausted: true, reasons: ["budget_exhausted"] };
      }
      const generation =
        (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(ownership_generation), 0) AS generation FROM dispatch_runs WHERE delivery_id = ?",
            )
            .get(delivery.id) as { generation: number }
        ).generation + 1;
      const root = plan.members.find((member) => member.role === "spec")!;
      this.db
        .prepare(
          `INSERT INTO dispatch_runs
             (id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash,
              issue_number, role, gate_profile, merge_policy, target_branch,
              ownership_generation, lap, state, actor, command_request_id, branch, worktree_path,
              base_sha, owner_pid, owner_token, lease_expires_at, head_sha, error,
              launched_at, finished_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'spec', 'final', 'manual', ?, ?, ?, 'succeeded', ?,
                   ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          project.id,
          delivery.id,
          plan.id,
          root.work_id,
          root.revision_id,
          root.content_hash,
          root.issue_number,
          delivery.delivery_branch,
          generation,
          lap,
          actor,
          requestId,
          this.integrationBranch(plan),
          worktreePath,
          targetTip,
          randomUUID(),
          candidate,
          now,
          now,
          now,
          now,
        );
      this.budget.recordConsumed(project.id, scope.scopeId, lap, now);
      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed/i.test(message)) {
        const raced = this.db
          .prepare(
            `SELECT id FROM dispatch_runs
             WHERE project_id = ? AND delivery_id = ? AND gate_profile = 'final' AND head_sha = ?
             LIMIT 1`,
          )
          .get(project.id, delivery.id, candidate) as { id: string } | undefined;
        if (raced) {
          this.ensureBuilderObservation(project.id, raced.id, actor, required, integrations);
          return { runId: raced.id, exhausted: false, reasons: [] };
        }
      }
      throw new FinalDeliveryError("final_storage_failed", message);
    }

    this.ensureBuilderObservation(project.id, runId, actor, required, integrations);
    return { runId, exhausted: false, reasons: [] };
  }

  private ensureBuilderObservation(
    projectId: string,
    runId: string,
    fallbackActor: string,
    required: PlanMember[],
    integrations: Map<string, IntegrationRow>,
  ): void {
    if (this.options.observations.latestObservation(projectId, runId, "builder_execution")) {
      return;
    }
    const row = this.db
      .prepare("SELECT actor FROM dispatch_runs WHERE project_id = ? AND id = ?")
      .get(projectId, runId) as { actor: string } | undefined;
    const actor = row?.actor ?? fallbackActor;
    this.options.observations.recordRunObservation(projectId, runId, {
      stage: "builder_execution",
      status: "passed",
      producer: { id: actor, role: "builder", name: "final-integrator" },
      checks: required.map((member) => {
        const integration = integrations.get(member.work_id);
        return {
          name: `child #${member.issue_number} included`,
          command: `child_integration:${integration?.remote_pull_request_number ?? "-"}`,
          result: "PASS" as const,
          kind: "contract" as const,
          detail: integration
            ? `candidate ${integration.candidate_head_sha} merge ${integration.merge_sha}`
            : "included in the verified integration lineage",
        };
      }),
      findings: [],
      artifacts: [],
    });
  }

  private ensureFinalWorktree(checkoutPath: string, worktreePath: string, candidate: string): void {
    if (!existsSync(worktreePath)) {
      this.gitRunner(["worktree", "add", "--detach", worktreePath, candidate], checkoutPath);
      return;
    }
    try {
      this.gitRunner(["checkout", "--detach", candidate], worktreePath);
    } catch {
      this.gitRunner(
        ["worktree", "add", "--force", "--detach", worktreePath, candidate],
        checkoutPath,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Remote lineage
  // ---------------------------------------------------------------------------

  private async fetchRemoteBranch(checkoutPath: string, branch: string): Promise<string | null> {
    const ref = `refs/animus/final-verify/${randomUUID()}`;
    try {
      const fetched = await this.gitRemote(
        ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:${ref}`],
        checkoutPath,
      );
      if (fetched.timedOut || fetched.exitCode !== 0) return null;
      return this.gitRunner(["rev-parse", ref], checkoutPath);
    } catch {
      return null;
    } finally {
      try {
        this.gitRunner(["update-ref", "-d", ref], checkoutPath);
      } catch {}
    }
  }

  private async fetchAndSyncTarget(checkoutPath: string, branch: string): Promise<string | null> {
    const tip = await this.fetchRemoteBranch(checkoutPath, branch);
    if (!tip) return null;
    try {
      this.syncLocalBranch(checkoutPath, branch, tip);
    } catch {
      return null;
    }
    return tip;
  }

  private syncLocalBranch(checkoutPath: string, branch: string, sha: string): void {
    const ref = `refs/heads/${branch.replace(/^refs\/heads\//, "")}`;
    let current: string | null = null;
    try {
      current = this.gitRunner(["rev-parse", ref], checkoutPath);
    } catch {
      current = null;
    }
    if (current === sha) return;
    if (current) {
      this.gitRunner(["update-ref", ref, sha, current], checkoutPath);
    } else {
      this.gitRunner(["update-ref", ref, sha], checkoutPath);
    }
  }

  private childLineageReasons(
    checkoutPath: string,
    integrations: Map<string, IntegrationRow>,
    remoteTip: string,
  ): string[] {
    const reasons: string[] = [];
    for (const integration of integrations.values()) {
      if (!this.isAncestor(checkoutPath, integration.candidate_head_sha, remoteTip)) {
        reasons.push(`child_lineage_unverified:#${integration.issue_number}`);
      }
      if (!this.isAncestor(checkoutPath, integration.merge_sha, remoteTip)) {
        reasons.push(`child_merge_unverified:#${integration.issue_number}`);
      }
      if (!this.isAncestor(checkoutPath, integration.target_tip_after_sha, remoteTip)) {
        reasons.push(`child_target_unverified:#${integration.issue_number}`);
      }
    }
    return reasons;
  }

  private async mergeTargetIntoIntegration(
    project: ProjectRow,
    delivery: DeliveryRow,
    integrationTip: string,
    targetTip: string,
  ): Promise<string | null> {
    const branch = delivery.integration_branch ?? `factory/spec-final-${delivery.id}`;
    let treeSha: string;
    try {
      const output = this.gitRunner(
        ["merge-tree", "--write-tree", integrationTip, targetTip],
        project.checkout_path,
      );
      treeSha = output.split("\n")[0]!.trim();
      if (!/^[a-f0-9]{40,64}$/.test(treeSha)) return null;
    } catch {
      return null;
    }
    let mergeSha: string;
    try {
      mergeSha = this.gitRunner(
        [
          "commit-tree",
          treeSha,
          "-p",
          integrationTip,
          "-p",
          targetTip,
          "-m",
          `merge delivery target ${delivery.delivery_branch} into ${branch}`,
        ],
        project.checkout_path,
      );
    } catch {
      return null;
    }
    try {
      this.syncLocalBranch(project.checkout_path, branch, mergeSha);
    } catch {
      return null;
    }
    this.assertInstallationReady();
    await this.remoteRunner(project.checkout_path, ["push", "origin", `refs/heads/${branch}`]);
    const remoteTip = await this.fetchRemoteBranch(project.checkout_path, branch);
    if (!remoteTip) return null;
    if (!this.isAncestor(project.checkout_path, mergeSha, remoteTip)) return null;
    this.syncLocalBranch(project.checkout_path, branch, remoteTip);
    return remoteTip;
  }

  private async remoteRunner(checkoutPath: string, args: string[]): Promise<boolean> {
    try {
      const result = await this.gitRemote(args, checkoutPath);
      return !result.timedOut && result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private isAncestor(checkoutPath: string, ancestor: string, descendant: string): boolean {
    try {
      this.gitRunner(["merge-base", "--is-ancestor", ancestor, descendant], checkoutPath);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Reads and mapping
  // ---------------------------------------------------------------------------

  private loadProject(projectId: string): ProjectRow {
    const row = this.db
      .prepare("SELECT id, repo_name, checkout_path, status FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
    if (!row) {
      throw new FinalDeliveryError("final_project_not_found", `Project ${projectId} not found`);
    }
    if (row.status !== "active") {
      throw new FinalDeliveryError(
        "final_project_not_active",
        `Project ${projectId} is ${row.status}`,
      );
    }
    return row;
  }

  private loadSpecPlan(projectId: string, planId: string): PlanRecord {
    let plan: PlanRecord;
    try {
      plan = this.options.plans.getPlan(projectId, planId);
    } catch {
      throw new FinalDeliveryError("final_plan_not_found", `Plan ${planId} not found`);
    }
    if (plan.kind !== "spec") {
      throw new FinalDeliveryError(
        "final_plan_not_spec",
        "Final delivery coordination applies only to spec plans",
      );
    }
    return plan;
  }

  private loadAdmittedSpec(projectId: string, planId: string): PlanRecord {
    const plan = this.loadSpecPlan(projectId, planId);
    if (plan.authority !== "admitted" || !plan.manifest || !plan.dispatchable) {
      throw new FinalDeliveryError(
        "final_plan_not_admitted",
        "Final delivery requires the exact admitted manifest",
      );
    }
    return plan;
  }

  private loadDelivery(projectId: string, planId: string): DeliveryRow | null {
    const row = this.db
      .prepare(
        `SELECT id, manifest_id, graph_hash, integration_branch, delivery_branch, final_pr_base
         FROM deliveries WHERE project_id = ? AND plan_id = ?`,
      )
      .get(projectId, planId) as DeliveryRow | undefined;
    return row ?? null;
  }

  private loadRow(projectId: string, planId: string): FinalRow | null {
    const row = this.db
      .prepare(
        `SELECT final_status AS status, candidate_head_sha, final_run_id, required_count,
                integrated_count, pull_request_number, pull_request_url, halt_reason,
                lease_owner, lease_expires_at, updated_at
         FROM deliveries
         WHERE project_id = ? AND plan_id = ? AND final_status IS NOT NULL`,
      )
      .get(projectId, planId) as FinalRow | undefined;
    return row ?? null;
  }

  private requiredChildren(plan: PlanRecord): PlanMember[] {
    return plan.members
      .filter((member) => member.role === "ticket" && member.gate_profile === "child")
      .sort((left, right) => left.issue_number - right.issue_number);
  }

  private integrationBranch(plan: PlanRecord): string {
    return plan.integration_branch ?? `factory/spec-${this.rootIssue(plan)}-integration`;
  }

  private rootIssue(plan: PlanRecord): number {
    return plan.members.find((member) => member.role === "spec")?.issue_number ?? 0;
  }

  private scopeKey(projectId: string, delivery: DeliveryRow, plan: PlanRecord): BudgetScopeKey {
    return {
      projectId,
      deliveryId: delivery.id,
      planId: plan.id,
      workId: plan.root_work_id,
      gateProfile: "final",
    };
  }

  private integrationRows(
    projectId: string,
    deliveryId: string,
    required: PlanMember[],
    targetBranch: string | null,
  ): Map<string, IntegrationRow> {
    const map = new Map<string, IntegrationRow>();
    if (!targetBranch) return map;
    for (const member of required) {
      const row = this.db
        .prepare(
          `SELECT work_id, issue_number, candidate_head_sha, merge_sha, target_tip_before_sha,
                  target_tip_after_sha, target_branch,
                  pr_number AS remote_pull_request_number,
                  pr_url AS remote_pull_request_url
           FROM delivery_merges
           WHERE project_id = ? AND delivery_id = ? AND work_id = ? AND target_branch = ?
             AND gate_profile = 'child'`,
        )
        .get(projectId, deliveryId, member.work_id, targetBranch) as IntegrationRow | undefined;
      if (row) map.set(member.work_id, row);
    }
    return map;
  }

  private childStatuses(
    plan: PlanRecord,
    required: PlanMember[],
    integrations: Map<string, IntegrationRow>,
  ): FinalDeliveryChild[] {
    return required.map((member) => {
      const integration = integrations.get(member.work_id);
      return {
        workId: member.work_id,
        issueNumber: member.issue_number,
        title: this.memberTitle(plan, member),
        gateProfile: member.gate_profile,
        integrated: Boolean(integration),
        candidateHeadSha: integration?.candidate_head_sha ?? null,
        mergeSha: integration?.merge_sha ?? null,
        targetBranch: integration?.target_branch ?? null,
        pullRequestNumber: integration?.remote_pull_request_number ?? null,
        pullRequestUrl: integration?.remote_pull_request_url ?? null,
        reasons: integration ? [] : [`child_not_integrated:#${member.issue_number}`],
      };
    });
  }

  private memberTitle(plan: PlanRecord, member: PlanMember): string {
    const row = this.db
      .prepare(
        "SELECT source_title FROM work_revisions WHERE id = ? AND work_id = ? AND project_id = ?",
      )
      .get(member.revision_id, member.work_id, plan.project_id) as
      | { source_title: string }
      | undefined;
    return row?.source_title ?? `#${member.issue_number}`;
  }

  private deriveState(
    row: FinalRow | null,
    gate: DeliveryGateStatus | null,
    delivered: boolean,
    integratedCount: number,
    requiredCount: number,
  ): FinalDeliveryState {
    if (delivered) return "delivered";
    if (gate?.state === "awaiting_merge_verification") return "awaiting_merge_verification";
    if (gate?.state === "ready_for_operator_review" || gate?.state === "awaiting_manual_merge") {
      return "awaiting_manual_merge";
    }
    if (!gate && row?.status) {
      if (
        row.status === "needs_owner" ||
        row.status === "blocked" ||
        row.status === "waiting_children" ||
        row.status === "remote_unavailable"
      ) {
        return row.status;
      }
    }
    if (row?.status === "needs_owner") return "needs_owner";
    if (integratedCount < requiredCount) {
      return row?.status === "blocked" ? "blocked" : "waiting_children";
    }
    if (gate) return "blocked";
    return "verifying";
  }

  private nextState(
    gate: DeliveryGateStatus | null,
    exhausted: boolean,
    action: string,
    reasons: string[],
  ): FinalDeliveryState {
    if (gate?.state === "delivered") return "delivered";
    if (gate?.state === "awaiting_merge_verification") return "awaiting_merge_verification";
    if (gate?.state === "ready_for_operator_review" || gate?.state === "awaiting_manual_merge") {
      return "awaiting_manual_merge";
    }
    if (exhausted || action === "failed" || reasons.some((reason) => reason.includes("budget"))) {
      return "needs_owner";
    }
    if (action === "stopped") return "verifying";
    if (gate) return "blocked";
    return "verifying";
  }

  private finalBudgetExhausted(
    projectId: string,
    delivery: DeliveryRow,
    plan: PlanRecord,
  ): boolean {
    const scope = this.budget.getScope(this.scopeKey(projectId, delivery, plan));
    return scope?.status === "exhausted";
  }

  private statusReasons(
    row: FinalRow | null,
    gate: DeliveryGateStatus | null,
    children: FinalDeliveryChild[],
    integratedCount: number,
    requiredCount: number,
  ): string[] {
    const reasons = new Set<string>();
    for (const child of children) {
      for (const reason of child.reasons) reasons.add(reason);
    }
    if (integratedCount < requiredCount) reasons.add("children_pending");
    for (const reason of gate?.reasons ?? []) reasons.add(reason);
    if (row?.halt_reason) reasons.add(row.halt_reason);
    return [...reasons];
  }

  private pullRequestSummary(
    projectId: string,
    row: FinalRow | null,
    gate: DeliveryGateStatus | null,
  ) {
    if (!row?.final_run_id) return null;
    const status = this.safePublicationStatus(projectId, row.final_run_id);
    const active =
      status?.pullRequests.find((pullRequest) => pullRequest.active) ??
      (status && status.pullRequests.length > 0
        ? status.pullRequests[status.pullRequests.length - 1]!
        : null);
    const publication = gate?.publication;
    const number = active?.number ?? publication?.prNumber ?? null;
    if (!number) return null;
    return {
      number,
      url: active?.url ?? publication?.url ?? null,
      headBranch: active?.headBranch ?? publication?.headBranch ?? "integration",
      baseBranch: active?.baseBranch ?? publication?.baseBranch ?? "main",
      headRefOid: active?.headRefOid ?? publication?.headRefOid ?? null,
      state: active?.state ?? publication?.remoteState ?? "open",
      draft: active?.draft ?? publication?.draft ?? true,
      mergeCommitOid: publication?.mergeCommitOid ?? null,
    };
  }

  private safePublicationStatus(projectId: string, runId: string): PublicationStatus | null {
    try {
      return this.options.publication.getStatusByRun(projectId, runId);
    } catch {
      return null;
    }
  }

  private safePullRequest(
    projectId: string,
    runId: string,
  ): { number: number | null; url: string | null } {
    const status = this.safePublicationStatus(projectId, runId);
    const active =
      status?.pullRequests.find((pullRequest) => pullRequest.active) ??
      (status && status.pullRequests.length > 0
        ? status.pullRequests[status.pullRequests.length - 1]!
        : null);
    return { number: active?.number ?? null, url: active?.url ?? null };
  }
}
