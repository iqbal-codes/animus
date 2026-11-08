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
