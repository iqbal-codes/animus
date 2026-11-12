import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAnimusLogsDir, resolveAnimusStateDir } from "@animus/contracts/paths";
import { validateBindAddress, ensureSessionSecret } from "./security";

export interface LauncherOptions {
  host?: string;
  port?: number;
  enginePort?: number;
  stateDir?: string;
  logsDir?: string;
  webDir?: string;
  remoteAccess?: boolean;
  operatorToken?: string;
  sessionSecretPath?: string;
  repoRoot?: string;
  detached?: boolean;
}

export interface LauncherStatus {
  state: "stopped" | "starting" | "running" | "stopping" | "error";
  backendUrl?: string;
  engineHostUrl?: string;
  backendPid?: number;
  engineHostPid?: number;
}

export interface StartupResult {
  status: "running" | "partial_startup_failure";
  backendUrl?: string;
  engineHostUrl?: string;
  succeeded?: string[];
  failed?: string[];
  error?: string;
}

export interface ShutdownResult {
  status: "stopped" | "partial_shutdown_failure";
  stopped: string[];
  failed?: string[];
  error?: string;
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to allocate port"));
        return;
      }
      const { port } = addr;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export function resolveBunRunner(): string {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const whichBun = Bun.which("bun");
    if (whichBun) return whichBun;
  }
  if (process.execPath && basename(process.execPath).toLowerCase().startsWith("bun")) {
    return process.execPath;
  }
  return "bun";
}

function resolveLauncherRepoRoot(provided?: string): string {
  if (provided && existsSync(join(provided, "apps/engine-host/src/main.ts"))) {
    return resolve(provided);
  }
  const envRoot = process.env.ANIMUS_SOURCE_ROOT || process.env.FACTORY_SOURCE_ROOT;
  if (envRoot && existsSync(join(envRoot, "apps/engine-host/src/main.ts"))) {
    return resolve(envRoot);
  }
  for (const rel of ["../../../", "../../", "../"]) {
    try {
      const candidate = fileURLToPath(new URL(rel, import.meta.url));
      if (
        !candidate.includes("/$bunfs/") &&
        existsSync(join(candidate, "apps/engine-host/src/main.ts"))
      ) {
        return resolve(candidate);
      }
    } catch {}
  }
  try {
    const home = homedir();
    const candidates = [
      join(home, ".animus/source"),
      join(home, "Documents/workspace/projects/animus"),
    ];
    for (const c of candidates) {
      if (existsSync(join(c, "apps/engine-host/src/main.ts"))) {
        return resolve(c);
      }
    }
  } catch {}
  return provided ? resolve(provided) : fileURLToPath(new URL("../../../", import.meta.url));
}

export class FactoryLauncher {
  private readonly options: Required<
    Omit<LauncherOptions, "sessionSecretPath" | "operatorToken" | "webDir" | "logsDir">
  > & {
    sessionSecretPath?: string;
    operatorToken?: string;
    webDir?: string;
    logsDir?: string;
  };
  private status: LauncherStatus = { state: "stopped" };
  private backendProcess: any = null;
  private engineHostProcess: any = null;
  private isSimulated = false;

  constructor(opts: LauncherOptions = {}) {
    const resolvedRepoRoot = resolveLauncherRepoRoot(opts.repoRoot);
    this.options = {
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 3000,
      enginePort: opts.enginePort ?? 0,
      stateDir: opts.stateDir ?? resolveAnimusStateDir(),
      logsDir: opts.logsDir ?? resolveAnimusLogsDir(),
      webDir: opts.webDir ?? join(resolvedRepoRoot, "apps/web/dist"),
      remoteAccess: opts.remoteAccess ?? false,
      repoRoot: resolvedRepoRoot,
      sessionSecretPath: opts.sessionSecretPath,
      operatorToken: opts.operatorToken,
      detached: opts.detached ?? false,
    };

    validateBindAddress(this.options.host, this.options.remoteAccess);
  }

