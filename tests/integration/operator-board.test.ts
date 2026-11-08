import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService, type DispatchRunner } from "../../apps/backend/src/dispatch";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  REPO,
  ORIGINAL_ANIMUS_HOME,
  cardFor,
  createFixture,
  git,
  type Fixture,
} from "./operator-board-fixture";

describe("operator board projection", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(() => {
    try {
      fixture.db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test("AC2: an empty project keeps every existing lane with honest zero counts", async () => {
    const board = await fixture.fetchBoard();
    expect(board.counts).toEqual({ specs: 0, tickets: 0, unplanned: 0, workers: 0, capacity: 3 });
    expect(board.lanes.map((lane) => lane.id)).toEqual([
      "triage",
      "ready",
      "working",
      "approval",
      "needs-owner",
      "parked",
      "merged",
      "failed",
    ]);
    expect(board.lanes.every((lane) => lane.count === 0)).toBe(true);
    expect(board.usage.available).toBe(false);
    expect(board.precedence.length).toBeGreaterThan(0);
  });

  test("AC1/AC2: partial child integration never completes the parent; counts and parent refs are distinct", async () => {
    const { planId } = await fixture.importSpec(1800, [
      { issue: 1801, coverage: "AC1" },
      { issue: 1802, dependsOn: [1801], coverage: "AC2" },
    ]);
    await fixture.importStandalone(1810);
    await fixture.integrateChild(planId, 1801, "one");

    const board = await fixture.fetchBoard();
    expect(board.counts).toMatchObject({ specs: 1, tickets: 3, unplanned: 0 });
    expect(board.counts.workers).toBe(0);

    const parent = cardFor(board, 1800);
    expect(parent.kind).toBe("spec");
    expect(parent.lane).toBe("ready");
    expect(parent.specProgress).toMatchObject({ integrated: 1, required: 2, delivered: false });
    expect(parent.finalState).toBe("waiting_children");
    expect(board.lanes.find((lane) => lane.id === "merged")?.cards).not.toContainEqual(
      expect.objectContaining({ issueNumber: 1800 }),
    );

    const integratedChild = cardFor(board, 1801);
    expect(integratedChild.kind).toBe("ticket");
    expect(integratedChild.lane).toBe("merged");
    expect(integratedChild.parent).toMatchObject({ issueNumber: 1800 });
    expect(integratedChild.detail).toContain("parent delivery is separate");

    const pendingChild = cardFor(board, 1802);
    expect(pendingChild.lane).toBe("ready");
    expect(pendingChild.parent).toMatchObject({ issueNumber: 1800 });
    expect(pendingChild.detail).toContain("eligible for dispatch");

    const standalone = cardFor(board, 1810);
    expect(standalone.kind).toBe("ticket");
    expect(standalone.parent).toBeNull();
    expect(standalone.lane).toBe("ready");
  });

  test("AC2/AC5: a failed review returns the child to correction without falsely merging", async () => {
    const { planId } = await fixture.importSpec(1820, [{ issue: 1821, coverage: "AC1" }], ["AC1"]);
    const run = await fixture.dispatch.dispatch(fixture.projectId, {
      plan_id: planId,
      issue_number: 1821,
      actor: "operator",
    });
    const reviewer = fixture.observations.registerTrustedProducer(fixture.projectId, {
      id: "reviewer-failed",
      role: "peer_reviewer",
    });
    fixture.observations.recordRunObservation(fixture.projectId, run.id, {
      stage: "independent_review",
      status: "failed",
      producer: reviewer.producer,
      checks: [{ name: "standards", command: "review diff", result: "FAIL" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "impl.txt:1",
          summary: "AC1 is not satisfied",
        },
      ],
    });
    await fixture.publication.publishByRun(fixture.projectId, run.id);

    const board = await fixture.fetchBoard();
    const child = cardFor(board, 1821);
    expect(child.lane).toBe("working");
    expect(child.stageLabel).toBe("Correction required");
    expect(child.integrationState).toBe("blocked");
    expect(child.budgetStatus).toBe("active");
    expect(child.specProgress).toBeNull();
  });

  test("AC4/AC5: exhaustion places the ticket in Needs owner with retained workspace", async () => {
    const { planId } = await fixture.importSpec(1830, [{ issue: 1831, coverage: "AC1" }], ["AC1"]);
    const failingDispatch = new DispatchService(fixture.db, {
      plans: fixture.plans,
      ledger: new CommandLedger(fixture.db),
      brakes: new BrakeService(fixture.db),
      observations: fixture.observations,
      budget: fixture.budget,
      processAlive: () => true,
      ownerPid: () => process.pid,
      runner: async () => ({ success: false, error: "rejected cycle" }),
    });
    for (let lap = 1; lap <= 3; lap += 1) {
      await failingDispatch
        .dispatch(fixture.projectId, {
          plan_id: planId,
          issue_number: 1831,
          actor: "operator",
        })
        .catch((error) => expect((error as { code: string }).code).toBe("dispatch_failed"));
    }
    await expect(
      failingDispatch.dispatch(fixture.projectId, {
        plan_id: planId,
        issue_number: 1831,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });

    const board = await fixture.fetchBoard();
    const child = cardFor(board, 1831);
    expect(child.lane).toBe("needs-owner");
    expect(child.budgetStatus).toBe("exhausted");
    expect(child.precedence).toContain("budget_exhausted");

    const workId = child.workId;
    const detail = await fixture.fetchWork(workId);
    expect(detail.retained).not.toBeNull();
    expect(detail.retained?.worktreePath).toContain("worktrees");
    expect(detail.latestRun?.budget?.status).toBe("exhausted");
    expect(detail.latestRun?.openFindings.length).toBe(0);
  });

  test("AC2/AC4: pending publication is shown as awaiting publication, not delivered", async () => {
    const { planId } = await fixture.importStandalone(1840);
    const run = await fixture.dispatch.dispatch(fixture.projectId, {
      plan_id: planId,
      actor: "operator",
    });
    const reviewer = fixture.observations.registerTrustedProducer(fixture.projectId, {
      id: "reviewer-pending",
      role: "peer_reviewer",
    });
    const evaluator = fixture.observations.registerTrustedProducer(fixture.projectId, {
      id: "evaluator-pending",
      role: "independent_evaluator",
    });
    fixture.observations.recordRunObservation(fixture.projectId, run.id, {
      stage: "independent_review",
      status: "passed",
      producer: reviewer.producer,
      checks: [{ name: "standards", command: "review diff", result: "PASS", kind: "review" }],
    });
    fixture.observations.recordRunObservation(fixture.projectId, run.id, {
      stage: "final_acceptance",
      status: "passed",
      producer: evaluator.producer,
      checks: [
        {
          name: "AC1",
          command: "acceptance AC1",
          result: "PASS",
          kind: "acceptance",
          criterionKey: "AC1",
        },
        { name: "regression", command: "bun test", result: "PASS", kind: "regression" },
        { name: "remote ci", command: "gh pr checks", result: "PASS", kind: "remote_ci" },
      ],
    });

    const board = await fixture.fetchBoard();
    const ticket = cardFor(board, 1840);
    expect(ticket.gateState).toBe("awaiting_publication");
    expect(ticket.lane).toBe("approval");
    expect(ticket.stageLabel).toBe("Awaiting publication");
  });

  test("AC5: stale evidence after target drift is failed, never merged", async () => {
    const { planId } = await fixture.importStandalone(1850);
    const run = await fixture.dispatch.dispatch(fixture.projectId, {
      plan_id: planId,
      actor: "operator",
    });
    const reviewer = fixture.observations.registerTrustedProducer(fixture.projectId, {
      id: "reviewer-stale",
      role: "peer_reviewer",
    });
    const evaluator = fixture.observations.registerTrustedProducer(fixture.projectId, {
      id: "evaluator-stale",
      role: "independent_evaluator",
    });
    fixture.observations.recordRunObservation(fixture.projectId, run.id, {
      stage: "independent_review",
      status: "passed",
      producer: reviewer.producer,
      checks: [{ name: "standards", command: "review diff", result: "PASS", kind: "review" }],
    });
    fixture.observations.recordRunObservation(fixture.projectId, run.id, {
      stage: "final_acceptance",
      status: "passed",
      producer: evaluator.producer,
      checks: [
        {
          name: "AC1",
          command: "acceptance AC1",
          result: "PASS",
          kind: "acceptance",
          criterionKey: "AC1",
        },
        { name: "regression", command: "bun test", result: "PASS", kind: "regression" },
        { name: "remote ci", command: "gh pr checks", result: "PASS", kind: "remote_ci" },
      ],
    });
    await fixture.publication.publishByRun(fixture.projectId, run.id);

    const dir = join(fixture.root, "advance");
    execFileSync("git", ["clone", "-q", fixture.bareOrigin, dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    git(dir, "commit", "--allow-empty", "-q", "-m", "advance main");
    git(dir, "push", "-q", "origin", "main");

    const board = await fixture.fetchBoard();
    const ticket = cardFor(board, 1850);
    expect(ticket.gateState).toBe("invalidated");
    expect(ticket.lane).toBe("failed");
    expect(ticket.stageLabel).toBe("Evidence stale");
  });

  test("AC2/AC5: final delivery waits for manual merge, then only a verified target merge marks the parent delivered", async () => {
    const { planId } = await fixture.importSpec(1860, [
      { issue: 1861, coverage: "AC1" },
      { issue: 1862, dependsOn: [1861], coverage: "AC2" },
    ]);
    await fixture.integrateChild(planId, 1861, "one");
    await fixture.integrateChild(planId, 1862, "two");

    const plan = fixture.plans.getPlan(fixture.projectId, planId);
    const rootWorkId = plan.root_work_id;

    function bindEvidence(runId: string): void {
      const status = fixture.publication.getStatusByRun(fixture.projectId, runId);
      for (const observation of fixture.observations.listObservations(fixture.projectId, {
        workId: rootWorkId,
      })) {
        for (const artifact of observation.artifacts) {
          fixture.publication.bindEvidence(
            fixture.projectId,
            status.target.id,
            artifact.id,
            `https://github.com/user-attachments/assets/${artifact.id}`,
          );
        }
      }
    }

    let status = await fixture.finalService.advance(fixture.projectId, planId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!status.runId) break;
      bindEvidence(status.runId);
      await fixture.publication.publishByRun(fixture.projectId, status.runId);
      status = await fixture.finalService.advance(fixture.projectId, planId);
      if (status.state === "awaiting_manual_merge") break;
    }
    expect(status.state).toBe("awaiting_manual_merge");
    expect(status.delivered).toBe(false);

    const readyBoard = await fixture.fetchBoard();
    const waitingParent = cardFor(readyBoard, 1860);
    expect(waitingParent.lane).toBe("approval");
    expect(waitingParent.stageLabel).toBe("Awaiting manual merge");
    expect(waitingParent.finalState).toBe("awaiting_manual_merge");
    expect(waitingParent.specProgress).toMatchObject({
      integrated: 2,
      required: 2,
      delivered: false,
    });
    expect(readyBoard.lanes.find((lane) => lane.id === "merged")?.cards ?? []).not.toContainEqual(
      expect.objectContaining({ issueNumber: 1860 }),
    );

    // Operator merges the final PR on the host, then delivery is verified.
    const publicationStatus = fixture.publication.getStatusByRun(fixture.projectId, status.runId!);
    const pr = publicationStatus.pullRequests[0]!;
    const mergeDir = join(fixture.root, "final-merge");
    execFileSync("git", ["clone", "-q", fixture.bareOrigin, mergeDir]);
    execFileSync("git", ["-C", mergeDir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", mergeDir, "config", "user.name", "Test"]);
    git(mergeDir, "checkout", "-q", pr.baseBranch);
    git(mergeDir, "fetch", "-q", "origin", `${pr.headBranch}:refs/remotes/origin/${pr.headBranch}`);
    git(mergeDir, "merge", "--no-ff", `origin/${pr.headBranch}`, "-m", "merge final");
    const mergeSha = git(mergeDir, "rev-parse", "HEAD");
    git(mergeDir, "push", "-q", "origin", pr.baseBranch);
    await fixture.forge.updatePullRequest(REPO, pr.number!, { draft: false });
    fixture.forge.setMergeRemote(() => ({ sha: mergeSha }));
    const merged = await fixture.forge.mergePullRequest(REPO, pr.number!);
    expect(merged.merged).toBe(true);

    const delivered = await fixture.finalService.verifyMerge(fixture.projectId, planId, "operator");
    expect(delivered.state).toBe("delivered");
    expect(delivered.delivered).toBe(true);

    const deliveredBoard = await fixture.fetchBoard();
    const deliveredParent = cardFor(deliveredBoard, 1860);
    expect(deliveredParent.lane).toBe("merged");
    expect(deliveredParent.stageLabel).toBe("Delivered");
    expect(deliveredParent.specProgress).toMatchObject({
      delivered: true,
      finalState: "delivered",
    });
    expect(deliveredParent.pullRequest).toMatchObject({ number: pr.number });

    const detail = await fixture.fetchWork(rootWorkId);
    expect(detail.kind).toBe("spec");
    expect(detail.plan?.kind).toBe("spec");
    expect(detail.plan?.authority).toBe("admitted");
    expect(detail.plan?.acceptance_criteria.map((criterion) => criterion.ac_key)).toEqual(
      expect.arrayContaining(["AC1", "AC2"]),
    );
    expect(detail.plan?.dependencies.length).toBeGreaterThan(0);
    expect(detail.final?.delivered).toBe(true);
    expect(detail.final?.children).toHaveLength(2);
    expect(detail.final?.children.every((child) => child.integrated)).toBe(true);
    expect(detail.final?.pullRequest).toMatchObject({ number: pr.number });
    expect(detail.specProgress?.delivered).toBe(true);
  }, 60_000);

  test("AC4/AC5: the worker count reflects live owner processes, not fabricated capacity", async () => {
    const { planId } = await fixture.importSpec(1870, [{ issue: 1871, coverage: "AC1" }], ["AC1"]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holdingRunner: DispatchRunner = async (context) => {
      await held;
      const name = `held-${context.issue_number}.txt`;
      writeFileSync(join(context.worktree_path, name), "implemented\n");
      git(context.worktree_path, "add", name);
      git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
      return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
    };
    const liveDispatch = new DispatchService(fixture.db, {
      plans: fixture.plans,
      ledger: new CommandLedger(fixture.db),
      brakes: new BrakeService(fixture.db),
      observations: fixture.observations,
      budget: fixture.budget,
      runner: holdingRunner,
      ownerPid: () => process.pid,
    });
    const pending = liveDispatch.dispatch(fixture.projectId, {
      plan_id: planId,
      issue_number: 1871,
      actor: "operator",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (liveDispatch.listRuns(fixture.projectId, { plan_id: planId }).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The backend app's own dispatch service is not the live one, but the board
    // reads the same durable run rows and real process ownership.
    const board = await fixture.fetchBoard();
    expect(cardFor(board, 1871).lane).toBe("working");
    expect(board.counts.workers).toBe(1);

    release();
    await pending;
    const settled = await fixture.fetchBoard();
    expect(settled.counts.workers).toBe(0);
  });

  test("work detail exposes the contract, laps, findings and retained state for a ticket", async () => {
    const { planId } = await fixture.importSpec(1880, [
      { issue: 1881, coverage: "AC1" },
      { issue: 1882, dependsOn: [1881], coverage: "AC2" },
    ]);
    const run = await fixture.dispatch.dispatch(fixture.projectId, {
      plan_id: planId,
      issue_number: 1881,
      actor: "operator",
    });
    const reviewer = fixture.observations.registerTrustedProducer(fixture.projectId, {
      id: "reviewer-detail",
      role: "peer_reviewer",
    });
    fixture.observations.recordRunObservation(fixture.projectId, run.id, {
      stage: "independent_review",
      status: "failed",
      producer: reviewer.producer,
      checks: [{ name: "standards", command: "review diff", result: "FAIL" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "impl.txt:1",
          summary: "AC1 is not satisfied",
        },
      ],
    });
    await fixture.publication.publishByRun(fixture.projectId, run.id);

    const detail = await fixture.fetchWork(run.work_id);
    expect(detail.kind).toBe("ticket");
    expect(detail.parent).toMatchObject({ issueNumber: 1880 });
    expect(detail.contract.title).toBe("Issue 1881");
    expect(detail.contract.body).toContain("Prepared ticket source.");
    expect(detail.plan?.kind).toBe("spec");
    expect(detail.runs.map((candidate) => candidate.lap)).toContain(1);
    expect(detail.latestRun?.run.id).toBe(run.id);
    expect(detail.latestRun?.acceptanceCriteria[0]?.acKey).toBe("AC1");
    expect(detail.evidence?.findings[0]).toMatchObject({
      severity: "blocking",
      status: "open",
      acKey: "AC1",
    });
    expect(detail.evidence?.findings[0]?.events.map((event) => event.action)).toContain("opened");
    expect(detail.integration?.state).toBe("blocked");
    expect(detail.publication?.pullRequests.length).toBeGreaterThan(0);
    expect(detail.usage.available).toBe(false);
  });

  test("planned dependency state is visible before the dependency integrates", async () => {
    await fixture.importSpec(1890, [
      { issue: 1891, coverage: "AC1" },
      { issue: 1892, dependsOn: [1891], coverage: "AC2" },
    ]);
    const board = await fixture.fetchBoard();
    const dependent = cardFor(board, 1892);
    expect(dependent.lane).toBe("ready");
    expect(dependent.stageLabel).toBe("Blocked by dependency");
    expect(dependent.detail).toContain("#1891");
  });
});
