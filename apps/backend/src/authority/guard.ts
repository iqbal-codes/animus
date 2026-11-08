import type { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import {
  ExecutionAuthorityGateError,
  readExecutionAuthority,
  type ExecutionAuthorityState,
} from "@animus/contracts/execution-authority";
import { resolveAnimusStateDir } from "@animus/contracts/paths";

/**
 * Resolves the installation state dir from the connection's own database file
 * instead of ambient environment, so a temp service never reads another
 * installation's marker. Falls back to the env-resolved state dir for in-memory
 * databases.
 */
export function resolveStateDirForDatabase(db: DatabaseSync, override?: string): string {
  if (override && override.trim() !== "") return resolve(override.trim());
  try {
    const rows = db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
    const main = rows.find((row) => row.name === "main");
    if (main?.file && main.file !== ":memory:") return dirname(resolve(main.file));
  } catch {}
  return resolveAnimusStateDir();
}

/**
 * Shared execution-authority gate for every external-effect writer.
 *
 * The durable marker is the single authority. A `local` marker is only trusted
 * when the database proves the matching cutover operation actually reached
 * `activated`; a marker without that row (crash, tamper or a stale restore) stays
 * fenced so neither legacy nor local writers can become a dual writer.
 *
 * `legacy` (before cutover) and `local` (verified after cutover) are settled.
 * `migrating`, an unreadable marker and an unverified `local` marker fail closed.
 */
export interface AuthorityGateDecision {
  marker: ExecutionAuthorityState;
  settled: boolean;
  reason: string | null;
}

export function evaluateExecutionAuthority(
  db: DatabaseSync,
  stateDir?: string,
): AuthorityGateDecision {
  const marker = readExecutionAuthority(resolveStateDirForDatabase(db, stateDir));
  if (marker.error) {
    return { marker, settled: false, reason: `authority_marker_unreadable:${marker.error}` };
  }
  if (marker.authority === "migrating") {
    return { marker, settled: false, reason: "authority_cutover_in_progress" };
  }
  if (marker.authority === "local") {
    let rows: Array<{ id: string; status: string }>;
    try {
      rows = db.prepare("SELECT id, status FROM authority_cutover_operations").all() as Array<{
        id: string;
        status: string;
      }>;
    } catch {
      return { marker, settled: false, reason: "authority_marker_without_activated_cutover" };
    }
    // No cutover rows means this installation was marked local outside a staged
    // operation (operator action or an embedder fixture). There is no incomplete
    // operation row to authorize, so the marker is the only authority.
    if (rows.length === 0) return { marker, settled: true, reason: null };
    const activated = rows.find((row) => row.status === "activated");
    if (!activated) {
      return { marker, settled: false, reason: "authority_marker_without_activated_cutover" };
    }
    if (marker.cutover_id && marker.cutover_id !== activated.id) {
      return { marker, settled: false, reason: "authority_marker_cutover_mismatch" };
    }
  }
  return { marker, settled: true, reason: null };
}

/**
 * Refuse before any remote push, PR/issue mutation, child landing, final advance,
 * delivery write or intent ledger write while the authority is not settled.
 */
export function assertExternalWriterAllowed(
  db: DatabaseSync,
  stateDir?: string,
): AuthorityGateDecision {
  const decision = evaluateExecutionAuthority(db, stateDir);
  if (!decision.settled) {
    throw new ExecutionAuthorityGateError(
      "execution_authority_moving",
      `execution_authority_moving: ${decision.reason ?? "execution authority is not settled"}`,
    );
  }
  return decision;
}

/**
 * Local dispatchers must additionally require the completed local authority. A
 * `legacy` installation has not been admitted and must use the legacy path.
 */
export function assertLocalDispatchAllowed(
  db: DatabaseSync,
  stateDir?: string,
): AuthorityGateDecision {
  const decision = evaluateExecutionAuthority(db, stateDir);
  if (!decision.settled || decision.marker.authority !== "local") {
    throw new ExecutionAuthorityGateError(
      "authority_not_activated",
      "authority_not_activated: the installation has not completed its local authority cutover",
    );
  }
  return decision;
}

export function resolveAuthorityStateDir(stateDir?: string): string {
  return resolveAnimusStateDir(stateDir);
}
