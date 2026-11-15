// @vitest-environment jsdom
import React from "react";
import { describe, expect, test, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { IssueInspector } from "../../apps/web/src/features/jobs/issue-inspector";
import { CreateJobDialog } from "../../apps/web/src/features/jobs/create-job-dialog";
import type { OperatorWorkDetail } from "@animus/contracts/operator";

afterEach(() => {
  cleanup();
});

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as any).ResizeObserver = ResizeObserverStub;
});

function makeWorkDetail(overrides: Partial<OperatorWorkDetail> = {}): OperatorWorkDetail {
  return {
    projectId: "proj-1",
    generatedAt: Date.now(),
    work: {
      id: "work-1",
      project_id: "proj-1",
      repo_id: 1,
      repo_name: "animus/platform",
      issue_number: 10001,
      created_at: Date.now() - 3600000,
      updated_at: Date.now() - 1800000,
      revision: {
        id: "rev-1",
        work_id: "work-1",
        project_id: "proj-1",
        revision_number: 1,
        content_hash: "a".repeat(64),
        source: {
          title: "Direct Task #10001",
          body: "Direct job description",
          state: "OPEN",
          labels: ["ready-for-agent"],
          comments: [],
        },
        provenance: {
          repo_id: 1,
          repo_name: "animus/platform",
          issue_number: 10001,
          source_url: "local://proj-1/issues/10001",
          captured_at: Date.now() - 3600000,
        },
        imported_at: Date.now() - 3600000,
      },
    },
    kind: "standalone",
    lane: "triage",
    stageLabel: "Triage",
    detail: "Needs operator triage review",
    precedence: ["canonical"],
    role: null,
    planId: null,
    planKind: null,
    parent: null,
    specProgress: null,
    draft: null,
    contract: {
      title: "Direct Task #10001",
      body: "Direct job description",
      labels: ["ready-for-agent"],
      state: "OPEN",
      revisionNumber: 1,
      contentHash: "a".repeat(64),
      sourceUrl: "local://proj-1/issues/10001",
    },
    plan: null,
    latestRun: null,
    evidence: null,
    runs: [],
    history: [],
    timeline: [],
    usage: {
      available: true,
      tokensIn: 1000,
      tokensOut: 500,
      cacheReadTokens: 200,
      costMicros: 10000,
      activeWorkers: 1,
      maxParallelWorkers: 3,
      provider: "claude",
      model: "claude-3-7-sonnet",
    },
    ...overrides,
  } as unknown as OperatorWorkDetail;
}

