// @vitest-environment jsdom
import React from "react";
import { describe, expect, test, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueExpandedWorkspace } from "../../apps/web/src/features/jobs/issue-expanded-workspace";
import { JobsScreen } from "../../apps/web/src/features/jobs/jobs-screen";
import { SidebarProvider } from "../../apps/web/src/components/ui/sidebar";
import {
  emptyBoard,
  mapTimelineMilestones,
  mapHarnessMetrics,
  type JobsBoardModel,
} from "../../apps/web/src/features/jobs/jobs-model";
import type { OperatorWorkDetail } from "@animus/contracts/operator";

const mockDetail = {
  projectId: "proj-1",
  generatedAt: Date.now(),
  work: {
    id: "work-1",
    project_id: "proj-1",
    repo_id: 1,
    repo_name: "animus/platform",
    issue_number: 102,
    created_at: Date.now() - 3600000,
    updated_at: Date.now() - 1800000,
    revision: {
      id: "rev-1",
      work_id: "work-1",
      project_id: "proj-1",
      revision_number: 1,
      content_hash: "a".repeat(64),
      source: {
        title: "Search ignores accents (crème brûlée vs creme brulee)",
        body: "Problem statement: Accented characters are not normalized during search matching.\nOutcome: Queries like creme brulee match crème brûlée.",
        state: "OPEN",
        labels: ["bug", "search"],
        comments: [],
      },
      provenance: {
        repo_id: 1,
        repo_name: "animus/platform",
        issue_number: 102,
        source_url: "https://github.com/animus/platform/issues/102",
        captured_at: Date.now() - 3600000,
      },
      imported_at: Date.now() - 3600000,
    },
  },
  kind: "standalone",
  lane: "merged",
  stageLabel: "Merged",
  detail: "PR #102 merged as f86af28",
  precedence: ["canonical"],
  role: null,
  planId: "plan-1",
  planKind: "standalone",
  parent: null,
  specProgress: null,
  contract: {
    title: "Search ignores accents (crème brûlée vs creme brulee)",
    body: "Problem statement: Accented characters are not normalized during search matching.\nOutcome: Queries like creme brulee match crème brûlée.",
    labels: ["bug", "search"],
    state: "OPEN",
    revisionNumber: 1,
    contentHash: "a".repeat(64),
    sourceUrl: "https://github.com/animus/platform/issues/102",
  },
  plan: {
    id: "plan-1",
    project_id: "proj-1",
    root_work_id: "work-1",
    kind: "standalone",
    delivery_branch: "main",
    integration_branch: null,
    dispatchable: true,
    authority: "operator",
    accepted_revision: null,
    holds: [],
    acceptance_criteria: [
      { id: "ac-1", plan_id: "plan-1", ac_key: "AC1", text: "Accent-insensitive query match" },
      { id: "ac-2", plan_id: "plan-1", ac_key: "AC2", text: "Preserves exact match rank" },
    ],
    dependencies: [],
    members: [],
  },
  final: null,
  runs: [],
  latestRun: {
    run: {
      id: "run-1",
      project_id: "proj-1",
      delivery_id: "del-1",
      plan_id: "plan-1",
      work_id: "work-1",
      revision_id: "rev-1",
      content_hash: "a".repeat(64),
      issue_number: 102,
      role: "standalone",
      gate_profile: "standalone",
      merge_policy: "rebase",
      target_branch: "main",
      ownership_generation: 1,
      lap: 1,
      state: "succeeded",
      actor: "operator",
      command_request_id: "req-1",
      branch: "factory/issue-102",
      worktree_path: "/tmp/worktree",
      base_sha: "b".repeat(40),
      owner_pid: null,
      owner_token: "tok",
      lease_expires_at: null,
      head_sha: "f86af28123456789",
      error: null,
      launched_at: Date.now() - 3000000,
      finished_at: Date.now() - 1000000,
      created_at: Date.now() - 3000000,
      updated_at: Date.now() - 1000000,
    },
    budget: null,
    control: null,
    grants: [],
    attempts: [],
    process: {
      ownerPid: null,
      ownerAlive: false,
      workerPid: null,
      workerAlive: false,
      worktreeLockPid: null,
      worktreeLockAlive: false,
    },
    claims: [],
    acceptanceCriteria: [
      { acKey: "AC1", text: "Accent-insensitive query match", openFindingIds: [] },
      { acKey: "AC2", text: "Preserves exact match rank", openFindingIds: [] },
    ],
    openFindings: [],
    acceptance: {
      runId: "run-1",
      projectId: "proj-1",
      deliveryId: "del-1",
      gateProfile: "standalone",
      candidateHeadSha: "f86af28",
      targetTipSha: "main-sha",
      mergeBaseSha: "base-sha",
      integrationLineage: "direct",
      authorized: true,
      reasons: ["all checks passed"],
      builderObservationId: "obs-1",
      independentObservationId: null,
      openBlockingFindingIds: [],
      verifiedArtifactIds: [],
    },
  },
  evidence: {
    observations: [
      {
        id: "obs-1",
        projectId: "proj-1",
        deliveryId: "del-1",
        runId: "run-1",
        lap: 1,
        attemptKey: "att-1",
        stage: "final_acceptance",
        status: "passed",
        candidateHeadSha: "f86af28",
        targetTipSha: "main-sha",
        mergeBaseSha: "base-sha",
        testedIdentity: "test-id",
        integrationLineage: "direct",
        producer: { id: "builder-1", role: "builder" },
        gateProfile: "standalone",
        gateProfileVersion: 1,
        error: null,
        createdAt: Date.now() - 1200000,
        checks: [
          {
            id: "chk-1",
            observationId: "obs-1",
            name: "Tests",
            command: "npm run test",
            result: "PASS",
            kind: "regression",
            criterionKey: "AC1",
            durationMs: 15000,
            detail: "48 passed",
            artifactPath: null,
            createdAt: Date.now() - 1200000,
          },
          {
            id: "chk-2",
            observationId: "obs-1",
            name: "Lint",
            command: "npm run lint",
            result: "PASS",
            kind: "standards",
            criterionKey: null,
            durationMs: 6000,
            detail: "Clean",
            artifactPath: null,
            createdAt: Date.now() - 1200000,
          },
        ],
        artifacts: [],
      },
    ],
    findings: [],
    acceptance: {
      runId: "run-1",
      projectId: "proj-1",
      deliveryId: "del-1",
      gateProfile: "standalone",
      candidateHeadSha: "f86af28",
      targetTipSha: "main-sha",
      mergeBaseSha: "base-sha",
      integrationLineage: "direct",
      authorized: true,
      reasons: ["all checks passed"],
      builderObservationId: "obs-1",
      independentObservationId: null,
      openBlockingFindingIds: [],
      verifiedArtifactIds: [],
    },
  },
  integration: null,
  gate: null,
  publication: {
    target: { state: "published" },
    auditComplete: true,
    queuedEventCount: 0,
    publishedEventCount: 1,
    failedIntentCount: 0,
    unknownIntentCount: 0,
    remoteStale: false,
    pullRequests: [
      {
        id: "pr-1",
        number: 102,
        url: "https://github.com/animus/platform/pull/102",
        state: "merged",
        draft: false,
        headSha: "f86af28",
        baseRef: "main",
        createdAt: Date.now() - 3000000,
        updatedAt: Date.now() - 1000000,
      },
    ],
  },
  retained: null,
  process: null,
  usage: {
    available: true,
    tokensIn: 84200,
    tokensOut: 12500,
    cacheReadTokens: 42000,
    costMicros: 1860000,
    detail: "Recorded session usage",
  },
};

