import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  runLocalDispatchTick,
  resolveWorkerOwnerPath,
  writeWorkerOwner,
  type DispatchRunner,
} from "../../apps/backend/src/dispatch";

const REPO = "owner/repo";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function ticketBody(
  options: {
    partOf?: number | null;
    dependsOn?: number[];
    criteria?: string[];
    coverage?: string;
  } = {},
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("local dispatch ownership and frozen execution", () => {
  let root: string;
  let dbPath: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let projectId: string;
  let checkoutPath: string;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-dispatch-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    writeExecutionAuthority("local");
    dbPath = join(root, "state", "console.db");
    db = initializeDatabase(dbPath);
    forge = new SyntheticForgeAdapter({ [REPO]: 991 });
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
    body: string,
    labels: string[] = ["ready-for-agent"],
    state = "OPEN",
  ) {
    forge.addIssue(REPO, {
      number,
      title: `Issue ${number}`,
      body,
      state,
      labels: labels.map((name) => ({ name })),
      comments: [],
    });
  }

  function writeSchedule(config: Record<string, unknown>) {
    mkdirSync(join(checkoutPath, ".factory"), { recursive: true });
    writeFileSync(join(checkoutPath, ".factory", "schedule.json"), JSON.stringify(config));
  }

  function makeService(options: Partial<ConstructorParameters<typeof DispatchService>[1]>) {
    return new DispatchService(db, {
      plans,
      ledger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      ...options,
    });
  }

  function commitInWorktree(worktreePath: string, name: string): string {
    writeFileSync(join(worktreePath, name), "implemented\n");
    git(worktreePath, "add", name);
    git(worktreePath, "commit", "-q", "-m", `implement ${name}`);
    return git(worktreePath, "rev-parse", "HEAD");
  }

  test("AC1/AC2: spec dispatch consumes the frozen revision and manifest target, never rebinding GitHub", async () => {
    addIssue(100, specBody(["parent first", "parent second"]), ["ready-for-agent", "spec"]);
    addIssue(101, ticketBody({ partOf: 100, coverage: "AC1" }));
    addIssue(102, ticketBody({ partOf: 100, coverage: "AC2", dependsOn: [101] }));
    const plan = await plans.importPlan(projectId, { issue_number: 100, kind: "spec" });
    expect(plan.authority).toBe("admitted");
    const child = plan.members.find((member) => member.issue_number === 101)!;
    const parent = plan.members.find((member) => member.issue_number === 100)!;

    // Live GitHub changes after admission must not be consulted.
    forge.addIssue(REPO, {
      number: 101,
      title: "Edited after admission",
      body: ticketBody({ partOf: 100, dependsOn: [102] }),
      state: "OPEN",
      labels: [{ name: "needs-human" }],
      comments: [{ id: "1", author: "x", body: "manual comment" }],
    });

    const calls: any[] = [];
    const runner: DispatchRunner = async (context) => {
      calls.push(context);
      const persisted = db
        .prepare("SELECT state FROM commands WHERE request_id = ?")
        .get(context.command_request_id) as { state: string } | undefined;
      expect(["dispatched", "running"]).toContain(persisted?.state);
      const head = commitInWorktree(context.worktree_path, "child-101.txt");
      return { success: true, headSha: head };
    };
    const service = makeService({ runner });

    const run = await service.dispatch(projectId, { plan_id: plan.id, actor: "test" });

    expect(run.state).toBe("succeeded");
    expect(run.issue_number).toBe(101);
    expect(run.revision_id).toBe(child.revision_id);
    expect(run.content_hash).toBe(child.content_hash);
    expect(run.gate_profile).toBe("child");
    expect(run.merge_policy).toBe("auto_after_gates");
    expect(run.target_branch).toBe("factory/spec-100-integration");
    expect(run.branch).toBe("factory/spec-100/ticket-101");
    expect(existsSync(run.worktree_path)).toBe(true);
    expect(git(checkoutPath, "rev-parse", "--verify", "factory/spec-100/ticket-101")).toBe(
      run.head_sha,
    );

    expect(calls).toHaveLength(1);
    // Frozen body preserves the admission-time dependency set, not the live edit.
    expect(calls[0].contract.rawBody).toContain("Depends on: None");
    expect(calls[0].contract.rawBody).not.toContain("needs-human");

    const reloaded = plans.getPlan(projectId, plan.id);
    expect(reloaded.accepted_revision?.revision_id).toBe(plan.accepted_revision?.revision_id);
    expect(reloaded.accepted_revision?.content_hash).toBe(plan.accepted_revision?.content_hash);

    await expect(
      service.dispatch(projectId, { plan_id: plan.id, work_id: parent.work_id, actor: "test" }),
    ).rejects.toMatchObject({ code: "parent_not_dispatchable" });
  });

  test("AC2: standalone delivery uses the standalone profile and a manual merge policy", async () => {
    addIssue(300, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 300, kind: "standalone" });
    const member = plan.members[0]!;
    const service = makeService({
      runner: async (context) => ({
        success: true,
        headSha: commitInWorktree(context.worktree_path, "standalone.txt"),
      }),
    });

    const run = await service.dispatch(projectId, { plan_id: plan.id, actor: "test" });
    expect(run.issue_number).toBe(300);
    expect(run.revision_id).toBe(member.revision_id);
    expect(run.gate_profile).toBe("standalone");
    expect(run.merge_policy).toBe("manual");
    expect(run.target_branch).toBe("main");
    expect(run.branch).toBe("factory/standalone-300");
  });

  test("AC3: competing dispatches atomically allocate one claim and persist the command before tools", async () => {
    writeSchedule({ parallel: 2 });
    addIssue(310, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 310, kind: "standalone" });

    const started = deferred<void>();
    const release = deferred<void>();
    const runner: DispatchRunner = async (context) => {
      started.resolve();
      await release.promise;
      return { success: true, headSha: commitInWorktree(context.worktree_path, "race.txt") };
    };
    const first = makeService({ runner });
    const secondDb = initializeDatabase(dbPath);
    const second = new DispatchService(secondDb, {
      plans: new PlanService(secondDb, forge),
      ledger: new CommandLedger(secondDb),
      brakes: new BrakeService(secondDb),
      processAlive: () => true,
      ownerPid: () => 4243,
      runner,
    });

    const firstDispatch = first.dispatch(projectId, { plan_id: plan.id, actor: "first" });
    await started.promise;

    await expect(
      second.dispatch(projectId, { plan_id: plan.id, actor: "second" }),
    ).rejects.toMatchObject({ code: "claim_conflict" });

    release.resolve();
    const won = await firstDispatch;
    expect(won.state).toBe("succeeded");

    const active = db
      .prepare(
        "SELECT COUNT(*) AS count FROM dispatch_runs WHERE state IN ('claimed','dispatched','running')",
      )
      .get() as { count: number };
    expect(active.count).toBe(0);
    const deliveries = db.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as {
      count: number;
    };
    expect(deliveries.count).toBe(1);
    secondDb.close();
  });

  test("AC3: failed command persistence cannot launch tools or return success", async () => {
    addIssue(320, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 320, kind: "standalone" });
    let ran = false;
    const service = new DispatchService(db, {
      plans,
      brakes,
      ledger: {
        recordBeforeDispatch: () => {
          throw new Error("sqlite unavailable");
        },
        recordRejection: () => {
          throw new Error("sqlite unavailable");
        },
        updateOutcome: () => {
          throw new Error("sqlite unavailable");
        },
        markReconciled: () => {
          throw new Error("sqlite unavailable");
        },
      } as unknown as CommandLedger,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: async () => {
        ran = true;
        return { success: true };
      },
    });

    await expect(
      service.dispatch(projectId, { plan_id: plan.id, actor: "test" }),
    ).rejects.toMatchObject({ code: "storage_failed" });
    expect(ran).toBe(false);
    const runs = db.prepare("SELECT COUNT(*) AS count FROM dispatch_runs").get() as {
      count: number;
    };
    expect(runs.count).toBe(0);
  });

  test("AC3: a late result from a superseded ownership generation is fenced", async () => {
    addIssue(330, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 330, kind: "standalone" });
    const started = deferred<string>();
    const release = deferred<void>();
    const service = makeService({
      runner: async (context) => {
        started.resolve(context.run_id);
        await release.promise;
        return { success: true, headSha: commitInWorktree(context.worktree_path, "late.txt") };
      },
    });

    const pending = service.dispatch(projectId, { plan_id: plan.id, actor: "old" });
    const runId = await started.promise;
    db.prepare(
      "UPDATE dispatch_runs SET ownership_generation = ownership_generation + 1, owner_token = 'newer-token' WHERE id = ?",
    ).run(runId);
    release.resolve();

    await expect(pending).rejects.toMatchObject({ code: "stale_worker" });
    const row = db.prepare("SELECT state, head_sha FROM dispatch_runs WHERE id = ?").get(runId) as {
      state: string;
      head_sha: string | null;
    };
    expect(row.state).toBe("running");
    expect(row.head_sha).toBeNull();
    // A fenced result must not leave a stage observation behind either.
    const observations = db
      .prepare("SELECT COUNT(*) AS count FROM execution_observations WHERE run_id = ?")
      .get(runId) as { count: number };
    expect(observations.count).toBe(0);
  });

  test("AC4: restart keeps interrupted ownership; lease expiry alone never frees the claim", async () => {
    addIssue(340, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 340, kind: "standalone" });
    const failed = makeService({
      runner: async () => ({ success: false, error: "simulated crash" }),
    });
    await expect(
      failed.dispatch(projectId, { plan_id: plan.id, actor: "first" }),
    ).rejects.toMatchObject({ code: "dispatch_failed" });
    const firstRun = failed.listRuns(projectId)[0]!;
    expect(firstRun.state).toBe("failed");

    // Simulate a process that died mid-run during a previous host lifetime.
    const delivery = db
      .prepare("SELECT * FROM deliveries WHERE project_id = ? AND plan_id = ?")
      .get(projectId, plan.id) as any;
    const interruptedId = "run_interrupted";
    db.prepare(
      `INSERT INTO dispatch_runs (
        id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash, issue_number,
        role, gate_profile, merge_policy, target_branch, ownership_generation, lap, state, actor,
        command_request_id, branch, worktree_path, base_sha, owner_pid, owner_token,
        lease_expires_at, head_sha, error, launched_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
    ).run(
      interruptedId,
      projectId,
      delivery.id,
      plan.id,
      firstRun.work_id,
      firstRun.revision_id,
      firstRun.content_hash,
      firstRun.issue_number,
      firstRun.role,
      firstRun.gate_profile,
      firstRun.merge_policy,
      firstRun.target_branch,
      2,
      2,
      "crashed-host",
      "cmd_interrupted",
      firstRun.branch,
      firstRun.worktree_path,
      firstRun.base_sha,
      99999999,
      "dead-token",
      1,
      Date.now() - 10_000,
      Date.now(),
      Date.now(),
    );

    const restarted = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      processAlive: () => false,
      ownerPid: () => 5555,
      runner: async (context) => ({
        success: true,
        headSha: commitInWorktree(context.worktree_path, "restart.txt"),
      }),
    });

    const reconciled = restarted.reconcile(projectId);
    expect(reconciled.retained.map((run) => run.id)).toContain(interruptedId);
    const interrupted = restarted.getRun(projectId, interruptedId);
    expect(interrupted.state).toBe("interrupted");

    // Lease is long expired, yet a competing dispatch still cannot start.
    await expect(
      restarted.dispatch(projectId, { plan_id: plan.id, actor: "competitor" }),
    ).rejects.toMatchObject({ code: "claim_conflict" });

    const released = restarted.reconcileRun(projectId, interruptedId);
    expect(released.state).toBe("reconciled");
    expect(released.finished_at).not.toBeNull();

    const next = await restarted.dispatch(projectId, { plan_id: plan.id, actor: "competitor" });
    expect(next.state).toBe("succeeded");
    expect(next.ownership_generation).toBeGreaterThan(released.ownership_generation);
  });

  test("AC4: checkout relocation keeps the same project-owned delivery identity", async () => {
    addIssue(350, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(351, ticketBody({ partOf: 350, coverage: "AC1" }));
    addIssue(352, ticketBody({ partOf: 350, coverage: "AC2" }));
    const plan = await plans.importPlan(projectId, { issue_number: 350, kind: "spec" });
    const service = makeService({
      runner: async (context) => ({
        success: true,
        headSha: commitInWorktree(context.worktree_path, `ticket-${context.issue_number}.txt`),
      }),
    });

    const first = await service.dispatch(projectId, { plan_id: plan.id, actor: "test" });
    const moved = join(root, "checkout-moved");
    symlinkSync(checkoutPath, moved);
    db.prepare("UPDATE projects SET checkout_path = ? WHERE id = ?").run(moved, projectId);

    service.reconcile(projectId);
    const second = await service.dispatch(projectId, { plan_id: plan.id, actor: "test" });
    expect(second.delivery_id).toBe(first.delivery_id);
    expect(second.issue_number).not.toBe(first.issue_number);
  });

  test("AC1: brakes, capacity and holds block dispatch before tools and are audited", async () => {
    writeSchedule({ parallel: 1 });
    addIssue(360, ticketBody({}));
    addIssue(361, ticketBody({}));
    const planA = await plans.importPlan(projectId, { issue_number: 360, kind: "standalone" });
    const planB = await plans.importPlan(projectId, { issue_number: 361, kind: "standalone" });

    const started = deferred<void>();
    const release = deferred<void>();
    const service = makeService({
      runner: async (context) => {
        started.resolve();
        await release.promise;
        return { success: true, headSha: commitInWorktree(context.worktree_path, "capacity.txt") };
      },
    });

    const pending = service.dispatch(projectId, { plan_id: planA.id, actor: "first" });
    await started.promise;
    await expect(
      service.dispatch(projectId, { plan_id: planB.id, actor: "second" }),
    ).rejects.toMatchObject({ code: "capacity_full" });
    release.resolve();
    await pending;

    brakes.setProjectLaunchBrake(projectId, true, "operator", "maintenance");
    const calls: string[] = [];
    const braked = makeService({
      runner: async (context) => {
        calls.push(context.run_id);
        return { success: true };
      },
    });
    await expect(
      braked.dispatch(projectId, { plan_id: planB.id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "launch_brake_set" });
    expect(calls).toHaveLength(0);
    expect(braked.listRuns(projectId, { plan_id: planB.id })).toHaveLength(0);

    brakes.setProjectLaunchBrake(projectId, false, "operator");
    brakes.setProjectSchedulePause(projectId, true, "operator", "paused");
    await expect(
      braked.dispatch(projectId, { plan_id: planB.id, actor: "scheduler", scheduled: true }),
    ).rejects.toMatchObject({ code: "schedule_paused" });
    brakes.setProjectSchedulePause(projectId, false, "operator");
  });

  test("AC1: a held plan and an unsatisfied dependency cannot dispatch", async () => {
    addIssue(370, specBody(["only"]), ["ready-for-agent", "spec"]);
    const held = await plans.importPlan(projectId, { issue_number: 370, kind: "spec" });
    const service = makeService({
      runner: async (context) => ({
        success: true,
        headSha: commitInWorktree(context.worktree_path, "dependency.txt"),
      }),
    });
    await expect(
      service.dispatch(projectId, { plan_id: held.id, actor: "test" }),
    ).rejects.toMatchObject({ code: "plan_not_dispatchable" });

    addIssue(380, specBody(["parent first", "parent second"]), ["ready-for-agent", "spec"]);
    addIssue(381, ticketBody({ partOf: 380, coverage: "AC1" }));
    addIssue(382, ticketBody({ partOf: 380, coverage: "AC2", dependsOn: [381] }));
    const spec = await plans.importPlan(projectId, { issue_number: 380, kind: "spec" });
    const dep = spec.members.find((member) => member.issue_number === 382)!;
    await expect(
      service.dispatch(projectId, { plan_id: spec.id, work_id: dep.work_id, actor: "test" }),
    ).rejects.toMatchObject({ code: "dependency_pending_integration" });

    // Prove completion is verified against the frozen integration target, not an arbitrary branch.
    const tree = git(checkoutPath, "rev-parse", "HEAD^{tree}");
    const unrelatedCommit = git(
      checkoutPath,
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      "unrelated integration for 381",
    );
    git(checkoutPath, "branch", "unrelated/380", unrelatedCommit);
    const integrationCommit = git(
      checkoutPath,
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      "integrate 381",
    );
    git(checkoutPath, "branch", "factory/spec-380-integration", integrationCommit);
    db.prepare(
      `INSERT INTO project_issue_integrations (project_id, issue_number, branch, commit_sha, integrated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(projectId, 381, "unrelated/380", unrelatedCommit, new Date().toISOString());

    // Recorded on an unrelated branch: still pending against the frozen target.
    await expect(
      service.dispatch(projectId, { plan_id: spec.id, work_id: dep.work_id, actor: "test" }),
    ).rejects.toMatchObject({ code: "dependency_pending_integration" });

    db.prepare(
      "UPDATE project_issue_integrations SET branch = ?, commit_sha = ? WHERE project_id = ? AND issue_number = ?",
    ).run("factory/spec-380-integration", integrationCommit, projectId, 381);
    const run = await service.dispatch(projectId, {
      plan_id: spec.id,
      work_id: dep.work_id,
      actor: "test",
    });
    expect(run.issue_number).toBe(382);
  });

  test("AC5: the local scheduler tick dispatches admitted plans without live GitHub calls", async () => {
    addIssue(390, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 390, kind: "standalone" });
    forge.listIssues = async () => {
      throw new Error("live GitHub must not be consulted");
    };
    const service = makeService({
      runner: async (context) => ({
        success: true,
        headSha: commitInWorktree(context.worktree_path, "scheduler.txt"),
      }),
    });

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch: service,
      actor: "scheduler",
    });
    expect(tick.action).toBe("launched");
    expect(tick.planId).toBe(plan.id);
    expect(tick.runId).toBeTruthy();
    expect(service.listRuns(projectId)).toHaveLength(1);

    const second = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch: service,
      actor: "scheduler",
    });
    expect(second.action).toBe("skipped");
  });

  test("AC5: dispatch failure preserves a real failure state and never reports success", async () => {
    addIssue(395, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 395, kind: "standalone" });
    const service = makeService({
      runner: async () => ({ success: false, error: "model transport refused" }),
    });
    await expect(
      service.dispatch(projectId, { plan_id: plan.id, actor: "test" }),
    ).rejects.toMatchObject({ code: "dispatch_failed" });
    const [run] = service.listRuns(projectId);
    expect(run.state).toBe("failed");
    expect(run.error).toContain("model transport refused");
    expect(run.finished_at).not.toBeNull();
    const command = ledger.getCommand(run.command_request_id);
    expect(command?.state).toBe("failed");
  });

  test("AC3: worktree allocation failure cannot launch tools", async () => {
    addIssue(396, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 396, kind: "standalone" });
    let ran = false;
    const service = makeService({
      worktreeAllocator: () => {
        throw new Error("git worktree add failed");
      },
      runner: async () => {
        ran = true;
        return { success: true };
      },
    });
    await expect(
      service.dispatch(projectId, { plan_id: plan.id, actor: "test" }),
    ).rejects.toMatchObject({ code: "worktree_allocation_failed" });
    expect(ran).toBe(false);
    const [run] = service.listRuns(projectId);
    expect(run.state).toBe("failed");
  });

  test("AC4/B2: reconciliation retains a live detached builder writer and releases only after it dies", async () => {
    addIssue(400, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 400, kind: "standalone" });
    const first = makeService({
      runner: async () => ({ success: false, error: "coordinator crashed" }),
    });
    await expect(
      first.dispatch(projectId, { plan_id: plan.id, actor: "first" }),
    ).rejects.toMatchObject({ code: "dispatch_failed" });
    const failedRun = first.listRuns(projectId)[0]!;

    const delivery = db
      .prepare("SELECT * FROM deliveries WHERE project_id = ? AND plan_id = ?")
      .get(projectId, plan.id) as any;
    const interruptedId = "run_live_detached_writer";
    db.prepare(
      `INSERT INTO dispatch_runs (
        id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash, issue_number,
        role, gate_profile, merge_policy, target_branch, ownership_generation, lap, state, actor,
        command_request_id, branch, worktree_path, base_sha, owner_pid, owner_token,
        lease_expires_at, head_sha, error, launched_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
    ).run(
      interruptedId,
      projectId,
      delivery.id,
      plan.id,
      failedRun.work_id,
      failedRun.revision_id,
      failedRun.content_hash,
      failedRun.issue_number,
      failedRun.role,
      failedRun.gate_profile,
      failedRun.merge_policy,
      failedRun.target_branch,
      2,
      2,
      "crashed-host",
      "cmd_live_writer",
      failedRun.branch,
      failedRun.worktree_path,
      failedRun.base_sha,
      99999998,
      "dead-token",
      Date.now() + 60_000,
      Date.now(),
      Date.now(),
      Date.now(),
    );

    // A real detached process group that would keep writing the worktree.
    const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    writer.unref();
    const writerPid = writer.pid!;
    const writerExited = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
    try {
      writeWorkerOwner({
        run_id: interruptedId,
        owner_token: "dead-token",
        pid: writerPid,
        pgid: writerPid,
      });
      writeFileSync(
        join(failedRun.worktree_path, ".worktree.lock"),
        JSON.stringify({ runId: interruptedId, branch: failedRun.branch, pid: writerPid }),
      );

      const restarted = new DispatchService(db, {
        plans,
        ledger,
        brakes,
        processAlive: () => false,
        ownerPid: () => 5556,
        runner: async () => ({ success: true }),
      });

      expect(() => restarted.reconcileRun(projectId, interruptedId)).toThrowError(
        /live builder process group/,
      );
      expect(restarted.getRun(projectId, interruptedId).state).toBe("running");

      process.kill(-writerPid, "SIGKILL");
      await Promise.race([writerExited, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);

      // An unreadable ownership record is unknown, not absent: keep the claim.
      const ownerPath = resolveWorkerOwnerPath(interruptedId);
      writeFileSync(ownerPath, "{ not valid json");
      expect(() => restarted.reconcileRun(projectId, interruptedId)).toThrowError(
        /unreadable worker ownership/,
      );
      expect(restarted.getRun(projectId, interruptedId).state).toBe("running");
      unlinkSync(ownerPath);

      const released = restarted.reconcileRun(projectId, interruptedId);
      expect(released.state).toBe("reconciled");
    } finally {
      try {
        process.kill(-writerPid, "SIGKILL");
      } catch {}
    }
  });

  test("AC3/AC1: capacity is re-evaluated inside the claim transaction across plans and processes", async () => {
    writeSchedule({ parallel: 1 });
    addIssue(410, ticketBody({}));
    addIssue(411, ticketBody({}));
    const planA = await plans.importPlan(projectId, { issue_number: 410, kind: "standalone" });
    const planB = await plans.importPlan(projectId, { issue_number: 411, kind: "standalone" });

    const secondDb = initializeDatabase(dbPath);
    const release = deferred<void>();
    const competitor = new DispatchService(secondDb, {
      plans: new PlanService(secondDb, forge),
      ledger: new CommandLedger(secondDb),
      brakes: new BrakeService(secondDb),
      processAlive: () => true,
      ownerPid: () => 4244,
      runner: async (context) => {
        await release.promise;
        return {
          success: true,
          headSha: commitInWorktree(context.worktree_path, "competitor.txt"),
        };
      },
    });

    let competitorStarted = false;
    const racingLedger = {
      recordBeforeDispatch: (input: Parameters<CommandLedger["recordBeforeDispatch"]>[0]) => {
        ledger.recordBeforeDispatch(input);
        if (!competitorStarted) {
          competitorStarted = true;
          // Another process claims a different plan after this validation point.
          void competitor.dispatch(projectId, { plan_id: planB.id, actor: "competitor" });
        }
      },
      recordRejection: ledger.recordRejection.bind(ledger),
      updateOutcome: ledger.updateOutcome.bind(ledger),
      markReconciled: ledger.markReconciled.bind(ledger),
    } as unknown as CommandLedger;

    const first = new DispatchService(db, {
      plans,
      ledger: racingLedger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: async () => ({ success: true }),
    });

    await expect(
      first.dispatch(projectId, { plan_id: planA.id, actor: "first" }),
    ).rejects.toMatchObject({ code: "capacity_full" });
    expect(competitorStarted).toBe(true);

    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const active = db
      .prepare(
        "SELECT COUNT(*) AS count FROM dispatch_runs WHERE state IN ('claimed','dispatched','running','interrupted')",
      )
      .get() as { count: number };
    expect(active.count).toBe(0);
    const runs = db.prepare("SELECT COUNT(*) AS count FROM dispatch_runs").get() as {
      count: number;
    };
    expect(runs.count).toBe(1);
    secondDb.close();
  });

  test("AC3/AC1: a brake applied after validation aborts the claim", async () => {
    addIssue(420, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 420, kind: "standalone" });
    const secondDb = initializeDatabase(dbPath);
    const secondBrakes = new BrakeService(secondDb);

    let ran = false;
    const brakingLedger = {
      recordBeforeDispatch: (input: Parameters<CommandLedger["recordBeforeDispatch"]>[0]) => {
        ledger.recordBeforeDispatch(input);
        secondBrakes.setProjectLaunchBrake(projectId, true, "operator", "maintenance");
      },
      recordRejection: ledger.recordRejection.bind(ledger),
      updateOutcome: ledger.updateOutcome.bind(ledger),
      markReconciled: ledger.markReconciled.bind(ledger),
    } as unknown as CommandLedger;

    const service = new DispatchService(db, {
      plans,
      ledger: brakingLedger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: async (context) => {
        ran = true;
        return { success: true, headSha: commitInWorktree(context.worktree_path, "brake.txt") };
      },
    });

    await expect(
      service.dispatch(projectId, { plan_id: plan.id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "launch_brake_set" });
    expect(ran).toBe(false);
    expect(service.listRuns(projectId)).toHaveLength(0);
    secondDb.close();
  });

  test("AC1/AC4: revocation after validation aborts the claim", async () => {
    addIssue(430, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 430, kind: "standalone" });
    const secondDb = initializeDatabase(dbPath);
    const secondPlans = new PlanService(secondDb, forge);
    let ran = false;

    const revokingLedger = {
      recordBeforeDispatch: (input: Parameters<CommandLedger["recordBeforeDispatch"]>[0]) => {
        ledger.recordBeforeDispatch(input);
        secondPlans.revokePlan(projectId, plan.id, { actor: "operator", reason: "scope retired" });
      },
      recordRejection: ledger.recordRejection.bind(ledger),
      updateOutcome: ledger.updateOutcome.bind(ledger),
      markReconciled: ledger.markReconciled.bind(ledger),
    } as unknown as CommandLedger;

    const service = new DispatchService(db, {
      plans,
      ledger: revokingLedger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: async (context) => {
        ran = true;
        return { success: true, headSha: commitInWorktree(context.worktree_path, "revoked.txt") };
      },
    });

    await expect(
      service.dispatch(projectId, { plan_id: plan.id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "plan_not_dispatchable" });
    expect(ran).toBe(false);
    expect(service.listRuns(projectId)).toHaveLength(0);
    secondDb.close();
  });

  test("AC3: independent plans may genuinely overlap up to capacity", async () => {
    writeSchedule({ parallel: 2 });
    addIssue(440, ticketBody({}));
    addIssue(441, ticketBody({}));
    const planA = await plans.importPlan(projectId, { issue_number: 440, kind: "standalone" });
    const planB = await plans.importPlan(projectId, { issue_number: 441, kind: "standalone" });

    const startedA = deferred<void>();
    const startedB = deferred<void>();
    const release = deferred<void>();
    let running = 0;
    let maxRunning = 0;
    const runner: DispatchRunner = async (context) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (context.issue_number === 440) startedA.resolve();
      if (context.issue_number === 441) startedB.resolve();
      await release.promise;
      running -= 1;
      return {
        success: true,
        headSha: commitInWorktree(context.worktree_path, `overlap-${context.issue_number}.txt`),
      };
    };

    const service = makeService({ runner });
    const first = service.dispatch(projectId, { plan_id: planA.id, actor: "a" });
    const second = service.dispatch(projectId, { plan_id: planB.id, actor: "b" });

    await Promise.all([startedA.promise, startedB.promise]);
    expect(maxRunning).toBe(2);
    release.resolve();
    const [runA, runB] = await Promise.all([first, second]);
    expect(runA.state).toBe("succeeded");
    expect(runB.state).toBe("succeeded");
  });

  test("AC4/B2: reconciliation refuses a remote branch effect not present locally", async () => {
    addIssue(450, ticketBody({}));
    const plan = await plans.importPlan(projectId, { issue_number: 450, kind: "standalone" });
    const first = makeService({
      runner: async () => ({ success: false, error: "coordinator crashed" }),
    });
    await expect(
      first.dispatch(projectId, { plan_id: plan.id, actor: "first" }),
    ).rejects.toMatchObject({ code: "dispatch_failed" });
    const failedRun = first.listRuns(projectId)[0]!;
    const delivery = db
      .prepare("SELECT * FROM deliveries WHERE project_id = ? AND plan_id = ?")
      .get(projectId, plan.id) as any;

    const interruptedId = "run_remote_effect";
    db.prepare(
      `INSERT INTO dispatch_runs (
        id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash, issue_number,
        role, gate_profile, merge_policy, target_branch, ownership_generation, lap, state, actor,
        command_request_id, branch, worktree_path, base_sha, owner_pid, owner_token,
        lease_expires_at, head_sha, error, launched_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
    ).run(
      interruptedId,
      projectId,
      delivery.id,
      plan.id,
      failedRun.work_id,
      failedRun.revision_id,
      failedRun.content_hash,
      failedRun.issue_number,
      failedRun.role,
      failedRun.gate_profile,
      failedRun.merge_policy,
      failedRun.target_branch,
      2,
      2,
      "crashed-host",
      "cmd_remote_effect",
      failedRun.branch,
      failedRun.worktree_path,
      failedRun.base_sha,
      99999997,
      "dead-token",
      Date.now() + 60_000,
      Date.now(),
      Date.now(),
      Date.now(),
    );

    const tree = git(checkoutPath, "rev-parse", "HEAD^{tree}");
    const aheadCommit = git(
      checkoutPath,
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      "remote writer advanced",
    );
    git(checkoutPath, "update-ref", `refs/remotes/origin/${failedRun.branch}`, aheadCommit);

    const restarted = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      processAlive: () => false,
      ownerPid: () => 5557,
      runner: async () => ({ success: true }),
    });

    expect(() => restarted.reconcileRun(projectId, interruptedId)).toThrowError(
      /remote branch|effects not present locally/,
    );
    expect(restarted.getRun(projectId, interruptedId).state).toBe("running");

    git(checkoutPath, "update-ref", "-d", `refs/remotes/origin/${failedRun.branch}`);
    expect(restarted.reconcileRun(projectId, interruptedId).state).toBe("reconciled");
  });
});
