// @vitest-environment jsdom
import React from "react";
import { describe, expect, test, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { DispatchControl } from "../../apps/web/src/features/dispatch/dispatch-control";

afterEach(() => {
  cleanup();
});
import { ProjectList } from "../../apps/web/src/features/projects/project-list";
import { ProjectDetail } from "../../apps/web/src/features/projects/project-detail";
import type { Project } from "@animus/contracts/operator";

describe("Web Console UI Components: Honest States & Keyboard Interaction", () => {
  const mockProjects: Project[] = [
    {
      id: "proj-1",
      name: "Alpha Service",
      repo_id: 101,
      repo_name: "org/alpha-service",
      checkout_path: "/checkouts/alpha",
      status: "active",
      status_reason: null,
      created_at: "2026-10-31T00:00:00Z",
      updated_at: "2026-10-31T01:00:00Z",
    },
    {
      id: "proj-2",
      name: "Beta Worker",
      repo_id: 102,
      repo_name: "org/beta-worker",
      checkout_path: "/checkouts/beta",
      status: "held",
      status_reason: "Awaiting operator token configuration",
      created_at: "2026-10-31T00:00:00Z",
      updated_at: "2026-10-31T02:00:00Z",
    },
  ];

  test("ProjectList renders explicit loading state when fetching", () => {
    render(
      <ProjectList
        projects={[]}
        selectedProjectId={null}
        onSelectProject={() => {}}
        isLoading={true}
        error={null}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByTestId("projects-loading")).toBeTruthy();
    expect(screen.getByText(/Loading registered repositories from console database/i)).toBeTruthy();
  });

  test("ProjectList renders honest empty state when no repositories exist", () => {
    const onRefresh = vi.fn();
    render(
      <ProjectList
        projects={[]}
        selectedProjectId={null}
        onSelectProject={() => {}}
        isLoading={false}
        error={null}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByTestId("projects-empty")).toBeTruthy();
    expect(screen.getByText("No repositories enrolled")).toBeTruthy();
    expect(screen.getByText("animus setup")).toBeTruthy();

    const refreshBtn = screen.getByText("Refresh Registry");
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("ProjectList renders error state with retry button on failure", () => {
    const onRefresh = vi.fn();
    render(
      <ProjectList
        projects={[]}
        selectedProjectId={null}
        onSelectProject={() => {}}
        isLoading={false}
        error="Connection refused on 127.0.0.1:3000"
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByTestId("projects-error")).toBeTruthy();
    expect(screen.getByText("Unable to load project registry")).toBeTruthy();
    expect(screen.getByText("Connection refused on 127.0.0.1:3000")).toBeTruthy();

    const retryBtn = screen.getByText("Retry Connection");
    fireEvent.click(retryBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("ProjectList renders real data table and handles selection", () => {
    const onSelect = vi.fn();
    render(
      <ProjectList
        projects={mockProjects}
        selectedProjectId="proj-1"
        onSelectProject={onSelect}
        isLoading={false}
        error={null}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByTestId("projects-table")).toBeTruthy();
    expect(screen.getByText("Alpha Service")).toBeTruthy();
    expect(screen.getByText("Beta Worker")).toBeTruthy();
    expect(screen.getByText("org/alpha-service")).toBeTruthy();
    expect(screen.getByText("org/beta-worker")).toBeTruthy();

    // Active button for selected project
    const activeBtn = screen.getByRole("button", { name: /View project Alpha Service/i });
    expect(activeBtn.textContent).toContain("Active");

    // Click inspect on second project
    const inspectBtn = screen.getByRole("button", { name: /View project Beta Worker/i });
    expect(inspectBtn.textContent).toContain("Inspect");
    fireEvent.click(inspectBtn);
    expect(onSelect).toHaveBeenCalledWith("proj-2");
  });

  test("ProjectDetail renders inspected project metadata and status advisory", () => {
    const onClose = vi.fn();
    render(<ProjectDetail project={mockProjects[1]} onClose={onClose} />);

    expect(screen.getByTestId("project-detail-panel")).toBeTruthy();
    expect(screen.getByText("Beta Worker")).toBeTruthy();
    expect(screen.getByText("held")).toBeTruthy();
    expect(screen.getByText("/checkouts/beta")).toBeTruthy();
    expect(screen.getByText("Status Advisory:")).toBeTruthy();
    expect(screen.getByText("Awaiting operator token configuration")).toBeTruthy();

    // Close button dismisses detail panel
    const closeBtn = screen.getByRole("button", { name: "Close project details" });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])(
    "DispatchControl refreshes persisted runs after dispatch (failure=%s)",
    async (failed) => {
      const submissions: Array<{ plan_id: string; actor?: string }> = [];
      const runs: unknown[] = [];
      const plan = {
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
      const factory = {
        projects: async () => mockProjects,
        forProject: () => ({
          plans: async () => [plan],
          dispatchRuns: async () => runs,
          dispatchPlan: async (submission: { plan_id: string; actor?: string }) => {
            submissions.push(submission);
            const run = {
              id: "run-1",
              project_id: "proj-1",
              delivery_id: "del-1",
              plan_id: "plan-1",
              work_id: "work-1",
              revision_id: "rev-1",
              content_hash: "b".repeat(64),
              issue_number: 714,
              role: "ticket" as const,
              gate_profile: "standalone" as const,
              merge_policy: "manual" as const,
              target_branch: "main",
              ownership_generation: 1,
              lap: 1,
              state: failed ? ("failed" as const) : ("succeeded" as const),
              actor: "operator",
              command_request_id: "cmd-1",
              branch: "factory/standalone-714",
              worktree_path: "/tmp/worktree",
              base_sha: "c".repeat(40),
              owner_pid: 1,
              owner_token: "token",
              lease_expires_at: null,
              head_sha: "d".repeat(40),
              error: null,
              launched_at: 1,
              finished_at: 1,
              created_at: 1,
              updated_at: 1,
            };
            runs.push(run);
            if (failed) throw new Error("dispatch_failed");
            return run;
          },
        }),
      } as any;

      render(<DispatchControl factory={factory} />);

      const planRow = await screen.findByTestId("dispatch-plan-plan-1");
      expect(planRow.textContent).toContain("Standalone delivery");
      fireEvent.click(screen.getByRole("button", { name: "Dispatch" }));

      await waitFor(() => expect(submissions).toHaveLength(1));
      expect(submissions[0]).toEqual({ plan_id: "plan-1", actor: "operator" });
      if (failed) {
        await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("dispatch_failed"));
        expect(screen.queryByRole("status")).toBeNull();
      } else {
        await waitFor(() => expect(screen.getByText(/Run run-1 started for #714/)).toBeTruthy());
      }
      await waitFor(() =>
        expect(screen.getByText("Profile: standalone · Merge: manual · Target: main")).toBeTruthy(),
      );
      expect(screen.getByText(failed ? "failed" : "succeeded")).toBeTruthy();
    },
  );

  test("DispatchControl shows an honest empty state when no plan is admitted", async () => {
    const factory = {
      projects: async () => [mockProjects[0]!],
      forProject: () => ({
        plans: async () => [],
        dispatchRuns: async () => [],
        dispatchPlan: async () => {
          throw new Error("must not dispatch");
        },
      }),
    } as any;

    render(<DispatchControl factory={factory} />);
    expect(await screen.findByTestId("dispatch-empty")).toBeTruthy();
    expect(screen.getByText(/No admitted plans for this project/)).toBeTruthy();
  });

  test("DispatchControl exposes the selected run's checks, findings, artifacts and acceptance", async () => {
    const plan = {
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
    const run = {
      id: "run-1",
      project_id: "proj-1",
      delivery_id: "del-1",
      plan_id: "plan-1",
      work_id: "work-1",
      revision_id: "rev-1",
      content_hash: "b".repeat(64),
      issue_number: 714,
      role: "ticket" as const,
      gate_profile: "standalone" as const,
      merge_policy: "manual" as const,
      target_branch: "main",
      ownership_generation: 1,
      lap: 1,
      state: "succeeded" as const,
      actor: "operator",
      command_request_id: "cmd-1",
      branch: "factory/standalone-714",
      worktree_path: "/tmp/worktree",
      base_sha: "c".repeat(40),
      owner_pid: 1,
      owner_token: "token",
      lease_expires_at: null,
      head_sha: "d".repeat(40),
      error: null,
      launched_at: 1,
      finished_at: 1,
      created_at: 1,
      updated_at: 1,
    };
    const report = {
      observations: [
        {
          id: "obs-1",
          projectId: "proj-1",
          deliveryId: "del-1",
          runId: "run-1",
          lap: 1,
          stage: "independent_review",
          status: "passed",
          candidateHeadSha: "d".repeat(40),
          targetTipSha: "c".repeat(40),
          mergeBaseSha: "c".repeat(40),
          testedIdentity: "d".repeat(40),
          integrationLineage: `${"a".repeat(64)}@main`,
          producer: { id: "reviewer-2", role: "peer_reviewer" },
          gateProfile: "standalone",
          gateProfileVersion: 1,
          error: null,
          createdAt: 1,
          checks: [
            {
              id: "chk-1",
              observationId: "obs-1",
              name: "unit",
              command: "bun test",
              result: "PASS",
              durationMs: 12,
              detail: null,
              artifactPath: "checks/report.log",
              createdAt: 1,
            },
          ],
          artifacts: [
            {
              id: "art-1",
              projectId: "proj-1",
              observationId: "obs-1",
              ownerType: "observation",
              ownerId: "obs-1",
              name: "unit-report",
              relativePath: "checks/report.log",
              mediaType: "text/plain",
              sizeBytes: 26,
              digestSha256: "e".repeat(64),
              createdAt: 1,
            },
          ],
        },
      ],
      findings: [
        {
          id: "find-1",
          projectId: "proj-1",
          deliveryId: "del-1",
          runId: "run-1",
          workId: "work-1",
          issueNumber: 714,
          acKey: "AC1",
          severity: "blocking",
          fileContext: "apps/backend/src/example.ts:10",
          summary: "prepared criterion is not implemented",
          originObservationId: "obs-0",
          status: "resolved",
          createdAt: 1,
          resolvedAt: 2,
          events: [
            {
              id: "evt-1",
              findingId: "find-1",
              sequence: 1,
              action: "opened",
              actor: "gate-1",
              actorRole: "automated_gate",
              observationId: "obs-0",
              detail: null,
              createdAt: 1,
            },
            {
              id: "evt-2",
              findingId: "find-1",
              sequence: 2,
              action: "recheck_passed",
              actor: "reviewer-2",
              actorRole: "peer_reviewer",
              observationId: "obs-1",
              detail: null,
              createdAt: 2,
            },
          ],
        },
      ],
      acceptance: {
        runId: "run-1",
        projectId: "proj-1",
        deliveryId: "del-1",
        gateProfile: "standalone",
        candidateHeadSha: "d".repeat(40),
        targetTipSha: "c".repeat(40),
        mergeBaseSha: "c".repeat(40),
        integrationLineage: `${"a".repeat(64)}@main`,
        authorized: true,
        reasons: [],
        builderObservationId: "obs-0",
        independentObservationId: "obs-1",
        openBlockingFindingIds: [],
        verifiedArtifactIds: ["art-1"],
      },
    };
    const evidenceRequests: string[] = [];
    const factory = {
      projects: async () => [mockProjects[0]!],
      forProject: () => ({
        plans: async () => [plan],
        dispatchRuns: async () => [run],
        dispatchPlan: async () => {
          throw new Error("must not dispatch");
        },
        runEvidence: async (runId: string) => {
          evidenceRequests.push(runId);
          return report;
        },
      }),
    } as any;

    render(<DispatchControl factory={factory} />);
    const button = await screen.findByRole("button", { name: "View evidence" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("run-evidence-run-1");
    fireEvent.click(button);

    const panel = await screen.findByTestId("run-evidence-run-1");
    expect(evidenceRequests).toEqual(["run-1"]);
    expect(
      screen.getByRole("button", { name: "Hide evidence" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(panel.textContent).toContain("Acceptance authorized");
    expect(panel.textContent).toContain("independent_review");
    expect(panel.textContent).toContain("bun test");
    expect(panel.textContent).toContain("checks/report.log");
    expect(panel.textContent).toContain("prepared criterion is not implemented");
    expect(panel.textContent).toContain("recheck_passed");
    expect(screen.getByLabelText("Finalized artifacts")).toBeTruthy();
    expect(screen.getByLabelText("Factory findings")).toBeTruthy();

    // Collapsing hides the panel without dropping the cached evidence.
    fireEvent.click(screen.getByRole("button", { name: "Hide evidence" }));
    await waitFor(() => expect(screen.queryByTestId("run-evidence-run-1")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(await screen.findByTestId("run-evidence-run-1")).toBeTruthy();
    expect(evidenceRequests).toEqual(["run-1"]);
  });

  test("DispatchControl lets operators select a ticket/run/candidate history", async () => {
    const plan = {
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
    const baseRun = {
      project_id: "proj-1",
      delivery_id: "del-1",
      plan_id: "plan-1",
      work_id: "work-1",
      revision_id: "rev-1",
      content_hash: "b".repeat(64),
      role: "ticket" as const,
      gate_profile: "standalone" as const,
      merge_policy: "manual" as const,
      target_branch: "main",
      actor: "operator",
      command_request_id: "cmd-1",
      branch: "factory/standalone-714",
      worktree_path: "/tmp/worktree",
      base_sha: "c".repeat(40),
      owner_pid: 1,
      owner_token: "token",
      lease_expires_at: null,
      error: null,
      launched_at: 1,
      finished_at: 1,
      updated_at: 1,
    };
    const older = {
      ...baseRun,
      id: "run-old",
      issue_number: 714,
      ownership_generation: 1,
      lap: 1,
      state: "failed" as const,
      head_sha: "d".repeat(40),
      created_at: 1,
    };
    const newer = {
      ...baseRun,
      id: "run-new",
      issue_number: 715,
      ownership_generation: 2,
      lap: 2,
      state: "succeeded" as const,
      head_sha: "e".repeat(40),
      created_at: 2,
    };
    const requests: string[] = [];
    const acceptance = {
      runId: "run-new",
      projectId: "proj-1",
      deliveryId: "del-1",
      gateProfile: "standalone",
      candidateHeadSha: "e".repeat(40),
      targetTipSha: "c".repeat(40),
      mergeBaseSha: "c".repeat(40),
      integrationLineage: "a".repeat(64) + "@main",
      authorized: false,
      reasons: ["run_not_succeeded"],
      builderObservationId: null,
      independentObservationId: null,
      openBlockingFindingIds: [],
      verifiedArtifactIds: [],
    };
    const factory = {
      projects: async () => [mockProjects[0]!],
      forProject: () => ({
        plans: async () => [plan],
        dispatchRuns: async () => [newer, older],
        dispatchPlan: async () => {
          throw new Error("must not dispatch");
        },
        runEvidence: async (runId: string) => {
          requests.push(runId);
          return { observations: [], findings: [], acceptance: { ...acceptance, runId } };
        },
      }),
    } as any;

    render(<DispatchControl factory={factory} />);
    const history = await screen.findByLabelText("Run history for #714");
    expect(history.textContent).toContain("#715 · lap 2");
    expect(history.textContent).toContain("#714 · lap 1");

    fireEvent.click(screen.getByRole("button", { name: "View evidence" }));
    await waitFor(() => expect(requests).toEqual(["run-new"]));
    fireEvent.click(screen.getByRole("button", { name: "Hide evidence" }));

    fireEvent.change(history, { target: { value: "run-old" } });
    fireEvent.click(screen.getByRole("button", { name: "View evidence" }));
    await waitFor(() => expect(requests).toEqual(["run-new", "run-old"]));
  });
});
