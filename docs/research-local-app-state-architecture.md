# Research & Architecture Specification: Local Application State Architecture for Animus

* **Author:** Deep-Research Specialist Subagent (`ResearchLocalAppState`)
* **Date:** 2026-10-31
* **Topic:** Design of a Clean, Non-Polluting Local Application State Architecture (`~/.animus/`) for Animus Multi-Agent Autonomous Software Factory
* **Target Artifact:** `docs/research-local-app-state-architecture.md`
* **Status:** Final Research & Architecture Specification

---

## 1. Executive Summary & Problem Formulation

### 1.1 The Repository Pollution Dilemma
Animus is a multi-agent autonomous software factory and execution harness. During autonomous delivery laps, subagents, background supervisors, schedulers, and reviewers generate extensive operational metadata:
* SQLite databases tracking projects and command ledgers (`console.db`).
* Authentication secrets (`session.secret`) and runtime PID files (`runtime.json`).
* Ephemeral execution worktrees (`git worktree`).
* Per-run execution state, command outputs, test transcripts, and reviewer reports (`state.json`, `builder-checks.log`, `reviewer/report.md`).
* Advisory concurrency locks (`*.lock`) and scheduler tick logs (`schedule.log`).
* Operational brake switches (`STOP`, `PAUSE`).

In early versions of the Animus and Factory codebase, many of these operational files were colocated inside the target git repository under `.factory/` (e.g. `.factory/state/`, `.factory/worktrees/`, `.factory/schedule.log`, `.factory/*.lock`) or under `.animus/runs/`. 

This in-repository co-location creates severe systemic friction:
1. **Git Status & Merge Noise:** Uncommitted transient runtime artifacts pollute `git status`, break stash/rebase operations, and cause accidental commits of machine-local state.
2. **Subprocess & Search Tool Poisoning:** Recursive codebase inspection tools (`grep`, `find`, `rg`, AST scanners, and language server indexers) traverse active execution worktrees inside `.factory/worktrees/` or deep run logs, leading to runaway memory consumption and exponential indexing slowdowns.
3. **Security & Credential Exposure:** Machine-specific daemon secrets (`session.secret`) and SQLite database files containing sensitive environment tokens risk being checked into version control.
4. **Multi-Worktree State Collision:** When multiple git worktrees exist for the same repository, placing state inside `.factory/` causes state fragmentation—each worktree perceives a different brake state, schedule log, or lock set.
5. **Brittle `.gitignore` Dependency:** The repository's root `.gitignore` currently devotes 10+ entries solely to ignoring transient `.factory/` files (`.factory/consumer.json`, `.factory/state/`, `.factory/backup/`, `.factory/STOP`, `.factory/PAUSE`, `.factory/schedule.log`, `.factory/schedule-task.xml`, `.factory/trigger.json`, `.factory/gate.json`, `.factory/*.lock`). Any newly introduced lock or log file risks bypassing `.gitignore` if not meticulously updated.

### 1.2 The Solution: Separation of Church and State
Industry-standard AI agent harnesses—specifically **Claude Code** (`~/.claude/`), **OpenAI Codex CLI** (`~/.codex/`), **Pi Agent** (`~/.pi/`), and **OMP** (`~/.omp/`)—strictly separate:
1. **Repository Memory & Policy (Tracked in Git):** Human-authored or curated instructions, skills, hooks, architectural rules, and test harnesses (`.animus/config.yaml`, `.factory/codebase-rules.json`, `.factory/lessons.jsonl`, `.factory/tool-guidance.json`, `.factory/hooks/`, `.agents/skills/`).
2. **Local Application State (Isolated in Home Directory):** Transient databases, daemon credentials, active locks, runtime process tracking, per-run dossiers, execution worktrees, caches, and logs isolated in `~/.animus/` (or paths directed by `$ANIMUS_HOME`).

This document provides a comprehensive primary-source research investigation into how developer CLI tools and AI agent harnesses structure local state, audits the current Animus codebase, and defines a robust, production-ready `~/.animus/` architecture.

---

## 2. Primary Architecture of Modern Developer Harnesses

To establish proven design patterns, we investigate the primary architecture, file structures, permission models, and garbage-collection mechanisms of four production developer harnesses, grounded in their official specifications and directly observed filesystem artifacts.

```
+--------------------------------------------------------------------------------------------------+
|                                    HARNESS ARCHITECTURE COMPARISON                              |
+---------------------+-------------------+---------------------+------------------+---------------+
| Dimension           | Claude Code       | OpenAI Codex CLI    | Pi Agent         | OMP Harness   |
+---------------------+-------------------+---------------------+------------------+---------------+
| Global Home Path    | ~/.claude/        | ~/.codex/           | ~/.pi/agent/     | ~/.omp/agent/ |
| Primary Config File | ~/.claude.json    | config.toml         | settings.json    | config.yml    |
| Override Env Var    | CLAUDE_CONFIG_DIR | CODEX_HOME          | PI_CONFIG_DIR    | OMP_HOME      |
| SQLite Databases    | No (JSONL files)  | Yes (WAL mode)      | No (JSONL files) | Yes (WAL mode)|
| Project Keying      | Slugified Path    | Absolute Path Map   | Escaped Path     | Slugified CWD |
| Session Artifacts   | ~/.claude/projects| ~/.codex/           | ~/.pi/agent/     | ~/.omp/agent/ |
|                     | /<slug>/<id>.jsonl| (in sqlite DBs)     | sessions/<slug>/ | sessions/<cwd>|
| Worktree Storage    | Isolated /tmp     | Isolated sandbox    | Dispatched worker| Isolated CWD  |
| Secret Permissions  | 0o600 / 0o700     | 0o600 / 0o700       | 0o600 / 0o700    | 0o600 / 0o700 |
| In-Repo Footprint   | .claude/          | CODEX.md only       | .pi/settings.json| .omp/         |
|                     | (settings, skills)| (instructions)      | (extension hooks)| (settings)    |
+---------------------+-------------------+---------------------+------------------+---------------+
```

---

### 2.1 Anthropic Claude Code

#### Primary Sources
* Anthropic Claude Code Documentation: *Explore the .claude directory* (`https://code.claude.com/docs/en/claude-directory.md`) [Primary Source: Official Docs]
* Anthropic Claude Code Documentation: *Claude Code settings* (`https://code.claude.com/docs/en/settings.md`) [Primary Source: Official Docs]
* Observed Local Workstation Artifacts: `/Users/efishery/.claude/` and `/Users/efishery/.claude.json` [Primary Source: Local Verification]

