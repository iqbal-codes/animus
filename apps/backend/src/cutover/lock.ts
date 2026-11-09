import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isPidAlive, withLockMutation } from "@animus/contracts/paths";

/**
 * Cross-process operation lock for the authority cutover.
 *
 * Stage, activate and abort all mutate the durable marker plus the operation
 * row. Serializing the *whole* transition (not just the marker rename) makes a
 * concurrent abort/activate/stage race produce one consistent winner instead of a
 * local marker with a legacy/aborted database row.
 *
 * The lock is an owner-token file published with `link(2)` from a fully-formed,
 * fsynced temp record. `link` is atomic and refuses to replace an existing path,
 * so exactly one process wins the create and no competitor can observe a partial
 * owner record. A competitor may reclaim it only when the owner pid is proven
 * dead (`ESRCH`); missing/unreadable ownership is corruption and fails closed for
 * operator recovery. A crash before the `link` leaves no lock at all (only an
 * inert temp file), so it is safely retryable. There is no time-based steal.
 * Within one process an async queue serializes callers so the synchronous probe
 * never deadlocks the holder.
 */

const LOCK_FILE = ".authority-cutover.lock";
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

function writeOwnerRecordAtomically(path: string, owner: LockOwner): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Serialize stale reclamation under the shared atomic `mkdir` guard before any
 * unlink. Without it, two processes that both observed the same dead owner can
 * each unlink by path: the second removes the fresh owner the first just linked,
 * and both enter the critical section. Under the guard the owner is re-read and
 * removed only when it is still proven dead, so exactly one reclaimer frees the
 * path and every other contender observes the winner's live owner. An abandoned
 * guard fails closed for operator recovery (the same contract as
 * `withLockMutation`); it is never silently stolen.
 */
async function reclaimDeadOwner(lockPath: string): Promise<void> {
  try {
    await withLockMutation(lockPath, () => {
      const current = readOwner(lockPath);
      if (!("owner" in current) || isPidAlive(current.owner.pid)) return;
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  } catch (error) {
    if (error instanceof CutoverLockError) throw error;
    throw new CutoverLockError(
      "cutover_lock_ambiguous",
      `Authority cutover lock ${lockPath} could not be safely reclaimed (${
        error instanceof Error ? error.message : String(error)
      }); explicit operator recovery is required`,
    );
  }
}

async function acquireFileLock(lockPath: string, timeoutMs: number): Promise<() => void> {
  const ownerToken = globalThis.crypto.randomUUID();
  const owner: LockOwner = {
    pid: process.pid,
    ownerToken,
    createdAt: new Date().toISOString(),
  };
  const tempPath = `${lockPath}.${process.pid}.${ownerToken}.tmp`;
  writeOwnerRecordAtomically(tempPath, owner);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      try {
        linkSync(tempPath, lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const inspected = readOwner(lockPath);
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
          // Proven dead owner (ESRCH): reclaim under the atomic guard so two
          // reclaimers cannot both free the path and unlink each other's owner.
          await reclaimDeadOwner(lockPath);
          continue;
        }
        if ("missing" in inspected) {
          // The lock vanished between the failed link and the read; retry.
          if (Date.now() >= deadline) {
            throw new CutoverLockError(
              "cutover_lock_busy",
              `Authority cutover lock ${lockPath} is contended; retry after it settles`,
            );
          }
          continue;
        }
        // With atomic link publication a healthy creator never exposes a partial
        // record, so unreadable ownership is a corrupt pre-existing lock.
        throw new CutoverLockError(
          "cutover_lock_ambiguous",
          `Authority cutover lock ${lockPath} has unreadable ownership (${inspected.ambiguous}); explicit operator recovery is required`,
        );
      }
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {}
  }
  return () => {
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf-8")) as LockOwner;
      if (current?.ownerToken === ownerToken) unlinkSync(lockPath);
    } catch {}
  };
}

export async function withCutoverLock<T>(
  stateDir: string,
  run: () => Promise<T> | T,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, LOCK_FILE);
  const previous = inProcessQueues.get(lockPath) ?? Promise.resolve();
  let releaseProcess!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseProcess = resolve;
  });
  const tail = previous.then(() => gate);
  inProcessQueues.set(lockPath, tail);
  await previous.catch(() => {});
  let releaseFile: (() => void) | undefined;
  try {
    releaseFile = await acquireFileLock(lockPath, timeoutMs);
    return await run();
  } finally {
    try {
      releaseFile?.();
    } finally {
      releaseProcess();
      void tail.finally(() => {
        if (inProcessQueues.get(lockPath) === tail) inProcessQueues.delete(lockPath);
      });
    }
  }
}

/** True when a cutover operation currently owns the cross-process lock. */
export function cutoverLockPresent(stateDir: string): boolean {
  return existsSync(join(stateDir, LOCK_FILE));
}
