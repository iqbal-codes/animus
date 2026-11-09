import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isPidAlive } from "@animus/contracts/paths";
import type {
  DeliveryRoleClaimDisposition,
  DeliveryRoleClaimRecord,
} from "@animus/contracts/operator";
import { CommandLedger } from "../command/ledger";
import { DeliveryError } from "./errors";
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
  disposition: DeliveryRoleClaimDisposition;
  dispositionReason: string | null;
  dispositionOwnerProbe: OwnerProbe | null;
  resolvedAt: number | null;
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

export interface ReconcileClaimInput extends AcquireDeliveryClaimInput {
  action: "interrupt" | "complete";
  actor: string;
  reason: string;
  expectedGeneration: number;
  expectedCandidateHeadSha: string;
  expectedState: DeliveryClaimState;
  acknowledgeUnknownOwner?: boolean;
  observationId?: string;
}

interface ReconcileDecision {
  state: DeliveryClaimState;
  resultObservationId: string | null;
  error: string | null;
  disposition: DeliveryRoleClaimDisposition;
  dispositionReason: string;
  ownerProbe: OwnerProbe;
  clearIdentity: boolean;
  resolved: boolean;
  observationId?: string;
}

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
  disposition: DeliveryRoleClaimDisposition;
  disposition_reason: string | null;
  disposition_owner_probe: OwnerProbe | null;
  resolved_at: number | null;
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
    disposition: row.disposition,
    dispositionReason: row.disposition_reason,
    dispositionOwnerProbe: row.disposition_owner_probe,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type OwnerProbe = "alive" | "dead" | "unknown";

