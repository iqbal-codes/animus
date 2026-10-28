import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function resolveStateDir(): string {
  const custom = process.env.FACTORY_STATE_DIR;
  if (custom && custom.trim() !== "") {
    return custom;
  }
  return join(homedir(), ".factory", "state");
}

export function ensureStateDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // If chmod fails due to filesystem restrictions (e.g. some tmp mounts), continue
  }
}

export function initializeDatabase(dbPath?: string): DatabaseSync {
  const resolvedPath = dbPath ?? join(resolveStateDir(), "console.db");
  if (resolvedPath !== ":memory:") {
    ensureStateDirectory(dirname(resolvedPath));
  }
  const db = new DatabaseSync(resolvedPath);

  // Configure SQLite WAL mode and strict integrity
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  // Migration: create projects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_id INTEGER NOT NULL,
      repo_name TEXT NOT NULL,
      checkout_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'held', 'tombstone')),
      status_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Partial unique index: only one active or held project per unique repo_id
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_active_repo_id
    ON projects(repo_id)
    WHERE status != 'tombstone';
  `);

  // Table to track project runs for active run checks
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Table to track verified local branch integration status for subtickets/issues
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_issue_integrations (
      project_id TEXT NOT NULL REFERENCES projects(id),
      issue_number INTEGER NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT,
      integrated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, issue_number)
    );
  `);

  return db;
}
