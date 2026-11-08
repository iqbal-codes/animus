import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  planDispatchRunSchema,
  type BudgetGrantList,
  type BudgetGrantResult,
  type BudgetGrantSubmission,
  type DispatchRunDetail,
  type ExecutionBudgetStatus,
  type ExecutionControlResult,
  type ExecutionControlSubmission,
  type ExecutionProcessState,
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
  processStartIdentity,
  readWorkerOwner,
  resolveWorkerOwnerPath,
  writeWorkerOwner,
  type DispatchWorkerOwner,
} from "./ownership";
import {
  readExecutionAuthority,
  type ExecutionAuthority,
} from "@animus/contracts/execution-authority";
import { ExecutionObservationService } from "../evidence/observations";
import {
  BudgetGrantConflictError,
  ExecutionBudgetService,
  type BudgetScopeKey,
} from "../work/budget";
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
  | "budget_exhausted"
  | "budget_scope_missing"
  | "work_held"
  | "work_stopping"
  | "work_stopped"
  | "control_not_found"
  | "owner_may_still_run"
  | "termination_unconfirmed"
  | "stale_owner_generation"
  | "idempotency_conflict"
  | "run_still_active"
  | "invalid_control"
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

export interface DispatchFinding {
  summary: string;
  fileContext: string;
  acKey?: string;
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
  findings: DispatchFinding[];
}

export interface DispatchRunResult {
  success: boolean;
  headSha?: string;
  error?: string;
  exitCode?: number;
}

export type DispatchRunner = (context: DispatchRunnerContext) => Promise<DispatchRunResult>;

export type DispatchTerminator = (
  target: { pid: number | null; pgid: number | null },
  signal: NodeJS.Signals,
) => void;

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
  observations?: ExecutionObservationService;
  budget?: ExecutionBudgetService;
  terminate?: DispatchTerminator;
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
  lap: number;
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

type DispatchSubmission = PlanDispatchSubmission & {
  scheduled?: boolean;
  findings?: DispatchFinding[];
};

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

