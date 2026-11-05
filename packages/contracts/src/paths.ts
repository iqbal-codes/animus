import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface WorkWindowConfig {
  enabled: boolean;
  start_time: string;
  end_time: string;
  timezone: string;
}

export interface ScheduleConfig {
  workflow: string;
  parallel: number;
  max_laps: number;
  interval_seconds: number;
  inputs?: Record<string, unknown>;
  work_window?: WorkWindowConfig;
}

export interface ProjectWorkspace {
  /** The working repository checkout root path. */
  root: string;
  /** The canonical Git common directory (realpath to .git or primary .git). */
  canonicalGitCommon: string;
  /** SHA-256 hash of canonicalGitCommon. */
  gitCommonHash: string;
  /** The primary checkout root path (e.g. parent of canonicalGitCommon or checkout root). */
  primaryRoot: string;
  /** Deterministic project slug, e.g. <name>-<sha256[:8]>. */
  projectSlug: string;
  /** The state root directory (canonical precedence: explicit override outside checkout -> external ~/.animus/projects/<projectSlug> -> <canonicalGitCommon>/factory-local-loop). */
  stateRoot: string;
  /** Runs directory: <stateRoot>/runs. */
  runsDir: string;
  /** Worktrees directory: <stateRoot>/worktrees. */
  worktreesDir: string;
  /** Locks directory: <stateRoot>/locks. */
  locksDir: string;
  /** Dossiers directory: <stateRoot>/dossiers. */
  dossiersDir: string;
  /** Triage state root strictly outside checkout: <AnimusStateDir>/triage/<gitCommonHash>. */
  triageStateRoot: string;
  /** True if external state (~/.animus/projects/<projectSlug>) is active. */
  isExternalState: boolean;
  /** Fallback runs directories to inspect (e.g. <AnimusHome>/runs/<projectSlug>). */
  fallbackRunsDirs: string[];
}

export interface ProjectWorkspaceOptions {
  /** Explicit state root directory override. If outside checkout root, takes precedence. */
  stateRoot?: string;
  /** Explicit custom Animus home directory override (replaces ANIMUS_HOME). */
  customHome?: string;
  /** Explicit custom Animus state directory override (replaces ANIMUS_STATE_DIR). */
  customStateDir?: string;
  /** Explicit custom runs directory override (replaces ANIMUS_RUNS_DIR). */
  customRunsDir?: string;
  /** Explicit custom worktrees directory override (replaces ANIMUS_WORKTREES_DIR). */
  customWorktreesDir?: string;
}

export interface WorkspaceBrakeCheckResult {
  active: boolean;
  halted: boolean;
  paused: boolean;
  active_brake: "none" | "stop" | "pause" | "both";
  type?: "stop" | "pause" | "both";
  path?: string;
  paths: {
    stop?: string;
    pause?: string;
  };
}

export interface RelationalBrakeChecker {
  isScheduledLaunchPermitted?: (projectId?: string | null) => {
    permitted: boolean;
    reason?: string;
  };
  isLaunchPermitted?: (projectId?: string | null) => { permitted: boolean; reason?: string };
}

export interface WorkspacePreflightOptions {
  /** Optional relational brake checker or BrakeService instance. */
  brakes?: RelationalBrakeChecker | null;
  /** Optional project ID for project-scoped relational brakes. */
  projectId?: string | null;
  /** Optional schedule config overrides (e.g. CLI flags or tick options). */
  config?: Partial<ScheduleConfig> | null;
  /** Point in time for work-window evaluation (defaults to new Date()). */
  now?: Date;
  /** Operational mode: "schedule" evaluates schedule pauses and work window; "launch" evaluates launch brakes only. Default is "schedule". */
  mode?: "schedule" | "launch";
  /** If true, capacity check is not treated as a blocker (e.g. for triage or status inspection). */
  ignoreCapacity?: boolean;
}

export interface WorkspacePreflightResult {
  ok: boolean;
  status: "ready" | "blocked" | "held";
  reason?:
    | "stop_brake_set"
    | "pause_brake_set"
    | "schedule_paused"
    | "launch_brake_set"
    | "brake_state_unknown"
    | "outside_work_window"
    | "capacity_full"
    | (string & {});
  detail?: string;
  workspace: ProjectWorkspace;
  brakes: {
    halted: boolean;
    paused: boolean;
    active_brake: "none" | "stop" | "pause" | "both";
    filesystem: WorkspaceBrakeCheckResult;
    relational?: {
      permitted: boolean;
      reason?: string;
    };
  };
  schedule: ScheduleConfig;
  workWindow: {
    withinWindow: boolean;
    window?: WorkWindowConfig;
  };
  capacity: {
    activeLaps: number;
    maxParallel: number;
    availableSlots: number;
    hasCapacity: boolean;
  };
}

export type ControlAction = "halt" | "unhalt" | "pause" | "unpause";

/**
 * Resolves the primary root directory for Animus application state (~/.animus).
 *
 * Precedence:
 * 1. Explicit override passed as parameter
 * 2. ANIMUS_HOME environment variable
 * 3. FACTORY_HOME environment variable (legacy compatibility)
 * 4. $HOME/.animus
 */
export function resolveAnimusHome(customHome?: string): string {
  if (customHome && customHome.trim() !== "") {
    return resolve(customHome.trim());
  }
  const envAnimus = process.env.ANIMUS_HOME;
  if (envAnimus && envAnimus.trim() !== "") {
    return resolve(envAnimus.trim());
  }
  const envLegacy = process.env.FACTORY_HOME;
  if (envLegacy && envLegacy.trim() !== "") {
    return resolve(envLegacy.trim());
  }
  return join(homedir(), ".animus");
}

