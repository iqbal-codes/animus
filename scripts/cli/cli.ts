#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "./args";
import { BUNDLED_GIT_COMMIT, BUNDLED_IS_BINARY, BUNDLED_VERSION } from "./bundled-build";
import { renderHelp } from "./help";
import { runServeCommand, runStandaloneBackend, runStatusCommand } from "./commands/serve";
import { runEngineCommand, runLapCommand } from "./commands/engine";
import { runDoctorCommand } from "./commands/doctor";
import {
  runCommandLedgerCli,
  runControlCommand,
  runIntakeCommand,
  runProjectCommand,
  runPromotionCommand,
} from "./commands/operations";
import { runLoopCliCommand, runSchedulerCliCommand } from "./commands/loop";
import { runConfigCliCommand, runSetupCommand } from "./commands/setup";

export function resolveRepoRoot(cwdOverride?: string): string {
  if (cwdOverride) return resolve(cwdOverride);
  if (BUNDLED_IS_BINARY) return resolve(process.cwd());
  try {
    const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
    if (defaultRoot.includes("/$bunfs/")) return resolve(process.cwd());
    return resolve(defaultRoot);
  } catch {
    return resolve(process.cwd());
  }
}

export function formatVersionOutput(json = false): string {
  const mode = BUNDLED_IS_BINARY ? "binary" : "source";
  const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`;
  if (json) {
    return JSON.stringify(
      {
        name: "animus",
        version: BUNDLED_VERSION,
        commit: BUNDLED_GIT_COMMIT,
        mode,
        runtime,
      },
      null,
      2,
    );
  }
  return `animus v${BUNDLED_VERSION} (${mode}, commit: ${BUNDLED_GIT_COMMIT}, ${runtime})`;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`Error: ${msg}`);
    return 1;
  }

  const { command, subcommand, positionals, values } = parsed;

  if (values.version || command === "version") {
    console.log(formatVersionOutput(Boolean(values.json)));
    return 0;
  }

  if (values.help || !command || command === "help") {
    const targetCmd = command === "help" ? subcommand : command;
    console.log(renderHelp(targetCmd));
    return 0;
  }

  const managedRepositoryCommand = [
    "setup",
    "init",
    "onboard",
    "config",
    "project",
    "projects",
  ].includes(command);
  const repoRoot = managedRepositoryCommand
    ? resolve(values.cwd ?? process.cwd())
    : resolveRepoRoot(values.cwd);
  const port = values.port !== undefined ? Number(values.port) : undefined;
  const enginePort =
    values["engine-port"] !== undefined ? Number(values["engine-port"]) : undefined;
  const maxLaps = values["max-laps"] !== undefined ? Number(values["max-laps"]) : undefined;
  const parallel = values.parallel !== undefined ? Number(values.parallel) : undefined;
  const intervalSeconds = values.interval !== undefined ? Number(values.interval) : undefined;
  const agentsMdAction =
    values["agents-md"] === "keep" ||
    values["agents-md"] === "upgrade" ||
    values["agents-md"] === "overwrite"
      ? values["agents-md"]
      : undefined;

  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    const msg = `--port must be an integer between 0 and 65535, got: ${values.port}`;
    if (values.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }

  switch (command) {
    case "setup":
    case "init":
    case "onboard":
      return await runSetupCommand({
        repoRoot,
        nonInteractive: Boolean(values.yes),
        factoryUrl: values["factory-url"],
        factoryToken: values["factory-token"],
        localOnly: values["local-only"],
        name: values.name,
        provider: values.provider,
        smallTier: values["small-tier"],
        mediumTier: values["medium-tier"],
        largeTier: values["large-tier"],
        maxLaps,
        parallel,
        intervalSeconds,
        baseBranch: values["base-branch"],
        staticCmd: values["static-cmd"],
        unitCmd: values["unit-cmd"],
        workWindow: values["work-window"],
        timezone: values.timezone,
        agentsMdAction,
        json: values.json,
      });

    case "config":
      return await runConfigCliCommand({
        subcommand,
        positionals,
        repoRoot,
        provider: values.provider,
        effort: values.effort,
        maxLaps,
        parallel,
        intervalSeconds,
        baseBranch: values["base-branch"],
        staticCmd: values["static-cmd"],
        unitCmd: values["unit-cmd"],
        workWindow: values["work-window"],
        timezone: values.timezone,
        agentsMdAction,
        fileGlob: values.glob,
        forbidRegex: values.forbid,
        requireRegex: values.require,
        hint: values.hint,
        mode: values.mode,
        json: values.json,
      });

    case "serve":
    case "up":
      return await runServeCommand({
        subcommand,
        repoRoot,
        host: values.host,
        port,
        enginePort,
        stateDir: values["state-dir"],
        webDir: values["web-dir"],
        remoteAccess: values["remote-access"],
        json: values.json,
      });

    case "backend":
      return await runStandaloneBackend({
        repoRoot,
        host: values.host,
        port,
        stateDir: values["state-dir"],
        webDir: values["web-dir"],
        remoteAccess: values["remote-access"],
      });

    case "engine":
      return await runEngineCommand({
        subcommand,
        repoRoot,
        host: values.host,
        port,
        json: values.json,
      });

    case "status":
      return await runStatusCommand({
        repoRoot,
        stateDir: values["state-dir"],
        host: values.host,
        port,
        json: values.json,
      });

    case "doctor":
      return await runDoctorCommand({
        repoRoot,
        json: values.json,
      });

    case "lap":
    case "laps":
      return await runLapCommand({
        subcommand,
        positionals,
        repoRoot,
        runId: values.run,
        json: values.json,
      });

    case "loop":
      return await runLoopCliCommand({
        subcommand,
        positionals,
        repoRoot,
        issue: values.issue,
        run: values.run,
        dryRun: values["dry-run"],
        noPush: values["no-push"],
        once: values.once,
        history: values.history,
        json: values.json,
      });

    case "scheduler":
      return await runSchedulerCliCommand({
        repoRoot,
        once: values.once,
        dryRun: values["dry-run"],
        interval: values.interval,
        json: values.json,
      });

    case "control":
    case "controls":
    case "brake":
    case "brakes":
      return await runControlCommand({
        subcommand,
        repoRoot,
        json: values.json,
      });

    case "promotion":
      return await runPromotionCommand({
        subcommand,
        repoRoot,
        title: values.title,
        body: values.body,
        json: values.json,
      });

    case "intake":
      return await runIntakeCommand({
        subcommand,
        positionals,
        issue: values.issue,
        refresh: values.refresh,
        json: values.json,
      });

    case "project":
    case "projects":
      return await runProjectCommand({
        subcommand,
        positionals,
        repoRoot,
        stateDir: values["state-dir"],
        name: values.name,
        path: values.path,
        repo: values.repo,
        factoryUrl: values["factory-url"],
        factoryToken: values["factory-token"],
        json: values.json,
      });

    case "command":
    case "commands":
      return await runCommandLedgerCli({
        subcommand,
        positionals,
        repoRoot,
        stateDir: values["state-dir"],
        state: values.state,
        limit: values.limit,
        destination: values.destination,
        json: values.json,
      });

    default: {
      const msg = `Unknown command: ${command}. Run 'animus help' for available commands.`;
      if (values.json) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(`Error: ${msg}`);
      return 1;
    }
  }
}

if (import.meta.main) {
  const code = await runCli(Bun.argv.slice(2));
  process.exit(code);
}
