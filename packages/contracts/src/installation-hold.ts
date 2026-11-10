import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InstallationHold } from "./operator";
import { resolveAnimusStateDir } from "./paths";

export const INSTALLATION_HOLD_ID = "installation";

/**
 * Thrown whenever a restored installation is still held. Dispatch, publication,
 * native launch and delivery runtime must all fail closed with this error rather
 * than performing an outward effect.
 */
export class InstallationHeldError extends Error {
  readonly code = "installation_held";

  constructor(public readonly reason: string) {
    super(`installation_held: ${reason}`);
    this.name = "InstallationHeldError";
  }
}

/**
 * Thrown when the installation database exists but its hold state cannot be
 * read (corrupt, locked, unsupported schema). A hold check must never fail open:
 * an unreadable database is treated as unsafe, not as "not held".
 */
export class InstallationHoldUnavailableError extends Error {
  readonly code = "installation_hold_unavailable";

  constructor(
    public readonly stateDir: string,
    message: string,
  ) {
    super(`installation_hold_unavailable: ${message}`);
    this.name = "InstallationHoldUnavailableError";
  }
}

export class InstallationHoldConflictError extends Error {
  readonly code = "restore_reconcile_conflict";

  constructor(message: string) {
    super(message);
    this.name = "InstallationHoldConflictError";
  }
}

interface HoldRow {
  status: "held" | "reconciled";
  reason: string;
  source_restore_id: string | null;
  restored_at: number;
  reconciled_at: number | null;
  reconciliation_report: string | null;
}

export function emptyInstallationHold(): InstallationHold {
  return {
    held: false,
    status: null,
    reason: null,
    sourceRestoreId: null,
    restoredAt: null,
    reconciledAt: null,
    reconciliation: null,
  };
}

export function readInstallationHold(db: DatabaseSync): InstallationHold {
  const row = db
    .prepare(
      "SELECT status, reason, source_restore_id, restored_at, reconciled_at, reconciliation_report FROM installation_holds WHERE id = ?",
    )
    .get(INSTALLATION_HOLD_ID) as HoldRow | undefined;
  if (!row) return emptyInstallationHold();
  return {
    held: row.status === "held",
    status: row.status,
    reason: row.reason,
    sourceRestoreId: row.source_restore_id,
    restoredAt: row.restored_at,
    reconciledAt: row.reconciled_at,
    reconciliation: parseReconciliation(row.reconciliation_report),
  };
}

function parseReconciliation(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function assertHoldNotActive(hold: InstallationHold): void {
  if (hold.held) {
    throw new InstallationHeldError(hold.reason ?? "restored_installation_pending_reconciliation");
  }
}

/**
 * Hold lookup for out-of-process launchers (CLI, scheduler, native loop, engine
 * host) that resolve the Animus state directory rather than holding a kernel
 * connection.
 *
 * The connection is opened read-write and immediately restricted with
 * `PRAGMA query_only = ON`. SQLite cannot reliably read a WAL-mode database
 * through a read-only connection once its `-shm` file is gone, which would turn a
 * cleanly closed installation into a false "hold unavailable" refusal. query_only
 * keeps the same no-write guarantee at the SQL layer while letting SQLite attach
 * the WAL bookkeeping it needs.
 *
 * A missing database is a brand-new installation and a missing hold table is a
 * pre-v11 installation; both have no hold. Every other failure (open, corrupt or
 * locked/read error) throws {@link InstallationHoldUnavailableError} so callers
 * fail closed instead of launching against an unverifiable installation.
 */
export function readInstallationHoldAtStateDir(stateDir?: string): InstallationHold {
  const resolved = resolveAnimusStateDir(stateDir);
  const dbPath = join(resolved, "console.db");
  if (!existsSync(dbPath)) return emptyInstallationHold();

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = ON;");
  } catch (error) {
    throw new InstallationHoldUnavailableError(
      resolved,
      `cannot open ${dbPath}: ${errorMessage(error)}`,
    );
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'installation_holds'",
      )
      .get() as { name: string } | undefined;
    if (!table) return emptyInstallationHold();
    return readInstallationHold(db);
  } catch (error) {
    throw new InstallationHoldUnavailableError(
      resolved,
      `cannot read the installation hold from ${dbPath}: ${errorMessage(error)}`,
    );
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/**
 * Dispatch and publication call this before any external effect. A restored
 * installation is held until an operator records verified reconciliation, so a
 * restore flag can never silently re-enable work that belonged to lost processes.
 */
export function assertInstallationNotHeld(db: DatabaseSync): void {
  assertHoldNotActive(readInstallationHold(db));
}

/** Same authoritative hold policy for launchers that only know the state dir. */
export function assertInstallationNotHeldAtStateDir(stateDir?: string): void {
  assertHoldNotActive(readInstallationHoldAtStateDir(stateDir));
}

export interface ReconcileHoldInput {
  actor: string;
  now: number;
  reconciliation: Record<string, unknown>;
  /** Fence to the exact snapshot being released. */
  expected: { sourceRestoreId: string | null; restoredAt: number | null };
}

/**
 * Atomically release a held installation only when it is still the exact
 * snapshot the operator reconciled. A concurrent restore or release changes the
 * fence and refuses instead of clearing a newer hold.
 */
export function reconcileInstallationHold(
  db: DatabaseSync,
  input: ReconcileHoldInput,
): InstallationHold {
  const result = db
    .prepare(
      `UPDATE installation_holds
          SET status = 'reconciled',
              reconciled_at = ?,
              reconciled_by = ?,
              reconciliation_report = ?
        WHERE id = ?
          AND status = 'held'
          AND source_restore_id IS ?
          AND restored_at = ?`,
    )
    .run(
      input.now,
      input.actor,
      JSON.stringify(input.reconciliation),
      INSTALLATION_HOLD_ID,
      input.expected.sourceRestoreId,
      input.expected.restoredAt,
    );
  if (Number(result.changes ?? 0) === 0) {
    throw new InstallationHoldConflictError(
      "Installation hold changed while reconciling; re-read the restored snapshot and retry",
    );
  }
  return readInstallationHold(db);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
