import type { Migration } from "../registry/migrations";

/**
 * Child gate integration (#158) owns version 8. Version 3 (#161 drafts), 6
 * (budgets) and 7 (publication) stay reserved/untouched. The record is durable
 * evidence of a *verified remote merge and lineage inclusion*, not a local
 * request to merge.
 */
export const INTEGRATION_MIGRATIONS: Migration[] = [
  {
    version: 8,
    name: "child_gate_integration",
    up(db) {
      db.exec(`
        CREATE TABLE child_integrations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          issue_number INTEGER NOT NULL CHECK(issue_number > 0),
          gate_profile TEXT NOT NULL CHECK(gate_profile = 'child'),
          source_branch TEXT NOT NULL CHECK(length(source_branch) > 0),
          target_branch TEXT NOT NULL CHECK(length(target_branch) > 0),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          base_sha TEXT NOT NULL CHECK(length(base_sha) > 0),
          target_tip_before_sha TEXT NOT NULL CHECK(length(target_tip_before_sha) > 0),
          target_tip_after_sha TEXT NOT NULL CHECK(length(target_tip_after_sha) > 0),
          merge_sha TEXT NOT NULL CHECK(length(merge_sha) > 0),
          remote_pull_request_number INTEGER NOT NULL CHECK(remote_pull_request_number > 0),
          remote_pull_request_url TEXT,
          evidence_identity TEXT NOT NULL CHECK(length(evidence_identity) > 0),
          integrated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(project_id, delivery_id, work_id, target_branch),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id),
          FOREIGN KEY(run_id, project_id) REFERENCES dispatch_runs(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_child_integrations_project
        ON child_integrations(project_id, integrated_at DESC);
      `);
      db.exec(`
        CREATE INDEX idx_child_integrations_delivery
        ON child_integrations(delivery_id, target_branch);
      `);

      // Integration attempts are append-only so a blocked attempt is never confused
      // with a verified merge and the operator can inspect drift/conflict history.
      db.exec(`
        CREATE TABLE child_integration_events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          target_tip_sha TEXT NOT NULL CHECK(length(target_tip_sha) > 0),
          kind TEXT NOT NULL CHECK(kind IN ('blocked', 'merged', 'reconciled')),
          merge_sha TEXT,
          reasons TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_child_integration_events_run
        ON child_integration_events(run_id, created_at DESC);
      `);

      for (const table of ["child_integration_events"]) {
        db.exec(`
          CREATE TRIGGER ${table}_immutable_update
          BEFORE UPDATE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table}_immutable');
          END;
        `);
        db.exec(`
          CREATE TRIGGER ${table}_immutable_delete
          BEFORE DELETE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table}_immutable');
          END;
        `);
      }
    },
  },
];
