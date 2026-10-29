import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FactoryLauncher, type LauncherOptions } from "../../../apps/launcher/src/launcher";

export interface RuntimeMetadata {
  pid: number;
  backendUrl: string;
  engineHostUrl: string;
  backendPid?: number;
  engineHostPid?: number;
  startedAt: string;
}

export function getRuntimeMetadataPath(stateDir: string): string {
  return join(stateDir, "runtime.json");
}

export function readRuntimeMetadata(stateDir: string): RuntimeMetadata | null {
  const path = getRuntimeMetadataPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RuntimeMetadata;
  } catch {
    return null;
  }
}

export function writeRuntimeMetadata(stateDir: string, meta: RuntimeMetadata): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(getRuntimeMetadataPath(stateDir), JSON.stringify(meta, null, 2), "utf-8");
}

export function clearRuntimeMetadata(stateDir: string): void {
  try {
    rmSync(getRuntimeMetadataPath(stateDir), { force: true });
  } catch {}
}

export function isPidAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function probeServiceHealth(url: string): Promise<{
  reachable: boolean;
  healthy: boolean;
  buildId: string | null;
}> {
  try {
    const healthRes = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!healthRes.ok) {
      return { reachable: true, healthy: false, buildId: null };
    }
    const healthJson = (await healthRes.json()) as { status?: string };
    const buildRes = await fetch(`${url}/build-id`, { signal: AbortSignal.timeout(1500) });
    const buildId = buildRes.ok ? (await buildRes.text()).trim() : null;
    return {
      reachable: true,
      healthy: healthJson.status === "healthy",
      buildId,
    };
  } catch {
    return { reachable: false, healthy: false, buildId: null };
  }
}

export interface ServeCommandOptions {
  subcommand?: string;
  repoRoot: string;
  host?: string;
  port?: number;
  enginePort?: number;
  stateDir?: string;
  webDir?: string;
  remoteAccess?: boolean;
  json?: boolean;
}

