import { resolve } from "node:path";
import type { FactoryLauncher, LauncherOptions } from "../../../apps/launcher/src/launcher";
import { resolveRuntimeRoot, resolveWebDir } from "../runtime-root";
import { runServeCommand } from "./serve";

export interface StartCommandOptions {
  cwd?: string;
  host?: string;
  port?: number;
  enginePort?: number;
  stateDir?: string;
  logsDir?: string;
  remoteAccess?: boolean;
  foreground?: boolean;
  json?: boolean;
  runtimeRoot?: string;
  webDir?: string;
}

export interface StopCommandOptions {
  cwd?: string;
  stateDir?: string;
  json?: boolean;
}

/**
 * `animus start` is the operator-facing entry point for the engine, backend and
 * console. It never assumes the current directory is an Animus checkout: the
 * runtime source tree is resolved explicitly so an installed binary can launch
 * the same services a development checkout does.
 */
export async function runStartCommand(
  opts: StartCommandOptions,
  launcherFactory?: (options: LauncherOptions) => FactoryLauncher,
): Promise<number> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const runtimeRoot = opts.runtimeRoot ? resolve(opts.runtimeRoot) : resolveRuntimeRoot({ cwd });
  const webDir = opts.webDir ?? resolveWebDir(runtimeRoot);

  if (!webDir && !opts.json) {
    console.warn(
      `Web console assets not found at ${resolve(runtimeRoot, "apps/web/dist")}. The API will start without a dashboard; run \`bun run build:web\` in ${runtimeRoot} to serve it.`,
    );
  }

  return await runServeCommand(
    {
      subcommand: "start",
      repoRoot: runtimeRoot,
      host: opts.host,
      port: opts.port,
      enginePort: opts.enginePort,
      stateDir: opts.stateDir,
      logsDir: opts.logsDir,
      webDir,
      remoteAccess: opts.remoteAccess,
      foreground: opts.foreground,
      json: opts.json,
    },
    launcherFactory,
  );
}

export async function runStopCommand(opts: StopCommandOptions): Promise<number> {
  return await runServeCommand({
    subcommand: "stop",
    repoRoot: resolve(opts.cwd ?? process.cwd()),
    stateDir: opts.stateDir,
    json: opts.json,
  });
}
