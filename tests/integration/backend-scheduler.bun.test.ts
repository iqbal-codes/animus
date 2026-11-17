import { describe, expect, test } from "bun:test";
import {
  BackendScheduler,
  type SchedulerIntake,
  type SchedulerProject,
  type SchedulerProjects,
} from "../../apps/backend/src/scheduler/service";

function projectList(entries: Partial<SchedulerProject>[]): SchedulerProjects {
  const projects: SchedulerProject[] = entries.map((entry) => ({
    id: entry.id ?? "project",
    status: entry.status ?? "active",
    checkout_path: entry.checkout_path ?? `/tmp/${entry.id ?? "project"}`,
  }));
  return { listProjects: () => projects };
}

function recordingIntake(options: { fail?: string } = {}) {
  const seen: string[] = [];
  const intake: SchedulerIntake = {
    evaluateProjectBacklog: async (projectId) => {
      seen.push(projectId);
      if (options.fail === projectId) throw new Error(`github down for ${projectId}`);
      return { total_count: 3 };
    },
  };
  return { intake, seen };
}

describe("backend scheduler", () => {
  test("refreshes intake for active projects and runs one global dispatch tick under local authority", async () => {
    const { intake, seen } = recordingIntake();
    const dispatchCalls: string[] = [];
    const cycles: string[] = [];
    const scheduler = new BackendScheduler({
      projects: projectList([
        { id: "alpha" },
        { id: "beta" },
        { id: "retired", status: "tombstone" },
      ]),
      intake,
      authority: () => "local",
      dispatchLocal: async () => {
        dispatchCalls.push("tick");
        return { action: "skipped", reason: "no_admitted_plan" };
      },
      intervalMs: 60_000,
      onCycle: (cycle) => cycles.push(cycle.dispatch ?? "none"),
    });

    await scheduler.tick();

    expect(seen).toEqual(["alpha", "beta"]);
    expect(dispatchCalls).toHaveLength(1);
    expect(cycles).toEqual(["no_admitted_plan"]);
    expect(scheduler.status().map((entry) => entry.project_id)).toEqual(["alpha", "beta"]);
  });

  test("keeps refreshing intake under legacy authority but never runs a dispatch tick", async () => {
    const { intake, seen } = recordingIntake();
    let dispatches = 0;
    const scheduler = new BackendScheduler({
      projects: projectList([{ id: "alpha" }]),
      intake,
      authority: () => "legacy",
      dispatchLocal: async () => {
        dispatches += 1;
        return { action: "skipped", reason: "unexpected" };
      },
      intervalMs: 60_000,
    });

    await scheduler.tick();

    expect(seen).toEqual(["alpha"]);
    expect(dispatches).toBe(0);
  });

  test("honors each project's interval instead of polling on every scan", async () => {
    const { intake, seen } = recordingIntake();
    let clock = 1_000_000;
    const scheduler = new BackendScheduler({
      projects: projectList([{ id: "alpha" }]),
      intake,
      authority: () => "legacy",
      dispatchLocal: async () => ({ action: "skipped", reason: "unused" }),
      intervalMs: 60_000,
      now: () => clock,
    });

    await scheduler.tick();
    expect(seen).toHaveLength(1);

    clock += 30_000;
    await scheduler.tick();
    expect(seen).toHaveLength(1);

    clock += 31_000;
    await scheduler.tick();
    expect(seen).toHaveLength(2);

    const [status] = scheduler.status();
    expect(status?.last_error).toBeNull();
    expect(status?.next_check_at).not.toBeNull();
  });

  test("isolates a failing project and still advances delivery", async () => {
    const { intake } = recordingIntake({ fail: "alpha" });
    let dispatches = 0;
    const scheduler = new BackendScheduler({
      projects: projectList([{ id: "alpha" }, { id: "beta" }]),
      intake,
      authority: () => "local",
      dispatchLocal: async () => {
        dispatches += 1;
        return { action: "launched", reason: "launch_successful" };
      },
      intervalMs: 60_000,
    });

    await scheduler.tick();

    expect(dispatches).toBe(1);
    const byId = new Map(scheduler.status().map((entry) => [entry.project_id, entry]));
    expect(byId.get("alpha")?.last_error).toContain("github down for alpha");
    expect(byId.get("beta")?.last_error).toBeNull();
  });

  test("start and stop bound the polling lifecycle", async () => {
    const firstCheck = Promise.withResolvers<void>();
    let checks = 0;
    const scheduler = new BackendScheduler({
      projects: projectList([{ id: "alpha" }]),
      intake: {
        evaluateProjectBacklog: async () => {
          checks += 1;
          firstCheck.resolve();
          return { total_count: 0 };
        },
      },
      authority: () => "legacy",
      dispatchLocal: async () => ({ action: "skipped", reason: "unused" }),
      intervalMs: 60_000,
      scanIntervalMs: 1,
    });

    scheduler.start();
    await firstCheck.promise;
    await scheduler.stop();
    const settled = checks;

    await scheduler.tick();
    expect(checks).toBe(settled);
  });
});