  getStatus(): LauncherStatus {
    return { ...this.status };
  }

  getProcesses(): { backend: any; engineHost: any } {
    return {
      backend: this.backendProcess,
      engineHost: this.engineHostProcess,
    };
  }

  async startSimulated(sim: { backendOk: boolean; engineHostOk: boolean }): Promise<StartupResult> {
    this.isSimulated = true;
    this.status = { state: "starting" };

    const succeeded: string[] = [];
    const failed: string[] = [];

    if (sim.engineHostOk) {
      succeeded.push("engine-host");
      this.status.engineHostUrl = "http://127.0.0.1:4000";
    } else {
      failed.push("engine-host");
    }

    if (sim.backendOk) {
      succeeded.push("backend");
      this.status.backendUrl = `http://${this.options.host}:${this.options.port || 3000}`;
    } else {
      failed.push("backend");
    }

    if (failed.length > 0) {
      this.status = { state: "stopped" };
      return {
        status: "partial_startup_failure",
        succeeded,
        failed,
        error: `Process startup failed for: ${failed.join(", ")}`,
      };
    }

    this.status.state = "running";
    return {
      status: "running",
      backendUrl: this.status.backendUrl,
      engineHostUrl: this.status.engineHostUrl,
      succeeded,
    };
  }

  async stopSimulated(sim: {
    backendStopOk: boolean;
    engineHostStopOk: boolean;
  }): Promise<ShutdownResult> {
    this.status.state = "stopping";
    const stopped: string[] = [];
    const failed: string[] = [];

    if (sim.backendStopOk) {
      stopped.push("backend");
    } else {
      failed.push("backend");
    }

    if (sim.engineHostStopOk) {
      stopped.push("engine-host");
    } else {
      failed.push("engine-host");
    }

    if (failed.length > 0) {
      this.status.state = "error";
      return {
        status: "partial_shutdown_failure",
        stopped,
        failed,
        error: `Process shutdown failed for: ${failed.join(", ")}`,
      };
    }

    this.status = { state: "stopped" };
    return {
      status: "stopped",
      stopped,
    };
  }

  async start(): Promise<StartupResult> {
    this.status.state = "starting";
    const hostToken = randomBytes(32).toString("hex");
    ensureSessionSecret(this.options.sessionSecretPath);

    const root = this.options.repoRoot;
    const engineScript = join(root, "apps/engine-host/src/main.ts");
    const backendScript = join(root, "apps/backend/src/main.ts");

    const succeeded: string[] = [];
    const failed: string[] = [];
    const bunRunner = resolveBunRunner();

    const effectiveEnginePort =
      this.options.enginePort > 0
        ? this.options.enginePort
        : await allocateLoopbackPort().catch(() => 4001);

    const effectiveBackendPort =
      this.options.port > 0 ? this.options.port : await allocateLoopbackPort().catch(() => 3000);

    let outFd: number | undefined;
    let errFd: number | undefined;
    if (this.options.detached) {
      const logsDir = this.options.logsDir ?? resolveAnimusLogsDir();
      try {
        mkdirSync(logsDir, { recursive: true });
        outFd = openSync(join(logsDir, "daemon.stdout.log"), "a");
        errFd = openSync(join(logsDir, "daemon.stderr.log"), "a");
      } catch {}
    }

    // 1. Start engine-host on loopback
    try {
      this.engineHostProcess = Bun.spawn(
        [
          bunRunner,
          engineScript,
          "--port",
          String(effectiveEnginePort),
          "--host",
          "127.0.0.1",
          "--root",
          root,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            FACTORY_HOST_TOKEN: hostToken,
            FACTORY_RUNTIME_STATE: this.options.stateDir,
          },
          stdin: this.options.detached ? "ignore" : undefined,
          stdout: outFd !== undefined ? outFd : "pipe",
          stderr: errFd !== undefined ? errFd : "pipe",
          detached: Boolean(this.options.detached),
        },
      );
      succeeded.push("engine-host");
    } catch {
      failed.push("engine-host");
    }

