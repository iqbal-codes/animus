import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isPidAlive, resolveAnimusStateDir } from "./paths";

/**
 * Execution authority marker shared by the scheduler, monitor, CLI and #165 cutover.
 *
 * `legacy` is the only safe default: an installation that has not completed its
 * validated migration must keep its existing GitHub/filesystem writers.
 *
 * `migrating` is a durable fence written before staging. Every legacy writer and
 * every local dispatcher must fail closed while it is set, so an interrupted
 * cutover can never leave two writers active. `local` may only be written by the
 * cutover that validated the migrated state, its backup and its isolated restore.
 *
 * The marker is intentionally a small durable file rather than a numbered schema
 * migration so the cutover owner can introduce it without claiming a migration
 * version reserved by another slice.
 */
export type ExecutionAuthority = "legacy" | "migrating" | "local";

export type ExecutionAuthorityPhase = "staging" | "staged" | "activating" | "active" | null;

export interface ExecutionAuthorityState {
  authority: ExecutionAuthority;
  activated_at: string | null;
  source: "default" | "marker";
  /** Cutover operation that owns this marker, when written by #165. */
  cutover_id: string | null;
  /** Deterministic digest of the migrated inventory recorded at activation. */
  inventory_sha256: string | null;
  /** Validated backup manifest digest the activation was proven against. */
  backup_manifest_sha256: string | null;
  phase: ExecutionAuthorityPhase;
  error?: string;
}

export type ExecutionAuthorityConflictCode = "authority_marker_conflict";

export class ExecutionAuthorityConflictError extends Error {
  readonly code: ExecutionAuthorityConflictCode = "authority_marker_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ExecutionAuthorityConflictError";
  }
}

export type ExecutionAuthorityGateCode =
  | "execution_authority_moving"
  | "execution_authority_moved"
  | "authority_not_activated";

/**
 * Thrown by shared writer/dispatcher gates so every consumer fails closed with
 * the same stable code instead of inventing a second authority policy.
 */
export class ExecutionAuthorityGateError extends Error {
  constructor(
    public readonly code: ExecutionAuthorityGateCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionAuthorityGateError";
  }
}

const AUTHORITY_FILE = "execution-authority.json";
const AUTHORITY_LOCK_FILE = ".execution-authority.lock";
const AUTHORITY_VALUES: readonly ExecutionAuthority[] = ["legacy", "migrating", "local"];

