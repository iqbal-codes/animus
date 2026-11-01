export interface HelpEntry {
  command: string;
  subcommand?: string;
  spec: string;
  description: string;
}

export interface FlagHelp {
  spec: string;
  description: string;
  commands?: string[];
}

export interface ExampleHelp {
  text: string;
  command: string;
}

const HELP_DESC_COLUMN = 32;
const HELP_SPEC_WRAP_THRESHOLD = 36;

export const helpEntries: readonly HelpEntry[] = [
  {
    command: "setup",
    spec: "setup [--yes] [options]",
    description:
      "Interactive onboarding wizard (detects harnesses, configures tiers, laps & checks)",
  },
  {
    command: "config",
    spec: "config <show|audit|harnesses|tier|laps|harness|pattern|rule>",
    description: "Inspect/audit or update repo harness, AGENTS.md, tiers, laps, patterns & rules",
  },
  {
    command: "serve",
    spec: "serve [start|status|stop]",
    description: "Start/manage coordinated Backend + Engine-Host headless runtime",
  },
  {
    command: "backend",
    spec: "backend",
    description: "Start the Backend HTTP/WS server standalone",
  },
  {
    command: "engine",
    spec: "engine [serve|doctor|catalog]",
    description: "Operate Engine-Host server, diagnostics, or workflow catalog",
  },
  {
    command: "status",
    spec: "status",
    description: "Inspect live health, PIDs, and build identity of Backend & Engine",
  },
  {
    command: "doctor",
    spec: "doctor",
    description: "Verify toolchain, architecture boundaries, and engine prerequisites",
  },
  {
    command: "lap",
    spec: "lap <list|get|run|evidence|report>",
    description: "Inspect or launch supervised Animus engine laps",
  },
  {
    command: "loop",
    spec: "loop <run|watch|evidence>",
    description: "Run, watch, or bind/publish evidence for local autonomous issue loops",
  },
  {
    command: "scheduler",
    spec: "scheduler [--once] [--dry-run]",
    description: "Run the autonomous issue backlog scheduler",
  },
  {
    command: "control",
    spec: "control <status|halt|unhalt|pause|unpause>",
    description: "Inspect or toggle operational STOP / PAUSE launch brakes",
  },
  {
    command: "intake",
    spec: "intake [list|get <issue>]",
    description: "Evaluate GitHub issue backlog and admission readiness",
  },
  {
    command: "promotion",
    spec: "promotion <status|prepare>",
    description: "Inspect unpromoted commits or prepare batch promotion PR",
  },
  {
    command: "project",
    spec: "project <list|get|register|remove|monitoring>",
    description: "Manage projects through the selected factory API",
  },
  {
    command: "command",
    spec: "command <list|get|reconcile|backup>",
    description: "Inspect durable operator command ledger, reconcile, or backup DB",
  },
  {
    command: "version",
    spec: "version, --version, -V",
    description: "Show CLI version, build mode, and Git commit",
  },
  {
    command: "help",
    spec: "help [command]",
    description: "Show help message for all commands or a specific command",
  },
];