const DISPOSITIONS: readonly DeliveryRoleClaimDisposition[] = [
  "active",
  "terminal",
  "released_dead_owner",
  "frozen_unknown_owner",
  "restored_installation_held",
];

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
  const disposition = row.disposition;
  if (!DISPOSITIONS.includes(disposition as DeliveryRoleClaimDisposition)) {
    bounded(disposition, "disposition");
  }
  const ownerProbe = row.disposition_owner_probe;
  if (
    ownerProbe !== null &&
    ownerProbe !== undefined &&
    ownerProbe !== "alive" &&
    ownerProbe !== "dead" &&
    ownerProbe !== "unknown"
  ) {
    bounded(ownerProbe, "disposition_owner_probe");
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
    disposition: disposition as DeliveryRoleClaimDisposition,
    disposition_reason: typeof row.disposition_reason === "string" ? row.disposition_reason : null,
    disposition_owner_probe: (ownerProbe ?? null) as OwnerProbe | null,
    resolved_at: typeof row.resolved_at === "number" ? row.resolved_at : null,
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
      if (existing.state === "interrupted") {
        // A frozen interrupt keeps the recorded process identity: reclaiming it
        // would let a second role run while the previous one may still write.
        // Only a claim with no physical writer (released after a proven-dead
        // owner, or whose recorded identity is now provably dead) may be reclaimed.
        if (existing.disposition === "released_dead_owner") {
          const reclaimed = this.reclaim(existing, input, now);
          this.db.exec("COMMIT;");
          return reclaimed;
        }
        const safety = this.evaluateProcessSafety(existing);
        if (safety.probe !== "dead") {
          this.db.exec("COMMIT;");
          return {
            status: "already_running",
            claim: mapClaim(existing),
            reason: safety.probe === "alive" ? "already_running" : "owner_unverified",
          };
        }
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
             lease_expires_at = ?, disposition = 'terminal', disposition_reason = ?,
             disposition_owner_probe = 'dead', resolved_at = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(
        state,
        observationId,
        error,
        now,
        now + this.leaseMs,
        state === "completed" ? "claim_completed" : "claim_failed",
        now,
        now,
        claim.id,
        claim.claimToken,
      ) as { changes: number };
    return Number(result.changes) > 0;
  }

  /**
   * Mark an in-flight claim interrupted without inventing a result.
   *
   * The recorded coordinator/role OS identity is retained here on purpose: a
   * runtime interruption (Stop, thrown stage effect) does not prove the spawned
   * role process is gone, so dropping the identity would let takeover begin while
   * the previous role still runs. The claim is therefore disposed as
   * `frozen_unknown_owner` and cutover treats it as held until an operator proves
   * the process dead (`reconcileInterrupt`).
   */
  interrupt(claim: DeliveryRoleClaim, error: string): void {
    const now = this.clock();
    const row = this.loadById(claim.id);
    if (!row || row.state !== "running" || row.claim_token !== claim.claimToken) return;
    const safety = this.evaluateProcessSafety(row);
    const released = safety.probe === "dead";
    this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET state = 'interrupted', error = ?, disposition = ?,
             disposition_reason = ?, disposition_owner_probe = ?,
             owner_pid = ?, owner_process_start = ?, role_pid = ?, role_pgid = ?,
             role_process_start = ?, lease_expires_at = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(
        released ? `${error}:runtime_interrupt_dead_owner` : `${error}:runtime_interrupt_held`,
        released ? "released_dead_owner" : "frozen_unknown_owner",
        released ? "runtime_interrupt_dead_owner" : "runtime_interrupt_process_unknown",
        safety.probe,
        released ? null : row.owner_pid,
        released ? null : row.owner_process_start,
        released ? null : row.role_pid,
        released ? null : row.role_pgid,
        released ? null : row.role_process_start,
        released ? 0 : row.lease_expires_at,
        released ? now : null,
        now,
        row.id,
        claim.claimToken,
      );
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
   * Operator/CAS reconciliation for an existing claim.
   *
   * It never signals a PID and never fabricates a PASS. Every request is fenced by
   * the caller-observed opaque generation, candidate and state, recorded through
   * the durable CommandLedger before the claim row changes, and appended to the
   * append-only claim audit.
   *
   * - `complete` resolves the result observation under the claim's own
   *   project/run/stage/lap/attempt/candidate tuple. A caller-supplied
   *   `observationId` must satisfy the identical predicates as the automatic
   *   lookup; a foreign/stale receipt is rejected without mutating the claim.
   * - `interrupt` releases the claim only when the recorded owner/role process is
   *   proven dead. A live owner is refused. An unreadable/ambiguous owner may only
   *   be frozen with an explicit acknowledgement, and then stays truthfully held
   *   (`frozen_unknown_owner`) instead of reporting a false release.
   */
  reconcile(input: ReconcileClaimInput): DeliveryRoleClaim {
    const now = this.clock();
    const ledger = new CommandLedger(this.db);
    const requestId = `cmd_claim_reconcile_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.load(input);
      if (!existing) {
        throw new DeliveryError(
          "delivery_claim_not_found",
          `No delivery claim exists for run ${input.runId} stage ${input.stage} lap ${input.lap}`,
        );
      }
      this.assertReconcileFence(existing, input);
      if (existing.state !== "running" && existing.state !== "interrupted") {
        throw new DeliveryError(
          "delivery_claim_stale",
          `Delivery claim ${existing.id} is already terminal (${existing.state})`,
          { state: existing.state },
        );
      }

      const decision =
        input.action === "complete"
          ? this.planComplete(existing, input)
          : this.planInterrupt(existing, input);

      ledger.recordBeforeDispatch({
        requestId,
        actor: input.actor,
        projectId: existing.project_id,
        action: `delivery_claim_${input.action}`,
        target: {
          claim_id: existing.id,
          run_id: existing.run_id,
          stage: existing.stage,
          lap: existing.lap,
          expected_generation: input.expectedGeneration,
          expected_candidate: input.expectedCandidateHeadSha,
          expected_state: input.expectedState,
          ...(input.observationId ? { observation_id: input.observationId } : {}),
        },
      });

      const result = this.db
        .prepare(
          `UPDATE delivery_role_claims
           SET state = ?, result_observation_id = ?, error = ?, disposition = ?,
               disposition_reason = ?, disposition_owner_probe = ?, resolved_at = ?,
               owner_pid = ?, owner_process_start = ?, role_pid = ?, role_pgid = ?,
               role_process_start = ?, claim_token = ?, claim_generation = ?,
               lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND claim_generation = ? AND claim_token = ? AND state = ?
             AND candidate_head_sha = ?`,
        )
        .run(
          decision.state,
          decision.resultObservationId,
          decision.error,
          decision.disposition,
          decision.dispositionReason,
          decision.ownerProbe,
          decision.resolved ? now : null,
          decision.clearIdentity ? null : existing.owner_pid,
          decision.clearIdentity ? null : existing.owner_process_start,
          decision.clearIdentity ? null : existing.role_pid,
          decision.clearIdentity ? null : existing.role_pgid,
          decision.clearIdentity ? null : existing.role_process_start,
          decision.clearIdentity ? randomUUID() : existing.claim_token,
          decision.clearIdentity ? existing.claim_generation + 1 : existing.claim_generation,
          decision.clearIdentity ? 0 : existing.lease_expires_at,
          now,
          now,
          existing.id,
          input.expectedGeneration,
          existing.claim_token,
          existing.state,
          input.expectedCandidateHeadSha,
        ) as { changes: number };
      if (Number(result.changes) === 0) {
        throw new DeliveryError(
          "delivery_claim_stale",
          "Delivery claim changed before operator reconciliation",
        );
      }

      this.appendAudit(existing, input, decision, requestId, now);
      ledger.updateOutcome(requestId, {
        state: "succeeded",
        provenance: {
          source: "delivery_claim_reconcile",
          timestamp: new Date(now).toISOString(),
          actor: input.actor,
          details: decision.dispositionReason,
        },
      });

      const updated = this.loadById(existing.id);
      if (!updated) throw new Error("delivery claim disappeared during reconciliation");
      this.db.exec("COMMIT;");
      return mapClaim(updated);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      if (error instanceof DeliveryError) {
        this.recordRejectedReconcile(ledger, requestId, input, error);
      }
      throw error;
    }
  }

  private recordRejectedReconcile(
    ledger: CommandLedger,
    requestId: string,
    input: ReconcileClaimInput,
    error: DeliveryError,
  ): void {
    // A reject must still be durable. The claim transaction rolled back, so this
    // write is a standalone ledger entry; a failure here never masks the reject.
    try {
      ledger.recordRejection({
        requestId,
        actor: input.actor,
        projectId: input.projectId,
        action: `delivery_claim_${input.action}`,
        target: {
          run_id: input.runId,
          stage: input.stage,
          lap: input.lap,
          expected_generation: input.expectedGeneration,
        },
        reason: `${error.code}: ${error.message}`,
      });
    } catch {}
  }

  private assertReconcileFence(existing: ClaimRow, input: ReconcileClaimInput): void {
    if (
      existing.claim_generation !== input.expectedGeneration ||
      existing.candidate_head_sha !== input.expectedCandidateHeadSha ||
      existing.state !== input.expectedState
    ) {
      throw new DeliveryError(
        "delivery_claim_stale",
        "Delivery claim no longer matches the expected generation, candidate or state",
        {
          expected: {
            generation: input.expectedGeneration,
            candidate: input.expectedCandidateHeadSha,
            state: input.expectedState,
          },
          actual: {
            generation: existing.claim_generation,
            candidate: existing.candidate_head_sha,
            state: existing.state,
          },
        },
      );
    }
  }

  private planComplete(existing: ClaimRow, input: ReconcileClaimInput): ReconcileDecision {
    const observation = input.observationId
      ? this.loadObservationForClaimById(existing, input.observationId)
      : this.loadObservationForClaim(existing);
    if (!observation) {
      throw new DeliveryError(
        "delivery_claim_receipt_missing",
        input.observationId
          ? `Observation ${input.observationId} is not bound to claim ${existing.id}`
          : `No role observation exists for the claim's attempt key`,
        { claimId: existing.id, observationId: input.observationId ?? null },
      );
    }
    const state = observation.status === "passed" ? "completed" : "failed";
    return {
      state,
      resultObservationId: observation.id,
      error: `operator_complete: ${input.actor}: ${input.reason}`,
      disposition: "terminal",
      dispositionReason: state === "completed" ? "operator_complete" : "operator_complete_failed",
      ownerProbe: "dead",
      clearIdentity: true,
      resolved: true,
      observationId: observation.id,
    };
  }

  private planInterrupt(existing: ClaimRow, input: ReconcileClaimInput): ReconcileDecision {
    const safety = this.evaluateProcessSafety(existing);
    if (safety.coordinatorLive || safety.roleLive || safety.probe === "alive") {
      if (safety.probe !== "unknown") {
        throw new DeliveryError(
          "delivery_claim_owner_live",
          `Claim ${existing.id} still has a live owner; refuse to release a running role`,
          { claimId: existing.id, ownerPid: existing.owner_pid, rolePid: existing.role_pid },
        );
      }
    }
    if (safety.probe === "unknown" && input.acknowledgeUnknownOwner !== true) {
      throw new DeliveryError(
        "delivery_claim_owner_unknown",
        "Role process identity is unreadable; acknowledge unknown-owner effects before interrupting",
        { claimId: existing.id, ownerPid: existing.owner_pid, rolePid: existing.role_pid },
      );
    }
    const released = safety.probe === "dead";
    const dispositionReason = released
      ? `operator_interrupt_dead_owner: ${input.actor}: ${input.reason}`
      : `operator_frozen_unknown_owner: ${input.actor}: ${input.reason}`;
    return {
      state: "interrupted",
      resultObservationId: existing.result_observation_id,
      error: dispositionReason,
      disposition: released ? "released_dead_owner" : "frozen_unknown_owner",
      dispositionReason,
      ownerProbe: safety.probe,
      // Only a claim with no physical writer may drop its identity. A frozen claim
      // keeps the recorded identity so takeover cannot start under an unknown owner.
      clearIdentity: released,
      resolved: released,
    };
  }

  private appendAudit(
    existing: ClaimRow,
    input: ReconcileClaimInput,
    decision: ReconcileDecision,
    requestId: string,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO delivery_role_claim_audit
           (id, claim_id, project_id, run_id, stage, lap, action, actor, reason,
            claim_generation, candidate_head_sha, prior_state, outcome_state, disposition,
            owner_probe, command_request_id, observation_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `claim_audit_${randomUUID()}`,
        existing.id,
        existing.project_id,
        existing.run_id,
        existing.stage,
        existing.lap,
        input.action,
        input.actor,
        input.reason,
        existing.claim_generation,
        existing.candidate_head_sha,
        existing.state,
        decision.state,
        decision.disposition,
        decision.ownerProbe,
        requestId,
        decision.observationId ?? null,
        decision.dispositionReason,
        now,
      );
  }

  /** Public, operator-facing audit trail for one claim. */
  listAudit(claimId: string): Array<{
    id: string;
    claimId: string;
    action: string;
    actor: string;
    reason: string;
    priorState: string;
    outcomeState: string;
    disposition: string;
    ownerProbe: string;
    commandRequestId: string | null;
    observationId: string | null;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM delivery_role_claim_audit WHERE claim_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(claimId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      claimId: String(row.claim_id),
      action: String(row.action),
      actor: String(row.actor),
      reason: String(row.reason),
      priorState: String(row.prior_state),
      outcomeState: String(row.outcome_state),
      disposition: String(row.disposition),
      ownerProbe: String(row.owner_probe),
      commandRequestId: typeof row.command_request_id === "string" ? row.command_request_id : null,
      observationId: typeof row.observation_id === "string" ? row.observation_id : null,
      createdAt: Number(row.created_at),
    }));
  }

  private listClaimsForRun(projectId: string, runId: string): DeliveryRoleClaim[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM delivery_role_claims
          WHERE project_id = ? AND run_id = ?
          ORDER BY lap ASC, stage ASC`,
      )
      .all(projectId, runId) as unknown as ClaimRow[];
    return rows.map((row) => mapClaim(parseRow(row)));
  }

  /** Durable claims for one run, used by run-detail projection and cutover. */
  claimsForRun(projectId: string, runId: string): DeliveryRoleClaim[] {
    return this.listClaimsForRun(projectId, runId);
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
            error, disposition, disposition_reason, disposition_owner_probe, resolved_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, ?, 'running', NULL,
                 NULL, 'active', 'claim_acquired', 'alive', NULL, ?, ?)`,
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
             result_observation_id = NULL, error = NULL, disposition = 'active',
             disposition_reason = 'claim_reclaimed', disposition_owner_probe = 'alive',
             resolved_at = NULL, updated_at = ?
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

  /**
   * Decide whether an interrupted/reconciled claim is still a physical writer.
   *
   * The protected identity is the spawned role process, not the coordinator. A
   * coordinator can stay alive (it is the process asking to interrupt) while the
   * role it spawned is already gone; that is not a live writer. Distinct rules:
   *
   * - `alive`    a verified-live coordinator, or a verified-live role process.
   * - `unknown`  a recorded role process whose start identity cannot be read.
   * - `dead`     no role process exists, or its verified start no longer matches
   *              the live pid (PID reuse) and it is not in the process table.
   */
  private evaluateProcessSafety(row: ClaimRow): {
    probe: OwnerProbe;
    coordinatorLive: boolean;
    roleLive: boolean;
  } {
    if (row.owner_pid !== null && row.owner_process_start === null) {
      // A recorded coordinator pid with no start identity cannot be verified as the
      // same process. If that pid is not alive at all it is dead; otherwise the
      // identity is unknown (it may or may not be the recorded writer), never dead.
      const pidAlive = this.processAlive(row.owner_pid);
      if (!pidAlive && row.role_pid === null) {
        return { probe: "dead", coordinatorLive: false, roleLive: false };
      }
      return {
        probe: pidAlive ? "unknown" : "dead",
        coordinatorLive: pidAlive,
        roleLive: row.role_pid !== null,
      };
    }
    const coordinatorLive =
      row.owner_pid !== null &&
      row.owner_process_start !== null &&
      this.processStart(row.owner_pid) === row.owner_process_start &&
      this.processAlive(row.owner_pid);
    if (row.role_pid === null) {
      // No spawned role: the only possible writer is a verified-live coordinator.
      return { probe: coordinatorLive ? "alive" : "dead", coordinatorLive, roleLive: false };
    }
    if (row.role_process_start === null) {
      return { probe: "unknown", coordinatorLive, roleLive: true };
    }
    const roleStart = this.processStart(row.role_pid);
    if (roleStart !== row.role_process_start) {
      // PID reused or gone: never trust liveness for a mismatched identity.
      const stillAlive = this.processGroupAlive(row.role_pid, row.role_pgid ?? row.role_pid);
      if (stillAlive) return { probe: "unknown", coordinatorLive, roleLive: true };
      return { probe: "dead", coordinatorLive, roleLive: false };
    }
    const roleAlive = this.processGroupAlive(row.role_pid, row.role_pgid ?? row.role_pid);
    if (roleAlive) return { probe: "alive", coordinatorLive, roleLive: true };
    return { probe: coordinatorLive ? "alive" : "dead", coordinatorLive, roleLive: false };
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

  /**
   * The immutable predicates that bind a role observation to one claim. Every
   * lookup path (explicit operator id and automatic recovery) uses exactly these.
   */
  private loadObservationForClaim(row: ClaimRow): { id: string; status: string } | null {
    return this.loadObservationForClaimById(row, null);
  }

  /**
   * Resolve a role observation bound to the claim's own project/run/stage/lap/
   * attempt/candidate tuple. When `observationId` is supplied it must satisfy the
   * SAME predicates as the automatic lookup, so an operator cannot bless a
   * foreign or stale receipt.
   */
  private loadObservationForClaimById(
    row: ClaimRow,
    observationId: string | null,
  ): { id: string; status: string } | null {
    const observation = this.db
      .prepare(
        `SELECT id, status FROM execution_observations
          WHERE project_id = ? AND run_id = ? AND stage = ? AND lap = ?
            AND attempt_key = ? AND candidate_head_sha = ?
            AND (? IS NULL OR id = ?)
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(
        row.project_id,
        row.run_id,
        row.stage,
        row.lap,
        row.attempt_key,
        row.candidate_head_sha,
        observationId,
        observationId,
      ) as { id: string; status: string } | undefined;
    return observation ?? null;
  }

  /**
   * Terminalize a running claim whose role result is already durable. The
   * observation was recorded under the claim's unique attempt key, so this is
   * recovery of an existing result, not a second execution.
   */
  private reconcileFromObservation(row: ClaimRow, now: number): ClaimRow | null {
    const observation = this.loadObservationForClaim(row);
    if (!observation) return null;
    const state = observation.status === "passed" ? "completed" : "failed";
    const result = this.db
      .prepare(
        `UPDATE delivery_role_claims
         SET state = ?, result_observation_id = ?, error = ?, heartbeat_at = ?,
             lease_expires_at = ?, disposition = 'terminal', disposition_reason = ?,
             disposition_owner_probe = 'dead', resolved_at = ?, updated_at = ?
         WHERE id = ? AND claim_token = ? AND state = 'running'`,
      )
      .run(
        state,
        observation.id,
        state === "failed" ? `reconciled_from_observation:${observation.status}` : null,
        now,
        now + this.leaseMs,
        state === "completed" ? "reconciled_from_observation" : "reconciled_failed_observation",
        now,
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
    hold: {
      disposition: claim.disposition,
      reason: claim.dispositionReason ?? claim.disposition,
      ownerProbe: claim.dispositionOwnerProbe ?? "unknown",
      resolvedAt: claim.resolvedAt,
    },
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
  expectedGeneration: number;
  expectedCandidateHeadSha: string;
  expectedState: DeliveryClaimState;
  acknowledgeUnknownOwner?: boolean;
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
    throw new DeliveryError(
      "delivery_run_not_found",
      `Run ${input.runId} not found for project ${input.projectId}`,
    );
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
    expectedGeneration: input.expectedGeneration,
    expectedCandidateHeadSha: input.expectedCandidateHeadSha,
    expectedState: input.expectedState,
    ...(input.acknowledgeUnknownOwner ? { acknowledgeUnknownOwner: true } : {}),
    ...(input.observationId ? { observationId: input.observationId } : {}),
  });
}

/** Operator projection of a run's durable claims (never includes the fencing token). */
export function deliveryClaimsForRun(
  db: DatabaseSync,
  projectId: string,
  runId: string,
): DeliveryRoleClaimRecord[] {
  return new DeliveryRoleClaimService(db)
    .claimsForRun(projectId, runId)
    .map(toDeliveryRoleClaimRecord);
}
