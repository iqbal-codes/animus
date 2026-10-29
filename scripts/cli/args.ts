import { parseArgs } from "node:util";

export interface ParsedCliArgs {
  command?: string;
  subcommand?: string;
  positionals: string[];
  values: {
    help?: boolean;
    version?: boolean;
    json?: boolean;
    yes?: boolean;
    cwd?: string;
    host?: string;
    port?: string;
    "engine-port"?: string;
    "remote-access"?: boolean;
    "factory-url"?: string;
    "factory-token"?: string;
    "local-only"?: boolean;
    "state-dir"?: string;
    "web-dir"?: string;
    issue?: string;
    run?: string;
    "dry-run"?: boolean;
    "no-push"?: boolean;
    once?: boolean;
    history?: boolean;
    interval?: string;
    refresh?: boolean;
    reason?: string;
    actor?: string;
    title?: string;
    body?: string;
    name?: string;
    path?: string;
    repo?: string;
    destination?: string;
    state?: string;
    limit?: string;
    provider?: string;
    effort?: string;
    "small-tier"?: string;
    "medium-tier"?: string;
    "large-tier"?: string;
    "max-laps"?: string;
    parallel?: string;
    "base-branch"?: string;
    "static-cmd"?: string;
    "unit-cmd"?: string;
    "work-window"?: string;
    timezone?: string;
    "agents-md"?: string;
    glob?: string;
    forbid?: string;
    require?: string;
    hint?: string;
    mode?: string;
  };
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "V", default: false },
      json: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      cwd: { type: "string" },
      host: { type: "string" },
      port: { type: "string", short: "p" },
      "engine-port": { type: "string" },
      "remote-access": { type: "boolean", default: false },
      "factory-url": { type: "string" },
      "factory-token": { type: "string" },
      "local-only": { type: "boolean", default: false },
      "state-dir": { type: "string" },
      "web-dir": { type: "string" },
      issue: { type: "string", short: "i" },
      run: { type: "string", short: "r" },
      "dry-run": { type: "boolean", default: false },
      "no-push": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      history: { type: "boolean", default: false },
      interval: { type: "string" },
      refresh: { type: "boolean", default: false },
      reason: { type: "string" },
      actor: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      name: { type: "string" },
      path: { type: "string" },
      repo: { type: "string" },
      destination: { type: "string" },
      state: { type: "string" },
      limit: { type: "string" },
      provider: { type: "string" },
      effort: { type: "string" },
      "small-tier": { type: "string" },
      "medium-tier": { type: "string" },
      "large-tier": { type: "string" },
      "max-laps": { type: "string" },
      parallel: { type: "string" },
      "base-branch": { type: "string" },
      "static-cmd": { type: "string" },
      "unit-cmd": { type: "string" },
      "work-window": { type: "string" },
      timezone: { type: "string" },
      "agents-md": { type: "string" },
      glob: { type: "string" },
      forbid: { type: "string" },
      require: { type: "string" },
      hint: { type: "string" },
      mode: { type: "string" },
    },
  });

  const [command, subcommand] = positionals;
  return {
    command,
    subcommand,
    positionals,
    values: values as ParsedCliArgs["values"],
  };
}
