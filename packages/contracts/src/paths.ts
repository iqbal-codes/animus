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
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mergeYamlFile, readYamlObject, removeFileIfExists } from "./config-file";
import { readProjectSchedule, readRepoSchedule } from "./repo-config";
import {
  normalizeScheduleBlock,
  type ScheduleConfig,
  type ScheduleLayer,
  type WorkWindowConfig,
} from "./schedule-config";

export type { ScheduleConfig, WorkWindowConfig } from "./schedule-config";
/** Serialize owner inspection and replacement; abandoned guards require operator recovery. */
export async function withLockMutation<T>(lock: string, mutate: () => T): Promise<T> {
  const guard = `${lock}.mutex`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(guard);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
    }
  }
  try {
    return mutate();
  } finally {
    rmSync(guard, { recursive: true });
  }
}

/**
 * Synchronous, non-blocking sibling of {@link withLockMutation} for synchronous
 * callers such as the authority marker lock. It uses the same atomic `mkdir`
 * guard and fail-closed contract, but never blocks the event loop: if the guard
 * is already held it throws immediately so the caller fails fast and retries.
 * This is deliberate — lock contention must not block Node/Bun's event loop, and
 * force-reclaiming the guard would repeat the stale-owner race it serializes.
 */
export function withLockMutationSync<T>(lock: string, mutate: () => T): T {
  const guard = `${lock}.mutex`;
  mkdirSync(guard);
  try {
    return mutate();
  } finally {
    try {
      rmSync(guard, { recursive: true, force: true });
    } catch {}
  }
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
 * Resolves the directory for machine-level canonical agent skills (~/.animus/skills).
 */
export function resolveAnimusSkillsHome(customHome?: string): string {
  const envSkills = process.env.ANIMUS_SKILLS_HOME;
  if (envSkills && envSkills.trim() !== "") {
    return resolve(envSkills.trim());
  }
  return join(resolveAnimusHome(customHome), "skills");
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
  const animusDotRunsDir = join(primaryRoot, ".animus-local-loop", "runs");
  const primaryDotRunsDir = existsSync(animusDotRunsDir)
    ? animusDotRunsDir
    : join(primaryRoot, ".factory-local-loop", "runs");

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
 * Issue lookup selects the newest state-file mtime within the first matching directory,
 * breaking timestamp ties by path. Canonical storage takes precedence over legacy storage.
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
      let newest: { path: string; modified: number } | undefined;
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
                const modified = statSync(stateFile).mtimeMs;
                if (
                  !newest ||
                  modified > newest.modified ||
                  (modified === newest.modified && runPath < newest.path)
                ) {
                  newest = { path: runPath, modified };
                }
              }
            }
          } catch {}
        }
      }
      if (newest) return newest.path;
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
    const animusStop = join(dir, ".animus", "STOP");
    const factoryStop = join(dir, ".factory", "STOP");
    if (!stopPath) {
      if (existsSync(animusStop)) stopPath = animusStop;
      else if (existsSync(factoryStop)) stopPath = factoryStop;
    }

    const animusPause = join(dir, ".animus", "PAUSE");
    const factoryPause = join(dir, ".factory", "PAUSE");
    if (!pausePath) {
      if (existsSync(animusPause)) pausePath = animusPause;
      else if (existsSync(factoryPause)) pausePath = factoryPause;
    }
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

  const primaryAnimusDir = join(ws.primaryRoot, ".animus");
  if (!existsSync(primaryAnimusDir)) {
    try {
      mkdirSync(primaryAnimusDir, { recursive: true });
    } catch {}
  }
  const stopPath = join(primaryAnimusDir, "STOP");
  const pausePath = join(primaryAnimusDir, "PAUSE");
  const legacyStopPath = join(ws.primaryRoot, ".factory", "STOP");
  const legacyPausePath = join(ws.primaryRoot, ".factory", "PAUSE");
  const localStopPath = join(ws.root, ".animus", "STOP");
  const localPausePath = join(ws.root, ".animus", "PAUSE");
  const localLegacyStopPath = join(ws.root, ".factory", "STOP");
  const localLegacyPausePath = join(ws.root, ".factory", "PAUSE");

  switch (action) {
    case "halt":
      if (!existsSync(stopPath)) {
        writeFileSync(stopPath, `Halted by operator at ${new Date().toISOString()}\n`);
      }
      break;
    case "unhalt":
      for (const p of [stopPath, legacyStopPath, localStopPath, localLegacyStopPath]) {
        if (existsSync(p)) {
          try {
            unlinkSync(p);
          } catch {}
        }
      }
      break;
    case "pause":
      if (!existsSync(pausePath)) {
        writeFileSync(pausePath, `Paused by operator at ${new Date().toISOString()}\n`);
      }
      break;
    case "unpause":
      for (const p of [pausePath, legacyPausePath, localPausePath, localLegacyPausePath]) {
        if (existsSync(p)) {
          try {
            unlinkSync(p);
          } catch {}
        }
      }
      break;
    default:
      throw new Error(`Invalid control action: ${String(action)}`);
  }

  return checkWorkspaceBrakes(ws);
}

