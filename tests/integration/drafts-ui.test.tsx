// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DraftBoundary, DraftPlan, DraftRecord, Project } from "@animus/contracts/operator";
import {
  buildAnswerSubmission,
  draftActionsOf,
  planContentOf,
  summarizeDraft,
} from "../../apps/web/src/features/drafts/drafts-model";

const draftRecordMock = vi.hoisted(() => {
  return {
    projects: [] as Project[],
    drafts: [] as DraftRecord[],
    draft: null as DraftRecord | null,
    draftError: null as Error | null,
    reviseDraft: null as null | ((id: string, submission: unknown) => Promise<DraftRecord>),
    decideDraft: null as
      | null
      | ((id: string, submission: { decision: string; reason: string }) => Promise<DraftRecord>),
  };
});

vi.mock("../../apps/web/src/lib/factory-client", () => {
  const forProject = () => ({
    async drafts() {
      return draftRecordMock.drafts;
    },
    async draft() {
      if (draftRecordMock.draftError) throw draftRecordMock.draftError;
      return draftRecordMock.draft;
    },
    async reviseDraft(id: string, submission: unknown) {
      if (!draftRecordMock.reviseDraft) throw new Error("unexpected revise");
      return draftRecordMock.reviseDraft(id, submission);
    },
    async decideDraft(id: string, submission: { decision: string; reason: string }) {
      if (!draftRecordMock.decideDraft) throw new Error("unexpected decision");
      return draftRecordMock.decideDraft(id, submission);
    },
  });
  return {
    client: {
      async projects() {
        return draftRecordMock.projects;
      },
      forProject,
    },
  };
});

import { DraftsScreen } from "../../apps/web/src/features/drafts/drafts-screen";

afterEach(() => {
  cleanup();
  draftRecordMock.projects = [];
  draftRecordMock.drafts = [];
  draftRecordMock.draft = null;
  draftRecordMock.draftError = null;
  draftRecordMock.reviseDraft = null;
  draftRecordMock.decideDraft = null;
});

const project: Project = {
  id: "proj-1",
  name: "Product",
  repo_id: 501,
  repo_name: "owner/repo",
  checkout_path: "/tmp/checkout",
  status: "active",
  status_reason: null,
  created_at: "2026-11-08T00:00:00Z",
  updated_at: "2026-11-08T00:00:00Z",
};

const testBoundary: DraftBoundary = {
  touchpoints: "apps/web/src/features",
  known_callers: "none",
  test_seam: "tests/integration/web.test.tsx",
  exclusions: "unrelated work",
};

const standalonePlan: DraftPlan = {
  kind: "standalone",
  title: "Add the small button",
  scope: "Add one button to the toolbar.",
  outcome: "The button works and is tested.",
  invariants: ["Existing behavior remains intact."],
  acceptance_criteria: [
    { id: "AC1", description: "Button is visible.", verification: "Component test" },
  ],
  verification_requirements: ["bun run test"],
  boundary: testBoundary,
  depends_on: [],
  body: "",
  prepared: false,
};

function clarificationRecord(): DraftRecord {
  return {
    id: "draft_1",
    project_id: "proj-1",
    work_id: "work_1",
    status: "needs_clarification",
    created_at: 1,
    updated_at: 1,
    source: {
      title: "Improve onboarding",
      body: "Please improve onboarding.",
      state: "OPEN",
      labels: ["needs-triage"],
      comments: [],
    },
    source_provenance: {
      repo_id: 501,
      repo_name: "owner/repo",
      issue_number: 21,
      source_url: "https://github.com/owner/repo/issues/21",
      captured_at: 1,
    },
    source_work_revision_id: "wrev_1",
    source_content_hash: "a".repeat(64),
    latest_revision: {
      id: "drev_1",
      draft_id: "draft_1",
      project_id: "proj-1",
      work_id: "work_1",
      revision_number: 1,
      source_work_revision_id: "wrev_1",
      source_content_hash: "a".repeat(64),
      kind: "clarification",
      plan: {
        kind: "clarification",
        reason: "The onboarding outcome is a product decision.",
        questions: [
          {
            id: "q1",
            question: "Which onboarding outcome matters most?",
            reason: "The repository cannot infer product priority.",
          },
        ],
      },
      plan_hash: "b".repeat(64),
      questions: [
        {
          id: "q1",
          question: "Which onboarding outcome matters most?",
          reason: "The repository cannot infer product priority.",
        },
      ],
      answers: [],
      instructions: null,
      planner_metadata: {
        transport: "agent",
        prompt: "draft",
        provider: "claude",
        model: "test",
        effort: null,
        accepted_ref: null,
      },
      created_at: 1,
    },
    latest_decision: null,
    authorization: { approved: false, approved_revision_id: null, can_publish: false },
  };
}

function reviewRecord(): DraftRecord {
  return {
    ...clarificationRecord(),
    id: "draft_2",
    status: "needs_review",
    latest_revision: {
      ...clarificationRecord().latest_revision,
      id: "drev_2",
      revision_number: 2,
      kind: "standalone",
      plan: standalonePlan,
      questions: [],
    },
  };
}

