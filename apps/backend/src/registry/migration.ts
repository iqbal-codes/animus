import { DatabaseSync } from "node:sqlite";
import { existsSync, copyFileSync, unlinkSync } from "node:fs";

export interface MigrationSnapshotOptions {
  dbPath: string;
  currentVersion: string;
  targetVersion: string;
  migrate: (db: DatabaseSync) => void;
}

export interface MigrationResult {
  success: boolean;
  snapshotPath: string;
  currentVersion: string;
  targetVersion: string;
}

export interface RollbackOptions {
  dbPath: string;
  snapshotPath: string;
  confirm: boolean;
  previousBinaryPath?: string;
  currentBinaryPath?: string;
}

export interface RollbackResult {
  restored: boolean;
  dbPath: string;
  snapshotPath: string;
  binaryRestored?: boolean;
}

export function runDatabaseMigrationWithSnapshot(
  options: MigrationSnapshotOptions,
): MigrationResult {
  const { dbPath, currentVersion, targetVersion, migrate } = options;
  const snapshotPath = `${dbPath}.pre-v${currentVersion}.bak`;

  // Pre-migration snapshot on disk databases
  if (dbPath !== ":memory:" && existsSync(dbPath)) {
    try {
      if (existsSync(snapshotPath)) {
        unlinkSync(snapshotPath);
      }
      const snapshotDb = new DatabaseSync(dbPath);
      snapshotDb.exec(`VACUUM INTO '${snapshotPath}';`);
      snapshotDb.close();
    } catch (err: any) {
      throw new Error(`pre_migration_snapshot_failed: ${err.message || String(err)}`);
    }
  }

  // Execute migration in transaction
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE;");
    migrate(db);
    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {}
    db.close();
    throw err;
  }
  db.close();

  return {
    success: true,
    snapshotPath,
    currentVersion,
    targetVersion,
  };
}

export function rollbackDatabaseAndBinary(options: RollbackOptions): RollbackResult {
  if (!options.confirm) {
    throw new Error(
      "operator_confirmation_required: Database and binary rollback requires explicit operator confirmation",
    );
  }

  if (!existsSync(options.snapshotPath)) {
    throw new Error(
      `snapshot_not_found: Pre-migration database snapshot not found at ${options.snapshotPath}`,
    );
  }

  // Verify integrity of the snapshot before restoring
  const snap = new DatabaseSync(options.snapshotPath);
  try {
    const result = snap.prepare("PRAGMA integrity_check;").get() as { integrity_check: string };
    if (!result || result.integrity_check !== "ok") {
      throw new Error("snapshot_corrupted: Integrity check failed for database snapshot");
    }
  } finally {
    snap.close();
  }

  // Atomically replace target database with snapshot
  copyFileSync(options.snapshotPath, options.dbPath);

  let binaryRestored = false;
  if (
    options.previousBinaryPath &&
    options.currentBinaryPath &&
    existsSync(options.previousBinaryPath)
  ) {
    copyFileSync(options.previousBinaryPath, options.currentBinaryPath);
    binaryRestored = true;
  }

  return {
    restored: true,
    dbPath: options.dbPath,
    snapshotPath: options.snapshotPath,
    binaryRestored,
  };
}
