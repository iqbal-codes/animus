import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  planDispatchRunSchema,
  type FrozenContract,
  type PlanDispatchReconciliation,
  type PlanDispatchRun,
  type PlanDispatchSubmission,
  type PlanGateProfile,
  type PlanManifest,
  type PlanMember,
  type PlanRecord,
} from "@animus/contracts/operator";
import {
  countActiveLaps,
  getProjectWorktreesDir,
  isPidAlive,
  loadScheduleConfig,
  resolveAnimusStateDir,
  resolveProjectWorkspace,
} from "@animus/contracts/paths";
import { BrakeService } from "../command/brakes";
import { CommandLedger } from "../command/ledger";
import { readVerifiedBranchIntegrations } from "../intake/admission";
import { PlanError, PlanService } from "../plans";
import { graphFromManifest, computeGraphHash } from "../plans/parser";
import { freezeContract } from "../coordination/primitive";
import { runFrozenBuilder } from "../coordination/frozen-builder";
import type { AgentTransport, RoleBudget } from "../coordination/frozen-builder";
import {
  clearWorkerOwner,
  pidOrGroupAlive,
  readWorkerOwner,
  resolveWorkerOwnerPath,
  writeWorkerOwner,
} from "./ownership";
import { readExecutionAuthority, type ExecutionAuthority } from "./authority";
import {
  allocateWorktree,
  type WorktreeAllocation,
  type WorktreeAllocationOptions,
} from "../coordination/worktree";

export type DispatchErrorCode =
  | "project_not_found"
  | "project_not_active"
  | "plan_not_found"
  | "plan_not_dispatchable"
  | "manifest_mismatch"
  | "member_not_in_plan"
  | "parent_not_dispatchable"
  | "already_succeeded"
  | "no_dispatchable_member"
  | "dependency_pending_integration"
  | "launch_brake_set"
  | "schedule_paused"
  | "brake_state_unknown"
  | "capacity_full"
  | "claim_conflict"
  | "stale_worker"
  | "storage_failed"
  | "worktree_allocation_failed"
  | "dispatch_failed"
  | "run_not_found"
  | "run_not_active"
  | "owner_still_alive"
  | "external_effect_unverified"
  | "authority_not_activated"
  | "invalid_submission";

export class DispatchError extends Error {
  constructor(
    public readonly code: DispatchErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "DispatchError";
  }
}

export interface DispatchRunnerContext {
  run_id: string;
  command_request_id: string;
  ownership_generation: number;
  owner_token: string;
  project_id: string;
  project_root: string;
  plan_id: string;
  work_id: string;
  revision_id: string;
  issue_number: number;
  spec_issue_number: number;
  gate_profile: PlanGateProfile;
  merge_policy: "auto_after_gates" | "manual";
  branch: string;
  worktree_path: string;
  base_sha: string;
  target_branch: string;
  contract: FrozenContract;
  contract_body: string;
}

export interface DispatchRunResult {
  success: boolean;
  headSha?: string;
  error?: string;
  exitCode?: number;
}

export type DispatchRunner = (context: DispatchRunnerContext) => Promise<DispatchRunResult>;

export interface DispatchEngineOptions {
  /** External model/process transport. Internal dispatch callbacks are not injectable here. */
  transport?: AgentTransport;
  provider?: string;
  model?: string;
  effort?: string;
  budget?: RoleBudget;
  maxContinuations?: number;
}

type DispatchLedger = Pick<
  CommandLedger,
  "recordBeforeDispatch" | "recordRejection" | "updateOutcome" | "markReconciled"
>;
type DispatchBrakes = Pick<BrakeService, "isLaunchPermitted" | "isScheduledLaunchPermitted">;

export interface DispatchServiceOptions {
  plans: PlanService;
  ledger?: DispatchLedger;
  brakes?: DispatchBrakes;
  worktreeAllocator?: (options: WorktreeAllocationOptions) => WorktreeAllocation;
  runner?: DispatchRunner;
  processAlive?: (pid: number) => boolean;
  ownerPid?: () => number;
  clock?: () => number;
  leaseMs?: number;
  schedule?: (checkoutPath: string) => { parallel: number; max_laps: number };
  legacyActiveLaps?: (checkoutPath: string) => number;
  gitRunner?: (cmd: string[], options: { cwd: string }) => string;
  authority?: () => ExecutionAuthority;
  engine?: DispatchEngineOptions;
}

interface ProjectRow {
  id: string;
  name: string;
  repo_id: number;
  repo_name: string;
  checkout_path: string;
  status: "active" | "held" | "tombstone";
}