describe("draft view model", () => {
  test("clarification plans expose only questions, never fabricated scope", () => {
    const content = planContentOf(clarificationRecord());
    expect(content.kind).toBe("clarification");
    expect(content.title).toBeNull();
    expect(content.scope).toBeNull();
    expect(content.acceptanceCriteria).toEqual([]);
    expect(content.children).toEqual([]);
  });

  test("spec plans map child dependency indices to sibling ids and cover parent criteria", () => {
    const record = reviewRecord();
    record.latest_revision.plan = {
      kind: "spec",
      title: "Ship it",
      scope: "Feature.",
      outcome: "Delivered.",
      invariants: ["Invariant."],
      acceptance_criteria: [
        { id: "AC1", description: "First.", verification: "Test" },
        { id: "AC2", description: "Second.", verification: "Test" },
      ],
      verification_requirements: ["bun run test"],
      boundary: testBoundary,
      depends_on: [],
      body: "",
      children: [
        {
          id: "C1",
          title: "First slice",
          scope: "s",
          outcome: "o",
          invariants: ["i"],
          acceptance_criteria: [{ id: "AC1", description: "d", verification: "v" }],
          verification_requirements: ["v"],
          boundary: testBoundary,
          depends_on: [],
          body: "",
          depends_on_indices: [],
          covers_parent_ac_ids: ["AC1"],
        },
        {
          id: "C2",
          title: "Second slice",
          scope: "s",
          outcome: "o",
          invariants: ["i"],
          acceptance_criteria: [{ id: "AC1", description: "d", verification: "v" }],
          verification_requirements: ["v"],
          boundary: testBoundary,
          depends_on: [],
          body: "",
          depends_on_indices: [0],
          covers_parent_ac_ids: ["AC2"],
        },
      ],
    };
    const content = planContentOf(record);
    expect(content.children[0]!.dependsOn).toEqual([]);
    expect(content.children[1]!.dependsOn).toEqual(["C1"]);
    expect(content.children[1]!.covers).toEqual(["AC2"]);
  });

  test("a clarification draft cannot be approved and only offers answering", () => {
    const actions = draftActionsOf(clarificationRecord());
    expect(actions.canApprove).toBe(false);
    expect(actions.canReject).toBe(false);
    expect(actions.canAnswer).toBe(true);
  });

  test("answers must cover every question before a submission is built", () => {
    const record = clarificationRecord();
    expect(buildAnswerSubmission(record, { q1: "   " })).toBeNull();
    expect(buildAnswerSubmission(record, { q1: "Clarity first" })).toEqual([
      { question_id: "q1", answer: "Clarity first" },
    ]);
  });

  test("summaries surface the real backend status and revision identity", () => {
    const summary = summarizeDraft(reviewRecord());
    expect(summary.statusLabel).toBe("Needs review");
    expect(summary.revisionNumber).toBe(2);
    expect(summary.issueNumber).toBe(21);
  });
});

describe("drafts screen", () => {
  test("renders an honest loading state before data arrives", () => {
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [];
    render(<DraftsScreen />);
    // The queue shows a loading state synchronously, before any data resolves.
    expect(screen.getByText("Loading drafts…")).toBeTruthy();
  });

  test("renders an honest error state when the API is unreachable", async () => {
    const clientModule = await import("../../apps/web/src/lib/factory-client");
    vi.spyOn(clientModule.client, "projects").mockRejectedValueOnce(new Error("transport down"));
    render(<DraftsScreen />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("transport down")).toBeTruthy();
  });

  test("renders an empty queue pointing at the real CLI when there are no drafts", async () => {
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [];
    render(<DraftsScreen />);
    await waitFor(() => expect(screen.getByText("No drafts yet")).toBeTruthy());
    expect(screen.getByText(/animus draft refine/)).toBeTruthy();
  });

  test("shows real questions and submits answers through the backend client", async () => {
    const record = clarificationRecord();
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [record];
    draftRecordMock.draft = record;
    const revised = {
      ...record,
      status: "needs_review" as const,
      latest_revision: { ...record.latest_revision, revision_number: 2, plan: standalonePlan },
    };
    draftRecordMock.reviseDraft = vi.fn(async () => revised);
    render(<DraftsScreen />);

    await waitFor(() => expect(screen.getByText("Awaiting answers")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Improve onboarding/ }));
    await waitFor(() =>
      expect(screen.getByText("Which onboarding outcome matters most?")).toBeTruthy(),
    );

    const answer = screen.getByLabelText("Which onboarding outcome matters most?");
    fireEvent.change(answer, { target: { value: "Clarity first" } });
    fireEvent.click(screen.getByRole("button", { name: /Save answers/ }));

    await waitFor(() => expect(draftRecordMock.reviseDraft).toHaveBeenCalled());
    expect(draftRecordMock.reviseDraft).toHaveBeenCalledWith("draft_1", {
      answers: [{ question_id: "q1", answer: "Clarity first" }],
    });
  });

  test("approve stays disabled until a reason is provided and binds to the current revision", async () => {
    const record = reviewRecord();
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [record];
    draftRecordMock.draft = record;
    draftRecordMock.decideDraft = vi.fn(async () => ({
      ...record,
      status: "approved" as const,
      authorization: {
        approved: true,
        approved_revision_id: record.latest_revision.id,
        can_publish: true,
      },
    }));
    render(<DraftsScreen />);

    await waitFor(() => expect(screen.getByText("Needs review")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Improve onboarding/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Approve for publication/ })).toBeTruthy(),
    );

    const approve = screen.getByRole("button", { name: /Approve for publication/ });
    expect((approve as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Scope is correct" },
    });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);

    await waitFor(() => expect(draftRecordMock.decideDraft).toHaveBeenCalled());
    expect(draftRecordMock.decideDraft).toHaveBeenCalledWith(
      "draft_2",
      expect.objectContaining({ decision: "approve", reason: "Scope is correct" }),
    );
  });
});
