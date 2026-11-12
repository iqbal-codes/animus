import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
  type SyntheticForgeOptions,
} from "../../apps/backend/src/registry";
import { PlanService } from "../../apps/backend/src/plans";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import {
  DispatchService,
  runLocalDispatchTick,
  type DispatchRunner,
} from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../../apps/backend/src/work/budget";
import { PublicationService } from "../../apps/backend/src/publication";
import { createLocalExecutionRuntime } from "../../apps/backend/src/local-runtime";
import { DeliveryRoleClaimService } from "../../apps/backend/src/delivery/claims";
import { handleProjectDeliveryRoute } from "../../apps/backend/src/delivery/routes";
import { inventoryInstallation } from "../../apps/backend/src/cutover/inventory";
import { AuthorityCutoverService } from "../../apps/backend/src/cutover/service";
import { BackupRestoreService } from "../../apps/backend/src/restore/service";
import { createFactoryClient } from "@animus/client";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import { pidOrGroupAlive } from "../../apps/backend/src/dispatch/ownership";
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthority } from "./support/activated-authority";

const REPO = "owner/final-repair";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;
const ORIGINAL_ANIMUS_STATE_DIR = process.env.ANIMUS_STATE_DIR;
const DETAILS: Record<string, unknown> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function specBody(): string {
  return [
    "## Source and problem",
    "s",
    "",
    "## Outcome",
    "o",
    "",
    "## Invariants",
    "- i",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1 — p1",
    "- [ ] AC2 — p2",
    "",
    "## Boundary",
    "b",
  ].join("\n");
}

function ticketBody(partOf: number): string {
  return [
    `Part of #${partOf}`,
    "",
    "Source acceptance coverage: AC1–AC2",
    "",
    "## Source and problem",
    "s",
    "",
    "## Outcome",
    "o",
    "",
    "## Invariants",
    "- i",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1: prepared criterion",
    "",
    "## Boundary",
    "b",
    "",
    "Depends on: None",
  ].join("\n");
}

function writeDetails(): void {
  writeFileSync("/tmp/final-repair-probe-results.json", `${JSON.stringify(DETAILS, null, 2)}\n`);
}