#### Directory & State Layout
Claude Code enforces a strict two-tier architecture:
1. **Global Configuration & Application State (`~/.claude/` & `~/.claude.json`):**
   * `~/.claude.json`: Global configuration, user authentication tokens, machine ID, UI toggles, personal MCP servers, and the `projects` map (storing per-project trust status, permission overrides, and custom commands).
   * `~/.claude/projects/<slugified-project-path>/`: Conversation transcripts (`<session-id>.jsonl`), session memory (`memory/`), and tool results. Project paths are slugified by converting all non-alphanumeric characters to hyphens (e.g., `/home/user/my-project` becomes `-home-user-my-project`).
   * `~/.claude/file-history/<session>/`: Pre-edit file snapshots used for checkpoint restoration and undo operations.
   * `~/.claude/session-env/`: Per-session environment metadata.
   * `~/.claude/tasks/`: Subagent task lists and status tracking.
   * `~/.claude/history.jsonl`: Global prompt history with timestamp and project path markers.
   * `~/.claude/backups/`: Up to 5 rotating backups of `~/.claude.json`.
2. **Ephemeral Scratchpad (`/tmp/claude-<uid>/...`):**
   * Temporary execution files, helper scripts, and intermediate artifacts are written to `/private/tmp/claude-<uid>/<project>/<session-id>/scratchpad/` (controllable via `CLAUDE_CODE_TMPDIR`). This prevents scratchpad files from ever entering the git repository or cluttering the persistent user home directory.
3. **In-Repository Project Configuration (`.claude/`):**
   * Committed to git: `.claude/settings.json` (team permissions, hooks, model defaults), `.claude/skills/`, `.claude/commands/`, `.claude/agents/*.md`, `.claude/rules/*.md`, `CLAUDE.md`, `.mcp.json`.
   * Uncommitted local override: `.claude/settings.local.json`, `CLAUDE.local.md`.
   * **In-repo transient state written by Claude Code: NONE.** All execution transcripts, checkpoints, and logs are strictly redirected to `~/.claude/` or temp scratchpads.

#### Retention & Garbage Collection
Claude Code implements an automated retention sweep:
* Files under `projects/`, `file-history/`, `tasks/`, and `debug/` are pruned after `cleanupPeriodDays` (default: 30 days).
* Manual purge CLI: `claude purge <project-path> [--dry-run] [--yes]` removes project transcripts, auto-memory, prompt history lines, and the entry in `~/.claude.json`.

---

### 2.2 OpenAI Codex CLI

#### Primary Sources
* Codex CLI Configuration Specification: `skill://chatgpt-codex-custom-provider` [Primary Source: Installed Skill]
* Local Codex CLI Configuration: `/Users/efishery/.codex/config.toml` [Primary Source: Local Verification]
* Local Codex State & SQLite Assets: `/Users/efishery/.codex/` (`state_5.sqlite`, `logs_2.sqlite`, `auth.json`, `auth.lock`) [Primary Source: Local Verification]

#### Directory & State Layout
Codex CLI encapsulates all local state within `$CODEX_HOME` (default: `~/.codex/`):
* `~/.codex/config.toml`: Central configuration file. Defines global model settings, reasoning effort rungs, MCP servers, and the `[projects."/absolute/path"]` trust registry.
* `~/.codex/auth.json`: Authentication credentials, OAuth tokens, and session tickets. File permissions are locked to `0o600`.
* `~/.codex/auth.lock`: Advisory filesystem lock preventing race conditions between concurrent CLI instances and the Codex desktop daemon (`codex app-server`).
* `~/.codex/*.sqlite` (with `-wal` and `-shm` sidecars):
  * `state_5.sqlite`: Internal state store for sessions, runs, and workspace snapshots.
  * `logs_2.sqlite`: Structured queryable execution logs.
  * `thread_history_1.sqlite`: Thread conversation history.
* `~/.codex/cache/`: Cached remote catalogs, downloaded plugins, and models cache (`models_cache.json`).
* `~/.codex/tmp/`: Ephemeral binaries, IPC sockets, and tool execution helpers (e.g. `apply_patch`).
* **In-Repository Project Footprint:** Codex reads `CODEX.md` or `.codex/instructions.md` for project instructions. It writes zero local state files, logs, or databases into the user's workspace.

---

### 2.3 Pi Agent Harness

#### Primary Sources
* Local Pi Configuration: `/Users/efishery/.pi/agent/settings.json` [Primary Source: Local Verification]
* Local Pi Session Storage: `/Users/efishery/.pi/agent/sessions/` [Primary Source: Local Verification]
* Local Pi Hook Integration: `.pi/settings.json` referencing `.factory/hooks/loop-guard.ts` [Primary Source: Local Verification]

#### Directory & State Layout
Pi Agent partitions global state from project hooks:
* `~/.pi/agent/settings.json`: Global defaults (model, provider, reasoning level, device ID, installed global packages).
* `~/.pi/agent/models-store.json`: Secure provider API keys and model configurations.
* `~/.pi/agent/mcp.json`: Global MCP server configurations.
* `~/.pi/agent/extensions/`: Global runtime extension TypeScript modules (e.g. `orca-agent-status.ts`, `herdr-agent-state.ts`).
* `~/.pi/agent/sessions/`: Session conversation transcripts stored as JSONL files.
  * Subdirectories use double-dash escaped paths: `--Users-efishery-Documents-workspace-projects-animus--/`
  * Session files: `YYYY-MM-DDTHH-mm-ss-SSSZ_<uuid>.jsonl`.
* **In-Repository Project Footprint:** The project repository contains only `.pi/settings.json` specifying repository-specific extension hooks (e.g. `"extensions": ["./.factory/hooks/loop-guard.ts"]`). Pi never writes runtime transcripts or session dumps into the local repository.

---

### 2.4 OMP (Agent Harness)

#### Primary Sources
* OMP Storage Cleanup Guide: `skill://omp-storage-cleanup` [Primary Source: Installed Skill]
* OMP Headless Orchestration Contract: `skill://omp-headless-orchestration-contract` [Primary Source: Installed Skill]
* Local OMP Filesystem Layout: `/Users/efishery/.omp/` (`agent/`, `logs/`, `run/`, `cache/`) [Primary Source: Local Verification]

