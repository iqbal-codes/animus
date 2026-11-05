import { expect, test } from "bun:test";
import { fetchGithubBacklog } from "../../scripts/scheduler";
import {
  SyntheticForgeAdapter,
  type IssueForgeAdapter,
} from "../../apps/backend/src/registry/forge";
import {
  runSchedulerTick,
  awaitInFlightTriage,
  getInFlightTriage,
  clearTriageTracking,
  type BacklogCandidate,
} from "../../scripts/loop/scheduler";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("scheduler resolves only shared dependencies of ready open candidates", async () => {
  const forge: IssueForgeAdapter = new SyntheticForgeAdapter({ "owner/repo": 1 });
  forge.listIssues = async () => [
    {
      number: 200,
      title: "first",
      state: "OPEN",
      labels: ["ready-for-agent"],
      body: "Depends on: #1",
      comments: [],
    },
    {
      number: 201,
      title: "second",
      state: "OPEN",
      labels: ["ready-for-agent"],
      body: "Depends on: #1, #200",
      comments: [],
    },
    {
      number: 202,
      title: "triage",
      state: "OPEN",
      labels: ["needs-triage"],
      body: "Depends on: #99",
      comments: [],
    },
  ];
  let requested: number[] = [];
  forge.getIssueStates = async (_repo, numbers) => {
    requested = numbers;
    return new Map([[1, "CLOSED"]]);
  };
  const result = await fetchGithubBacklog("/unused", "owner/repo", forge);
  expect(result.issues.map((issue) => issue.number)).toEqual([200, 201]);
  expect(requested).toEqual([1]);
  expect([...result.closedNumbers]).toEqual([1]);
});

test("fetchGithubBacklog unions native GitHub blocked_by dependencies and filterAdmittedIssues holds them", async () => {
  const forge: IssueForgeAdapter = new SyntheticForgeAdapter({ "owner/repo": 1 });
  forge.listIssues = async () => [
    {
      number: 300,
      title: "native blocked candidate",
      state: "OPEN",
      labels: ["ready-for-agent"],
      body: "Depends on: None",
      comments: [],
    },
  ];
  forge.getIssueDependencies = async (_repo, childNumber) => {
    if (childNumber === 300) return [400];
    return [];
  };
  forge.getIssueStates = async (_repo, numbers) => {
    return new Map(numbers.map((n) => [n, "OPEN"]));
  };

  const result = await fetchGithubBacklog("/unused", "owner/repo", forge);
  expect(result.issues[0]?.dependencies).toContain(400);

  const { filterAdmittedIssues } = await import("../../scripts/loop/scheduler");
  const admitted = filterAdmittedIssues(result.issues, result.closedNumbers);
  expect(admitted).toEqual([]);
});

