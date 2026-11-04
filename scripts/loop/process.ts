import { spawn } from "node:child_process";
import type { ProcessResult } from "./types";
import { validateTimeout } from "./deadlines";

export interface ProcessRunOptions {
  manageSignals?: boolean;
}

const ownedExecutions = new Set<() => Promise<void>>();
let stopping = false;
let hostSignalManagement = true;

const onInterrupt = () => { void stopHost(130); };
const onTerminate = () => { void stopHost(143); };

export function configureProcessLifecycle(options: { manageSignals?: boolean }): void {
  hostSignalManagement = options.manageSignals ?? true;
}

export function stopOwnedExecutions(): Promise<void> {
  return Promise.all([...ownedExecutions].map((cleanup) => cleanup())).then(() => {});
}

async function stopHost(exitCode: number) {
  if (stopping) return;
  stopping = true;
  try {
    await stopOwnedExecutions();
  } finally {
    process.exit(exitCode);
  }
}

/** Own only the POSIX group created by this spawn; never discover owners by cwd or process names. */
export function processRun(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
  options?: ProcessRunOptions,
): Promise<ProcessResult> {
  validateTimeout(timeoutMs);
  if (stopping) throw new Error("Local loop host is shutting down");
  if (process.platform === "win32") throw new Error("Local loop requires POSIX process groups");
  const shouldManageSignals = options?.manageSignals ?? hostSignalManagement;
  return new Promise((resolve) => {
    const resolvedPiCacheRetention =
      env?.PI_CACHE_RETENTION !== undefined
        ? env.PI_CACHE_RETENTION
        : process.env.PI_CACHE_RETENTION !== undefined
          ? process.env.PI_CACHE_RETENTION
          : "long";
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached: true,
      env: {
        ...process.env,
        PI_CACHE_RETENTION: resolvedPiCacheRetention,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finishing: Promise<void> | undefined;
    const drained = Promise.all([child.stdout, child.stderr].map((stream) => new Promise<void>((done) => {
      stream.once("end", done);
      stream.once("close", done);
    })));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          stderr += `\nOwned process group ${signal} failed: ${String(error)}`;
        }
        return false;
      }
    };
    const finish = (exitCode: number): Promise<void> => {
      if (finishing) return finishing;
      finishing = (async () => {
        try {
          clearTimeout(timer);
          if (signalGroup("SIGTERM")) {
            const cleanupDeadline = Date.now() + 250;
            while (Date.now() < cleanupDeadline && signalGroup(0)) {
              await new Promise((done) => setTimeout(done, 10));
            }
            signalGroup("SIGKILL");
          }
          // Even an escaped child holding a pipe cannot keep the host waiting for EOF.
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            drained,
            new Promise((done) => { drainTimer = setTimeout(done, 250); }),
          ]);
          if (drainTimer) clearTimeout(drainTimer);
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          resolve({ exitCode: timedOut ? 124 : exitCode, stdout, stderr, timedOut });
        } finally {
          ownedExecutions.delete(cleanup);
          if (shouldManageSignals && ownedExecutions.size === 0) {
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onTerminate);
          }
        }
      })();
      return finishing;
    };
    const cleanup = () => finish(143);
    if (shouldManageSignals && ownedExecutions.size === 0) {
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
    }
    ownedExecutions.add(cleanup);
    const timer = setTimeout(() => {
      timedOut = true;
      void finish(124);
    }, timeoutMs);
    child.once("error", (error) => {
      stderr += error.message;
      void finish(127);
    });
    child.once("exit", (code, signal) => { void finish(code ?? (signal ? 128 : 1)); });
  });
}
