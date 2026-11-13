import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProjectWorkspace,
  evaluateWorkspacePreflight,
  assertOperationalReadiness,
  loadCascadedScheduleConfig,
  isWithinWorkWindow,
  countActiveLaps,
  getProjectSlug,
  type RelationalBrakeChecker,
} from "../../packages/contracts/src/paths";
import { resolveRunDirectory } from "../../scripts/loop/evidence-manager";

describe("Canonical ProjectWorkspace Resolution & Unified Preflight (Issue #142)", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let repoDir: string;
  let gitDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "animus-workspace-test-"));
    repoDir = join(tempDir, "test-repo");
    gitDir = join(repoDir, ".git");
    mkdirSync(gitDir, { recursive: true });

    delete process.env.ANIMUS_HOME;
    delete process.env.ANIMUS_STATE_DIR;
    delete process.env.ANIMUS_RUNS_DIR;
    delete process.env.ANIMUS_LOGS_DIR;
    delete process.env.ANIMUS_LOCKS_DIR;
    delete process.env.ANIMUS_CACHE_DIR;
    delete process.env.ANIMUS_WORKTREES_DIR;
    delete process.env.FACTORY_HOME;
    delete process.env.FACTORY_STATE_DIR;
    delete process.env.FACTORY_RUNS_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("AC1: Canonical ProjectWorkspace Resolver", () => {
    test("resolves default local-loop location when no external state is set", () => {
      const ws = resolveProjectWorkspace(repoDir);
      expect(ws.root).toBe(repoDir);
      expect(ws.stateRoot).toBe(join(ws.canonicalGitCommon, "factory-local-loop"));
      expect(ws.runsDir).toBe(join(ws.stateRoot, "runs"));
      expect(ws.worktreesDir).toBe(join(ws.stateRoot, "worktrees"));
      expect(ws.locksDir).toBe(join(ws.stateRoot, "locks"));
      expect(ws.dossiersDir).toBe(join(ws.stateRoot, "dossiers"));
      expect(ws.isExternalState).toBe(false);
      expect(ws.triageStateRoot).toContain(join(".animus", "state", "triage"));
      expect(ws.triageStateRoot).not.toContain(repoDir);
    });

    test("resolves external state ~/.animus/state/projects/<projectSlug> when ANIMUS_HOME is set", () => {
      const animusHome = join(tempDir, "custom-animus");
      process.env.ANIMUS_HOME = animusHome;
      const slug = getProjectSlug(repoDir);

      const ws = resolveProjectWorkspace(repoDir);
      expect(ws.stateRoot).toBe(join(animusHome, "state", "projects", slug));
      expect(ws.runsDir).toBe(join(ws.stateRoot, "runs"));
      expect(ws.worktreesDir).toBe(join(ws.stateRoot, "worktrees"));
      expect(ws.locksDir).toBe(join(ws.stateRoot, "locks"));
      expect(ws.dossiersDir).toBe(join(ws.stateRoot, "dossiers"));
      expect(ws.isExternalState).toBe(true);
      expect(ws.fallbackRunsDirs).toContain(join(animusHome, "projects", slug, "runs"));
      expect(ws.fallbackRunsDirs).toContain(join(animusHome, "runs", slug));
    });

    test("accepts explicit caller stateRoot outside checkout root", () => {
      const explicitState = join(tempDir, "outside-state");
      mkdirSync(explicitState, { recursive: true });

      const ws = resolveProjectWorkspace(repoDir, { stateRoot: explicitState });
      expect(ws.stateRoot).toBe(explicitState);
      expect(ws.runsDir).toBe(join(explicitState, "runs"));
    });

    test("ignores caller stateRoot inside checkout root and derives canonical stateRoot", () => {
      const insideState = join(repoDir, ".git", "inside-state");
      mkdirSync(insideState, { recursive: true });

      const ws = resolveProjectWorkspace(repoDir, { stateRoot: insideState });
      expect(ws.stateRoot).not.toBe(insideState);
      expect(ws.stateRoot).toBe(join(ws.canonicalGitCommon, "factory-local-loop"));
    });

    test("resolves linked worktree to identical canonicalGitCommon and triageStateRoot", () => {
      // Set up a linked worktree structure
      const wtDir = join(tempDir, "linked-wt");
      mkdirSync(wtDir, { recursive: true });
      const wtGitDir = join(gitDir, "worktrees", "linked-wt");
      mkdirSync(wtGitDir, { recursive: true });
      writeFileSync(join(wtDir, ".git"), `gitdir: ${wtGitDir}\n`);
      writeFileSync(join(wtGitDir, "gitdir"), `${join(wtDir, ".git")}\n`);
      writeFileSync(join(wtGitDir, "commondir"), "../../\n");

      const primaryWs = resolveProjectWorkspace(repoDir);
      const wtWs = resolveProjectWorkspace(wtDir);

      expect(wtWs.canonicalGitCommon).toBe(primaryWs.canonicalGitCommon);
      expect(wtWs.gitCommonHash).toBe(primaryWs.gitCommonHash);
      expect(wtWs.triageStateRoot).toBe(primaryWs.triageStateRoot);
      expect(wtWs.primaryRoot).toBe(primaryWs.primaryRoot);
    });
  });

  describe("AC2: Fallback Lookup for Existing Runs", () => {
    test("resolveRunDirectory locates runs in canonical runsDir and fallback directories", async () => {
      const animusHome = join(tempDir, "animus-home");
      process.env.ANIMUS_HOME = animusHome;
      const slug = getProjectSlug(repoDir);

      // Create a legacy run under <AnimusHome>/runs/<projectSlug>/run-legacy-1
      const legacyRunsDir = join(animusHome, "runs", slug);
      const legacyRunPath = join(legacyRunsDir, "run-legacy-1");
      mkdirSync(legacyRunPath, { recursive: true });
      writeFileSync(
        join(legacyRunPath, "state.json"),
        JSON.stringify({ runId: "run-legacy-1", issue: 42, status: "completed" }),
      );

      // Create a new run under <stateRoot>/runs/run-canonical-2
      const canonicalRunsDir = join(animusHome, "state", "projects", slug, "runs");
      const canonicalRunPath = join(canonicalRunsDir, "run-canonical-2");
      mkdirSync(canonicalRunPath, { recursive: true });
      writeFileSync(
        join(canonicalRunPath, "state.json"),
        JSON.stringify({ runId: "run-canonical-2", issue: 99, status: "completed" }),
      );

      // Both must be resolvable via resolveRunDirectory
      const foundCanonical = await resolveRunDirectory(repoDir, { runId: "run-canonical-2" });
      expect(foundCanonical).toBe(canonicalRunPath);

      const foundLegacy = await resolveRunDirectory(repoDir, { runId: "run-legacy-1" });
      expect(foundLegacy).toBe(legacyRunPath);

      // By issue number
      const foundByIssueCanonical = await resolveRunDirectory(repoDir, { issue: 99 });
      expect(foundByIssueCanonical).toBe(canonicalRunPath);

      const foundByIssueLegacy = await resolveRunDirectory(repoDir, { issue: 42 });
      expect(foundByIssueLegacy).toBe(legacyRunPath);
    });
  });

  describe("AC3: Operational Preflight (evaluateWorkspacePreflight / assertOperationalReadiness)", () => {
    test("returns ready when all preflight checks pass", () => {
      const preflight = evaluateWorkspacePreflight(repoDir);
      expect(preflight.ok).toBe(true);
      expect(preflight.status).toBe("ready");
      expect(preflight.brakes.halted).toBe(false);
      expect(preflight.brakes.paused).toBe(false);
      expect(preflight.workWindow.withinWindow).toBe(true);
      expect(preflight.capacity.hasCapacity).toBe(true);

      const asserted = assertOperationalReadiness(repoDir);
      expect(asserted.ok).toBe(true);
    });

    test("detects filesystem STOP brake in checkout root and blocks preflight", () => {
      mkdirSync(join(repoDir, ".animus"), { recursive: true });
      writeFileSync(join(repoDir, ".animus/STOP"), "Halted for maintenance\n");

      const preflight = evaluateWorkspacePreflight(repoDir);
      expect(preflight.ok).toBe(false);
      expect(preflight.status).toBe("blocked");
      expect(preflight.reason).toBe("stop_brake_set");
      expect(preflight.brakes.halted).toBe(true);
      expect(preflight.brakes.active_brake).toBe("stop");

      expect(() => assertOperationalReadiness(repoDir)).toThrow(/stop_brake_set/);
    });

    test("detects filesystem STOP brake in primary worktree root from linked worktree", () => {
      const wtDir = join(tempDir, "linked-wt-stop");
      mkdirSync(wtDir, { recursive: true });
      const wtGitDir = join(gitDir, "worktrees", "linked-wt-stop");
      mkdirSync(wtGitDir, { recursive: true });
      writeFileSync(join(wtDir, ".git"), `gitdir: ${wtGitDir}\n`);
      writeFileSync(join(wtGitDir, "gitdir"), `${join(wtDir, ".git")}\n`);
      writeFileSync(join(wtGitDir, "commondir"), "../../\n");

      // Place STOP in primary repo root
      mkdirSync(join(repoDir, ".animus"), { recursive: true });
      writeFileSync(join(repoDir, ".animus/STOP"), "Primary stop\n");

      const preflight = evaluateWorkspacePreflight(wtDir);
      expect(preflight.ok).toBe(false);
      expect(preflight.status).toBe("blocked");
      expect(preflight.reason).toBe("stop_brake_set");
      expect(preflight.brakes.halted).toBe(true);
    });

    test("detects filesystem PAUSE brake and blocks schedule ticks", () => {
      mkdirSync(join(repoDir, ".animus"), { recursive: true });
      writeFileSync(join(repoDir, ".animus/PAUSE"), "Paused\n");

      const schedulePreflight = evaluateWorkspacePreflight(repoDir, { mode: "schedule" });
      expect(schedulePreflight.ok).toBe(false);
      expect(schedulePreflight.status).toBe("blocked");
      expect(schedulePreflight.reason).toBe("pause_brake_set");
      expect(schedulePreflight.brakes.paused).toBe(true);

      // Direct launch mode is permitted despite PAUSE brake
      const launchPreflight = evaluateWorkspacePreflight(repoDir, { mode: "launch" });
      expect(launchPreflight.ok).toBe(true);
    });

    test("honors SQLite BrakeService records", () => {
      const mockBrakes: RelationalBrakeChecker = {
        isScheduledLaunchPermitted: () => ({ permitted: false, reason: "schedule_paused" }),
        isLaunchPermitted: () => ({ permitted: false, reason: "launch_brake_set" }),
      };

      const preflight = evaluateWorkspacePreflight(repoDir, { brakes: mockBrakes });
      expect(preflight.ok).toBe(false);
      expect(preflight.status).toBe("blocked");
      expect(preflight.reason).toBe("schedule_paused");

      const launchPreflight = evaluateWorkspacePreflight(repoDir, {
        brakes: mockBrakes,
        mode: "launch",
      });
      expect(launchPreflight.ok).toBe(false);
      expect(launchPreflight.reason).toBe("launch_brake_set");
    });

    test("evaluates work-window in IANA timezone, including overnight spans", () => {
      // Overnight window: 21:00 to 04:00 Asia/Jakarta (UTC+7)
      const window = {
        enabled: true,
        start_time: "21:00",
        end_time: "04:00",
        timezone: "Asia/Jakarta",
      };

      // 22:30 Jakarta time (15:30 UTC) -> should be inside
      const insideNight = new Date("2026-11-04T15:30:00Z");
      expect(isWithinWorkWindow(window, insideNight)).toBe(true);

      // 03:00 Jakarta time (20:00 UTC previous day) -> should be inside
      const insideMorning = new Date("2026-11-04T20:00:00Z");
      expect(isWithinWorkWindow(window, insideMorning)).toBe(true);

      // 12:00 noon Jakarta time (05:00 UTC) -> should be outside
      const outsideDay = new Date("2026-11-04T05:00:00Z");
      expect(isWithinWorkWindow(window, outsideDay)).toBe(false);

      // Preflight integration
      const preflightInside = evaluateWorkspacePreflight(repoDir, {
        config: { work_window: window },
        now: insideNight,
      });
      expect(preflightInside.ok).toBe(true);

      const preflightOutside = evaluateWorkspacePreflight(repoDir, {
        config: { work_window: window },
        now: outsideDay,
      });
      expect(preflightOutside.ok).toBe(false);
      expect(preflightOutside.reason).toBe("outside_work_window");
    });

    test("counts active laps with process-liveness check (kill(pid, 0)) and blocks on capacity_full", () => {
      const ws = resolveProjectWorkspace(repoDir);
      mkdirSync(ws.runsDir, { recursive: true });

      // Live PID (current test process)
      const liveRunDir = join(ws.runsDir, "live-run-1");
      mkdirSync(liveRunDir, { recursive: true });
      writeFileSync(
        join(liveRunDir, "state.json"),
        JSON.stringify({ pid: process.pid, status: "building" }),
      );

      // Dead PID (e.g. 9999999)
      const deadRunDir = join(ws.runsDir, "dead-run-2");
      mkdirSync(deadRunDir, { recursive: true });
      writeFileSync(
        join(deadRunDir, "state.json"),
        JSON.stringify({ pid: 9999999, status: "building" }),
      );

      // Parallel capacity = 1
      const count = countActiveLaps(ws.runsDir);
      expect(count).toBe(1); // Only live PID counted!

      // Preflight with parallel: 1 should report capacity_full
      const preflight = evaluateWorkspacePreflight(repoDir, {
        config: { parallel: 1 },
      });
      expect(preflight.ok).toBe(false);
      expect(preflight.status).toBe("held");
      expect(preflight.reason).toBe("capacity_full");
      expect(preflight.capacity.activeLaps).toBe(1);
      expect(preflight.capacity.maxParallel).toBe(1);

      // Preflight with parallel: 2 should be ready
      const preflightParallel2 = evaluateWorkspacePreflight(repoDir, {
        config: { parallel: 2 },
      });
      expect(preflightParallel2.ok).toBe(true);
      expect(preflightParallel2.capacity.activeLaps).toBe(1);
      expect(preflightParallel2.capacity.maxParallel).toBe(2);
      expect(preflightParallel2.capacity.availableSlots).toBe(1);
    });

    test("cascades schedule configuration: defaults -> repo -> global -> project -> override", () => {
      const animusHome = join(tempDir, "animus-home-cascade");
      process.env.ANIMUS_HOME = animusHome;
      mkdirSync(animusHome, { recursive: true });
      const slug = getProjectSlug(repoDir);

      mkdirSync(join(repoDir, ".animus"), { recursive: true });
      writeFileSync(
        join(repoDir, ".animus/schedule.json"),
        JSON.stringify({ workflow: "repo-workflow", parallel: 2, interval_seconds: 120 }),
      );

      writeFileSync(
        join(animusHome, "schedule.json"),
        JSON.stringify({ parallel: 4 }), // overrides repo parallel
      );

      const projectConfigDir = join(animusHome, "state", "projects", slug);
      mkdirSync(projectConfigDir, { recursive: true });
      writeFileSync(
        join(projectConfigDir, "schedule.json"),
        JSON.stringify({ interval_seconds: 60 }), // overrides repo interval
      );

      const config = loadCascadedScheduleConfig(repoDir);
      expect(config.workflow).toBe("repo-workflow"); // inherited from repo
      expect(config.parallel).toBe(4); // overridden by global ~/.animus/schedule.json
      expect(config.interval_seconds).toBe(60); // overridden by project schedule.json

      // Caller override takes final precedence
      const overrideConfig = loadCascadedScheduleConfig(repoDir, { parallel: 8 });
      expect(overrideConfig.parallel).toBe(8);
    });

    test("fails closed on malformed schedule JSON or invalid timezone", () => {
      mkdirSync(join(repoDir, ".animus"), { recursive: true });
      writeFileSync(join(repoDir, ".animus/schedule.json"), "{ invalid-json ");

      expect(() => loadCascadedScheduleConfig(repoDir)).toThrow(/Malformed schedule config/);

      writeFileSync(
        join(repoDir, ".animus/schedule.json"),
        JSON.stringify({
          work_window: {
            enabled: true,
            start_time: "20:00",
            end_time: "05:00",
            timezone: "Invalid/Tz",
          },
        }),
      );
      expect(() => loadCascadedScheduleConfig(repoDir)).toThrow(/Invalid timezone/);
    });
  });
});
