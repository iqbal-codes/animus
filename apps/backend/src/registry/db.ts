import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import {
  resolveAnimusStateDir,
  ensureSecureDirectory,
  migrateLegacyState,
} from "@animus/contracts/paths";
import { applyCommandMigrations } from "../command/db";
import { applyCoordinationMigrations } from "../coordination/db";
import { applyEvidenceMigrations } from "../evidence/db";
import { WORK_MIGRATIONS } from "../work/db";
import { DRAFT_MIGRATIONS } from "../draft/db";
import { DISPATCH_MIGRATIONS } from "../dispatch/db";
import { applyMigrations, type Migration } from "./migrations";

/**
 * Single ordered migration registry for the schema-migrated subsystem.
 *
 * Versions are owned here, not by the feature modules that contribute them.
 * Work identity (#152) owns version 1, prepared plan admission (#153) owns
 * version 2, local draft authoring (#161) owns version 3, and delivery
 * dispatch ownership (#154) owns version 4. A future lane appends the next
 * version instead of claiming an existing one.
 */
export const SCHEMA_MIGRATIONS: Migration[] = [
  ...WORK_MIGRATIONS,
  ...DRAFT_MIGRATIONS,
  ...DISPATCH_MIGRATIONS,
];

export function resolveStateDir(): string {
  const custom = process.env.ANIMUS_STATE_DIR || process.env.FACTORY_STATE_DIR;
  if (custom && custom.trim() !== "") {
    return resolveAnimusStateDir(custom);
  }
  migrateLegacyState();
  return resolveAnimusStateDir();
}

export function ensureStateDirectory(dirPath: string): void {
  ensureSecureDirectory(dirPath);
}

export function initializeDatabase(dbPath?: string): DatabaseSync {
  const resolvedPath = dbPath ?? join(resolveStateDir(), "console.db");
  if (resolvedPath !== ":memory:") {
    ensureStateDirectory(dirname(resolvedPath));
  }
  const db = new DatabaseSync(resolvedPath);

  // Configure SQLite WAL mode and strict integrity
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  verifyDatabasePragmas(db, resolvedPath);

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

  applyCommandMigrations(db);
  applyCoordinationMigrations(db);
  applyEvidenceMigrations(db);
  applyMigrations(db, SCHEMA_MIGRATIONS);

  return db;
}

function verifyDatabasePragmas(db: DatabaseSync, resolvedPath: string): void {
  const journal = db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
  const synchronous = db.prepare("PRAGMA synchronous;").get() as
    | { synchronous?: number }
    | undefined;
  const foreignKeys = db.prepare("PRAGMA foreign_keys;").get() as
    | { foreign_keys?: number }
    | undefined;

  if (resolvedPath !== ":memory:" && String(journal?.journal_mode).toLowerCase() !== "wal") {
    throw new Error("SQLite WAL journal mode is unavailable");
  }
  if (Number(synchronous?.synchronous) !== 2) {
    throw new Error("SQLite FULL synchronous mode is unavailable");
  }
  if (Number(foreignKeys?.foreign_keys) !== 1) {
    throw new Error("SQLite foreign key enforcement is unavailable");
  }
}
