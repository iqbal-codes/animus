import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { RegisteredProjectMonitor } from "../../apps/backend/src/monitor/service";
import { loadMonitorRuntime, type MonitorRuntime } from "../../apps/backend/src/monitor/runtime";
import { BrakeService } from "../../apps/backend/src/command/brakes";

describe("registered project monitoring", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let registry: ProjectRegistryService;
  let forge: SyntheticForgeAdapter;
  let monitor: RegisteredProjectMonitor;
  const launches: Array<{ root: string; issue: number }> = [];
  let runtime: MonitorRuntime;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "onboarding-monitor-"));
    db = initializeDatabase(join(root, "state", "console.db"));
    forge = new SyntheticForgeAdapter({ "owner/alpha": 101, "owner/beta": 102 });
    registry = new ProjectRegistryService(db, forge);
    launches.length = 0;
    runtime = await loadMonitorRuntime({
      githubRead(args) {
        if (args[0] === "api") return [[]];
        const repo = args[args.indexOf("--repo") + 1]!;
        return {
          number: 1,
          url: `https://github.com/${repo}/issues/1`,
          title: "Implement contract",
          body: "Deliver the requested behavior",
          comments: [],
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
        };
      },
      fetchBacklog: async () => ({
        issues: [
          {
            number: 1,
            title: "Implement contract",
            state: "OPEN",
            labels: ["ready-for-agent"],
            dependencies: [],
            activeClaim: false,
          },
        ],
        closedNumbers: new Set<number>(),
      }),
      launch: async (checkout, issue) => {
        launches.push({ root: checkout, issue: issue.number });
        return { runId: `run-${launches.length}`, status: "waiting_approval" };
      },
    });
    monitor = new RegisteredProjectMonitor(registry, { runtime, intervalMs: 100 });
  });
  afterEach(async () => {
    await monitor.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function project(name: "alpha" | "beta", configured = true) {
    const checkout = join(root, name);
    mkdirSync(checkout);
    execFileSync("git", ["init", "--quiet", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      `https://github.com/owner/${name}.git`,
    ]);
    if (configured) {
      mkdirSync(join(checkout, "harness"));
      writeFileSync(
        join(checkout, "harness/harness.config.json"),
        JSON.stringify({ static: "bun run check", unit: "bun test" }),
      );
      mkdirSync(join(checkout, ".animus"));
      writeFileSync(
        join(checkout, ".animus/config.yaml"),
        "tiers:\n  small:\n    provider: pi\n    model: test-small\n  medium:\n    provider: pi\n    model: test-medium\n  large:\n    provider: pi\n    model: test-large\n",
      );
    }
    return registry.registerProject({ method: "local_checkout", name, checkout_path: checkout });
  }

  test("discovers durable registrations and launches each configured checkout rather than the backend root", async () => {
    const alpha = await project("alpha");
    const beta = await project("beta");
    await monitor.tick();
    await monitor.drain();
    expect(monitor.status().projects.map((entry) => entry.error)).toEqual([undefined, undefined]);
    expect([...launches].sort((a, b) => a.root.localeCompare(b.root))).toEqual([
      { root: alpha.checkout_path, issue: 1 },
      { root: beta.checkout_path, issue: 1 },
    ]);
    expect(monitor.status().projects.map((entry) => entry.reason)).toEqual([
      "launch_successful",
      "launch_successful",
    ]);
  });

  test("unconfigured and altered checkouts are held without preventing a healthy project", async () => {
    const alpha = await project("alpha", false);
    const beta = await project("beta");
    await monitor.tick();
    await monitor.drain();
    expect(launches.map((entry) => entry.root)).toEqual([beta.checkout_path]);
    expect(monitor.status().projects.find((entry) => entry.project_id === alpha.id)?.reason).toBe(
      "setup_incomplete",
    );
    await monitor.stop();
    execFileSync("git", [
      "-C",
      beta.checkout_path,
      "remote",
      "set-url",
      "origin",
      "https://github.com/owner/alpha.git",
    ]);
    monitor = new RegisteredProjectMonitor(registry, { runtime });
    await monitor.tick();
    await monitor.drain();
    expect(launches.length).toBe(1);
    expect(monitor.status().projects.find((entry) => entry.project_id === beta.id)?.error).toBe(
      "checkout_identity_mismatch",
    );
  });

  test("no-op checks and malformed schedules never become runnable setup", async () => {
    const alpha = await project("alpha");
    writeFileSync(
      join(alpha.checkout_path, "harness/harness.config.json"),
      JSON.stringify({ static: "true", unit: "echo fine" }),
    );
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.reason).toBe("setup_incomplete");
    writeFileSync(
      join(alpha.checkout_path, "harness/harness.config.json"),
      JSON.stringify({ unit: "bun test" }),
    );
    mkdirSync(join(alpha.checkout_path, ".factory"));
    writeFileSync(join(alpha.checkout_path, ".factory/schedule.json"), "not json");
    await monitor.stop();
    monitor = new RegisteredProjectMonitor(registry, { runtime });
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.reason).toBe("setup_incomplete");
  });

  test("database global and project schedule/launch brakes prevent dispatch", async () => {
    const alpha = await project("alpha");
    const brakes = new BrakeService(db);
    for (const action of ["schedule", "launch"] as const) {
      for (const scope of ["global", "project"] as const) {
        if (scope === "global") {
          if (action === "schedule") brakes.setGlobalSchedulePause(true, "test");
          else brakes.setGlobalLaunchBrake(true, "test");
        } else {
          if (action === "schedule") brakes.setProjectSchedulePause(alpha.id, true, "test");
          else brakes.setProjectLaunchBrake(alpha.id, true, "test");
        }
        await monitor.stop();
        monitor = new RegisteredProjectMonitor(registry, { runtime });
        await monitor.tick();
        await monitor.drain();
        expect(launches).toEqual([]);
        expect(monitor.status().projects[0]?.reason).toBe(
          action === "schedule" ? "schedule_paused" : "launch_brake_set",
        );
        brakes.setGlobalSchedulePause(false, "test");
        brakes.setGlobalLaunchBrake(false, "test");
        brakes.setProjectSchedulePause(alpha.id, false, "test");
        brakes.setProjectLaunchBrake(alpha.id, false, "test");
      }
    }
  });

  test("filesystem brakes and failed label provisioning block monitoring", async () => {
    const alpha = await project("alpha");
    mkdirSync(join(alpha.checkout_path, ".factory"));
    writeFileSync(join(alpha.checkout_path, ".factory/PAUSE"), "paused");
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.error).toContain("PAUSE brake is active");
    rmSync(join(alpha.checkout_path, ".factory/PAUSE"));
    await monitor.stop();
    monitor = new RegisteredProjectMonitor(registry, { runtime });
    forge.failNextLabel = true;
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.error).toContain("label creation failed");
  });

  test("live candidate admission refuses readiness drift even when backlog selection was ready", async () => {
    await project("alpha");
    await monitor.stop();
    const changed = await loadMonitorRuntime({
      fetchBacklog: runtime.fetchBacklog,
      githubRead: (args) =>
        args[0] === "api"
          ? [[]]
          : {
              number: 1,
              url: "https://github.com/owner/alpha/issues/1",
              state: "OPEN",
              title: "Held",
              body: "Not ready",
              comments: [],
              labels: [{ name: "needs-triage" }],
            },
      launch: runtime.launch,
    });
    monitor = new RegisteredProjectMonitor(registry, { runtime: changed });
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.error).toContain("not ready for agent execution");
  });

  test("effective brakes are checked again after asynchronous backlog and candidate reads", async () => {
    const alpha = await project("alpha");
    const brakes = new BrakeService(db);
    await monitor.stop();
    const changed = {
      ...runtime,
      fetchBacklog: async (...args: Parameters<MonitorRuntime["fetchBacklog"]>) => {
        const backlog = await runtime.fetchBacklog(...args);
        brakes.setProjectLaunchBrake(alpha.id, true, "late brake");
        return backlog;
      },
    };
    monitor = new RegisteredProjectMonitor(registry, { runtime: changed });
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.error).toBe("launch_brake_set");
  });

  test("scheduler respects work windows and actual git-common local-loop capacity", async () => {
    const alpha = await project("alpha");
    mkdirSync(join(alpha.checkout_path, ".factory"));
    writeFileSync(
      join(alpha.checkout_path, ".factory/schedule.json"),
      JSON.stringify({
        work_window: { enabled: true, start_time: "00:00", end_time: "00:00", timezone: "UTC" },
      }),
    );
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.reason).toBe("outside_work_window");
    rmSync(join(alpha.checkout_path, ".factory/schedule.json"));
    mkdirSync(join(alpha.checkout_path, ".git/factory-local-loop/runs/existing"), {
      recursive: true,
    });
    writeFileSync(
      join(alpha.checkout_path, ".git/factory-local-loop/runs/existing/state.json"),
      JSON.stringify({ status: "building" }),
    );
    await monitor.stop();
    monitor = new RegisteredProjectMonitor(registry, { runtime });
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.reason).toBe("capacity_full");
  });

  test("one project error is inspectable while another finishes, and registry restart remains the source", async () => {
    const alpha = await project("alpha");
    const beta = await project("beta");
    await monitor.stop();
    const changed = {
      ...runtime,
      fetchBacklog: async (...args: Parameters<MonitorRuntime["fetchBacklog"]>) => {
        if (args[1] === "owner/alpha") throw new Error("GitHub unavailable for alpha");
        return runtime.fetchBacklog(...args);
      },
    };
    monitor = new RegisteredProjectMonitor(new ProjectRegistryService(db, forge), {
      runtime: changed,
    });
    await monitor.tick();
    await monitor.drain();
    expect(launches.map((entry) => entry.root)).toEqual([beta.checkout_path]);
    expect(
      monitor.status().projects.find((entry) => entry.project_id === alpha.id)?.error,
    ).toContain("GitHub unavailable for alpha");
  });

  test("unfinished durable runs and filesystem monitor locks fail closed across monitor restarts", async () => {
    const alpha = await project("alpha");
    const beta = await project("beta");
    registry.recordRun("previous-process-run", alpha.id);
    mkdirSync(join(beta.checkout_path, ".git/factory-local-loop/registered-project-monitor.lock"), {
      recursive: true,
    });
    await monitor.tick();
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects.find((entry) => entry.project_id === alpha.id)?.reason).toBe(
      "project_has_active_runs",
    );
    expect(monitor.status().projects.find((entry) => entry.project_id === beta.id)?.reason).toBe(
      "project_locked",
    );
  });

  test("one long lap cannot block another project or permit overlapping monitor dispatch", async () => {
    const alpha = await project("alpha");
    const beta = await project("beta");
    await monitor.stop();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launched!: () => void;
    const bothLaunched = new Promise<void>((resolve) => {
      launched = resolve;
    });
    const launch = runtime.launch;
    const slowRuntime = {
      ...runtime,
      launch: async (...args: Parameters<MonitorRuntime["launch"]>) => {
        const result = await launch(...args);
        if (launches.length === 2) launched();
        await blocked;
        return result;
      },
    };
    monitor = new RegisteredProjectMonitor(registry, { runtime: slowRuntime });
    const peer = new RegisteredProjectMonitor(registry, { runtime: slowRuntime });
    try {
      await monitor.tick();
      await bothLaunched;
      expect(registry.getActiveRunCount(alpha.id)).toBe(1);
      expect(registry.getActiveRunCount(beta.id)).toBe(1);
      const refusal = await registry.deregisterProject(alpha.id).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ code: "project_has_active_runs" });
      await monitor.tick();
      await peer.tick();
      await peer.drain();
      expect(launches.map((entry) => entry.root).sort()).toEqual([
        alpha.checkout_path,
        beta.checkout_path,
      ]);
      expect(peer.status().projects.map((entry) => entry.reason)).toEqual([
        "project_has_active_runs",
        "project_has_active_runs",
      ]);
      let stopped = false;
      const stopping = monitor.stop().then(() => {
        stopped = true;
      });
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(registry.getActiveRunCount(alpha.id)).toBe(0);
      expect(registry.getProjectRunIds(alpha.id)).toHaveLength(1);
      expect(
        registry.getRunProject(
          monitor.status().projects.find((entry) => entry.project_id === alpha.id)!.run_id!,
        ),
      ).toBe(alpha.id);
      await monitor.tick();
      expect(launches.length).toBe(2);
    } finally {
      release();
      await peer.stop();
    }
  });

  test("#118 AC1: wakeProject triggers immediate scheduler tick within 2 seconds even with large interval", async () => {
    const alpha = await project("alpha");
    await monitor.stop();
    // 60-second timer interval - no background timer tick should happen before wakeProject
    monitor = new RegisteredProjectMonitor(registry, { runtime, intervalMs: 60_000 });

    expect(launches).toEqual([]);
    const startTime = Date.now();
    const wake = monitor.wakeProject(alpha.id);
    expect(wake).toEqual({ triggered: true, pending_wake: false });

    await monitor.drain();
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(2000);
    expect(launches).toEqual([{ root: alpha.checkout_path, issue: 1 }]);
    expect(monitor.status().projects[0]?.reason).toBe("launch_successful");
  });

  test("#118 AC4 & AC5: wakeProject respects brakes and work window without launching laps", async () => {
    const alpha = await project("alpha");
    await monitor.stop();
    monitor = new RegisteredProjectMonitor(registry, { runtime, intervalMs: 60_000 });

    // AC4: .factory/STOP filesystem brake
    mkdirSync(join(alpha.checkout_path, ".factory"), { recursive: true });
    writeFileSync(join(alpha.checkout_path, ".factory/STOP"), "stopped");
    const stopWake = monitor.wakeProject(alpha.id);
    expect(stopWake.triggered).toBe(true);
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.error).toContain("STOP brake is active");
    rmSync(join(alpha.checkout_path, ".factory/STOP"));

    // AC4: DB launch brake
    const brakes = new BrakeService(db);
    brakes.setProjectLaunchBrake(alpha.id, true, "test brake");
    monitor.wakeProject(alpha.id);
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.reason).toBe("launch_brake_set");
    brakes.setProjectLaunchBrake(alpha.id, false, "test brake");

    // AC5: Outside work window
    writeFileSync(
      join(alpha.checkout_path, ".factory/schedule.json"),
      JSON.stringify({
        work_window: { enabled: true, start_time: "00:00", end_time: "00:00", timezone: "UTC" },
      }),
    );
    monitor.wakeProject(alpha.id);
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.reason).toBe("outside_work_window");
  });

  test("#119 AC1, AC2, AC3, AC4: pending_wake coalesces while busy and triggers chained execution upon lap finish", async () => {
    const alpha = await project("alpha");
    await monitor.stop();

    let lap1Resolve!: (res: { runId: string; status: string }) => void;
    const lap1Running = new Promise<{ runId: string; status: string }>((resolve) => {
      lap1Resolve = resolve;
    });

    let lap1Started!: () => void;
    const lap1StartedPromise = new Promise<void>((resolve) => {
      lap1Started = resolve;
    });

    let backlogIssueCount = 2;
    const customRuntime = {
      ...runtime,
      fetchBacklog: async () => ({
        issues:
          backlogIssueCount > 0
            ? [
                {
                  number: backlogIssueCount === 2 ? 1 : 2,
                  title: "Implement contract",
                  state: "OPEN",
                  labels: ["ready-for-agent"],
                  dependencies: [],
                  activeClaim: false,
                },
              ]
            : [],
        closedNumbers: new Set<number>(),
      }),
      readContract: async (rootPath: string, num: number, repo: string) => {
        return {
          number: num,
          url: `https://github.com/${repo}/issues/${num}`,
          title: `Contract ${num}`,
          body: "Deliver",
          comments: [],
          dependencies: [],
          activeClaim: false,
        };
      },
      launch: async (checkout: string, issue: { number: number }) => {
        launches.push({ root: checkout, issue: issue.number });
        if (issue.number === 1) {
          lap1Started();
          return lap1Running;
        }
        return { runId: "run-2", status: "completed" };
      },
    };

    // Use a huge interval so timer does not fire on its own
    monitor = new RegisteredProjectMonitor(registry, {
      runtime: customRuntime,
      intervalMs: 120_000,
    });

    // Start Lap 1
    const wake1 = monitor.wakeProject(alpha.id);
    expect(wake1).toEqual({ triggered: true, pending_wake: false });
    await lap1StartedPromise;

    // Lap 1 is now actively running
    expect(launches).toHaveLength(1);
    expect(monitor.isPendingWake(alpha.id)).toBe(false);

    // AC1: Webhook arrives while capacity full / lap running -> pending_wake = true
    const wakeWhileBusy1 = monitor.wakeProject(alpha.id);
    expect(wakeWhileBusy1).toEqual({ triggered: false, pending_wake: true });
    expect(monitor.isPendingWake(alpha.id)).toBe(true);
    expect(monitor.status().projects[0]?.pending_wake).toBe(true);

    // AC2: Multiple webhooks arriving coalesce into single pending_wake without extra launches
    const wakeWhileBusy2 = monitor.wakeProject(alpha.id);
    expect(wakeWhileBusy2).toEqual({ triggered: false, pending_wake: true });
    expect(monitor.isPendingWake(alpha.id)).toBe(true);
    expect(launches).toHaveLength(1);

    // Decrement backlog so Lap 2 is issue #2
    backlogIssueCount = 1;

    // AC3: Lap 1 finishes (completed) -> monitor inspects pending_wake and immediately chains next tick
    lap1Resolve({ runId: "run-1", status: "completed" });

    // Wait for monitor drain (chained execution completes without waiting for 120_000ms timer)
    await monitor.drain();

    // Verify Lap 2 was launched via chained execution
    expect(launches).toHaveLength(2);
    expect(launches[1]).toEqual({ root: alpha.checkout_path, issue: 2 });

    // AC4: Backlog is now exhausted (0 issues), pending_wake is cleared (false), returns to idle
    backlogIssueCount = 0;
    expect(monitor.isPendingWake(alpha.id)).toBe(false);
    expect(monitor.status().projects[0]?.pending_wake).toBe(false);
  });

  test("#119 AC1 (external capacity): pending_wake is recorded when external capacity is full", async () => {
    const alpha = await project("alpha");
    mkdirSync(join(alpha.checkout_path, ".git/factory-local-loop/runs/existing"), {
      recursive: true,
    });
    writeFileSync(
      join(alpha.checkout_path, ".git/factory-local-loop/runs/existing/state.json"),
      JSON.stringify({ status: "building" }),
    );

    const wake = monitor.wakeProject(alpha.id);
    // Either synchronously detected or recorded in status
    expect(wake.pending_wake).toBe(true);
    await monitor.drain();
    expect(launches).toEqual([]);
    expect(monitor.status().projects[0]?.pending_wake).toBe(true);
    expect(monitor.status().projects[0]?.reason).toBe("capacity_full");
  });

  test("#119 AC5: background interval scheduling runs uninterrupted alongside event-driven wake triggers", async () => {
    const alpha = await project("alpha");
    await monitor.stop();
    // Fast interval (50ms) to verify timer ticks
    monitor = new RegisteredProjectMonitor(registry, { runtime, intervalMs: 50 });
    monitor.start();

    // Allow periodic scan to launch issue 1
    await Bun.sleep(150);
    await monitor.drain();
    expect(launches.length).toBeGreaterThanOrEqual(1);
    expect(monitor.status().enabled).toBe(true);

    // Event-driven wake also functions while periodic timer is active
    const wake = monitor.wakeProject(alpha.id);
    expect(wake.triggered || wake.pending_wake).toBe(true);
    await monitor.drain();

    // Verify timer is still active and monitoring status is healthy
    const status = monitor.status();
    expect(status.enabled).toBe(true);
    expect(status.stopping).toBe(false);
    expect(status.error).toBeNull();
  });
});