test("fetchGithubBacklog propagates error when forge.getIssueDependencies throws", async () => {
  const forge: IssueForgeAdapter = new SyntheticForgeAdapter({ "owner/repo": 1 });
  forge.listIssues = async () => [
    {
      number: 305,
      title: "native candidate",
      state: "OPEN",
      labels: ["ready-for-agent"],
      body: "Depends on: None",
      comments: [],
    },
  ];
  forge.getIssueDependencies = async () => {
    throw new Error("dependency service unavailable");
  };

  const result = await fetchGithubBacklog("/unused", "owner/repo", forge).catch(
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe("dependency service unavailable");
});

test("filterAdmittedIssues holds issues whose runs are in needs_owner or interrupted", async () => {
  const { filterAdmittedIssues } = await import("../../scripts/loop/scheduler");
  const candidates: BacklogCandidate[] = [
    {
      number: 501,
      title: "needs owner candidate",
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
    },
    {
      number: 502,
      title: "interrupted candidate",
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
    },
    {
      number: 503,
      title: "clean candidate",
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
    },
  ];

  const runStates = new Map<number, string>([
    [501, "needs_owner"],
    [502, "interrupted"],
  ]);

  const admitted = filterAdmittedIssues(candidates, new Set(), { runStates });
  expect(admitted.map((c) => c.number)).toEqual([503]);
});

test("scheduler dependency outage refuses discovery instead of admitting work", async () => {
  const forge: IssueForgeAdapter = new SyntheticForgeAdapter({ "owner/repo": 1 });
  forge.listIssues = async () => [
    {
      number: 200,
      title: "first",
      state: "OPEN",
      labels: ["ready-for-agent"],
      body: "Depends on: #1",
    },
  ];
  forge.getIssueStates = async () => {
    throw new Error("lookup unavailable");
  };
  const result = await fetchGithubBacklog("/unused", "owner/repo", forge).catch(
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe("lookup unavailable");
});

test("runSchedulerTick executes non-blocking triage when builder capacity is full and returns before triage finishes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "animus-sched-cap-"));
  clearTriageTracking(tmp);
  try {
    const runsDir = join(tmp, "runs");
    await mkdir(join(runsDir, "run-1"), { recursive: true });
    await writeFile(join(runsDir, "run-1", "state.json"), JSON.stringify({ status: "building" }));

    let resolveTriage!: (val: unknown) => void;
    const deferredPromise = new Promise((resolve) => {
      resolveTriage = resolve;
    });
    let triageStarted = false;
    let triageEnded = false;

    const mockTriage = async (_ctx: { root: string; repo: string; stateRoot: string }) => {
      triageStarted = true;
      await deferredPromise;
      triageEnded = true;
      return { triaged: true };
    };

    let builderLaunched = false;
    const mockLaunch = async (issue: BacklogCandidate) => {
      builderLaunched = true;
      return { runId: `run-${issue.number}` };
    };

    const candidate: BacklogCandidate = {
      number: 10,
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
    };

    // Capacity is full: parallel limit 1, 1 active lap
    const tick1 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      runsDir,
      config: { parallel: 1 },
      fetchBacklog: async () => ({ issues: [candidate], closedNumbers: new Set() }),
      launchLap: mockLaunch,
      triage: mockTriage,
    });

    // Scheduler tick returns immediately before triage finishes
    expect(triageStarted).toBe(true);
    expect(triageEnded).toBe(false);
    expect(tick1.action).toBe("skipped");
    expect(tick1.reason).toBe("capacity_full");
    expect(tick1.activeLapsCount).toBe(1);
    expect(tick1.triage?.status).toBe("scheduled");
    expect(builderLaunched).toBe(false);
    expect(getInFlightTriage(tmp)).not.toBeNull();

    // Second tick while triage is still in flight
    const tick2 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      runsDir,
      config: { parallel: 1 },
      fetchBacklog: async () => ({ issues: [candidate], closedNumbers: new Set() }),
      launchLap: mockLaunch,
      triage: mockTriage,
    });
    expect(tick2.action).toBe("skipped");
    expect(tick2.reason).toBe("capacity_full");
    expect(tick2.triage?.status).toBe("inflight");

    // Finish triage
    resolveTriage({ success: true });
    await awaitInFlightTriage(tmp);
    expect(triageEnded).toBe(true);

    // Triage must not increment builder lap slots in runsDir
    const tick3 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      runsDir,
      config: { parallel: 1 },
      fetchBacklog: async () => ({ issues: [candidate], closedNumbers: new Set() }),
      launchLap: mockLaunch,
      triage: async () => ({ done: true }),
    });
    expect(tick3.activeLapsCount).toBe(1);
  } finally {
    clearTriageTracking(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
});