export const orderedFlags: readonly FlagHelp[] = [
  {
    spec: "--cwd <path>",
    description: "Override repository root working directory",
  },
  {
    spec: "--yes, -y",
    description: "Accept detected defaults non-interactively during 'setup'",
    commands: ["setup"],
  },
  {
    spec: "--factory-url <url>",
    description: "Factory API origin (FACTORY_URL; default: http://127.0.0.1:3000)",
    commands: ["setup", "project"],
  },
  {
    spec: "--factory-token <token>",
    description: "Operator token (FACTORY_TOKEN or FACTORY_HOST_TOKEN)",
    commands: ["setup", "project"],
  },
  {
    spec: "--local-only",
    description: "Save setup locally without enrolling in the factory",
    commands: ["setup"],
  },
  {
    spec: "--repo <owner/repository>",
    description: "Register a GitHub clone in factory-managed storage; sends no local path",
    commands: ["project"],
  },
  {
    spec: "--path <path>",
    description: "Register a local checkout (default: cwd); requires a loopback factory URL",
    commands: ["project"],
  },
  {
    spec: "--name <name>",
    description: "Registered project display name (default: GitHub repository name)",
    commands: ["project"],
  },
  {
    spec: "--provider <id>",
    description: "Default agent harness provider (pi, claude, omp; codex, opencode coming soon)",
    commands: ["setup", "config"],
  },
  {
    spec: "--small-tier <spec>",
    description: "Small tier binding (e.g. pi:default:medium)",
    commands: ["setup"],
  },
  {
    spec: "--medium-tier <spec>",
    description: "Medium tier binding (e.g. claude:claude-sonnet-4-5:high)",
    commands: ["setup"],
  },
  {
    spec: "--large-tier <spec>",
    description: "Large tier binding (e.g. codex:gpt-5.3-codex:high)",
    commands: ["setup"],
  },
  {
    spec: "--effort <rung>",
    description: "Reasoning effort rung (minimal, low, medium, high, xhigh, max, ultra)",
    commands: ["config"],
  },
  {
    spec: "--max-laps <n>",
    description: "Maximum laps per issue before escalating to owner (default: 3)",
    commands: ["setup", "config"],
  },
  {
    spec: "--parallel <n>",
    description: "Maximum parallel autonomous laps (default: 1)",
    commands: ["setup", "config"],
  },
  {
    spec: "--base-branch <branch>",
    description: "Default base branch for worktree isolation & PRs (default: main)",
    commands: ["setup", "config"],
  },
  {
    spec: "--static-cmd <cmd>",
    description: "Repository static check command (lint + typecheck)",
    commands: ["setup", "config"],
  },
  {
    spec: "--unit-cmd <cmd>",
    description: "Repository unit test command",
    commands: ["setup", "config"],
  },
  {
    spec: "--work-window <HH:MM-HH:MM|off>",
    description: "Schedule work window (e.g. 20:00-05:00 or off)",
    commands: ["setup", "config"],
  },
  {
    spec: "--agents-md <keep|overwrite>",
    description: "How to handle AGENTS.md during setup (default: keep existing, create if missing)",
    commands: ["setup", "config"],
  },
  {
    spec: "--host <address>",
    description: "Bind address for serve/backend/engine (default: 127.0.0.1)",
    commands: ["serve", "backend", "engine", "status"],
  },
  {
    spec: "--port, -p <port>",
    description: "HTTP port for serve/backend (default: 3000) or engine (default: 4001)",
    commands: ["serve", "backend", "engine", "status"],
  },
  {
    spec: "--engine-port <port>",
    description: "Dedicated loopback port for engine-host under 'serve' (default: dynamic)",
    commands: ["serve"],
  },
  {
    spec: "--remote-access",
    description: "Enable private network access mode with operator token auth",
    commands: ["serve", "backend"],
  },
  {
    spec: "--state-dir <path>",
    description: "Override runtime state directory (default: .factory/state)",
    commands: ["serve", "backend", "engine", "command"],
  },
  {
    spec: "--web-dir <path>",
    description: "Optional static web directory to serve (headless by default)",
    commands: ["serve", "backend"],
  },
  {
    spec: "--issue, -i <number>",
    description: "Target GitHub issue number for loop run/watch or intake",
    commands: ["loop", "intake"],
  },
  {
    spec: "--run, -r <id>",
    description: "Target run/lap ID for watch or inspection",
    commands: ["loop", "lap"],
  },
  {
    spec: "--dry-run",
    description: "Run preflight validation or simulation without executing changes",
    commands: ["loop", "scheduler"],
  },
  {
    spec: "--no-push",
    description: "Skip pushing branch during local loop execution",
    commands: ["loop"],
  },
  {
    spec: "--once",
    description: "Execute a single poll/tick and exit",
    commands: ["loop", "scheduler"],
  },
  {
    spec: "--history",
    description: "Replay historical session events when watching a loop run",
    commands: ["loop"],
  },
  {
    spec: "--interval <seconds>",
    description: "Polling interval in seconds for scheduler/setup",
    commands: ["scheduler", "setup", "config"],
  },
  {
    spec: "--refresh",
    description: "Force fresh GitHub API lookup bypassing intake cache",
    commands: ["intake"],
  },
  {
    spec: "--mapping <path>",
    description: "Evidence ID to hosted image URL mapping file for loop evidence binding",
    commands: ["loop"],
  },
  {
    spec: "--publish",
    description: "Publish bound evidence to GitHub PR body",
    commands: ["loop"],
  },
  {
    spec: "--candidate <sha>",
    description: "Explicit candidate SHA to bind evidence against",
    commands: ["loop"],
  },
  {
    spec: "--json",
    description: "Output machine-readable JSON",
  },
  {
    spec: "--help, -h",
    description: "Show help message",
  },
];

