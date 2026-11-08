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
];

export function applyWorkMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );

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
