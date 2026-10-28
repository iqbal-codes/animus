import type { DatabaseSync } from "node:sqlite";

export function applyCommandMigrations(db: DatabaseSync): void {
  // Commands table: stores durable-before-dispatch records, outcomes, and audit trails
  db.exec(`
    CREATE TABLE IF NOT EXISTS commands (
      request_id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      project_id TEXT,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('rejected', 'dispatched', 'acknowledged', 'running', 'succeeded', 'failed', 'partial', 'unknown')),
      outcome TEXT,
      evidence_links TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reconciled_at TEXT
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_commands_project_id ON commands(project_id);
    CREATE INDEX IF NOT EXISTS idx_commands_state ON commands(state);
    CREATE INDEX IF NOT EXISTS idx_commands_created_at ON commands(created_at);
  `);

  // Brakes table: stores independent hierarchical launch brakes and schedule pause
  db.exec(`
    CREATE TABLE IF NOT EXISTS brakes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
      project_id TEXT,
      brake_type TEXT NOT NULL CHECK(brake_type IN ('launch_brake', 'schedule_pause')),
      active INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_brakes_scope_type
    ON brakes(scope, brake_type, IFNULL(project_id, ''));
  `);
}