export const orderedExamples: readonly ExampleHelp[] = [
  { text: "animus setup", command: "setup" },
  {
    text: "animus setup --yes --provider claude --max-laps 4 --parallel 2",
    command: "setup",
  },
  { text: "animus config show", command: "config" },
  { text: "animus config harnesses", command: "config" },
  {
    text: "animus config tier large codex gpt-5.3-codex --effort xhigh",
    command: "config",
  },
  { text: "animus config laps --max-laps 4 --parallel 2 --interval 180", command: "config" },
  {
    text: 'animus config harness --provider pi --static-cmd "bun run check"',
    command: "config",
  },
  { text: "animus serve --port 3000", command: "serve" },
  { text: "animus status --port 3000", command: "status" },
  { text: "animus engine doctor --json", command: "engine" },
  { text: "animus engine catalog", command: "engine" },
  { text: "animus doctor", command: "doctor" },
  { text: "animus control status", command: "control" },
  { text: "animus lap list --json", command: "lap" },
  { text: 'animus lap run "Fix login validation for issue #42"', command: "lap" },
  { text: "animus loop run --issue 72 --dry-run", command: "loop" },
  { text: "animus loop evidence --issue 72", command: "loop" },
  { text: "animus loop evidence --issue 72 --mapping evidence-map.json --publish", command: "loop" },
  { text: "animus scheduler --once --dry-run", command: "scheduler" },
];

export function formatSpecLine(spec: string, description: string): string {
  const parts = description.split("\n");
  const first = parts[0] ?? "";
  const rest = parts.slice(1);
  let firstLine: string;
  if (spec.length > HELP_SPEC_WRAP_THRESHOLD) {
    firstLine = `  ${spec}\n${" ".repeat(HELP_DESC_COLUMN)}${first}`;
  } else if (spec.length + 2 <= HELP_DESC_COLUMN) {
    const pad = " ".repeat(HELP_DESC_COLUMN - spec.length - 2);
    firstLine = `  ${spec}${pad}${first}`;
  } else {
    firstLine = `  ${spec} ${first}`;
  }
  const continuations = rest.map((part) => " ".repeat(HELP_DESC_COLUMN) + part).join("\n");
  return continuations ? `${firstLine}\n${continuations}` : firstLine;
}

export function renderHelp(command?: string): string {
  const entries = command ? helpEntries.filter((e) => e.command === command) : helpEntries;
  const activeEntries = entries.length > 0 ? entries : helpEntries;

  const flags = command
    ? orderedFlags.filter((f) => !f.commands || f.commands.includes(command))
    : orderedFlags;

  const examples = command
    ? orderedExamples.filter((ex) => ex.command === command)
    : orderedExamples;

  const sections: string[] = [];
  sections.push("Animus CLI - Unified Backend, Engine-Host & Autonomous Loop Operator");
  sections.push("");
  sections.push("Usage:");
  sections.push("  animus <command> [subcommand] [options] [arguments]");
  sections.push("");
  sections.push("Commands:");
  sections.push(activeEntries.map((e) => formatSpecLine(e.spec, e.description)).join("\n"));

  if (flags.length > 0) {
    sections.push("");
    sections.push("Options:");
    sections.push(flags.map((f) => formatSpecLine(f.spec, f.description)).join("\n"));
  }

  if (examples.length > 0) {
    sections.push("");
    sections.push("Examples:");
    sections.push(examples.map((ex) => `  ${ex.text}`).join("\n"));
  }

  return `\n${sections.join("\n")}\n`;
}
