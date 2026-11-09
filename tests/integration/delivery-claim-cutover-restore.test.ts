import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { BackupRestoreService } from "../../apps/backend/src/restore/service";
import { inventoryInstallation } from "../../apps/backend/src/cutover/inventory";
import { AuthorityCutoverService } from "../../apps/backend/src/cutover/service";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthority } from "./support/activated-authority";

const REPO = "owner/delivery-claim-cutover-restore";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;
const ORIGINAL_ANIMUS_STATE_DIR = process.env.ANIMUS_STATE_DIR;

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
    "- [ ] AC1 — parent one",
    "",
    "## Boundary",
    "b",
  ].join("\n");
}

function ticketBody(partOf: number): string {
  return [
    `Part of #${partOf}`,
    "",
    "Source acceptance coverage: AC1",
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
    "- [ ] AC1: child",
    "",
    "## Boundary",
    "b",
    "",
    "Depends on: None",
  ].join("\n");
}

describe("delivery role claims: cutover, restore and recovery", () => {
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
    if (!headSha || !baseSha) throw new Error("merge transport is missing a real remote ref");
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
      `Merge ${pr.head} into ${pr.base}`,
    );
    git(checkoutPath, "update-ref", `refs/heads/${pr.base}`, mergeSha, baseSha);
    git(checkoutPath, "push", "-q", "origin", `refs/heads/${pr.base}`);
    return { sha: mergeSha };
  }

  function forgeOptions(): SyntheticForgeOptions {
    return {
      requireRemoteSourceRef: true,
      resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
      mergeRemote: (_repo, pr) => mergeOnBareOrigin(pr),
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
        stderr: "",
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

  function backupService(connection = db) {
    return new BackupRestoreService(connection, {
      stateDir: dirname(dbPath),
      databasePath: dbPath,
      artifactRoot,
      home: join(root, "animus-home"),
      forge,
    });
  }

  async function importTicket(issue: number) {
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

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-claim-lifecycle-"));
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
    publication = new PublicationService(db, forge);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    if (ORIGINAL_ANIMUS_STATE_DIR === undefined) delete process.env.ANIMUS_STATE_DIR;
    else process.env.ANIMUS_STATE_DIR = ORIGINAL_ANIMUS_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("a running role claim is inventoried as an active writer", async () => {
    writeHarness();
    await importTicket(9701);
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
    const runId = tick.runId!;
    const run = dispatch.getRun(projectId, runId);
    const claims = new DeliveryRoleClaimService(db);
    const acquired = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "final_acceptance",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(acquired.status).toBe("acquired");

    const inventory = inventoryInstallation(db, {
      stateDir,
      home: join(root, "animus-home"),
      now: () => 1,
    });
    const claimHeld = inventory.held.filter((fact) => fact.entity === "delivery_role_claims");
    expect(claimHeld.length).toBe(1);
    const claimTable = inventory.tables.find((table) => table.table === "delivery_role_claims");
    expect(claimTable?.group).toBe("delivery");
  }, 120_000);

  test("cutover staging succeeds after a real role because scratch is outside the artifact root", async () => {
    writeHarness();
    await importTicket(9705);
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

    const walk = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`],
      );
    const artifactFiles = existsSync(artifactRoot) ? walk(artifactRoot) : [];
    expect(artifactFiles.some((file) => /reviewer-attempt-\d+\.json$/.test(file))).toBe(false);

    const dbStateDir = dirname(dbPath);
    writeExecutionAuthority("legacy", { stateDir: dbStateDir, expected: "local" });
    db.exec("DELETE FROM authority_cutover_operations");
    const cutover = new AuthorityCutoverService(db, {
      stateDir: dbStateDir,
      backup: backupService(),
      home: join(root, "animus-home"),
    });
    const staged = await cutover.stage({ actor: "operator" });
    expect(staged.operation.status).toBe("staged");
  }, 180_000);

  test("restore interrupts and clears a copied running claim, and reacquire works", async () => {
    writeHarness();
    await importTicket(9703);
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
    const runId = tick.runId!;
    const run = dispatch.getRun(projectId, runId);
    const claims = new DeliveryRoleClaimService(db);
    const acquired = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "final_acceptance",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(acquired.status).toBe("acquired");
    const before = db
      .prepare(
        "SELECT id, owner_pid, owner_process_start, claim_token, claim_generation, state FROM delivery_role_claims WHERE run_id = ?",
      )
      .get(runId) as {
      id: string;
      owner_pid: number | null;
      owner_process_start: string | null;
      claim_token: string;
      claim_generation: number;
      state: string;
    };
    expect(before.state).toBe("running");

    const bundle = join(root, "bundle");
    backupService().createBackup(bundle, "operator");
    const targetStateDir = join(root, "restored", "state");
    const restored = backupService().restoreBackup({
      sourcePath: bundle,
      targetStateDir,
      targetHome: join(root, "restored"),
      actor: "operator",
    });
    expect(restored.installation.held).toBe(true);
    expect(restored.operation.report.interruptedClaimCount).toBeGreaterThanOrEqual(1);
    expect(
      (restored.operation.report.clearedClaims as unknown[] | undefined)?.length ?? 0,
    ).toBeGreaterThanOrEqual(1);

    const restoredDb = new DatabaseSync(join(targetStateDir, "console.db"));
    try {
      const after = restoredDb
        .prepare(
          "SELECT state, owner_pid, owner_process_start, role_pid, role_pgid, role_process_start, lease_expires_at, claim_token, claim_generation FROM delivery_role_claims WHERE id = ?",
        )
        .get(before.id) as {
        state: string;
        owner_pid: number | null;
        owner_process_start: string | null;
        role_pid: number | null;
        role_pgid: number | null;
        role_process_start: string | null;
        lease_expires_at: number;
        claim_token: string;
        claim_generation: number;
      };
      expect(after.state).not.toBe("running");
      expect(after.owner_pid).toBeNull();
      expect(after.owner_process_start).toBeNull();
      expect(after.role_pid).toBeNull();
      expect(after.role_pgid).toBeNull();
      expect(after.role_process_start).toBeNull();
      expect(after.lease_expires_at).toBe(0);
      expect(after.claim_token).not.toBe(before.claim_token);
      expect(after.claim_generation).toBe(before.claim_generation + 1);

      const restoredClaims = new DeliveryRoleClaimService(restoredDb);
      const reacquired = restoredClaims.acquire({
        projectId,
        deliveryId: run.delivery_id,
        runId,
        lap: run.lap,
        stage: "final_acceptance",
        candidateHeadSha: run.head_sha ?? run.base_sha,
      });
      expect(reacquired.status).toBe("acquired");
    } finally {
      restoredDb.close();
    }
  }, 120_000);

  test("a running claim with an existing role receipt terminalizes without re-executing", async () => {
    writeHarness();
    await importTicket(9707);
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
    const runId = tick.runId!;
    const run = dispatch.getRun(projectId, runId);
    const claim = db
      .prepare(
        "SELECT id, attempt_key, state FROM delivery_role_claims WHERE run_id = ? AND stage = 'independent_review'",
      )
      .get(runId) as { id: string; attempt_key: string; state: string };
    expect(claim.state).toBe("completed");
    const observation = db
      .prepare(
        "SELECT id, status FROM execution_observations WHERE run_id = ? AND stage = 'independent_review' AND attempt_key = ?",
      )
      .get(runId, claim.attempt_key) as { id: string; status: string };
    expect(observation.status).toBe("passed");

    // Simulate a crash after the receipt was durable but before the claim CAS was
    // observed: the claim is running and the role result already exists.
    db.prepare(
      "UPDATE delivery_role_claims SET state = 'running', result_observation_id = NULL WHERE id = ?",
    ).run(claim.id);

    const claims = new DeliveryRoleClaimService(db);
    const recovered = claims.acquire({
      projectId,
      deliveryId: run.delivery_id,
      runId,
      lap: run.lap,
      stage: "independent_review",
      candidateHeadSha: run.head_sha ?? run.base_sha,
    });
    expect(recovered.status).toBe("terminal");
    if (recovered.status === "terminal") {
      expect(recovered.claim.state).toBe("completed");
      expect(recovered.claim.resultObservationId).toBe(observation.id);
    }
  }, 120_000);
});