interface DispatchRunRow {
  id: string;
  project_id: string;
  delivery_id: string;
  plan_id: string;
  work_id: string;
  revision_id: string;
  content_hash: string;
  issue_number: number;
  role: "spec" | "ticket";
  gate_profile: PlanGateProfile;
  merge_policy: "auto_after_gates" | "manual";
  target_branch: string;
  ownership_generation: number;
  state: PlanDispatchRun["state"];
  actor: string;
  command_request_id: string;
  branch: string;
  worktree_path: string;
  base_sha: string;
  owner_pid: number | null;
  owner_token: string;
  lease_expires_at: number | null;
  head_sha: string | null;
  error: string | null;
  launched_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ClaimedRun {
  run: PlanDispatchRun;
  context: Omit<DispatchRunnerContext, "contract" | "contract_body">;
}

type DispatchSubmission = PlanDispatchSubmission & { scheduled?: boolean };

const ACTIVE_STATES = ["claimed", "dispatched", "running", "interrupted"] as const;
const ACTIVE_SQL = "('claimed', 'dispatched', 'running', 'interrupted')";
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function activeStateCondition(): string {
  return `state IN ${ACTIVE_SQL}`;
}

function defaultGitRunner(cmd: string[], options: { cwd: string }): string {
  return execFileSync("git", cmd, {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createDefaultRunner(engine: DispatchEngineOptions = {}): DispatchRunner {
  return async (context: DispatchRunnerContext): Promise<DispatchRunResult> => {
    const result = await runFrozenBuilder({
      projectRoot: context.project_root,
      worktreePath: context.worktree_path,
      branch: context.branch,
      baseSha: context.base_sha,
      issueNumber: context.issue_number,
      specIssueNumber: context.spec_issue_number,
      contractBody: context.contract_body,
      runId: context.run_id,
      runDirectory: join(resolveAnimusStateDir(), "dispatch", context.run_id),
      transport: engine.transport,
      provider: engine.provider,
      model: engine.model,
      effort: engine.effort,
      budget: engine.budget,
      maxContinuations: engine.maxContinuations,
      onWorkerSpawn: (pid) => {
        writeWorkerOwner({
          run_id: context.run_id,
          owner_token: context.owner_token,
          pid,
          pgid: pid,
        });
      },
    });
    return {
      success: result.success,
      headSha: result.headSha,
      error: result.error,
      exitCode: result.exitCode,
    };
  };
}

export class DispatchService {
  private readonly plans: PlanService;
  private readonly ledger: DispatchLedger;
  private readonly brakes: DispatchBrakes;
  private readonly worktreeAllocator: (options: WorktreeAllocationOptions) => WorktreeAllocation;
  private readonly runner: DispatchRunner;
  private readonly processAlive: (pid: number) => boolean;
  private readonly ownerPid: () => number;
  private readonly clock: () => number;
  private readonly leaseMs: number;
  private readonly schedule: (checkoutPath: string) => { parallel: number; max_laps: number };
  private readonly legacyActiveLaps: (checkoutPath: string) => number;
  private readonly gitRunner: (cmd: string[], options: { cwd: string }) => string;
  private readonly authority: () => ExecutionAuthority;

  constructor(
    private readonly db: DatabaseSync,
    options: DispatchServiceOptions,
  ) {
    this.plans = options.plans;
    this.ledger = options.ledger ?? new CommandLedger(db);
    this.brakes = options.brakes ?? new BrakeService(db);
    this.worktreeAllocator = options.worktreeAllocator ?? allocateWorktree;
    this.runner = options.runner ?? createDefaultRunner(options.engine);
    this.processAlive = options.processAlive ?? ((pid) => isPidAlive(pid));
    this.ownerPid = options.ownerPid ?? (() => process.pid);
    this.clock = options.clock ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.schedule = options.schedule ?? ((checkoutPath) => loadScheduleConfig(checkoutPath));
    this.legacyActiveLaps =
      options.legacyActiveLaps ??
      ((checkoutPath) => countActiveLaps(resolveProjectWorkspace(checkoutPath).runsDir));
    this.gitRunner = options.gitRunner ?? defaultGitRunner;
    this.authority = options.authority ?? (() => readExecutionAuthority().authority);
  }

  async dispatch(projectId: string, submission: DispatchSubmission): Promise<PlanDispatchRun> {
    if (!submission || typeof submission.plan_id !== "string" || submission.plan_id.trim() === "") {
      throw new DispatchError("invalid_submission", "plan_id is required");
    }
    this.assertAuthority();
    const project = this.getProject(projectId);
    const plan = this.loadPlan(projectId, submission.plan_id);
    const manifest = this.verifiedManifest(plan);
    const targetBranch = this.targetBranch(plan, manifest);
    const member = this.selectMember(project, plan, manifest, submission);
    this.assertProfile(plan, member);

    const blocked = this.dependencyBlock(project, plan, manifest, member, targetBranch);
    if (blocked !== null) {
      throw new DispatchError(
        "dependency_pending_integration",
        `Prerequisite #${blocked} is not verified on the frozen target ${targetBranch}`,
        { target_issue_number: blocked, target_branch: targetBranch },
      );
    }

    this.assertBrakes(project, submission, targetBranch);

    const activeRuns = this.countActiveRuns(projectId);
    const legacy = this.legacyActiveLaps(project.checkout_path);
    const capacity = this.schedule(project.checkout_path).parallel;
    if (activeRuns + legacy >= capacity) {
      this.recordRejection(project, submission, "capacity_full", {
        plan_id: plan.id,
        work_id: member.work_id,
        active_runs: activeRuns + legacy,
        capacity,
      });
      throw new DispatchError(
        "capacity_full",
        `Project capacity is full (${activeRuns + legacy}/${capacity})`,
      );
    }

    const revision = this.readFrozenRevision(project.id, member);
    const contract = freezeContract(revision);

    const requestId = `cmd_dispatch_${randomUUID()}`;
    const mergePolicy: "auto_after_gates" | "manual" =
      member.gate_profile === "child" ? "auto_after_gates" : "manual";

    // Durable command/audit record before any tool (including git worktree) starts.
    try {
      this.ledger.recordBeforeDispatch({
        requestId,
        actor: submission.actor ?? "operator",
        projectId,
        action: "dispatch",
        target: {
          plan_id: plan.id,
          work_id: member.work_id,
          revision_id: member.revision_id,
          issue_number: member.issue_number,
          graph_hash: plan.graph_hash,
          gate_profile: member.gate_profile,
          target_branch: targetBranch,
        },
      });
    } catch (error) {
      throw new DispatchError(
        "storage_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    let baseSha: string;
    let branch: string;
    try {
      baseSha = this.resolveBaseSha(project.checkout_path, targetBranch);
      branch = this.uniqueBranch(
        project.id,
        project.checkout_path,
        this.branchFor(manifest, member),
        member.work_id,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failCommand(requestId, "worktree_allocation_failed", message);
      throw new DispatchError("worktree_allocation_failed", message);
    }

    let claimed: ClaimedRun;
    try {
      claimed = this.claim({
        project,
        plan,
        manifest,
        member,
        targetBranch,
        baseSha,
        branch,
        mergePolicy,
        requestId,
        actor: submission.actor ?? "operator",
        scheduled: Boolean(submission.scheduled),
        runId: `run_${randomUUID()}`,
      });
    } catch (error) {
      if (error instanceof DispatchError) {
        this.failCommand(requestId, error.code, error.message);
        throw error;
      }
      this.failCommand(requestId, "storage_failed", String(error));
      throw new DispatchError(
        "storage_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    let allocation: WorktreeAllocation;
    try {
      allocation = this.worktreeAllocator({
        repoRoot: project.checkout_path,
        worktreeDir: claimed.run.worktree_path,
        branch: claimed.run.branch,
        startSha: claimed.run.base_sha,
        issueNumber: claimed.run.issue_number,
        runId: claimed.run.id,
        gitRunner: this.gitRunner,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markRunFailed(claimed.run.id, message);
      this.failCommand(requestId, "worktree_allocation_failed", message);
      throw new DispatchError("worktree_allocation_failed", message);
    }

    this.markRunRunning(claimed.run.id);
    this.updateCommand(requestId, "running", undefined);

    let result: DispatchRunResult;
    try {
      result = await this.runner({
        ...claimed.context,
        contract,
        contract_body: revision,
      });
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) };
    }

    try {
      return this.finalize(claimed.run, result);
    } finally {
      allocation.releaseLock();
    }
  }

  listRuns(projectId: string, options?: { plan_id?: string }): PlanDispatchRun[] {
    const rows = options?.plan_id
      ? (this.db
          .prepare(
            "SELECT * FROM dispatch_runs WHERE project_id = ? AND plan_id = ? ORDER BY created_at DESC, id DESC",
          )
          .all(projectId, options.plan_id) as unknown as DispatchRunRow[])
      : (this.db
          .prepare(
            "SELECT * FROM dispatch_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC",
          )
          .all(projectId) as unknown as DispatchRunRow[]);
    return rows.map((row) => this.mapRun(row));
  }

  getRun(projectId: string, runId: string): PlanDispatchRun {
    const row = this.db
      .prepare("SELECT * FROM dispatch_runs WHERE project_id = ? AND id = ?")
      .get(projectId, runId) as unknown as DispatchRunRow | undefined;
    if (!row) throw new DispatchError("run_not_found", `Run ${runId} not found`);
    return this.mapRun(row);
  }

  reconcile(projectId?: string): PlanDispatchReconciliation {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT * FROM dispatch_runs WHERE project_id = ? AND ${activeStateCondition()} ORDER BY created_at ASC`,
          )
          .all(projectId) as unknown as DispatchRunRow[])
      : (this.db
          .prepare(
            `SELECT * FROM dispatch_runs WHERE ${activeStateCondition()} ORDER BY created_at ASC`,
          )
          .all() as unknown as DispatchRunRow[]);

    const retained: PlanDispatchRun[] = [];
    for (const row of rows) {
      if (row.owner_pid !== null && this.processAlive(row.owner_pid)) {
        retained.push(this.mapRun(row));
        continue;
      }
      // Process liveness cannot prove external effects. Retain the claim as interrupted
      // until an explicit reconciliation inspects the worktree and releases it.
      const now = this.clock();
      this.db
        .prepare(
          `UPDATE dispatch_runs
           SET state = 'interrupted',
               error = COALESCE(error, 'owner_process_gone_pending_reconciliation'),
               updated_at = ?
           WHERE id = ? AND ${activeStateCondition()}`,
        )
        .run(now, row.id);
      retained.push(this.getRun(row.project_id, row.id));
    }

    return {
      reconciled: [],
      retained,
      timestamp: new Date(this.clock()).toISOString(),
    };
  }

  reconcileRun(projectId: string, runId: string): PlanDispatchRun {
    const run = this.getRun(projectId, runId);
    if (!(ACTIVE_STATES as readonly string[]).includes(run.state)) {
      throw new DispatchError("run_not_active", `Run ${runId} is already terminal (${run.state})`);
    }
    if (run.owner_pid !== null && this.processAlive(run.owner_pid)) {
      throw new DispatchError(
        "owner_still_alive",
        `Run ${runId} is still owned by live pid ${run.owner_pid}`,
      );
    }

    const observedHead = this.inspectRunEffects(run);
    const now = this.clock();
    const changed = this.db
      .prepare(
        `UPDATE dispatch_runs
         SET state = 'reconciled',
             head_sha = COALESCE(?, head_sha),
             error = 'operator_reconciled_after_process_and_effect_check',
             finished_at = ?,
             updated_at = ?
         WHERE id = ? AND project_id = ? AND ${activeStateCondition()}`,
      )
      .run(observedHead, now, now, runId, projectId) as { changes: number };
    if (changed.changes === 0) {
      throw new DispatchError("run_not_active", `Run ${runId} is no longer active`);
    }

    clearWorkerOwner(runId);

    try {
      this.ledger.markReconciled(run.command_request_id, {
        state: "failed",
        provenance: {
          source: "dispatch_reconciliation",
          timestamp: new Date(now).toISOString(),
          actor: "operator",
          details: observedHead
            ? `reconciled after observing worktree head ${observedHead}`
            : "reconciled after confirming no worktree effect",
        },
        error: "owner_process_gone",
      });
    } catch {
      // The dispatch record is already terminal; command audit reconciliation is best-effort
      // here but never changes the run outcome.
    }

    return this.getRun(projectId, runId);
  }

  private finalize(run: PlanDispatchRun, result: DispatchRunResult): PlanDispatchRun {
    const verified = this.verifyCandidate(run, result);
    const current = this.db
      .prepare("SELECT * FROM dispatch_runs WHERE id = ?")
      .get(run.id) as unknown as DispatchRunRow | undefined;
    if (
      !current ||
      current.ownership_generation !== run.ownership_generation ||
      current.owner_token !== run.owner_token ||
      !(ACTIVE_STATES as readonly string[]).includes(current.state)
    ) {
      this.failCommand(
        run.command_request_id,
        "stale_worker",
        "result superseded by a newer owner",
      );
      throw new DispatchError(
        "stale_worker",
        "Worker result was superseded by a newer ownership generation",
      );
    }

    const now = this.clock();
    const nextState = verified.success ? "succeeded" : "failed";
    const error = verified.success ? null : (verified.error ?? "dispatch_failed");
    const changed = this.db
      .prepare(
        `UPDATE dispatch_runs
         SET state = ?, head_sha = ?, error = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND ownership_generation = ? AND owner_token = ?
           AND state IN ('running', 'dispatched', 'interrupted')`,
      )
      .run(
        nextState,
        verified.success ? (verified.headSha ?? null) : null,
        error,
        now,
        now,
        run.id,
        run.ownership_generation,
        run.owner_token,
      ) as { changes: number };

    if (changed.changes === 0) {
      this.failCommand(
        run.command_request_id,
        "stale_worker",
        "result superseded by a newer owner",
      );
      throw new DispatchError(
        "stale_worker",
        "Worker result was superseded by a newer ownership generation",
      );
    }

    clearWorkerOwner(run.id);

    if (verified.success) {
      this.updateCommand(run.command_request_id, "succeeded", verified.headSha);
      return this.getRun(run.project_id, run.id);
    }

    this.failCommand(run.command_request_id, "dispatch_failed", error ?? "dispatch_failed");
    throw new DispatchError("dispatch_failed", error ?? "dispatch_failed", { run_id: run.id });
  }

  /**
   * A runner's `success: true` is not evidence by itself: the candidate must be a
   * real commit in the dispatched worktree, and it is the SHA recorded for the run.
   */
  private verifyCandidate(run: PlanDispatchRun, result: DispatchRunResult): DispatchRunResult {
    if (!result.success) return result;
    const head = result.headSha;
    if (!head || !COMMIT_SHA.test(head)) {
      return {
        success: false,
        error: "dispatch runner reported success without a valid candidate head",
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      };
    }
    try {
      this.gitRunner(["cat-file", "-e", `${head}^{commit}`], { cwd: run.worktree_path });
    } catch {
      return {
        success: false,
        error: `dispatch runner candidate ${head} is not a committed object`,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      };
    }
    return result;
  }

  private assertAuthority(): void {
    if (this.authority() !== "local") {
      throw new DispatchError(
        "authority_not_activated",
        "Local execution authority is not activated; complete the validated #165 cutover before dispatching",
      );
    }
  }

  private claim(input: {
    project: ProjectRow;
    plan: PlanRecord;
    manifest: PlanManifest;
    member: PlanMember;
    targetBranch: string;
    baseSha: string;
    branch: string;
    mergePolicy: "auto_after_gates" | "manual";
    requestId: string;
    actor: string;
    scheduled?: boolean;
    runId: string;
  }): ClaimedRun {
    const {
      project,
      plan,
      manifest,
      member,
      targetBranch,
      baseSha,
      branch,
      mergePolicy,
      requestId,
      actor,
      scheduled,
      runId,
    } = input;
    const manifestRow = this.db
      .prepare("SELECT id FROM plan_manifests WHERE plan_id = ? AND graph_hash = ?")
      .get(plan.id, plan.graph_hash) as { id: string } | undefined;
    if (!manifestRow) {
      throw new DispatchError("manifest_mismatch", "Frozen plan manifest is missing");
    }

    const now = this.clock();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      // Revalidate the latest durable authority inside the same serialized write that
      // allocates the claim. Pre-claim checks race with revocation, brakes and other
      // processes; only this check can fail closed before tools start.
      this.revalidateClaim({
        project,
        plan,
        manifest,
        member,
        targetBranch,
        scheduled: Boolean(scheduled),
      });

      let delivery = this.db
        .prepare("SELECT * FROM deliveries WHERE project_id = ? AND plan_id = ?")
        .get(project.id, plan.id) as
        | {
            id: string;
            graph_hash: string;
            manifest_id: string;
            delivery_branch: string;
            integration_branch: string | null;
            final_pr_base: string;
          }
        | undefined;

      if (!delivery) {
        const deliveryId = `del_${randomUUID()}`;
        this.db
          .prepare(
            `INSERT INTO deliveries
               (id, project_id, plan_id, kind, delivery_branch, integration_branch, final_pr_base,
                merge_policy_child, merge_policy_standalone, merge_policy_final, manifest_id,
                graph_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            deliveryId,
            project.id,
            plan.id,
            plan.kind,
            manifest.targets.delivery_branch,
            manifest.targets.integration_branch,
            manifest.targets.final_pr_base,
            manifest.merge_policy.child,
            manifest.merge_policy.standalone,
            manifest.merge_policy.final,
            manifestRow.id,
            manifest.graph_hash,
            now,
            now,
          );
        delivery = {
          id: deliveryId,
          graph_hash: manifest.graph_hash,
          manifest_id: manifestRow.id,
          delivery_branch: manifest.targets.delivery_branch,
          integration_branch: manifest.targets.integration_branch,
          final_pr_base: manifest.targets.final_pr_base,
        };
      } else if (
        delivery.graph_hash !== manifest.graph_hash ||
        delivery.manifest_id !== manifestRow.id ||
        delivery.delivery_branch !== manifest.targets.delivery_branch ||
        delivery.integration_branch !== manifest.targets.integration_branch ||
        delivery.final_pr_base !== manifest.targets.final_pr_base
      ) {
        throw new DispatchError(
          "manifest_mismatch",
          "Delivery was frozen against a different manifest or target",
        );
      }

      const generationRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(ownership_generation), 0) AS generation FROM dispatch_runs WHERE delivery_id = ?",
        )
        .get(delivery.id) as { generation: number };
      const generation = generationRow.generation + 1;
      const worktreePath = join(
        getProjectWorktreesDir(project.checkout_path),
        "dispatch",
        delivery.id,
        `gen-${generation}`,
      );
      const ownerToken = randomUUID();
      const ownerPid = this.ownerPid();
      const leaseExpiresAt = now + this.leaseMs;
      this.db
        .prepare(
          `INSERT INTO dispatch_runs
             (id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash,
              issue_number, role, gate_profile, merge_policy, target_branch,
              ownership_generation, state, actor, command_request_id, branch, worktree_path,
              base_sha, owner_pid, owner_token, lease_expires_at, head_sha, error,
              launched_at, finished_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          runId,
          project.id,
          delivery.id,
          plan.id,
          member.work_id,
          member.revision_id,
          member.content_hash,
          member.issue_number,
          member.role,
          member.gate_profile,
          mergePolicy,
          targetBranch,
          generation,
          actor,
          requestId,
          branch,
          worktreePath,
          baseSha,
          ownerPid,
          ownerToken,
          leaseExpiresAt,
          now,
          now,
        );
      this.db.exec("COMMIT;");

      const run = this.getRun(project.id, runId);
      return {
        run,
        context: {
          run_id: run.id,
          command_request_id: requestId,
          ownership_generation: run.ownership_generation,
          owner_token: run.owner_token,
          project_id: project.id,
          project_root: project.checkout_path,
          plan_id: plan.id,
          work_id: member.work_id,
          revision_id: member.revision_id,
          issue_number: member.issue_number,
          spec_issue_number: manifest.root.issue_number,
          gate_profile: member.gate_profile,
          merge_policy: mergePolicy,
          branch: run.branch,
          worktree_path: run.worktree_path,
          base_sha: run.base_sha,
          target_branch: targetBranch,
        },
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      if (error instanceof DispatchError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed/i.test(message)) {
        throw new DispatchError(
          "claim_conflict",
          "Another active run already owns this delivery or work item",
        );
      }
      throw new DispatchError("storage_failed", message);
    }
  }

  private selectMember(
    project: ProjectRow,
    plan: PlanRecord,
    manifest: PlanManifest,
    submission: PlanDispatchSubmission,
  ): PlanMember {
    if (submission.work_id || submission.issue_number) {
      const member = submission.work_id
        ? plan.members.find((item) => item.work_id === submission.work_id)
        : plan.members.find((item) => item.issue_number === submission.issue_number);
      if (!member) {
        throw new DispatchError(
          "member_not_in_plan",
          "Requested work is not part of this frozen plan",
        );
      }
      this.assertExplicitMemberAvailable(project.id, member);
      return member;
    }

    const candidates = plan.members
      .filter((member) => member.role === "ticket")
      .filter((member) => this.profileMatches(plan, member))
      .sort((left, right) => left.issue_number - right.issue_number);

    let dependencyBlocked: number | null = null;
    let activeBlocked = false;
    for (const member of candidates) {
      if (this.hasActiveRun(project.id, member.work_id)) {
        activeBlocked = true;
        continue;
      }
      if (this.hasSucceededRun(project.id, member.work_id)) continue;
      const blocked = this.dependencyBlock(
        project,
        plan,
        manifest,
        member,
        this.targetBranch(plan, manifest),
      );
      if (blocked !== null) {
        dependencyBlocked = blocked;
        continue;
      }
      return member;
    }

    if (dependencyBlocked !== null) {
      throw new DispatchError(
        "dependency_pending_integration",
        `Prerequisite #${dependencyBlocked} is not verified on the frozen target`,
        { target_issue_number: dependencyBlocked },
      );
    }
    if (activeBlocked) {
      throw new DispatchError(
        "claim_conflict",
        "Another active run already owns work in this delivery",
      );
    }
    throw new DispatchError(
      "no_dispatchable_member",
      "No executable ticket in this plan is currently eligible",
    );
  }

  private assertExplicitMemberAvailable(projectId: string, member: PlanMember): void {
    if (this.hasActiveRun(projectId, member.work_id)) {
      throw new DispatchError("claim_conflict", `Work ${member.work_id} already has an active run`);
    }
    if (this.hasSucceededRun(projectId, member.work_id)) {
      throw new DispatchError(
        "already_succeeded",
        `Work ${member.work_id} already succeeded and awaits downstream integration`,
      );
    }
  }

  private assertProfile(plan: PlanRecord, member: PlanMember): void {
    if (member.role === "spec" || member.gate_profile === "final") {
      throw new DispatchError(
        "parent_not_dispatchable",
        "Parent specifications are planning records and cannot be dispatched as child builders",
        { work_id: member.work_id },
      );
    }
    if (!this.profileMatches(plan, member)) {
      throw new DispatchError(
        "parent_not_dispatchable",
        `Member profile ${member.gate_profile} does not match plan kind ${plan.kind}`,
      );
    }
  }

  private profileMatches(plan: PlanRecord, member: PlanMember): boolean {
    if (plan.kind === "spec") return member.role === "ticket" && member.gate_profile === "child";
    return member.role === "ticket" && member.gate_profile === "standalone";
  }

  private dependencyBlock(
    project: ProjectRow,
    plan: PlanRecord,
    manifest: PlanManifest,
    member: PlanMember,
    targetBranch: string,
  ): number | null {
    const dependencies = manifest.dependencies.filter(
      (dependency) => dependency.work_id === member.work_id,
    );
    if (dependencies.length === 0) return null;

    const verified = readVerifiedBranchIntegrations({
      db: this.db,
      projectId: project.id,
      root: project.checkout_path,
      integrationRef: targetBranch,
    });

    for (const dependency of dependencies) {
      if (verified.has(dependency.target_issue_number)) continue;
      if (dependency.internal) {
        const target = plan.members.find(
          (candidate) => candidate.issue_number === dependency.target_issue_number,
        );
        if (target && this.hasIntegratedRun(project, target.work_id, targetBranch)) {
          continue;
        }
      }
      return dependency.target_issue_number;
    }
    return null;
  }

  private hasIntegratedRun(project: ProjectRow, workId: string, targetBranch: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT head_sha FROM dispatch_runs
         WHERE project_id = ? AND work_id = ? AND state = 'succeeded' AND head_sha IS NOT NULL
         ORDER BY created_at DESC`,
      )
      .all(project.id, workId) as Array<{ head_sha: string }>;
    for (const row of rows) {
      try {
        this.gitRunner(["merge-base", "--is-ancestor", row.head_sha, targetBranch], {
          cwd: project.checkout_path,
        });
        return true;
      } catch {
        // Not on the frozen target lineage.
      }
    }
    return false;
  }

  private hasActiveRun(projectId: string, workId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM dispatch_runs
         WHERE project_id = ? AND work_id = ? AND ${activeStateCondition()} LIMIT 1`,
      )
      .get(projectId, workId);
    return Boolean(row);
  }

  private hasSucceededRun(projectId: string, workId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM dispatch_runs WHERE project_id = ? AND work_id = ? AND state = 'succeeded' LIMIT 1",
      )
      .get(projectId, workId);
    return Boolean(row);
  }

  private countActiveRuns(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM dispatch_runs WHERE project_id = ? AND ${activeStateCondition()}`,
      )
      .get(projectId) as { count: number };
    return row.count;
  }

  private revalidateClaim(input: {
    project: ProjectRow;
    plan: PlanRecord;
    manifest: PlanManifest;
    member: PlanMember;
    targetBranch: string;
    scheduled: boolean;
  }): void {
    const { project, plan, manifest, member, targetBranch, scheduled } = input;

    let currentPlan: PlanRecord;
    try {
      currentPlan = this.plans.getPlan(project.id, plan.id);
    } catch (error) {
      if (error instanceof PlanError) {
        throw new DispatchError("plan_not_dispatchable", `Plan ${plan.id} is no longer admitted`);
      }
      throw error;
    }
    const currentManifest = this.verifiedManifest(currentPlan);
    if (
      currentManifest.graph_hash !== manifest.graph_hash ||
      currentPlan.graph_hash !== plan.graph_hash
    ) {
      throw new DispatchError("manifest_mismatch", "Frozen plan manifest changed after validation");
    }
    const currentMember = currentPlan.members.find((item) => item.work_id === member.work_id);
    if (
      !currentMember ||
      currentMember.revision_id !== member.revision_id ||
      currentMember.content_hash !== member.content_hash
    ) {
      throw new DispatchError(
        "manifest_mismatch",
        "Frozen member revision changed after validation",
      );
    }
    this.assertProfile(currentPlan, currentMember);

    const brakeCode = this.brakeFailure(project.id, scheduled);
    if (brakeCode) {
      throw new DispatchError(brakeCode, `Dispatch blocked by ${brakeCode}`);
    }

    const blocked = this.dependencyBlock(
      project,
      currentPlan,
      currentManifest,
      currentMember,
      targetBranch,
    );
    if (blocked !== null) {
      throw new DispatchError(
        "dependency_pending_integration",
        `Prerequisite #${blocked} is no longer verified on the frozen target ${targetBranch}`,
        { target_issue_number: blocked, target_branch: targetBranch },
      );
    }

    if (this.hasActiveRun(project.id, currentMember.work_id)) {
      throw new DispatchError("claim_conflict", "Work already has an active run");
    }
    if (this.hasSucceededRun(project.id, currentMember.work_id)) {
      throw new DispatchError("already_succeeded", "Work already succeeded");
    }

    const activeRuns = this.countActiveRuns(project.id);
    const legacy = this.legacyActiveLaps(project.checkout_path);
    const capacity = this.schedule(project.checkout_path).parallel;
    if (activeRuns + legacy >= capacity) {
      throw new DispatchError(
        "capacity_full",
        `Project capacity is full (${activeRuns + legacy}/${capacity})`,
      );
    }
  }

  private brakeFailure(projectId: string, scheduled: boolean): DispatchErrorCode | null {
    const result = scheduled
      ? this.brakes.isScheduledLaunchPermitted(projectId)
      : this.brakes.isLaunchPermitted(projectId);
    if (result.permitted) return null;
    if (result.reason === "schedule_paused") return "schedule_paused";
    if (result.reason === "brake_state_unknown") return "brake_state_unknown";
    return "launch_brake_set";
  }

  private assertBrakes(
    project: ProjectRow,
    submission: DispatchSubmission,
    targetBranch: string,
  ): void {
    const code = this.brakeFailure(project.id, Boolean(submission.scheduled));
    if (!code) return;

    this.recordRejection(project, submission, code, {
      plan_id: submission.plan_id,
      target_branch: targetBranch,
    });
    throw new DispatchError(code, `Dispatch blocked by ${code}`);
  }

  private recordRejection(
    project: ProjectRow,
    submission: PlanDispatchSubmission,
    code: string,
    target: Record<string, unknown>,
  ): void {
    try {
      this.ledger.recordRejection({
        actor: submission.actor ?? "operator",
        projectId: project.id,
        action: "dispatch",
        target,
        reason: code,
      });
    } catch {
      // Rejection audit is best-effort; the fail-closed command error is authoritative.
    }
  }

  private loadPlan(projectId: string, planId: string): PlanRecord {
    try {
      return this.plans.getPlan(projectId, planId);
    } catch (error) {
      if (error instanceof PlanError && error.code === "plan_not_found") {
        throw new DispatchError("plan_not_found", `Plan ${planId} not found`);
      }
      if (error instanceof PlanError && error.code === "project_not_found") {
        throw new DispatchError("project_not_found", `Project ${projectId} not found`);
      }
      throw new DispatchError(
        "storage_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private verifiedManifest(plan: PlanRecord): PlanManifest {
    if (
      plan.authority !== "admitted" ||
      !plan.dispatchable ||
      plan.manifest === null ||
      plan.accepted_revision === null
    ) {
      throw new DispatchError("plan_not_dispatchable", "Plan is not admitted and dispatchable", {
        holds: plan.holds,
      });
    }
    const manifest = plan.manifest;
    if (
      manifest.plan_id !== plan.id ||
      manifest.project_id !== plan.project_id ||
      manifest.graph_hash !== plan.graph_hash ||
      computeGraphHash(graphFromManifest(manifest)) !== manifest.graph_hash
    ) {
      throw new DispatchError(
        "manifest_mismatch",
        "Frozen plan manifest does not match the admitted graph identity",
      );
    }
    return manifest;
  }

  private targetBranch(plan: PlanRecord, manifest: PlanManifest): string {
    if (plan.kind === "spec") {
      if (!manifest.targets.integration_branch) {
        throw new DispatchError("manifest_mismatch", "Spec plan has no frozen integration branch");
      }
      return manifest.targets.integration_branch;
    }
    return manifest.targets.delivery_branch;
  }

  private readFrozenRevision(projectId: string, member: PlanMember): string {
    const row = this.db
      .prepare(
        `SELECT source_body, content_hash FROM work_revisions
         WHERE id = ? AND work_id = ? AND project_id = ?`,
      )
      .get(member.revision_id, member.work_id, projectId) as
      | { source_body: string; content_hash: string }
      | undefined;
    if (!row || row.content_hash !== member.content_hash) {
      throw new DispatchError(
        "manifest_mismatch",
        `Frozen revision ${member.revision_id} is missing or no longer matches the manifest`,
      );
    }
    return row.source_body;
  }

  private resolveBaseSha(checkoutPath: string, targetBranch: string): string {
    for (const ref of [targetBranch, "HEAD"]) {
      try {
        return this.gitRunner(["rev-parse", ref], { cwd: checkoutPath });
      } catch {}
    }
    throw new DispatchError(
      "worktree_allocation_failed",
      `Cannot resolve frozen target ${targetBranch}`,
    );
  }

  private branchFor(manifest: PlanManifest, member: PlanMember): string {
    if (manifest.kind === "standalone") return `factory/standalone-${member.issue_number}`;
    return `factory/spec-${manifest.root.issue_number}/ticket-${member.issue_number}`;
  }

  private uniqueBranch(
    projectId: string,
    checkoutPath: string,
    base: string,
    workId: string,
  ): string {
    const prior = this.db
      .prepare("SELECT COUNT(*) AS count FROM dispatch_runs WHERE project_id = ? AND work_id = ?")
      .get(projectId, workId) as { count: number } | undefined;
    let attempt = (prior?.count ?? 0) + 1;
    let candidate = attempt <= 1 ? base : `${base}-r${attempt}`;
    while (this.branchExists(checkoutPath, candidate)) {
      attempt += 1;
      candidate = `${base}-r${attempt}`;
    }
    return candidate;
  }

  private branchExists(checkoutPath: string, branch: string): boolean {
    try {
      this.gitRunner(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: checkoutPath });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Inspect real external ownership and effects before releasing a claim.
   *
   * A dead coordinator pid (and even a static worktree HEAD) proves nothing while
   * the bounded builder process group or the worktree lock owner is alive, or
   * while branch/remote state is unreadable. Those cases fail closed.
   */
  private inspectRunEffects(run: PlanDispatchRun): string | null {
    const ownerPath = resolveWorkerOwnerPath(run.id);
    if (existsSync(ownerPath)) {
      const owner = readWorkerOwner(run.id);
      if (!owner) {
        throw new DispatchError(
          "external_effect_unverified",
          `Run ${run.id} has an unreadable worker ownership record; manual inspection required`,
        );
      }
      if (pidOrGroupAlive(owner.pid, owner.pgid)) {
        throw new DispatchError(
          "external_effect_unverified",
          `Run ${run.id} still has a live builder process group (pid ${owner.pid}, pgid ${owner.pgid})`,
        );
      }
    }

    const lockPath = join(run.worktree_path, ".worktree.lock");
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid?: unknown };
        if (typeof lock.pid === "number" && this.processAlive(lock.pid)) {
          throw new DispatchError(
            "external_effect_unverified",
            `Run ${run.id} worktree is still owned by live pid ${lock.pid}`,
          );
        }
      } catch (error) {
        if (error instanceof DispatchError) throw error;
        throw new DispatchError(
          "external_effect_unverified",
          `Run ${run.id} has an unreadable worktree lock; manual inspection required`,
        );
      }
    }

    let observedHead: string | null = null;
    if (existsSync(run.worktree_path)) {
      try {
        observedHead = this.gitRunner(["rev-parse", "HEAD"], { cwd: run.worktree_path }) || null;
        // Reading the worktree status proves git still owns a usable checkout; a
        // failure here means effects cannot be verified.
        this.gitRunner(["status", "--porcelain", "--untracked-files=all"], {
          cwd: run.worktree_path,
        });
      } catch (error) {
        throw new DispatchError(
          "external_effect_unverified",
          `Cannot verify worktree state for ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    let branchHead: string | null = null;
    const projectRoot = this.projectCheckoutPath(run.project_id);
    try {
      branchHead = this.gitRunner(["rev-parse", "--verify", `refs/heads/${run.branch}`], {
        cwd: run.worktree_path,
      });
    } catch {}
    if (branchHead === null) {
      try {
        branchHead = this.gitRunner(["rev-parse", "--verify", `refs/heads/${run.branch}`], {
          cwd: projectRoot,
        });
      } catch {}
    }

    let remoteHead: string | null = null;
    try {
      remoteHead = this.gitRunner(["rev-parse", "--verify", `refs/remotes/origin/${run.branch}`], {
        cwd: projectRoot,
      });
    } catch {}

    if (remoteHead) {
      const candidate = observedHead ?? branchHead;
      if (!candidate) {
        throw new DispatchError(
          "external_effect_unverified",
          `Run ${run.id} branch ${run.branch} exists on origin but no local candidate can be verified`,
        );
      }
      if (candidate !== remoteHead) {
        try {
          this.gitRunner(["merge-base", "--is-ancestor", remoteHead, candidate], {
            cwd: projectRoot,
          });
        } catch {
          throw new DispatchError(
            "external_effect_unverified",
            `Run ${run.id} remote branch ${run.branch} has effects not present locally`,
          );
        }
      }
    }

    return observedHead ?? branchHead;
  }

  private markRunRunning(runId: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE dispatch_runs SET state = 'running', launched_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('claimed', 'dispatched')`,
      )
      .run(now, now, runId);
  }

  private markRunFailed(runId: string, error: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE dispatch_runs SET state = 'failed', error = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND ${activeStateCondition()}`,
      )
      .run(error, now, now, runId);
  }

  private updateCommand(requestId: string, state: "running" | "succeeded", result?: string): void {
    try {
      this.ledger.updateOutcome(requestId, {
        state,
        provenance: {
          source: "dispatch_service",
          timestamp: new Date(this.clock()).toISOString(),
        },
        ...(result ? { result: { head_sha: result } } : {}),
      });
    } catch {
      // Command audit updates never change dispatch truth.
    }
  }

  private failCommand(requestId: string, code: string, detail?: string): void {
    try {
      this.ledger.updateOutcome(requestId, {
        state: "failed",
        provenance: {
          source: "dispatch_service",
          timestamp: new Date(this.clock()).toISOString(),
          details: code,
        },
        error: detail ?? code,
      });
    } catch {
      // Command audit updates never change dispatch truth.
    }
  }

  private getProject(projectId: string): ProjectRow {
    const row = this.db
      .prepare(
        "SELECT id, name, repo_id, repo_name, checkout_path, status FROM projects WHERE id = ?",
      )
      .get(projectId) as ProjectRow | undefined;
    if (!row) throw new DispatchError("project_not_found", `Project ${projectId} not found`);
    if (row.status !== "active") {
      throw new DispatchError("project_not_active", `Project ${projectId} is ${row.status}`);
    }
    return row;
  }

  private projectCheckoutPath(projectId: string): string {
    const row = this.db
      .prepare("SELECT checkout_path FROM projects WHERE id = ?")
      .get(projectId) as { checkout_path: string } | undefined;
    if (!row) throw new DispatchError("project_not_found", `Project ${projectId} not found`);
    return row.checkout_path;
  }

  private mapRun(row: DispatchRunRow): PlanDispatchRun {
    return planDispatchRunSchema.parse({
      id: row.id,
      project_id: row.project_id,
      delivery_id: row.delivery_id,
      plan_id: row.plan_id,
      work_id: row.work_id,
      revision_id: row.revision_id,
      content_hash: row.content_hash,
      issue_number: row.issue_number,
      role: row.role,
      gate_profile: row.gate_profile,
      merge_policy: row.merge_policy,
      target_branch: row.target_branch,
      ownership_generation: row.ownership_generation,
      state: row.state,
      actor: row.actor,
      command_request_id: row.command_request_id,
      branch: row.branch,
      worktree_path: row.worktree_path,
      base_sha: row.base_sha,
      owner_pid: row.owner_pid,
      owner_token: row.owner_token,
      lease_expires_at: row.lease_expires_at,
      head_sha: row.head_sha,
      error: row.error,
      launched_at: row.launched_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }
}