#### Directory & State Layout
OMP demonstrates an industrial harness state architecture designed for heavy multi-agent workloads:
* `~/.omp/agent/`:
  * Core SQLite databases (in WAL mode): `agent.db`, `history.db`, `models.db`, `skill-descriptions.db`.
  * `sessions/<slugified-cwd>/<session-id>.jsonl`: Multi-turn session transcripts.
  * Per-session advisory lock files: `.<session-id>.jsonl.lock.os`.
  * `blobs/`: Large binary/text content-addressed blobs spilled from tool calls.
* `~/.omp/run/`:
  * `session-owners/<session-id>.lock`: Active PID ownership locks.
  * `daemons/<scope>/`: Background service state (`broker.pid`, `scope.json`, `meta.json`, `output.log`, Unix domain sockets such as `lsp-mux.sock`).
* `~/.omp/logs/`:
  * Daily rotating log files formatted as `omp.<date>.<pid>.log`.
* `~/.omp/cache/`: Precompiled runtime modules, caches, and AST indexes.
* **Garbage Collection Primitives:**
  * Native command: `omp gc --apply --archive --blobs --wal --cold-archive-after-days=7`
  * Retention policies: `gc.coldArchiveAfterDays`, `gc.retainNewestGlobal`, `gc.retainNewestPerCwd`.
  * Ephemeral execution flag: `--no-session` skips writing transcripts entirely, essential for transient evaluation worktrees.

---

## 3. Standards Specification: XDG Base Directory vs POSIX/macOS Dotfiles

### 3.1 The XDG Base Directory Specification (v0.8)
*Published: 08th May 2021 by Freedesktop.org (Waldo Bastian, Allison Karlitskaya, Lennart Poettering, Johannes Löthberg)* [Primary Source: `https://specifications.freedesktop.org/basedir/latest/`]

The specification establishes normative rules for user-specific paths:
1. **`$XDG_DATA_HOME`** (Default: `$HOME/.local/share`):
   * Base directory for user-specific data files (e.g. persistent SQLite databases, completed run dossiers).
2. **`$XDG_CONFIG_HOME`** (Default: `$HOME/.config`):
   * Base directory for user-specific configuration files.
3. **`$XDG_STATE_HOME`** (Default: `$HOME/.local/state`):
   * Base directory for user-specific state files that persist between restarts but are not essential across machines (logs, command history, application layout, recently used files).
4. **`$XDG_CACHE_HOME`** (Default: `$HOME/.cache`):
   * Base directory for user-specific non-essential (cached) data that can be safely wiped without data loss.
5. **`$XDG_RUNTIME_DIR`**:
   * Base directory for runtime communication objects (sockets, named pipes, process locks).
   * **Strict Invariant:** Must be owned by the user, mode `0o700`, bound to login lifecycle.
6. **Binary Executables:** `$HOME/.local/bin` for user-specific executable files.
7. **Permission Invariant:** "If, when attempting to write a file, the destination directory is non-existent an attempt should be made to create it with permission `0700`."

### 3.2 POSIX & macOS Conventions vs Developer CLI Reality
Apple's macOS Human Interface Guidelines recommend:
* Application Support: `~/Library/Application Support/<AppName>/`
* Caches: `~/Library/Caches/<AppName>/`
* Preferences: `~/Library/Preferences/<AppName>.plist`

However, across developer tools and AI coding harnesses (`git`, `gh`, `docker`, `cargo`, `rustup`, `aws`, `claude`, `codex`, `pi`, `omp`), developers and systems engineers overwhelmingly reject the split macOS Library structure in favor of a dedicated dot-directory in `$HOME` (e.g. `~/.animus/` or `$ANIMUS_HOME`):

| Evaluation Criteria | macOS `~/Library/` Structure | Pure XDG Split (`~/.config`, `~/.local`) | Unified `~/.animus/` Dot-Directory |
| :--- | :--- | :--- | :--- |
| **Cross-Platform Parity** | Low (macOS only; requires branching logic for Linux/macOS) | Moderate (Standard on Linux; uncommon on macOS) | **Highest** (Identical paths on macOS, Linux, and WSL) |
| **Container & Docker Mounting** | Poor (Requires mounting multiple deep OS paths) | Moderate (Requires mounting 3-4 separate directories) | **Best** (`-v ~/.animus:/root/.animus` mounts entire toolchain) |
| **Backup & Total Reset** | Complex (Scattered across Library/Caches, Application Support) | Complex (Scattered across `~/.local`, `~/.config`, `~/.cache`) | **Trivial** (`rm -rf ~/.animus` completely cleans local state) |
| **Permission Containment** | Mixed (Inherits macOS user folder permissions) | Dependent on OS umask unless explicitly chmodded | **Strict** (`chmod 700 ~/.animus` seals entire boundary) |
| **Developer Ergonomics** | Low (Paths contain spaces, hard to reach from terminal) | Moderate | **Highest** (Directly accessible via `cd ~/.animus`) |

### 3.3 The Optimal Hybrid Architecture for Animus
The recommended best practice for Animus is an **XDG-principled unified home directory**:
1. Default to a single unified root directory: `~/.animus/` (or `$ANIMUS_HOME`).
2. Mirror the XDG separation of concerns *inside* `~/.animus/`:
   * `~/.animus/bin/` (Executables: matches `$HOME/.local/bin`)
   * `~/.animus/state/` (Persistent state, SQLite DBs, daemon secrets: matches `XDG_DATA_HOME` / `XDG_STATE_HOME`)
   * `~/.animus/runs/` (Execution dossiers and lap artifacts: matches `XDG_DATA_HOME`)
   * `~/.animus/logs/` (Scheduler and daemon output: matches `XDG_STATE_HOME`)
   * `~/.animus/locks/` (Advisory locks and IPC: matches `XDG_RUNTIME_DIR`)
   * `~/.animus/cache/` (Packs, downloads, git caches: matches `XDG_CACHE_HOME`)
   * `~/.animus/worktrees/` (Isolated agent execution workspaces)
3. Allow full environment variable overrides (`ANIMUS_HOME`, `ANIMUS_STATE_DIR`, `ANIMUS_RUNS_DIR`, `ANIMUS_LOGS_DIR`, `ANIMUS_CACHE_DIR`, `ANIMUS_BIN_DIR`) for CI/CD environments and strict Linux packagers who mandate pure XDG paths.