test("STOP/PAUSE brakes and work window enforce zero spawn for builder laps and triage passes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "animus-sched-brakes-"));
  clearTriageTracking(tmp);
  try {
    let triageCalled = false;
    let builderCalled = false;
    const mockTriage = async () => {
      triageCalled = true;
    };
    const mockLaunch = async (issue: BacklogCandidate) => {
      builderCalled = true;
      return { runId: `run-${issue.number}` };
    };
    const candidate: BacklogCandidate = {
      number: 20,
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
    };
    const backlog = async () => ({ issues: [candidate], closedNumbers: new Set<number>() });

    // 1. File STOP brake
    await mkdir(join(tmp, ".factory"), { recursive: true });
    await writeFile(join(tmp, ".factory", "STOP"), "emergency stop");

    const stopRes = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      triage: mockTriage,
    });
    expect(stopRes.action).toBe("skipped");
    expect(stopRes.reason).toBe("stop_brake_set");
    expect(stopRes.triage?.status).toBe("skipped");
    expect(triageCalled).toBe(false);
    expect(builderCalled).toBe(false);

    await rm(join(tmp, ".factory", "STOP"));

    // 2. File PAUSE brake
    await writeFile(join(tmp, ".factory", "PAUSE"), "pause drain");
    const pauseRes = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      triage: mockTriage,
    });
    expect(pauseRes.action).toBe("skipped");
    expect(pauseRes.reason).toBe("pause_brake_set");
    expect(pauseRes.triage?.status).toBe("skipped");
    expect(triageCalled).toBe(false);
    expect(builderCalled).toBe(false);

    await rm(join(tmp, ".factory", "PAUSE"));

    // 3. BrakeService schedule pause
    const mockBrakeService = {
      isScheduledLaunchPermitted: (_projectId?: string | null) => ({
        permitted: false,
        reason: "schedule_paused",
      }),
    };
    const brakeServiceRes = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      brakes: mockBrakeService,
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      triage: mockTriage,
    });
    expect(brakeServiceRes.action).toBe("skipped");
    expect(brakeServiceRes.reason).toBe("pause_brake_set");
    expect(brakeServiceRes.triage?.status).toBe("skipped");
    expect(triageCalled).toBe(false);
    expect(builderCalled).toBe(false);

    // 4. Outside work window
    const outsideWindowRes = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      config: {
        work_window: {
          enabled: true,
          start_time: "01:00",
          end_time: "02:00",
          timezone: "UTC",
        },
      },
      now: new Date("2026-01-01T15:00:00Z"),
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      triage: mockTriage,
    });
    expect(outsideWindowRes.action).toBe("skipped");
    expect(outsideWindowRes.reason).toBe("outside_work_window");
    expect(outsideWindowRes.triage?.status).toBe("skipped");
    expect(triageCalled).toBe(false);
    expect(builderCalled).toBe(false);
  } finally {
    clearTriageTracking(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
});

test("triage background errors are inspectable without throwing or blocking builder scheduling", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "animus-sched-err-"));
  clearTriageTracking(tmp);
  try {
    let builderRan = false;
    const mockLaunch = async (issue: BacklogCandidate) => {
      builderRan = true;
      return { runId: `run-${issue.number}` };
    };

    const candidate: BacklogCandidate = {
      number: 30,
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
    };
    const backlog = async () => ({ issues: [candidate], closedNumbers: new Set<number>() });

    let rejectTriage!: (err: Error) => void;
    const triagePromise = new Promise((_, reject) => {
      rejectTriage = reject;
    });

    // Tick 1: Triage starts and builder launches simultaneously
    const tick1 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      triage: async () => triagePromise,
    });

    expect(tick1.action).toBe("launched");
    expect(tick1.reason).toBe("launch_successful");
    expect(tick1.triage?.status).toBe("scheduled");
    expect(builderRan).toBe(true);

    // Asynchronously reject triage
    rejectTriage(new Error("Connection reset by peer during triage pass"));
    await awaitInFlightTriage(tmp);

    // Tick 2: Error from previous background triage is inspectable on result
    const tick2 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      // Triage disabled on this tick so we inspect previous error
      triage: null,
    });

    expect(tick2.triage?.status).toBe("error");
    expect(tick2.triage?.error).toContain("Connection reset by peer during triage pass");
    expect(tick2.action).toBe("launched"); // Builder still dispatches unhindered
  } finally {
    clearTriageTracking(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
});