/**
 * Resolves the persistent state directory for SQLite databases, secrets, and runtime metadata.
 *
 * Precedence:
 * 1. Explicit override passed as parameter
 * 2. ANIMUS_STATE_DIR environment variable
 * 3. If ANIMUS_HOME is set: join(ANIMUS_HOME, "state")
 * 4. FACTORY_STATE_DIR environment variable (legacy compatibility)
 * 5. join(resolveAnimusHome(), "state") -> ~/.animus/state
 */
export function resolveAnimusStateDir(customStateDir?: string): string {
  if (customStateDir && customStateDir.trim() !== "") {
    return resolve(customStateDir.trim());
  }
  const envAnimusState = process.env.ANIMUS_STATE_DIR;
  if (envAnimusState && envAnimusState.trim() !== "") {
    return resolve(envAnimusState.trim());
  }
  const envAnimusHome = process.env.ANIMUS_HOME;
  if (envAnimusHome && envAnimusHome.trim() !== "") {
    return join(resolve(envAnimusHome.trim()), "state");
  }
  const envLegacyState = process.env.FACTORY_STATE_DIR;
  if (envLegacyState && envLegacyState.trim() !== "") {
    return resolve(envLegacyState.trim());
  }
  return join(resolveAnimusHome(), "state");
}

/**
 * Resolves the directory for execution runs and dossiers.
 *
 * Precedence:
 * 1. Explicit override passed as parameter
 * 2. ANIMUS_RUNS_DIR environment variable
 * 3. If ANIMUS_HOME is set: join(ANIMUS_HOME, "runs")
 * 4. FACTORY_RUNS_DIR environment variable (legacy compatibility)
 * 5. join(resolveAnimusHome(), "runs") -> ~/.animus/runs
 */
export function resolveAnimusRunsDir(customRunsDir?: string): string {
  if (customRunsDir && customRunsDir.trim() !== "") {
    return resolve(customRunsDir.trim());
  }
  const envAnimusRuns = process.env.ANIMUS_RUNS_DIR;
  if (envAnimusRuns && envAnimusRuns.trim() !== "") {
    return resolve(envAnimusRuns.trim());
  }
  const envAnimusHome = process.env.ANIMUS_HOME;
  if (envAnimusHome && envAnimusHome.trim() !== "") {
    return join(resolve(envAnimusHome.trim()), "runs");
  }
  const envLegacyRuns = process.env.FACTORY_RUNS_DIR;
  if (envLegacyRuns && envLegacyRuns.trim() !== "") {
    return resolve(envLegacyRuns.trim());
  }
  return join(resolveAnimusHome(), "runs");
}

/**
 * Resolves the directory for scheduler, daemon, and audit logs (~/.animus/logs).
 */
export function resolveAnimusLogsDir(customLogsDir?: string): string {
  if (customLogsDir && customLogsDir.trim() !== "") {
    return resolve(customLogsDir.trim());
  }
  const envLogs = process.env.ANIMUS_LOGS_DIR;
  if (envLogs && envLogs.trim() !== "") {
    return resolve(envLogs.trim());
  }
  const envAnimusHome = process.env.ANIMUS_HOME;
  if (envAnimusHome && envAnimusHome.trim() !== "") {
    return join(resolve(envAnimusHome.trim()), "logs");
  }
  const envLegacyLogs = process.env.FACTORY_LOGS_DIR;
  if (envLegacyLogs && envLegacyLogs.trim() !== "") {
    return resolve(envLegacyLogs.trim());
  }
  return join(resolveAnimusHome(), "logs");
}

/**
 * Resolves the directory for advisory concurrency and issue locks (~/.animus/locks).
 */
export function resolveAnimusLocksDir(customLocksDir?: string): string {
  if (customLocksDir && customLocksDir.trim() !== "") {
    return resolve(customLocksDir.trim());
  }
  const envLocks = process.env.ANIMUS_LOCKS_DIR;
  if (envLocks && envLocks.trim() !== "") {
    return resolve(envLocks.trim());
  }
  const envAnimusHome = process.env.ANIMUS_HOME;
  if (envAnimusHome && envAnimusHome.trim() !== "") {
    return join(resolve(envAnimusHome.trim()), "locks");
  }
  const envLegacyLocks = process.env.FACTORY_LOCKS_DIR;
  if (envLegacyLocks && envLegacyLocks.trim() !== "") {
    return resolve(envLegacyLocks.trim());
  }
  return join(resolveAnimusHome(), "locks");
}

/**
 * Resolves the directory for downloaded workflow packs and git object cache (~/.animus/cache).
 */
export function resolveAnimusCacheDir(customCacheDir?: string): string {
  if (customCacheDir && customCacheDir.trim() !== "") {
    return resolve(customCacheDir.trim());
  }
  const envCache = process.env.ANIMUS_CACHE_DIR;
  if (envCache && envCache.trim() !== "") {
    return resolve(envCache.trim());
  }
  const envAnimusHome = process.env.ANIMUS_HOME;
  if (envAnimusHome && envAnimusHome.trim() !== "") {
    return join(resolve(envAnimusHome.trim()), "cache");
  }
  const envLegacyCache = process.env.FACTORY_CACHE_DIR;
  if (envLegacyCache && envLegacyCache.trim() !== "") {
    return resolve(envLegacyCache.trim());
  }
  return join(resolveAnimusHome(), "cache");
}

/**
 * Resolves the directory for isolated agent execution worktrees (~/.animus/worktrees).
 */
export function resolveAnimusWorktreesDir(customWorktreesDir?: string): string {
  if (customWorktreesDir && customWorktreesDir.trim() !== "") {
    return resolve(customWorktreesDir.trim());
  }
  const envWorktrees = process.env.ANIMUS_WORKTREES_DIR;
  if (envWorktrees && envWorktrees.trim() !== "") {
    return resolve(envWorktrees.trim());
  }
  const envAnimusHome = process.env.ANIMUS_HOME;
  if (envAnimusHome && envAnimusHome.trim() !== "") {
    return join(resolve(envAnimusHome.trim()), "worktrees");
  }
  const envLegacyWorktrees = process.env.FACTORY_WORKTREES_DIR;
  if (envLegacyWorktrees && envLegacyWorktrees.trim() !== "") {
    return resolve(envLegacyWorktrees.trim());
  }
  return join(resolveAnimusHome(), "worktrees");
}