---

## 4. Current State Audit of the Animus Codebase

A systematic audit of `apps/backend/`, `apps/engine-host/`, `apps/launcher/`, `packages/`, and `scripts/` reveals where state, logs, locks, databases, and worktrees are currently resolved.

```
+-----------------------------------------------------------------------------------------------------------------+
|                                     CURRENT STATE PATH AUDIT IN ANIMUS                                          |
+-----------------------------------+-----------------------------------------------+-----------------------------+
| Source File                       | Current Resolved Path                         | Classification / Problem    |
+-----------------------------------+-----------------------------------------------+-----------------------------+
| apps/backend/src/registry/db.ts   | process.env.FACTORY_STATE_DIR ||              | Local State (Good, but uses |
|                                   | join(homedir(), ".factory", "state")          | legacy ~/.factory/ name)    |
| apps/backend/src/security.ts      | join(homedir(), ".factory", "state",          | Local Secret (Good, but uses|
|                                   | "session.secret")                             | legacy ~/.factory/ name)    |
| apps/launcher/src/launcher.ts     | opts.stateDir ?? join(defaultRoot,            | Repo Pollution Risk         |
|                                   | ".factory/state")                             | Defaults to repo directory! |
| scripts/cli/commands/serve.ts     | opts.stateDir ?? join(opts.repoRoot,          | Repo Pollution Bug          |
|                                   | ".factory/state")                             | Disagrees with db.ts!       |
| apps/backend/src/coordination/    | join(project.checkout_path, ".factory",       | Critical Repo Pollution     |
|   service.ts (line 364)           | "worktrees", `spec-${spec}`, `ticket-${n}`)   | Worktrees inside repo!      |
| scripts/local-loop.ts (line 544)  | join(common, "factory-local-loop")            | Repo Pollution              |
|                                   | runs under .factory-local-loop/runs/          | Unignored root folder       |
| scripts/loop/manager.ts (line 31) | join(stateRoot, "locks") and                  | Repo Pollution              |
|                                   | join(stateRoot, "runs")                       | Locks/runs inside repo dir  |
| scripts/loop/scheduler.ts         | join(root, ".factory/schedule.json")          | Mixed Repo/Config State     |
|                                   | join(root, ".factory/STOP"), PAUSE            | Transient brake files       |
| apps/engine-host/src/native.ts    | join(process.env.HOME, ".cache/factory/animus"| Cache Sprawl                |
|                                   | join(repoRoot, ".animus/runs", id, ...)       | Scattered run artifacts     |
| install.sh (line 111)             | ANIMUS_INSTALL_DIR || $HOME/.animus/bin       | Binary Install (Correct)    |
+-----------------------------------+-----------------------------------------------+-----------------------------+
```

### 4.1 Detailed Findings by Subsystem

#### 1. Backend Registry & Session Secrets (`apps/backend/src/`)
* **`apps/backend/src/registry/db.ts` (lines 9–15):**
  ```typescript
  export function resolveStateDir(): string {
    const custom = process.env.FACTORY_STATE_DIR;
    if (custom && custom.trim() !== "") {
      return custom;
    }
    return join(homedir(), ".factory", "state");
  }
  ```
  Resolves `console.db` into `~/.factory/state/`. It applies `0o700` directory permissions and WAL mode.
* **`apps/backend/src/security.ts` (lines 6–26):**
  Resolves `session.secret` into `~/.factory/state/session.secret`. It enforces permission mode `0o600` on the file and `0o700` on the parent directory, throwing `session_secret_insecure_mode` if permissions cannot be secured.
* **`apps/backend/src/coordination/service.ts` (lines 363–368):**
  ```typescript
  const worktreeDir = join(
    project.checkout_path,
    ".factory",
    "worktrees",
    `spec-${specIssueNumber}`,
    `ticket-${childIssueNumber}`,
  );
  ```
  **Critical Finding:** Worktrees are created directly inside the project checkout's `.factory/` directory! If a developer or subagent runs a recursive file search, git grep, or linter, these spawned worktrees are scanned, causing git locks and massive search latency.

#### 2. Engine Host & Native Adapters (`apps/engine-host/src/`)
* **`apps/engine-host/src/native.ts` (lines 38–43, 130–134):**
  Checks cache paths in `join(process.env.HOME || "", ".cache/factory/animus", reqRev)`.
  This creates scattered dot-directories in the user's home (`.cache/factory/animus` alongside `.factory/` and `.animus/`).
* **`apps/engine-host/src/native.ts` (lines 233–236):**
  Resolves lap evidence reports at `join(repoRoot, ".animus/runs", detail.id, "reviewer/report.md")`.
  This attempts to find execution evidence inside the repository root under `.animus/runs/`.

#### 3. Launcher & CLI Serve Commands (`apps/launcher/` & `scripts/cli/`)
* **`scripts/cli/commands/serve.ts` (line 89):**
  ```typescript
  const stateDir = opts.stateDir ?? join(opts.repoRoot, ".factory/state");
  ```
  **Severe Discrepancy:** When `animus serve` or `animus start` is run without `--state-dir`, `serve.ts` defaults `stateDir` to `join(opts.repoRoot, ".factory/state")` inside the repository!
  Meanwhile, `apps/backend/src/registry/db.ts` defaults to `join(homedir(), ".factory", "state")`.
  This discrepancy results in runtime metadata (`runtime.json`) being written inside the git repository while `console.db` is written to `~/.factory/state/`, or vice versa.
* **`apps/launcher/src/launcher.ts` (line 82):**
  Defaults `stateDir` to `join(defaultRoot, ".factory/state")`. Passes `FACTORY_RUNTIME_STATE` and `FACTORY_STATE_DIR` pointing into the repo checkout.

#### 4. Autonomous Local Loop & Schedulers (`scripts/`)
* **`scripts/local-loop.ts` (line 544) & `scripts/loop/manager.ts` (lines 23–32):**
  `stateRoot = join(root, ".factory-local-loop")` or `join(common, "factory-local-loop")`.
  Creates:
  * `join(stateRoot, "locks")`: Advisory file locks.
  * `join(stateRoot, "runs")`: Execution dossiers and lap attempts.
  * `join(stateRoot, "dossiers")`: `issue-${n}.json` files.
