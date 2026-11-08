import type { Migration } from "../registry/migrations";

/**
 * Durable delivery-role ownership (#151 child/standalone/final remediation).
 *
 * The dispatch-run claim only covers builder allocation. Technical checks,
 * independent review and full-delivery acceptance are separate external role
 * executions that two supported ticks (app monitor + CLI scheduler, or two
 * scheduler processes) can otherwise run concurrently for the same run/lap.
 *
 * One mutable row per (run, stage, lap) is the durable ownership projection:
 * claim token/generation, owner process identity, optional spawned role process
 * group, bounded lease and heartbeat. The claim is acquired before any role
 * transport or check process starts, and a competing tick must re-read and skip.
 * It lives in the existing console.db and ordered registry; it is not a second
 * engine or database.
 */
export const DELIVERY_CLAIM_MIGRATIONS: Migration[] = [
  {
    version: 16,
    name: "delivery_role_claims",
    up(db) {
      db.exec(`
        CREATE TABLE delivery_role_claims (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          lap INTEGER NOT NULL CHECK(lap > 0),
          stage TEXT NOT NULL CHECK(stage IN ('technical_checks', 'independent_review', 'final_acceptance')),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          attempt_key TEXT NOT NULL CHECK(length(attempt_key) > 0),
          claim_token TEXT NOT NULL CHECK(length(claim_token) > 0),
          claim_generation INTEGER NOT NULL CHECK(claim_generation > 0),
          owner_pid INTEGER CHECK(owner_pid IS NULL OR owner_pid > 0),
          owner_process_start TEXT,
          role_pid INTEGER CHECK(role_pid IS NULL OR role_pid > 0),
          role_pgid INTEGER CHECK(role_pgid IS NULL OR role_pgid > 0),
          role_process_start TEXT,
          lease_expires_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'interrupted')),
          result_observation_id TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(run_id, stage, lap),
          UNIQUE(id, project_id),
          FOREIGN KEY(run_id, project_id) REFERENCES dispatch_runs(id, project_id),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_delivery_role_claims_run
        ON delivery_role_claims(project_id, run_id, stage);
      `);
    },
  },
];
