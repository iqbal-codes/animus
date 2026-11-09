import type { Migration } from "../registry/migrations";

/**
 * Final-spec delivery coordination (#160) owns version 12. Version 11 stays
 * reserved for backup/restore (#164), so this lane appends to the single ordered
 * registry instead of claiming a version inside feature code.
 *
 * The tables persist coordination state only; candidate evidence, PR audit,
 * budgets and dispatches remain owned by their existing modules.
 */
export const FINAL_DELIVERY_MIGRATIONS: Migration[] = [
  {
    version: 12,
    name: "final_spec_delivery_coordination",
    up(db) {
      db.exec(`
        CREATE TABLE final_deliveries (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          manifest_id TEXT NOT NULL,
          graph_hash TEXT NOT NULL CHECK(length(graph_hash) = 64),
          integration_branch TEXT NOT NULL CHECK(length(integration_branch) > 0),
          delivery_branch TEXT NOT NULL CHECK(length(delivery_branch) > 0),
          status TEXT NOT NULL CHECK(status IN (
            'waiting_children','blocked','verifying','needs_owner',
            'awaiting_manual_merge','awaiting_merge_verification','remote_unavailable','delivered'
          )),
          candidate_head_sha TEXT,
          final_run_id TEXT,
          required_count INTEGER NOT NULL CHECK(required_count >= 0),
          integrated_count INTEGER NOT NULL CHECK(integrated_count >= 0),
          pull_request_number INTEGER CHECK(pull_request_number IS NULL OR pull_request_number > 0),
          pull_request_url TEXT,
          halt_reason TEXT,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(project_id, delivery_id),
          UNIQUE(project_id, plan_id),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(manifest_id) REFERENCES plan_manifests(id),
          FOREIGN KEY(final_run_id, project_id) REFERENCES dispatch_runs(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_final_deliveries_project
        ON final_deliveries(project_id, updated_at DESC);
      `);

      // Exactly one final assembly run may exist for a combined candidate in a
      // delivery. A repair builder run has its own candidate branch head that is not
      // the merged integration tip, so it cannot collide with an assembled candidate.
      db.exec(`
        CREATE UNIQUE INDEX uq_dispatch_runs_final_candidate
        ON dispatch_runs(delivery_id, head_sha)
        WHERE gate_profile = 'final' AND head_sha IS NOT NULL;
      `);

      db.exec(`
        CREATE TABLE final_delivery_events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          run_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN (
            'waiting','blocked','ready','final_run','verification','correction',
            'repair_merged','published','needs_owner','delivered','error'
          )),
          candidate_head_sha TEXT,
          reasons TEXT NOT NULL,
          detail TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_final_delivery_events_delivery
        ON final_delivery_events(project_id, delivery_id, created_at DESC);
      `);
      db.exec(`
        CREATE TRIGGER final_delivery_events_immutable_update
        BEFORE UPDATE ON final_delivery_events
        BEGIN
          SELECT RAISE(ABORT, 'final_delivery_events_immutable');
        END;
      `);
      db.exec(`
        CREATE TRIGGER final_delivery_events_immutable_delete
        BEFORE DELETE ON final_delivery_events
        BEGIN
          SELECT RAISE(ABORT, 'final_delivery_events_immutable');
        END;
      `);
    },
  },
];
