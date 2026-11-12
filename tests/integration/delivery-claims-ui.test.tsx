// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DispatchControl } from "../../apps/web/src/features/dispatch/dispatch-control";

const backing = vi.hoisted(() => ({
  projects: vi.fn(),
  plans: vi.fn(),
  dispatchRuns: vi.fn(),
  dispatchRunDetail: vi.fn(),
  reconcileDeliveryClaim: vi.fn(),
}));

vi.mock("../../apps/web/src/lib/factory-client", () => ({
  client: {
    projects: (...args: unknown[]) => backing.projects(...args),
    forProject: () => ({
      plans: (...args: unknown[]) => backing.plans(...args),
      dispatchRuns: (...args: unknown[]) => backing.dispatchRuns(...args),
      dispatchRunDetail: (...args: unknown[]) => backing.dispatchRunDetail(...args),
      reconcileDeliveryClaim: (...args: unknown[]) => backing.reconcileDeliveryClaim(...args),
    }),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PROJECT = {
  id: "proj-1",
  name: "Alpha",
  repo_id: 1,
  repo_name: "org/alpha",
  checkout_path: "/checkouts/alpha",
  status: "active" as const,
  status_reason: null,
  created_at: "2026-10-31T00:00:00Z",
  updated_at: "2026-10-31T01:00:00Z",
};

const PLAN = {
  id: "plan-1",
  project_id: "proj-1",
  kind: "standalone" as const,
  root_work_id: "work-1",
  root_issue_number: 714,
  root_title: "Standalone delivery",
  graph_hash: "a".repeat(64),
  authority: "admitted" as const,
  member_count: 1,
  ticket_count: 1,
  hold_count: 0,
  accepted_revision_id: "rev-1",
  created_at: 1,
  updated_at: 1,
};

const RUN = {
  id: "run-1",
  project_id: "proj-1",
  delivery_id: "del-1",
  plan_id: "plan-1",
  work_id: "work-1",
  revision_id: "rev-1",
  content_hash: "a".repeat(64),
  issue_number: 152,
  role: "ticket" as const,
  gate_profile: "child" as const,
  merge_policy: "auto_after_gates" as const,
  target_branch: "factory/spec-151-integration",
  ownership_generation: 1,
  state: "succeeded" as const,
  actor: "monitor",
  command_request_id: "cmd-1",
  branch: "ticket-152",
  worktree_path: "/tmp/wt",
  base_sha: "b".repeat(40),
  head_sha: "c".repeat(40),
  error: null,
  launched_at: 1,
  finished_at: 2,
  created_at: 1,
  updated_at: 2,
};

function claim(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "claim-1",
    projectId: "proj-1",
    deliveryId: "del-1",
    runId: "run-1",
    lap: 1,
    stage: "blackbox_verification" as const,
    candidateHeadSha: "c".repeat(40),
    attemptKey: "blackbox_verification:claim:abc",
    claimGeneration: 2,
    ownerPid: 4321,
    ownerProcessStart: null,
    rolePid: null,
    rolePgid: null,
    roleProcessStart: null,
    leaseExpiresAt: 10,
    heartbeatAt: 5,
    state: "interrupted" as const,
    resultObservationId: null,
    error: "frozen",
    hold: {
      disposition: "frozen_unknown_owner" as const,
      reason: "operator_frozen_unknown_owner",
      ownerProbe: "unknown" as const,
      resolvedAt: null,
    },
    createdAt: 1,
    updatedAt: 5,
    ...overrides,
  };
}

function detail(claims: unknown[]) {
  return {
    run: RUN,
    budget: null,
    control: null,
    grants: [],
    attempts: [],
    process: {
      ownerPid: null,
      ownerAlive: false,
      workerPid: null,
      workerPgid: null,
      workerAlive: false,
      worktreeLockPid: null,
      worktreeLockAlive: false,
      roleClaims: [],
    },
    claims,
    acceptanceCriteria: [],
    openFindings: [],
    acceptance: {
      runId: "run-1",
      projectId: "proj-1",
      deliveryId: "del-1",
      gateProfile: "child" as const,
      candidateHeadSha: "c".repeat(40),
      targetTipSha: "d".repeat(40),
      mergeBaseSha: "b".repeat(40),
      integrationLineage: "e".repeat(64) + "@main",
      authorized: true,
      reasons: [],
      builderObservationId: null,
      independentObservationId: null,
      openBlockingFindingIds: [],
      verifiedArtifactIds: [],
    },
  };
}

function setup(details: unknown[]) {
  backing.projects.mockResolvedValue([PROJECT]);
  backing.plans.mockResolvedValue([PLAN]);
  backing.dispatchRuns.mockResolvedValue([RUN]);
  backing.dispatchRunDetail.mockResolvedValue(details[0]);
}

describe("Delivery role claims panel", () => {
  test("shows active/unknown/interrupted claims even when the builder run succeeded", async () => {
    setup([detail([claim()])]);
    render(<DispatchControl />);
    const toggle = await screen.findByRole("button", { name: /budget & controls/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(backing.dispatchRunDetail).toHaveBeenCalled());
    const panel = await screen.findByLabelText("Delivery role claims");
    expect(panel.textContent).toContain("Held — owner identity unknown");
    expect(panel.textContent).toContain("blackbox_verification");
    // An unknown owner surfaces the truthful warning, not a fake enable.
    expect(panel.textContent).toMatch(/cannot be proven dead/i);
    expect(screen.getByTestId("claim-claim-1")).toBeTruthy();
  });

  test("interrupt sends fresh CAS values and the unknown-owner acknowledgement", async () => {
    setup([detail([claim({ resultObservationId: "obs-1" })])]);
    backing.reconcileDeliveryClaim.mockResolvedValue(
      claim({
        state: "interrupted",
        hold: {
          disposition: "frozen_unknown_owner",
          reason: "held",
          ownerProbe: "unknown",
          resolvedAt: 6,
        },
      }),
    );
    render(<DispatchControl />);
    fireEvent.click(await screen.findByRole("button", { name: /budget & controls/i }));
    await screen.findByLabelText("Delivery role claims");

    fireEvent.change(screen.getByLabelText("Reconcile reason for claim-1"), {
      target: { value: "operator reviewed the frozen role" },
    });
    fireEvent.click(screen.getByLabelText("Acknowledge unknown owner for claim-1"));
    fireEvent.click(screen.getByRole("button", { name: /interrupt \(held\)/i }));

    await waitFor(() => expect(backing.reconcileDeliveryClaim).toHaveBeenCalled());
    const [runId, stage, submission] = backing.reconcileDeliveryClaim.mock.calls[0]!;
    expect(runId).toBe("run-1");
    expect(stage).toBe("blackbox_verification");
    expect(submission).toMatchObject({
      action: "interrupt",
      lap: 1,
      expectedGeneration: 2,
      expectedCandidateHeadSha: "c".repeat(40),
      expectedState: "interrupted",
      acknowledgeUnknownOwner: true,
      reason: "operator reviewed the frozen role",
    });
  });

  test("complete is disabled when no bound receipt exists", async () => {
    setup([
      detail([
        claim({
          state: "running",
          hold: {
            disposition: "active",
            reason: "claim_acquired",
            ownerProbe: "alive",
            resolvedAt: null,
          },
        }),
      ]),
    ]);
    render(<DispatchControl />);
    fireEvent.click(await screen.findByRole("button", { name: /budget & controls/i }));
    await screen.findByLabelText("Delivery role claims");
    const complete = screen.getByRole("button", {
      name: /complete from receipt/i,
    }) as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
  });

  test("empty state is explicit, not silent", async () => {
    setup([detail([])]);
    render(<DispatchControl />);
    fireEvent.click(await screen.findByRole("button", { name: /budget & controls/i }));
    const panel = await screen.findByLabelText("Delivery role claims");
    expect(panel.textContent).toMatch(/No durable delivery-role claim/i);
  });
});
