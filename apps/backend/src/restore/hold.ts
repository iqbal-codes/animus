import type { DatabaseSync } from "node:sqlite";
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
}

export function readInstallationHold(db: DatabaseSync): InstallationHold {
  const row = db
    .prepare(
      "SELECT status, reason, source_restore_id, restored_at, reconciled_at FROM installation_holds WHERE id = ?",
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
    };
  }
  return {
    held: row.status === "held",
    status: row.status,
    reason: row.reason,
    sourceRestoreId: row.source_restore_id,
    restoredAt: row.restored_at,
    reconciledAt: row.reconciled_at,
  };
}

/**
 * Dispatch and publication call this before any external effect. A restored
 * installation is held until an operator records explicit reconciliation, so a
 * restore flag can never silently re-enable work that belonged to lost processes.
 */
export function assertInstallationNotHeld(db: DatabaseSync): void {
  const hold = readInstallationHold(db);
  if (hold.held) {
    throw new InstallationHeldError(hold.reason ?? "restored_installation_pending_reconciliation");
  }
}

export function reconcileInstallationHold(
  db: DatabaseSync,
  input: { actor: string; now: number },
): InstallationHold {
  db.prepare(
    `UPDATE installation_holds
        SET status = 'reconciled', reconciled_at = ?, reconciled_by = ?
      WHERE id = ? AND status = 'held'`,
  ).run(input.now, input.actor, INSTALLATION_HOLD_ID);
  return readInstallationHold(db);
}