* **`scripts/loop/scheduler.ts` (lines 107–117):**
  Checks for `.factory/STOP` and `.factory/PAUSE` in the repo root and `sharedRoot`. Writing these files mutates the working tree.

### 4.2 Classification: Repo-Tracked vs Local User State

To prevent repository pollution while preserving shared project governance, we establish a strict taxonomy:

```
+---------------------------------------------------------------------------------------------------+
|                                      STATE TAXONOMY MATRIX                                        |
+-----------------------------------------+------------------+--------------------------------------+
| Asset / Path                            | Classification   | Target Location                      |
+-----------------------------------------+------------------+--------------------------------------+
| Project Configuration (.animus/config)  | Tracked (Git)    | <repo>/.animus/config.yaml           |
| Engine Workflow Packs (workflows/sdlc)  | Tracked (Git)    | <repo>/.animus/workflows/            |
| Codebase Architecture Rules             | Tracked (Git)    | <repo>/.factory/codebase-rules.json  |
| Curated Agent Lessons                   | Tracked (Git)    | <repo>/.factory/lessons.jsonl        |
| Verified Tool Guidance Recipes          | Tracked (Git)    | <repo>/.factory/tool-guidance.json   |
| Verification Holdouts                   | Tracked (Git)    | <repo>/.factory/holdout/HOLDOUT.md   |
| Repository Guard Hooks                  | Tracked (Git)    | <repo>/.factory/hooks/*.ts           |
| Agent Procedural Skills                 | Tracked (Git)    | <repo>/.agents/skills/               |
| Agent Harness Settings                  | Tracked (Git)    | <repo>/.claude/, .pi/, .omp/         |
+-----------------------------------------+------------------+--------------------------------------+
| Console SQLite Database (console.db)    | Local App State  | ~/.animus/state/console.db           |
| Daemon Session Secret (session.secret)  | Local App State  | ~/.animus/state/session.secret       |
| Active Server Runtime (runtime.json)    | Local App State  | ~/.animus/state/runtime.json         |
| Workspace Trust & Project Registry      | Local App State  | ~/.animus/state/projects.json        |
| Per-Run Execution Dossiers & Artifacts  | Local App State  | ~/.animus/runs/<project>/<run-id>/   |
| Scheduler & Daemon Stderr/Stdout Logs   | Local App State  | ~/.animus/logs/                      |
| Concurrency & Claim Locks (*.lock)      | Local App State  | ~/.animus/locks/                     |
| Execution Worktrees (git worktrees)     | Local App State  | ~/.animus/worktrees/<project>/<id>/  |
| Workflow Engine Cache & Git Bundles     | Local App State  | ~/.animus/cache/                     |
| Installed Binaries (animus, factory)    | Local App State  | ~/.animus/bin/                       |
+-----------------------------------------+------------------+--------------------------------------+
```

---

## 5. Synthesis: The Proposed `~/.animus/` Architecture

### 5.1 Directory Hierarchy Specification

The authoritative directory structure under `$ANIMUS_HOME` (default: `~/.animus`) is defined as follows:

```
~/.animus/                                 [Mode: 0o700 - rwx------]
├── bin/                                   [Mode: 0o755 - rwxr-xr-x]
│   ├── animus                             (Compiled CLI binary)
│   └── factory                            (Symlink to animus)
│
├── state/                                 [Mode: 0o700 - rwx------]
│   ├── console.db                         (Primary SQLite database; WAL mode; Mode: 0o600)
│   ├── console.db-wal                     (SQLite write-ahead log)
│   ├── console.db-shm                     (SQLite shared-memory index)
│   ├── session.secret                     (32-byte daemon auth secret; Mode: 0o600)
│   ├── runtime.json                       (Active daemon PID, port, host URL; Mode: 0o600)
│   ├── projects.json                      (Project slug registry and trust mapping; Mode: 0o600)
│   └── brakes/                            (Project-specific execution brakes)
│       └── <project-slug>.json            (Halt/pause brake state; replaces repo STOP/PAUSE)
│
├── runs/                                  [Mode: 0o700 - rwx------]
│   └── <project-slug>/                    (Per-project run namespace)
│       └── <run-id>/                      (Per-lap execution container)
│           ├── state.json                 (Lap lifecycle, status, timestamps, pid)
│           ├── contract.json              (Snapshot of issue contract & acceptance criteria)
│           ├── dossier.json               (Issue attempt history, retry count, reflections)
│           ├── builder-checks.log         (Raw stdout/stderr from test/lint runs)
│           ├── reviewer/                  (Reviewer subagent outputs)
│           │   └── report.md              (Reviewer verdict, dispositions, findings)
│           ├── qa/                        (QA subagent outputs and probes)
│           │   └── probe-results.json     (Dynamic verification traces)
│           └── artifacts/                 (Screenshots, diffs, test logs)
│
├── logs/                                  [Mode: 0o700 - rwx------]
│   ├── scheduler.log                      (Continuous loop scheduling ticks)
│   ├── daemon.stdout.log                  (Background engine-host and backend stdout)
│   ├── daemon.stderr.log                  (Background engine-host and backend stderr)
│   └── audit.log                          (Operator actions and security events)
│
├── locks/                                 [Mode: 0o700 - rwx------]
│   ├── scheduler.lock                     (Single-instance scheduler tick lock)
│   ├── issue-<n>.lock                     (Issue claim concurrency lock)
│   └── worktree-<id>.lock                 (Worktree mutation lock)
│
├── cache/                                 [Mode: 0o700 - rwx------]
│   ├── packs/                             (Cached workflow packs by revision)
│   │   └── <revision-sha>/                (Unpacked workflow definitions)
│   ├── git/                               (Shared object cache for git clones)
│   └── models/                            (Cached model catalog responses)
│
└── worktrees/                             [Mode: 0o700 - rwx------]
    └── <project-slug>/                    (Per-project isolated execution worktrees)
        └── spec-<spec-id>-ticket-<n>/     (Isolated git worktree detached from repo)
```

---

### 5.2 Deterministic Project Slugification

To isolate runs and worktrees across multiple repositories without path collisions or filesystem issues, project paths must be deterministically slugified.

