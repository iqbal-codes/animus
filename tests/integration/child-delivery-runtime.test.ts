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
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthority } from "./support/activated-authority";

const REPO = "owner/child-delivery-runtime";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function specBody(): string {
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
    "- [ ] AC1 — first parent criterion",
    "- [ ] AC2 — second parent criterion",
    "",
    "## Boundary",
    "",
    "Prepared specification boundary.",
  ].join("\n");
}

function ticketBody(partOf: number, coverage: string, dependsOn?: number[]): string {
  return [
    `Part of #${partOf}`,
    "",
    `Source acceptance coverage: ${coverage}`,
    "",
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
    "- [ ] AC1: prepared criterion",
    "",
    "## Boundary",
    "",
    "Prepared ticket boundary.",
    "",
    dependsOn && dependsOn.length > 0
      ? `Depends on: ${dependsOn.map((n) => `#${n}`).join(", ")}`
      : "Depends on: None",
  ].join("\n");
}

describe("child delivery runtime on the normal scheduler tick", () => {
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
  let checkoutPath: string;
  let bareOrigin: string;
  let artifactRoot: string;
  let projectId: string;
  let reviewerVerdicts: string[];
  let reviewerIndex: number;

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
      const name = `impl-${context.issue_number}-${context.run_id.slice(-6)}-${suffix}.txt`;
      writeFileSync(join(context.worktree_path, name), "implemented\n");
      git(context.worktree_path, "add", name);
      git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
      return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
    };
  }

  function offlineTransport(): AgentTransport {
    return async (request) => {
      const head = git(request.cwd, "rev-parse", "HEAD");
      if (request.role === "reviewer") {
        const verdict = reviewerVerdicts[reviewerIndex] ?? "approved";
        reviewerIndex += 1;
        const approved = verdict === "approved";
        const report = approved
          ? { sha: head, outcome: "approved", summary: "independent review passed", findings: [] }
          : {
              sha: head,
              outcome: "sent-back",
              summary: "blocking defect",
              findings: [
                {
                  id: "F1",
                  axis: "standards",
                  classification: "defect",
                  blocking: true,
                  title: "Prepared criterion is not implemented",
                  description: "The candidate does not satisfy the frozen ticket contract",
                  location: { file: "impl.txt", line: 1 },
                  evidence: "worktree diff",
                  status: "open",
                },
              ],
            };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: "result", finalText: JSON.stringify(report) }),
          stderr: "",
        };
      }
      // Final-spec black-box QA: pass the imported parent criteria.
      const lines = ["AC1", "AC2"].map((criterion) => ({
        id: criterion,
        kind: "criterion",
        verdict: "PASS",
        text: `${criterion} verified`,
        evidence: [],
      }));
      const report = {
        head,
        overall: "PASS",
        summary: "final acceptance passed",
        lines,
        noticed: [],
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", finalText: JSON.stringify(report) }),
        stderr: "",
      };
    };
  }

  function makeRuntime(runner: DispatchRunner) {
    const dispatch = new DispatchService(db, {
      plans,
      ledger,
      brakes,
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
      technicalChecks: ["true"],
      regressionChecks: ["true"],
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

  async function importSpec(
    specIssue: number,
    children: Array<{ issue: number; dependsOn?: number[]; coverage?: string }>,
  ) {
    forge.addIssue(REPO, {
      number: specIssue,
      title: "Spec",
      body: specBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });
    for (const [index, child] of children.entries()) {
      forge.addIssue(REPO, {
        number: child.issue,
        title: `Ticket ${child.issue}`,
        body: ticketBody(specIssue, child.coverage ?? `AC${index + 1}`, child.dependsOn),
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        comments: [],
      });
    }
    const plan = await plans.importPlan(projectId, { issue_number: specIssue, kind: "spec" });
    const branch = `factory/spec-${specIssue}-integration`;
    git(checkoutPath, "branch", "-f", branch, "main");
    git(checkoutPath, "push", "-q", "origin", branch);
    return { plan, branch };
  }

  function integrationCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM child_integrations").get() as { c: number }).c;
  }

  function pullRequestCount(): number {
    return (
      db.prepare("SELECT COUNT(*) AS c FROM publication_pull_requests").get() as { c: number }
    ).c;
  }

  function stages(runId: string): string[] {
    return (
      db
        .prepare("SELECT stage FROM execution_observations WHERE run_id = ? ORDER BY created_at")
        .all(runId) as Array<{ stage: string }>
    ).map((row) => row.stage);
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-child-delivery-runtime-"));
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

    forge = new SyntheticForgeAdapter({ [REPO]: 8790 }, forgeOptions());
    registry = new ProjectRegistryService(db, forge);
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
    reviewerVerdicts = [];
    reviewerIndex = 0;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("AC6/AC7: the normal tick builds, reviews, publishes, merges and releases a dependent", async () => {
    const { plan, branch } = await importSpec(9000, [
      { issue: 9001 },
      { issue: 9002, dependsOn: [9001] },
    ]);
    const { dispatch, runtime } = makeRuntime(committingRunner("a"));

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(tick.action).toBe("launched");
    const firstRunId = tick.runId!;
    expect(stages(firstRunId)).toEqual([
      "builder_execution",
      "technical_checks",
      "independent_review",
    ]);
    expect(pullRequestCount()).toBe(1);
    expect(integrationCount()).toBe(1);
    expect(remoteHead(branch)).toBeTruthy();

    const integration = db
      .prepare(
        "SELECT candidate_head_sha, target_tip_after_sha FROM child_integrations WHERE run_id = ?",
      )
      .get(firstRunId) as { candidate_head_sha: string; target_tip_after_sha: string };
    const firstRun = dispatch.getRun(projectId, firstRunId);
    expect(integration.candidate_head_sha).toBe(firstRun.head_sha);
    git(
      checkoutPath,
      "merge-base",
      "--is-ancestor",
      firstRun.head_sha!,
      integration.target_tip_after_sha,
    );

    // The dependent now dispatches and integrates on the next normal tick.
    const second = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(second.action).toBe("launched");
    expect(second.issueNumber).toBe(9002);
    expect(integrationCount()).toBe(2);
    expect(pullRequestCount()).toBe(2);

    // Once every child is verifiably integrated, the tick advances final delivery.
    const third = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(third.action).toBe("launched");
    expect(third.planId).toBe(plan.id);
    expect(third.delivery).toMatchObject({ integratedCount: 2 });
    expect((third.delivery as { runId: string | null }).runId).toBeTruthy();
  }, 60_000);

  test("a builder-alone succeeded run is recovered by a later tick instead of already_succeeded", async () => {
    const { plan, branch } = await importSpec(9100, [{ issue: 9101, coverage: "AC1–AC2" }]);
    const { dispatch, runtime } = makeRuntime(committingRunner("recover"));

    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      actor: "operator",
    });
    expect(run.state).toBe("succeeded");
    expect(stages(run.id)).toEqual(["builder_execution"]);
    expect(pullRequestCount()).toBe(0);
    expect(integrationCount()).toBe(0);

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "scheduler",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(tick.action).toBe("launched");
    expect(tick.runId).toBe(run.id);
    expect(stages(run.id)).toEqual(["builder_execution", "technical_checks", "independent_review"]);
    expect(pullRequestCount()).toBe(1);
    expect(integrationCount()).toBe(1);
    expect(remoteHead(branch)).toBeTruthy();
    // Recovery never faked a new builder lap.
    expect(dispatch.listRuns(projectId, { plan_id: plan.id })).toHaveLength(1);
  });

  test("a failed independent review returns to a bounded correction lap and a fresh recheck", async () => {
    const { plan } = await importSpec(9200, [{ issue: 9201, coverage: "AC1–AC2" }]);
    reviewerVerdicts = ["sent-back", "approved"];
    const { dispatch, runtime } = makeRuntime(committingRunner("fix"));

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(tick.action).toBe("launched");

    const runs = dispatch.listRuns(projectId, { plan_id: plan.id });
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.lap).sort((left, right) => left - right)).toEqual([1, 2]);
    const first = runs.find((run) => run.lap === 1)!;
    const second = runs.find((run) => run.lap === 2)!;
    expect(
      observations
        .listObservations(projectId, { runId: first.id })
        .some((item) => item.stage === "independent_review" && item.status === "failed"),
    ).toBe(true);
    expect(
      observations
        .listObservations(projectId, { runId: second.id })
        .some((item) => item.stage === "independent_review" && item.status === "passed"),
    ).toBe(true);
    const integration = db
      .prepare("SELECT candidate_head_sha FROM child_integrations WHERE run_id = ?")
      .get(second.id) as { candidate_head_sha: string } | undefined;
    expect(integration?.candidate_head_sha).toBe(second.head_sha);
    expect(integrationCount()).toBe(1);
    expect(
      observations
        .listFindings(projectId, { workId: first.work_id })
        .every((finding) => finding.status === "resolved"),
    ).toBe(true);
  }, 60_000);

  test("pending required CI holds the child, then a later tick resumes the same run", async () => {
    const { plan, branch } = await importSpec(9400, [{ issue: 9401, coverage: "AC1–AC2" }]);
    forge.setRequiredStatusChecks(REPO, branch, ["ci/verify"]);
    const { dispatch, runtime } = makeRuntime(committingRunner("ci"));

    const first = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(first.action).toBe("launched");
    const run = dispatch.getRun(projectId, first.runId!);
    expect(integrationCount()).toBe(0);
    expect(pullRequestCount()).toBe(1);
    expect(first.delivery).toMatchObject({
      action: "failed",
      reasons: expect.arrayContaining(["integration_ci_missing"]),
    });

    // Complete the required check on the exact tested candidate.
    forge.setCheckRuns(REPO, run.head_sha!, [
      { name: "ci/verify", status: "completed", conclusion: "success" },
    ]);
    const second = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(second.action).toBe("launched");
    expect(second.runId).toBe(run.id);
    expect(integrationCount()).toBe(1);
    // Resuming never allocates a new builder lap.
    expect(dispatch.listRuns(projectId, { plan_id: plan.id })).toHaveLength(1);
  }, 60_000);

  test("missing technical configuration holds truthfully instead of inventing a pass", async () => {
    await importSpec(9300, [{ issue: 9301, coverage: "AC1–AC2" }]);
    const dispatch = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      observations,
      budget,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: committingRunner("config"),
    });
    // No technicalChecks and no harness config in the checkout.
    const runtime = createLocalExecutionRuntime({
      db,
      plans,
      dispatch,
      forge,
      observations,
      budget,
      publication,
      artifactRoot,
      engine: { transport: offlineTransport(), provider: "pi", model: "test-model" },
    });

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    const delivery = tick.delivery as { action: string; reasons: string[] };
    expect(delivery.action).toBe("failed");
    expect(delivery.reasons).toContain("technical_checks_unavailable");
    expect(integrationCount()).toBe(0);
    expect(pullRequestCount()).toBe(0);
  });
});
