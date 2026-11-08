import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveAnimusStateDir } from "@animus/contracts/paths";
import type { InstallationHold } from "@animus/contracts/operator";

export const INSTALLATION_HOLD_ID = "installation";

export class InstallationHeldError extends Error {
  readonly code = "installation_held";

  constructor(public readonly reason: string) {
    super(`installation_held: ${reason}`);
    this.name = "InstallationHeldError";
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

export function readInstallationHold(db: DatabaseSync): InstallationHold {
  const row = db
    .prepare(
      "SELECT status, reason, source_restore_id, restored_at, reconciled_at, reconciliation_report FROM installation_holds WHERE id = ?",
    )
    .get(INSTALLATION_HOLD_ID) as HoldRow | undefined;
  if (!row) {
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

function assertHoldNotActive(hold: InstallationHold | null): void {
  if (hold?.held) {
    throw new InstallationHeldError(hold.reason ?? "restored_installation_pending_reconciliation");
  }
}

/**
 * Dispatch and publication call this before any external effect. A restored
 * installation is held until an operator records explicit reconciliation, so a
 * restore flag can never silently re-enable work that belonged to lost processes.
 */
export function assertInstallationNotHeld(db: DatabaseSync): void {
  assertHoldNotActive(readInstallationHold(db));
}

/**
 * Read-only hold lookup for out-of-process launchers (CLI, scheduler, native
 * loop) that resolve the Animus state directory rather than holding a kernel
 * connection. A missing database or pre-v11 schema has no hold.
 */
export function readInstallationHoldAtStateDir(stateDir?: string): InstallationHold | null {
  const dbPath = join(resolveAnimusStateDir(stateDir), "console.db");
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'installation_holds'",
      )
      .get() as { name: string } | undefined;
    if (!table) return null;
    return readInstallationHold(db);
  } finally {
    try {
      db.close();
    } catch {}
  }
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

export class InstallationHoldConflictError extends Error {
  readonly code = "restore_reconcile_conflict";

  constructor(message: string) {
    super(message);
    this.name = "InstallationHoldConflictError";
  }
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
