// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  FactoryEngineState,
  OperatorBoard,
  OperatorWorkDetail,
  Project,
} from "@animus/contracts/operator";
import { SidebarProvider } from "../../apps/web/src/components/ui/sidebar";
import { JobsScreen } from "../../apps/web/src/features/jobs/jobs-screen";
import { InboxScreen } from "../../apps/web/src/features/inbox/inbox-screen";
import { JobsHeader } from "../../apps/web/src/features/jobs/jobs-header";
import {
  ALL_PROJECTS_ID,
  emptyBoard,
  mergeOperatorBoards,
} from "../../apps/web/src/features/jobs/jobs-model";

const PROJECTS: Project[] = [
  {
    id: "prj_alpha",
    name: "Alpha",
    repo_id: 101,
    repo_name: "owner/alpha",
    checkout_path: "/tmp/alpha",
    status: "active",
    status_reason: null,
    created_at: "2026-11-10T00:00:00Z",
    updated_at: "2026-11-10T00:00:00Z",
  },
  {
    id: "prj_beta",
    name: "Beta",
    repo_id: 102,
    repo_name: "owner/beta",
    checkout_path: "/tmp/beta",
    status: "active",
    status_reason: null,
    created_at: "2026-11-10T00:00:00Z",
    updated_at: "2026-11-10T00:00:00Z",
  },
];

function makeRawBoard(
  projectId: string,
  repository: string,
  laneId: "triage" | "approval",
  workId: string,
  issueNumber: number,
  title: string,
): OperatorBoard {
  return {
    projectId,
    repository,
    generatedAt: 1_700_000_000_000,
    precedence: ["unplanned"],
    counts: {
      specs: 0,
      tickets: 1,
      unplanned: laneId === "triage" ? 1 : 0,
      workers: 0,
      capacity: 4,
    },
    lanes: (
      [
        "triage",
        "ready",
        "working",
        "approval",
        "needs-owner",
        "parked",
        "merged",
        "failed",
      ] as const
    ).map((id) => ({
      id,
      count: id === laneId ? 1 : 0,
      cards:
        id === laneId
          ? [
              {
                id: `card_${workId}`,
                kind: "ticket" as const,
                lane: id,
                workId,
                issueNumber,
                title,
                ref: `#${issueNumber}`,
                updatedAt: 1_700_000_000_000,
                role: "ticket",
                gateProfile: null,
                planId: null,
                planKind: null,
                parent: null,
                stageLabel: id === "approval" ? "Ready to merge" : "Needs triage",
                detail: id === "approval" ? "Waiting for operator approval." : "Needs triage.",
                precedence: ["unplanned"],
                specProgress: null,
                latestRun: null,
                budgetStatus: "active",
                controlStatus: null,
                integrationState: null,
                gateState: null,
                finalState: null,
                pullRequest: null,
                process: null,
                usage: {
                  available: true,
                  tokensIn: 900,
                  tokensOut: 300,
                  cacheReadTokens: 0,
                  costMicros: 20_000,
                  detail: "1.2k tokens",
                },
              },
            ]
          : [],
    })),
    usage: {
      available: true,
      tokensIn: 900,
      tokensOut: 300,
      cacheReadTokens: 0,
      costMicros: 20_000,
      detail: "1.2k tokens",
    },
  };
}

