import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "@animus/contracts/paths";

/**
 * Cross-process operation lock for the authority cutover.
 *
 * Stage, activate and abort all mutate the durable marker plus the operation
 * row. Serializing the *whole* transition (not just the marker rename) makes a
 * concurrent abort/activate/stage race produce one consistent winner instead of a
 * local marker with a legacy/aborted database row.
 *
 * The lock is a directory created atomically. Its `owner.json` records a pid and
 * a unique token. A competitor may reclaim it only when the owner pid is proven
 * dead (`ESRCH`); missing/unreadable ownership is ambiguous and fails closed for
 * operator recovery. There is no time-based steal. Within one process an async
 * queue serializes callers so the synchronous probe never deadlocks the holder.
 */

const LOCK_DIRECTORY = ".authority-cutover.lock";
const DEFAULT_TIMEOUT_MS = 30_000;

export type CutoverLockErrorCode = "cutover_lock_busy" | "cutover_lock_ambiguous";

export class CutoverLockError extends Error {
  constructor(
    public readonly code: CutoverLockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CutoverLockError";
  }
}

interface LockOwner {
  pid: number;
  ownerToken: string;
  createdAt: string;
}

const inProcessQueues = new Map<string, Promise<void>>();

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function readOwner(path: string): { owner: LockOwner } | { missing: true } | { ambiguous: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { ambiguous: error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ambiguous: "owner is not an object" };
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.ownerToken !== "string" ||
      record.ownerToken.trim() === ""
    ) {
      return { ambiguous: "owner is missing a usable pid/token identity" };
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

async function acquireFileLock(lockDir: string, timeoutMs: number): Promise<() => void> {
  const ownerToken = globalThis.crypto.randomUUID();
  const ownerPath = join(lockDir, "owner.json");
  const deadline = Date.now() + timeoutMs;
  let missingOwnerReads = 0;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const inspected = readOwner(ownerPath);
      if ("owner" in inspected) {
        if (isPidAlive(inspected.owner.pid)) {
          if (Date.now() >= deadline) {
            throw new CutoverLockError(
              "cutover_lock_busy",
              `Authority cutover is already running under live process ${inspected.owner.pid}; retry after it settles`,
            );
          }
          await sleep(25);
          continue;
        }
        // Proven dead owner (ESRCH): safe stale reclamation.
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if ("missing" in inspected) {
        // The creator may still be writing its owner record; give it a bounded
        // window, then require explicit operator recovery rather than stealing.
        missingOwnerReads += 1;
        if (missingOwnerReads > 40) {
          throw new CutoverLockError(
            "cutover_lock_ambiguous",
            `Authority cutover lock ${lockDir} has no owner identity; explicit operator recovery is required`,
          );
        }
        await sleep(25);
        continue;
      }
      throw new CutoverLockError(
        "cutover_lock_ambiguous",
        `Authority cutover lock ${lockDir} has unreadable ownership (${inspected.ambiguous}); explicit operator recovery is required`,
      );
    }
    const owner: LockOwner = {
      pid: process.pid,
      ownerToken,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    return () => {
      try {
        const current = JSON.parse(readFileSync(ownerPath, "utf-8")) as LockOwner;
        if (current?.ownerToken === ownerToken) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {}
    };
  }
}

export async function withCutoverLock<T>(
  stateDir: string,
  run: () => Promise<T> | T,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const lockDir = join(stateDir, LOCK_DIRECTORY);
  const previous = inProcessQueues.get(lockDir) ?? Promise.resolve();
  let releaseProcess!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseProcess = resolve;
  });
  const tail = previous.then(() => gate);
  inProcessQueues.set(lockDir, tail);
  await previous.catch(() => {});
  let releaseFile: (() => void) | undefined;
  try {
    releaseFile = await acquireFileLock(lockDir, timeoutMs);
    return await run();
  } finally {
    try {
      releaseFile?.();
    } finally {
      releaseProcess();
      void tail.finally(() => {
        if (inProcessQueues.get(lockDir) === tail) inProcessQueues.delete(lockDir);
      });
    }
  }
}

/** True when a cutover operation currently owns the cross-process lock. */
export function cutoverLockPresent(stateDir: string): boolean {
  return existsSync(join(stateDir, LOCK_DIRECTORY));
}
