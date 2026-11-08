import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { PlanService } from "../../apps/backend/src/plans";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import {
  DispatchService,
  resolveWorkerOwnerPath,
  runLocalDispatchTick,
  writeWorkerOwner,
  type DispatchRunner,
  type DispatchRunnerContext,
  type DispatchTerminator,
} from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../../apps/backend/src/work/budget";

const REPO = "owner/budget-repo";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function ticketBody(
  options: { partOf?: number; dependsOn?: number[]; criteria?: string[]; coverage?: string } = {},
): string {
  const lines: string[] = [];
  if (options.partOf) lines.push(`Part of #${options.partOf}`, "");
  if (options.coverage) lines.push(`Source acceptance coverage: ${options.coverage}`, "");
  lines.push(
    "## Source and problem",
    "",
    "Prepared ticket source.",
    "",
    "## Outcome",
    "",
    "Prepared ticket outcome.",
    "",
    "## Invariants",
    "",
    "- Keep the invariant.",
    "",
    "## Acceptance criteria",
    "",
    ...(options.criteria ?? ["AC1: prepared criterion"]).map((line) => `- [ ] ${line}`),
    "",
    "## Boundary",
    "",
    "Prepared ticket boundary.",
    "",
    options.dependsOn && options.dependsOn.length > 0
      ? `Depends on: ${options.dependsOn.map((n) => `#${n}`).join(", ")}`
      : "Depends on: None",
  );
  return lines.join("\n");
}