function makeMockFactory(initialMode: FactoryEngineState["mode"] = "running", activeRuns = 0) {
  let state: FactoryEngineState = {
    mode: initialMode,
    global_launch_brake: initialMode === "stopped",
    schedule_pause: initialMode === "paused",
    active_runs: activeRuns,
    updated_at: "2026-11-14T00:00:00Z",
  };
  const publishTicket = vi.fn(
    async (input: { title: string; body: string; labels?: string[] }) => ({
      repo: "owner/beta",
      issue: {
        number: 42,
        title: input.title,
        body: input.body,
        state: "OPEN",
        labels: input.labels ?? ["needs-triage"],
        comments: [],
        url: "https://github.com/owner/beta/issues/42",
        updatedAt: "2026-11-14T00:00:00Z",
        admission_status: "held" as const,
        hold_reasons: [],
        section_checks: [],
      },
      created_at: "2026-11-14T00:00:00Z",
    }),
  );
  const workDetail = vi.fn(async (workId: string): Promise<OperatorWorkDetail> => ({
    projectId: "prj_beta",
    generatedAt: 1_700_000_000_000,
    work: {
      id: workId,
      project_id: "prj_beta",
      repo_id: 102,
      repo_name: "owner/beta",
      issue_number: 22,
      revision: {
        id: "rev_1",
        work_id: workId,
        project_id: "prj_beta",
        revision_number: 1,
        content_hash: "a".repeat(64),
        source: {
          title: "Beta approval item",
          body: "Detailed body for beta approval item",
          state: "OPEN",
          labels: ["ready-for-agent"],
          comments: [],
        },
        provenance: {
          repo_id: 102,
          repo_name: "owner/beta",
          issue_number: 22,
          source_url: "https://github.com/owner/beta/issues/22",
          captured_at: 1_700_000_000_000,
        },
        imported_at: 1_700_000_000_000,
      },
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    },
    kind: "ticket",
    lane: "approval",
    stageLabel: "Ready to merge",
    detail: "Waiting for operator approval.",
    precedence: ["unplanned"],
    role: "ticket",
    planId: null,
    planKind: null,
    parent: null,
    specProgress: null,
    contract: {
      title: "Beta approval item",
      body: "Detailed body for beta approval item",
      labels: ["ready-for-agent"],
      state: "OPEN",
      revisionNumber: 1,
      contentHash: "a".repeat(64),
      sourceUrl: "https://github.com/owner/beta/issues/22",
    },
    plan: null,
    draft: null,
    final: null,
    runs: [],
    latestRun: null,
    evidence: null,
    integration: null,
    gate: null,
    publication: null,
    retained: null,
    process: null,
    usage: {
      available: true,
      tokensIn: 900,
      tokensOut: 300,
      cacheReadTokens: 0,
      costMicros: 20_000,
      detail: "1.2k tokens",
    },
    executionSteps: [],
    realtimeLogs: [],
  }));
  const forProject = vi.fn(() => ({
    publishTicket,
    workDetail,
  }));
  const engineState = vi.fn(async () => state);
  const setEngineState = vi.fn(async (submission: { mode: FactoryEngineState["mode"] }) => {
    state = {
      mode: submission.mode,
      global_launch_brake: submission.mode === "stopped",
      schedule_pause: submission.mode === "paused",
      active_runs: submission.mode === "stopped" ? 0 : activeRuns,
      stopped_runs: submission.mode === "stopped" ? activeRuns : undefined,
      failed_runs: submission.mode === "stopped" ? 0 : undefined,
      updated_at: "2026-11-14T00:01:00Z",
    };
    return state;
  });

  return {
    factory: { engineState, setEngineState, forProject } as any,
    publishTicket,
    workDetail,
    forProject,
    engineState,
    setEngineState,
  };
}