export async function runServeCommand(
  opts: ServeCommandOptions,
  launcherFactory: (options: LauncherOptions) => FactoryLauncher = (options) =>
    new FactoryLauncher(options),
): Promise<number> {
  const stateDir = opts.stateDir ?? join(opts.repoRoot, ".factory/state");
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3000;
  const sub = opts.subcommand ?? "start";

  if (sub === "status") {
    return await runStatusCommand({
      repoRoot: opts.repoRoot,
      stateDir,
      host,
      port,
      json: opts.json,
    });
  }

  if (sub === "stop") {
    const meta = readRuntimeMetadata(stateDir);
    if (!meta) {
      const payload = {
        ok: false,
        status: "not_running",
        message: "No active runtime metadata found.",
      };
      if (opts.json) console.log(JSON.stringify(payload));
      else console.log(payload.message);
      return 0;
    }

    const stoppedPids: number[] = [];
    for (const pid of [meta.pid, meta.backendPid, meta.engineHostPid]) {
      if (pid && pid !== process.pid && isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          stoppedPids.push(pid);
        } catch {}
      }
    }
    clearRuntimeMetadata(stateDir);
    const payload = { ok: true, status: "stopped", stoppedPids };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`Stopped Factory runtime (PIDs: ${stoppedPids.join(", ") || "none"}).`);
    return 0;
  }

  if (sub !== "start") {
    const msg = `Unknown serve subcommand: ${sub}. Expected start, status, or stop.`;
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }

  const launcher = launcherFactory({
    host,
    port,
    enginePort: opts.enginePort ?? 0,
    stateDir,
    webDir: opts.webDir,
    remoteAccess: opts.remoteAccess ?? false,
    repoRoot: opts.repoRoot,
  });

  if (!opts.json) {
    console.log(`Starting Software Factory Services (Backend + Engine-Host) on ${host}:${port}...`);
  }

  const result = await launcher.start();
  if (result.status === "partial_startup_failure") {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, ...result }, null, 2));
    } else {
      console.error(`Factory startup failed: ${result.error}`);
    }
    return 1;
  }

  const status = launcher.getStatus();
  writeRuntimeMetadata(stateDir, {
    pid: process.pid,
    backendUrl: result.backendUrl ?? `http://${host}:${port}`,
    engineHostUrl: result.engineHostUrl ?? "http://127.0.0.1:0",
    backendPid: status.backendPid,
    engineHostPid: status.engineHostPid,
    startedAt: new Date().toISOString(),
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: "running",
          backendUrl: result.backendUrl,
          engineHostUrl: result.engineHostUrl,
          backendPid: status.backendPid,
          engineHostPid: status.engineHostPid,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Backend API running at ${result.backendUrl}`);
    console.log(`Engine-Host running on loopback at ${result.engineHostUrl}`);
    console.log("Press Ctrl+C to stop both services gracefully.");
  }

  if (!status.backendPid && !status.engineHostPid) {
    return 0;
  }

  return await new Promise<number>((resolveExit) => {
    const shutdown = async () => {
      if (!opts.json) console.log("\nStopping Software Factory Services...");
      clearRuntimeMetadata(stateDir);
      const stopResult = await launcher.stop();
      if (stopResult.status === "partial_shutdown_failure") {
        if (!opts.json) console.error("Factory shutdown partial failure:", stopResult.failed);
        resolveExit(1);
        return;
      }
      resolveExit(0);
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });
}

export async function runStatusCommand(opts: {
  repoRoot: string;
  stateDir?: string;
  host?: string;
  port?: number;
  json?: boolean;
}): Promise<number> {
  const stateDir = opts.stateDir ?? join(opts.repoRoot, ".factory/state");
  const meta = readRuntimeMetadata(stateDir);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3000;
  const targetBackendUrl = meta?.backendUrl ?? `http://${host}:${port}`;

  const backendProbe = await probeServiceHealth(targetBackendUrl);
  const engineProbe = meta?.engineHostUrl
    ? await probeServiceHealth(meta.engineHostUrl)
    : { reachable: false, healthy: false, buildId: null };

  const pidAlive = meta ? isPidAlive(meta.pid) : false;
  const running = backendProbe.healthy || pidAlive;

  const statusPayload = {
    ok: true,
    state: running ? "running" : "stopped",
    backend: {
      url: targetBackendUrl,
      pid: meta?.backendPid ?? null,
      reachable: backendProbe.reachable,
      healthy: backendProbe.healthy,
      buildId: backendProbe.buildId,
    },
    engineHost: {
      url: meta?.engineHostUrl ?? null,
      pid: meta?.engineHostPid ?? null,
      reachable: engineProbe.reachable,
      healthy: engineProbe.healthy,
      buildId: engineProbe.buildId,
    },
    startedAt: meta?.startedAt ?? null,
  };

  if (opts.json) {
    console.log(JSON.stringify(statusPayload, null, 2));
  } else {
    console.log(`Factory Status: ${statusPayload.state.toUpperCase()}`);
    console.log(
      `  Backend:     ${statusPayload.backend.url} (${backendProbe.healthy ? "healthy" : "unreachable"}${meta?.backendPid ? `, pid=${meta.backendPid}` : ""})`,
    );
    console.log(
      `  Engine-Host: ${statusPayload.engineHost.url ?? "not configured"} (${engineProbe.healthy ? "healthy" : "unreachable"}${meta?.engineHostPid ? `, pid=${meta.engineHostPid}` : ""})`,
    );
    if (backendProbe.buildId) {
      console.log(`  Build ID:    ${backendProbe.buildId}`);
    }
  }
  return 0;
}

export async function runStandaloneBackend(opts: {
  repoRoot: string;
  host?: string;
  port?: number;
  stateDir?: string;
  webDir?: string;
  remoteAccess?: boolean;
}): Promise<number> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3000;
  const script = resolve(opts.repoRoot, "apps/backend/src/main.ts");
  const child = Bun.spawn([process.execPath, script, "--port", String(port), "--host", host], {
    cwd: opts.repoRoot,
    env: {
      ...process.env,
      FACTORY_STATE_DIR: opts.stateDir ?? join(opts.repoRoot, ".factory/state"),
      ...(opts.webDir ? { FACTORY_WEB_DIR: opts.webDir } : {}),
      FACTORY_REMOTE_ACCESS: String(opts.remoteAccess ?? false),
      FACTORY_HOST_URL: process.env.FACTORY_HOST_URL ?? "http://127.0.0.1:4001",
      FACTORY_HOST_TOKEN:
        process.env.FACTORY_HOST_TOKEN ?? "standalone_local_host_token_0000000000000000",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}