const mockFactory: any = {
  forProject: () => ({
    workDetail: vi.fn().mockResolvedValue(mockDetail as unknown as OperatorWorkDetail),
  }),
};

describe("Expanded Issue Workspace (vDp5q)", () => {
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
  });

  test("mapper functions produce correct milestones and harness metrics", () => {
    const milestones = mapTimelineMilestones(mockDetail as unknown as OperatorWorkDetail);
    expect(milestones).toHaveLength(7);
    expect(milestones[0].label).toBe("Created");
    expect(milestones[0].status).toBe("completed");
    expect(milestones[milestones.length - 1].label).toBe("Merged");
    expect(milestones[milestones.length - 1].status).toBe("completed");

    const metrics = mapHarnessMetrics(mockDetail as unknown as OperatorWorkDetail);
    expect(metrics.tokensIn).toBe(84200);
    expect(metrics.tokensOut).toBe(12500);
    expect(metrics.costFormatted).toBe("$1.86");
    expect(metrics.model).toBe("Sonnet 4.5");
  });

  test("renders 2-column layout with issue inspector and factory execution panes", async () => {
    const onClose = vi.fn();
    render(
      <IssueExpandedWorkspace
        workId="work-1"
        projectId="proj-1"
        onClose={onClose}
        factory={mockFactory}
      />,
    );

    // Header & Identity
    await screen.findByText("Search ignores accents (crème brûlée vs creme brulee)");
    expect(screen.getByText(/animus\/platform/)).toBeTruthy();

    // PR badge
    expect(screen.getByText("PR #102")).toBeTruthy();
    expect(screen.getByText("(merged)")).toBeTruthy();

    // Contract Scope
    expect(screen.getByText("Scope & Contract")).toBeTruthy();
    expect(screen.getByText(/Problem statement: Accented characters/)).toBeTruthy();

    // Acceptance Criteria checklist
    expect(screen.getByText("Acceptance Criteria")).toBeTruthy();
    expect(screen.getByText("AC1")).toBeTruthy();
    expect(screen.getByText("Accent-insensitive query match")).toBeTruthy();

    // Evidence & Gate Verification
    expect(screen.getByText("Evidence & Gate Verification")).toBeTruthy();
    expect(screen.getByText("2 / 2 checks passed")).toBeTruthy();
    expect(screen.getAllByText("Tests").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Lint").length).toBeGreaterThan(0);

    // Factory Milestones Stepper
    expect(screen.getByText("Factory Timeline")).toBeTruthy();
    expect(screen.getByText("Lifecycle Stepper")).toBeTruthy();

    // Harness & Resource Metrics Card
    expect(screen.getByText("Harness & Resource Metrics")).toBeTruthy();
    expect(screen.getByText("$1.86")).toBeTruthy();
    expect(screen.getByText(/Sonnet 4.5/)).toBeTruthy();

    // Activity Stream
    expect(screen.getByText("Activity & Checks Stream")).toBeTruthy();

    // Close button invokes onClose
    const backButton = screen.getByRole("button", { name: "Back to Kanban" });
    fireEvent.click(backButton);
    expect(onClose).toHaveBeenCalled();
  });

  test("Escape key triggers onClose", async () => {
    const onClose = vi.fn();
    render(
      <IssueExpandedWorkspace
        workId="work-1"
        projectId="proj-1"
        onClose={onClose}
        factory={mockFactory}
      />,
    );
    await screen.findByText("Search ignores accents (crème brûlée vs creme brulee)");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("JobsScreen transitions between board mode and expanded workspace", async () => {
    const board: JobsBoardModel = {
      ...emptyBoard("animus/platform"),
      lanes: emptyBoard("animus/platform").lanes.map((lane) =>
        lane.id === "merged"
          ? {
              ...lane,
              count: 1,
              cards: [
                {
                  id: "card-1",
                  ref: "YTF-102",
                  stage: { label: "Merged", surface: "surface", ink: "success" },
                  title: "Search ignores accents",
                  workId: "work-1",
                },
              ],
            }
          : lane,
      ),
    };

    render(
      <SidebarProvider>
        <JobsScreen board={board} backendState="connected" projectId="proj-1" />
      </SidebarProvider>,
    );

    // Initial board mode: Kanban lanes are present
    expect(screen.getByRole("region", { name: "Merged" })).toBeTruthy();
    const cardTitleButton = screen.getByRole("button", {
      name: "Open details for YTF-102 Search ignores accents",
    });
    expect(cardTitleButton).toBeTruthy();

    // Click card to open expanded workspace
    fireEvent.click(cardTitleButton);

    // Loading or expanded workspace mounts
    expect(screen.getByTestId("expanded-workspace-loading")).toBeTruthy();
  });
});