export function resolveExecutionAuthorityPath(customStateDir?: string): string {
  return join(resolveAnimusStateDir(customStateDir), AUTHORITY_FILE);
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalPhase(record: Record<string, unknown>): ExecutionAuthorityPhase {
  const value = record.phase;
  if (value === "staging" || value === "staged" || value === "activating" || value === "active") {
    return value;
  }
  return null;
}

export function readExecutionAuthority(customStateDir?: string): ExecutionAuthorityState {
  const path = resolveExecutionAuthorityPath(customStateDir);
  if (!existsSync(path)) {
    return {
      authority: "legacy",
      activated_at: null,
      source: "default",
      cutover_id: null,
      inventory_sha256: null,
      backup_manifest_sha256: null,
      phase: null,
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") throw new Error("authority marker must be an object");
    const record = raw as Record<string, unknown>;
    const authority = record.authority;
    if (typeof authority !== "string" || !AUTHORITY_VALUES.includes(authority as never)) {
      throw new Error(`invalid authority: ${String(authority)}`);
    }
    const activatedAt =
      typeof record.activated_at === "string" && record.activated_at.trim() !== ""
        ? record.activated_at
        : null;
    return {
      authority: authority as ExecutionAuthority,
      activated_at: activatedAt,
      source: "marker",
      cutover_id: optionalString(record, "cutover_id"),
      inventory_sha256: optionalString(record, "inventory_sha256"),
      backup_manifest_sha256: optionalString(record, "backup_manifest_sha256"),
      phase: optionalPhase(record),
    };
  } catch (error) {
    // A malformed marker must never activate the new authority. Fall back to the
    // legacy behaviour and surface the read error so operators can inspect it.
    return {
      authority: "legacy",
      activated_at: null,
      source: "default",
      cutover_id: null,
      inventory_sha256: null,
      backup_manifest_sha256: null,
      phase: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface WriteExecutionAuthorityOptions {
  stateDir?: string;
  activatedAt?: string;
  cutoverId?: string | null;
  inventorySha256?: string | null;
  backupManifestSha256?: string | null;
  phase?: ExecutionAuthorityPhase;
  /**
   * Compare-and-swap guard. When supplied, the current on-disk authority must
   * equal this value or the write refuses. `null` means "no marker file yet".
   */
  expected?: ExecutionAuthority | null;
}

/** Reads the current authority without the legacy fallback swallowing errors. */
function readRawAuthority(path: string): ExecutionAuthority | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("authority marker must be an object");
  const authority = (raw as Record<string, unknown>).authority;
  if (typeof authority !== "string" || !AUTHORITY_VALUES.includes(authority as never)) {
    throw new Error(`invalid authority: ${String(authority)}`);
  }
  return authority as ExecutionAuthority;
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the file itself is
    // still fsynced before the atomic rename in every case.
  }
}

interface AuthorityLockOwner {
  pid: number;
  ownerToken: string;
  createdAt: string;
}

/** Paths currently locked by this process, used to fail fast on re-entry. */
const PROCESS_LOCKS = new Set<string>();

function readLockOwner(
  path: string,
): { owner: AuthorityLockOwner } | { missing: true } | { ambiguous: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { ambiguous: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ambiguous: "lock owner is not an object" };
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.ownerToken !== "string" ||
      record.ownerToken.trim() === ""
    ) {
      return { ambiguous: "lock owner is missing a usable pid/token identity" };
    }
    return {
      owner: {
        pid: record.pid,
        ownerToken: record.ownerToken,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
      },
    };
  } catch (error) {
    return { ambiguous: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Writes a fully-formed owner record to a private temp file and fsyncs it. The
 * caller then atomically links/renames it into place, so a competing reader can
 * never observe a zero-length or partially-written record.
 */
function writeOwnerRecordAtomically(path: string, owner: AuthorityLockOwner): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * True compare-and-swap serialization for the durable marker.
 *
 * The lock is an owner-token file published with `link(2)` from a fully-formed,
 * fsynced temp record. `link` is atomic and refuses to replace an existing path,
 * so exactly one process wins the create and no reader ever sees a partial
 * owner record. A competing process may reclaim the lock only when the recorded
 * owner pid is *proven dead* (`ESRCH`); unreadable/missing ownership is treated as
 * corruption and fails closed for explicit operator recovery. A crash before the
 * `link` leaves no lock at all (only an inert temp file), so it is safely
 * retryable. There is intentionally no time-based steal. The lock spans the entire
 * read -> compare -> write -> rename -> fsync sequence, so two writers cannot
 * both observe the same predecessor.
 */
function acquireMarkerLock(lockPath: string): () => void {
  if (PROCESS_LOCKS.has(lockPath)) {
    throw new ExecutionAuthorityConflictError(
      `Execution authority marker lock ${lockPath} is already held by this process; refusing re-entrant write`,
    );
  }
  const ownerToken = globalThis.crypto.randomUUID();
  const owner: AuthorityLockOwner = {
    pid: process.pid,
    ownerToken,
    createdAt: new Date().toISOString(),
  };
  const tempPath = `${lockPath}.${process.pid}.${ownerToken}.tmp`;
  writeOwnerRecordAtomically(tempPath, owner);
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      try {
        linkSync(tempPath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const inspected = readLockOwner(lockPath);
        if ("owner" in inspected) {
          if (isPidAlive(inspected.owner.pid)) {
            // Non-blocking by design: the async cutover operation lock serializes
            // stage/activate/abort across processes, so direct marker contention is
            // a real conflict. Never spin or sleep on the event loop.
            throw new ExecutionAuthorityConflictError(
              `Execution authority marker is locked by live process ${inspected.owner.pid}; re-read the marker and retry`,
            );
          }
          // Proven dead owner (ESRCH): safe stale reclamation.
          try {
            unlinkSync(lockPath);
          } catch {}
          continue;
        }
        if ("missing" in inspected) {
          // The lock disappeared between the failed link and the read; retry.
          continue;
        }
        // With atomic link publication a healthy creator can never expose a
        // partial record, so unreadable ownership means a corrupt pre-existing
        // lock. Never steal it; require explicit operator recovery.
        throw new ExecutionAuthorityConflictError(
          `Execution authority marker lock ${lockPath} has unreadable ownership (${inspected.ambiguous}); operation recovery is required`,
        );
      }
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {}
  }
  // Never fall through as if the lock were held: a bounded retry loop that never
  // linked the owner record cannot authorize a write. Returning a release here
  // would let two writers believe they serialized the same compare-and-swap.
  if (!acquired) {
    throw new ExecutionAuthorityConflictError(
      `Execution authority marker lock ${lockPath} could not be acquired after bounded retries; re-read the marker and retry`,
    );
  }
  PROCESS_LOCKS.add(lockPath);
  return () => {
    PROCESS_LOCKS.delete(lockPath);
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf-8")) as AuthorityLockOwner;
      if (current?.ownerToken === ownerToken) unlinkSync(lockPath);
    } catch {}
  };
}

/**
 * Atomically replaces the durable marker. The payload is written to a temporary
 * file, fsynced, then renamed over the target and the directory is fsynced so a
 * crash exposes either the previous or the new state, never a partial record.
 */
export function writeExecutionAuthority(
  authority: ExecutionAuthority,
  options: WriteExecutionAuthorityOptions = {},
): ExecutionAuthorityState {
  const path = resolveExecutionAuthorityPath(options.stateDir);
  if (authority !== "legacy" && authority !== "migrating" && authority !== "local") {
    throw new Error(`invalid authority: ${String(authority)}`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquireMarkerLock(join(dirname(path), AUTHORITY_LOCK_FILE));
  try {
    if (options.expected !== undefined) {
      let current: ExecutionAuthority | null;
      try {
        current = readRawAuthority(path);
      } catch (error) {
        throw new ExecutionAuthorityConflictError(
          `Execution authority marker is unreadable; refusing to overwrite it: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // A missing marker is the documented legacy default.
      const comparable = current ?? "legacy";
      if (comparable !== options.expected) {
        throw new ExecutionAuthorityConflictError(
          `Execution authority changed from ${String(options.expected)} to ${String(comparable)}; re-read the marker and retry`,
        );
      }
    }

    const payload = {
      authority,
      activated_at: options.activatedAt ?? new Date().toISOString(),
      cutover_id: options.cutoverId ?? null,
      inventory_sha256: options.inventorySha256 ?? null,
      backup_manifest_sha256: options.backupManifestSha256 ?? null,
      phase:
        options.phase ??
        (authority === "local" ? "active" : authority === "migrating" ? "staging" : null),
    };
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
    return {
      authority,
      activated_at: payload.activated_at,
      source: "marker",
      cutover_id: payload.cutover_id,
      inventory_sha256: payload.inventory_sha256,
      backup_manifest_sha256: payload.backup_manifest_sha256,
      phase: payload.phase,
    };
  } finally {
    release();
  }
}

/** True only for the completed local authority; every other state fails closed. */
export function isLocalAuthority(stateDir?: string): boolean {
  return readExecutionAuthority(stateDir).authority === "local";
}

/** True when the installation is still safe for legacy GitHub/filesystem writers. */
export function isLegacyAuthority(stateDir?: string): boolean {
  return readExecutionAuthority(stateDir).authority === "legacy";
}

/**
 * External-effect gate: an in-progress cutover (`migrating`) or unreadable marker
 * must fail closed before any push, PR/issue mutation, role dispatch or DB write.
 * Both `legacy` (before cutover) and `local` (after cutover) are settled.
 *
 * This is marker-level only. A caller that also has the database must verify that
 * a `local` marker is backed by an activated cutover row (see the backend guard).
 */
export function assertExecutionAuthoritySettled(stateDir?: string): ExecutionAuthorityState {
  const state = readExecutionAuthority(stateDir);
  if (state.error) {
    throw new ExecutionAuthorityGateError(
      "execution_authority_moving",
      `Execution authority marker is unreadable; external writers fail closed: ${state.error}`,
    );
  }
  if (state.authority === "migrating") {
    throw new ExecutionAuthorityGateError(
      "execution_authority_moving",
      "An execution-authority cutover is in progress; external writers are fenced until it settles",
    );
  }
  return state;
}

/** Legacy writers may only run before cutover; after that they must refuse. */
export function assertLegacyAuthority(stateDir?: string): ExecutionAuthorityState {
  const state = readExecutionAuthority(stateDir);
  if (state.error) {
    throw new ExecutionAuthorityGateError(
      "execution_authority_moved",
      `Execution authority marker is unreadable; legacy writers fail closed: ${state.error}`,
    );
  }
  if (state.authority !== "legacy") {
    throw new ExecutionAuthorityGateError(
      "execution_authority_moved",
      "execution_authority_moved: use animus plan dispatch with an admitted plan",
    );
  }
  return state;
}

/** Local dispatchers require the completed authority; never a bare default. */
export function assertLocalAuthority(stateDir?: string): ExecutionAuthorityState {
  const state = readExecutionAuthority(stateDir);
  if (state.error || state.authority !== "local") {
    throw new ExecutionAuthorityGateError(
      "authority_not_activated",
      "authority_not_activated: the installation has not completed its local authority cutover",
    );
  }
  return state;
}