#### Slug Algorithm
Given a repository checkout path `P` (e.g. `/Users/efishery/Documents/workspace/projects/animus`):
1. Resolve the canonical real path via `realpath(P)`.
2. Extract the base repository folder name `repo_name` (e.g. `animus`).
3. Compute an 8-character cryptographic hash prefix: `sha256(canonical_path).slice(0, 8)`.
4. Construct the slug: `${repo_name}-${hash8}`.
   * *Example:* `animus-a19f3b2c`
5. Sanitize any non-alphanumeric character to a single dash `-`.

```typescript
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename } from "node:path";

export function getProjectSlug(checkoutPath: string): string {
  const canonical = realpathSync(checkoutPath);
  const name = basename(canonical).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}
```

This guarantees:
* Human-readable project identification in directory listings (`~/.animus/runs/animus-a19f3b2c/`).
* Zero collision between two different repositories sharing the same folder name (e.g. `/work/app` vs `/personal/app`).
* Filesystem-safe paths across macOS, Linux, and Windows.

---

### 5.3 Worktree Isolation Outside the Repository

Moving execution worktrees to `~/.animus/worktrees/<project-slug>/` eliminates the severe problem where subagent worktrees pollute the user's local working copy:

```
OLD DANGEROUS PATTERN:
/path/to/repo/.factory/worktrees/spec-12-ticket-34/
  └── Linters, Grep, AST indexers recursively scan the active worktree inside .factory/!

NEW ISOLATED PATTERN:
~/.animus/worktrees/animus-a19f3b2c/spec-12-ticket-34/
  └── Completely isolated in user home; git status and search tools in /path/to/repo/ are 100% clean!
```

#### Git Worktree Mechanics
Creating an isolated worktree outside the repository:
```bash
git -C /path/to/repo worktree add \
  --detach ~/.animus/worktrees/animus-a19f3b2c/spec-12-ticket-34 \
  <start-commit-sha>
```
Cleaning up an isolated worktree:
```bash
git -C /path/to/repo worktree remove \
  --force ~/.animus/worktrees/animus-a19f3b2c/spec-12-ticket-34
```

---

### 5.4 File Permission Invariants & Security Hardening

In multi-user Unix environments, shared build hosts, and CI runners, permissive file permissions on local state directories represent a critical security vulnerability.

Following POSIX SSH (`~/.ssh`), GnuPG (`~/.gnupg`), and the XDG Base Directory runtime specification:
1. **Directories (`~/.animus`, `state`, `runs`, `logs`, `locks`, `cache`, `worktrees`):**
   * MUST be mode `0o700` (`rwx------`: readable, writable, searchable ONLY by the owner).
   * Any newly created directory must be created with `{ recursive: true, mode: 0o700 }` followed by an explicit `chmodSync(dir, 0o700)` fallback check.
2. **Secrets & Databases (`session.secret`, `console.db`, `projects.json`, `runtime.json`):**
   * MUST be mode `0o600` (`rw-------`: readable and writable ONLY by the owner).
   * On startup, the security module checks:
     ```typescript
     const mode = statSync(secretPath).mode & 0o777;
     if (mode !== 0o600) {
       chmodSync(secretPath, 0o600);
       if ((statSync(secretPath).mode & 0o777) !== 0o600) {
         throw new Error("insecure_permissions: secret file must be 0o600");
       }
     }
     ```
3. **Binaries (`~/.animus/bin/*`):**
   * MUST be mode `0o755` (`rwxr-xr-x`).

---

### 5.5 Environment Variable Hierarchy & Precedence

To provide maximum flexibility for CI/CD, multi-tenant daemons, and package managers while preserving backwards compatibility, paths are resolved using a deterministic hierarchy:

```
[Level 1: Explicit Subdirectory Override]
   ANIMUS_STATE_DIR, ANIMUS_RUNS_DIR, ANIMUS_LOGS_DIR, etc.
                  │
                  ▼ (if unset)
[Level 2: Global Home Override]
   ANIMUS_HOME  (e.g. /custom/storage/.animus)
                  │
                  ▼ (if unset)
[Level 3: Legacy Compatibility Override]
   FACTORY_STATE_DIR, FACTORY_RUNS_DIR, etc.
                  │
                  ▼ (if unset)
[Level 4: Default Standard Home]
   $HOME/.animus/  (e.g. ~/.animus/state/)
                  │
                  ▼ (if absent and legacy exists)
[Level 5: Legacy Filesystem Fallback]
   $HOME/.factory/state/  (Migrated on first launch)
```

#### Complete Environment Variable Mapping

| Component | Standard Animus Env Var | Legacy Factory Env Var | Default Path |
| :--- | :--- | :--- | :--- |
| **Home Root** | `ANIMUS_HOME` | `FACTORY_HOME` | `~/.animus` |
| **State & DB** | `ANIMUS_STATE_DIR` | `FACTORY_STATE_DIR` | `~/.animus/state` |
| **Runs & Dossiers**| `ANIMUS_RUNS_DIR` | `FACTORY_RUNS_DIR` | `~/.animus/runs` |
| **Logs** | `ANIMUS_LOGS_DIR` | `FACTORY_LOGS_DIR` | `~/.animus/logs` |
| **Locks** | `ANIMUS_LOCKS_DIR` | `FACTORY_LOCKS_DIR` | `~/.animus/locks` |
| **Cache** | `ANIMUS_CACHE_DIR` | `FACTORY_CACHE_DIR` | `~/.animus/cache` |
| **Worktrees** | `ANIMUS_WORKTREES_DIR`| `FACTORY_WORKTREES_DIR`| `~/.animus/worktrees` |
| **Binaries** | `ANIMUS_BIN_DIR` | `ANIMUS_INSTALL_DIR` | `~/.animus/bin` |

---

### 5.6 Automated Migration Protocol (`~/.factory/state` -> `~/.animus/state`)

To prevent breaking existing developer installations where `console.db` and `session.secret` currently live in `~/.factory/state/`, Animus must execute a transparent, atomic migration on first startup:

