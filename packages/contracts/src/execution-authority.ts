import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveAnimusStateDir } from "./paths";

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

const AUTHORITY_FILE = "execution-authority.json";
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

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
}

/** True only for the completed local authority; every other state fails closed. */
export function isLocalAuthority(stateDir?: string): boolean {
  return readExecutionAuthority(stateDir).authority === "local";
}

/** True when the installation is still safe for legacy GitHub/filesystem writers. */
export function isLegacyAuthority(stateDir?: string): boolean {
  return readExecutionAuthority(stateDir).authority === "legacy";
}
