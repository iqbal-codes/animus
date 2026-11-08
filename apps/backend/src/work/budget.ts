import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BudgetGrantRecord,
  ExecutionBudgetStatus,
  ExecutionControlState,
  ExecutionControlStatus,
  PlanGateProfile,
} from "@animus/contracts/operator";

export interface BudgetScopeKey {
  projectId: string;
  deliveryId: string;
  planId: string;
  workId: string;
  gateProfile: PlanGateProfile;
}

export interface BudgetScopeInit extends BudgetScopeKey {
  baseLimit: number;
  now: number;
}

export interface BudgetExhaustionRetention {
  runId: string;
  worktreePath: string;
  branch: string;
  headSha: string | null;
  reason: string;
}

export interface BudgetGrantInput extends BudgetScopeKey {
  amount: number;
  reason: string;
  actor: string;
  commandRequestId: string;
  idempotencyKey: string;
  now: number;
}

export interface BudgetGrantOutcome {
  grant: BudgetGrantRecord;
  budget: ExecutionBudgetStatus;
  replayed: boolean;
}

export interface ControlKey {
  projectId: string;
  deliveryId: string;
  workId: string;
}

export interface ControlUpdate extends ControlKey {
  status: ExecutionControlStatus;
  actor: string;
  reason: string | null;
  commandRequestId: string;
  lastRunId: string;
  now: number;
  stopSignal?: string | null;
  stopRequestedAt?: number | null;
  stoppedAt?: number | null;
}

interface ScopeRow {
  id: string;
  project_id: string;
  delivery_id: string;
  plan_id: string;
  work_id: string;
  gate_profile: PlanGateProfile;
  base_limit: number;
  granted_attempts: number;
  consumed_attempts: number;
  status: "active" | "exhausted";
  exhausted_at: number | null;
  last_rejection: string | null;
  retained_worktree_path: string | null;
  retained_branch: string | null;
  retained_run_id: string | null;
  retained_head_sha: string | null;
  created_at: number;
  updated_at: number;
}

interface GrantRow {
  id: string;
  project_id: string;
  scope_id: string;
  delivery_id: string;
  work_id: string;
  gate_profile: PlanGateProfile;
  amount: number;
  reason: string;
  actor: string;
  command_request_id: string;
  idempotency_key: string;
  created_at: number;
}

