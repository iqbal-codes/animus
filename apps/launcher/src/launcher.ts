import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBindAddress, ensureSessionSecret } from "./security";

export interface LauncherOptions {
  host?: string;
  port?: number;
  enginePort?: number;
  stateDir?: string;
  webDir?: string;
  remoteAccess?: boolean;
  operatorToken?: string;
  sessionSecretPath?: string;
  repoRoot?: string;
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

export class FactoryLauncher {
  private readonly options: Required<
    Omit<LauncherOptions, "sessionSecretPath" | "operatorToken">
  > & {
    sessionSecretPath?: string;
    operatorToken?: string;
  };
  private status: LauncherStatus = { state: "stopped" };
  private backendProcess: any = null;
  private engineHostProcess: any = null;
  private isSimulated = false;

  constructor(opts: LauncherOptions = {}) {
    const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
    this.options = {
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 3000,
      enginePort: opts.enginePort ?? 0,
      stateDir: opts.stateDir ?? join(defaultRoot, ".factory/state"),
      webDir: opts.webDir ?? join(defaultRoot, "apps/web/dist"),
      remoteAccess: opts.remoteAccess ?? false,
      repoRoot: opts.repoRoot ?? defaultRoot,
      sessionSecretPath: opts.sessionSecretPath,
      operatorToken: opts.operatorToken,
    };

    validateBindAddress(this.options.host, this.options.remoteAccess);
  }

  getStatus(): LauncherStatus {
    return { ...this.status };
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

    // 1. Start engine-host on loopback
    try {
      this.engineHostProcess = Bun.spawn(
        [
          process.execPath,
          engineScript,
          "--port",
          String(this.options.enginePort),
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
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      succeeded.push("engine-host");
    } catch {
      failed.push("engine-host");
    }

    // 2. Start backend
    if (succeeded.includes("engine-host")) {
      try {
        const engineUrl = `http://127.0.0.1:${this.options.enginePort || 0}`;
        this.backendProcess = Bun.spawn(
          [
            process.execPath,
            backendScript,
            "--port",
            String(this.options.port),
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
              FACTORY_WEB_DIR: this.options.webDir,
              FACTORY_REMOTE_ACCESS: String(this.options.remoteAccess),
              ...(this.options.operatorToken
                ? { FACTORY_OPERATOR_TOKEN: this.options.operatorToken }
                : {}),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        succeeded.push("backend");
      } catch {
        failed.push("backend");
      }
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

    this.status = {
      state: "running",
      backendUrl: `http://${this.options.host}:${this.options.port}`,
      engineHostUrl: `http://127.0.0.1:${this.options.enginePort}`,
      backendPid: this.backendProcess?.pid,
      engineHostPid: this.engineHostProcess?.pid,
    };

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
