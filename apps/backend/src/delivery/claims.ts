import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isPidAlive } from "@animus/contracts/paths";
import type { DeliveryRoleClaimRecord } from "@animus/contracts/operator";
import { pidOrGroupAlive, processStartIdentity } from "../dispatch/ownership";

export type DeliveryClaimStage = "technical_checks" | "independent_review" | "final_acceptance";
export type DeliveryClaimState = "running" | "completed" | "failed" | "interrupted";

export interface DeliveryRoleClaim {
  id: string;
  projectId: string;
  deliveryId: string;
  runId: string;
  lap: number;
  stage: DeliveryClaimStage;
  candidateHeadSha: string;
  attemptKey: string;
  claimToken: string;
  claimGeneration: number;
  ownerPid: number | null;
  ownerProcessStart: string | null;
  rolePid: number | null;
  rolePgid: number | null;
  roleProcessStart: string | null;
  leaseExpiresAt: number;
  heartbeatAt: number;
  state: DeliveryClaimState;
  resultObservationId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AcquireDeliveryClaimInput {
  projectId: string;
  deliveryId: string;
  runId: string;
  lap: number;
  stage: DeliveryClaimStage;
  candidateHeadSha: string;
}

export type AcquireDeliveryClaimResult =
  | { status: "acquired"; claim: DeliveryRoleClaim }
  | {
      status: "already_running";
      claim: DeliveryRoleClaim;
      reason: "already_running" | "owner_unverified";
    }
  | { status: "terminal"; claim: DeliveryRoleClaim };

export interface DeliveryClaimOptions {
  clock?: () => number;
  /** Bounded lease refreshed by the heartbeat while a role executes. */
  leaseMs?: number;
  ownerPid?: () => number;
  processAlive?: (pid: number) => boolean;
  processGroupAlive?: (pid: number, pgid: number) => boolean;
  processStart?: (pid: number) => string | null;
}

interface ClaimRow {
  id: string;
  project_id: string;
  delivery_id: string;
  run_id: string;
  lap: number;
  stage: DeliveryClaimStage;
  candidate_head_sha: string;
  attempt_key: string;
  claim_token: string;
  claim_generation: number;
  owner_pid: number | null;
  owner_process_start: string | null;
  role_pid: number | null;
  role_pgid: number | null;
  role_process_start: string | null;
  lease_expires_at: number;
  heartbeat_at: number;
  state: DeliveryClaimState;
  result_observation_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const DEFAULT_LEASE_MS = 10 * 60 * 1000;

function mapClaim(row: ClaimRow): DeliveryRoleClaim {
  return {
    id: row.id,
    projectId: row.project_id,
    deliveryId: row.delivery_id,
    runId: row.run_id,
    lap: row.lap,
    stage: row.stage,
    candidateHeadSha: row.candidate_head_sha,
    attemptKey: row.attempt_key,
    claimToken: row.claim_token,
    claimGeneration: row.claim_generation,
    ownerPid: row.owner_pid,
    ownerProcessStart: row.owner_process_start,
    rolePid: row.role_pid,
    rolePgid: row.role_pgid,
    roleProcessStart: row.role_process_start,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    state: row.state,
    resultObservationId: row.result_observation_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bounded(value: unknown, what: string): never {
  throw new Error(`invalid delivery claim ${what}: ${String(value)}`);
}

function parseRow(raw: unknown): ClaimRow {
  if (!raw || typeof raw !== "object") bounded(raw, "row");
  const row = raw as Record<string, unknown>;
  const stage = row.stage;
  if (
    stage !== "technical_checks" &&
    stage !== "independent_review" &&
    stage !== "final_acceptance"
  ) {
    bounded(stage, "stage");
  }
  const state = row.state;
  if (
    state !== "running" &&
    state !== "completed" &&
    state !== "failed" &&
    state !== "interrupted"
  ) {
    bounded(state, "state");
  }
  if (
    typeof row.id !== "string" ||
    typeof row.project_id !== "string" ||
    typeof row.delivery_id !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.candidate_head_sha !== "string" ||
    typeof row.attempt_key !== "string" ||
    typeof row.claim_token !== "string" ||
    typeof row.lap !== "number" ||
    typeof row.claim_generation !== "number" ||
    typeof row.lease_expires_at !== "number" ||
    typeof row.heartbeat_at !== "number" ||
    typeof row.created_at !== "number" ||
    typeof row.updated_at !== "number"
  ) {
    bounded(row.id, "columns");
  }
  return {
    id: row.id,
    project_id: row.project_id,
    delivery_id: row.delivery_id,
    run_id: row.run_id,
    lap: row.lap,
    stage,
    candidate_head_sha: row.candidate_head_sha,
    attempt_key: row.attempt_key,
    claim_token: row.claim_token,
    claim_generation: row.claim_generation,
    owner_pid: typeof row.owner_pid === "number" ? row.owner_pid : null,
    owner_process_start:
      typeof row.owner_process_start === "string" ? row.owner_process_start : null,
    role_pid: typeof row.role_pid === "number" ? row.role_pid : null,
    role_pgid: typeof row.role_pgid === "number" ? row.role_pgid : null,
    role_process_start: typeof row.role_process_start === "string" ? row.role_process_start : null,
    lease_expires_at: row.lease_expires_at,
    heartbeat_at: row.heartbeat_at,
    state,
    result_observation_id:
      typeof row.result_observation_id === "string" ? row.result_observation_id : null,
    error: typeof row.error === "string" ? row.error : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Durable claim/CAS for one delivery role execution (run + stage + lap).
 *
 * The claim is written before any role transport, check process, publication or
 * merge runs. A competing tick observes the row and returns without executing.
 * A stale running claim is only reclaimed when its recorded coordinator process
 * (and any recorded role process group) is proven dead by the persisted OS start
 * identity; an unreadable/ambiguous owner is retained. No PID is signalled here:
 * the bounded role runner owns its own process group and timeout.
 */
export class DeliveryRoleClaimService {
  private readonly clock: () => number;
  private readonly leaseMs: number;
  private readonly ownerPid: () => number;
  private readonly processAlive: (pid: number) => boolean;
  private readonly processGroupAlive: (pid: number, pgid: number) => boolean;
  private readonly processStart: (pid: number) => string | null;

  constructor(
    private readonly db: DatabaseSync,
    options: DeliveryClaimOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.ownerPid = options.ownerPid ?? (() => process.pid);
    this.processAlive = options.processAlive ?? ((pid) => isPidAlive(pid));
    this.processGroupAlive =
      options.processGroupAlive ?? ((pid, pgid) => pidOrGroupAlive(pid, pgid));
    this.processStart = options.processStart ?? ((pid) => processStartIdentity(pid));
  }

  acquire(input: AcquireDeliveryClaimInput): AcquireDeliveryClaimResult {
    const now = this.clock();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.load(input);
      if (!existing) {
        const claim = this.insert(input, now);
        this.db.exec("COMMIT;");
        return { status: "acquired", claim };
      }
      if (existing.state === "running") {
        // A crash can leave a claim running after its role result was durably
        // recorded with the claim's unique attempt key. Terminalize it from that
        // existing observation instead of re-executing the role.
        const reconciled = this.reconcileFromObservation(existing, now);
        if (reconciled) {
          this.db.exec("COMMIT;");
          return { status: "terminal", claim: mapClaim(reconciled) };
        }
        const probe = this.probeOwner(existing);
        if (probe !== "dead") {
          this.db.exec("COMMIT;");
          return {
            status: "already_running",
            claim: mapClaim(existing),
            reason: probe === "alive" ? "already_running" : "owner_unverified",
          };
        }
        const reclaimed = this.reclaim(existing, input, now);
        this.db.exec("COMMIT;");
        return reclaimed;
      }
      if (existing.state === "interrupted" || existing.result_observation_id === null) {
        const reclaimed = this.reclaim(existing, input, now);
        this.db.exec("COMMIT;");
        return reclaimed;
      }
      this.db.exec("COMMIT;");
      return { status: "terminal", claim: mapClaim(existing) };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }

  /** Persist the spawned role/check process group so a dead coordinator cannot hide it. */
  recordRoleProcess(claim: DeliveryRoleClaim, pid: number, pgid: number): DeliveryRoleClaim {
    if (!Number.isSafeInteger(pid) || pid <= 0) return claim;
    const group = Number.isSafeInteger(pgid) && pgid > 0 ? pgid : pid;
    const start = this.processStart(pid);
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET role_pid = ?, role_pgid = ?, role_process_start = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(pid, group, start, now, claim.id, claim.claimToken);
    return { ...claim, rolePid: pid, rolePgid: group, roleProcessStart: start, updatedAt: now };
  }

  renew(claim: DeliveryRoleClaim): boolean {
    const now = this.clock();
    const result = this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(now, now + this.leaseMs, now, claim.id, claim.claimToken) as { changes: number };
    return result.changes > 0;
  }

  isCurrent(claim: DeliveryRoleClaim): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM delivery_role_claims
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .get(claim.id, claim.claimToken) as { present: number } | undefined;
    return row !== undefined;
  }

  complete(
    claim: DeliveryRoleClaim,
    state: "completed" | "failed",
    observationId: string,
    error: string | null,
  ): boolean {
    return this.completeWithinTransaction(claim, state, observationId, error);
  }

  /**
   * Claim CAS completion used inside the caller's observation/claim transaction.
   * Returns false when another tick already terminalized or reclaimed the claim.
   */
  completeWithinTransaction(
    claim: DeliveryRoleClaim,
    state: "completed" | "failed",
    observationId: string,
    error: string | null,
  ): boolean {
    const now = this.clock();
    const result = this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET state = ?, result_observation_id = ?, error = ?, heartbeat_at = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(
        state,
        observationId,
        error,
        now,
        now + this.leaseMs,
        now,
        claim.id,
        claim.claimToken,
      ) as { changes: number };
    return Number(result.changes) > 0;
  }

  interrupt(claim: DeliveryRoleClaim, error: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET state = 'interrupted', error = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(error, now, claim.id, claim.claimToken);
  }

  get(input: AcquireDeliveryClaimInput): DeliveryRoleClaim | null {
    const row = this.load(input);
    return row ? mapClaim(row) : null;
  }

  /**
   * Refresh the lease while the role runs. A renewal failure is reported to the
   * caller instead of being silently swallowed; it never crashes the role.
   */
  startHeartbeat(claim: DeliveryRoleClaim, onError?: (error: unknown) => void): () => void {
    const interval = Math.max(1000, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => {
      try {
        this.renew(claim);
      } catch (error) {
        onError?.(error);
      }
    }, interval);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Persist a non-fatal heartbeat failure so it is visible, not swallowed. */
  noteHeartbeatError(claim: DeliveryRoleClaim, message: string): void {
    this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET error = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(`heartbeat_failed: ${message}`, this.clock(), claim.id, claim.claimToken);
  }

  /**
   * Operator/CAS reconciliation for an owner-unverified claim. It never signals a
   * PID and never fabricates a PASS: `interrupt` marks the row interrupted, while
   * `complete` requires an existing observation id for the claim's attempt key.
   */
  reconcile(
    input: AcquireDeliveryClaimInput & {
      action: "interrupt" | "complete";
      actor: string;
      reason: string;
      observationId?: string;
    },
  ): DeliveryRoleClaim {
    const now = this.clock();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.load(input);
      if (!existing) throw new Error("delivery claim not found for reconciliation");
      if (existing.state !== "running") {
        this.db.exec("COMMIT;");
        return mapClaim(existing);
      }
      if (input.action === "interrupt") {
        const result = this.db
          .prepare(
            `UPDATE delivery_role_claims
             SET state = 'interrupted', error = ?, updated_at = ?
             WHERE id = ? AND claim_generation = ? AND state = 'running'`,
          )
          .run(
            `operator_interrupt: ${input.actor}: ${input.reason}`,
            now,
            existing.id,
            existing.claim_generation,
          ) as {
          changes: number;
        };
        if (Number(result.changes) === 0) {
          throw new Error("delivery claim changed before operator reconciliation");
        }
      } else {
        const observation = input.observationId
          ? this.loadObservationById(input.observationId)
          : this.findObservationForClaim(existing);
        if (!observation) {
          throw new Error("operator reconciliation requires an existing role observation");
        }
        const state = observation.status === "passed" ? "completed" : "failed";
        const result = this.db
          .prepare(
            `UPDATE delivery_role_claims
             SET state = ?, result_observation_id = ?, error = ?, updated_at = ?
             WHERE id = ? AND claim_generation = ? AND state = 'running'`,
          )
          .run(
            state,
            observation.id,
            `operator_complete: ${input.actor}: ${input.reason}`,
            now,
            existing.id,
            existing.claim_generation,
          ) as { changes: number };
        if (Number(result.changes) === 0) {
          throw new Error("delivery claim changed before operator reconciliation");
        }
      }
      const updated = this.loadById(existing.id);
      if (!updated) throw new Error("delivery claim disappeared during reconciliation");
      this.db.exec("COMMIT;");
      return mapClaim(updated);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }

  private insert(input: AcquireDeliveryClaimInput, now: number): DeliveryRoleClaim {
    const identity = this.ownerIdentity();
    const claimToken = randomUUID();
    const attemptKey = `${input.stage}:claim:${claimToken}`;
    const id = `claim_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO delivery_role_claims
           (id, project_id, delivery_id, run_id, lap, stage, candidate_head_sha, attempt_key,
            claim_token, claim_generation, owner_pid, owner_process_start, role_pid, role_pgid,
            role_process_start, lease_expires_at, heartbeat_at, state, result_observation_id,
            error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, ?, 'running', NULL,
                 NULL, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.deliveryId,
        input.runId,
        input.lap,
        input.stage,
        input.candidateHeadSha,
        attemptKey,
        claimToken,
        identity.pid,
        identity.processStart,
        now + this.leaseMs,
        now,
        now,
        now,
      );
    const row = this.load(input);
    if (!row) throw new Error("delivery claim insert did not persist");
    return mapClaim(row);
  }

  private reclaim(
    existing: ClaimRow,
    input: AcquireDeliveryClaimInput,
    now: number,
  ): AcquireDeliveryClaimResult {
    const identity = this.ownerIdentity();
    const claimToken = randomUUID();
    const attemptKey = `${input.stage}:claim:${claimToken}`;
    const result = this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET candidate_head_sha = ?, attempt_key = ?, claim_token = ?,
             claim_generation = claim_generation + 1, owner_pid = ?, owner_process_start = ?,
             role_pid = NULL, role_pgid = NULL, role_process_start = NULL,
             lease_expires_at = ?, heartbeat_at = ?, state = 'running',
             result_observation_id = NULL, error = NULL, updated_at = ?
         WHERE id = ? AND claim_token = ? AND claim_generation = ?`,
      )
      .run(
        input.candidateHeadSha,
        attemptKey,
        claimToken,
        identity.pid,
        identity.processStart,
        now + this.leaseMs,
        now,
        now,
        existing.id,
        existing.claim_token,
        existing.claim_generation,
      ) as { changes: number };
    if (result.changes === 0) {
      // Another tick won the reclaim race between our read and update.
      const current = this.load(input);
      if (!current) throw new Error("delivery claim disappeared during reclaim");
      return {
        status: "already_running",
        claim: mapClaim(current),
        reason: "already_running",
      };
    }
    const row = this.load(input);
    if (!row) throw new Error("delivery claim reclaim did not persist");
    return { status: "acquired", claim: mapClaim(row) };
  }

  private ownerIdentity(): { pid: number; processStart: string | null } {
    const pid = this.ownerPid();
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("delivery claim owner pid is invalid");
    }
    return { pid, processStart: this.processStart(pid) };
  }

  private probeOwner(row: ClaimRow): "alive" | "dead" | "unknown" {
    if (row.owner_pid === null || row.owner_process_start === null) return "unknown";
    const ownerStart = this.processStart(row.owner_pid);
    if (ownerStart === row.owner_process_start && this.processAlive(row.owner_pid)) {
      return "alive";
    }
    if (row.role_pid === null) return "dead";
    if (row.role_process_start === null) return "unknown";
    const roleStart = this.processStart(row.role_pid);
    if (
      roleStart === row.role_process_start &&
      this.processGroupAlive(row.role_pid, row.role_pgid ?? row.role_pid)
    ) {
      return "alive";
    }
    return "dead";
  }

  private load(input: AcquireDeliveryClaimInput): ClaimRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM delivery_role_claims
         WHERE project_id = ? AND run_id = ? AND stage = ? AND lap = ?`,
      )
      .get(input.projectId, input.runId, input.stage, input.lap);
    return row === undefined ? null : parseRow(row);
  }

  private loadById(id: string): ClaimRow | null {
    const row = this.db.prepare("SELECT * FROM delivery_role_claims WHERE id = ?").get(id);
    return row === undefined ? null : parseRow(row);
  }

  private loadObservationById(id: string): { id: string; status: string } | null {
    const row = this.db
      .prepare("SELECT id, status FROM execution_observations WHERE id = ?")
      .get(id) as { id: string; status: string } | undefined;
    return row ?? null;
  }

  private findObservationForClaim(row: ClaimRow): { id: string; status: string } | null {
    const observation = this.db
      .prepare(
        `SELECT id, status FROM execution_observations
          WHERE project_id = ? AND run_id = ? AND stage = ? AND lap = ? AND attempt_key = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(row.project_id, row.run_id, row.stage, row.lap, row.attempt_key) as
      | { id: string; status: string }
      | undefined;
    return observation ?? null;
  }

  /**
   * Terminalize a running claim whose role result is already durable. The
   * observation was recorded under the claim's unique attempt key, so this is
   * recovery of an existing result, not a second execution.
   */
  private reconcileFromObservation(row: ClaimRow, now: number): ClaimRow | null {
    const observation = this.findObservationForClaim(row);
    if (!observation) return null;
    const state = observation.status === "passed" ? "completed" : "failed";
    const result = this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET state = ?, result_observation_id = ?, error = ?, heartbeat_at = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(
        state,
        observation.id,
        state === "failed" ? `reconciled_from_observation:${observation.status}` : null,
        now,
        now + this.leaseMs,
        now,
        row.id,
        row.claim_token,
      ) as { changes: number };
    if (Number(result.changes) === 0) return null;
    return this.loadById(row.id);
  }
}

/** Public projection for operator surfaces: never includes the fencing token. */
export function toDeliveryRoleClaimRecord(claim: DeliveryRoleClaim): DeliveryRoleClaimRecord {
  return {
    id: claim.id,
    projectId: claim.projectId,
    deliveryId: claim.deliveryId,
    runId: claim.runId,
    lap: claim.lap,
    stage: claim.stage,
    candidateHeadSha: claim.candidateHeadSha,
    attemptKey: claim.attemptKey,
    claimGeneration: claim.claimGeneration,
    ownerPid: claim.ownerPid,
    ownerProcessStart: claim.ownerProcessStart,
    rolePid: claim.rolePid,
    rolePgid: claim.rolePgid,
    roleProcessStart: claim.roleProcessStart,
    leaseExpiresAt: claim.leaseExpiresAt,
    heartbeatAt: claim.heartbeatAt,
    state: claim.state,
    resultObservationId: claim.resultObservationId,
    error: claim.error,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

export interface ReconcileDeliveryClaimRequest {
  projectId: string;
  runId: string;
  stage: DeliveryClaimStage;
  lap: number;
  action: "interrupt" | "complete";
  actor: string;
  reason: string;
  observationId?: string;
}

/**
 * Operator-facing entry point used by the delivery HTTP command surface. It
 * resolves the run's delivery/candidate from durable state (never from the
 * caller) and delegates to the audited CAS reconcile.
 */
export function reconcileDeliveryClaim(
  db: DatabaseSync,
  input: ReconcileDeliveryClaimRequest,
): DeliveryRoleClaim {
  const run = db
    .prepare(
      "SELECT delivery_id, head_sha, base_sha FROM dispatch_runs WHERE project_id = ? AND id = ?",
    )
    .get(input.projectId, input.runId) as
    | { delivery_id: string; head_sha: string | null; base_sha: string }
    | undefined;
  if (!run) {
    throw new Error(`Run ${input.runId} not found for project ${input.projectId}`);
  }
  const claims = new DeliveryRoleClaimService(db);
  return claims.reconcile({
    projectId: input.projectId,
    deliveryId: run.delivery_id,
    runId: input.runId,
    lap: input.lap,
    stage: input.stage,
    candidateHeadSha: run.head_sha ?? run.base_sha,
    action: input.action,
    actor: input.actor,
    reason: input.reason,
    ...(input.observationId ? { observationId: input.observationId } : {}),
  });
}