/**
 * Resolves the directory for installed binaries (~/.animus/bin).
 */
export function resolveAnimusBinDir(customBinDir?: string): string {
  if (customBinDir && customBinDir.trim() !== "") {
    return resolve(customBinDir.trim());
  }
  const envBin = process.env.ANIMUS_BIN_DIR;
  if (envBin && envBin.trim() !== "") {
    return resolve(envBin.trim());
  }
  const envInstall = process.env.ANIMUS_INSTALL_DIR;
  if (envInstall && envInstall.trim() !== "") {
    return resolve(envInstall.trim());
  }
  const envAnimusHome = process.env.ANIMUS_HOME;
  if (envAnimusHome && envAnimusHome.trim() !== "") {
    return join(resolve(envAnimusHome.trim()), "bin");
  }
  return join(resolveAnimusHome(), "bin");
}

/**
 * Produces a deterministic, collision-free, filesystem-safe slug for a project repository path.
 * Format: `<sanitized-dirname>-<sha256[:8]>` (e.g. `animus-a19f3b2c`).
 */
export function getProjectSlug(checkoutPath: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(checkoutPath);
  } catch {
    canonical = resolve(checkoutPath);
  }

  const rawBase = basename(canonical);
  const name =
    rawBase
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

/**
 * Returns the scoped runs directory for a specific project checkout.
 * Example: `~/.animus/runs/animus-a19f3b2c`
 */
export function getProjectRunsDir(checkoutPath: string, customRunsDir?: string): string {
  if (customRunsDir && customRunsDir.trim() !== "") {
    return join(resolveAnimusRunsDir(customRunsDir), getProjectSlug(checkoutPath));
  }
  return resolveProjectWorkspace(checkoutPath).runsDir;
}

/**
 * Returns the scoped worktree directory for a specific project checkout.
 * Example: `~/.animus/worktrees/animus-a19f3b2c`
 */
export function getProjectWorktreesDir(checkoutPath: string, customWorktreesDir?: string): string {
  if (customWorktreesDir && customWorktreesDir.trim() !== "") {
    return join(resolveAnimusWorktreesDir(customWorktreesDir), getProjectSlug(checkoutPath));
  }
  return resolveProjectWorkspace(checkoutPath).worktreesDir;
}

/**
 * Returns the path to the project-specific brake state file (replaces repo STOP/PAUSE).
 * Example: `~/.animus/state/brakes/animus-a19f3b2c.json`
 */
export function getProjectBrakeStatePath(checkoutPath: string, customStateDir?: string): string {
  return join(
    resolveAnimusStateDir(customStateDir),
    "brakes",
    `${getProjectSlug(checkoutPath)}.json`,
  );
}

/**
 * Ensures a directory exists with strict private permissions (0o700: rwx------).
 * Fails closed or tightens permissions via chmodSync.
 */
export function ensureSecureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // If chmod fails due to filesystem restrictions (e.g. CIFS/FAT mounts), continue
  }
}

/**
 * Checks file permissions and enforces 0o600 (rw-------) for sensitive files (secrets, DBs).
 */
export function enforceSecureFilePermissions(filePath: string): void {
  if (!existsSync(filePath)) return;
  try {
    const mode = statSync(filePath).mode & 0o777;
    if (mode !== 0o600) {
      chmodSync(filePath, 0o600);
    }
  } catch {
    // Filesystem limitations
  }
}

/**
 * Transparent migration helper: if legacy ~/.factory/state exists and target ~/.animus/state does not,
 * copies legacy database and session secret files to the new ~/.animus location.
 */
