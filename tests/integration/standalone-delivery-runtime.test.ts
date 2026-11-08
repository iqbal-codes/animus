import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { DeliveryGateService, DeliveryRuntimeCoordinator } from "../../apps/backend/src/delivery";
import { FinalDeliveryService } from "../../apps/backend/src/final";
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthority } from "./support/activated-authority";

const REPO = "owner/standalone-runtime";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function ticketBody(): string {
  return [
    "## Source and problem",
    "",
    "Prepared standalone ticket source.",
    "",
    "## Outcome",
    "",
    "Prepared standalone ticket outcome.",
    "",
    "## Invariants",
    "",
    "- Keep the invariant.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1: first prepared criterion",
    "- [ ] AC2: second prepared criterion",
    "",
    "## Boundary",
    "",
    "Prepared standalone ticket boundary.",
    "",
    "Depends on: None",
  ].join("\n");
}

describe("standalone delivery runtime producer", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let observations: ExecutionObservationService;
  let budget: ExecutionBudgetService;
  let publication: PublicationService;
  let delivery: DeliveryGateService;
  let dispatch: DispatchService;
  let projectId: string;
  let checkoutPath: string;
  let bareOrigin: string;
  let artifactRoot: string;
  let runContexts: Array<{
    runId: string;
    findings: Array<{ summary: string; fileContext: string; acKey?: string }>;
    worktree: string;
    head: string;
  }>;

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

  function forgeOptions(): SyntheticForgeOptions {
    return {
      requireRemoteSourceRef: true,
      resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
    };
  }

  function committingRunner(): DispatchRunner {
    return async (context) => {
      const name = `impl-${context.run_id}.txt`;
      writeFileSync(join(context.worktree_path, name), "implemented\n");
      git(context.worktree_path, "add", name);
      git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
      const head = git(context.worktree_path, "rev-parse", "HEAD");
      runContexts.push({
        runId: context.run_id,
        findings: context.findings,
        worktree: context.worktree_path,
        head,
      });
      return { success: true, headSha: head };
    };
  }

  let qaCalls = 0;

  function offlineTransport(): AgentTransport {
    return async (request) => {
      const head = git(request.cwd, "rev-parse", "HEAD");
      let report: Record<string, unknown>;
      if (request.role === "reviewer") {
        report = {
          sha: head,
          outcome: "approved",
          summary: "independent standards and contract review passed",
          findings: [],
        };
      } else {
        qaCalls += 1;
        const pass = qaCalls > 1;
        report = {
          head,
          overall: pass ? "PASS" : "FAIL",
          summary: pass ? "black-box acceptance passed" : "AC1 is not satisfied",
          lines: [
            {
              id: "AC1",
              kind: "criterion",
              verdict: pass ? "PASS" : "FAIL",
              text: pass ? "AC1 works" : "AC1 missing",
              evidence: [],
            },
            {
              id: "AC2",
              kind: "criterion",
              verdict: "PASS",
              text: "AC2 works",
              evidence: [],
            },
          ],
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", finalText: JSON.stringify(report) }),
        stderr: "",
      };
    };
  }

  function makeCoordinator(): DeliveryRuntimeCoordinator {
    const runtimeRef: { current: DeliveryRuntimeCoordinator | null } = { current: null };
    const finalService = new FinalDeliveryService(db, {
      plans,
      dispatch,
      observations,
      publication,
      gate: delivery,
      budget,
      runtime: () => runtimeRef.current!,
    });
    const coordinator = new DeliveryRuntimeCoordinator(db, {
      gate: delivery,
      observations,
      dispatch,
      budget,
      publication,
      artifactRoot,
      engine: {
        transport: offlineTransport(),
        provider: "pi",
        model: "test-model",
        roleBudgets: {
          qa: { softMs: 5_000, hardMs: 10_000 },
          reviewer: { softMs: 5_000, hardMs: 10_000 },
        },
      },
      regressionChecks: ["true"],
      maxCorrections: 2,
      correction: {
        dispatch: (request) => finalService.dispatchCorrection(request),
      },
    });
    runtimeRef.current = coordinator;
    return coordinator;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-standalone-runtime-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    artifactRoot = join(root, "animus-home", "state", "artifacts");
    db = initializeDatabase(join(root, "state", "console.db"));
    seedActivatedAuthority(db);
    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
    forge = new SyntheticForgeAdapter({ [REPO]: 159 }, forgeOptions());
    registry = new ProjectRegistryService(db, forge);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", `url.${bareOrigin}.insteadOf`, `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    git(checkoutPath, "commit", "--allow-empty", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    git(checkoutPath, "push", "-q", "origin", "main");
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    plans = new PlanService(db, forge);
    ledger = new CommandLedger(db);
    brakes = new BrakeService(db);
    observations = new ExecutionObservationService(db, { artifactRoot });
    budget = new ExecutionBudgetService(db);
    publication = new PublicationService(db, forge);
    delivery = new DeliveryGateService(db, { observations, publication, forge });
    runContexts = [];
    qaCalls = 0;
    dispatch = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: committingRunner(),
      observations,
      budget,
    });
    forge.addIssue(REPO, {
      number: 1590,
      title: "Standalone runtime",
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("the normal scheduler tick preserves standalone corrections with the shared final-spec hook installed", async () => {
    const plan = await plans.importPlan(projectId, { issue_number: 1590, kind: "standalone" });
    const coordinator = makeCoordinator();

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "scheduler",
      deliveryRuntime: coordinator,
    });
    expect(tick.action).toBe("launched");
    expect(tick.delivery).toMatchObject({
      action: "published",
      state: "awaiting_publication",
    });

    const runs = dispatch.listRuns(projectId, { plan_id: plan.id });
    expect(runs).toHaveLength(2);
    const firstRun = runs.find((run) => run.lap === 1)!;
    const secondRun = runs.find((run) => run.lap === 2)!;
    expect(secondRun.head_sha).not.toBe(firstRun.head_sha);
    expect(runContexts[1]!.findings[0]).toMatchObject({
      summary: expect.stringContaining("AC1"),
    });

    const firstEvidence = observations.listObservations(projectId, { runId: firstRun.id });
    const failedAcceptance = firstEvidence.find(
      (observation) => observation.stage === "final_acceptance",
    )!;
    expect(failedAcceptance.status).toBe("failed");
    expect(observations.listFindings(projectId, { runId: firstRun.id }).length).toBeGreaterThan(0);

    const secondEvidence = observations.listObservations(projectId, { runId: secondRun.id });
    const review = secondEvidence.find(
      (observation) => observation.stage === "independent_review",
    )!;
    const acceptance = secondEvidence.find(
      (observation) => observation.stage === "final_acceptance",
    )!;
    expect(review.status).toBe("passed");
    expect(acceptance.status).toBe("passed");
    expect(acceptance.candidateHeadSha).toBe(secondRun.head_sha);
    expect(acceptance.checks.some((check) => check.kind === "regression")).toBe(true);
    expect(
      acceptance.checks
        .filter((check) => check.kind === "acceptance")
        .map((check) => check.criterionKey),
    ).toEqual(["AC1", "AC2"]);

    // The runtime writes immutable, hash-verifiable artifacts for every stage.
    for (const observation of [failedAcceptance, review, acceptance]) {
      expect(observation.artifacts.length).toBeGreaterThan(0);
      for (const artifact of observation.artifacts) {
        const absolute = join(artifactRoot, projectId, artifact.relativePath);
        const bytes = readFileSync(absolute);
        expect(bytes.byteLength).toBe(artifact.sizeBytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.digestSha256);
      }
    }

    // A failing lap opens a blocking finding; the fresh recheck resolves it.
    const findings = observations.listFindings(projectId, { workId: firstRun.work_id });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.status === "resolved")).toBe(true);

    // Publication is real, but the manual audit remains incomplete until evidence
    // hosting is bound. The runtime never marks a remote merge.
    const published = publication.getStatusByRun(projectId, secondRun.id);
    expect(published.pullRequests.length).toBeGreaterThan(0);
    expect(published.pullRequests[0]!.state).toBe("open");
    const gate = await delivery.getGate(projectId, secondRun.id);
    expect(gate.state).toBe("awaiting_publication");
    expect(gate.manualMergeRequired).toBe(true);
    expect(gate.merge.verified).toBe(false);
    expect(gate.stages.find((stage) => stage.name === "remote_ci")?.status).toBe("passed");
  });

  test("a Stop control prevents the runtime from dispatching corrections", async () => {
    const plan = await plans.importPlan(projectId, { issue_number: 1590, kind: "standalone" });
    const firstRun = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      actor: "operator",
    });
    budget.setControl({
      projectId,
      deliveryId: firstRun.delivery_id,
      workId: firstRun.work_id,
      status: "stopped",
      actor: "operator",
      reason: "operator_stop",
      commandRequestId: "cmd_stop_test",
      lastRunId: firstRun.id,
      now: Date.now(),
    });

    const coordinator = makeCoordinator();
    const result = await coordinator.process(projectId, firstRun.id);
    expect(result.action).toBe("stopped");
    expect(qaCalls).toBe(0);
    expect(dispatch.listRuns(projectId, { plan_id: plan.id })).toHaveLength(1);
  });
});
