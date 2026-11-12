// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService } from "../../apps/backend/src/dispatch";
import { JobsBoard } from "../../apps/web/src/features/jobs/jobs-board";
import { WorkDetailDialog } from "../../apps/web/src/features/jobs/work-detail-dialog";
import { JobsScreen } from "../../apps/web/src/features/jobs/jobs-screen";
import { SidebarProvider } from "../../apps/web/src/components/ui/sidebar";
import {
  emptyBoard,
  mapOperatorBoard,
  type JobsBoardModel,
} from "../../apps/web/src/features/jobs/jobs-model";
import {
  REPO,
  ORIGINAL_ANIMUS_HOME,
  createFixture,
  git,
  type Fixture,
} from "./operator-board-fixture";

const LANES = [
  "Triage",
  "Ready",
  "Working",
  "Approval",
  "Needs owner",
  "Parked",
  "Merged",
  "Failed",
];

function lane(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function fixtureFactory(fixture: Fixture): any {
  return {
    forProject: () => ({
      workDetail: (workId: string) => fixture.readWork(workId),
    }),
  };
}

function recordReview(fixture: Fixture, runId: string, producerId = "reviewer-ui"): void {
  const producer = fixture.observations.registerTrustedProducer(fixture.projectId, {
    id: producerId,
    role: "peer_reviewer",
  });
  fixture.observations.recordRunObservation(fixture.projectId, runId, {
    stage: "code_review",
    status: "passed",
    producer: producer.producer,
    checks: [{ name: "standards", command: "review diff", result: "PASS", kind: "review" }],
  });
}

function recordAcceptance(fixture: Fixture, runId: string, producerId = "evaluator-ui"): void {
  const producer = fixture.observations.registerTrustedProducer(fixture.projectId, {
    id: producerId,
    role: "independent_evaluator",
  });
  fixture.observations.recordRunObservation(fixture.projectId, runId, {
    stage: "blackbox_verification",
    status: "passed",
    producer: producer.producer,
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
}

describe("operator board UI", () => {
  let fixture: Fixture;

  beforeAll(() => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as any).ResizeObserver = ResizeObserverStub;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    (HTMLElement.prototype as any).scrollIntoView = () => {};
    if (!Element.prototype.getAnimations) {
      Element.prototype.getAnimations = () => [];
    }
  });

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(() => {
    cleanup();
    try {
      fixture.db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test("screen: mounts exactly one canonical dispatch control and preserves all board lanes", async () => {
    render(
      <SidebarProvider>
        <JobsScreen board={emptyBoard("animus/platform")} backendState="connected" />
      </SidebarProvider>,
    );
    expect(screen.getAllByRole("heading", { name: "Run admitted plan" })).toHaveLength(1);
    for (const name of LANES) expect(lane(name)).toBeTruthy();
  });

  test("component: preserves the established columns and renders honest loading, error and empty states", () => {
    const board = emptyBoard("animus/platform");
    const { rerender } = render(
      <JobsBoard board={board} backendState="connected" loading={true} />,
    );
    expect(screen.getByTestId("board-loading")).toBeTruthy();
    expect(document.querySelectorAll("section[aria-label]")).toHaveLength(8);

    rerender(
      <JobsBoard
        board={board}
        backendState="connected"
        error="storage_failed"
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByTestId("board-error").textContent).toContain("storage_failed");
    expect(screen.getByText("Retry")).toBeTruthy();

    rerender(<JobsBoard board={board} backendState="connected" />);
    expect(screen.getByTestId("board-empty")).toBeTruthy();
    const labels = [...document.querySelectorAll("section[aria-label]")].map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(labels).toEqual(LANES);
  });

  test("layout: docks the compact inspector inside the kanban wrapper so the KPI row keeps full width", () => {
    render(
      <JobsBoard
        board={emptyBoard("animus/platform")}
        backendState="connected"
        sideSheet={<div data-testid="side-sheet-content" />}
      />,
    );

    const kpiRow = screen.getByTestId("kpi-row");
    const kanbanWrapper = screen.getByTestId("kanban-wrapper");
    const sideSheet = screen.getByTestId("side-sheet-content");

    expect(kpiRow.contains(kanbanWrapper)).toBe(false);
    expect(kanbanWrapper.contains(sideSheet)).toBe(true);
    expect(kpiRow.contains(sideSheet)).toBe(false);
  });

  test("backend-driven: parent partial progress, parent refs, mixed Needs owner / correction / publication / stale states and live workers", async () => {
    const { planId } = await fixture.importSpec(
      1900,
      [
        { issue: 1901, coverage: "AC1" },
        { issue: 1902, coverage: "AC2" },
        { issue: 1903, coverage: "AC3" },
      ],
      ["AC1 — first", "AC2 — second", "AC3 — third"],
    );
    await fixture.integrateChild(planId, 1901, "one");

    // Child 1902: a failed independent review returns it to correction.
    const failedReviewRun = await fixture.dispatch.dispatch(fixture.projectId, {
      plan_id: planId,
      issue_number: 1902,
      actor: "operator",
    });
    const reviewer = fixture.observations.registerTrustedProducer(fixture.projectId, {
      id: "reviewer-correction",
      role: "peer_reviewer",
    });
    fixture.observations.recordRunObservation(fixture.projectId, failedReviewRun.id, {
      stage: "code_review",
      status: "failed",
      producer: reviewer.producer,
      checks: [{ name: "standards", command: "review diff", result: "FAIL" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC2",
          fileContext: "impl.txt:1",
          summary: "AC2 is not satisfied",
        },
      ],
    });
    await fixture.publication.publishByRun(fixture.projectId, failedReviewRun.id);

    // Child 1903: three rejected laps exhaust the budget into Needs owner.
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
          issue_number: 1903,
          actor: "operator",
        })
        .catch(() => {});
    }

    // Standalone 1910: gates pass, publication is still pending.
    const pending = await fixture.importStandalone(1910);
    const pendingRun = await fixture.dispatch.dispatch(fixture.projectId, {
      plan_id: pending.planId,
      actor: "operator",
    });
    recordReview(fixture, pendingRun.id);
    recordAcceptance(fixture, pendingRun.id);

    // Standalone 1920: evidence is stale after the delivery branch advances.
    const stale = await fixture.importStandalone(1920);
    const staleRun = await fixture.dispatch.dispatch(fixture.projectId, {
      plan_id: stale.planId,
      actor: "operator",
    });
    recordReview(fixture, staleRun.id, "reviewer-stale");
    recordAcceptance(fixture, staleRun.id, "evaluator-stale");
    await fixture.publication.publishByRun(fixture.projectId, staleRun.id);
    const advance = join(fixture.root, "advance-ui");
    execFileSync("git", ["clone", "-q", fixture.bareOrigin, advance]);
    execFileSync("git", ["-C", advance, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", advance, "config", "user.name", "Test"]);
    git(advance, "commit", "--allow-empty", "-q", "-m", "advance main");
    git(advance, "push", "-q", "origin", "main");

    // Standalone 1930: a live owner process counts as one actual worker.
    const live = await fixture.importStandalone(1930);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const liveDispatch = new DispatchService(fixture.db, {
      plans: fixture.plans,
      ledger: new CommandLedger(fixture.db),
      brakes: new BrakeService(fixture.db),
      observations: fixture.observations,
      budget: fixture.budget,
      ownerPid: () => process.pid,
      runner: async (context) => {
        await held;
        const name = `live-${context.issue_number}.txt`;
        writeFileSync(join(context.worktree_path, name), "implemented\n");
        git(context.worktree_path, "add", name);
        git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
        return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
      },
    });
    const pendingLive = liveDispatch.dispatch(fixture.projectId, {
      plan_id: live.planId,
      actor: "operator",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (liveDispatch.listRuns(fixture.projectId, { plan_id: live.planId }).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    let board: JobsBoardModel;
    try {
      board = mapOperatorBoard(await fixture.readBoard());
      render(<JobsBoard board={board} backendState="connected" />);

      const labels = [...document.querySelectorAll("section[aria-label]")].map((node) =>
        node.getAttribute("aria-label"),
      );
      expect(labels).toEqual(LANES);

      // Parent partial progress: 1/3 integrated, not delivered.
      const ready = lane("Ready");
      expect(within(ready).getByText(/#1900/)).toBeTruthy();
      expect(within(ready).getByText(/1\/3 tickets integrated/)).toBeTruthy();
      expect(within(ready).getByText(/waiting for children/)).toBeTruthy();

      // Integrated child keeps its parent reference and does not imply delivery.
      const merged = lane("Merged");
      expect(within(merged).getByText("Part of #1900")).toBeTruthy();
      expect(within(merged).getByText(/parent delivery is separate/)).toBeTruthy();

      // Failed review is a correction, not a merge.
      const working = lane("Working");
      expect(within(working).getByText("Correction required")).toBeTruthy();
      expect(within(working).getAllByText("Part of #1900").length).toBeGreaterThan(0);

      // Exhausted ticket is Needs owner.
      const needsOwner = lane("Needs owner");
      expect(within(needsOwner).getByText(/Attempt budget exhausted/)).toBeTruthy();
      expect(within(needsOwner).getAllByText("Needs owner").length).toBeGreaterThan(0);

      // Pending publication and stale evidence are distinct honest states.
      expect(within(lane("Approval")).getByText("Awaiting publication")).toBeTruthy();
      expect(within(lane("Failed")).getByText("Evidence stale")).toBeTruthy();

      // Counts distinguish specs, executable tickets and actual workers.
      expect(screen.getByText("1 / 3")).toBeTruthy();
      const ticketKpi = screen.getByText("Executable tickets").parentElement!.parentElement!;
      expect(within(ticketKpi).getByText("6")).toBeTruthy();
      expect(screen.getByText("1 specs · 0 unplanned")).toBeTruthy();
      expect(screen.getAllByText("Unavailable").length).toBe(2);
    } finally {
      release();
      await pendingLive;
    }
  }, 60_000);

  test("backend-driven: final delivery waits for manual merge, then renders delivered only after verified merge", async () => {
    const { planId, branch } = await fixture.importSpec(1950, [
      { issue: 1951, coverage: "AC1" },
      { issue: 1952, coverage: "AC2" },
    ]);
    await fixture.integrateChild(planId, 1951, "final-one");
    await fixture.integrateChild(planId, 1952, "final-two");

    const plan = fixture.plans.getPlan(fixture.projectId, planId);
    function bindEvidence(runId: string): void {
      const status = fixture.publication.getStatusByRun(fixture.projectId, runId);
      for (const observation of fixture.observations.listObservations(fixture.projectId, {
        workId: plan.root_work_id,
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

    render(
      <JobsBoard board={mapOperatorBoard(await fixture.readBoard())} backendState="connected" />,
    );
    expect(within(lane("Approval")).getByText("Awaiting manual merge")).toBeTruthy();
    expect(within(lane("Approval")).getByText(/2\/2 tickets integrated/)).toBeTruthy();
    expect(within(lane("Merged")).queryByText("#1950")).toBeNull();
    cleanup();

    const publicationStatus = fixture.publication.getStatusByRun(fixture.projectId, status.runId!);
    const pr = publicationStatus.pullRequests[0]!;
    const mergeDir = join(fixture.root, "final-merge-ui");
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
    await fixture.forge.mergePullRequest(REPO, pr.number!);
    const delivered = await fixture.finalService.verifyMerge(fixture.projectId, planId, "operator");
    expect(delivered.state).toBe("delivered");

    render(
      <JobsBoard board={mapOperatorBoard(await fixture.readBoard())} backendState="connected" />,
    );
    const merged = lane("Merged");
    expect(within(merged).getByText("#1950")).toBeTruthy();
    expect(within(merged).getByText("Delivered")).toBeTruthy();
    expect(within(merged).getByText(/2\/2 tickets integrated · delivered/)).toBeTruthy();
    void branch;
  }, 60_000);

  test("backend-driven: parent and child detail reuse the canonical plan, evidence and final panels", async () => {
    const { planId } = await fixture.importSpec(
      1960,
      [
        { issue: 1961, coverage: "AC1" },
        { issue: 1962, coverage: "AC2" },
      ],
      ["AC1 — detail parent", "AC2 — detail parent"],
    );
    await fixture.integrateChild(planId, 1961, "detail-one");
    const childRun = await fixture.dispatch.dispatch(fixture.projectId, {
      plan_id: planId,
      issue_number: 1962,
      actor: "operator",
    });
    const reviewer = fixture.observations.registerTrustedProducer(fixture.projectId, {
      id: "reviewer-detail-ui",
      role: "peer_reviewer",
    });
    fixture.observations.recordRunObservation(fixture.projectId, childRun.id, {
      stage: "code_review",
      status: "failed",
      producer: reviewer.producer,
      checks: [{ name: "standards", command: "review diff", result: "FAIL" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC2",
          fileContext: "impl.txt:1",
          summary: "AC2 is missing from the candidate",
        },
      ],
    });
    await fixture.publication.publishByRun(fixture.projectId, childRun.id);

    const board = await fixture.readBoard();
    const factory = fixtureFactory(fixture);
    const plan = fixture.plans.getPlan(fixture.projectId, planId);

    render(
      <WorkDetailDialog
        workId={plan.root_work_id}
        projectId={fixture.projectId}
        onClose={() => {}}
        factory={factory}
      />,
    );
    await screen.findByText("Approved plan");
    expect(screen.getByText(/AC1 — detail parent/)).toBeTruthy();
    expect(screen.getByText("Dependencies")).toBeTruthy();
    expect(screen.getByText("Parent delivery")).toBeTruthy();
    expect(screen.getByText(/1\/2 tickets integrated/)).toBeTruthy();
    expect(screen.getByText(/1\/2 children integrated/)).toBeTruthy();
    cleanup();

    const childCard = board.lanes
      .flatMap((entry) => entry.cards)
      .find((card) => card.issueNumber === 1962)!;
    render(
      <WorkDetailDialog
        workId={childCard.workId}
        projectId={fixture.projectId}
        onClose={() => {}}
        factory={factory}
      />,
    );
    await screen.findByText("Contract");
    expect(screen.getByText(/Prepared ticket source/)).toBeTruthy();
    expect(screen.getByText("Runs and laps")).toBeTruthy();
    expect(screen.getByText(/Checks, findings and evidence/)).toBeTruthy();
    expect(screen.getAllByText(/AC2 is missing from the candidate/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/opened/).length).toBeGreaterThan(0);
    expect(screen.getByText("Operator controls")).toBeTruthy();
    expect(screen.getByText("Part of #1960")).toBeTruthy();
  }, 60_000);
});