export function migrateLegacyState(
  targetStateDir?: string,
  sourceStateDir?: string,
): { migrated: string[]; errors: string[] } {
  const targetDir = resolveAnimusStateDir(targetStateDir);
  const sourceDir = sourceStateDir ? resolve(sourceStateDir) : join(homedir(), ".factory", "state");

  const migrated: string[] = [];
  const errors: string[] = [];

  if (!existsSync(sourceDir)) {
    return { migrated, errors };
  }

  ensureSecureDirectory(targetDir);

  const filesToMigrate = ["console.db", "console.db-wal", "console.db-shm", "session.secret"];

  for (const file of filesToMigrate) {
    const src = join(sourceDir, file);
    const dest = join(targetDir, file);

    if (existsSync(src) && !existsSync(dest)) {
      try {
        copyFileSync(src, dest);
        enforceSecureFilePermissions(dest);
        migrated.push(file);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to migrate ${file}: ${msg}`);
      }
    }
  }

  return { migrated, errors };
}

function canonicalizePath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    let curr = resolve(targetPath);
    const parts: string[] = [];
    while (!existsSync(curr) && curr !== "/" && curr !== ".") {
      parts.unshift(basename(curr));
      curr = dirname(curr);
    }
    try {
      const canonicalParent = realpathSync(curr);
      return join(canonicalParent, ...parts);
    } catch {
      return resolve(targetPath);
    }
  }
}

/**
 * Checks whether stateRoot is strictly outside the checkout root.
 */
export function isStateRootOutsideCheckout(root: string, stateRoot: string): boolean {
  const canonicalRoot = canonicalizePath(root);
  const canonicalStateRoot = canonicalizePath(stateRoot);

  const rootPrefix = canonicalRoot.endsWith("/") ? canonicalRoot : canonicalRoot + "/";
  return canonicalStateRoot !== canonicalRoot && !canonicalStateRoot.startsWith(rootPrefix);
}

/**
 * Resolves the canonical absolute path of the Git common directory for a repository or worktree.
 * For primary checkouts, this is <repo>/.git.
 * For linked worktrees, git rev-parse --git-common-dir points to the primary checkout's .git directory.
 * Across all linked worktrees of the same repository, this returns the exact same canonical path.
 */
export function resolveCanonicalGitCommon(root: string): string {
  try {
    const gitRes = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (gitRes.status === 0 && gitRes.stdout) {
      const raw = gitRes.stdout.trim();
      const resolved = resolve(root, raw);
      try {
        return realpathSync(resolved);
      } catch {
        return resolved;
      }
    }
  } catch {}

  const dotGit = join(root, ".git");
  if (existsSync(dotGit)) {
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) {
        try {
          return realpathSync(dotGit);
        } catch {
          return resolve(dotGit);
        }
      } else if (st.isFile()) {
        const content = readFileSync(dotGit, "utf8").trim();
        if (content.startsWith("gitdir:")) {
          const gitDirTarget = resolve(root, content.slice(7).trim());
          const commondirFile = join(gitDirTarget, "commondir");
          if (existsSync(commondirFile)) {
            const commonTarget = resolve(gitDirTarget, readFileSync(commondirFile, "utf8").trim());
            try {
              return realpathSync(commonTarget);
            } catch {
              return commonTarget;
            }
          }
          try {
            return realpathSync(gitDirTarget);
          } catch {
            return gitDirTarget;
          }
        }
      }
    } catch {}
  }

  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * Computes a stable identifier hash for the canonical Git common directory.
 */
export function computeGitCommonHash(canonicalCommon: string): string {
  return createHash("sha256").update(canonicalCommon).digest("hex");
}

/**
 * Resolves a canonical per-repo TRIAGE STATE ONLY directory outside the checkout.
 *
 * Rules:
 * 1. Explicit caller stateRoot outside checkout root is accepted and returned directly.
 * 2. If caller stateRoot is inside checkout root or omitted, derives a separate triageRoot
 *    in the external OS state directory.
 * 3. The derived triageRoot is keyed by the SHA-256 hash of the canonical Git common directory.
 */
export function resolveTriageStateRoot(
  root: string,
  callerStateRoot?: string,
  customExternalStateDir?: string,
): string {
  if (callerStateRoot && callerStateRoot.trim() !== "") {
    if (isStateRootOutsideCheckout(root, callerStateRoot)) {
      return resolve(callerStateRoot.trim());
    }
  }

  const canonicalCommon = resolveCanonicalGitCommon(root);
  const hash = computeGitCommonHash(canonicalCommon);
  const baseStateDir = resolveAnimusStateDir(customExternalStateDir);
  return join(baseStateDir, "triage", hash);
}

/**
 * Resolves the canonical ProjectWorkspace for a repository or worktree.
 * Standardizes state root resolution onto a single canonical rule:
 * 1. Explicit caller override when outside checkout root
 * 2. When ANIMUS_HOME, ANIMUS_STATE_DIR, or ANIMUS_RUNS_DIR is set: ~/.animus/projects/<projectSlug>
 * 3. Default local-loop location: <canonicalGitCommon>/factory-local-loop
 */
export function resolveProjectWorkspace(
  root: string,
  options?: ProjectWorkspaceOptions,
): ProjectWorkspace {
  const canonicalRoot = resolve(root);
  const canonicalGitCommon = resolveCanonicalGitCommon(canonicalRoot);
  const gitCommonHash = computeGitCommonHash(canonicalGitCommon);
  let primaryRoot: string;
  if (basename(canonicalGitCommon) === ".git" || canonicalGitCommon.endsWith(".git")) {
    primaryRoot = dirname(canonicalGitCommon);
  } else {
    primaryRoot = canonicalRoot;
  }
  try {
    primaryRoot = realpathSync(primaryRoot);
  } catch {}

  const projectSlug = getProjectSlug(canonicalRoot);

  const isExternalState = Boolean(
    options?.customHome ||
    options?.customStateDir ||
    options?.customRunsDir ||
    options?.customWorktreesDir ||
    (process.env.ANIMUS_HOME && process.env.ANIMUS_HOME.trim() !== "") ||
    (process.env.ANIMUS_STATE_DIR && process.env.ANIMUS_STATE_DIR.trim() !== "") ||
    (process.env.ANIMUS_RUNS_DIR && process.env.ANIMUS_RUNS_DIR.trim() !== "") ||
    (process.env.ANIMUS_WORKTREES_DIR && process.env.ANIMUS_WORKTREES_DIR.trim() !== "") ||
    (process.env.FACTORY_HOME && process.env.FACTORY_HOME.trim() !== "") ||
    (process.env.FACTORY_STATE_DIR && process.env.FACTORY_STATE_DIR.trim() !== "") ||
    (process.env.FACTORY_RUNS_DIR && process.env.FACTORY_RUNS_DIR.trim() !== ""),
  );

  let stateRoot: string;
  if (options?.stateRoot && options.stateRoot.trim() !== "") {
    if (isStateRootOutsideCheckout(canonicalRoot, options.stateRoot)) {
      stateRoot = resolve(options.stateRoot.trim());
    } else if (isExternalState) {
      const home = resolveAnimusHome(options?.customHome);
      stateRoot = join(home, "projects", projectSlug);
    } else {
      stateRoot = join(canonicalGitCommon, "factory-local-loop");
    }
  } else if (isExternalState) {
    const home = resolveAnimusHome(options?.customHome);
    stateRoot = join(home, "projects", projectSlug);
  } else {
    stateRoot = join(canonicalGitCommon, "factory-local-loop");
  }

  const runsDir = options?.customRunsDir ? resolve(options.customRunsDir) : join(stateRoot, "runs");
  const worktreesDir = options?.customWorktreesDir
    ? resolve(options.customWorktreesDir)
    : join(stateRoot, "worktrees");
  const locksDir = join(stateRoot, "locks");
  const dossiersDir = join(stateRoot, "dossiers");
  const triageStateRoot = resolveTriageStateRoot(canonicalRoot, undefined, options?.customStateDir);

  const animusHome = resolveAnimusHome(options?.customHome);
  const legacyRunsDir = join(animusHome, "runs", projectSlug);
  const localCommonRunsDir = join(canonicalGitCommon, "factory-local-loop", "runs");
  const primaryDotRunsDir = join(primaryRoot, ".factory-local-loop", "runs");

  const fallbackRunsDirs: string[] = [];
  if (legacyRunsDir !== runsDir && !fallbackRunsDirs.includes(legacyRunsDir)) {
    fallbackRunsDirs.push(legacyRunsDir);
  }
  if (localCommonRunsDir !== runsDir && !fallbackRunsDirs.includes(localCommonRunsDir)) {
    fallbackRunsDirs.push(localCommonRunsDir);
  }
  if (primaryDotRunsDir !== runsDir && !fallbackRunsDirs.includes(primaryDotRunsDir)) {
    fallbackRunsDirs.push(primaryDotRunsDir);
  }

  return {
    root: canonicalRoot,
    canonicalGitCommon,
    gitCommonHash,
    primaryRoot,
    projectSlug,
    stateRoot,
    runsDir,
    worktreesDir,
    locksDir,
    dossiersDir,
    triageStateRoot,
    isExternalState,
    fallbackRunsDirs,
  };
}

/**
 * Searches across canonical runsDir and fallback legacy runs directories for a matching run directory.
 */
export function findWorkspaceRunDirectory(
  workspace: ProjectWorkspace,
  options: { runId?: string; issue?: number },
): string {
  const candidateDirs = [workspace.runsDir, ...workspace.fallbackRunsDirs];

  if (options.runId) {
    for (const runsDir of candidateDirs) {
      const direct = join(runsDir, options.runId);
      if (existsSync(direct)) return direct;
    }
  }

  for (const runsDir of candidateDirs) {
    if (!existsSync(runsDir)) continue;
    try {
      const entries = readdirSync(runsDir);
      for (const entry of entries) {
        const runPath = join(runsDir, entry);
        const stateFile = join(runPath, "state.json");
        if (existsSync(stateFile)) {
          try {
            const state = JSON.parse(readFileSync(stateFile, "utf-8"));
            if (options.runId && (state.runId === options.runId || entry === options.runId)) {
              return runPath;
            }
            if (options.issue !== undefined) {
              const issueStr = String(options.issue);
              if (
                String(state.issue).match(/\/issues\/(\d+)\/?$/)?.[1] === issueStr ||
                String(state.issue) === issueStr ||
                state.issue === `#${issueStr}` ||
                state.branch?.includes(`issue-${issueStr}`)
              ) {
                return runPath;
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  throw new Error(
    `No run matching ${options.runId ? `runId '${options.runId}'` : `issue #${options.issue}`} found in ${workspace.runsDir}`,
  );
}

/**
 * Checks filesystem Brake markers (.factory/STOP and .factory/PAUSE) across checkout root,
 * primary worktree root, and Git common roots.
 */
export function checkWorkspaceBrakes(
  workspaceOrRoot: ProjectWorkspace | string,
  sharedRoot?: string,
): WorkspaceBrakeCheckResult {
  const ws =
    typeof workspaceOrRoot === "string"
      ? resolveProjectWorkspace(workspaceOrRoot)
      : workspaceOrRoot;

  const rootsToCheck = new Set<string>();
  rootsToCheck.add(ws.root);
  rootsToCheck.add(ws.primaryRoot);
  if (sharedRoot) rootsToCheck.add(sharedRoot);
  rootsToCheck.add(ws.canonicalGitCommon);
  rootsToCheck.add(dirname(ws.canonicalGitCommon));

  let stopPath: string | undefined;
  let pausePath: string | undefined;

  for (const dir of rootsToCheck) {
    const s = join(dir, ".factory", "STOP");
    if (!stopPath && existsSync(s)) stopPath = s;
    const p = join(dir, ".factory", "PAUSE");
    if (!pausePath && existsSync(p)) pausePath = p;
  }

  const halted = Boolean(stopPath);
  const paused = Boolean(pausePath);
  const active = halted || paused;
  let active_brake: "none" | "stop" | "pause" | "both" = "none";
  let type: "stop" | "pause" | "both" | undefined;

  if (halted && paused) {
    active_brake = "both";
    type = "both";
  } else if (halted) {
    active_brake = "stop";
    type = "stop";
  } else if (paused) {
    active_brake = "pause";
    type = "pause";
  }

  return {
    active,
    halted,
    paused,
    active_brake,
    type,
    path: stopPath ?? pausePath,
    paths: {
      stop: stopPath,
      pause: pausePath,
    },
  };
}

/**
 * Backward-compatible wrapper for checkWorkspaceBrakes.
 */
export function checkBrakes(
  root: string,
  sharedRoot?: string,
): { active: boolean; type?: "stop" | "pause"; path?: string } {
  const result = checkWorkspaceBrakes(root, sharedRoot);
  return {
    active: result.active,
    type: result.type === "both" ? "stop" : result.type,
    path: result.path,
  };
}

/**
 * Mutates filesystem Brake markers (.factory/STOP and .factory/PAUSE) in primary worktree.
 */
export function mutateWorkspaceBrakes(
  workspaceOrRoot: ProjectWorkspace | string,
  action: ControlAction,
): WorkspaceBrakeCheckResult {
  const ws =
    typeof workspaceOrRoot === "string"
      ? resolveProjectWorkspace(workspaceOrRoot)
      : workspaceOrRoot;

  const primaryFactoryDir = join(ws.primaryRoot, ".factory");
  if (!existsSync(primaryFactoryDir)) {
    try {
      mkdirSync(primaryFactoryDir, { recursive: true });
    } catch {}
  }
  const stopPath = join(primaryFactoryDir, "STOP");
  const pausePath = join(primaryFactoryDir, "PAUSE");
  const localStopPath = join(ws.root, ".factory", "STOP");
  const localPausePath = join(ws.root, ".factory", "PAUSE");

  switch (action) {
    case "halt":
      if (!existsSync(stopPath)) {
        writeFileSync(stopPath, `Halted by operator at ${new Date().toISOString()}\n`);
      }
      break;
    case "unhalt":
      if (existsSync(stopPath)) {
        try {
          unlinkSync(stopPath);
        } catch {}
      }
      if (existsSync(localStopPath)) {
        try {
          unlinkSync(localStopPath);
        } catch {}
      }
      break;
    case "pause":
      if (!existsSync(pausePath)) {
        writeFileSync(pausePath, `Paused by operator at ${new Date().toISOString()}\n`);
      }
      break;
    case "unpause":
      if (existsSync(pausePath)) {
        try {
          unlinkSync(pausePath);
        } catch {}
      }
      if (existsSync(localPausePath)) {
        try {
          unlinkSync(localPausePath);
        } catch {}
      }
      break;
    default:
      throw new Error(`Invalid control action: ${String(action)}`);
  }

  return checkWorkspaceBrakes(ws);
}

/**
 * Parses and strictly validates a schedule.json configuration file.
 */
export function parseScheduleJson(filePath: string): Partial<ScheduleConfig> | null {
  if (!existsSync(filePath)) return null;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err: any) {
    throw new Error(
      `Malformed schedule config in '${filePath}': ${err?.message || "invalid JSON"}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid schedule config in '${filePath}': expected an object`);
  }

  if (
    raw.interval_seconds !== undefined &&
    (!Number.isFinite(raw.interval_seconds) || raw.interval_seconds <= 0)
  ) {
    throw new Error(`Invalid schedule interval in '${filePath}': must be a positive number`);
  }
  if (raw.parallel !== undefined && (!Number.isSafeInteger(raw.parallel) || raw.parallel <= 0)) {
    throw new Error(
      `Invalid schedule parallel capacity in '${filePath}': must be a positive integer`,
    );
  }
  if (raw.max_laps !== undefined && (!Number.isSafeInteger(raw.max_laps) || raw.max_laps <= 0)) {
    throw new Error(`Invalid schedule max_laps in '${filePath}': must be a positive integer`);
  }

  if (raw.work_window !== undefined && raw.work_window !== null) {
    if (typeof raw.work_window !== "object" || Array.isArray(raw.work_window)) {
      throw new Error(`Invalid schedule work_window in '${filePath}': expected an object`);
    }
    const window = raw.work_window;
    if (window.enabled) {
      if (
        typeof window.start_time !== "string" ||
        typeof window.end_time !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start_time) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.end_time)
      ) {
        throw new Error(
          `Invalid schedule work window times in '${filePath}': expected HH:MM format`,
        );
      }
      const tz = window.timezone || "Asia/Jakarta";
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
      } catch {
        throw new Error(`Invalid timezone in schedule config '${filePath}': '${tz}'`);
      }
    }
  }

  return {
    ...(typeof raw.workflow === "string" ? { workflow: raw.workflow } : {}),
    ...(typeof raw.parallel === "number" && raw.parallel > 0 ? { parallel: raw.parallel } : {}),
    ...(typeof raw.max_laps === "number" && raw.max_laps > 0 ? { max_laps: raw.max_laps } : {}),
    ...(typeof raw.interval_seconds === "number" && raw.interval_seconds > 0
      ? { interval_seconds: raw.interval_seconds }
      : {}),
    ...(typeof raw.inputs === "object" && raw.inputs !== null ? { inputs: raw.inputs } : {}),
    ...(typeof raw.work_window === "object" && raw.work_window !== null
      ? {
          work_window: {
            enabled: Boolean(raw.work_window.enabled),
            start_time: raw.work_window.start_time || "20:00",
            end_time: raw.work_window.end_time || "05:00",
            timezone: raw.work_window.timezone || "Asia/Jakarta",
          },
        }
      : {}),
  };
}

