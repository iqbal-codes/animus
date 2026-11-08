// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  DraftBoundary,
  DraftRecord,
  DraftSpecPlan,
  DraftStandalonePlan,
  Project,
} from "@animus/contracts/operator";
import {
  buildAnswerSubmission,
  draftActionsOf,
  pendingChangeInstructions,
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

const standalonePlan: DraftStandalonePlan = {
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

function specPlan(): DraftSpecPlan {
  return {
    kind: "spec",
    title: "Ship the operator revision flow",
    scope: "Implement revision generation for specs.",
    outcome: "Operators can request and generate a revised spec.",
    invariants: ["Approval stays revision-bound."],
    acceptance_criteria: [
      { id: "AC1", description: "Spec request changes works.", verification: "Integration test" },
      { id: "AC2", description: "Children stay covered.", verification: "Integration test" },
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
}

function issueRecord(id: string, issueNumber: number, title: string): DraftRecord {
  const base = reviewRecord();
  return {
    ...base,
    id,
    work_id: `work_${issueNumber}`,
    source: { ...base.source, title },
    source_provenance: { ...base.source_provenance, issue_number: issueNumber },
    latest_revision: {
      ...base.latest_revision,
      id: `${id}_rev`,
      draft_id: id,
      work_id: `work_${issueNumber}`,
      plan: { ...standalonePlan, title },
    },
  };
}

function changesRequested(record: DraftRecord, instructions: string): DraftRecord {
  return {
    ...record,
    status: "changes_requested",
    latest_decision: {
      id: "ddecision_1",
      draft_id: record.id,
      project_id: record.project_id,
      revision_id: record.latest_revision.id,
      revision_number: record.latest_revision.revision_number,
      decision: "revise",
      reason: "Tighten the scope",
      instructions,
      actor: null,
      decided_at: 2,
    },
  };
}

function nextRevision(record: DraftRecord, revisionNumber: number): DraftRecord {
  return {
    ...record,
    status: "needs_review",
    latest_revision: {
      ...record.latest_revision,
      id: `drev_${revisionNumber}`,
      revision_number: revisionNumber,
      plan:
        record.latest_revision.plan.kind === "spec"
          ? { ...specPlan(), title: "Revised operator revision flow" }
          : { ...standalonePlan, title: "Add the revised small button" },
    },
    authorization: { approved: false, approved_revision_id: null, can_publish: false },
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

  test("pending change instructions stay bound to the current revision", () => {
    const record = changesRequested(reviewRecord(), "Keep the API stable.");
    expect(pendingChangeInstructions(record)).toBe("Keep the API stable.");
    const actions = draftActionsOf(record);
    expect(actions.canRegenerate).toBe(true);
    expect(actions.canRequestChanges).toBe(false);

    const superseded = {
      ...record,
      latest_revision: { ...record.latest_revision, id: "drev_3", revision_number: 3 },
    };
    // The decision still targets revision 2, so it must not replay as pending text.
    expect(pendingChangeInstructions(superseded)).toBe("");
    expect(draftActionsOf(superseded).canRegenerate).toBe(false);
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

  test("a distinct revision identity remounts the detail and renders the new revision", async () => {
    const record = clarificationRecord();
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [record];
    draftRecordMock.draft = record;
    // A real refinement produces a new revision row, so the identity must change.
    // Reusing the old id would leave the keyed detail mounted and never exercise
    // the remount that keeps typed input from being wiped by a stale effect.
    const revised: DraftRecord = {
      ...record,
      status: "needs_review",
      latest_revision: {
        ...record.latest_revision,
        id: "drev_2",
        revision_number: 2,
        kind: "standalone",
        plan: standalonePlan,
        questions: [],
      },
    };
    draftRecordMock.reviseDraft = vi.fn(async () => {
      draftRecordMock.drafts = [revised];
      draftRecordMock.draft = revised;
      return revised;
    });
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

    // The new revision replaces the clarification detail rather than reusing it.
    await waitFor(() => expect(screen.getByText("Saved revision 2.")).toBeTruthy());
    expect(screen.getByText(/revision 2 · standalone/)).toBeTruthy();
    expect(screen.getByText("Add the small button")).toBeTruthy();
    expect(screen.queryByLabelText("Which onboarding outcome matters most?")).toBeNull();
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

  test("standalone request changes records the revise decision then generates a new revision", async () => {
    const record = reviewRecord();
    const changed = changesRequested(record, "Keep the API stable.");
    const revised = nextRevision(changed, 3);
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [record];
    draftRecordMock.draft = record;
    draftRecordMock.decideDraft = vi.fn(async () => {
      draftRecordMock.drafts = [changed];
      draftRecordMock.draft = changed;
      return changed;
    });
    draftRecordMock.reviseDraft = vi.fn(async () => {
      draftRecordMock.drafts = [revised];
      draftRecordMock.draft = revised;
      return revised;
    });
    render(<DraftsScreen />);

    await waitFor(() => expect(screen.getByText("Needs review")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Improve onboarding/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Request changes/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Tighten the scope" },
    });
    fireEvent.change(screen.getByLabelText("Change instructions"), {
      target: { value: "Keep the API stable." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));

    await waitFor(() =>
      expect(screen.getByText("Generated revision 3 from the change request.")).toBeTruthy(),
    );
    expect(draftRecordMock.decideDraft).toHaveBeenCalledWith("draft_2", {
      revision_id: "drev_2",
      decision: "revise",
      reason: "Tighten the scope",
      instructions: "Keep the API stable.",
    });
    expect(draftRecordMock.reviseDraft).toHaveBeenCalledWith("draft_2", {
      answers: [],
      instructions: "Keep the API stable.",
    });
    expect(screen.getByText("Add the revised small button")).toBeTruthy();
    expect(screen.getByText(/revision 3 · standalone/)).toBeTruthy();
    // A new revision invalidates the prior authorization.
    expect(revised.authorization).toEqual({
      approved: false,
      approved_revision_id: null,
      can_publish: false,
    });
  });

  test("spec request changes generates a new spec revision with preserved children", async () => {
    const record = reviewRecord();
    record.latest_revision = {
      ...record.latest_revision,
      kind: "spec",
      plan: specPlan(),
    };
    const changed = changesRequested(record, "Cover the second child.");
    const revised = nextRevision(changed, 3);
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [record];
    draftRecordMock.draft = record;
    draftRecordMock.decideDraft = vi.fn(async () => {
      draftRecordMock.drafts = [changed];
      draftRecordMock.draft = changed;
      return changed;
    });
    draftRecordMock.reviseDraft = vi.fn(async () => {
      draftRecordMock.drafts = [revised];
      draftRecordMock.draft = revised;
      return revised;
    });
    render(<DraftsScreen />);

    await waitFor(() => expect(screen.getByText("Needs review")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Improve onboarding/ }));
    await waitFor(() => expect(screen.getByText("Child tickets (2)")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Tighten the spec" },
    });
    fireEvent.change(screen.getByLabelText("Change instructions"), {
      target: { value: "Cover the second child." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));

    await waitFor(() =>
      expect(screen.getByText("Generated revision 3 from the change request.")).toBeTruthy(),
    );
    expect(draftRecordMock.reviseDraft).toHaveBeenCalledWith("draft_2", {
      answers: [],
      instructions: "Cover the second child.",
    });
    expect(screen.getByText("Revised operator revision flow")).toBeTruthy();
    expect(screen.getByText(/revision 3 · spec/)).toBeTruthy();
    expect(screen.getByText("Child tickets (2)")).toBeTruthy();
  });

  test("a generation failure is reported honestly and the preserved instructions can be retried", async () => {
    const record = reviewRecord();
    const changed = changesRequested(record, "Keep the API stable.");
    const revised = nextRevision(changed, 3);
    let attempts = 0;
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [record];
    draftRecordMock.draft = record;
    draftRecordMock.decideDraft = vi.fn(async () => {
      draftRecordMock.drafts = [changed];
      draftRecordMock.draft = changed;
      return changed;
    });
    draftRecordMock.reviseDraft = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("planner transport unavailable");
      draftRecordMock.drafts = [revised];
      draftRecordMock.draft = revised;
      return revised;
    });
    render(<DraftsScreen />);

    await waitFor(() => expect(screen.getByText("Needs review")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Improve onboarding/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Request changes/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Tighten the scope" },
    });
    fireEvent.change(screen.getByLabelText("Change instructions"), {
      target: { value: "Keep the API stable." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));

    await waitFor(() =>
      expect(
        screen.getByText(/could not be generated: planner transport unavailable/),
      ).toBeTruthy(),
    );
    // No fake success: the revision was never generated.
    expect(screen.queryByText(/Generated revision/)).toBeNull();
    expect((screen.getByLabelText("Change instructions") as HTMLTextAreaElement).value).toBe(
      "Keep the API stable.",
    );

    fireEvent.click(screen.getByRole("button", { name: /Generate revised scope/ }));
    await waitFor(() =>
      expect(screen.getByText("Generated revision 3 from the change request.")).toBeTruthy(),
    );
    expect(draftRecordMock.reviseDraft).toHaveBeenNthCalledWith(1, "draft_2", {
      answers: [],
      instructions: "Keep the API stable.",
    });
    expect(draftRecordMock.reviseDraft).toHaveBeenNthCalledWith(2, "draft_2", {
      answers: [],
      instructions: "Keep the API stable.",
    });
  });

  test("a stale revise decision fails closed without attempting generation", async () => {
    const record = reviewRecord();
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [record];
    draftRecordMock.draft = record;
    draftRecordMock.decideDraft = vi.fn(async () => {
      throw new Error("The decision targets a superseded draft revision");
    });
    draftRecordMock.reviseDraft = vi.fn(async () => record);
    render(<DraftsScreen />);

    await waitFor(() => expect(screen.getByText("Needs review")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Improve onboarding/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Request changes/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Tighten the scope" },
    });
    fireEvent.change(screen.getByLabelText("Change instructions"), {
      target: { value: "Keep the API stable." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));

    await waitFor(() => expect(screen.getByText(/superseded draft revision/)).toBeTruthy());
    expect(draftRecordMock.reviseDraft).not.toHaveBeenCalled();
  });

  test("the draft queue supports arrows, Home, End and aria-activedescendant", async () => {
    const alpha = issueRecord("draft_a", 31, "Alpha draft");
    const beta = issueRecord("draft_b", 32, "Beta draft");
    const gamma = issueRecord("draft_c", 33, "Gamma draft");
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [alpha, beta, gamma];
    draftRecordMock.draft = alpha;
    render(<DraftsScreen />);

    await waitFor(() => expect(screen.getByText("Alpha draft")).toBeTruthy());
    const listbox = screen.getByRole("listbox", { name: "Drafts" });
    expect(listbox.getAttribute("aria-activedescendant")).toBeNull();

    // End from a fresh list selects the last draft, not the first.
    fireEvent.keyDown(listbox, { key: "End" });
    await waitFor(() =>
      expect(listbox.getAttribute("aria-activedescendant")).toBe("draft-option-draft_c"),
    );

    fireEvent.keyDown(listbox, { key: "Home" });
    await waitFor(() =>
      expect(listbox.getAttribute("aria-activedescendant")).toBe("draft-option-draft_a"),
    );

    // Clear the selection so ArrowDown exercises the no-selection path.
    fireEvent.keyDown(listbox, { key: "Escape" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    await waitFor(() =>
      expect(listbox.getAttribute("aria-activedescendant")).toBe("draft-option-draft_a"),
    );
    expect(screen.getByRole("option", { name: /Alpha draft/ }).getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    await waitFor(() =>
      expect(listbox.getAttribute("aria-activedescendant")).toBe("draft-option-draft_b"),
    );

    fireEvent.keyDown(listbox, { key: "End" });
    await waitFor(() =>
      expect(listbox.getAttribute("aria-activedescendant")).toBe("draft-option-draft_c"),
    );

    fireEvent.keyDown(listbox, { key: "Home" });
    await waitFor(() =>
      expect(listbox.getAttribute("aria-activedescendant")).toBe("draft-option-draft_a"),
    );

    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    await waitFor(() =>
      expect(listbox.getAttribute("aria-activedescendant")).toBe("draft-option-draft_a"),
    );
  });

  test("draft mobile controls expose at least a 44px touch target", async () => {
    const record = reviewRecord();
    draftRecordMock.projects = [project];
    draftRecordMock.drafts = [record];
    draftRecordMock.draft = record;
    render(<DraftsScreen />);

    await waitFor(() => expect(screen.getByText("Needs review")).toBeTruthy());
    expect(screen.getByLabelText("Project").className).toContain("h-11");
    expect(screen.getByLabelText("Project").className).toContain("sm:h-9");
    expect(screen.getByRole("button", { name: /Refresh drafts/ }).className).toContain("min-h-11");

    fireEvent.click(screen.getByRole("option", { name: /Improve onboarding/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Request changes/ })).toBeTruthy(),
    );
    for (const name of [/Approve for publication/, /Request changes/, /Reject/]) {
      expect(screen.getByRole("button", { name }).className).toContain("min-h-11");
    }
  });
});
