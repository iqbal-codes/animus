import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAnimusStateDir } from "@animus/contracts/paths";

/**
 * Execution authority marker shared by the scheduler, monitor, CLI and #165 cutover.
 *
 * `legacy` is the only safe default: an installation that has not completed its
 * validated migration must keep its existing GitHub/filesystem writers. `local`
 * may only be written by the cutover that validated the migrated state. The
 * marker is intentionally a small durable file rather than a numbered schema
 * migration so the cutover owner can introduce it without claiming a migration
 * version reserved by another slice.
 */
export type ExecutionAuthority = "legacy" | "local";

export interface ExecutionAuthorityState {
  authority: ExecutionAuthority;
  activated_at: string | null;
  source: "default" | "marker";
  error?: string;
}

const AUTHORITY_FILE = "execution-authority.json";

export function resolveExecutionAuthorityPath(customStateDir?: string): string {
  return join(resolveAnimusStateDir(customStateDir), AUTHORITY_FILE);
}

export function readExecutionAuthority(customStateDir?: string): ExecutionAuthorityState {
  const path = resolveExecutionAuthorityPath(customStateDir);
  if (!existsSync(path)) {
    return { authority: "legacy", activated_at: null, source: "default" };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") throw new Error("authority marker must be an object");
    const record = raw as Record<string, unknown>;
    const authority = record.authority;
    if (authority !== "legacy" && authority !== "local") {
      throw new Error(`invalid authority: ${String(authority)}`);
    }
    const activatedAt =
      typeof record.activated_at === "string" && record.activated_at.trim() !== ""
        ? record.activated_at
        : null;
    return { authority, activated_at: activatedAt, source: "marker" };
  } catch (error) {
    // A malformed marker must never activate the new authority. Fall back to the
    // legacy behaviour and surface the read error so operators can inspect it.
    return {
      authority: "legacy",
      activated_at: null,
      source: "default",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeExecutionAuthority(
  authority: ExecutionAuthority,
  options: { stateDir?: string; activatedAt?: string } = {},
): ExecutionAuthorityState {
  const path = resolveExecutionAuthorityPath(options.stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    authority,
    activated_at: options.activatedAt ?? new Date().toISOString(),
  };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return {
    authority,
    activated_at: payload.activated_at,
    source: "marker",
  };
}