```typescript
export function migrateLegacyFactoryState(): void {
  const animusStateDir = resolveStateDir();
  const legacyStateDir = join(homedir(), ".factory", "state");

  // Only attempt migration if legacy directory exists and animus state is fresh
  if (!existsSync(legacyStateDir) || existsSync(join(animusStateDir, "console.db"))) {
    return;
  }

  ensureDirectory(animusStateDir, 0o700);

  // Files to safely migrate
  const filesToMigrate = ["console.db", "console.db-wal", "console.db-shm", "session.secret"];

  for (const file of filesToMigrate) {
    const src = join(legacyStateDir, file);
    const dst = join(animusStateDir, file);

    if (existsSync(src) && !existsSync(dst)) {
      try {
        // Copy file preserving content
        copyFileSync(src, dst);
        // Ensure secure permissions
        chmodSync(dst, file === "session.secret" ? 0o600 : 0o600);
      } catch (err) {
        console.warn(`[Animus Migration] Failed to migrate ${file}:`, err);
      }
    }
  }

  console.info(`[Animus Migration] Successfully migrated local state from ${legacyStateDir} to ${animusStateDir}`);
}
```

---

### 5.7 Retention Sweeps & Garbage Collection

As observed in OMP and Claude Code, autonomous harnesses generate large volumes of build and test logs. Without automated garbage collection, disk usage can swell to tens of gigabytes.

#### 1. In-Loop Ephemeral Retention
* Finished laps whose status is `merged` or `tombstone` retain full raw check logs (`builder-checks.log`) for **14 days**, after which check logs are pruned while structured dossiers (`dossier.json`, `state.json`) and reviewer summaries (`report.md`) are kept permanently.

#### 2. Automatic Age-Based Retention Sweep
* When Animus starts or when the scheduler runs, an asynchronous maintenance sweep deletes run folders under `~/.animus/runs/` older than `ANIMUS_RETENTION_DAYS` (default: 30 days; minimum: 3 days).
* Sockets and PID files in `~/.animus/state/runtime.json` and stale locks in `~/.animus/locks/` are swept if the owning process is confirmed dead (`kill(pid, 0)` throws `ESRCH`).

#### 3. Operator CLI Purge Command
A dedicated CLI command allows operators to inspect and clear disk usage:
```bash
# Preview what would be cleaned up
animus purge --dry-run

# Prune runs older than 7 days
animus purge --days 7 --yes

# Purge state for a specific project
animus purge --project /path/to/my-repo
```

---

## 6. Comprehensive Path Resolution Module Blueprint

To implement this specification across `apps/backend/`, `apps/engine-host/`, `apps/launcher/`, and `scripts/`, a single canonical path resolution module should be added to `@animus/contracts` (or shared package).

### Canonical Implementation (`packages/contracts/src/paths.ts`)

```typescript
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Ensures a directory exists with strict permission modes (default: 0o700).
 */
export function ensureSecureDir(dirPath: string, mode = 0o700): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode });
  }
  try {
    chmodSync(dirPath, mode);
  } catch {
    // Gracefully handle filesystems that restrict chmod
  }
}

/**
 * Resolves the root Animus home directory.
 * Precedence: $ANIMUS_HOME -> $FACTORY_HOME -> ~/.animus
 */
export function resolveAnimusHome(): string {
  const custom = process.env.ANIMUS_HOME || process.env.FACTORY_HOME;
  if (custom && custom.trim() !== "") {
    return resolve(custom.trim());
  }
  return join(homedir(), ".animus");
}

/**
 * Resolves the state directory for databases, secrets, and runtime metadata.
 * Precedence: $ANIMUS_STATE_DIR -> $FACTORY_STATE_DIR -> $ANIMUS_HOME/state
 */
export function resolveStateDir(): string {
  const custom = process.env.ANIMUS_STATE_DIR || process.env.FACTORY_STATE_DIR;
  if (custom && custom.trim() !== "") {
    return resolve(custom.trim());
  }
  return join(resolveAnimusHome(), "state");
}

/**
 * Resolves the path to the primary SQLite database (console.db).
 */
export function resolveDatabasePath(): string {
  const stateDir = resolveStateDir();
  ensureSecureDir(stateDir, 0o700);
  return join(stateDir, "console.db");
}

/**
 * Resolves the path to the session secret file.
 */
export function resolveSessionSecretPath(): string {
  const stateDir = resolveStateDir();
  ensureSecureDir(stateDir, 0o700);
  return join(stateDir, "session.secret");
}

/**
 * Resolves the path to the active runtime metadata file (runtime.json).
 */
export function resolveRuntimeMetadataPath(): string {
  const stateDir = resolveStateDir();
  ensureSecureDir(stateDir, 0o700);
  return join(stateDir, "runtime.json");
}

/**
 * Resolves the base directory for execution runs and dossiers.
 * Precedence: $ANIMUS_RUNS_DIR -> $FACTORY_RUNS_DIR -> $ANIMUS_HOME/runs
 */
export function resolveRunsDir(): string {
  const custom = process.env.ANIMUS_RUNS_DIR || process.env.FACTORY_RUNS_DIR;
  if (custom && custom.trim() !== "") {
    return resolve(custom.trim());
  }
  return join(resolveAnimusHome(), "runs");
}

/**
 * Resolves the logs directory for schedulers and daemon logs.
 */
export function resolveLogsDir(): string {
  const custom = process.env.ANIMUS_LOGS_DIR || process.env.FACTORY_LOGS_DIR;
  if (custom && custom.trim() !== "") {
    return resolve(custom.trim());
  }
  return join(resolveAnimusHome(), "logs");
}

/**
 * Resolves the locks directory for concurrency control.
 */
export function resolveLocksDir(): string {
  const custom = process.env.ANIMUS_LOCKS_DIR || process.env.FACTORY_LOCKS_DIR;
  if (custom && custom.trim() !== "") {
    return resolve(custom.trim());
  }
  return join(resolveAnimusHome(), "locks");
}

/**
 * Resolves the cache directory for workflow packs and git bundles.
 */
export function resolveCacheDir(): string {
  const custom = process.env.ANIMUS_CACHE_DIR || process.env.FACTORY_CACHE_DIR;
  if (custom && custom.trim() !== "") {
    return resolve(custom.trim());
  }
  return join(resolveAnimusHome(), "cache");
}

/**
 * Resolves the directory for isolated agent execution worktrees.
 */
export function resolveWorktreesDir(): string {
  const custom = process.env.ANIMUS_WORKTREES_DIR || process.env.FACTORY_WORKTREES_DIR;
  if (custom && custom.trim() !== "") {
    return resolve(custom.trim());
  }
  return join(resolveAnimusHome(), "worktrees");
}

/**
 * Computes a deterministic slug for a project checkout path.
 * Format: <foldername>-<8char-sha256>
 */
export function resolveProjectSlug(checkoutPath: string): string {
  let canonical = checkoutPath;
  try {
    canonical = realpathSync(checkoutPath);
  } catch {
    canonical = resolve(checkoutPath);
  }
  const folderName = basename(canonical).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${folderName}-${hash}`;
}

