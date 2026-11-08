import type { Migration } from "../registry/migrations";

export const BUDGET_MIGRATIONS: Migration[] = [
  {
    version: 6,
    name: "execution_budgets_and_controls",
    up(db) {
      // Durable per-ticket attempt budgets. The lap ordinal allocated at claim is the
      // consumed attempt; grants add an explicit numbered allowance and never reset it.
      db.exec(`
        CREATE TABLE execution_budget_scopes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('child', 'standalone', 'final')),
          base_limit INTEGER NOT NULL CHECK(base_limit > 0),
          granted_attempts INTEGER NOT NULL DEFAULT 0 CHECK(granted_attempts >= 0),
          consumed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(consumed_attempts >= 0),
          status TEXT NOT NULL CHECK(status IN ('active', 'exhausted')),
          exhausted_at INTEGER,
          last_rejection TEXT,
          retained_worktree_path TEXT,
          retained_branch TEXT,
          retained_run_id TEXT,
          retained_head_sha TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(delivery_id, work_id, gate_profile),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_budget_scopes_project
        ON execution_budget_scopes(project_id, status);
      `);

      // Explicit operator grants. Idempotency keys make grant replay a no-op so a
      // transient retry cannot double the allowance.
      db.exec(`
        CREATE TABLE execution_budget_grants (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          scope_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('child', 'standalone', 'final')),
          amount INTEGER NOT NULL CHECK(amount > 0),
          reason TEXT NOT NULL CHECK(length(reason) > 0),
          actor TEXT NOT NULL CHECK(length(actor) > 0),
          command_request_id TEXT NOT NULL CHECK(length(command_request_id) > 0),
          idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) > 0),
          created_at INTEGER NOT NULL,
          UNIQUE(project_id, idempotency_key),
          FOREIGN KEY(scope_id, project_id) REFERENCES execution_budget_scopes(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_budget_grants_scope
        ON execution_budget_grants(scope_id, created_at);
      `);
      db.exec(`
        CREATE TRIGGER execution_budget_grants_immutable_update
        BEFORE UPDATE ON execution_budget_grants
        BEGIN
          SELECT RAISE(ABORT, 'execution_budget_grant_immutable');
        END;
      `);
      db.exec(`
        CREATE TRIGGER execution_budget_grants_immutable_delete
        BEFORE DELETE ON execution_budget_grants
        BEGIN
          SELECT RAISE(ABORT, 'execution_budget_grant_immutable');
        END;
      `);

      // Operator hold/stop/takeover state per ticket. A stop request is recorded as
      // 'stopping' until reconciliation proves the prior process tree cannot write.
      db.exec(`
        CREATE TABLE execution_controls (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'held', 'stopping', 'stopped')),
          reason TEXT,
          actor TEXT,
          command_request_id TEXT,
          stop_signal TEXT,
          stop_requested_at INTEGER,
          stopped_at INTEGER,
          last_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(delivery_id, work_id),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_execution_controls_project
        ON execution_controls(project_id, status);
      `);
    },
  },
];
