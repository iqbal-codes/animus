import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { resolveAnimusStateDir } from "@animus/contracts/paths";

/**
 * Durable ownership record for the actual bounded-builder process group.
 *
 * The dispatch run's `owner_pid` is the coordinator process that created the
 * claim. The builder role is spawned as a detached child (its own process
 * group), so a surviving child is invisible to a coordinator-liveness check.
 * The default engine persists that child's pid/pgid here before executing and
 * reconciliation refuses to release the claim while either is alive.
 */
export interface DispatchWorkerOwner {
  run_id: string;
  owner_token: string;
  ownership_generation: number;
  pid: number;
  pgid: number;
  /** OS-reported process start identity used to defeat same-record PID reuse. */
  process_start: string | null;
  recorded_at: string;
}

/**
 * Returns the OS process start identity for a live pid, or null when it cannot
 * be read. PID reuse changes this value, so a recorded value that no longer
 * matches the pid proves the record is stale and must never be signalled.
 */
export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  for (const field of ["lstart=", "start="]) {
    try {
      const value = execFileSync("ps", ["-o", field, "-p", String(pid)], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .replace(/\s+/g, " ")
        .trim();
      if (value !== "") return value;
    } catch {}
  }
  return null;
}

const OWNERS_DIR = "dispatch/owners";

export function resolveWorkerOwnerPath(runId: string, customStateDir?: string): string {
  return join(resolveAnimusStateDir(customStateDir), OWNERS_DIR, `${runId}.json`);
}

export function writeWorkerOwner(
  owner: Omit<DispatchWorkerOwner, "recorded_at" | "process_start"> & {
    recorded_at?: string;
    process_start?: string | null;
  },
  customStateDir?: string,
): DispatchWorkerOwner {
  const path = resolveWorkerOwnerPath(owner.run_id, customStateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record: DispatchWorkerOwner = {
    run_id: owner.run_id,
    owner_token: owner.owner_token,
    ownership_generation: owner.ownership_generation,
    pid: owner.pid,
    pgid: owner.pgid,
    process_start:
      owner.process_start === undefined ? processStartIdentity(owner.pid) : owner.process_start,
    recorded_at: owner.recorded_at ?? new Date().toISOString(),
  };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return record;
}

export function readWorkerOwner(
  runId: string,
  customStateDir?: string,
): DispatchWorkerOwner | null {
  const path = resolveWorkerOwnerPath(runId, customStateDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    if (
      typeof record.run_id !== "string" ||
      typeof record.owner_token !== "string" ||
      !Number.isSafeInteger(record.ownership_generation) ||
      (record.ownership_generation as number) <= 0 ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      !Number.isSafeInteger(record.pgid) ||
      (record.pgid as number) <= 0
    ) {
      return null;
    }
    return {
      run_id: record.run_id,
      owner_token: record.owner_token,
      ownership_generation: record.ownership_generation as number,
      pid: record.pid as number,
      pgid: record.pgid as number,
      process_start:
        typeof record.process_start === "string" && record.process_start !== ""
          ? record.process_start
          : null,
      recorded_at: typeof record.recorded_at === "string" ? record.recorded_at : "",
    };
  } catch {
    return null;
  }
}

export function clearWorkerOwner(runId: string, customStateDir?: string): void {
  const path = resolveWorkerOwnerPath(runId, customStateDir);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {}
}

/** True when the pid is a live (non-zombie) process, or belongs to a live process group. */
export function pidOrGroupAlive(pid: number, pgid: number): boolean {
  if (Number.isSafeInteger(pid) && pid > 0 && liveProcess(pid)) return true;
  if (Number.isSafeInteger(pgid) && pgid > 0 && liveGroup(pgid)) return true;
  return false;
}

function groupMembers(pgid: number): string[] | null {
  try {
    const output = execFileSync("ps", ["-o", "stat=", "-g", String(pgid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output === "" ? [] : output.split("\n").map((line) => line.trim());
  } catch (error) {
    // BSD/macOS `ps` exits 1 when the selection matches nothing, i.e. the group is gone.
    if ((error as { status?: number }).status === 1) return [];
    return null;
  }
}

function liveGroup(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const members = groupMembers(pgid);
  // Unreadable process table after a successful group signal: fail closed.
  if (members === null) return true;
  return members.some((state) => state !== "" && !state.startsWith("Z"));
}

function liveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // A zombie cannot write or publish anything; treat it as dead.
    return state !== "" && !state.startsWith("Z");
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    return true;
  }
}