describe("web header parity, all repositories, engine control & new job UI", () => {
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

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("JobsScreen and InboxScreen share unified header without Notifications bell or List/Kanban toggle", async () => {
    const merged = mergeOperatorBoards([
      makeRawBoard("prj_alpha", "owner/alpha", "approval", "wrk_a", 11, "Alpha approval task"),
      makeRawBoard("prj_beta", "owner/beta", "approval", "wrk_b", 22, "Beta approval task"),
    ]);
    const mock = makeMockFactory("running", 0);
    const onSelectProject = vi.fn();

    const { rerender } = render(
      <SidebarProvider>
        <JobsScreen
          board={merged}
          backendState="connected"
          projectId={ALL_PROJECTS_ID}
          projects={PROJECTS}
          onSelectProject={onSelectProject}
          factory={mock.factory}
        />
      </SidebarProvider>,
    );

    expect(screen.getByRole("group", { name: "Factory state" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New job/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Notifications/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /View mode/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^List$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Kanban$/i })).toBeNull();

    rerender(
      <SidebarProvider>
        <InboxScreen
          board={merged}
          backendState="connected"
          includeFailed={false}
          projectId={ALL_PROJECTS_ID}
          projects={PROJECTS}
          onSelectProject={onSelectProject}
          onOpenJobs={() => {}}
          factory={mock.factory}
        />
      </SidebarProvider>,
    );

    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Factory state" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New job/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Notifications/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /View mode/i })).toBeNull();
    // Inbox rows display repository badges when aggregated across repos
    expect(screen.getByText("owner/alpha")).toBeTruthy();
    expect(screen.getByText("owner/beta")).toBeTruthy();
  });

  test("RepositorySelector includes All repositories and JobsScreen resolves per-card projectId", async () => {
    const merged = mergeOperatorBoards([
      makeRawBoard("prj_alpha", "owner/alpha", "triage", "wrk_a", 11, "Alpha triage item"),
      makeRawBoard("prj_beta", "owner/beta", "approval", "wrk_b", 22, "Beta approval item"),
    ]);
    expect(merged.repository).toBe("All repositories");
    expect(merged.totalJobs).toBe(2);
    expect(merged.kpis.length).toBeGreaterThan(0);
    expect(merged.lanes.find((l) => l.id === "approval")?.count).toBe(1);

    const mock = makeMockFactory("running", 0);
    const onSelectProject = vi.fn();

    render(
      <SidebarProvider>
        <JobsScreen
          board={merged}
          backendState="connected"
          projectId="prj_alpha"
          projects={PROJECTS}
          onSelectProject={onSelectProject}
          factory={mock.factory}
        />
      </SidebarProvider>,
    );

    // Open repository selector dropdown and choose "All repositories"
    fireEvent.click(screen.getByRole("button", { name: /All repositories|owner\/alpha/i }));
    const allRepoBtn = await screen.findByRole("button", { name: /All repositories/i });
    fireEvent.click(allRepoBtn);
    expect(onSelectProject).toHaveBeenCalledWith(ALL_PROJECTS_ID);

    // Clicking the card owned by prj_beta should query workDetail on prj_beta
    fireEvent.click(screen.getByText("Beta approval item"));
    await waitFor(() => {
      expect(mock.forProject).toHaveBeenCalledWith("prj_beta");
      expect(mock.workDetail).toHaveBeenCalledWith("wrk_b");
    });
    expect((await screen.findAllByText(/aaaaaaa/)).length).toBeGreaterThan(0);
  });

  test("mergeOperatorBoards preserves machine-wide capacity instead of summing across repos", () => {
    const boardA = makeRawBoard("prj_alpha", "owner/alpha", "triage", "wrk_a", 11, "Alpha triage");
    const boardB = makeRawBoard("prj_beta", "owner/beta", "approval", "wrk_b", 22, "Beta approval");
    boardA.counts.capacity = 2;
    boardB.counts.capacity = 2;
    boardA.counts.workers = 1;
    boardB.counts.workers = 0;

    const merged = mergeOperatorBoards([boardA, boardB]);
    const workerKpi = merged.kpis.find((k) => k.label === "Active workers");
    expect(workerKpi?.value).toBe("1 / 2");
    expect(workerKpi?.description).toBe("1 slots available");
  });

  test("Engine Control: switches to Paused directly, confirms before Stopped, and shows errors", async () => {
    const mock = makeMockFactory("running", 3);
    const onRefresh = vi.fn();
    const board = emptyBoard("owner/alpha");

    render(
      <SidebarProvider>
        <JobsHeader
          board={board}
          projects={PROJECTS}
          currentProjectId="prj_alpha"
          onSelectProject={() => {}}
          onRefresh={onRefresh}
          factory={mock.factory}
        />
      </SidebarProvider>,
    );

    await waitFor(() => expect(mock.engineState).toHaveBeenCalled());

    // Pause immediately without dialog
    const pausedBtn = screen.getByRole("button", { name: /Paused/i });
    fireEvent.click(pausedBtn);
    await waitFor(() => {
      expect(mock.setEngineState).toHaveBeenCalledWith({ mode: "paused", actor: "operator" });
    });
    expect(pausedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(onRefresh).toHaveBeenCalled();

    // Clicking Stopped opens confirmation dialog showing 3 active AI runs
    const stoppedBtn = screen.getByRole("button", { name: /Stopped/i });
    fireEvent.click(stoppedBtn);
    const alertDialog = await screen.findByRole("alertdialog");
    expect(alertDialog.textContent).toContain("3 active AI runs");
    expect(mock.setEngineState).toHaveBeenCalledTimes(1);

    // Cancel leaves state paused
    fireEvent.click(within(alertDialog).getByRole("button", { name: /Cancel/i }));
    expect(mock.setEngineState).toHaveBeenCalledTimes(1);

    // Confirm Stop executes hard stop
    fireEvent.click(stoppedBtn);
    const confirmDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: /Stop factory/i }));
    await waitFor(() => {
      expect(mock.setEngineState).toHaveBeenCalledWith({ mode: "stopped", actor: "operator" });
    });
    expect(stoppedBtn.getAttribute("aria-pressed")).toBe("true");

    // Negative: error while switching back to Running renders alert and keeps Stopped pressed
    mock.setEngineState.mockRejectedValueOnce(new Error("brake_update_failed"));
    fireEvent.click(screen.getByRole("button", { name: /Running/i }));
    const errAlert = await screen.findByRole("alert");
    expect(errAlert.textContent).toContain("brake_update_failed");
    expect(stoppedBtn.getAttribute("aria-pressed")).toBe("true");
  });

  test("New job modal: disabled when empty repos, validates empty title, creates ticket and handles failure", async () => {
    const mock = makeMockFactory("running", 0);
    const onRefresh = vi.fn();
    const board = emptyBoard("All repositories");

    const { rerender } = render(
      <SidebarProvider>
        <JobsHeader
          board={board}
          projects={[]}
          currentProjectId={null}
          onSelectProject={() => {}}
          onRefresh={onRefresh}
          factory={mock.factory}
        />
      </SidebarProvider>,
    );

    expect((screen.getByRole("button", { name: /New job/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    rerender(
      <SidebarProvider>
        <JobsHeader
          board={board}
          projects={PROJECTS}
          currentProjectId={ALL_PROJECTS_ID}
          onSelectProject={() => {}}
          onRefresh={onRefresh}
          factory={mock.factory}
        />
      </SidebarProvider>,
    );

    const newJobBtn = screen.getByRole("button", { name: /New job/i }) as HTMLButtonElement;
    expect(newJobBtn.disabled).toBe(false);
    fireEvent.click(newJobBtn);

    const dialog = await screen.findByRole("dialog");
    const submitBtn = within(dialog).getByRole("button", {
      name: /Create job/i,
    }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // Choose prj_beta, enter title, body and ready-for-agent stage
    fireEvent.change(within(dialog).getByLabelText("Repository"), {
      target: { value: "prj_beta" },
    });
    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "  Add billing export  " },
    });
    fireEvent.change(within(dialog).getByLabelText(/Description/i), {
      target: { value: "Export CSV invoices" },
    });
    fireEvent.change(within(dialog).getByLabelText("Initial admission stage"), {
      target: { value: "ready-for-agent" },
    });
    expect(submitBtn.disabled).toBe(false);

    // Negative: API failure keeps modal open and renders alert
    mock.publishTicket.mockRejectedValueOnce(new Error("forge_unreachable"));
    fireEvent.click(submitBtn);
    const errAlert = await within(dialog).findByRole("alert");
    expect(errAlert.textContent).toContain("forge_unreachable");
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Retry succeeds, closes dialog and refreshes board
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(mock.forProject).toHaveBeenCalledWith("prj_beta");
      expect(mock.publishTicket).toHaveBeenLastCalledWith({
        title: "Add billing export",
        body: "Export CSV invoices",
        labels: ["ready-for-agent"],
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onRefresh).toHaveBeenCalled();
  });
});
