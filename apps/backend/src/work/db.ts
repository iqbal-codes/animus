import type { DatabaseSync } from "node:sqlite";

interface WorkMigration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS: WorkMigration[] = [
  {
    version: 1,
    name: "project_work_identity_and_revisions",
    up(db) {
      db.exec(`
        CREATE TABLE work_items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          repo_id INTEGER NOT NULL CHECK(repo_id > 0),
          repo_name TEXT NOT NULL,
          issue_number INTEGER NOT NULL CHECK(issue_number > 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(repo_id, issue_number)
        );
      `);
      db.exec(`
        CREATE INDEX idx_work_items_project ON work_items(project_id, issue_number);
      `);
      db.exec(`
        CREATE TABLE work_revisions (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          revision_number INTEGER NOT NULL CHECK(revision_number > 0),
          content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
          source_title TEXT NOT NULL CHECK(length(source_title) > 0),
          source_body TEXT NOT NULL,
          source_state TEXT NOT NULL CHECK(source_state IN ('OPEN', 'CLOSED')),
          source_labels TEXT NOT NULL,
          source_comments TEXT NOT NULL,
          source_url TEXT NOT NULL,
          provenance TEXT NOT NULL,
          imported_at INTEGER NOT NULL,
          UNIQUE(work_id, revision_number),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_work_revisions_work
        ON work_revisions(work_id, revision_number DESC);
      `);
      db.exec(`
        CREATE TRIGGER work_revisions_immutable_update
        BEFORE UPDATE ON work_revisions
        BEGIN
          SELECT RAISE(ABORT, 'work_revision_immutable');
        END;
      `);
      db.exec(`
        CREATE TRIGGER work_revisions_immutable_delete
        BEFORE DELETE ON work_revisions
        BEGIN
          SELECT RAISE(ABORT, 'work_revision_immutable');
        END;
      `);
    },
  },
  {
    version: 2,
    name: "prepared_plan_admission",
    up(db) {
      db.exec(`
        CREATE UNIQUE INDEX uq_work_revisions_id_work ON work_revisions(id, work_id);
      `);
      db.exec(`
        CREATE TABLE plans (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          kind TEXT NOT NULL CHECK(kind IN ('standalone', 'spec')),
          root_work_id TEXT NOT NULL,
          root_revision_id TEXT NOT NULL,
          graph_hash TEXT NOT NULL CHECK(length(graph_hash) = 64),
          evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
          delivery_branch TEXT NOT NULL CHECK(length(delivery_branch) > 0),
          integration_branch TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          UNIQUE(root_work_id, graph_hash, evidence_hash),
          FOREIGN KEY(root_work_id, project_id) REFERENCES work_items(id, project_id),
          FOREIGN KEY(root_revision_id, root_work_id) REFERENCES work_revisions(id, work_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_plans_project ON plans(project_id, created_at DESC);
      `);
      db.exec(`
        CREATE TABLE plan_members (
          plan_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('spec', 'ticket')),
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('child', 'standalone', 'final')),
          issue_number INTEGER NOT NULL CHECK(issue_number > 0),
          PRIMARY KEY(plan_id, work_id),
          UNIQUE(plan_id, issue_number),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id),
          FOREIGN KEY(revision_id, work_id) REFERENCES work_revisions(id, work_id)
        );
      `);
      db.exec(`
        CREATE TABLE plan_acceptance_criteria (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          ac_key TEXT NOT NULL CHECK(length(ac_key) > 0),
          ordinal INTEGER NOT NULL CHECK(ordinal > 0),
          text TEXT NOT NULL,
          UNIQUE(plan_id, work_id, ac_key),
          FOREIGN KEY(plan_id, work_id) REFERENCES plan_members(plan_id, work_id),
          FOREIGN KEY(revision_id, work_id) REFERENCES work_revisions(id, work_id)
        );
      `);
      db.exec(`
        CREATE TABLE plan_dependencies (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          target_issue_number INTEGER NOT NULL CHECK(target_issue_number > 0),
          source TEXT NOT NULL CHECK(source IN ('textual', 'native', 'textual+native')),
          target_role TEXT NOT NULL CHECK(target_role IN ('internal', 'external', 'unresolved')),
          target_work_id TEXT,
          target_revision_id TEXT,
          UNIQUE(plan_id, work_id, target_issue_number),
          FOREIGN KEY(plan_id, work_id) REFERENCES plan_members(plan_id, work_id),
          FOREIGN KEY(revision_id, work_id) REFERENCES work_revisions(id, work_id),
          FOREIGN KEY(target_work_id) REFERENCES work_items(id),
          FOREIGN KEY(target_revision_id, target_work_id) REFERENCES work_revisions(id, work_id)
        );
      `);
      db.exec(`
        CREATE TABLE plan_coverage (
          plan_id TEXT NOT NULL,
          parent_ac_key TEXT NOT NULL,
          child_work_id TEXT NOT NULL,
          note TEXT,
          PRIMARY KEY(plan_id, parent_ac_key, child_work_id),
          FOREIGN KEY(plan_id, child_work_id) REFERENCES plan_members(plan_id, work_id)
        );
      `);
      db.exec(`
        CREATE TABLE plan_holds (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          member_work_id TEXT,
          issue_number INTEGER,
          code TEXT NOT NULL CHECK(length(code) > 0),
          severity TEXT NOT NULL CHECK(severity IN ('blocking', 'conditional')),
          detail TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(plan_id) REFERENCES plans(id),
          FOREIGN KEY(member_work_id) REFERENCES work_items(id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_plan_holds_plan ON plan_holds(plan_id);
      `);
      db.exec(`
        CREATE TABLE plan_manifests (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          graph_hash TEXT NOT NULL CHECK(length(graph_hash) = 64),
          manifest TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(id, plan_id),
          UNIQUE(plan_id, graph_hash),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id)
        );
      `);
      db.exec(`
        CREATE TABLE plan_decisions (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          action TEXT NOT NULL CHECK(action IN ('import', 'approve', 'revoke')),
          outcome TEXT NOT NULL CHECK(outcome IN ('admitted', 'held', 'revoked')),
          actor TEXT NOT NULL CHECK(length(actor) > 0),
          source TEXT NOT NULL CHECK(source IN ('import_authorization', 'operator')),
          reason TEXT,
          manifest_id TEXT,
          evidence TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          UNIQUE(plan_id, sequence),
          FOREIGN KEY(plan_id) REFERENCES plans(id),
          FOREIGN KEY(manifest_id) REFERENCES plan_manifests(id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_plan_decisions_plan ON plan_decisions(plan_id, sequence);
      `);
      for (const table of [
        "plans",
        "plan_members",
        "plan_acceptance_criteria",
        "plan_dependencies",
        "plan_coverage",
        "plan_holds",
        "plan_manifests",
        "plan_decisions",
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
    },
  },
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
          stage TEXT NOT NULL CHECK(stage IN ('builder_execution', 'technical_checks', 'independent_review', 'final_acceptance')),
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

export function applyWorkMigrations(db: DatabaseSync): void {
  const declared = new Map<number, string>();
  for (const migration of MIGRATIONS) {
    const existing = declared.get(migration.version);
    if (existing !== undefined) {
      throw new Error(
        `Work migration version collision at ${migration.version}: '${existing}' and '${migration.name}'`,
      );
    }
    declared.set(migration.version, migration.name);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = db.prepare("SELECT version, name FROM schema_migrations").all() as Array<{
    version: number;
    name: string;
  }>;
  const applied = new Map(appliedRows.map((row) => [row.version, row.name]));

  // Fail closed when an already-applied version disagrees with this codebase: two branches
  // that both claimed a version would otherwise leave the later table set unapplied.
  for (const [version, name] of applied) {
    const declaredName = declared.get(version);
    if (declaredName !== undefined && declaredName !== name) {
      throw new Error(
        `Work migration version collision at ${version}: database applied '${name}', code declares '${declaredName}'`,
      );
    }
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      const present = db
        .prepare("SELECT 1 AS present FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (!present) {
        migration.up(db);
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, Date.now());
      }
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }
}
