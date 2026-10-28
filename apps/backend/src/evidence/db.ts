import type { DatabaseSync } from "node:sqlite";

export function applyEvidenceMigrations(db: DatabaseSync): void {
  // Table for candidate-bound verification records (AC1, AC2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_verifications (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      spec_issue_number INTEGER,
      pr_number INTEGER NOT NULL,
      candidate_head_sha TEXT NOT NULL,
      merge_base_sha TEXT NOT NULL,
      runtime_environment TEXT NOT NULL,
      producer_identity TEXT NOT NULL,
      verification_status TEXT NOT NULL CHECK(verification_status IN ('passed', 'failed', 'unverified')),
      checks TEXT NOT NULL DEFAULT '[]',
      review TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cand_verif_proj_pr ON candidate_verifications(project_id, pr_number);
    CREATE INDEX IF NOT EXISTS idx_cand_verif_proj_head ON candidate_verifications(project_id, candidate_head_sha);
  `);

  // Table for gate approvals (AC5)
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_approvals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      gate_id TEXT NOT NULL,
      candidate_sha TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
      actor TEXT NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gate_approvals_proj_gate ON gate_approvals(project_id, gate_id);
    CREATE INDEX IF NOT EXISTS idx_gate_approvals_candidate ON gate_approvals(candidate_sha);
  `);

  // Table for tracked run processes (AC4)
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_processes (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      pid INTEGER NOT NULL,
      child_pids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('running', 'cancelled', 'terminated', 'completed', 'failed')),
      started_at TEXT NOT NULL,
      terminated_at TEXT
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_run_proc_proj ON run_processes(project_id);
  `);

  // Table for landed candidates (AC1, AC2, AC5)
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidate_landings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      pr_number INTEGER NOT NULL,
      candidate_head_sha TEXT NOT NULL,
      merge_base_sha TEXT NOT NULL,
      merge_sha TEXT NOT NULL,
      landed_by TEXT NOT NULL,
      landed_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cand_landings_proj_head ON candidate_landings(project_id, candidate_head_sha);
  `);
}