/**
 * Loads cascaded schedule configuration with strict validation:
 * defaults -> repo .factory/schedule.json -> global ~/.animus/schedule.json -> project ~/.animus/projects/<slug>/schedule.json -> caller override
 */
export function loadCascadedScheduleConfig(
  workspaceOrRoot: ProjectWorkspace | string,
  override?: Partial<ScheduleConfig> | null,
): ScheduleConfig {
  const ws =
    typeof workspaceOrRoot === "string"
      ? resolveProjectWorkspace(workspaceOrRoot)
      : workspaceOrRoot;

  const defaults: ScheduleConfig = {
    workflow: "animus-loop",
    parallel: 1,
    max_laps: 3,
    interval_seconds: 300,
    inputs: { merge: "approve" },
    work_window: {
      enabled: false,
      start_time: "20:00",
      end_time: "05:00",
      timezone: "Asia/Jakarta",
    },
  };

  const repoSchedule =
    parseScheduleJson(join(ws.root, ".factory/schedule.json")) ??
    (ws.primaryRoot !== ws.root
      ? parseScheduleJson(join(ws.primaryRoot, ".factory/schedule.json"))
      : null);
  const userGlobal = parseScheduleJson(join(resolveAnimusHome(), "schedule.json"));
  const userProject = parseScheduleJson(
    join(resolveAnimusHome(), "projects", ws.projectSlug, "schedule.json"),
  );

  return {
    ...defaults,
    ...repoSchedule,
    ...userGlobal,
    ...userProject,
    ...override,
    inputs: {
      ...defaults.inputs,
      ...repoSchedule?.inputs,
      ...userGlobal?.inputs,
      ...userProject?.inputs,
      ...override?.inputs,
    },
    work_window: {
      enabled:
        override?.work_window?.enabled ??
        userProject?.work_window?.enabled ??
        userGlobal?.work_window?.enabled ??
        repoSchedule?.work_window?.enabled ??
        defaults.work_window!.enabled,
      start_time:
        override?.work_window?.start_time ??
        userProject?.work_window?.start_time ??
        userGlobal?.work_window?.start_time ??
        repoSchedule?.work_window?.start_time ??
        defaults.work_window!.start_time,
      end_time:
        override?.work_window?.end_time ??
        userProject?.work_window?.end_time ??
        userGlobal?.work_window?.end_time ??
        repoSchedule?.work_window?.end_time ??
        defaults.work_window!.end_time,
      timezone:
        override?.work_window?.timezone ??
        userProject?.work_window?.timezone ??
        userGlobal?.work_window?.timezone ??
        repoSchedule?.work_window?.timezone ??
        defaults.work_window!.timezone,
    },
  };
}

