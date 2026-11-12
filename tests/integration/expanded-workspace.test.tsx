// @vitest-environment jsdom
import React from "react";
import { describe, expect, test, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
  draft: {
    id: "draft-1",
    project_id: "proj-1",
    work_id: "work-1",
    source_revision_id: "rev-1",
    latest_revision: {
      id: "draft-rev-1",
      draft_id: "draft-1",
      revision_number: 1,
      source_revision_id: "rev-1",
      intent: "Refined plan",
      questions: [],
      answers: [],
      proposed_plan: "Implement accent normalization query filter",
      proposed_acceptance_criteria: [
        "Accent-insensitive query match",
        "Preserves exact match rank",
      ],
      planner_metadata: {
        model: "Sonnet 4.5",
        provider: "Anthropic",
      },
      created_at: Date.now() - 3600000,
    },
    latest_decision: null,
    created_at: Date.now() - 3600000,
    updated_at: Date.now() - 3600000,
  },
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
        stage: "blackbox_verification",
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
  executionSteps: [
    { id: "created", label: "Created", status: "completed", time: "13:17", logs: [] },
    { id: "triage", label: "Triage", status: "completed", time: "13:17–13:26", logs: [] },
    { id: "ready", label: "Ready", status: "completed", time: "13:26", logs: [] },
    {
      id: "implement-1",
      label: "Implement · lap 1",
      status: "completed",
      time: "13:26–13:40",
      logs: [
        { timestamp: "13:38:22", event: "stdout", message: "Accent regression suite passed." },
        { timestamp: "13:35:42", event: "Edit", message: "Added shared normalize() helper." },
      ],
    },
    {
      id: "verify-1",
      label: "Verification · lap 1",
      status: "completed",
      time: "13:40–13:45",
      logs: [],
    },
  ],
  realtimeLogs: [
    {
      id: "log-1",
      timestamp: "13:45:28",
      event: "evidence",
      message: "4/4 checks passed at a91f2c4.",
    },
    {
      id: "log-2",
      timestamp: "13:48:12",
      event: "review",
      message: "Ready to merge — awaiting human.",
    },
  ],
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
    if (!Element.prototype.getAnimations) {
      Element.prototype.getAnimations = () => [];
    }
    if (!(HTMLElement.prototype as any).scrollIntoView) {
      (HTMLElement.prototype as any).scrollIntoView = () => {};
    }
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

  afterEach(() => {
    cleanup();
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

    // Pinned issue header: identity, title, stage metadata, execution context.
    await screen.findByText("Search ignores accents (crème brûlée vs creme brulee)");
    expect(screen.getAllByText(/animus\/platform/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Merged").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Back to Kanban" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close workspace" })).toBeTruthy();

    // Outcome block: single hairline section, no nested card.
    expect(screen.getByText("Outcome")).toBeTruthy();
    expect(screen.getByText(/Merged and verified/)).toBeTruthy();

    // Evidence gates read from the canonical observation set.
    expect(screen.getAllByText("Evidence").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 / 2 checks passed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Tests").length).toBeGreaterThan(0);
    expect(screen.getByText("npm run test")).toBeTruthy();

    // Factory rail: exactly the three canonical sections.
    expect(screen.getByText("Factory timeline")).toBeTruthy();
    expect(screen.getByText("Token usage")).toBeTruthy();
    expect(screen.getByText("Harness logs")).toBeTruthy();
    expect(screen.getByText("TIME")).toBeTruthy();
    expect(screen.getByText("TOOL / EVENT")).toBeTruthy();
    expect(screen.getByText("MESSAGE")).toBeTruthy();
    expect(screen.getAllByText(/\$1\.86/).length).toBeGreaterThan(0);

    // Timeline accordion lists every executed step and only one open panel.
    expect(screen.getAllByText("Implement · lap 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Verification · lap 1").length).toBeGreaterThan(0);
    expect(screen.getByText("One step open at a time · steps appear as they run")).toBeTruthy();
    expect(screen.getAllByText(/Ready to merge — awaiting human\./).length).toBeGreaterThan(0);

    // Disclosures close the inspector.
    expect(screen.getByText("Refined ticket & original issue")).toBeTruthy();
    expect(screen.getByText("Audit log")).toBeTruthy();

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
        <JobsScreen
          board={board}
          backendState="connected"
          projectId="proj-1"
          factory={mockFactory}
        />
      </SidebarProvider>,
    );

    // Initial board mode: Kanban lanes are present
    expect(screen.getByRole("region", { name: "Merged" })).toBeTruthy();
    const cardTitleButton = screen.getByRole("button", {
      name: "Open details for YTF-102 Search ignores accents",
    });
    expect(cardTitleButton).toBeTruthy();

    // Click card on Kanban board -> opens 500px Compact Side-Sheet alongside board
    fireEvent.click(cardTitleButton);
    expect(screen.getByTestId("compact-side-sheet")).toBeTruthy();

    // Click "Expand" -> transitions into Expanded 2-Column Workspace
    const expandButton = await screen.findByRole("button", {
      name: "Expand to full workspace",
    });
    fireEvent.click(expandButton);
    expect(screen.getByTestId("expanded-workspace-loading")).toBeTruthy();
  });

  test("JobsScreen: compact sheet reuses the expanded left pane with independent pane scroll", async () => {
    const questions = [
      {
        id: "q1",
        question: "Where are new users getting stuck today?",
        reason: "The current drop-off point is not recorded.",
      },
    ];
    const triageDetail = {
      ...mockDetail,
      lane: "triage",
      stageLabel: "Needs triage",
      detail: "Imported work is not part of an approved plan.",
      latestRun: null,
      evidence: null,
      publication: null,
      specProgress: null,
      draft: {
        ...mockDetail.draft,
        status: "needs_clarification",
        latest_revision: {
          ...mockDetail.draft.latest_revision,
          plan: {
            kind: "clarification",
            reason:
              "The intended flow and acceptance criteria are not clear enough to prepare an actionable ticket.",
            questions,
          },
          questions,
          answers: [],
        },
      },
    };

    const board: JobsBoardModel = {
      ...emptyBoard("animus/platform"),
      lanes: emptyBoard("animus/platform").lanes.map((lane) =>
        lane.id === "triage"
          ? {
              ...lane,
              count: 1,
              cards: [
                {
                  id: "card-triage",
                  ref: "#153",
                  stage: { label: "Needs triage", surface: "warning-bg", ink: "warning" },
                  title: "Improve onboarding",
                  workId: "work-triage",
                },
              ],
            }
          : lane,
      ),
    };

    render(
      <SidebarProvider>
        <JobsScreen
          board={board}
          backendState="connected"
          projectId="proj-1"
          factory={
            {
              forProject: () => ({
                workDetail: async () => triageDetail as unknown as OperatorWorkDetail,
              }),
            } as any
          }
        />
      </SidebarProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open details for #153 Improve onboarding" }),
    );

    const sheet = await screen.findByTestId("compact-side-sheet");
    expect(await screen.findByText("What triage read")).toBeTruthy();
    expect(screen.getByTestId("compact-side-sheet-scroll")).toBeTruthy();
    expect(screen.getAllByText(/Where are new users getting stuck today\?/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("button", { name: "Provide context" })).toBeTruthy();
    expect(screen.getAllByText("Needs clarification").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/animus\/platform/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open source issue on GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand to full workspace" })).toBeTruthy();

    const compactLabels = [
      ...sheet.querySelectorAll('[data-testid="issue-inspector-pane"] section[aria-label]'),
    ].map((node) => node.getAttribute("aria-label"));
    expect(compactLabels.length).toBeGreaterThan(0);

    const kpiRow = screen.getByTestId("kpi-row");
    const kanbanWrapper = screen.getByTestId("kanban-wrapper");
    expect(kpiRow.contains(kanbanWrapper)).toBe(false);
    expect(kanbanWrapper.contains(sheet)).toBe(true);
    expect(kpiRow.contains(sheet)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Expand to full workspace" }));
    const workspace = await screen.findByTestId("expanded-issue-workspace");

    const leftPane = screen.getByRole("region", { name: "Issue Inspector" });
    const expandedLabels = [
      ...leftPane.querySelectorAll('[data-testid="issue-inspector-pane"] section[aria-label]'),
    ].map((node) => node.getAttribute("aria-label"));
    expect(expandedLabels).toEqual(compactLabels);

    expect(screen.getByTestId("issue-inspector-scroll")).toBeTruthy();
    expect(screen.getByTestId("factory-rail-scroll")).toBeTruthy();
    expect(workspace.querySelector('[data-testid="issue-inspector-scroll"]')).toBeTruthy();
    expect(workspace.querySelector('[data-testid="factory-rail-scroll"]')).toBeTruthy();
  });
});