    // 2. Start backend
    if (succeeded.includes("engine-host")) {
      try {
        const engineUrl = `http://127.0.0.1:${effectiveEnginePort}`;
        this.backendProcess = Bun.spawn(
          [
            bunRunner,
            backendScript,
            "--port",
            String(effectiveBackendPort),
            "--host",
            this.options.host,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              FACTORY_HOST_URL: engineUrl,
              FACTORY_HOST_TOKEN: hostToken,
              FACTORY_STATE_DIR: this.options.stateDir,
              ...(this.options.webDir ? { FACTORY_WEB_DIR: this.options.webDir } : {}),
              FACTORY_REMOTE_ACCESS: String(this.options.remoteAccess),
              ...(this.options.operatorToken
                ? { FACTORY_OPERATOR_TOKEN: this.options.operatorToken }
                : {}),
            },
            stdin: this.options.detached ? "ignore" : undefined,
            stdout: outFd !== undefined ? outFd : "pipe",
            stderr: errFd !== undefined ? errFd : "pipe",
            detached: Boolean(this.options.detached),
          },
        );
        succeeded.push("backend");
      } catch {
        failed.push("backend");
      }
    }

    if (outFd !== undefined) {
      try {
        closeSync(outFd);
      } catch {}
    }
    if (errFd !== undefined) {
      try {
        closeSync(errFd);
      } catch {}
    }

    if (failed.length > 0) {
      await this.stop();
      return {
        status: "partial_startup_failure",
        succeeded,
        failed,
        error: `Startup failed for ${failed.join(", ")}`,
      };
    }

    const backendUrl = `http://${this.options.host}:${effectiveBackendPort}`;
    let backendReady = false;
    for (let i = 0; i < 40; i++) {
      if (this.engineHostProcess?.exitCode !== null) {
        failed.push("engine-host");
        break;
      }
      if (this.backendProcess?.exitCode !== null) {
        failed.push("backend");
        break;
      }
      try {
        const res = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(200) });
        if (res.ok) {
          backendReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!backendReady || failed.length > 0) {
      await this.stop();
      return {
        status: "partial_startup_failure",
        succeeded: succeeded.filter((s) => !failed.includes(s)),
        failed,
        error: `Startup failed for ${failed.join(", ") || "backend readiness probe"}`,
      };
    }

    this.status = {
      state: "running",
      backendUrl: `http://${this.options.host}:${effectiveBackendPort}`,
      engineHostUrl: `http://127.0.0.1:${effectiveEnginePort}`,
      backendPid: this.backendProcess?.pid,
      engineHostPid: this.engineHostProcess?.pid,
    };

    if (this.options.detached) {
      try {
        this.engineHostProcess?.unref();
      } catch {}
      try {
        this.backendProcess?.unref();
      } catch {}
    }

    return {
      status: "running",
      backendUrl: this.status.backendUrl,
      engineHostUrl: this.status.engineHostUrl,
      succeeded,
    };
  }

  async stop(): Promise<ShutdownResult> {
    if (this.isSimulated) {
      return this.stopSimulated({ backendStopOk: true, engineHostStopOk: true });
    }

    this.status.state = "stopping";
    const stopped: string[] = [];
    const failed: string[] = [];

    if (this.backendProcess) {
      try {
        this.backendProcess.kill("SIGTERM");
        stopped.push("backend");
      } catch {
        failed.push("backend");
      }
      this.backendProcess = null;
    }

    if (this.engineHostProcess) {
      try {
        this.engineHostProcess.kill("SIGTERM");
        stopped.push("engine-host");
      } catch {
        failed.push("engine-host");
      }
      this.engineHostProcess = null;
    }

    if (failed.length > 0) {
      this.status.state = "error";
      return {
        status: "partial_shutdown_failure",
        stopped,
        failed,
      };
    }

    this.status = { state: "stopped" };
    return {
      status: "stopped",
      stopped,
    };
  }
}