/**
 * Reads a legacy `schedule.json` file and validates it with the shared
 * schedule schema. Kept for `.factory/schedule.json` and pre-migration user
 * overrides; the runtime policy itself now lives in each layer's `config.yaml`.
 */
export function parseScheduleJson(filePath: string): Partial<ScheduleConfig> | null {
  if (!existsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Malformed schedule config in '${filePath}': ${message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid schedule config in '${filePath}': expected an object`);
  }
  return normalizeScheduleBlock(raw, filePath) as Partial<ScheduleConfig> | null;
}

/**
 * Maps the machine policy block (`automation`) onto schedule keys.
 * `animus onboard` owns that block in `~/.animus/config.yaml`, so the cascade
 * and per-repository setup share one machine-wide source of truth.
 */
function machineLayerFromAutomation(automation: unknown): ScheduleLayer | null {
  if (typeof automation !== "object" || automation === null) return null;
  const policy = automation as Record<string, unknown>;

  const layer: ScheduleLayer = {};
  if (typeof policy.parallelJobs === "number" && policy.parallelJobs > 0) {
    layer.parallel = policy.parallelJobs;
  }
  if (typeof policy.maxLaps === "number" && policy.maxLaps > 0) {
    layer.max_laps = policy.maxLaps;
  }
  if (typeof policy.pollInterval === "number" && policy.pollInterval > 0) {
    layer.interval_seconds = policy.pollInterval;
  }

  const enabled = typeof policy.limitWorkWindow === "boolean" ? policy.limitWorkWindow : undefined;
  const start = typeof policy.startTime === "string" ? policy.startTime : undefined;
  const end = typeof policy.endTime === "string" ? policy.endTime : undefined;
  if (enabled !== undefined || start !== undefined || end !== undefined) {
    layer.work_window = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(start !== undefined ? { start_time: start } : {}),
      ...(end !== undefined ? { end_time: end } : {}),
    };
  }
  return Object.keys(layer).length > 0 ? layer : null;
}

/**
 * Reads the machine layer (`automation`) and the user-global override
 * (`schedule`) from the single home configuration file. A pre-existing
 * `~/.animus/schedule.json` is folded into that file on first read.
 */
function loadHomeScheduleLayers(): {
  machine: ScheduleLayer | null;
  override: ScheduleLayer | null;
} {
  const home = resolveAnimusHome();
  const configPath = join(home, "config.yaml");
  const raw = readYamlObject(configPath);
  const machine = raw ? machineLayerFromAutomation(raw.automation) : null;

  if (raw && raw.schedule !== undefined) {
    return { machine, override: normalizeScheduleBlock(raw.schedule, configPath) };
  }

  const legacyPath = join(home, "schedule.json");
  const legacy = parseScheduleJson(legacyPath);
  if (!legacy) return { machine, override: null };

  const guard = join(home, ".config-migration.lock");
  try {
    mkdirSync(guard);
    try {
      mergeYamlFile(configPath, { schedule: legacy }, { mode: 0o600 });
      removeFileIfExists(legacyPath);
    } finally {
      rmSync(guard, { recursive: true, force: true });
    }
  } catch {
    // Another process owns the migration or the home is read-only: the legacy
    // value still applies for this read.
  }
  return { machine, override: legacy };
}

function resolveRepoScheduleLayer(ws: ProjectWorkspace): ScheduleLayer | null {
  const fromRoot = readRepoSchedule(ws.root);
  if (fromRoot) return fromRoot;

  const factorySchedule = parseScheduleJson(join(ws.root, ".factory/schedule.json"));
  if (factorySchedule) return factorySchedule as ScheduleLayer;

  if (ws.primaryRoot !== ws.root) {
    return (
      readRepoSchedule(ws.primaryRoot) ??
      (parseScheduleJson(join(ws.primaryRoot, ".factory/schedule.json")) as ScheduleLayer | null)
    );
  }
  return null;
}

/**
 * Loads cascaded schedule configuration with strict validation:
 * defaults -> machine policy (`automation` in ~/.animus/config.yaml) ->
 * repo `.animus/config.yaml` -> user-global `schedule` in ~/.animus/config.yaml ->
 * per-project `~/.animus/projects/<slug>/config.yaml` -> caller override.
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

  const home = loadHomeScheduleLayers();
  const userProject = readProjectSchedule(ws.projectSlug, resolveAnimusHome());

  let layer: ScheduleLayer = defaults;
  for (const next of [
    home.machine,
    resolveRepoScheduleLayer(ws),
    home.override,
    userProject,
    (override ?? null) as ScheduleLayer | null,
  ]) {
    if (!next) continue;
    layer = {
      ...layer,
      ...next,
      inputs: { ...layer.inputs, ...next.inputs },
      work_window: { ...layer.work_window, ...next.work_window },
    };
  }
  return layer as ScheduleConfig;
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
export function isPidAlive(pid?: number | null): boolean {
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
          if (typeof state.pid === "number" && !isPidAlive(state.pid)) {
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
