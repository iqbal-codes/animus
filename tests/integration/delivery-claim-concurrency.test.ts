import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { DeliveryRoleClaimService } from "../../apps/backend/src/delivery";
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthority } from "./support/activated-authority";

const REPO = "owner/delivery-claim-concurrency";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function specBody(): string {
  return [
    "## Source and problem",
    "",
    "s",
    "",
    "## Outcome",
    "",
    "o",
    "",
    "## Invariants",
    "",
    "- i",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1 — parent one",
    "",
    "## Boundary",
    "",
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
    "",
    "s",
    "",
    "## Outcome",
    "",
    "o",
    "",
    "## Invariants",
    "",
    "- i",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1: child",
    "",
    "## Boundary",
    "",
    "b",
    "",
    "Depends on: None",
  ].join("\n");
}

describe("durable delivery-role claims", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let observations: ExecutionObservationService;
  let budget: ExecutionBudgetService;
  let checkoutPath: string;
  let bareOrigin: string;
  let artifactRoot: string;
  let projectId: string;
  let planId: string;

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

  function committingRunner(suffix: string): DispatchRunner {
    return async (context) => {
      const name = `impl-${suffix}-${context.run_id.slice(-6)}.txt`;
      writeFileSync(join(context.worktree_path, name), "implemented\n");
      git(context.worktree_path, "add", name);
      git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
      return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
    };
  }

  function services(connection: ReturnType<typeof initializeDatabase>, runner: DispatchRunner) {
    const connectionPlans = new PlanService(connection, forge);
    const connectionObservations = new ExecutionObservationService(connection, { artifactRoot });
    const connectionBudget = new ExecutionBudgetService(connection);
    const connectionPublication = new PublicationService(connection, forge);
    const dispatch = new DispatchService(connection, {
      plans: connectionPlans,
      ledger: new CommandLedger(connection),
      brakes: new BrakeService(connection),
      observations: connectionObservations,
      budget: connectionBudget,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner,
    });
    return {
      dispatch,
      observations: connectionObservations,
      budget: connectionBudget,
      publication: connectionPublication,
      plans: connectionPlans,
    };
  }

  async function createBuiltRun(): Promise<{
    runId: string;
    deliveryId: string;
    workId: string;
    lap: number;
    headSha: string;
  }> {
    const dispatch = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      observations,
      budget,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: committingRunner("built"),
    });
    const run = await dispatch.dispatch(projectId, { plan_id: planId, actor: "operator" });
    expect(run.state).toBe("succeeded");
    expect(run.head_sha).toBeTruthy();
    return {
      runId: run.id,
      deliveryId: run.delivery_id,
      workId: run.work_id,
      lap: run.lap,
      headSha: run.head_sha!,
    };
  }

  function integrationCount(connection: ReturnType<typeof initializeDatabase>): number {
    return (connection.prepare("SELECT COUNT(*) AS c FROM delivery_merges").get() as { c: number })
      .c;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-delivery-claims-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    artifactRoot = join(root, "animus-home", "state", "artifacts");
    db = initializeDatabase(join(root, "state", "console.db"));
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

    forge = new SyntheticForgeAdapter({ [REPO]: 9910 }, forgeOptions());
    registry = new ProjectRegistryService(db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    forge.addIssue(REPO, {
      number: 9911,
      title: "Spec",
      body: specBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: 9912,
      title: "Ticket",
      body: ticketBody(9911),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    plans = new PlanService(db, forge);
    const plan = await plans.importPlan(projectId, { issue_number: 9911, kind: "spec" });
    planId = plan.id;
    const branch = "factory/spec-9911-integration";
    git(checkoutPath, "branch", "-f", branch, "main");
    git(checkoutPath, "push", "-q", "origin", branch);
    ledger = new CommandLedger(db);
    brakes = new BrakeService(db);
    observations = new ExecutionObservationService(db, { artifactRoot });
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

  test("two connections race the review: exactly one invocation and no early merge", async () => {
    const built = await createBuiltRun();

    let releaseReview!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let reviewStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reviewStarted = resolve;
    });
    let invocations = 0;
    const transport: AgentTransport = async (request) => {
      if (request.role !== "reviewer") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "result",
            finalText: JSON.stringify({
              head: git(request.cwd, "rev-parse", "HEAD"),
              overall: "PASS",
            }),
          }),
          stderr: "",
        };
      }
      invocations += 1;
      reviewStarted();
      await released;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "result",
          finalText: JSON.stringify({
            sha: git(request.cwd, "rev-parse", "HEAD"),
            outcome: "approved",
            summary: "independent review passed",
            findings: [],
          }),
        }),
        stderr: "",
      };
    };

    const dbA = initializeDatabase(join(root, "state", "console.db"));
    const dbB = initializeDatabase(join(root, "state", "console.db"));
    const a = services(dbA, async () => {
      throw new Error("no builder expected");
    });
    const b = services(dbB, async () => {
      throw new Error("no builder expected");
    });
    const runtimeA = createLocalExecutionRuntime({
      db: dbA,
      plans: a.plans,
      dispatch: a.dispatch,
      forge,
      observations: a.observations,
      budget: a.budget,
      publication: a.publication,
      artifactRoot,
      regressionChecks: ["true"],
      engine: {
        transport,
        provider: "pi",
        model: "test-model",
        roleBudgets: {
          qa: { softMs: 5_000, hardMs: 10_000 },
          reviewer: { softMs: 5_000, hardMs: 10_000 },
        },
      },
    });
    const runtimeB = createLocalExecutionRuntime({
      db: dbB,
      plans: b.plans,
      dispatch: b.dispatch,
      forge,
      observations: b.observations,
      budget: b.budget,
      publication: b.publication,
      artifactRoot,
      regressionChecks: ["true"],
      engine: {
        transport,
        provider: "pi",
        model: "test-model",
        roleBudgets: {
          qa: { softMs: 5_000, hardMs: 10_000 },
          reviewer: { softMs: 5_000, hardMs: 10_000 },
        },
      },
    });

    const tickA = runLocalDispatchTick({
      db: dbA,
      registry: new ProjectRegistryService(dbA, forge),
      plans: a.plans,
      dispatch: a.dispatch,
      actor: "monitor-a",
      deliveryRuntime: runtimeA.delivery,
    });
    await started;
    expect(integrationCount(dbA)).toBe(0);

    const tickB = await runLocalDispatchTick({
      db: dbB,
      registry: new ProjectRegistryService(dbB, forge),
      plans: b.plans,
      dispatch: b.dispatch,
      actor: "monitor-b",
      deliveryRuntime: runtimeB.delivery,
    });
    expect(tickB.action).toBe("skipped");
    expect(tickB.reason).toBe("delivery_already_claimed");
    expect(invocations).toBe(1);
    // The competing tick observed a live claim and never merged while it was pending.
    expect(integrationCount(dbB)).toBe(0);
    expect(tickA).toBeDefined();

    releaseReview();
    const resultA = await tickA;
    expect(resultA.action).toBe("launched");
    expect((resultA.delivery as { action: string }).action).toBe("published");
    expect(invocations).toBe(1);
    expect(integrationCount(dbA)).toBe(1);
    const reviews = a.observations
      .listObservations(projectId, { runId: built.runId })
      .filter((item) => item.stage === "code_review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("passed");
    const claim = dbA
      .prepare(
        "SELECT state, claim_generation FROM delivery_role_claims WHERE run_id = ? AND stage = 'code_review'",
      )
      .get(built.runId) as { state: string; claim_generation: number };
    expect(claim.state).toBe("completed");
    expect(claim.claim_generation).toBe(1);

    dbA.close();
    dbB.close();
  });

  test("a live claim is retained, a proven-dead owner is reclaimed, and ambiguity holds", async () => {
    const built = await createBuiltRun();
    const now = 1_000_000;
    const input = {
      projectId,
      deliveryId: built.deliveryId,
      runId: built.runId,
      lap: built.lap,
      stage: "code_review" as const,
      candidateHeadSha: built.headSha,
    };

    const owner = new DeliveryRoleClaimService(db, {
      clock: () => now,
      ownerPid: () => 11111,
      processStart: () => "start-A",
      processAlive: () => true,
      processGroupAlive: () => false,
    });
    const first = owner.acquire(input);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") throw new Error("expected acquisition");
    expect(first.claim.claimGeneration).toBe(1);

    const contender = new DeliveryRoleClaimService(db, {
      clock: () => now,
      ownerPid: () => 22222,
      processStart: (pid) => (pid === 11111 ? "start-A" : "start-B"),
      processAlive: (pid) => pid === 11111,
      processGroupAlive: () => false,
    });
    const live = contender.acquire(input);
    expect(live.status).toBe("already_running");
    if (live.status === "already_running") expect(live.reason).toBe("already_running");

    const reclaimer = new DeliveryRoleClaimService(db, {
      clock: () => now,
      ownerPid: () => 33333,
      processStart: () => "start-C",
      processAlive: () => false,
      processGroupAlive: () => false,
    });
    const reclaimed = reclaimer.acquire(input);
    expect(reclaimed.status).toBe("acquired");
    if (reclaimed.status !== "acquired") throw new Error("expected reclaim");
    expect(reclaimed.claim.claimGeneration).toBe(2);
    // A legitimate retry gets its own attempt key instead of collapsing into one.
    expect(reclaimed.claim.attemptKey).not.toBe(first.claim.attemptKey);

    // An unreadable owner identity is ambiguous: retain the running claim.
    db.prepare("UPDATE delivery_role_claims SET owner_process_start = NULL WHERE id = ?").run(
      reclaimed.claim.id,
    );
    const ambiguous = contender.acquire(input);
    expect(ambiguous.status).toBe("already_running");
    if (ambiguous.status === "already_running") expect(ambiguous.reason).toBe("owner_unverified");
  });

  test("a late failed review is persisted and revokes the earlier pass", async () => {
    const built = await createBuiltRun();
    const gate = observations.ensureTrustedProducer(projectId, {
      id: `late-gate-${built.runId}`,
      role: "automated_gate",
    });
    observations.recordRunObservation(
      projectId,
      built.runId,
      {
        stage: "technical_checks",
        status: "passed",
        producer: gate,
        checks: [
          {
            name: "declared technical/contract check #1",
            command: "echo tech-ok",
            result: "PASS",
            kind: "contract",
          },
        ],
        findings: [],
        artifacts: [],
      },
      { attemptKey: `technical_checks:claim:${"c".repeat(36)}` },
    );
    const reviewer = observations.ensureTrustedProducer(projectId, {
      id: `late-reviewer-${built.runId}`,
      role: "peer_reviewer",
    });

    observations.recordRunObservation(
      projectId,
      built.runId,
      {
        stage: "code_review",
        status: "passed",
        producer: reviewer,
        checks: [
          {
            name: "independent standards and contract review",
            command: "review candidate diff",
            result: "PASS",
            kind: "review",
          },
        ],
        findings: [],
        artifacts: [],
      },
      { attemptKey: `code_review:claim:${"a".repeat(36)}` },
    );
    expect(observations.evaluateAcceptance(projectId, built.runId).authorized).toBe(true);

    observations.recordRunObservation(
      projectId,
      built.runId,
      {
        stage: "code_review",
        status: "failed",
        producer: reviewer,
        checks: [
          {
            name: "independent standards and contract review",
            command: "review candidate diff",
            result: "FAIL",
            kind: "review",
          },
        ],
        findings: [
          {
            severity: "blocking",
            fileContext: "impl.txt:1",
            summary: "A late concurrent review found a blocking defect",
            workId: undefined,
          },
        ],
        artifacts: [],
      },
      { attemptKey: `code_review:claim:${"b".repeat(36)}` },
    );

    const latest = observations.latestObservation(projectId, built.runId, "code_review");
    expect(latest?.status).toBe("failed");
    const reviews = observations
      .listObservations(projectId, { runId: built.runId })
      .filter((item) => item.stage === "code_review");
    expect(reviews.map((item) => item.status)).toEqual(["passed", "failed"]);
    expect(reviews[0]!.attemptKey).not.toBe(reviews[1]!.attemptKey);
    const acceptance = observations.evaluateAcceptance(projectId, built.runId);
    expect(acceptance.authorized).toBe(false);
    expect(acceptance.reasons).toContain("required_stage_not_passed:code_review:failed");
    expect(acceptance.reasons).toContain("open_blocking_findings");
    expect(observations.listFindings(projectId, { workId: built.workId }).length).toBeGreaterThan(
      0,
    );
  });
});
