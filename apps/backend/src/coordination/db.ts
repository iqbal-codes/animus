import type { DatabaseSync } from "node:sqlite";

export function applyCoordinationMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_spec_coordinations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      spec_issue_number INTEGER NOT NULL,
      is_standalone INTEGER NOT NULL DEFAULT 0,
      integration_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      current_integration_sha TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('planning', 'active', 'halted', 'completed')),
      plan_snapshot TEXT NOT NULL,
      final_pr_number INTEGER,
      final_pr_url TEXT,
      halt_reason TEXT,
      halt_attribution TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_coord_proj_issue
    ON project_spec_coordinations(project_id, spec_issue_number);
  `);
}
