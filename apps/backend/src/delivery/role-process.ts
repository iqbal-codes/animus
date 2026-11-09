import type { DatabaseSync } from "node:sqlite";
import type { DeliveryRoleClaimRecord, DeliveryRoleProcessState } from "@animus/contracts/operator";
import { pidOrGroupAlive, processStartIdentity } from "../dispatch/ownership";

interface ClaimProcessRow {
  id: string;
  stage: string;
  lap: number;
  state: string;
  disposition: string;
  owner_pid: number | null;
  owner_process_start: string | null;
  role_pid: number | null;
  role_pgid: number | null;
  role_process_start: string | null;
}

function probeOwner(row: ClaimProcessRow): "alive" | "dead" | "unknown" {
  if (row.owner_pid === null || row.owner_process_start === null) return "unknown";
  const ownerStart = processStartIdentity(row.owner_pid);
  if (ownerStart === row.owner_process_start && pidOrGroupAlive(row.owner_pid, row.owner_pid)) {
    return "alive";
  }
  if (row.role_pid === null) return "dead";
  if (row.role_process_start === null) return "unknown";
  const roleStart = processStartIdentity(row.role_pid);
  if (
    roleStart === row.role_process_start &&
    pidOrGroupAlive(row.role_pid, row.role_pgid ?? row.role_pid)
  ) {
    return "alive";
  }
  return "dead";
}

/**
 * Read the actual OS presence of the delivery-role process recorded for a run.
 *
 * A role process is only signallable when its persisted start identity still
 * matches the live pid (no PID reuse) and it is the group leader (pgid == pid),
 * matching the bounded role runner invariant. Anything unreadable stays
 * `alive:true` so a caller fails closed rather than killing an unrelated process.
 */
export function readRoleProcesses(
  db: DatabaseSync,
  projectId: string,
  runId: string,
): DeliveryRoleProcessState[] {
  const rows = db
    .prepare(
      `SELECT id, stage, lap, state, disposition, owner_pid, owner_process_start,
              role_pid, role_pgid, role_process_start
         FROM delivery_role_claims
        WHERE project_id = ? AND run_id = ?
        ORDER BY lap ASC, stage ASC`,
    )
    .all(projectId, runId) as unknown as ClaimProcessRow[];
  return rows.map((row) => {
    const ownerProbe = probeOwner(row);
    // Only a running or interrupted claim can be a physical writer. A completed or
    // failed claim legitimately retains the pid of the process that already
    // finished; that pid may be reused by an unrelated live process.
    const claimCanWrite = row.state === "running" || row.state === "interrupted";
    let verified = false;
    let alive = false;
    if (claimCanWrite && row.role_pid !== null) {
      const roleStart = row.role_process_start !== null ? processStartIdentity(row.role_pid) : null;
      verified =
        row.role_process_start !== null &&
        roleStart === row.role_process_start &&
        (row.role_pgid ?? row.role_pid) === row.role_pid;
      alive = verified ? pidOrGroupAlive(row.role_pid, row.role_pgid ?? row.role_pid) : true;
      if (row.role_process_start === null) {
        // An unverified identity is unknown, never assumed dead.
        verified = false;
        alive = true;
      }
    } else if (claimCanWrite && ownerProbe === "alive") {
      verified = false;
      alive = true;
    }
    return {
      claimId: row.id,
      stage: row.stage,
      lap: row.lap,
      state: row.state,
      disposition: row.disposition,
      ownerProbe,
      rolePid: row.role_pid,
      rolePgid: row.role_pgid,
      roleProcessStart: row.role_process_start,
      verified,
      alive,
    };
  });
}

/** True when any recorded role process is live or its identity is unreadable. */
export function anyRoleProcessLive(claims: DeliveryRoleProcessState[]): boolean {
  return claims.some((claim) => claim.alive);
}

/** The set of verified-live process groups a Stop may safely signal. */
export function verifiedRoleTargets(
  claims: DeliveryRoleProcessState[],
): Array<{ pid: number; pgid: number }> {
  return claims
    .filter((claim) => claim.alive && claim.verified && claim.rolePid !== null)
    .map((claim) => ({ pid: claim.rolePid!, pgid: claim.rolePgid ?? claim.rolePid! }));
}

/**
 * Operator projection of a run's durable claims. Reads the shared claim table
 * directly so dispatch/run-detail can surface claim state without importing the
 * claim service (and creating an import cycle with the delivery runtime).
 */
export function readDeliveryClaimsForRun(
  db: DatabaseSync,
  projectId: string,
  runId: string,
): DeliveryRoleClaimRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM delivery_role_claims
        WHERE project_id = ? AND run_id = ?
        ORDER BY lap ASC, stage ASC`,
    )
    .all(projectId, runId) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    deliveryId: String(row.delivery_id),
    runId: String(row.run_id),
    lap: Number(row.lap),
    stage: String(row.stage) as DeliveryRoleClaimRecord["stage"],
    candidateHeadSha: String(row.candidate_head_sha),
    attemptKey: String(row.attempt_key),
    claimGeneration: Number(row.claim_generation),
    ownerPid: typeof row.owner_pid === "number" ? row.owner_pid : null,
    ownerProcessStart: typeof row.owner_process_start === "string" ? row.owner_process_start : null,
    rolePid: typeof row.role_pid === "number" ? row.role_pid : null,
    rolePgid: typeof row.role_pgid === "number" ? row.role_pgid : null,
    roleProcessStart: typeof row.role_process_start === "string" ? row.role_process_start : null,
    leaseExpiresAt: Number(row.lease_expires_at),
    heartbeatAt: Number(row.heartbeat_at),
    state: String(row.state) as DeliveryRoleClaimRecord["state"],
    resultObservationId:
      typeof row.result_observation_id === "string" ? row.result_observation_id : null,
    error: typeof row.error === "string" ? row.error : null,
    hold: {
      disposition: String(row.disposition) as DeliveryRoleClaimRecord["hold"]["disposition"],
      reason:
        typeof row.disposition_reason === "string"
          ? row.disposition_reason
          : String(row.disposition),
      ownerProbe: (typeof row.disposition_owner_probe === "string"
        ? row.disposition_owner_probe
        : "unknown") as DeliveryRoleClaimRecord["hold"]["ownerProbe"],
      resolvedAt: typeof row.resolved_at === "number" ? row.resolved_at : null,
    },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}
