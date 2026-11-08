import type { Migration } from "../registry/migrations";

/**
 * Publication audit (#157) owns version 7. Version 6 stays reserved for lap
 * budgets (#156), so this module is appended after execution evidence v5 in the
 * one ordered registry rather than claiming a version inside feature code.
 */
export const PUBLICATION_MIGRATIONS: Migration[] = [
  {
    version: 7,
    name: "publication_audit_outgoing_intents",
    up(db) {
      // One publication target per executable ticket in a delivery. It survives PR
      // replacement; the active PR is tracked separately so closed history is never
      // rewritten.
      db.exec(`
        CREATE TABLE publication_targets (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          issue_number INTEGER NOT NULL CHECK(issue_number > 0),
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('child', 'standalone', 'final')),
          source_branch TEXT NOT NULL CHECK(length(source_branch) > 0),
          target_branch TEXT NOT NULL CHECK(length(target_branch) > 0),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          base_sha TEXT NOT NULL CHECK(length(base_sha) > 0),
          state TEXT NOT NULL CHECK(state IN ('no_candidate', 'ready', 'publishing', 'published', 'failed', 'unknown')),
          active_pull_request_id TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(project_id, delivery_id, work_id),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_publication_targets_project
        ON publication_targets(project_id, created_at DESC);
      `);

      db.exec(`
        CREATE TABLE publication_pull_requests (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES publication_targets(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          number INTEGER CHECK(number IS NULL OR number > 0),
          url TEXT,
          head_branch TEXT NOT NULL CHECK(length(head_branch) > 0),
          base_branch TEXT NOT NULL CHECK(length(base_branch) > 0),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          head_ref_oid TEXT,
          draft INTEGER NOT NULL CHECK(draft IN (0, 1)),
          state TEXT NOT NULL CHECK(state IN ('open', 'closed', 'merged', 'superseded')),
          active INTEGER NOT NULL CHECK(active IN (0, 1)),
          created_by_intent TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(target_id, head_branch, candidate_head_sha)
        );
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_publication_pr_active
        ON publication_pull_requests(target_id)
        WHERE active = 1;
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_publication_pr_number
        ON publication_pull_requests(project_id, number)
        WHERE number IS NOT NULL;
      `);
      db.exec(`
        CREATE INDEX idx_publication_prs_target
        ON publication_pull_requests(target_id, created_at DESC);
      `);

      // Consequential audit events are append-only. They are queued whether or not a
      // PR exists yet; publication intents carry the remote side effect.
      db.exec(`
        CREATE TABLE publication_events (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES publication_targets(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          work_id TEXT NOT NULL CHECK(length(work_id) > 0),
          run_id TEXT,
          lap INTEGER CHECK(lap IS NULL OR lap > 0),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          observation_id TEXT,
          finding_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('verification_failure', 'finding', 'fix_submitted', 'recheck_passed', 'recheck_failed', 'recheck_inconclusive', 'verdict', 'escalation')),
          severity TEXT NOT NULL CHECK(severity IN ('blocking', 'conditional', 'info')),
          title TEXT NOT NULL CHECK(length(title) > 0),
          body TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          UNIQUE(target_id, sequence)
        );
      `);
      db.exec(`
        CREATE INDEX idx_publication_events_target
        ON publication_events(target_id, sequence ASC);
      `);

      db.exec(`
        CREATE TABLE publication_intents (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES publication_targets(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          operation_key TEXT NOT NULL CHECK(length(operation_key) > 0),
          kind TEXT NOT NULL CHECK(kind IN ('create_pr', 'publish_event', 'update_summary', 'create_review')),
          state TEXT NOT NULL CHECK(state IN ('queued', 'attempting', 'accepted', 'failed', 'unknown')),
          request_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          remote_object_id TEXT,
          remote_url TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(target_id, operation_key)
        );
      `);
      db.exec(`
        CREATE INDEX idx_publication_intents_target
        ON publication_intents(target_id, created_at ASC);
      `);

      db.exec(`
        CREATE TABLE publication_evidence_bindings (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES publication_targets(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          artifact_id TEXT NOT NULL REFERENCES execution_artifacts(id),
          status TEXT NOT NULL CHECK(status IN ('pending', 'supplied_unverified')),
          hosted_url TEXT,
          updated_at INTEGER NOT NULL,
          UNIQUE(target_id, artifact_id)
        );
      `);

      db.exec(`
        CREATE TABLE publication_summaries (
          target_id TEXT PRIMARY KEY REFERENCES publication_targets(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          body TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      for (const table of ["publication_events"]) {
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
