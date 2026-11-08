import type { Migration } from "../registry/migrations";

/**
 * Workspace backup/restore (#164) owns version 11 in the one ordered registry.
 * Child gate integration (#158) owns 8, final delivery (#159) keeps 9 reserved,
 * and approved-draft issue publication (#162) owns 10. This module appends 11
 * rather than claiming one of those numbers inside feature code.
 */
export const RESTORE_MIGRATIONS: Migration[] = [
  {
    version: 11,
    name: "workspace_backup_restore",
    up(db) {
      // Durable record of every backup attempt. Only `complete` rows that still
      // verify on disk are advertised as restorable.
      db.exec(`
        CREATE TABLE backup_snapshots (
          id TEXT PRIMARY KEY,
          destination_path TEXT NOT NULL CHECK(length(destination_path) > 0),
          manifest_version INTEGER NOT NULL CHECK(manifest_version > 0),
          manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
          database_sha256 TEXT NOT NULL CHECK(length(database_sha256) = 64),
          database_size_bytes INTEGER NOT NULL CHECK(database_size_bytes >= 0),
          artifact_count INTEGER NOT NULL CHECK(artifact_count >= 0),
          schema_version INTEGER NOT NULL CHECK(schema_version > 0),
          status TEXT NOT NULL CHECK(status IN ('complete', 'failed')),
          created_by TEXT NOT NULL CHECK(length(created_by) > 0),
          error TEXT,
          verified_at INTEGER,
          created_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL,
          UNIQUE(destination_path)
        );
      `);
      db.exec(`
        CREATE INDEX idx_backup_snapshots_status
        ON backup_snapshots(status, created_at DESC);
      `);

      // Restore attempts performed by this installation. The report is a validated
      // JSON object so a failed restore keeps an actionable diagnosis without a
      // partial target installation.
      db.exec(`
        CREATE TABLE restore_operations (
          id TEXT PRIMARY KEY,
          source_path TEXT NOT NULL CHECK(length(source_path) > 0),
          target_state_dir TEXT NOT NULL CHECK(length(target_state_dir) > 0),
          manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
          status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
          report TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL
        );
      `);
      db.exec(`
        CREATE INDEX idx_restore_operations_created
        ON restore_operations(created_at DESC);
      `);

      // A restored installation is held until an operator explicitly reconciles
      // process ownership and pending external effects. The singleton row applies
      // installation-wide; dispatch and publication fail closed while status=held.
      db.exec(`
        CREATE TABLE installation_holds (
          id TEXT PRIMARY KEY CHECK(id = 'installation'),
          status TEXT NOT NULL CHECK(status IN ('held', 'reconciled')),
          reason TEXT NOT NULL CHECK(length(reason) > 0),
          source_restore_id TEXT,
          restored_at INTEGER NOT NULL,
          reconciled_at INTEGER,
          reconciled_by TEXT,
          reconciliation_report TEXT
        );
      `);
    },
  },
];