describe("IssueInspector: Consolidated Triage -> Ready UX", () => {
  test("shows 'Start Triage' button when draft is null in triage lane", async () => {
    const detail = makeWorkDetail({ draft: null, lane: "triage" });
    const refineDraftMock = vi.fn().mockResolvedValue({ id: "draft-1" });
    const mockFactory = {
      forProject: () => ({
        refineDraft: refineDraftMock,
      }),
    } as any;

    render(<IssueInspector detail={detail} projectId="proj-1" factory={mockFactory} />);

    const startTriageBtn = screen.getByRole("button", { name: /start triage/i });
    expect(startTriageBtn).toBeTruthy();

    fireEvent.click(startTriageBtn);

    await waitFor(() => {
      expect(refineDraftMock).toHaveBeenCalledWith({
        work_id: "work-1",
        answers: [],
      });
    });
  });

  test("renders multi-question clarification inputs and submits answers for each question", async () => {
    const detail = makeWorkDetail({
      draft: {
        id: "draft-1",
        project_id: "proj-1",
        work_id: "work-1",
        source_revision_id: "rev-1",
        status: "needs_clarification",
        latest_revision: {
          id: "draft-rev-1",
          draft_id: "draft-1",
          revision_number: 1,
          kind: "clarification",
          questions: [
            {
              id: "q1",
              question: "Which authentication provider should we use?",
              reason: "Architectural choice",
            },
            {
              id: "q2",
              question: "Should session expire after 24h or 7d?",
              reason: "Security policy",
            },
          ],
          answers: [],
          plan: { kind: "clarification", reason: "Needs inputs", questions: [] },
        },
      } as any,
      lane: "triage",
    });

    const refineDraftMock = vi.fn().mockResolvedValue({ id: "draft-1" });
    const mockFactory = {
      forProject: () => ({
        refineDraft: refineDraftMock,
      }),
    } as any;

    render(<IssueInspector detail={detail} projectId="proj-1" factory={mockFactory} />);

    expect(
      screen.getAllByText(/Which authentication provider should we use\?/i).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Should session expire after 24h or 7d\?/i)).toBeTruthy();

    const textareas = screen.getAllByPlaceholderText(
      /Provide context or answer for this question…/i,
    );
    expect(textareas).toHaveLength(2);

    fireEvent.change(textareas[0]!, { target: { value: "OAuth with GitHub" } });
    fireEvent.change(textareas[1]!, { target: { value: "24 hours" } });

    const provideContextBtn = screen.getByRole("button", { name: /provide context/i });
    fireEvent.click(provideContextBtn);

    await waitFor(() => {
      expect(refineDraftMock).toHaveBeenCalledWith({
        work_id: "work-1",
        answers: [
          {
            question_id: "q1",
            question: "Which authentication provider should we use?",
            answer: "OAuth with GitHub",
          },
          {
            question_id: "q2",
            question: "Should session expire after 24h or 7d?",
            answer: "24 hours",
          },
        ],
      });
    });
  });

  test("supports requesting changes with revision instructions", async () => {
    const detail = makeWorkDetail({
      draft: {
        id: "draft-1",
        project_id: "proj-1",
        work_id: "work-1",
        status: "needs_review",
        latest_revision: {
          id: "draft-rev-1",
          draft_id: "draft-1",
          revision_number: 1,
          kind: "standalone",
          questions: [],
          answers: [],
          plan: {
            kind: "standalone",
            title: "Task #10001",
            body: "Task plan body",
            acceptance_criteria: [],
          },
        },
      } as any,
      lane: "triage",
    });

    const decideDraftMock = vi.fn().mockResolvedValue({ id: "draft-1" });
    const mockFactory = {
      forProject: () => ({
        decideDraft: decideDraftMock,
      }),
    } as any;

    render(<IssueInspector detail={detail} projectId="proj-1" factory={mockFactory} />);

    const requestChangesBtn = screen.getByRole("button", { name: /request changes/i });
    fireEvent.click(requestChangesBtn);

    const instructionsTextarea = screen.getByPlaceholderText(
      /Describe what needs to be changed in this draft plan…/i,
    );
    expect(instructionsTextarea).toBeTruthy();

    fireEvent.change(instructionsTextarea, {
      target: { value: "Please split into two acceptance criteria: UI and API." },
    });

    const submitChangesBtn = screen.getByRole("button", { name: /submit changes/i });
    fireEvent.click(submitChangesBtn);

    await waitFor(() => {
      expect(decideDraftMock).toHaveBeenCalledWith("draft-1", {
        decision: "revise",
        actor: "operator",
        reason: "Operator requested revision",
        revision_id: "draft-rev-1",
        instructions: "Please split into two acceptance criteria: UI and API.",
      });
    });
  });

  test("1-click 'Approve & Move to Ready' approves draft and calls admitDraft", async () => {
    const detail = makeWorkDetail({
      draft: {
        id: "draft-1",
        project_id: "proj-1",
        work_id: "work-1",
        status: "needs_review",
        latest_revision: {
          id: "draft-rev-1",
          draft_id: "draft-1",
          revision_number: 1,
          kind: "standalone",
          questions: [],
          answers: [],
          plan: {
            kind: "standalone",
            title: "Task #10001",
            body: "Task plan body",
            acceptance_criteria: [],
          },
        },
      } as any,
      lane: "triage",
    });

    const decideDraftMock = vi.fn().mockResolvedValue({ id: "draft-1" });
    const admitDraftMock = vi.fn().mockResolvedValue({ id: "plan-1", authority: "admitted" });
    const mockFactory = {
      forProject: () => ({
        decideDraft: decideDraftMock,
        admitDraft: admitDraftMock,
      }),
    } as any;

    render(<IssueInspector detail={detail} projectId="proj-1" factory={mockFactory} />);

    const approveAndMoveBtn = screen.getByRole("button", { name: /approve & move to ready/i });
    fireEvent.click(approveAndMoveBtn);

    await waitFor(() => {
      expect(decideDraftMock).toHaveBeenCalledWith("draft-1", {
        decision: "approve",
        actor: "operator",
        reason: "Operator approved draft",
        revision_id: "draft-rev-1",
      });
      expect(admitDraftMock).toHaveBeenCalledWith("draft-1");
    });
  });
});

describe("CreateJobDialog: Direct Animus Job Creation", () => {
  test("creates a new job directly without forge issue creation and invokes callback", async () => {
    const createJobMock = vi.fn().mockResolvedValue({
      work: { id: "work-new-1", issue_number: 10002 },
      issue_number: 10002,
    });
    const mockFactory = {
      forProject: () => ({
        createJob: createJobMock,
      }),
    } as any;

    const onJobCreated = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CreateJobDialog
        open={true}
        onOpenChange={onOpenChange}
        projectId="proj-1"
        onJobCreated={onJobCreated}
        factory={mockFactory}
      />,
    );

    expect(screen.getByText("New Job")).toBeTruthy();

    const titleInput = screen.getByLabelText(/title/i);
    const promptInput = screen.getByLabelText(/task prompt/i);

    fireEvent.change(titleInput, { target: { value: "Add JWT middleware" } });
    fireEvent.change(promptInput, {
      target: { value: "Please implement JWT verification for all API routes." },
    });

    const submitBtn = screen.getByRole("button", { name: /create job/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createJobMock).toHaveBeenCalledWith({
        title: "Add JWT middleware",
        prompt: "Please implement JWT verification for all API routes.",
      });
      expect(onJobCreated).toHaveBeenCalledWith("work-new-1");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
