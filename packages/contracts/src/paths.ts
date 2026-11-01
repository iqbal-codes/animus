import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

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
  return join(resolveAnimusRunsDir(customRunsDir), getProjectSlug(checkoutPath));
}

/**
 * Returns the scoped worktree directory for a specific project checkout.
 * Example: `~/.animus/worktrees/animus-a19f3b2c`
 */
export function getProjectWorktreesDir(checkoutPath: string, customWorktreesDir?: string): string {
  return join(resolveAnimusWorktreesDir(customWorktreesDir), getProjectSlug(checkoutPath));
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
