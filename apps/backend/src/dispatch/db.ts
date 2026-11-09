import type { Migration } from "../registry/migrations";

export const DISPATCH_MIGRATIONS: Migration[] = [
  {
    version: 4,
    name: "delivery_dispatch_ownership",
    up(db) {
      db.exec(`
        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          plan_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('standalone', 'spec')),
          delivery_branch TEXT NOT NULL CHECK(length(delivery_branch) > 0),
          integration_branch TEXT,
          final_pr_base TEXT NOT NULL CHECK(length(final_pr_base) > 0),
          merge_policy_child TEXT NOT NULL CHECK(merge_policy_child IN ('auto_after_gates', 'manual')),
          merge_policy_standalone TEXT NOT NULL CHECK(merge_policy_standalone IN ('auto_after_gates', 'manual')),
          merge_policy_final TEXT NOT NULL CHECK(merge_policy_final IN ('auto_after_gates', 'manual')),
          manifest_id TEXT NOT NULL,
          graph_hash TEXT NOT NULL CHECK(length(graph_hash) = 64),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(project_id, plan_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(manifest_id) REFERENCES plan_manifests(id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_deliveries_project ON deliveries(project_id, created_at DESC);
      `);
      db.exec(`
        CREATE TABLE dispatch_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
          issue_number INTEGER NOT NULL CHECK(issue_number > 0),
          role TEXT NOT NULL CHECK(role IN ('spec', 'ticket')),
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('child', 'standalone', 'final')),
          merge_policy TEXT NOT NULL CHECK(merge_policy IN ('auto_after_gates', 'manual')),
          target_branch TEXT NOT NULL CHECK(length(target_branch) > 0),
          ownership_generation INTEGER NOT NULL CHECK(ownership_generation > 0),
          state TEXT NOT NULL CHECK(state IN ('claimed', 'dispatched', 'running', 'succeeded', 'failed', 'interrupted', 'reconciled')),
          actor TEXT NOT NULL CHECK(length(actor) > 0),
          command_request_id TEXT NOT NULL CHECK(length(command_request_id) > 0),
          branch TEXT NOT NULL CHECK(length(branch) > 0),
          worktree_path TEXT NOT NULL CHECK(length(worktree_path) > 0),
          base_sha TEXT NOT NULL CHECK(length(base_sha) > 0),
          owner_pid INTEGER CHECK(owner_pid IS NULL OR owner_pid > 0),
          owner_token TEXT NOT NULL CHECK(length(owner_token) > 0),
          lease_expires_at INTEGER,
          head_sha TEXT,
          error TEXT,
          launched_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(delivery_id, ownership_generation),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id),
          FOREIGN KEY(revision_id, work_id) REFERENCES work_revisions(id, work_id)
        );
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_dispatch_runs_active_delivery
        ON dispatch_runs(delivery_id)
        WHERE state IN ('claimed', 'dispatched', 'running', 'interrupted');
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_dispatch_runs_active_work
        ON dispatch_runs(project_id, work_id)
        WHERE state IN ('claimed', 'dispatched', 'running', 'interrupted');
      `);
      db.exec(`
        CREATE INDEX idx_dispatch_runs_project ON dispatch_runs(project_id, created_at DESC);
      `);
      db.exec(`
        CREATE INDEX idx_dispatch_runs_plan ON dispatch_runs(plan_id, created_at DESC);
      `);
    },
  },
];