/**
 * Resolves the run directory for a specific project lap.
 */
export function resolveRunDir(checkoutPath: string, runId: string): string {
  const slug = resolveProjectSlug(checkoutPath);
  const runDir = join(resolveRunsDir(), slug, runId);
  ensureSecureDir(runDir, 0o700);
  return runDir;
}

/**
 * Resolves the isolated worktree directory for a spec ticket.
 */
export function resolveTicketWorktreeDir(
  checkoutPath: string,
  specIssueNumber: number,
  childIssueNumber: number,
): string {
  const slug = resolveProjectSlug(checkoutPath);
  const worktreeDir = join(
    resolveWorktreesDir(),
    slug,
    `spec-${specIssueNumber}-ticket-${childIssueNumber}`,
  );
  ensureSecureDir(dirname(worktreeDir), 0o700);
  return worktreeDir;
}
```

---

## 7. Migration Checklist for the Animus Codebase

To cut over cleanly to the new `~/.animus/` state architecture, the following files must be updated across the repository:

```
[Phase 1: Contracts & Path Resolver]
   [ ] Add canonical path resolver to packages/contracts/src/paths.ts.
   [ ] Export path resolution functions from @animus/contracts.

[Phase 2: Backend Registry & Security]
   [ ] Update apps/backend/src/registry/db.ts:
         - Replace hardcoded ~/.factory/state with resolveStateDir() and resolveDatabasePath().
         - Add legacy migration invocation on startup.
   [ ] Update apps/backend/src/security.ts:
         - Replace hardcoded ~/.factory/state/session.secret with resolveSessionSecretPath().
   [ ] Update apps/backend/src/coordination/service.ts:
         - Change worktreeDir from join(project.checkout_path, ".factory", "worktrees", ...)
           to resolveTicketWorktreeDir(project.checkout_path, specIssueNumber, childIssueNumber).

[Phase 3: Launcher & CLI Serve Commands]
   [ ] Update apps/launcher/src/launcher.ts:
         - Default stateDir to resolveStateDir() rather than join(defaultRoot, ".factory/state").
   [ ] Update apps/launcher/src/security.ts:
         - Use resolveSessionSecretPath().
   [ ] Update scripts/cli/commands/serve.ts:
         - Replace opts.stateDir ?? join(opts.repoRoot, ".factory/state")
           with opts.stateDir ?? resolveStateDir().
         - Use resolveRuntimeMetadataPath().

[Phase 4: Autonomous Loop & Schedulers]
   [ ] Update scripts/local-loop.ts:
         - Replace stateRoot = join(common, "factory-local-loop")
           with resolveRunsDir() and resolveRunDir(root, runId).
   [ ] Update scripts/loop/manager.ts:
         - Replace locksDir and runsDir inside repo with resolveLocksDir() and resolveRunsDir().
   [ ] Update scripts/loop/scheduler.ts:
         - Redirect schedule.log to join(resolveLogsDir(), "scheduler.log").
         - Redirect scheduler.lock to join(resolveLocksDir(), "scheduler.lock").
   [ ] Update apps/engine-host/src/native.ts:
         - Change cache lookup from ~/.cache/factory/animus to resolveCacheDir().
         - Look for run evidence in resolveRunsDir() rather than repoRoot/.animus/runs/.

[Phase 5: Repository Cleanup & Gitignore]
   [ ] Clean up root .gitignore:
         - Remove unnecessary .factory/ runtime noise (.factory/state/, .factory/*.lock, .factory/schedule.log).
         - Keep .gitignore focused on local developer files and build outputs.
```

---

## 8. Summary of Citations & References

1. **XDG Base Directory Specification (v0.8, 08 May 2021)**:
   * Authors: Waldo Bastian, Allison Karlitskaya, Lennart Poettering, Johannes Löthberg.
   * Published by Freedesktop.org: `https://specifications.freedesktop.org/basedir/latest/`
   * Normative definitions for `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, and `XDG_RUNTIME_DIR`.
2. **Anthropic Claude Code Architecture & Settings Specification**:
   * Official Documentation: *Explore the .claude directory* (`https://code.claude.com/docs/en/claude-directory.md`)
   * Official Documentation: *Claude Code settings* (`https://code.claude.com/docs/en/settings.md`)
   * Two-tier global/project architecture, slugified project transcripts under `~/.claude/projects/`, and temp scratchpads.
3. **OpenAI Codex CLI Configuration & Architecture**:
   * Installed Skill: `skill://chatgpt-codex-custom-provider`
   * Primary Filesystem Verification: `/Users/efishery/.codex/config.toml` and SQLite database layout (`state_5.sqlite`, `logs_2.sqlite`, `auth.json`, `auth.lock`).
4. **Pi Agent Harness Architecture**:
   * Primary Filesystem Verification: `/Users/efishery/.pi/agent/settings.json` and session layout (`~/.pi/agent/sessions/--<escaped-path>--/`).
5. **OMP Harness Storage & Orchestration Contracts**:
   * Installed Skill: `skill://omp-storage-cleanup`
   * Installed Skill: `skill://omp-headless-orchestration-contract`
   * Primary Filesystem Verification: `/Users/efishery/.omp/` (`agent/`, `logs/`, `run/`, `cache/`).
6. **Animus Codebase Primary Files**:
   * `apps/backend/src/registry/db.ts` (lines 9–15: state directory and SQLite configuration)
   * `apps/backend/src/security.ts` (lines 6–26: session secret permissions)
   * `apps/backend/src/coordination/service.ts` (lines 363–368: worktree allocation)
   * `apps/launcher/src/launcher.ts` (line 82: launcher stateDir resolution)
   * `scripts/cli/commands/serve.ts` (lines 14–30, 89: runtime metadata and serve options)
   * `scripts/local-loop.ts` (lines 343, 544: brake checks and local loop state root)
   * `scripts/loop/scheduler.ts` (lines 60, 107–117, 168–188: scheduler configs, brakes, active lap counting)
   * `scripts/loop/manager.ts` (lines 23–32: manager locks and runs sweep)
   * `install.sh` (lines 111–112: `ANIMUS_INSTALL_DIR` default `$HOME/.animus/bin`)
