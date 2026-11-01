import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  resolveAnimusHome,
  resolveAnimusStateDir,
  resolveAnimusRunsDir,
  resolveAnimusLogsDir,
  resolveAnimusLocksDir,
  resolveAnimusCacheDir,
  resolveAnimusWorktreesDir,
  resolveAnimusBinDir,
  getProjectSlug,
  getProjectRunsDir,
  getProjectWorktreesDir,
  getProjectBrakeStatePath,
  ensureSecureDirectory,
  enforceSecureFilePermissions,
  migrateLegacyState,
} from "@animus/contracts/paths";
import { loadScheduleConfig } from "../../scripts/loop/scheduler";

describe("Local Application State Paths (~/.animus/)", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "animus-paths-test-"));
    // Clear relevant environment variables
    delete process.env.ANIMUS_HOME;
    delete process.env.ANIMUS_STATE_DIR;
    delete process.env.ANIMUS_RUNS_DIR;
    delete process.env.ANIMUS_LOGS_DIR;
    delete process.env.ANIMUS_LOCKS_DIR;
    delete process.env.ANIMUS_CACHE_DIR;
    delete process.env.ANIMUS_WORKTREES_DIR;
    delete process.env.ANIMUS_BIN_DIR;
    delete process.env.ANIMUS_INSTALL_DIR;
    delete process.env.FACTORY_HOME;
    delete process.env.FACTORY_STATE_DIR;
    delete process.env.FACTORY_RUNS_DIR;
    delete process.env.FACTORY_LOGS_DIR;
    delete process.env.FACTORY_LOCKS_DIR;
    delete process.env.FACTORY_CACHE_DIR;
    delete process.env.FACTORY_WORKTREES_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("resolves default home path to ~/.animus", () => {
    const home = resolveAnimusHome();
    expect(home).toBe(join(homedir(), ".animus"));
  });

  test("ANIMUS_HOME environment variable overrides default home", () => {
    process.env.ANIMUS_HOME = join(tempDir, "custom-animus");
    expect(resolveAnimusHome()).toBe(join(tempDir, "custom-animus"));
    expect(resolveAnimusStateDir()).toBe(join(tempDir, "custom-animus", "state"));
    expect(resolveAnimusRunsDir()).toBe(join(tempDir, "custom-animus", "runs"));
    expect(resolveAnimusLogsDir()).toBe(join(tempDir, "custom-animus", "logs"));
    expect(resolveAnimusLocksDir()).toBe(join(tempDir, "custom-animus", "locks"));
    expect(resolveAnimusCacheDir()).toBe(join(tempDir, "custom-animus", "cache"));
    expect(resolveAnimusWorktreesDir()).toBe(join(tempDir, "custom-animus", "worktrees"));
    expect(resolveAnimusBinDir()).toBe(join(tempDir, "custom-animus", "bin"));
  });

  test("legacy FACTORY_HOME environment variable works as fallback", () => {
    process.env.FACTORY_HOME = join(tempDir, "legacy-factory");
    expect(resolveAnimusHome()).toBe(join(tempDir, "legacy-factory"));
  });

  test("specific environment variables take precedence over ANIMUS_HOME", () => {
    process.env.ANIMUS_HOME = join(tempDir, "animus-home");
    process.env.ANIMUS_STATE_DIR = join(tempDir, "explicit-state");
    process.env.ANIMUS_RUNS_DIR = join(tempDir, "explicit-runs");
    process.env.ANIMUS_LOGS_DIR = join(tempDir, "explicit-logs");
    process.env.ANIMUS_LOCKS_DIR = join(tempDir, "explicit-locks");

    expect(resolveAnimusStateDir()).toBe(join(tempDir, "explicit-state"));
    expect(resolveAnimusRunsDir()).toBe(join(tempDir, "explicit-runs"));
    expect(resolveAnimusLogsDir()).toBe(join(tempDir, "explicit-logs"));
    expect(resolveAnimusLocksDir()).toBe(join(tempDir, "explicit-locks"));
  });

  test("legacy FACTORY_STATE_DIR works as fallback", () => {
    process.env.FACTORY_STATE_DIR = join(tempDir, "legacy-state");
    expect(resolveAnimusStateDir()).toBe(join(tempDir, "legacy-state"));
  });

  test("explicit argument overrides all environment variables", () => {
    process.env.ANIMUS_HOME = join(tempDir, "env-home");
    process.env.ANIMUS_STATE_DIR = join(tempDir, "env-state");

    expect(resolveAnimusHome(join(tempDir, "arg-home"))).toBe(join(tempDir, "arg-home"));
    expect(resolveAnimusStateDir(join(tempDir, "arg-state"))).toBe(join(tempDir, "arg-state"));
  });

  test("generates deterministic and filesystem-safe project slugs", () => {
    const repoA = join(tempDir, "project-alpha");
    const repoB = join(tempDir, "project-beta");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });

    const slugA = getProjectSlug(repoA);
    const slugB = getProjectSlug(repoB);

    expect(slugA).toMatch(/^project-alpha-[a-f0-9]{8}$/);
    expect(slugB).toMatch(/^project-beta-[a-f0-9]{8}$/);
    expect(slugA).not.toBe(slugB);

    // Repeated calls on same path produce identical slug
    expect(getProjectSlug(repoA)).toBe(slugA);
  });

  test("scopes runs and worktrees to project slug", () => {
    const repoPath = join(tempDir, "animus");
    mkdirSync(repoPath, { recursive: true });
    const slug = getProjectSlug(repoPath);

    const runsDir = getProjectRunsDir(repoPath, join(tempDir, "runs"));
    const worktreesDir = getProjectWorktreesDir(repoPath, join(tempDir, "worktrees"));
    const brakePath = getProjectBrakeStatePath(repoPath, join(tempDir, "state"));

    expect(runsDir).toBe(join(tempDir, "runs", slug));
    expect(worktreesDir).toBe(join(tempDir, "worktrees", slug));
    expect(brakePath).toBe(join(tempDir, "state", "brakes", `${slug}.json`));
  });

  test("enforces 0o700 permissions on secure directories", () => {
    const secureDir = join(tempDir, "secure-state");
    ensureSecureDirectory(secureDir);

    expect(existsSync(secureDir)).toBe(true);
    const mode = statSync(secureDir).mode & 0o777;
    // On POSIX systems, check mode is 0o700
    if (process.platform !== "win32") {
      expect(mode).toBe(0o700);
    }
  });

  test("enforces 0o600 permissions on sensitive files", () => {
    const sensitiveFile = join(tempDir, "secret.key");
    writeFileSync(sensitiveFile, "super-secret-token", { mode: 0o644 });

    enforceSecureFilePermissions(sensitiveFile);
    if (process.platform !== "win32") {
      const mode = statSync(sensitiveFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("migrates legacy ~/.factory/state files transparently to ~/.animus/state", () => {
    const sourceDir = join(tempDir, "legacy-factory-state");
    const targetDir = join(tempDir, "animus-state");

    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "console.db"), "MOCK_DB_BYTES");
    writeFileSync(join(sourceDir, "session.secret"), "MOCK_SECRET_32_BYTES");

    const result = migrateLegacyState(targetDir, sourceDir);

    expect(result.errors).toEqual([]);
    expect(result.migrated).toContain("console.db");
    expect(result.migrated).toContain("session.secret");

    expect(existsSync(join(targetDir, "console.db"))).toBe(true);
    expect(existsSync(join(targetDir, "session.secret"))).toBe(true);
    expect(readFileSync(join(targetDir, "console.db"), "utf-8")).toBe("MOCK_DB_BYTES");

    // Second run should migrate nothing since destination already exists
    const secondResult = migrateLegacyState(targetDir, sourceDir);
    expect(secondResult.migrated).toEqual([]);
  });

  test("allows user-level ~/.animus/schedule.json to override repo schedule defaults", () => {
    const userAnimus = join(tempDir, "user-animus");
    process.env.ANIMUS_HOME = userAnimus;
    const repoPath = join(tempDir, "repo-schedule-test");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(repoPath, ".factory"), { recursive: true });

    // Repo defines team workflow and inputs
    writeFileSync(
      join(repoPath, ".factory/schedule.json"),
      JSON.stringify({ workflow: "team-workflow", parallel: 1 }),
    );

    // User defines personal work_window and local parallel capacity in ~/.animus/schedule.json
    mkdirSync(userAnimus, { recursive: true });
    writeFileSync(
      join(userAnimus, "schedule.json"),
      JSON.stringify({
        parallel: 4,
        work_window: {
          enabled: true,
          start_time: "21:00",
          end_time: "04:00",
          timezone: "Asia/Jakarta",
        },
      }),
    );

    const config = loadScheduleConfig(repoPath);
    expect(config.workflow).toBe("team-workflow"); // inherited from repo
    expect(config.parallel).toBe(4); // overridden by user home
    expect(config.work_window?.enabled).toBe(true); // overridden by user home
    expect(config.work_window?.start_time).toBe("21:00");
  });
});
