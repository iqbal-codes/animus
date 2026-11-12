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
    command: "onboard",
    spec: "onboard [--yes] [--accept-unverified-auth] [--reconfigure]",
    description:
      "Machine-wide onboarding: prerequisites, live harness detection, GitHub auth, ~/.animus/config.yaml",
  },
  {
    command: "start",
    spec: "start [--foreground] [--port <port>] [--web-dir <path>]",
    description: "Start Backend, Engine-Host and the web console from the resolved runtime",
  },
  {
    command: "stop",
    spec: "stop",
    description: "Stop the running Backend and Engine-Host",
  },
  {
    command: "setup",
    spec: "setup [--yes] [options]",
    description:
      "Per-repository onboarding wizard (harnesses, tiers, laps & checks) for one checkout",
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
    spec: "intake [list|get <issue>|triage] [--issue <number>] [--dry-run]",
    description: "Evaluate GitHub issue backlog and run on-demand triage passes",
  },
  {
    command: "draft",
    spec: "draft <list|get|refine|revise|approve|reject|request-changes> --project <project-id>",
    description:
      "Refine imported work into local drafts, answer questions, and record operator decisions",
  },
  {
    command: "promotion",
    spec: "promotion <status|prepare>",
    description: "Inspect unpromoted commits or prepare batch promotion PR",
  },
  {
    command: "plan",
    spec: "plan <list|get|import|approve|revoke|dispatch|runs|run|detail|evidence|findings|grants|grant|hold|resume|stop|takeover|claims|claim-interrupt|claim-complete|reconcile|publication|audit|publish|bind-evidence|integration|integrations|land> --project <project-id>",
    description:
      "Inspect, decide and dispatch frozen local execution plans with budgets, run controls and publication audit",
  },
  {
    command: "project",
    spec: "project <list|get|register|remove|monitoring>",
    description: "Manage projects through the selected factory API",
  },
  {
    command: "authority",
    spec: "authority <status|stage|activate|abort|mappings>",
    description:
      "Inspect, stage, activate or abort the validated local execution-authority cutover with backup and held-restore proof",
  },
  {
    command: "backup",
    spec: "backup <status|create|restore|restores|reconcile> [destination|source] [--target-state-dir <path>] [--target-home <path>] [--state-dir <path>]",
    description:
      "Create verified workspace backups, report restorability, and restore isolated held installations; with --state-dir the compiled CLI runs the same backend service offline",
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
    description: "Accept detected defaults non-interactively during 'onboard' and 'setup'",
    commands: ["onboard", "setup"],
  },
  {
    spec: "--accept-unverified-auth",
    description:
      "Non-interactive 'onboard': accept that harness sign-in cannot be verified automatically",
    commands: ["onboard"],
  },
  {
    spec: "--reconfigure",
    description: "Re-run machine onboarding choices even when already onboarded",
    commands: ["onboard"],
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
    spec: "--project <project-id>",
    description: "Registered project ID for work, draft, or plan reads",
    commands: ["work", "draft", "plan"],
  },
  {
    spec: "--reason <text>",
    description: "Reason for a draft, plan decision, or cutover abort",
    commands: ["draft", "plan", "authority"],
  },
  {
    spec: "--cutover-id <id>",
    description: "Exact authority cutover operation",
    commands: ["authority"],
  },
  {
    spec: "--answers <json>",
    description: "Answers to draft clarification questions as a JSON array or @file",
    commands: ["draft"],
  },
  {
    spec: "--instructions <text>",
    description: "Operator revision instructions for the next draft revision",
    commands: ["draft"],
  },
  {
    spec: "--stage <technical_checks|code_review|blackbox_verification>",
    description: "Delivery role claim stage for claim-interrupt/claim-complete",
    commands: ["plan"],
  },
  {
    spec: "--expected-generation <n>",
    description: "Opaque claim generation CAS version the operator observed",
    commands: ["plan"],
  },
  {
    spec: "--ack-unknown-owner",
    description: "Acknowledge unknown-owner effects when interrupting a claim",
    commands: ["plan"],
  },
  {
    spec: "--revision <number>",
    description: "Exact draft revision number a decision targets",
    commands: ["draft"],
  },
  {
    spec: "--kind <standalone|spec>",
    description:
      "Prepared plan kind for import; standalone tickets stay standalone, specs never fall back",
    commands: ["plan"],
  },
  {
    spec: "--provider <id>",
    description:
      "Default agent harness provider (pi, claude, omp, commandcode; codex, opencode coming soon)",
    commands: ["onboard", "setup", "config"],
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
    description: "Maximum laps per issue before escalating to owner (default: machine policy)",
    commands: ["onboard", "setup", "config"],
  },
  {
    spec: "--parallel <n>",
    description: "Maximum parallel autonomous laps (default: machine policy)",
    commands: ["onboard", "setup", "config"],
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
    description: "Schedule work window (e.g. 20:00-05:00 or off); onboard sets the machine default",
    commands: ["onboard", "setup", "config"],
  },
  {
    spec: "--agents-md <keep|overwrite>",
    description: "How to handle AGENTS.md during setup (default: keep existing, create if missing)",
    commands: ["setup", "config"],
  },
  {
    spec: "--foreground, -f",
    description: "Run services in the foreground instead of detaching into the background",
    commands: ["start", "serve"],
  },
  {
    spec: "--host <address>",
    description: "Bind address for serve/backend/engine (default: 127.0.0.1)",
    commands: ["start", "serve", "backend", "engine", "status"],
  },
  {
    spec: "--port, -p <port>",
    description: "HTTP port for serve/backend (default: 3000) or engine (default: 4001)",
    commands: ["start", "serve", "backend", "engine", "status"],
  },
  {
    spec: "--engine-port <port>",
    description: "Dedicated loopback port for engine-host under 'start'/'serve' (default: dynamic)",
    commands: ["start", "serve"],
  },
  {
    spec: "--remote-access",
    description: "Enable private network access mode with operator token auth",
    commands: ["start", "serve", "backend"],
  },
  {
    spec: "--state-dir <path>",
    description: "Override runtime state directory (default: ~/.animus/state)",
    commands: ["start", "stop", "serve", "backend", "engine", "command"],
  },
  {
    spec: "--web-dir <path>",
    description: "Optional static web directory to serve (headless by default)",
    commands: ["start", "serve", "backend"],
  },
  {
    spec: "--issue, -i <number>",
    description: "Target GitHub issue number for loop run/watch, intake or plan import",
    commands: ["loop", "intake", "plan"],
  },
  {
    spec: "--run, -r <id>",
    description: "Target run/lap ID for watch or inspection",
    commands: ["loop", "lap"],
  },
  {
    spec: "--dry-run",
    description: "Run preflight validation or simulation without executing changes",
    commands: ["loop", "scheduler", "intake"],
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
    description: "Polling interval in seconds for scheduler/onboard/setup",
    commands: ["onboard", "scheduler", "setup", "config"],
  },
  {
    spec: "--refresh",
    description: "Force fresh GitHub API lookup bypassing intake cache",
    commands: ["intake"],
  },
  {
    spec: "--target-state-dir <path>",
    description: "Isolated target state directory for backup restore, status and reconciliation",
    commands: ["backup"],
  },
  {
    spec: "--target-home <path>",
    description: "Isolated target Animus home used to rewrite legitimate home-local worktree paths",
    commands: ["backup"],
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
    text: "animus onboard --yes --accept-unverified-auth --max-laps 4 --parallel 2 --interval 120",
    command: "onboard",
  },
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
  {
    text: "animus loop evidence --issue 72 --mapping evidence-map.json --publish",
    command: "loop",
  },
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
