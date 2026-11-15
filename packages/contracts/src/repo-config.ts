import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mergeYamlFile, readYamlObject, removeFileIfExists } from "./config-file";
import { normalizeScheduleBlock, type ScheduleLayer } from "./schedule-config";

/**
 * Per-repository configuration (`<repo>/.animus/config.yaml`).
 *
 * One YAML file per layer holds both the model/role bindings and the runtime
 * `schedule:` block. The legacy `<repo>/.animus/schedule.json` is migrated on
 * first read — the file is rewritten with the block folded in and the legacy
 * file removed — so an existing checkout keeps working without running setup.
 *
 * Reads never fail because migration could not acquire the guard: they fall back
 * to merging the legacy block in memory and leave the files untouched, which is
 * safe for concurrent readers (monitor tick, board request, CLI) racing a writer.
 */

export interface RepoConfigFile {
  assistant?: string;
  assistants?: Record<string, Record<string, unknown>>;
  tiers?: Record<string, Record<string, unknown>>;
  aliases?: Record<string, Record<string, unknown>>;
  roles?: Record<string, unknown>;
  worktree?: Record<string, unknown>;
  loop?: Record<string, unknown>;
  concurrencyLimit?: number;
  releases?: Record<string, unknown>;
  schedule?: ScheduleLayer;
  [key: string]: unknown;
}

export function repoConfigPath(root: string): string {
  return join(root, ".animus", "config.yaml");
}

/** Legacy files that held the schedule before it moved into `config.yaml`. */
export function legacyRepoSchedulePaths(root: string): string[] {
  return [join(root, ".animus", "schedule.json"), join(root, ".factory", "schedule.json")];
}

export function projectConfigPath(projectSlug: string, home: string): string {
  return join(home, "state", "projects", projectSlug, "config.yaml");
}

export function legacyProjectConfigPath(projectSlug: string, home: string): string {
  return join(home, "projects", projectSlug, "config.yaml");
}

export function legacyProjectSchedulePath(projectSlug: string, home: string): string {
  return join(home, "state", "projects", projectSlug, "schedule.json");
}

export function legacyHomeProjectSchedulePath(projectSlug: string, home: string): string {
  return join(home, "projects", projectSlug, "schedule.json");
}

interface LegacySchedule {
  path: string;
  block: ScheduleLayer;
}

function readLegacySchedule(path: string): LegacySchedule | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Malformed schedule config in '${path}': ${message}`);
  }
  const block = normalizeScheduleBlock(raw, path);
  return block ? { path, block } : null;
}

/** Best-effort exclusive guard: on contention the caller keeps the in-memory result. */
function withMigrationGuard<T>(lockDir: string, mutate: () => T): T | null {
  try {
    mkdirSync(lockDir);
  } catch {
    return null;
  }
  try {
    try {
      return mutate();
    } catch {
      // A read-only or malformed destination must not make reads fail: the
      // caller still receives the merged in-memory view.
      return null;
    }
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Reads the repository configuration, migrating the legacy schedule file when
 * the mixed format is still on disk. Idempotent and safe to call from any code
 * path, including the monitor tick.
 */
export function readRepoConfig(root: string): RepoConfigFile {
  const path = repoConfigPath(root);
  const existing = (readYamlObject(path) ?? {}) as RepoConfigFile;
  const legacyPath = legacyRepoSchedulePaths(root).find((candidate) => existsSync(candidate));
  if (!legacyPath) return existing;

  const guard = join(root, ".animus", ".config-migration.lock");
  if (existing.schedule) {
    // Already migrated: only the stale file is left behind.
    withMigrationGuard(guard, () => removeFileIfExists(legacyPath));
    return existing;
  }

  const legacy = readLegacySchedule(legacyPath);
  if (!legacy) {
    withMigrationGuard(guard, () => removeFileIfExists(legacyPath));
    return existing;
  }

  // A concurrent writer may hold the guard: serve the merged view without writing.
  withMigrationGuard(guard, () => {
    mergeYamlFile(path, { schedule: legacy.block });
    removeFileIfExists(legacy.path);
    return true;
  });
  return { ...existing, schedule: legacy.block };
}

/**
 * Writes the repository configuration atomically and drops the legacy schedule
 * file. Unknown top-level keys and comments on keys we do not touch survive.
 */
export function writeRepoConfig(root: string, config: RepoConfigFile): string {
  const path = repoConfigPath(root);
  mkdirSync(join(root, ".animus"), { recursive: true });
  const patch = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  );
  mergeYamlFile(path, patch);
  for (const legacy of legacyRepoSchedulePaths(root)) removeFileIfExists(legacy);
  return path;
}

/** The schedule block of a repository layer, already validated. */
export function readRepoSchedule(root: string): ScheduleLayer | null {
  const config = readRepoConfig(root);
  if (config.schedule === undefined) return null;
  return normalizeScheduleBlock(config.schedule, repoConfigPath(root));
}

/** The schedule block of the per-project user layer (`~/.animus/state/projects/<slug>/config.yaml`). */
export function readProjectSchedule(projectSlug: string, home: string): ScheduleLayer | null {
  const path = projectConfigPath(projectSlug, home);
  const config = readYamlObject(path);
  if (config && config.schedule !== undefined) {
    return normalizeScheduleBlock(config.schedule, path);
  }

  const legacyConfig = readYamlObject(legacyProjectConfigPath(projectSlug, home));
  if (legacyConfig && legacyConfig.schedule !== undefined) {
    return normalizeScheduleBlock(
      legacyConfig.schedule,
      legacyProjectConfigPath(projectSlug, home),
    );
  }

  const legacy =
    (existsSync(legacyProjectSchedulePath(projectSlug, home))
      ? legacyProjectSchedulePath(projectSlug, home)
      : null) ??
    (existsSync(legacyHomeProjectSchedulePath(projectSlug, home))
      ? legacyHomeProjectSchedulePath(projectSlug, home)
      : null);
  if (!legacy) return null;

  const legacySchedule = readLegacySchedule(legacy);
  if (!legacySchedule) return null;

  const guard = join(home, "state", "projects", projectSlug, ".config-migration.lock");
  withMigrationGuard(guard, () => {
    mergeYamlFile(path, { schedule: legacySchedule.block });
    removeFileIfExists(legacy);
    return true;
  });
  return legacySchedule.block;
}