function specBody(criteria: string[]): string {
  return [
    "## Source and problem",
    "",
    "Prepared specification source.",
    "",
    "## Outcome",
    "",
    "Prepared specification outcome.",
    "",
    "## Invariants",
    "",
    "- Planning record, never dispatched directly.",
    "",
    "## Acceptance criteria",
    "",
    ...criteria.map((criterion, index) => `- [ ] AC${index + 1} — ${criterion}`),
    "",
    "## Boundary",
    "",
    "Prepared specification boundary.",
  ].join("\n");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("bounded attempt budgets and operator controls", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let projectId: string;
  let checkoutPath: string;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let observations: ExecutionObservationService;
  let budget: ExecutionBudgetService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-budget-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    writeExecutionAuthority("local");
    db = initializeDatabase(join(root, "state", "console.db"));
    forge = new SyntheticForgeAdapter({ [REPO]: 987 });
    registry = new ProjectRegistryService(db, forge);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    git(checkoutPath, "commit", "--allow-empty", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    plans = new PlanService(db, forge);
    ledger = new CommandLedger(db);
    brakes = new BrakeService(db);
    observations = new ExecutionObservationService(db);
    budget = new ExecutionBudgetService(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  function addIssue(
    number: number,
    body: string = ticketBody(),
    labels: string[] = ["ready-for-agent"],
  ) {
    forge.addIssue(REPO, {
      number,
      title: `Issue ${number}`,
      body,
      state: "OPEN",
      labels: labels.map((name) => ({ name })),
      comments: [],
    });
  }

  function makeService(options: Record<string, unknown> = {}): DispatchService {
    return new DispatchService(db, {
      plans,
      ledger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: async () => ({ success: false, error: "rejected cycle" }),
      ...options,
    } as ConstructorParameters<typeof DispatchService>[1]);
  }

  function commitInWorktree(worktreePath: string, name: string): string {
    writeFileSync(join(worktreePath, name), "implemented\n");
    git(worktreePath, "add", name);
    git(worktreePath, "commit", "-q", "-m", `implement ${name}`);
    return git(worktreePath, "rev-parse", "HEAD");
  }

  function committingRunner(): DispatchRunner {
    return async (context) => ({
      success: true,
      headSha: commitInWorktree(context.worktree_path, `impl-${context.issue_number}.txt`),
    });
  }

  async function deadProcessPid(): Promise<number> {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    const pid = child.pid!;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return pid;
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
      resolve = next;
    });
    return { promise, resolve };
  }

  async function waitForRunningRun(service: DispatchService, planId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = service.listRuns(projectId, { plan_id: planId })[0];
      if (run?.state === "running") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("dispatch did not reach the running state");
  }

  function register(id: string, role: "automated_gate" | "peer_reviewer") {
    return observations.registerTrustedProducer(projectId, { id, role });
  }

  async function dispatchLap(
    service: DispatchService,
    planId: string,
    workId: string,
  ): Promise<string> {
    try {
      const run = await service.dispatch(projectId, {
        plan_id: planId,
        work_id: workId,
        actor: "operator",
      });
      return run.id;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "dispatch_failed") throw error;
      const runs = service.listRuns(projectId, { plan_id: planId });
      return runs[0]!.id;
    }
  }

  test("AC1: three rejected builder cycles allocate laps 1-3 and the fourth dispatch is refused", async () => {
    addIssue(500);
    const plan = await plans.importPlan(projectId, { issue_number: 500, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const run = await service
        .dispatch(projectId, {
          plan_id: plan.id,
          work_id: member.work_id,
          actor: "operator",
        })
        .catch(async (error) => {
          expect((error as { code: string }).code).toBe("dispatch_failed");
          return service.listRuns(projectId, { plan_id: plan.id })[0]!;
        });
      expect(run.lap).toBe(attempt);
    }

    const runs = service.listRuns(projectId, { plan_id: plan.id });
    expect(runs.map((run) => run.lap).sort((left, right) => left - right)).toEqual([1, 2, 3]);

    const detail = service.getRunDetail(projectId, runs[0]!.id);
    expect(detail.budget).toMatchObject({
      baseLimit: 3,
      grantedAttempts: 0,
      consumedAttempts: 3,
      allowedAttempts: 3,
      remainingAttempts: 0,
      status: "exhausted",
      lastRejection: "rejected cycle",
    });
    expect(detail.budget?.retainedWorktreePath).toBe(runs[0]!.worktree_path);
    expect(detail.budget?.retainedBranch).toBe(runs[0]!.branch);
    expect(existsSync(detail.budget!.retainedWorktreePath!)).toBe(true);
    expect(detail.attempts).toHaveLength(3);
    expect(detail.acceptance.reasons).toContain("budget_exhausted");

    await expect(
      service.dispatch(projectId, {
        plan_id: plan.id,
        work_id: member.work_id,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(service.listRuns(projectId, { plan_id: plan.id })).toHaveLength(3);
  });

  test("AC2: exhaustion retains work and findings, blocks dependents, and leaves independent siblings eligible", async () => {
    addIssue(600, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(601, ticketBody({ partOf: 600, criteria: ["AC1"], coverage: "AC1" }));
    addIssue(602, ticketBody({ partOf: 600, dependsOn: [601], coverage: "AC2" }));
    addIssue(603, ticketBody({ partOf: 600 }));
    const plan = await plans.importPlan(projectId, { issue_number: 600, kind: "spec" });
    const ticket601 = plan.members.find((m) => m.issue_number === 601)!;
    const ticket602 = plan.members.find((m) => m.issue_number === 602)!;
    const ticket603 = plan.members.find((m) => m.issue_number === 603)!;

    register("gate-1", "automated_gate");
    const gate = { id: "gate-1", role: "automated_gate" as const };
    const service = makeService({ runner: committingRunner() });

    let lastRunId = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const run = await service.dispatch(projectId, {
        plan_id: plan.id,
        work_id: ticket601.work_id,
        actor: "operator",
      });
      lastRunId = run.id;
      expect(run.lap).toBe(attempt);
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "failed",
        producer: gate,
        checks: [{ name: "unit", command: "bun test", result: "FAIL", detail: "2 failing" }],
        findings: [
          {
            severity: "blocking",
            acKey: "AC1",
            fileContext: "apps/backend/src/example.ts:42",
            summary: `rejected cycle ${attempt}`,
          },
        ],
      });
    }

    // The third rejected cycle exhausted the ticket; the explicit fourth attempt is refused.
    await expect(
      service.dispatch(projectId, {
        plan_id: plan.id,
        work_id: ticket601.work_id,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });

    const detail = service.getRunDetail(projectId, lastRunId);
    expect(detail.budget?.status).toBe("exhausted");
    expect(detail.openFindings).toHaveLength(3);
    expect(detail.acceptanceCriteria).toEqual([
      expect.objectContaining({ acKey: "AC1", openFindingIds: expect.any(Array) }),
    ]);
    expect(detail.acceptanceCriteria[0]!.openFindingIds).toHaveLength(3);
    expect(detail.attempts.map((attempt) => attempt.lap)).toEqual([1, 2, 3]);
    expect(detail.budget?.retainedWorktreePath).toBeTruthy();

    // A dependent waits because its prerequisite is not integrated on the frozen target.
    await expect(
      service.dispatch(projectId, {
        plan_id: plan.id,
        work_id: ticket602.work_id,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "dependency_pending_integration" });

    // An independent sibling remains eligible and keeps its own untouched budget.
    const sibling = await service.dispatch(projectId, {
      plan_id: plan.id,
      work_id: ticket603.work_id,
      actor: "operator",
    });
    expect(sibling.state).toBe("succeeded");
    expect(sibling.lap).toBe(1);
    const siblingScope = budget.getScope({
      projectId,
      deliveryId: sibling.delivery_id,
      planId: plan.id,
      workId: sibling.work_id,
      gateProfile: "child",
    });
    expect(siblingScope?.status).toBe("active");
    expect(siblingScope?.consumedAttempts).toBe(1);

    // The final-delivery budget is a distinct scope keyed by the spec root and profile.
    const finalScope = budget.ensureScope({
      projectId,
      deliveryId: sibling.delivery_id,
      planId: plan.id,
      workId: plan.root_work_id,
      gateProfile: "final",
      baseLimit: plan.manifest!.budgets.final_max_laps,
      now: Date.now(),
    });
    expect(finalScope.status).toBe("active");
    expect(finalScope.consumedAttempts).toBe(0);
    expect(
      budget.getScope({
        projectId,
        deliveryId: sibling.delivery_id,
        planId: plan.id,
        workId: ticket601.work_id,
        gateProfile: "child",
      })?.status,
    ).toBe("exhausted");
  });

  test("AC3: a positive grant permits only the numbered attempts; replay does not double; resume cannot reset", async () => {
    addIssue(700);
    const plan = await plans.importPlan(projectId, { issue_number: 700, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await dispatchLap(service, plan.id, member.work_id);
    }
    const [firstRun] = service.listRuns(projectId, { plan_id: plan.id });
    expect(service.getRunDetail(projectId, firstRun!.id).budget?.status).toBe("exhausted");

    await expect(async () =>
      service.applyControl(projectId, firstRun!.id, {
        action: "resume",
        actor: "operator",
        reason: "try to resume",
      }),
    ).rejects.toMatchObject({ code: "control_not_found" });

    const firstGrant = service.grantBudget(projectId, firstRun!.id, {
      amount: 1,
      reason: "root cause identified",
      actor: "operator",
      idempotency_key: "grant-key-1",
    });
    expect(firstGrant.replayed).toBe(false);
    expect(firstGrant.budget).toMatchObject({
      status: "active",
      grantedAttempts: 1,
      allowedAttempts: 4,
      remainingAttempts: 1,
      consumedAttempts: 3,
    });

    const replay = service.grantBudget(projectId, firstRun!.id, {
      amount: 1,
      reason: "root cause identified",
      actor: "operator",
      idempotency_key: "grant-key-1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.budget.grantedAttempts).toBe(1);
    expect(replay.budget.allowedAttempts).toBe(4);
    expect(service.listGrants(projectId, { runId: firstRun!.id }).map((grant) => grant.id)).toEqual(
      [firstGrant.grant.id],
    );

    // Exactly the fourth numbered attempt becomes available.
    const fourth = await dispatchLap(service, plan.id, member.work_id);
    const fourthRun = service.getRun(projectId, fourth);
    expect(fourthRun.lap).toBe(4);
    expect(service.getRunDetail(projectId, fourth).budget?.status).toBe("exhausted");

    await expect(
      service.dispatch(projectId, {
        plan_id: plan.id,
        work_id: member.work_id,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });

    const secondGrant = service.grantBudget(projectId, firstRun!.id, {
      amount: 2,
      reason: "two more investigated attempts",
      actor: "operator",
      idempotency_key: "grant-key-2",
    });
    expect(secondGrant.budget).toMatchObject({
      status: "active",
      grantedAttempts: 3,
      allowedAttempts: 6,
      remainingAttempts: 2,
      consumedAttempts: 4,
    });

    const fifth = await dispatchLap(service, plan.id, member.work_id);
    expect(service.getRun(projectId, fifth).lap).toBe(5);

    const command = ledger.getCommand(firstGrant.commandRequestId);
    expect(command?.action).toBe("budget_grant");
    expect(command?.target).toMatchObject({ amount: 1, reason: "root cause identified" });
  });

  test("AC4: hold blocks new attempts, resume requires budget, and stale ownership generation is rejected", async () => {
    addIssue(800);
    const plan = await plans.importPlan(projectId, { issue_number: 800, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    const firstRunId = await dispatchLap(service, plan.id, member.work_id);

    const held = service.applyControl(projectId, firstRunId, {
      action: "hold",
      actor: "operator",
      reason: "investigate output",
    });
    expect(held.control.status).toBe("held");
    expect(held.confirmed).toBe(true);
    await expect(
      service.dispatch(projectId, {
        plan_id: plan.id,
        work_id: member.work_id,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "work_held" });

    const resumed = service.applyControl(projectId, firstRunId, {
      action: "resume",
      actor: "operator",
      reason: "investigation complete",
      expected_ownership_generation: held.run.ownership_generation,
    });
    expect(resumed.control.status).toBe("active");
    expect(resumed.budget?.consumedAttempts).toBe(1);

    await expect(async () =>
      service.applyControl(projectId, firstRunId, {
        action: "resume",
        actor: "operator",
        expected_ownership_generation: 9999,
      }),
    ).rejects.toMatchObject({ code: "stale_owner_generation" });

    // Exhaust the ticket, then prove resume cannot reset consumed attempts.
    await dispatchLap(service, plan.id, member.work_id);
    await dispatchLap(service, plan.id, member.work_id);
    const exhaustedRun = service.getRunDetail(projectId, firstRunId);
    expect(exhaustedRun.budget?.status).toBe("exhausted");

    // Stop the (failed) run first so a stopped control row exists.
    const stopped = service.applyControl(projectId, firstRunId, {
      action: "hold",
      actor: "operator",
      reason: "halt before escalation",
    });
    expect(stopped.control.status).toBe("held");

    await expect(async () =>
      service.applyControl(projectId, firstRunId, {
        action: "resume",
        actor: "operator",
        reason: "try to reset budget",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(service.getRunDetail(projectId, firstRunId).budget?.consumedAttempts).toBe(3);
  });

  test("AC4: stop stays unconfirmed while a live detached writer exists; takeover refuses; reconcile releases it", async () => {
    addIssue(900);
    const plan = await plans.importPlan(projectId, { issue_number: 900, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    const firstRunId = await dispatchLap(service, plan.id, member.work_id);
    const failedRun = service.getRun(projectId, firstRunId);

    // Simulate a still-running detached builder owned by the claim.
    const { spawn } = await import("node:child_process");
    const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    writer.unref();
    const writerPid = writer.pid!;
    const writerExited = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
    try {
      db.prepare(
        "UPDATE dispatch_runs SET state = 'running', owner_pid = ?, owner_token = 'live-token' WHERE id = ?",
      ).run(writerPid, failedRun.id);
      writeWorkerOwner({
        run_id: failedRun.id,
        owner_token: "live-token",
        ownership_generation: failedRun.ownership_generation,
        pid: writerPid,
        pgid: writerPid,
      });
      writeFileSync(
        join(failedRun.worktree_path, ".worktree.lock"),
        JSON.stringify({ runId: failedRun.id, branch: failedRun.branch, pid: writerPid }),
      );

      const restarted = makeService({ terminate: () => {}, processAlive: () => false });
      const stopped = restarted.applyControl(projectId, firstRunId, {
        action: "stop",
        actor: "operator",
        reason: "terminate stuck writer",
      });
      expect(stopped.confirmed).toBe(false);
      expect(stopped.control.status).toBe("stopping");
      expect(stopped.detail).toContain("termination");

      // The run cannot be released while the detached group may still write.
      expect(() => restarted.reconcileRun(projectId, firstRunId)).toThrowError(
        /live builder process group/,
      );
      expect(() =>
        restarted.applyControl(projectId, firstRunId, {
          action: "takeover",
          actor: "operator",
          reason: "new coordinator",
        }),
      ).toThrowError(/may still be writing/);
      expect(restarted.getRun(projectId, firstRunId).state).toBe("running");

      // A failed stop is still shown as unconfirmed, never as stopped.
      expect(restarted.getRunDetail(projectId, firstRunId).control?.status).toBe("stopping");

      process.kill(-writerPid, "SIGKILL");
      await Promise.race([writerExited, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
      const { unlinkSync } = await import("node:fs");
      unlinkSync(resolveWorkerOwnerPath(failedRun.id));
      unlinkSync(join(failedRun.worktree_path, ".worktree.lock"));

      const released = restarted.reconcileRun(projectId, firstRunId);
      expect(released.state).toBe("reconciled");
      expect(restarted.getRunDetail(projectId, firstRunId).control?.status).toBe("stopped");
    } finally {
      try {
        process.kill(-writerPid, "SIGKILL");
      } catch {}
    }
  });

  test("B1: the scheduler skips an exhausted lowest-issue sibling and launches independent work", async () => {
    addIssue(1700, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(1701, ticketBody({ partOf: 1700, criteria: ["AC1"], coverage: "AC1" }));
    addIssue(1703, ticketBody({ partOf: 1700, criteria: ["AC2"], coverage: "AC2" }));
    const plan = await plans.importPlan(projectId, { issue_number: 1700, kind: "spec" });
    const exhaustedMember = plan.members.find((member) => member.issue_number === 1701)!;
    const eligibleMember = plan.members.find((member) => member.issue_number === 1703)!;
    const service = makeService({
      runner: async (context: DispatchRunnerContext) => {
        if (context.issue_number !== 1703) {
          return { success: false, error: "rejected cycle" };
        }
        return {
          success: true,
          headSha: commitInWorktree(context.worktree_path, "scheduler-sibling.txt"),
        };
      },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await dispatchLap(service, plan.id, exhaustedMember.work_id);
    }
    expect(
      service.getRunDetail(projectId, service.listRuns(projectId, { plan_id: plan.id })[0]!.id)
        .budget?.status,
    ).toBe("exhausted");

    const tick = await runLocalDispatchTick({ db, registry, plans, dispatch: service });
    expect(tick).toMatchObject({
      action: "launched",
      reason: "launch_successful",
      issueNumber: 1703,
    });
    const launched = service.getRun(projectId, tick.runId!);
    expect(launched.work_id).toBe(eligibleMember.work_id);
    expect(launched.lap).toBe(1);
    expect(launched.state).toBe("succeeded");

    // The exhausted ticket keeps its precise explicit refusal.
    await expect(
      service.dispatch(projectId, {
        plan_id: plan.id,
        work_id: exhaustedMember.work_id,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
  });

  test("B2: stop never signals a worker record whose owner identity is not this run", async () => {
    addIssue(1800);
    const plan = await plans.importPlan(projectId, { issue_number: 1800, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    const runId = await dispatchLap(service, plan.id, member.work_id);
    const run = service.getRun(projectId, runId);
    db.prepare("UPDATE dispatch_runs SET state = 'running' WHERE id = ?").run(runId);

    const { spawn } = await import("node:child_process");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    unrelated.unref();
    const unrelatedPid = unrelated.pid!;
    try {
      writeWorkerOwner({
        run_id: run.id,
        owner_token: "stale-foreign-token",
        ownership_generation: run.ownership_generation,
        pid: unrelatedPid,
        pgid: unrelatedPid,
      });

      // Real default terminator: a stale/foreign record must not kill the unrelated process.
      const stopped = service.applyControl(projectId, run.id, {
        action: "stop",
        actor: "operator",
        reason: "reclaim stuck writer",
        signal: "SIGTERM",
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
      expect(stopped.confirmed).toBe(false);
      expect(stopped.control.status).toBe("stopping");
      expect(stopped.detail).toContain("termination_unverified");
      expect(stopped.detail).toContain("token");
    } finally {
      try {
        process.kill(-unrelatedPid, "SIGKILL");
      } catch {}
      try {
        process.kill(unrelatedPid, "SIGKILL");
      } catch {}
    }
  });

  test("B2: a matching token with a different process start identity is PID reuse, never signalled", async () => {
    addIssue(1801);
    const plan = await plans.importPlan(projectId, { issue_number: 1801, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    const runId = await dispatchLap(service, plan.id, member.work_id);
    const run = service.getRun(projectId, runId);
    db.prepare("UPDATE dispatch_runs SET state = 'running' WHERE id = ?").run(runId);
    const { spawn } = await import("node:child_process");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    unrelated.unref();
    const pid = unrelated.pid!;
    const signaled: Array<{ pid: number | null; pgid: number | null }> = [];
    try {
      writeWorkerOwner({
        run_id: run.id,
        owner_token: run.owner_token,
        ownership_generation: run.ownership_generation,
        pid,
        pgid: pid,
        process_start: "Mon Jan  1 00:00:00 1990",
      });
      const spy = makeService({
        processAlive: () => false,
        terminate: (target: Parameters<DispatchTerminator>[0]) => {
          signaled.push(target);
        },
      });
      const stopped = spy.applyControl(projectId, run.id, {
        action: "stop",
        actor: "operator",
        reason: "pid reuse guard",
      });
      expect(signaled).toEqual([]);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(stopped.confirmed).toBe(false);
      expect(stopped.detail).toContain("process_identity");
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });

  test("B2: an unreadable worker record is unknown and is never signalled", async () => {
    addIssue(1802);
    const plan = await plans.importPlan(projectId, { issue_number: 1802, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    const runId = await dispatchLap(service, plan.id, member.work_id);
    const run = service.getRun(projectId, runId);
    db.prepare("UPDATE dispatch_runs SET state = 'running' WHERE id = ?").run(runId);
    writeWorkerOwner({
      run_id: run.id,
      owner_token: run.owner_token,
      ownership_generation: run.ownership_generation,
      pid: 1,
      pgid: 1,
    });
    writeFileSync(resolveWorkerOwnerPath(run.id), "{ not valid json");
    const signaled: unknown[] = [];
    const spy = makeService({
      terminate: (target: Parameters<DispatchTerminator>[0]) => {
        signaled.push(target);
      },
    });
    try {
      const stopped = spy.applyControl(projectId, run.id, {
        action: "stop",
        actor: "operator",
        reason: "unreadable owner",
      });
      expect(signaled).toEqual([]);
      expect(stopped.confirmed).toBe(false);
      expect(stopped.detail).toContain("unreadable");
    } finally {
      unlinkSync(resolveWorkerOwnerPath(run.id));
    }
  });

  test("B3: takeover terminalizes the stale run so public reconcile and the next numbered dispatch work", async () => {
    addIssue(1900);
    const plan = await plans.importPlan(projectId, { issue_number: 1900, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    const runId = await dispatchLap(service, plan.id, member.work_id);
    const original = service.getRun(projectId, runId);
    const deadPid = await deadProcessPid();
    db.prepare(
      "UPDATE dispatch_runs SET state = 'interrupted', owner_pid = ?, error = 'owner_process_gone_pending_reconciliation' WHERE id = ?",
    ).run(deadPid, runId);
    writeWorkerOwner({
      run_id: runId,
      owner_token: original.owner_token,
      ownership_generation: original.ownership_generation,
      pid: deadPid,
      pgid: deadPid,
    });
    expect(existsSync(resolveWorkerOwnerPath(runId))).toBe(true);

    const liveCoordinator = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      ownerPid: () => process.pid,
      runner: async () => ({ success: false, error: "rejected cycle" }),
    });
    const taken = liveCoordinator.applyControl(projectId, runId, {
      action: "takeover",
      actor: "operator",
      reason: "prior coordinator confirmed dead",
    });
    expect(taken.confirmed).toBe(true);
    expect(taken.run.state).toBe("reconciled");
    expect(taken.run.owner_pid).toBeNull();
    expect(taken.run.ownership_generation).toBeGreaterThan(original.ownership_generation);
    expect(taken.run.owner_token).not.toBe(original.owner_token);
    expect(taken.control.status).toBe("active");
    expect(taken.budget?.consumedAttempts).toBe(1);
    expect(existsSync(resolveWorkerOwnerPath(runId))).toBe(false);

    // Public reconcile sees no active run to retain, and the next numbered lap dispatches.
    expect(liveCoordinator.reconcile(projectId).retained).toEqual([]);
    const nextId = await dispatchLap(liveCoordinator, plan.id, member.work_id);
    expect(liveCoordinator.getRun(projectId, nextId).lap).toBe(2);
  });

  test("B3: takeover preserves an exhausted budget instead of silently resetting it", async () => {
    addIssue(1901);
    const plan = await plans.importPlan(projectId, { issue_number: 1901, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await dispatchLap(service, plan.id, member.work_id);
    }
    const [latest] = service.listRuns(projectId, { plan_id: plan.id });
    const deadPid = await deadProcessPid();
    db.prepare(
      "UPDATE dispatch_runs SET state = 'interrupted', owner_pid = ?, error = 'owner_process_gone_pending_reconciliation' WHERE id = ?",
    ).run(deadPid, latest!.id);

    const liveCoordinator = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      ownerPid: () => process.pid,
      runner: async () => ({ success: false, error: "rejected cycle" }),
    });
    const taken = liveCoordinator.applyControl(projectId, latest!.id, {
      action: "takeover",
      actor: "operator",
      reason: "recover exhausted work",
    });
    expect(taken.run.state).toBe("reconciled");
    expect(taken.budget?.status).toBe("exhausted");
    await expect(
      liveCoordinator.dispatch(projectId, {
        plan_id: plan.id,
        work_id: member.work_id,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
  });

  test("B3: failed termination stays stopping and only reconciliation releases it", async () => {
    addIssue(1902);
    const plan = await plans.importPlan(projectId, { issue_number: 1902, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    const runId = await dispatchLap(service, plan.id, member.work_id);
    const run = service.getRun(projectId, runId);
    db.prepare("UPDATE dispatch_runs SET state = 'running' WHERE id = ?").run(runId);
    const { spawn } = await import("node:child_process");
    const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    writer.unref();
    const writerPid = writer.pid!;
    const exited = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
    try {
      writeWorkerOwner({
        run_id: run.id,
        owner_token: run.owner_token,
        ownership_generation: run.ownership_generation,
        pid: writerPid,
        pgid: writerPid,
      });
      writeFileSync(
        join(run.worktree_path, ".worktree.lock"),
        JSON.stringify({ runId: run.id, branch: run.branch, pid: writerPid }),
      );
      const restarted = makeService({
        processAlive: () => false,
        terminate: () => {
          throw new Error("kill denied");
        },
      });
      const stopped = restarted.applyControl(projectId, run.id, {
        action: "stop",
        actor: "operator",
        reason: "failed signal",
      });
      expect(stopped.confirmed).toBe(false);
      expect(stopped.control.status).toBe("stopping");
      expect(stopped.detail).toContain("termination_error");

      process.kill(-writerPid, "SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      unlinkSync(resolveWorkerOwnerPath(run.id));
      unlinkSync(join(run.worktree_path, ".worktree.lock"));
      const released = restarted.reconcileRun(projectId, run.id);
      expect(released.state).toBe("reconciled");
      expect(restarted.getRunDetail(projectId, run.id).control?.status).toBe("stopped");
    } finally {
      try {
        process.kill(-writerPid, "SIGKILL");
      } catch {}
    }
  });

  test("B3: a delayed result from a taken-over run is fenced instead of overwriting recovery", async () => {
    addIssue(1903);
    const plan = await plans.importPlan(projectId, { issue_number: 1903, kind: "standalone" });
    const member = plan.members[0]!;
    const deadPid = await deadProcessPid();
    const pendingResult = deferred<{ success: boolean; headSha?: string }>();
    const owner = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      ownerPid: () => deadPid,
      processAlive: () => false,
      runner: async () => pendingResult.promise,
    });
    const pending = owner
      .dispatch(projectId, {
        plan_id: plan.id,
        work_id: member.work_id,
        actor: "operator",
      })
      .then(
        (run) => ({ ok: true as const, run }),
        (error) => ({ ok: false as const, error }),
      );
    await waitForRunningRun(owner, plan.id);
    const running = owner.listRuns(projectId, { plan_id: plan.id })[0]!;
    const lateHead = commitInWorktree(running.worktree_path, "late-result.txt");

    const taker = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      ownerPid: () => process.pid,
      processAlive: () => false,
      runner: async () => ({ success: false, error: "rejected cycle" }),
    });
    const taken = taker.applyControl(projectId, running.id, {
      action: "takeover",
      actor: "operator",
      reason: "recover before the old runner returns",
    });
    expect(taken.run.state).toBe("reconciled");

    pendingResult.resolve({ success: true, headSha: lateHead });
    const outcome = await pending;
    if (outcome.ok) throw new Error("the delayed runner unexpectedly committed");
    expect((outcome.error as { code?: string }).code).toBe("stale_worker");
    expect(taker.getRun(projectId, running.id).state).toBe("reconciled");
  });

  test("S1: a rejected final check/review marks the ticket exhausted immediately", async () => {
    addIssue(2000);
    const plan = await plans.importPlan(projectId, { issue_number: 2000, kind: "standalone" });
    const member = plan.members[0]!;
    register("reviewer-1", "peer_reviewer");
    const service = makeService({ runner: committingRunner() });
    let lastRunId = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const run = await service.dispatch(projectId, {
        plan_id: plan.id,
        work_id: member.work_id,
        actor: "operator",
      });
      lastRunId = run.id;
      observations.recordRunObservation(projectId, run.id, {
        stage: "independent_review",
        status: "failed",
        producer: { id: "reviewer-1", role: "peer_reviewer" },
        checks: [{ name: "review", command: "review diff", result: "FAIL", detail: "rejected" }],
        findings: [
          {
            severity: "blocking",
            acKey: "AC1",
            fileContext: "apps/backend/src/example.ts:42",
            summary: `review rejection ${attempt}`,
          },
        ],
      });
    }
    const detail = service.getRunDetail(projectId, lastRunId);
    expect(detail.budget).toMatchObject({ status: "exhausted", remainingAttempts: 0 });
    expect(detail.budget?.lastRejection).toBe("rejected_observation");
    expect(detail.acceptance.reasons).toContain("budget_exhausted");
  });

  test("S2: reusing a grant idempotency key with a changed payload conflicts and records failure", async () => {
    addIssue(2001);
    const plan = await plans.importPlan(projectId, { issue_number: 2001, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService();
    const runId = await dispatchLap(service, plan.id, member.work_id);

    const first = service.grantBudget(projectId, runId, {
      amount: 1,
      reason: "one more attempt",
      actor: "operator",
      idempotency_key: "grant-shared-key",
    });
    const allowed = first.budget.allowedAttempts;
    expect(() =>
      service.grantBudget(projectId, runId, {
        amount: 5,
        reason: "different payload",
        actor: "another-operator",
        idempotency_key: "grant-shared-key",
      }),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));

    expect(service.listGrants(projectId, { runId })).toHaveLength(1);
    expect(service.getRunDetail(projectId, runId).budget?.allowedAttempts).toBe(allowed);
    const failed = ledger
      .listCommands({ projectId, state: "failed" })
      .filter((command) => command.action === "budget_grant");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.target).toMatchObject({ amount: 5, reason: "different payload" });

    const replay = service.grantBudget(projectId, runId, {
      amount: 1,
      reason: "one more attempt",
      actor: "operator",
      idempotency_key: "grant-shared-key",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.budget.allowedAttempts).toBe(allowed);
    const replayCommand = ledger.getCommand(replay.commandRequestId);
    expect(replayCommand?.state).toBe("succeeded");
    expect(JSON.stringify(replayCommand?.outcome)).toContain(
      `idempotent_replay:${first.commandRequestId}`,
    );
  });
});