interface ControlRow {
  id: string;
  project_id: string;
  delivery_id: string;
  work_id: string;
  status: ExecutionControlStatus;
  reason: string | null;
  actor: string | null;
  command_request_id: string | null;
  stop_signal: string | null;
  stop_requested_at: number | null;
  stopped_at: number | null;
  last_run_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Durable attempt budgets and operator controls for locally dispatched tickets.
 *
 * The budget key is the ticket (delivery + work + gate profile), so exhausting one
 * child never touches a sibling or the independent final-delivery budget. The lap
 * ordinal allocated by dispatch is the consumed attempt; grants add allowance only.
 */
export class ExecutionBudgetService {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert the scope on first dispatch. Repeated claims keep the frozen base limit. */
  ensureScope(input: BudgetScopeInit, inTransaction = false): ExecutionBudgetStatus {
    const existing = this.loadScopeByKey(input);
    if (existing) return this.mapScope(existing);
    const run = () => {
      this.db
        .prepare(
          `INSERT INTO execution_budget_scopes
             (id, project_id, delivery_id, plan_id, work_id, gate_profile, base_limit,
              granted_attempts, consumed_attempts, status, exhausted_at, last_rejection,
              retained_worktree_path, retained_branch, retained_run_id, retained_head_sha,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          `budget_${randomUUID()}`,
          input.projectId,
          input.deliveryId,
          input.planId,
          input.workId,
          input.gateProfile,
          input.baseLimit,
          input.now,
          input.now,
        );
      const created = this.loadScopeByKey(input);
      if (!created) throw new Error("budget_scope_not_created");
      return this.mapScope(created);
    };
    return inTransaction ? run() : this.withTransaction(run);
  }

  getScope(key: BudgetScopeKey): ExecutionBudgetStatus | null {
    const row = this.loadScopeByKey(key);
    return row ? this.mapScope(row) : null;
  }

  getScopeById(projectId: string, scopeId: string): ExecutionBudgetStatus | null {
    const row = this.db
      .prepare("SELECT * FROM execution_budget_scopes WHERE project_id = ? AND id = ?")
      .get(projectId, scopeId) as unknown as ScopeRow | undefined;
    return row ? this.mapScope(row) : null;
  }

  /** Record the allocated lap as consumed. Called inside the claim transaction. */
  recordConsumed(projectId: string, scopeId: string, attempt: number, now: number): void {
    this.db
      .prepare(
        `UPDATE execution_budget_scopes
         SET consumed_attempts = MAX(consumed_attempts, ?), updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(attempt, now, projectId, scopeId);
  }

  markExhausted(
    projectId: string,
    scopeId: string,
    retention: BudgetExhaustionRetention,
    now: number,
  ): void {
    this.db
      .prepare(
        `UPDATE execution_budget_scopes
         SET status = 'exhausted', exhausted_at = ?, last_rejection = ?,
             retained_run_id = ?, retained_worktree_path = ?, retained_branch = ?,
             retained_head_sha = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        now,
        retention.reason,
        retention.runId,
        retention.worktreePath,
        retention.branch,
        retention.headSha,
        now,
        projectId,
        scopeId,
      );
  }

  /** A grant re-opens an exhausted scope only up to the new numbered allowance. */
  applyGrant(
    scope: ExecutionBudgetStatus,
    input: Omit<BudgetGrantInput, keyof BudgetScopeKey>,
  ): BudgetGrantOutcome {
    const existing = this.db
      .prepare("SELECT * FROM execution_budget_grants WHERE project_id = ? AND idempotency_key = ?")
      .get(scope.projectId, input.idempotencyKey) as unknown as GrantRow | undefined;
    if (existing) {
      return {
        grant: this.mapGrant(existing),
        budget: this.getScopeById(scope.projectId, existing.scope_id) ?? scope,
        replayed: true,
      };
    }

    return this.withTransaction(() => {
      const replayed = this.db
        .prepare(
          "SELECT * FROM execution_budget_grants WHERE project_id = ? AND idempotency_key = ?",
        )
        .get(scope.projectId, input.idempotencyKey) as unknown as GrantRow | undefined;
      if (replayed) {
        return {
          grant: this.mapGrant(replayed),
          budget: this.getScopeById(scope.projectId, replayed.scope_id) ?? scope,
          replayed: true,
        };
      }

      const grantId = `grant_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO execution_budget_grants
             (id, project_id, scope_id, delivery_id, work_id, gate_profile, amount, reason,
              actor, command_request_id, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grantId,
          scope.projectId,
          scope.scopeId,
          scope.deliveryId,
          scope.workId,
          scope.gateProfile,
          input.amount,
          input.reason,
          input.actor,
          input.commandRequestId,
          input.idempotencyKey,
          input.now,
        );

      const row = this.db
        .prepare("SELECT * FROM execution_budget_scopes WHERE project_id = ? AND id = ?")
        .get(scope.projectId, scope.scopeId) as unknown as ScopeRow | undefined;
      if (!row) throw new Error("budget_scope_not_found");
      const grantedAttempts = row.granted_attempts + input.amount;
      const allowed = row.base_limit + grantedAttempts;
      const reactivated = row.consumed_attempts < allowed;
      this.db
        .prepare(
          `UPDATE execution_budget_scopes
           SET granted_attempts = ?,
               status = ?,
               exhausted_at = ?,
               updated_at = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(
          grantedAttempts,
          reactivated ? "active" : "exhausted",
          reactivated ? null : row.exhausted_at,
          input.now,
          scope.projectId,
          scope.scopeId,
        );

      const updated = this.db
        .prepare("SELECT * FROM execution_budget_scopes WHERE project_id = ? AND id = ?")
        .get(scope.projectId, scope.scopeId) as unknown as ScopeRow;
      const grantRow = this.db
        .prepare("SELECT * FROM execution_budget_grants WHERE project_id = ? AND id = ?")
        .get(scope.projectId, grantId) as unknown as GrantRow;
      return {
        grant: this.mapGrant(grantRow),
        budget: this.mapScope(updated),
        replayed: false,
      };
    });
  }

  listGrants(projectId: string, query: { scopeId?: string; deliveryId?: string; workId?: string }) {
    const clauses = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (query.scopeId) {
      clauses.push("scope_id = ?");
      params.push(query.scopeId);
    }
    if (query.deliveryId) {
      clauses.push("delivery_id = ?");
      params.push(query.deliveryId);
    }
    if (query.workId) {
      clauses.push("work_id = ?");
      params.push(query.workId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_budget_grants WHERE ${clauses.join(" AND ")}
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...(params as never[])) as unknown as GrantRow[];
    return rows.map((row) => this.mapGrant(row));
  }

  getControl(key: ControlKey): ExecutionControlState | null {
    const row = this.db
      .prepare(
        "SELECT * FROM execution_controls WHERE project_id = ? AND delivery_id = ? AND work_id = ?",
      )
      .get(key.projectId, key.deliveryId, key.workId) as unknown as ControlRow | undefined;
    return row ? this.mapControl(row) : null;
  }

  setControl(update: ControlUpdate): ExecutionControlState {
    const existing = this.db
      .prepare(
        "SELECT * FROM execution_controls WHERE project_id = ? AND delivery_id = ? AND work_id = ?",
      )
      .get(update.projectId, update.deliveryId, update.workId) as unknown as ControlRow | undefined;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO execution_controls
             (id, project_id, delivery_id, work_id, status, reason, actor, command_request_id,
              stop_signal, stop_requested_at, stopped_at, last_run_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `control_${randomUUID()}`,
          update.projectId,
          update.deliveryId,
          update.workId,
          update.status,
          update.reason,
          update.actor,
          update.commandRequestId,
          update.stopSignal ?? null,
          update.stopRequestedAt ?? null,
          update.stoppedAt ?? null,
          update.lastRunId,
          update.now,
          update.now,
        );
    } else {
      this.db
        .prepare(
          `UPDATE execution_controls
           SET status = ?, reason = ?, actor = ?, command_request_id = ?, stop_signal = ?,
               stop_requested_at = ?, stopped_at = ?, last_run_id = ?, updated_at = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(
          update.status,
          update.reason,
          update.actor,
          update.commandRequestId,
          update.stopSignal ?? null,
          update.stopRequestedAt ?? null,
          update.stoppedAt ?? null,
          update.lastRunId,
          update.now,
          update.projectId,
          existing.id,
        );
    }
    const saved = this.getControl(update);
    if (!saved) throw new Error("control_not_saved");
    return saved;
  }

  private loadScopeByKey(key: BudgetScopeKey): ScopeRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM execution_budget_scopes
         WHERE project_id = ? AND delivery_id = ? AND work_id = ? AND gate_profile = ?`,
      )
      .get(key.projectId, key.deliveryId, key.workId, key.gateProfile) as unknown as
      | ScopeRow
      | undefined;
  }

  private mapScope(row: ScopeRow): ExecutionBudgetStatus {
    const allowedAttempts = row.base_limit + row.granted_attempts;
    return {
      scopeId: row.id,
      projectId: row.project_id,
      deliveryId: row.delivery_id,
      planId: row.plan_id,
      workId: row.work_id,
      gateProfile: row.gate_profile,
      baseLimit: row.base_limit,
      grantedAttempts: row.granted_attempts,
      consumedAttempts: row.consumed_attempts,
      allowedAttempts,
      remainingAttempts: Math.max(0, allowedAttempts - row.consumed_attempts),
      status: row.status,
      exhaustedAt: row.exhausted_at,
      lastRejection: row.last_rejection,
      retainedWorktreePath: row.retained_worktree_path,
      retainedBranch: row.retained_branch,
      retainedRunId: row.retained_run_id,
      retainedHeadSha: row.retained_head_sha,
    };
  }

  private mapGrant(row: GrantRow): BudgetGrantRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      scopeId: row.scope_id,
      deliveryId: row.delivery_id,
      workId: row.work_id,
      gateProfile: row.gate_profile,
      amount: row.amount,
      reason: row.reason,
      actor: row.actor,
      commandRequestId: row.command_request_id,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    };
  }

  private mapControl(row: ControlRow): ExecutionControlState {
    return {
      status: row.status,
      reason: row.reason,
      actor: row.actor,
      commandRequestId: row.command_request_id,
      stopSignal: row.stop_signal,
      stopRequestedAt: row.stop_requested_at,
      stoppedAt: row.stopped_at,
      updatedAt: row.updated_at,
    };
  }

  private withTransaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }
}