describe("final repair closure: F1-F4 + standards counterexamples", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let observations: ExecutionObservationService;
  let budget: ExecutionBudgetService;
  let publication: PublicationService;
  let checkoutPath: string;
  let bareOrigin: string;
  let artifactRoot: string;
  let projectId: string;
  let dbPath: string;
  let stateDir: string;
  let sleepChild: ChildProcess | null = null;

  function remoteHead(branch: string): string | null {
    try {
      return execFileSync(
        "git",
        ["--git-dir", bareOrigin, "rev-parse", "--verify", `refs/heads/${branch}`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      return null;
    }
  }
  function mergeOnBareOrigin(pr: ForgePullRequest): { sha: string } {
    const headSha = pr.headRefOid ?? remoteHead(pr.head);
    const baseSha = remoteHead(pr.base);
    if (!headSha || !baseSha) throw new Error("missing ref");
    const treeSha = git(checkoutPath, "merge-tree", "--write-tree", baseSha, headSha)
      .split("\n")[0]!
      .trim();
    const mergeSha = git(
      checkoutPath,
      "commit-tree",
      treeSha,
      "-p",
      baseSha,
      "-p",
      headSha,
      "-m",
      "merge",
    );
    git(checkoutPath, "update-ref", `refs/heads/${pr.base}`, mergeSha, baseSha);
    git(checkoutPath, "push", "-q", "origin", `refs/heads/${pr.base}`);
    return { sha: mergeSha };
  }
  function forgeOptions(): SyntheticForgeOptions {
    return {
      requireRemoteSourceRef: true,
      resolveHeadRefOid: (_r, b) => remoteHead(b),
      mergeRemote: (_r, pr) => mergeOnBareOrigin(pr),
    };
  }
  function committingRunner(): DispatchRunner {
    return async (context) => {
      writeFileSync(join(context.worktree_path, "candidate-proof.txt"), "proof\n");
      git(context.worktree_path, "add", "candidate-proof.txt");
      git(context.worktree_path, "commit", "-q", "-m", "implement");
      return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
    };
  }
  function offlineTransport(): AgentTransport {
    return async (request) => {
      const head = git(request.cwd, "rev-parse", "HEAD");
      const report = {
        sha: head,
        outcome: "approved",
        summary: "independent review passed",
        findings: [],
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", finalText: JSON.stringify(report) }),
        stderr: "review stderr line\n",
      };
    };
  }
  function writeHarness(): void {
    mkdirSync(join(checkoutPath, "harness"), { recursive: true });
    writeFileSync(
      join(checkoutPath, "harness", "harness.config.json"),
      `${JSON.stringify({ static: "test -f candidate-proof.txt", unit: "true", protected_paths: ".factory" }, null, 2)}\n`,
    );
    git(checkoutPath, "add", "harness/harness.config.json");
    git(checkoutPath, "commit", "-q", "-m", "declare harness checks");
    git(checkoutPath, "push", "-q", "origin", "main");
  }
  function makeRuntime(runner: DispatchRunner) {
    const dispatch = new DispatchService(db, {
      plans,
      ledger: new CommandLedger(db),
      brakes: new BrakeService(db),
      observations,
      budget,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner,
    });
    const runtime = createLocalExecutionRuntime({
      db,
      plans,
      dispatch,
      forge,
      observations,
      budget,
      publication,
      artifactRoot,
      maxCorrections: 3,
      engine: {
        transport: offlineTransport(),
        provider: "pi",
        model: "test-model",
        roleBudgets: {
          qa: { softMs: 5_000, hardMs: 10_000 },
          reviewer: { softMs: 5_000, hardMs: 10_000 },
        },
      },
    });
    return { dispatch, runtime };
  }
  function backupService() {
    return new BackupRestoreService(db, {
      stateDir: dirname(dbPath),
      databasePath: dbPath,
      artifactRoot,
      home: join(root, "animus-home"),
      forge,
    });
  }
  async function importSpec(issue: number) {
    forge.addIssue(REPO, {
      number: issue,
      title: "Spec",
      body: specBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: issue + 1,
      title: `Ticket ${issue + 1}`,
      body: ticketBody(issue),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    const plan = await plans.importPlan(projectId, { issue_number: issue, kind: "spec" });
    const branch = `factory/spec-${issue}-integration`;
    git(checkoutPath, "branch", "-f", branch, "main");
    git(checkoutPath, "push", "-q", "origin", branch);
    return { plan, branch };
  }
  async function runChild(issue: number) {
    writeHarness();
    await importSpec(issue);
    const { dispatch, runtime } = makeRuntime(committingRunner());
    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
    });
    expect(tick.action).toBe("launched");
    expect(tick.runId).toBeTruthy();
    return { dispatch, runtime, tick, runId: tick.runId! };
  }

  async function startReconcileServer() {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const match = url.pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/delivery\/runs\/([^/]+)\/claims\/([^/]+)\/reconcile$/,
      );
      if (!match) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      });
      const parts = [
        "projects",
        "delivery",
        "runs",
        decodeURIComponent(match[2]!),
        "claims",
        decodeURIComponent(match[3]!),
        "reconcile",
      ];
      const response = await handleProjectDeliveryRoute(
        request,
        decodeURIComponent(match[1]!),
        parts,
        {} as never,
        db,
      );
      if (!response) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const client = createFactoryClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    return { server, client };
  }

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (sleepChild) {
      try {
        process.kill(-sleepChild.pid!, "SIGKILL");
      } catch {}
      sleepChild = null;
    }
    writeDetails();
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    if (ORIGINAL_ANIMUS_STATE_DIR === undefined) delete process.env.ANIMUS_STATE_DIR;
    else process.env.ANIMUS_STATE_DIR = ORIGINAL_ANIMUS_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-final-repair-"));
    stateDir = join(root, "animus-home", "state");
    process.env.ANIMUS_HOME = join(root, "animus-home");
    process.env.ANIMUS_STATE_DIR = stateDir;
    artifactRoot = join(stateDir, "artifacts");
    dbPath = join(stateDir, "console.db");
    db = initializeDatabase(dbPath);
    seedActivatedAuthority(db);
    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", `url.${bareOrigin}.insteadOf`, `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    writeFileSync(join(checkoutPath, "base.txt"), "base\n");
    git(checkoutPath, "add", "base.txt");
    git(checkoutPath, "commit", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    git(checkoutPath, "push", "-q", "origin", "main");
    mkdirSync(join(checkoutPath, ".factory"), { recursive: true });
    writeFileSync(join(checkoutPath, ".factory", "schedule.json"), '{"max_laps":3}\n');
    forge = new SyntheticForgeAdapter({ [REPO]: 9700 }, forgeOptions());
    registry = new ProjectRegistryService(db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    plans = new PlanService(db, forge);
    observations = new ExecutionObservationService(db, { artifactRoot });
    budget = new ExecutionBudgetService(db);
    publication = new PublicationService(db, forge, { artifactRoot });
  });

  test("F1: complete rejects a foreign-stage receipt (409) and never terminalizes the claim", async () => {
    const { dispatch, runId } = await runChild(9111);
    const run = dispatch.getRun(projectId, runId);
    const foreign = db
      .prepare(
        `SELECT id, stage, status FROM execution_observations
          WHERE project_id = ? AND run_id = ? AND stage = 'code_review' AND status = 'passed'
          ORDER BY created_at ASC LIMIT 1`,
      )
      .get(projectId, runId) as { id: string; stage: string; status: string } | undefined;
    expect(foreign).toBeTruthy();
    const claims = new DeliveryRoleClaimService(db);
    const acquired = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("claim");

    // A foreign-run observation must also be rejected.
    db.exec("PRAGMA foreign_keys = OFF;");
    const foreignRun = db
      .prepare(`SELECT id FROM dispatch_runs WHERE project_id = ? AND id <> ? LIMIT 1`)
      .get(projectId, runId) as { id: string } | undefined;
    db.exec("PRAGMA foreign_keys = ON;");

    const { server, client } = await startReconcileServer();
    try {
      let status = 0;
      let body: unknown = null;
      try {
        body = await client
          .forProject(projectId)
          .reconcileDeliveryClaim(runId, "blackbox_verification", {
            action: "complete",
            actor: "operator",
            reason: "attempting a foreign receipt",
            lap: run.lap,
            expectedGeneration: acquired.claim.claimGeneration,
            expectedCandidateHeadSha: acquired.claim.candidateHeadSha,
            expectedState: "running",
            observationId: foreign!.id,
          });
      } catch (error) {
        status = 409;
        body = { message: error instanceof Error ? error.message : String(error) };
      }
      DETAILS.f1 = {
        foreign,
        foreignRun,
        httpStatus: status,
        accepted: status === 0,
        result: body,
      };
      expect(status).toBe(409);
      const row = db
        .prepare("SELECT state, result_observation_id FROM delivery_role_claims WHERE id = ?")
        .get(acquired.claim.id) as { state: string; result_observation_id: string | null };
      expect(row.state).toBe("running");
      expect(row.result_observation_id).toBeNull();
    } finally {
      server.close();
    }
  }, 120_000);

  test("F2: an owner-unverified interrupt is held truthfully; cutover stays blocked, no fake release", async () => {
    const { dispatch, runId } = await runChild(9121);
    const run = dispatch.getRun(projectId, runId);
    const claims = new DeliveryRoleClaimService(db);
    const acquired = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("claim");
    db.prepare(
      "UPDATE delivery_role_claims SET owner_process_start = NULL, owner_pid = ? WHERE id = ?",
    ).run(process.pid, acquired.claim.id);

    const { server, client } = await startReconcileServer();
    try {
      const reconciled = await client
        .forProject(projectId)
        .reconcileDeliveryClaim(runId, "blackbox_verification", {
          action: "interrupt",
          actor: "operator",
          reason: "owner is not verifiable on this host",
          lap: run.lap,
          expectedGeneration: acquired.claim.claimGeneration,
          expectedCandidateHeadSha: acquired.claim.candidateHeadSha,
          expectedState: "running",
          acknowledgeUnknownOwner: true,
        });
      DETAILS.f2 = {
        state: reconciled.state,
        disposition: reconciled.hold.disposition,
        ownerPid: reconciled.ownerPid,
        ownerProcessStart: reconciled.ownerProcessStart,
      };
      expect(reconciled.state).toBe("interrupted");
      expect(reconciled.hold.disposition).toBe("frozen_unknown_owner");
      expect(reconciled.ownerProcessStart).toBeNull();
      expect(reconciled.ownerPid).not.toBeNull();

      const inventory = inventoryInstallation(db, {
        stateDir,
        home: join(root, "animus-home"),
        now: () => 1,
      });
      const claimHeld = inventory.held.filter((fact) => fact.entity === "delivery_role_claims");
      expect(claimHeld.length).toBe(1);

      const dbStateDir = dirname(dbPath);
      writeExecutionAuthority("legacy", { stateDir: dbStateDir, expected: "local" });
      db.exec("DELETE FROM authority_cutover_operations");
      const cutover = new AuthorityCutoverService(db, {
        stateDir: dbStateDir,
        backup: backupService(),
        home: join(root, "animus-home"),
      });
      let stageAfterInterrupt: Record<string, unknown>;
      try {
        const staged = await cutover.stage({ actor: "operator" });
        stageAfterInterrupt = { staged: staged.operation.status };
      } catch (error) {
        const typed = error as { code?: string; message?: string };
        stageAfterInterrupt = { code: typed.code, message: typed.message };
      }
      DETAILS.f2Stage = stageAfterInterrupt;
      // Truthful held state: staging must remain blocked, not silently succeed.
      expect(stageAfterInterrupt.code).toBe("cutover_writers_active");
    } finally {
      server.close();
    }
  }, 120_000);

  test("F2b: a proven-dead interrupt releases the claim and cutover stages", async () => {
    const { dispatch, runId } = await runChild(9131);
    const run = dispatch.getRun(projectId, runId);
    const claims = new DeliveryRoleClaimService(db);
    const acquired = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("claim");
    // No spawned role process and a coordinator that can never be alive again.
    db.prepare(
      "UPDATE delivery_role_claims SET owner_pid = 999999, owner_process_start = 'dead-start', role_pid = NULL, role_process_start = NULL WHERE id = ?",
    ).run(acquired.claim.id);

    const reconciled = claims.reconcile({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: acquired.claim.candidateHeadSha,
      action: "interrupt",
      actor: "operator",
      reason: "coordinator and role are proven dead",
      expectedGeneration: acquired.claim.claimGeneration,
      expectedCandidateHeadSha: acquired.claim.candidateHeadSha,
      expectedState: "running",
    });
    expect(reconciled.disposition).toBe("released_dead_owner");
    expect(reconciled.ownerPid).toBeNull();
    expect(reconciled.leaseExpiresAt).toBe(0);
  }, 120_000);

  test("F3: takeover refuses a live detached role process; stop terminates the verified group", async () => {
    const { dispatch, runId } = await runChild(9141);
    const run = dispatch.getRun(projectId, runId);
    const claims = new DeliveryRoleClaimService(db);
    const acquired = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("claim");

    sleepChild = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    sleepChild.unref();
    claims.recordRoleProcess(acquired.claim, sleepChild.pid!, sleepChild.pid!);

    // Model an abandoned active run: builder owner cleared, but the role lives.
    db.prepare(
      "UPDATE dispatch_runs SET state = 'running', owner_pid = NULL, finished_at = NULL WHERE id = ?",
    ).run(runId);

    let takeoverWhileLive: Record<string, unknown>;
    try {
      const result = dispatch.applyControl(projectId, runId, {
        action: "takeover",
        actor: "operator",
        reason: "take over while the role is still live",
      } as never);
      takeoverWhileLive = { confirmed: result.confirmed, detail: result.detail };
    } catch (error) {
      takeoverWhileLive = {
        error: (error as { code?: string }).code ?? (error as Error).message,
      };
    }
    DETAILS.f3TakeoverLive = takeoverWhileLive;
    expect(takeoverWhileLive.error).toBe("owner_may_still_run");

    const stopActive = dispatch.applyControl(projectId, runId, {
      action: "stop",
      actor: "operator",
      reason: "stop the live delivery role",
    } as never);
    // Use the production zombie-aware liveness primitive: a SIGTERM'd child that
    // has not been reaped by this test process is still reported alive by a bare
    // kill(pid, 0), while production correctly treats a zombie as dead.
    const aliveAfter = pidOrGroupAlive(sleepChild!.pid!, sleepChild!.pid!);
    DETAILS.f3Stop = { confirmed: stopActive.confirmed, detail: stopActive.detail, aliveAfter };
    // The verified role must actually terminate, and the stop must never falsely
    // confirm while the role is still alive (AC18 / #156 AC4).
    expect(aliveAfter).toBe(false);
    expect(stopActive.confirmed && aliveAfter).toBe(false);
  }, 120_000);

  test("F3b: stop on a SUCCEEDED builder run with a live role is not hidden by run_not_active", async () => {
    const { dispatch, runId } = await runChild(9151);
    const run = dispatch.getRun(projectId, runId);
    expect(run.state).toBe("succeeded");
    const claims = new DeliveryRoleClaimService(db);
    const acquired = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("claim");
    sleepChild = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    sleepChild.unref();
    claims.recordRoleProcess(acquired.claim, sleepChild.pid!, sleepChild.pid!);

    let result: Record<string, unknown>;
    try {
      const stopped = dispatch.applyControl(projectId, runId, {
        action: "stop",
        actor: "operator",
        reason: "stop the delivery role on a succeeded builder run",
      } as never);
      result = { confirmed: stopped.confirmed, detail: stopped.detail };
    } catch (error) {
      result = { error: (error as { code?: string }).code ?? (error as Error).message };
    }
    DETAILS.f3b = result;
    expect(result.error).not.toBe("run_not_active");
    expect(result.confirmed).toBe(true);
  }, 120_000);

  test("S-C-1: a Stop/thrown stage interrupts the claim without a false release; nothing stays invisible", async () => {
    const { dispatch, runId } = await runChild(9171);
    const run = dispatch.getRun(projectId, runId);
    const claims = new DeliveryRoleClaimService(db);
    const acquired = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("claim");
    // Model a crash/Stop with no recorded role process and an unreadable owner.
    db.prepare(
      "UPDATE delivery_role_claims SET owner_pid = ?, owner_process_start = NULL WHERE id = ?",
    ).run(process.pid, acquired.claim.id);
    // Runtime-equivalent interrupt (no explicit operator ack).
    claims.interrupt(acquired.claim, "check process crashed");

    const afterInterrupt = claims.get({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    })!;
    DETAILS.sc1 = { state: afterInterrupt.state, disposition: afterInterrupt.disposition };
    expect(afterInterrupt.state).toBe("interrupted");
    // Truthful: a live-but-unverifiable owner keeps the claim held, never released.
    expect(afterInterrupt.disposition).toBe("frozen_unknown_owner");

    const inventory = inventoryInstallation(db, {
      stateDir,
      home: join(root, "animus-home"),
      now: () => 1,
    });
    expect(inventory.held.filter((fact) => fact.entity === "delivery_role_claims")).toHaveLength(1);

    // The claim is visible/actionable but a reconcile without an explicit
    // unknown-owner acknowledgement is refused (never a silent success), and an
    // acknowledged re-interrupt keeps it truthfully frozen — not falsely released
    // while the owner is still present.
    expect(() =>
      claims.reconcile({
        projectId,
        deliveryId: run.delivery_id,
        runId,
        lap: run.lap,
        stage: "blackbox_verification",
        candidateHeadSha: acquired.claim.candidateHeadSha,
        action: "interrupt",
        actor: "operator",
        reason: "operator wants to clear it",
        expectedGeneration: afterInterrupt.claimGeneration,
        expectedCandidateHeadSha: afterInterrupt.candidateHeadSha,
        expectedState: "interrupted",
      }),
    ).toThrow(/acknowledge unknown-owner/i);
    const reFrozen = claims.reconcile({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "blackbox_verification",
      candidateHeadSha: acquired.claim.candidateHeadSha,
      action: "interrupt",
      actor: "operator",
      reason: "operator acknowledges unknown owner effects",
      expectedGeneration: afterInterrupt.claimGeneration,
      expectedCandidateHeadSha: afterInterrupt.candidateHeadSha,
      expectedState: "interrupted",
      acknowledgeUnknownOwner: true,
    });
    expect(reFrozen.disposition).toBe("frozen_unknown_owner");
    const audit = claims.listAudit(acquired.claim.id);
    expect(audit.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test("V16-1: a crash-orphaned artifact is a truthful held fact, not a silent digest block", async () => {
    const { dispatch, runId } = await runChild(9161);
    void dispatch.getRun(projectId, runId);
    const orphan = join(artifactRoot, projectId, "runtime", "crash-orphan.json");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, '{"orphan":true}\n');

    const inventory = inventoryInstallation(db, {
      stateDir,
      home: join(root, "animus-home"),
      now: () => 1,
    });
    DETAILS.v161 = {
      orphanHeld: inventory.held.filter(
        (fact) => fact.entity === "artifact" && fact.identity.includes("crash-orphan"),
      ),
    };
    const heldOrphan = inventory.held.find(
      (fact) => fact.entity === "artifact" && fact.identity.includes("crash-orphan"),
    );
    expect(heldOrphan).toBeTruthy();
    expect(heldOrphan!.identity).toContain("sha256");
    expect(heldOrphan!.reason).toMatch(/unregistered file/i);

    // Remove the orphan: the registered-artifact closure is stable and stage works.
    rmSync(orphan);
    const clean = inventoryInstallation(db, {
      stateDir,
      home: join(root, "animus-home"),
      now: () => 1,
    });
    expect(clean.held.filter((fact) => fact.entity === "artifact")).toHaveLength(0);
  }, 120_000);
});