test("structured runTriagePass failure records error status and honest counters without being lost", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "animus-sched-struct-err-"));
  clearTriageTracking(tmp);
  try {
    const candidate: BacklogCandidate = {
      number: 35,
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
    };
    const backlog = async () => ({ issues: [candidate], closedNumbers: new Set<number>() });
    const mockLaunch = async (issue: BacklogCandidate) => ({ runId: `run-${issue.number}` });

    let resolveTriage!: (res: unknown) => void;
    const triagePromise = new Promise((resolve) => {
      resolveTriage = resolve;
    });

    // Tick 1: Triage scheduled
    const tick1 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      triage: async () => triagePromise,
    });
    expect(tick1.triage?.status).toBe("scheduled");

    // Resolve with structured failure
    resolveTriage({
      processed: [
        {
          issueNumber: 35,
          status: "failed",
          error: "Model API rate limit exceeded in triage evaluation",
        },
      ],
      failureCount: 1,
      successCount: 0,
      skippedCount: 0,
      heldCount: 0,
    });
    await awaitInFlightTriage(tmp);

    // Tick 2: Inspect error from structured triage failure
    const tick2 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      triage: null,
    });
    expect(tick2.triage?.status).toBe("error");
    expect(tick2.triage?.error).toContain("Model API rate limit exceeded");

    // Tick 3: Error is persisted and not lost after single check!
    const tick3 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: backlog,
      launchLap: mockLaunch,
      triage: null,
    });
    expect(tick3.triage?.status).toBe("error");
    expect(tick3.triage?.error).toContain("Model API rate limit exceeded");
  } finally {
    clearTriageTracking(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
});

test("triage promotes non-ready issue which becomes eligible for builder dispatch on same tick", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "animus-sched-promote-same-"));
  clearTriageTracking(tmp);
  try {
    let issueLabels = ["needs-triage"];
    let launchedNumber: number | null = null;

    const mockLaunch = async (issue: BacklogCandidate) => {
      launchedNumber = issue.number;
      return { runId: `run-${issue.number}` };
    };

    const getBacklog = async () => ({
      issues: [
        {
          number: 55,
          state: "OPEN",
          labels: [...issueLabels],
          dependencies: [],
        },
      ],
      closedNumbers: new Set<number>(),
    });

    const mockTriage = async () => {
      // Triage runs synchronously and promotes issue #55 before builder backlog fetch
      issueLabels = ["ready-for-agent"];
      return { promoted: 55 };
    };

    // Tick 1: triage immediately promotes issue 55, builder admits and dispatches it in the same tick
    const tick1 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: getBacklog,
      launchLap: mockLaunch,
      triage: mockTriage,
    });

    expect(tick1.action).toBe("launched");
    expect(tick1.reason).toBe("launch_successful");
    expect(tick1.targetIssueNumber).toBe(55);
    expect(tick1.triage?.status).toBe("scheduled");
    expect<number | null>(launchedNumber).toBe(55);
  } finally {
    clearTriageTracking(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
});

test("deferred triage promotion admits and dispatches issue on next tick", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "animus-sched-promote-next-"));
  clearTriageTracking(tmp);
  try {
    let issueLabels = ["needs-triage"];
    let launchedNumber: number | null = null;

    const mockLaunch = async (issue: BacklogCandidate) => {
      launchedNumber = issue.number;
      return { runId: `run-${issue.number}` };
    };

    const getBacklog = async () => ({
      issues: [
        {
          number: 77,
          state: "OPEN",
          labels: [...issueLabels],
          dependencies: [],
        },
      ],
      closedNumbers: new Set<number>(),
    });

    let resolveTriage!: () => void;
    const triageGate = new Promise<void>((resolve) => {
      resolveTriage = resolve;
    });

    const mockTriage = async () => {
      await triageGate;
      issueLabels = ["ready-for-agent"];
      return { promoted: 77 };
    };

    // Tick 1: issue is needs-triage, triage is deferred, builder skips with no_admitted_issues
    const tick1 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: getBacklog,
      launchLap: mockLaunch,
      triage: mockTriage,
    });

    expect(tick1.action).toBe("skipped");
    expect(tick1.reason).toBe("no_admitted_issues");
    expect(tick1.triage?.status).toBe("scheduled");
    expect(launchedNumber).toBeNull();

    // Now resolve triage and let it promote issue #77
    resolveTriage();
    await awaitInFlightTriage(tmp);

    // Tick 2: issue 77 is now ready-for-agent, builder admits and dispatches it on next tick
    const tick2 = await runSchedulerTick({
      root: tmp,
      repo: "animus/test-repo",
      fetchBacklog: getBacklog,
      launchLap: mockLaunch,
      triage: async () => ({}),
    });

    expect(tick2.action).toBe("launched");
    expect(tick2.reason).toBe("launch_successful");
    expect(tick2.targetIssueNumber).toBe(77);
    expect<number | null>(launchedNumber).toBe(77);
  } finally {
    clearTriageTracking(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
});