/**
 * Backward-compatible alias for loadCascadedScheduleConfig.
 */
export function loadScheduleConfig(root: string): ScheduleConfig {
  return loadCascadedScheduleConfig(root);
}

/**
 * Evaluates whether current or provided date is within the configured work window in its IANA timezone.
 * Handles normal daytime spans as well as overnight spans (e.g. 21:00 to 04:00).
 */
export function isWithinWorkWindow(window?: WorkWindowConfig, now = new Date()): boolean {
  if (!window || !window.enabled) return true;

  const tz = window.timezone || "Asia/Jakarta";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = window.start_time.split(":").map(Number);
  const [endH, endM] = window.end_time.split(":").map(Number);
  const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
  const endMinutes = (endH ?? 0) * 60 + (endM ?? 0);

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight window (e.g. 21:00 to 04:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * Canonical PID liveness verification.
 * Invariant: 'age never proves dead, EPERM alive, only ESRCH proves dead'.
 * Returns false only if pid is not a positive integer or process.kill(pid, 0) throws ESRCH.
 */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") {
      return false; // dead
    }
    // EPERM or other error indicates process exists in OS process table
    return true;
  }
}

export const isPidAlive = isProcessAlive;

/**
 * Counts active laps in runsDir, ignoring abandoned runs with dead PIDs.
 */