function defaultTerminate(
  target: { pid: number | null; pgid: number | null },
  signal: NodeJS.Signals,
): void {
  if (target.pgid !== null && target.pgid > 0) {
    try {
      process.kill(-target.pgid, signal);
    } catch {}
  }
  if (target.pid !== null && target.pid > 0) {
    try {
      process.kill(target.pid, signal);
    } catch {}
  }
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
      findings: context.findings,
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
          ownership_generation: context.ownership_generation,
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
  private readonly observations: ExecutionObservationService;
  private readonly budget: ExecutionBudgetService;
  private readonly terminate: DispatchTerminator;

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
    this.observations = options.observations ?? new ExecutionObservationService(db);
    this.budget = options.budget ?? new ExecutionBudgetService(db);
    this.terminate = options.terminate ?? defaultTerminate;
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
    this.assertControlAvailability(project.id, plan.id, member);
    this.assertBudgetForNextAttempt(project, plan, member, submission);

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
        explicit: Boolean(submission.work_id || submission.issue_number),
        runId: `run_${randomUUID()}`,
        findings: submission.findings ?? [],
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

    const reconciled = this.getRun(projectId, runId);
    const control = this.budget.getControl({
      projectId,
      deliveryId: reconciled.delivery_id,
      workId: reconciled.work_id,
    });
    if (control && (control.status === "stopping" || control.status === "held")) {
      this.budget.setControl({
        projectId,
        deliveryId: reconciled.delivery_id,
        workId: reconciled.work_id,
        status: "stopped",
        actor: "operator",
        reason: "termination_reconciled",
        commandRequestId: control.commandRequestId ?? reconciled.command_request_id,
        lastRunId: reconciled.id,
        now,
        stopSignal: control.stopSignal,
        stopRequestedAt: control.stopRequestedAt,
        stoppedAt: now,
      });
    }
    if (reconciled.state !== "succeeded") {
      this.maybeExhaustAfterRejection(reconciled, "run_reconciled");
    }

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

  listGrants(projectId: string, query: { runId?: string; workId?: string } = {}): BudgetGrantList {
    let workId = query.workId;
    let deliveryId: string | undefined;
    if (query.runId) {
      const run = this.getRun(projectId, query.runId);
      workId = run.work_id;
      deliveryId = run.delivery_id;
    }
    return this.budget.listGrants(projectId, {
      ...(workId ? { workId } : {}),
      ...(deliveryId ? { deliveryId } : {}),
    });
  }

  grantBudget(
    projectId: string,
    runId: string,
    submission: BudgetGrantSubmission,
  ): BudgetGrantResult {
    if (!Number.isSafeInteger(submission.amount) || submission.amount <= 0) {
      throw new DispatchError("invalid_submission", "A budget grant amount must be positive");
    }
    const run = this.getRun(projectId, runId);
    const key = this.scopeKeyFromRun(run);
    const scope = this.budget.getScope(key);
    if (!scope) {
      throw new DispatchError(
        "budget_scope_missing",
        `Run ${runId} has no allocated attempt budget yet`,
        { run_id: runId },
      );
    }
    const requestId = `cmd_grant_${randomUUID()}`;
    this.beginControlCommand(requestId, submission.actor, projectId, "budget_grant", run, {
      amount: submission.amount,
      reason: submission.reason,
      idempotency_key: submission.idempotency_key ?? null,
    });
    try {
      const outcome = this.budget.applyGrant(scope, {
        amount: submission.amount,
        reason: submission.reason,
        actor: submission.actor,
        commandRequestId: requestId,
        idempotencyKey: submission.idempotency_key ?? requestId,
        now: this.clock(),
      });
      this.updateCommand(
        requestId,
        "succeeded",
        undefined,
        outcome.replayed ? `idempotent_replay:${outcome.grant.commandRequestId}` : undefined,
      );
      return {
        grant: outcome.grant,
        budget: outcome.budget,
        replayed: outcome.replayed,
        commandRequestId: requestId,
      };
    } catch (error) {
      if (error instanceof BudgetGrantConflictError) {
        this.failCommand(requestId, "idempotency_conflict", error.message);
        throw new DispatchError("idempotency_conflict", error.message, error.details);
      }
      this.failCommand(
        requestId,
        "storage_failed",
        error instanceof Error ? error.message : String(error),
      );
      throw new DispatchError(
        "storage_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  getRunDetail(projectId: string, runId: string): DispatchRunDetail {
    const run = this.getRun(projectId, runId);
    const key = this.scopeKeyFromRun(run);
    const budget = this.budget.getScope(key);
    const control = this.budget.getControl({
      projectId,
      deliveryId: run.delivery_id,
      workId: run.work_id,
    });
    const grants = this.budget.listGrants(projectId, {
      deliveryId: run.delivery_id,
      workId: run.work_id,
    });
    const attemptRows = this.db
      .prepare(
        `SELECT id, lap, ownership_generation, state, issue_number, head_sha, error, created_at, finished_at
         FROM dispatch_runs WHERE delivery_id = ? AND work_id = ? ORDER BY lap ASC, created_at ASC`,
      )
      .all(run.delivery_id, run.work_id) as Array<{
      id: string;
      lap: number;
      ownership_generation: number;
      state: PlanDispatchRun["state"];
      issue_number: number;
      head_sha: string | null;
      error: string | null;
      created_at: number;
      finished_at: number | null;
    }>;
    const plan = this.loadPlan(projectId, run.plan_id);
    const criteria = plan.acceptance_criteria.filter(
      (criterion) => criterion.work_id === run.work_id,
    );
    const openFindings = this.observations.listFindings(projectId, {
      deliveryId: run.delivery_id,
      workId: run.work_id,
      status: "open",
    });
    return {
      run,
      budget,
      control,
      grants,
      attempts: attemptRows.map((row) => ({
        runId: row.id,
        lap: row.lap,
        ownershipGeneration: row.ownership_generation,
        state: row.state,
        issueNumber: row.issue_number,
        headSha: row.head_sha,
        error: row.error,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      })),
      process: this.processState(run),
      acceptanceCriteria: criteria.map((criterion) => ({
        acKey: criterion.ac_key,
        text: criterion.text,
        openFindingIds: openFindings
          .filter((finding) => finding.acKey === criterion.ac_key)
          .map((finding) => finding.id),
      })),
      openFindings,
      acceptance: this.observations.evaluateAcceptance(projectId, run.id),
    };
  }

  applyControl(
    projectId: string,
    runId: string,
    submission: ExecutionControlSubmission,
  ): ExecutionControlResult {
    const run = this.getRun(projectId, runId);
    if (
      submission.expected_ownership_generation !== undefined &&
      submission.expected_ownership_generation !== run.ownership_generation
    ) {
      throw new DispatchError(
        "stale_owner_generation",
        `Run ${runId} generation is ${run.ownership_generation}, not ${submission.expected_ownership_generation}`,
        { run_id: runId, ownership_generation: run.ownership_generation },
      );
    }
    switch (submission.action) {
      case "hold":
        return this.holdRun(projectId, run, submission);
      case "resume":
        return this.resumeRun(projectId, run, submission);
      case "stop":
        return this.stopRun(projectId, run, submission);
      case "takeover":
        return this.takeoverRun(projectId, run, submission);
      default:
        throw new DispatchError("invalid_control", `Unknown control action`);
    }
  }

  private holdRun(
    projectId: string,
    run: PlanDispatchRun,
    submission: ExecutionControlSubmission,
  ): ExecutionControlResult {
    const key = {
      projectId,
      deliveryId: run.delivery_id,
      workId: run.work_id,
    };
    const current = this.budget.getControl(key);
    if (current?.status === "stopping") {
      throw new DispatchError(
        "work_stopping",
        `Run ${run.id} has an unconfirmed stop; reconcile termination before holding`,
      );
    }
    const requestId = `cmd_hold_${randomUUID()}`;
    this.beginControlCommand(requestId, submission.actor, projectId, "hold", run, {
      reason: submission.reason ?? null,
    });
    const control = this.budget.setControl({
      ...key,
      status: "held",
      actor: submission.actor,
      reason: submission.reason ?? "operator_hold",
      commandRequestId: requestId,
      lastRunId: run.id,
      now: this.clock(),
    });
    this.updateCommand(requestId, "succeeded");
    return {
      run: this.getRun(projectId, run.id),
      control,
      budget: this.budget.getScope(this.scopeKeyFromRun(run)),
      confirmed: true,
      commandRequestId: requestId,
      detail: "held",
    };
  }

  private resumeRun(
    projectId: string,
    run: PlanDispatchRun,
    submission: ExecutionControlSubmission,
  ): ExecutionControlResult {
    const key = {
      projectId,
      deliveryId: run.delivery_id,
      workId: run.work_id,
    };
    const current = this.budget.getControl(key);
    if (!current) {
      throw new DispatchError("control_not_found", `Work ${run.work_id} has no hold to resume`);
    }
    if (current.status !== "held" && current.status !== "stopped") {
      throw new DispatchError(
        "invalid_control",
        `Work ${run.work_id} is ${current.status}; only held or stopped work can resume`,
      );
    }
    const scope = this.budget.getScope(this.scopeKeyFromRun(run));
    if (!scope) {
      throw new DispatchError("budget_scope_missing", `Work ${run.work_id} has no attempt budget`);
    }
    if (scope.status === "exhausted" || scope.consumedAttempts >= scope.allowedAttempts) {
      throw new DispatchError(
        "budget_exhausted",
        "Resume cannot reset consumed attempts; grant an explicit additional attempt",
        { allowed_attempts: scope.allowedAttempts, consumed_attempts: scope.consumedAttempts },
      );
    }
    const active = this.db
      .prepare(
        `SELECT id FROM dispatch_runs WHERE project_id = ? AND work_id = ? AND ${activeStateCondition()} LIMIT 1`,
      )
      .get(projectId, run.work_id) as { id: string } | undefined;
    if (active) {
      const activeRun = this.getRun(projectId, active.id);
      const process = this.processState(activeRun);
      if (process.ownerAlive || process.workerAlive || process.worktreeLockAlive) {
        throw new DispatchError(
          "owner_may_still_run",
          `Run ${activeRun.id} may still be writing; reconcile or stop its process tree first`,
          { run_id: activeRun.id },
        );
      }
      throw new DispatchError(
        "run_still_active",
        `Run ${activeRun.id} is still active; reconcile it before resuming`,
        { run_id: activeRun.id },
      );
    }
    const requestId = `cmd_resume_${randomUUID()}`;
    this.beginControlCommand(requestId, submission.actor, projectId, "resume", run, {
      reason: submission.reason ?? null,
    });
    const control = this.budget.setControl({
      ...key,
      status: "active",
      actor: submission.actor,
      reason: submission.reason ?? "operator_resume",
      commandRequestId: requestId,
      lastRunId: run.id,
      now: this.clock(),
      stopSignal: null,
      stopRequestedAt: null,
      stoppedAt: null,
    });
    this.updateCommand(requestId, "succeeded");
    return {
      run: this.getRun(projectId, run.id),
      control,
      budget: scope,
      confirmed: true,
      commandRequestId: requestId,
      detail: "resumed",
    };
  }

  private stopRun(
    projectId: string,
    run: PlanDispatchRun,
    submission: ExecutionControlSubmission,
  ): ExecutionControlResult {
    if (!(ACTIVE_STATES as readonly string[]).includes(run.state)) {
      throw new DispatchError("run_not_active", `Run ${run.id} is already terminal (${run.state})`);
    }
    const requestId = `cmd_stop_${randomUUID()}`;
    const signal = (submission.signal ?? "SIGTERM") as NodeJS.Signals;
    this.beginControlCommand(requestId, submission.actor, projectId, "stop", run, {
      reason: submission.reason ?? null,
      signal,
    });

    // Validate the durable claim identity before any signal. A stale, foreign,
    // unreadable or PID-reused record is never allowed to kill an unrelated process.
    const ownerPathExists = existsSync(resolveWorkerOwnerPath(run.id));
    const owner = ownerPathExists ? readWorkerOwner(run.id) : null;
    const identityFailure = this.workerIdentityFailure(run, owner, ownerPathExists);
    // Terminate only the recorded bounded-builder process group. The coordinator
    // pid may be this backend; it is fenced by reconciliation, not killed here.
    const target =
      identityFailure === null && owner
        ? { pid: owner.pid, pgid: owner.pgid }
        : { pid: null, pgid: null };
    let terminateError: string | null = null;
    try {
      if (target.pid !== null || target.pgid !== null) {
        this.terminate(target, signal);
      }
    } catch (error) {
      terminateError = error instanceof Error ? error.message : String(error);
    }

    const process = this.processState(run);
    const confirmed =
      identityFailure === null &&
      terminateError === null &&
      !process.ownerAlive &&
      !process.workerAlive &&
      !process.worktreeLockAlive;
    const now = this.clock();
    const control = this.budget.setControl({
      projectId,
      deliveryId: run.delivery_id,
      workId: run.work_id,
      status: "stopping",
      actor: submission.actor,
      reason: identityFailure
        ? "termination_unverified"
        : confirmed
          ? "termination_requested"
          : "termination_unconfirmed",
      commandRequestId: requestId,
      lastRunId: run.id,
      now,
      stopSignal: signal,
      stopRequestedAt: now,
      stoppedAt: null,
    });
    try {
      this.ledger.updateOutcome(requestId, {
        state: confirmed ? "succeeded" : "unknown",
        provenance: {
          source: "dispatch_control",
          timestamp: new Date(now).toISOString(),
          actor: submission.actor,
          details:
            identityFailure ??
            terminateError ??
            (confirmed ? "termination_requested" : "termination_unconfirmed"),
        },
        ...(terminateError ? { error: terminateError } : {}),
      });
    } catch {}

    return {
      run: this.getRun(projectId, run.id),
      control,
      budget: this.budget.getScope(this.scopeKeyFromRun(run)),
      confirmed,
      commandRequestId: requestId,
      detail: identityFailure
        ? `termination_unverified:${identityFailure}`
        : terminateError
          ? `termination_error:${terminateError}`
          : confirmed
            ? "termination_requested"
            : "termination_unconfirmed",
    };
  }

  private takeoverRun(
    projectId: string,
    run: PlanDispatchRun,
    submission: ExecutionControlSubmission,
  ): ExecutionControlResult {
    if (!(ACTIVE_STATES as readonly string[]).includes(run.state)) {
      throw new DispatchError("run_not_active", `Run ${run.id} is already terminal (${run.state})`);
    }
    const process = this.processState(run);
    if (process.ownerAlive || process.workerAlive || process.worktreeLockAlive) {
      throw new DispatchError(
        "owner_may_still_run",
        `Run ${run.id} may still be writing; takeover refused until its process tree is confirmed dead`,
        { run_id: run.id },
      );
    }
    // Effects must be readable and clear before the CAS. This also captures the
    // retained head without pretending to reattach the old builder process.
    const observedHead = this.inspectRunEffects(run);
    const requestId = `cmd_takeover_${randomUUID()}`;
    this.beginControlCommand(requestId, submission.actor, projectId, "takeover", run, {
      reason: submission.reason ?? null,
    });
    const now = this.clock();
    const generationRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(ownership_generation), 0) AS generation FROM dispatch_runs WHERE delivery_id = ?",
      )
      .get(run.delivery_id) as { generation: number };
    const nextGeneration = generationRow.generation + 1;
    const ownerToken = randomUUID();
    const changed = this.db
      .prepare(
        `UPDATE dispatch_runs
         SET state = 'reconciled',
             ownership_generation = ?, owner_token = ?, owner_pid = NULL,
             head_sha = COALESCE(?, head_sha),
             error = 'operator_takeover_after_owner_confirmed_dead',
             finished_at = ?, updated_at = ?
         WHERE id = ? AND project_id = ? AND ownership_generation = ? AND ${activeStateCondition()}`,
      )
      .run(
        nextGeneration,
        ownerToken,
        observedHead,
        now,
        now,
        run.id,
        projectId,
        run.ownership_generation,
      ) as { changes: number };
    if (changed.changes === 0) {
      this.failCommand(
        requestId,
        "stale_owner_generation",
        "Run ownership changed before takeover",
      );
      throw new DispatchError(
        "stale_owner_generation",
        `Run ${run.id} ownership changed before takeover`,
      );
    }
    clearWorkerOwner(run.id);
    const control = this.budget.setControl({
      projectId,
      deliveryId: run.delivery_id,
      workId: run.work_id,
      status: "active",
      actor: submission.actor,
      reason: submission.reason ?? "operator_takeover",
      commandRequestId: requestId,
      lastRunId: run.id,
      now,
      stopSignal: null,
      stopRequestedAt: null,
      stoppedAt: null,
    });
    const updated = this.getRun(projectId, run.id);
    const budget = this.budget.getScope(this.scopeKeyFromRun(updated));
    if (
      budget &&
      budget.status !== "exhausted" &&
      budget.consumedAttempts >= budget.allowedAttempts
    ) {
      this.maybeExhaustAfterRejection(updated, "takeover_reconciled");
    }
    this.updateCommand(requestId, "succeeded");
    return {
      run: updated,
      control,
      budget: this.budget.getScope(this.scopeKeyFromRun(updated)),
      confirmed: true,
      commandRequestId: requestId,
      detail: `taken_over:generation=${updated.ownership_generation};prior_run_reconciled`,
    };
  }

  private workerIdentityFailure(
    run: PlanDispatchRun,
    owner: DispatchWorkerOwner | null,
    ownerPathExists: boolean,
  ): string | null {
    if (!ownerPathExists) return "worker_owner_record_missing";
    if (!owner) return "worker_owner_record_unreadable";
    if (owner.run_id !== run.id) return "worker_owner_run_mismatch";
    if (owner.owner_token !== run.owner_token) return "worker_owner_token_mismatch";
    if (owner.ownership_generation !== run.ownership_generation) {
      return "worker_owner_generation_mismatch";
    }
    // The bounded builder is spawned detached as its process-group leader.
    if (owner.pgid !== owner.pid) return "worker_owner_process_group_mismatch";
    if (owner.process_start === null) return "worker_owner_process_identity_unreadable";
    if (processStartIdentity(owner.pid) !== owner.process_start) {
      return "worker_owner_process_identity_unverified";
    }
    return null;
  }

  private processState(run: PlanDispatchRun): ExecutionProcessState {
    const ownerPid = run.owner_pid;
    const ownerAlive = ownerPid !== null && this.safeProcessAlive(ownerPid);

    let workerPid: number | null = null;
    let workerPgid: number | null = null;
    let workerAlive = false;
    if (existsSync(resolveWorkerOwnerPath(run.id))) {
      const owner = readWorkerOwner(run.id);
      if (!owner) {
        // An unreadable ownership record is unknown, not absent: fail closed.
        workerAlive = true;
      } else {
        workerPid = owner.pid;
        workerPgid = owner.pgid;
        workerAlive = pidOrGroupAlive(owner.pid, owner.pgid);
      }
    }

    let worktreeLockPid: number | null = null;
    let worktreeLockAlive = false;
    const lockPath = join(run.worktree_path, ".worktree.lock");
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid?: unknown };
        if (typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0) {
          worktreeLockPid = lock.pid;
          worktreeLockAlive = this.safeProcessAlive(lock.pid);
        } else {
          worktreeLockAlive = true;
        }
      } catch {
        worktreeLockAlive = true;
      }
    }

    return {
      ownerPid,
      ownerAlive,
      workerPid,
      workerPgid,
      workerAlive,
      worktreeLockPid,
      worktreeLockAlive,
    };
  }

  private safeProcessAlive(pid: number): boolean {
    try {
      return this.processAlive(pid);
    } catch {
      return true;
    }
  }

  private beginControlCommand(
    requestId: string,
    actor: string,
    projectId: string,
    action: string,
    run: PlanDispatchRun,
    details: Record<string, unknown> = {},
  ): void {
    try {
      this.ledger.recordBeforeDispatch({
        requestId,
        actor,
        projectId,
        action,
        target: {
          run_id: run.id,
          delivery_id: run.delivery_id,
          work_id: run.work_id,
          issue_number: run.issue_number,
          ownership_generation: run.ownership_generation,
          ...details,
        },
      });
    } catch (error) {
      throw new DispatchError(
        "storage_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private finalize(run: PlanDispatchRun, result: DispatchRunResult): PlanDispatchRun {
    const verified = this.verifyCandidate(run, result);
    const nextState = verified.success ? "succeeded" : "failed";
    const error = verified.success ? null : (verified.error ?? "dispatch_failed");
    const now = this.clock();

    try {
      // The terminal state and its immutable stage observation commit together so a
      // partial persistence cannot report a result without its evidence.
      this.db.exec("BEGIN IMMEDIATE;");
      const current = this.db
        .prepare("SELECT * FROM dispatch_runs WHERE id = ?")
        .get(run.id) as unknown as DispatchRunRow | undefined;
      if (
        !current ||
        current.ownership_generation !== run.ownership_generation ||
        current.owner_token !== run.owner_token ||
        !(ACTIVE_STATES as readonly string[]).includes(current.state)
      ) {
        throw new DispatchError(
          "stale_worker",
          "Worker result was superseded by a newer ownership generation",
        );
      }

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
        throw new DispatchError(
          "stale_worker",
          "Worker result was superseded by a newer ownership generation",
        );
      }

      this.observations.recordRunObservation(run.project_id, run.id, {
        stage: "builder_execution",
        status: verified.success ? "passed" : "failed",
        producer: { id: run.actor, role: "builder", name: "dispatch-builder" },
        checks: [
          {
            name: "builder_commit",
            command: "git rev-parse HEAD",
            result: verified.success ? "PASS" : "FAIL",
            detail: verified.success
              ? `candidate ${verified.headSha ?? ""}`
              : (verified.error ?? "dispatch_failed"),
          },
        ],
        findings: [],
        artifacts: [],
      });

      this.db.exec("COMMIT;");
    } catch (caught) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      if (caught instanceof DispatchError) {
        this.failCommand(
          run.command_request_id,
          caught.code === "stale_worker" ? "stale_worker" : "storage_failed",
          caught.message,
        );
        throw caught;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      this.failCommand(run.command_request_id, "storage_failed", message);
      throw new DispatchError("storage_failed", message);
    }

    clearWorkerOwner(run.id);

    if (verified.success) {
      this.updateCommand(run.command_request_id, "succeeded", verified.headSha);
      return this.getRun(run.project_id, run.id);
    }

    this.failCommand(run.command_request_id, "dispatch_failed", error ?? "dispatch_failed");
    this.maybeExhaustAfterRejection(run, error ?? "dispatch_failed");
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
    explicit?: boolean;
    runId: string;
    findings?: DispatchFinding[];
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
      explicit,
      runId,
      findings,
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
        explicit: Boolean(explicit),
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
      // The execution lap is allocated per ticket (work item), transactionally in
      // this same serialized claim. A resumed/reconciled run keeps its row and lap;
      // only a new builder/fix cycle consumes the next ticket lap. Budget enforcement
      // (limit, grants, exhaustion) belongs to #156.
      const lapRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(lap), 0) AS lap FROM dispatch_runs WHERE delivery_id = ? AND work_id = ?",
        )
        .get(delivery.id, member.work_id) as { lap: number };
      const lap = lapRow.lap + 1;
      const worktreePath = join(
        getProjectWorktreesDir(project.checkout_path),
        "dispatch",
        delivery.id,
        `gen-${generation}`,
      );
      const ownerToken = randomUUID();
      const ownerPid = this.ownerPid();
      const leaseExpiresAt = now + this.leaseMs;

      // The attempt budget is the ticket (delivery + work + gate profile). It is
      // checked and consumed in this same serialized claim, so two coordinators can
      // never allocate the same numbered attempt.
      const budgetKey: BudgetScopeKey = {
        projectId: project.id,
        deliveryId: delivery.id,
        planId: plan.id,
        workId: member.work_id,
        gateProfile: member.gate_profile,
      };
      const scope = this.budget.ensureScope(
        { ...budgetKey, baseLimit: this.budgetBaseLimit(manifest, member), now },
        true,
      );
      if (lap > scope.allowedAttempts) {
        const latest = this.db
          .prepare(
            `SELECT id, worktree_path, branch, head_sha FROM dispatch_runs
             WHERE delivery_id = ? AND work_id = ? ORDER BY lap DESC LIMIT 1`,
          )
          .get(delivery.id, member.work_id) as
          | { id: string; worktree_path: string; branch: string; head_sha: string | null }
          | undefined;
        const retention = {
          runId: latest?.id ?? runId,
          worktreePath: latest?.worktree_path ?? worktreePath,
          branch: latest?.branch ?? branch,
          headSha: latest?.head_sha ?? null,
          reason: "budget_exhausted",
        };
        this.budget.markExhausted(project.id, scope.scopeId, retention, now);
        this.db.exec("COMMIT;");
        throw new DispatchError(
          "budget_exhausted",
          `Ticket #${member.issue_number} exhausted its ${scope.allowedAttempts}-attempt budget; grant an explicit additional attempt`,
          {
            work_id: member.work_id,
            gate_profile: member.gate_profile,
            allowed_attempts: scope.allowedAttempts,
            consumed_attempts: scope.consumedAttempts,
            retained_worktree_path: retention.worktreePath,
            retained_branch: retention.branch,
          },
        );
      }

      this.db
        .prepare(
          `INSERT INTO dispatch_runs
             (id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash,
              issue_number, role, gate_profile, merge_policy, target_branch,
              ownership_generation, lap, state, actor, command_request_id, branch, worktree_path,
              base_sha, owner_pid, owner_token, lease_expires_at, head_sha, error,
              launched_at, finished_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
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
          lap,
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
      this.budget.recordConsumed(project.id, scope.scopeId, lap, now);
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
          findings: findings ?? [],
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
      this.assertExplicitMemberAvailable(project, member, this.targetBranch(plan, manifest));
      return member;
    }

    const candidates = plan.members
      .filter((member) => member.role === "ticket")
      .filter((member) => this.profileMatches(plan, member))
      .sort((left, right) => left.issue_number - right.issue_number);

    // Shared member eligibility: an exhausted, held, stopping or stopped sibling is
    // skipped so it cannot starve independent work in the same plan. Explicit
    // work selection still returns its precise refusal below.
    const deliveryId = this.deliveryIdForPlan(project.id, plan.id);
    const skipped: DispatchError[] = [];
    let activeBlocked = false;
    for (const member of candidates) {
      if (this.hasActiveRun(project.id, member.work_id)) {
        activeBlocked = true;
        continue;
      }
      if (this.hasSucceededRun(project.id, member.work_id)) {
        if (!this.staleSucceededRun(project, member.work_id, this.targetBranch(plan, manifest))) {
          continue;
        }
      }
      const skip = this.memberEligibilitySkip(project.id, plan.id, deliveryId, member);
      if (skip) {
        skipped.push(skip);
        continue;
      }
      const blocked = this.dependencyBlock(
        project,
        plan,
        manifest,
        member,
        this.targetBranch(plan, manifest),
      );
      if (blocked !== null) {
        skipped.push(
          new DispatchError(
            "dependency_pending_integration",
            `Prerequisite #${blocked} is not verified on the frozen target`,
            { target_issue_number: blocked },
          ),
        );
        continue;
      }
      return member;
    }

    if (skipped.length > 0) throw skipped[0];
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

  private memberEligibilitySkip(
    projectId: string,
    planId: string,
    deliveryId: string | null,
    member: PlanMember,
  ): DispatchError | null {
    if (!deliveryId) return null;
    const control = this.budget.getControl({
      projectId,
      deliveryId,
      workId: member.work_id,
    });
    if (control?.status === "held") {
      return new DispatchError("work_held", `Work ${member.work_id} is held by the operator`);
    }
    if (control?.status === "stopping") {
      return new DispatchError(
        "work_stopping",
        `Work ${member.work_id} is still stopping; termination is not yet reconciled`,
      );
    }
    if (control?.status === "stopped") {
      return new DispatchError(
        "work_stopped",
        `Work ${member.work_id} was stopped; resume it before dispatching again`,
      );
    }
    const scope = this.budget.getScope({
      projectId,
      deliveryId,
      planId,
      workId: member.work_id,
      gateProfile: member.gate_profile,
    });
    if (
      scope &&
      (scope.status === "exhausted" || scope.consumedAttempts >= scope.allowedAttempts)
    ) {
      return new DispatchError(
        "budget_exhausted",
        `Ticket #${member.issue_number} exhausted its ${scope.allowedAttempts}-attempt budget; grant an explicit additional attempt`,
        {
          work_id: member.work_id,
          gate_profile: member.gate_profile,
          allowed_attempts: scope.allowedAttempts,
          consumed_attempts: scope.consumedAttempts,
          retained_worktree_path: scope.retainedWorktreePath,
          retained_branch: scope.retainedBranch,
        },
      );
    }
    return null;
  }

  private assertExplicitMemberAvailable(
    project: ProjectRow,
    member: PlanMember,
    targetBranch: string,
  ): void {
    if (this.hasActiveRun(project.id, member.work_id)) {
      throw new DispatchError("claim_conflict", `Work ${member.work_id} already has an active run`);
    }
    if (
      this.hasSucceededRun(project.id, member.work_id) &&
      !this.hasOpenFinding(project.id, member.work_id) &&
      !this.staleSucceededRun(project, member.work_id, targetBranch)
    ) {
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

  private budgetBaseLimit(manifest: PlanManifest, member: PlanMember): number {
    return member.gate_profile === "final"
      ? manifest.budgets.final_max_laps
      : manifest.budgets.child_max_laps;
  }

  private deliveryIdForPlan(projectId: string, planId: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM deliveries WHERE project_id = ? AND plan_id = ?")
      .get(projectId, planId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private scopeKeyFromRun(run: PlanDispatchRun): BudgetScopeKey {
    return {
      projectId: run.project_id,
      deliveryId: run.delivery_id,
      planId: run.plan_id,
      workId: run.work_id,
      gateProfile: run.gate_profile,
    };
  }

  private assertControlAvailability(projectId: string, planId: string, member: PlanMember): void {
    const deliveryId = this.deliveryIdForPlan(projectId, planId);
    if (!deliveryId) return;
    const control = this.budget.getControl({ projectId, deliveryId, workId: member.work_id });
    if (!control) return;
    if (control.status === "held") {
      throw new DispatchError("work_held", `Work ${member.work_id} is held by the operator`);
    }
    if (control.status === "stopping") {
      throw new DispatchError(
        "work_stopping",
        `Work ${member.work_id} is still stopping; termination is not yet reconciled`,
      );
    }
    if (control.status === "stopped") {
      throw new DispatchError(
        "work_stopped",
        `Work ${member.work_id} was stopped; resume it before dispatching again`,
      );
    }
  }

  /** Fail before allocating a worktree/branch when the ticket budget is already spent. */
  private assertBudgetForNextAttempt(
    project: ProjectRow,
    plan: PlanRecord,
    member: PlanMember,
    submission: DispatchSubmission,
  ): void {
    const deliveryId = this.deliveryIdForPlan(project.id, plan.id);
    if (!deliveryId) return;
    const key: BudgetScopeKey = {
      projectId: project.id,
      deliveryId,
      planId: plan.id,
      workId: member.work_id,
      gateProfile: member.gate_profile,
    };
    const scope = this.budget.getScope(key);
    if (!scope) return;
    if (scope.status !== "exhausted" && scope.consumedAttempts < scope.allowedAttempts) return;
    if (scope.status !== "exhausted") {
      this.markBudgetExhaustedFromLatestRun(project.id, key, scope, "budget_exhausted");
    }
    this.recordRejection(project, submission, "budget_exhausted", {
      plan_id: plan.id,
      work_id: member.work_id,
      gate_profile: member.gate_profile,
      allowed_attempts: scope.allowedAttempts,
      consumed_attempts: scope.consumedAttempts,
    });
    throw new DispatchError(
      "budget_exhausted",
      `Ticket #${member.issue_number} exhausted its ${scope.allowedAttempts}-attempt budget; grant an explicit additional attempt`,
      {
        work_id: member.work_id,
        gate_profile: member.gate_profile,
        allowed_attempts: scope.allowedAttempts,
        consumed_attempts: scope.consumedAttempts,
        retained_worktree_path: scope.retainedWorktreePath,
        retained_branch: scope.retainedBranch,
      },
    );
  }

  private markBudgetExhaustedFromLatestRun(
    projectId: string,
    key: BudgetScopeKey,
    scope: ExecutionBudgetStatus,
    reason: string,
  ): void {
    const latest = this.db
      .prepare(
        `SELECT id, worktree_path, branch, head_sha FROM dispatch_runs
         WHERE delivery_id = ? AND work_id = ? ORDER BY lap DESC LIMIT 1`,
      )
      .get(key.deliveryId, key.workId) as
      | { id: string; worktree_path: string; branch: string; head_sha: string | null }
      | undefined;
    if (!latest) return;
    this.budget.markExhausted(
      projectId,
      scope.scopeId,
      {
        runId: latest.id,
        worktreePath: latest.worktree_path,
        branch: latest.branch,
        headSha: latest.head_sha,
        reason,
      },
      this.clock(),
    );
  }

  /** A rejected final allowed attempt moves the ticket to Needs owner immediately. */
  private maybeExhaustAfterRejection(run: PlanDispatchRun, reason: string): void {
    const key = this.scopeKeyFromRun(run);
    const scope = this.budget.getScope(key);
    if (!scope) return;
    if (scope.consumedAttempts < scope.allowedAttempts) return;
    this.budget.markExhausted(
      run.project_id,
      scope.scopeId,
      {
        runId: run.id,
        worktreePath: run.worktree_path,
        branch: run.branch,
        headSha: run.head_sha ?? null,
        reason,
      },
      this.clock(),
    );
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

  /**
   * A succeeded run that is not on the frozen target lineage is stale when the
   * target has advanced since it was built. Such work must re-enter a new bounded
   * builder lap instead of being merged or treated as permanently complete.
   */
  private staleSucceededRun(project: ProjectRow, workId: string, targetBranch: string): boolean {
    const row = this.db
      .prepare(
        `SELECT head_sha, base_sha FROM dispatch_runs
          WHERE project_id = ? AND work_id = ? AND state = 'succeeded' AND head_sha IS NOT NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(project.id, workId) as { head_sha: string; base_sha: string } | undefined;
    if (!row) return false;
    try {
      this.gitRunner(["merge-base", "--is-ancestor", row.head_sha, targetBranch], {
        cwd: project.checkout_path,
      });
      return false;
    } catch {
      // Not included on the frozen target lineage; only a moved target is stale.
    }
    try {
      const tip = this.gitRunner(["rev-parse", "--verify", targetBranch], {
        cwd: project.checkout_path,
      });
      return tip !== row.base_sha;
    } catch {
      return false;
    }
  }

  /**
   * An open finding for the ticket means its last builder/fix cycle did not close
   * the defect, so an explicit re-dispatch starts the next ticket lap. Whether and
   * how many laps may be granted is #156's budget policy.
   */
  private hasOpenFinding(projectId: string, workId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM factory_findings WHERE project_id = ? AND work_id = ? AND status = 'open' LIMIT 1",
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
    explicit: boolean;
  }): void {
    const { project, plan, manifest, member, targetBranch, scheduled, explicit } = input;

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
    this.assertControlAvailability(project.id, currentPlan.id, currentMember);

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
    if (
      this.hasSucceededRun(project.id, currentMember.work_id) &&
      !(
        explicit &&
        (this.hasOpenFinding(project.id, currentMember.work_id) ||
          this.staleSucceededRun(project, currentMember.work_id, targetBranch))
      )
    ) {
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

  private updateCommand(
    requestId: string,
    state: "running" | "succeeded",
    result?: string,
    details?: string,
  ): void {
    try {
      this.ledger.updateOutcome(requestId, {
        state,
        provenance: {
          source: "dispatch_service",
          timestamp: new Date(this.clock()).toISOString(),
          ...(details ? { details } : {}),
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
      lap: row.lap,
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
