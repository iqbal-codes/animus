import type { Migration } from "../registry/migrations";

export const EVIDENCE_MIGRATIONS: Migration[] = [
  {
    version: 5,
    name: "execution_observations_findings_artifacts",
    up(db) {
      // The execution lap is per ticket (builder/fix cycle), independent of the
      // delivery-wide ownership generation used for claim fencing. v4 is preserved
      // as shipped; v5 adds the per-work lap ordinal transactionally allocated at claim.
      db.exec(`
        ALTER TABLE dispatch_runs ADD COLUMN lap INTEGER NOT NULL DEFAULT 1 CHECK(lap > 0);
      `);
      db.exec(`
        UPDATE dispatch_runs
        SET lap = (
          SELECT COUNT(*)
          FROM dispatch_runs AS prior
          WHERE prior.delivery_id = dispatch_runs.delivery_id
            AND prior.work_id = dispatch_runs.work_id
            AND (
              prior.created_at < dispatch_runs.created_at
              OR (prior.created_at = dispatch_runs.created_at AND prior.id <= dispatch_runs.id)
            )
        );
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_dispatch_runs_work_lap
        ON dispatch_runs(delivery_id, work_id, lap);
      `);

      // Durable trusted producer identities. Credentials are minted only by the
      // trusted backend/host boundary (never by the public evidence route); the
      // stored value is a one-way hash so a leaked database cannot impersonate.
      db.exec(`
        CREATE TABLE execution_producers (
          project_id TEXT NOT NULL REFERENCES projects(id),
          producer_id TEXT NOT NULL CHECK(length(producer_id) > 0),
          role TEXT NOT NULL CHECK(role IN ('independent_evaluator', 'peer_reviewer', 'automated_gate', 'builder')),
          producer_name TEXT,
          credential_hash TEXT NOT NULL CHECK(length(credential_hash) = 64),
          created_at INTEGER NOT NULL,
          revoked_at INTEGER,
          PRIMARY KEY(project_id, producer_id),
          UNIQUE(credential_hash)
        );
      `);

      // Candidate-bound stage observations. Rows are append-only: a new lap or a new
      // candidate appends a new row instead of rewriting earlier failures.
      db.exec(`
        CREATE TABLE execution_observations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          lap INTEGER NOT NULL CHECK(lap > 0),
          attempt_key TEXT NOT NULL CHECK(length(attempt_key) > 0),
          stage TEXT NOT NULL CHECK(stage IN ('builder_execution', 'technical_checks', 'code_review', 'blackbox_verification')),
          status TEXT NOT NULL CHECK(status IN ('running', 'passed', 'failed', 'inconclusive', 'interrupted')),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          target_tip_sha TEXT NOT NULL CHECK(length(target_tip_sha) > 0),
          merge_base_sha TEXT NOT NULL CHECK(length(merge_base_sha) > 0),
          tested_identity TEXT NOT NULL CHECK(length(tested_identity) > 0),
          integration_lineage TEXT NOT NULL CHECK(length(integration_lineage) > 0),
          producer_id TEXT NOT NULL CHECK(length(producer_id) > 0),
          producer_role TEXT NOT NULL CHECK(producer_role IN ('independent_evaluator', 'peer_reviewer', 'automated_gate', 'builder')),
          producer_name TEXT,
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('child', 'standalone', 'final')),
          gate_profile_version INTEGER NOT NULL CHECK(gate_profile_version > 0),
          error TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(run_id, stage, lap, producer_id, attempt_key),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(run_id, project_id) REFERENCES dispatch_runs(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_exec_obs_run ON execution_observations(run_id, created_at);
      `);
      db.exec(`
        CREATE INDEX idx_exec_obs_delivery ON execution_observations(delivery_id, created_at);
      `);
      db.exec(`
        CREATE INDEX idx_exec_obs_candidate
        ON execution_observations(project_id, candidate_head_sha);
      `);

      db.exec(`
        CREATE TABLE execution_checks (
          id TEXT PRIMARY KEY,
          observation_id TEXT NOT NULL REFERENCES execution_observations(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          name TEXT NOT NULL CHECK(length(name) > 0),
          command TEXT NOT NULL,
          result TEXT NOT NULL CHECK(result IN ('PASS', 'FAIL', 'BLOCKED', 'NOT_RUN')),
          duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
          detail TEXT,
          artifact_path TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(observation_id, name)
        );
      `);
      db.exec(`
        CREATE INDEX idx_exec_checks_observation ON execution_checks(observation_id);
      `);

      // Findings retain their original evidence forever. Only the lifecycle columns
      // (status, resolved_at) may change; append-only events carry the history.
      db.exec(`
        CREATE TABLE factory_findings (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          work_id TEXT,
          issue_number INTEGER NOT NULL CHECK(issue_number > 0),
          ac_key TEXT,
          severity TEXT NOT NULL CHECK(severity IN ('blocking', 'conditional')),
          file_context TEXT NOT NULL CHECK(length(file_context) > 0),
          summary TEXT NOT NULL CHECK(length(summary) > 0),
          origin_observation_id TEXT NOT NULL REFERENCES execution_observations(id),
          status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          UNIQUE(id, project_id),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(run_id, project_id) REFERENCES dispatch_runs(id, project_id),
          FOREIGN KEY(work_id) REFERENCES work_items(id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_findings_run ON factory_findings(run_id, status);
      `);
      db.exec(`
        CREATE INDEX idx_findings_delivery ON factory_findings(delivery_id, status);
      `);

      db.exec(`
        CREATE TABLE factory_finding_events (
          id TEXT PRIMARY KEY,
          finding_id TEXT NOT NULL REFERENCES factory_findings(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          action TEXT NOT NULL CHECK(action IN ('opened', 'fix_submitted', 'recheck_passed', 'recheck_failed', 'recheck_inconclusive')),
          actor TEXT NOT NULL CHECK(length(actor) > 0),
          actor_role TEXT NOT NULL CHECK(actor_role IN ('independent_evaluator', 'peer_reviewer', 'automated_gate', 'builder')),
          observation_id TEXT REFERENCES execution_observations(id),
          detail TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(finding_id, sequence)
        );
      `);
      db.exec(`
        CREATE INDEX idx_finding_events_finding
        ON factory_finding_events(finding_id, sequence);
      `);

      // Finalized artifact references: relative path, size and digest are captured
      // when the file is finalized, before any acceptance decision can cite it.
      db.exec(`
        CREATE TABLE execution_artifacts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          observation_id TEXT NOT NULL REFERENCES execution_observations(id),
          owner_type TEXT NOT NULL CHECK(owner_type IN ('observation', 'finding')),
          owner_id TEXT NOT NULL CHECK(length(owner_id) > 0),
          name TEXT NOT NULL CHECK(length(name) > 0),
          relative_path TEXT NOT NULL CHECK(length(relative_path) > 0),
          media_type TEXT NOT NULL CHECK(length(media_type) > 0),
          size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
          digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256) = 64),
          created_at INTEGER NOT NULL,
          UNIQUE(project_id, owner_type, owner_id, relative_path)
        );
      `);
      db.exec(`
        CREATE INDEX idx_artifacts_observation ON execution_artifacts(observation_id);
      `);

      for (const table of [
        "execution_observations",
        "execution_checks",
        "execution_artifacts",
        "factory_finding_events",
      ]) {
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

      db.exec(`
        CREATE TRIGGER factory_findings_immutable_delete
        BEFORE DELETE ON factory_findings
        BEGIN
          SELECT RAISE(ABORT, 'factory_finding_immutable');
        END;
      `);
      db.exec(`
        CREATE TRIGGER factory_findings_immutable_update
        BEFORE UPDATE ON factory_findings
        WHEN NEW.id IS NOT OLD.id
          OR NEW.project_id IS NOT OLD.project_id
          OR NEW.delivery_id IS NOT OLD.delivery_id
          OR NEW.run_id IS NOT OLD.run_id
          OR NEW.work_id IS NOT OLD.work_id
          OR NEW.issue_number IS NOT OLD.issue_number
          OR NEW.ac_key IS NOT OLD.ac_key
          OR NEW.severity IS NOT OLD.severity
          OR NEW.file_context IS NOT OLD.file_context
          OR NEW.summary IS NOT OLD.summary
          OR NEW.origin_observation_id IS NOT OLD.origin_observation_id
          OR NEW.created_at IS NOT OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'factory_finding_immutable');
        END;
      `);
    },
  },
];