export function countActiveLaps(runsDir: string): number {
  if (!existsSync(runsDir)) return 0;
  let active = 0;
  try {
    for (const entry of readdirSync(runsDir)) {
      const statePath = join(runsDir, entry, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        if (
          state.status === "preparing" ||
          state.status === "building" ||
          state.status === "checking" ||
          state.status === "qa" ||
          state.status === "reviewing" ||
          state.status === "reflecting"
        ) {
          if (typeof state.pid === "number" && !isProcessAlive(state.pid)) {
            continue;
          }
          active++;
        }
      } catch {}
    }
  } catch {}
  return active;
}

/**
 * Returns issue numbers currently in waiting_approval status.
 */
export function getIssuesWaitingApproval(runsDir: string): Set<number> {
  const waiting = new Set<number>();
  if (!existsSync(runsDir)) return waiting;
  try {
    for (const entry of readdirSync(runsDir)) {
      const statePath = join(runsDir, entry, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        if (
          state.status === "waiting_approval" ||
          state.status === "interrupted" ||
          state.status === "needs_owner"
        ) {
          let num: number | undefined;
          if (typeof state.issue === "number") num = state.issue;
          else if (typeof state.issue === "string") {
            const m = state.issue.match(/\/issues\/(\d+)\/?$/) || state.issue.match(/^#?(\d+)$/);
            if (m?.[1]) num = Number(m[1]);
          }
          if (num && Number.isSafeInteger(num)) waiting.add(num);
        }
      } catch {}
    }
  } catch {}
  return waiting;
}

/**
 * Returns issue numbers currently in merged status.
 */
export function getMergedIssueNumbers(runsDir: string): Set<number> {
  const merged = new Set<number>();
  if (!existsSync(runsDir)) return merged;
  try {
    for (const entry of readdirSync(runsDir)) {
      const statePath = join(runsDir, entry, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        if (state.status === "merged") {
          let num: number | undefined;
          if (typeof state.issue === "number") num = state.issue;
          else if (typeof state.issue === "string") {
            const m = state.issue.match(/\/issues\/(\d+)\/?$/) || state.issue.match(/^#?(\d+)$/);
            if (m?.[1]) num = Number(m[1]);
          }
          if (num && Number.isSafeInteger(num)) merged.add(num);
        }
      } catch {}
    }
  } catch {}
  return merged;
}

/**
 * Evaluates operational readiness in a single unified preflight check:
 * 1. Filesystem Brakes (.factory/STOP and .factory/PAUSE across roots)
 * 2. SQLite BrakeService records (isLaunchPermitted / isScheduledLaunchPermitted)
 * 3. Cascaded schedule configuration with strict validation
 * 4. Work-window timezone evaluation (including overnight spans)
 * 5. Active Lap capacity via process-liveness inspection (kill(pid, 0))
 */
export function evaluateWorkspacePreflight(
  workspaceOrRoot: ProjectWorkspace | string,
  options?: WorkspacePreflightOptions,
): WorkspacePreflightResult {
  const workspace =
    typeof workspaceOrRoot === "string"
      ? resolveProjectWorkspace(workspaceOrRoot)
      : workspaceOrRoot;

  const schedule = loadCascadedScheduleConfig(workspace, options?.config);
  const activeLaps = countActiveLaps(workspace.runsDir);
  const maxParallel = schedule.parallel ?? 1;
  const availableSlots = Math.max(0, maxParallel - activeLaps);
  const hasCapacity = availableSlots > 0;

  // 1. Filesystem Brakes
  const fsBrakes = checkWorkspaceBrakes(workspace);
  if (fsBrakes.halted) {
    const detail = `STOP brake set at ${fsBrakes.paths.stop ?? "filesystem"}`;
    return {
      ok: false,
      status: "blocked",
      reason: "stop_brake_set",
      detail,
      workspace,
      brakes: {
        halted: true,
        paused: fsBrakes.paused,
        active_brake: fsBrakes.active_brake,
        filesystem: fsBrakes,
      },
      schedule,
      workWindow: { withinWindow: true },
      capacity: {
        activeLaps,
        maxParallel,
        availableSlots,
        hasCapacity,
      },
    };
  }

  const mode = options?.mode ?? "schedule";
  if (mode === "schedule" && fsBrakes.paused) {
    const detail = `PAUSE brake set at ${fsBrakes.paths.pause ?? "filesystem"}`;
    return {
      ok: false,
      status: "blocked",
      reason: "pause_brake_set",
      detail,
      workspace,
      brakes: {
        halted: false,
        paused: true,
        active_brake: fsBrakes.active_brake,
        filesystem: fsBrakes,
      },
      schedule,
      workWindow: { withinWindow: true },
      capacity: {
        activeLaps,
        maxParallel,
        availableSlots,
        hasCapacity,
      },
    };
  }

  // 2. Relational SQLite BrakeService
  let relationalBrakeResult: { permitted: boolean; reason?: string } | undefined;
  if (options?.brakes) {
    if (mode === "launch" && options.brakes.isLaunchPermitted) {
      relationalBrakeResult = options.brakes.isLaunchPermitted(options.projectId);
    } else if (options.brakes.isScheduledLaunchPermitted) {
      relationalBrakeResult = options.brakes.isScheduledLaunchPermitted(options.projectId);
    } else if (options.brakes.isLaunchPermitted) {
      relationalBrakeResult = options.brakes.isLaunchPermitted(options.projectId);
    }

    if (relationalBrakeResult && !relationalBrakeResult.permitted) {
      const reason =
        relationalBrakeResult.reason ??
        (mode === "launch" ? "launch_brake_set" : "schedule_paused");
      return {
        ok: false,
        status: "blocked",
        reason,
        detail: `Relational brake check refused launch: ${reason}`,
        workspace,
        brakes: {
          halted: fsBrakes.halted,
          paused: fsBrakes.paused,
          active_brake: fsBrakes.active_brake,
          filesystem: fsBrakes,
          relational: relationalBrakeResult,
        },
        schedule,
        workWindow: { withinWindow: true },
        capacity: {
          activeLaps,
          maxParallel,
          availableSlots,
          hasCapacity,
        },
      };
    }
  }

  // 3. Work Window (evaluated in schedule mode)
  let withinWindow = true;
  if (mode === "schedule") {
    withinWindow = isWithinWorkWindow(schedule.work_window, options?.now);
    if (!withinWindow) {
      return {
        ok: false,
        status: "blocked",
        reason: "outside_work_window",
        detail: `Current time is outside configured work window (${schedule.work_window?.start_time} - ${schedule.work_window?.end_time} ${schedule.work_window?.timezone})`,
        workspace,
        brakes: {
          halted: fsBrakes.halted,
          paused: fsBrakes.paused,
          active_brake: fsBrakes.active_brake,
          filesystem: fsBrakes,
          relational: relationalBrakeResult,
        },
        schedule,
        workWindow: { withinWindow: false, window: schedule.work_window },
        capacity: {
          activeLaps,
          maxParallel,
          availableSlots,
          hasCapacity,
        },
      };
    }
  }

  // 4. Active Lap Capacity
  if (!hasCapacity && !options?.ignoreCapacity) {
    return {
      ok: false,
      status: "held",
      reason: "capacity_full",
      detail: `Active laps (${activeLaps}) reached parallel limit (${maxParallel})`,
      workspace,
      brakes: {
        halted: fsBrakes.halted,
        paused: fsBrakes.paused,
        active_brake: fsBrakes.active_brake,
        filesystem: fsBrakes,
        relational: relationalBrakeResult,
      },
      schedule,
      workWindow: { withinWindow, window: schedule.work_window },
      capacity: {
        activeLaps,
        maxParallel,
        availableSlots,
        hasCapacity: false,
      },
    };
  }

  return {
    ok: true,
    status: "ready",
    workspace,
    brakes: {
      halted: fsBrakes.halted,
      paused: fsBrakes.paused,
      active_brake: fsBrakes.active_brake,
      filesystem: fsBrakes,
      relational: relationalBrakeResult,
    },
    schedule,
    workWindow: { withinWindow, window: schedule.work_window },
    capacity: {
      activeLaps,
      maxParallel,
      availableSlots,
      hasCapacity,
    },
  };
}

/**
 * Asserts operational readiness, throwing an Error if any preflight condition fails.
 */
export function assertOperationalReadiness(
  workspaceOrRoot: ProjectWorkspace | string,
  options?: WorkspacePreflightOptions,
): WorkspacePreflightResult {
  const preflight = evaluateWorkspacePreflight(workspaceOrRoot, options);
  if (!preflight.ok) {
    const msg = preflight.reason
      ? `${preflight.reason}${preflight.detail ? `: ${preflight.detail}` : ""}`
      : preflight.detail || "operational_readiness_failed";
    const error = new Error(msg);
    (error as any).code = preflight.reason;
    (error as any).preflight = preflight;
    throw error;
  }
  return preflight;
}
