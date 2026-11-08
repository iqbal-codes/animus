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
          gateProfileVersion: 2,
          error: null,
          createdAt: 1,
          checks: [
            {
              id: "chk-1",
              observationId: "obs-1",
              name: "unit",
              command: "bun test",
              result: "PASS",
              kind: "review",
              criterionKey: null,
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

  test("DispatchControl exposes publication audit, failed outgoing intents and recovery", async () => {
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
      gate_profile: "child" as const,
      merge_policy: "auto_after_gates" as const,
      target_branch: "factory/spec-714-integration",
      ownership_generation: 1,
      lap: 2,
      state: "failed" as const,
      actor: "operator",
      command_request_id: "cmd-1",
      branch: "factory/spec-714/ticket-714-r2",
      worktree_path: "/tmp/worktree",
      base_sha: "c".repeat(40),
      owner_pid: 1,
      owner_token: "token",
      lease_expires_at: null,
      head_sha: "d".repeat(40),
      error: "publication failed",
      launched_at: 1,
      finished_at: 1,
      created_at: 1,
      updated_at: 1,
    };
    const status = {
      target: {
        id: "pub-1",
        projectId: "proj-1",
        deliveryId: "del-1",
        planId: "plan-1",
        workId: "work-1",
        issueNumber: 714,
        gateProfile: "child" as const,
        sourceBranch: "factory/spec-714/ticket-714-r2",
        targetBranch: "factory/spec-714-integration",
        candidateHeadSha: "d".repeat(40),
        baseSha: "c".repeat(40),
        state: "failed" as const,
        activePullRequestId: null,
        lastError: "GitHub unavailable",
        createdAt: 1,
        updatedAt: 1,
      },
      pullRequests: [],
      events: [
        {
          id: "pevt-1",
          targetId: "pub-1",
          projectId: "proj-1",
          sequence: 1,
          workId: "work-1",
          runId: "run-1",
          lap: 2,
          candidateHeadSha: "d".repeat(40),
          observationId: "obs-1",
          findingId: null,
          kind: "verification_failure" as const,
          severity: "blocking" as const,
          title: "technical_checks failed",
          body: "unit failed",
          occurredAt: 1,
        },
      ],
      intents: [
        {
          id: "int-1",
          targetId: "pub-1",
          projectId: "proj-1",
          operationKey: "event:pevt-1",
          kind: "publish_event" as const,
          state: "failed" as const,
          attempts: 2,
          remoteObjectId: null,
          remoteUrl: null,
          lastError: "GitHub unavailable",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      evidence: [],
      summary: "audit summary",
      queuedEventCount: 1,
      publishedEventCount: 0,
      failedIntentCount: 1,
      unknownIntentCount: 0,
      auditComplete: false,
      remoteObservedAt: null,
      remoteStale: false,
    };
    const published: string[] = [];
    const factory = {
      projects: async () => [mockProjects[0]!],
      forProject: () => ({
        plans: async () => [plan],
        dispatchRuns: async () => [run],
        dispatchPlan: async () => {
          throw new Error("must not dispatch");
        },
        publication: async () => status,
        publishPublication: async (runId: string) => {
          published.push(runId);
          return status;
        },
      }),
    } as any;

    render(<DispatchControl factory={factory} />);
    const auditButton = await screen.findByRole("button", { name: "View audit" });
    expect(auditButton.getAttribute("aria-expanded")).toBe("false");
    expect(auditButton.getAttribute("aria-controls")).toBe("run-audit-run-1");
    fireEvent.click(auditButton);

    const panel = await screen.findByTestId("run-audit-run-1");
    expect(panel.textContent).toContain("Audit incomplete");
    expect(panel.textContent).toContain("failed");
    expect(panel.textContent).toContain("GitHub unavailable");
    expect(panel.textContent).toContain("technical_checks failed");
    expect(panel.textContent).toContain("lap 2");
    expect(panel.textContent).toContain("No PR yet");

    fireEvent.click(screen.getByRole("button", { name: "Retry publication" }));
    await waitFor(() => expect(published).toEqual(["run-1"]));
    expect(screen.getByLabelText("Outgoing publication intents")).toBeTruthy();
    expect(screen.getByLabelText("Publication audit history")).toBeTruthy();
  });

  test("DispatchControl exposes child integration blockers, checks and a landing action", async () => {
    const plan = {
      id: "plan-1",
      project_id: "proj-1",
      kind: "spec" as const,
      root_work_id: "work-1",
      root_issue_number: 714,
      root_title: "Spec delivery",
      graph_hash: "a".repeat(64),
      authority: "admitted" as const,
      member_count: 2,
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
      gate_profile: "child" as const,
      merge_policy: "auto_after_gates" as const,
      target_branch: "factory/spec-714-integration",
      ownership_generation: 1,
      lap: 1,
      state: "succeeded" as const,
      actor: "operator",
      command_request_id: "cmd-1",
      branch: "factory/spec-714/ticket-714",
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
    const status = {
      runId: "run-1",
      projectId: "proj-1",
      deliveryId: "del-1",
      planId: "plan-1",
      workId: "work-1",
      issueNumber: 714,
      gateProfile: "child" as const,
      mergePolicy: "auto_after_gates" as const,
      targetBranch: "factory/spec-714-integration",
      state: "blocked" as const,
      blockers: [
        {
          code: "integration_acceptance_blocked",
          message: "Candidate-bound acceptance is not authorized",
        },
      ],
      acceptance: {
        runId: "run-1",
        projectId: "proj-1",
        deliveryId: "del-1",
        gateProfile: "child" as const,
        candidateHeadSha: "d".repeat(40),
        targetTipSha: "c".repeat(40),
        mergeBaseSha: "c".repeat(40),
        integrationLineage: "lineage@factory/spec-714-integration",
        authorized: false,
        reasons: ["required_stage_missing:independent_review"],
        builderObservationId: "obs-1",
        independentObservationId: null,
        openBlockingFindingIds: [],
        verifiedArtifactIds: [],
      },
      publication: null,
      requiredChecks: [
        {
          name: "ci/verify",
          required: true,
          status: "completed",
          conclusion: "success",
        },
      ],
      integration: null,
      events: [
        {
          id: "ievt-1",
          projectId: "proj-1",
          runId: "run-1",
          kind: "blocked" as const,
          candidateHeadSha: "d".repeat(40),
          targetTipSha: "c".repeat(40),
          mergeSha: null,
          reasons: ["integration_acceptance_blocked: Candidate-bound acceptance is not authorized"],
          createdAt: 1,
        },
      ],
    };
    const landed: string[] = [];
    const factory = {
      projects: async () => [mockProjects[0]!],
      forProject: () => ({
        plans: async () => [plan],
        dispatchRuns: async () => [run],
        dispatchRunDetail: async () => {
          throw new Error("not needed");
        },
        integrationStatus: async () => status,
        landChild: async (runId: string) => {
          landed.push(runId);
          return status;
        },
      }),
    } as any;

    render(<DispatchControl factory={factory} />);
    const button = await screen.findByRole("button", { name: "Integration" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("run-integration-run-1");
    expect((button as HTMLButtonElement).className).toContain("min-h-11");
    fireEvent.click(button);

    const panel = await screen.findByTestId("run-integration-run-1");
    expect(panel.textContent).toContain("Integration to factory/spec-714-integration");
    expect(panel.textContent).toContain("integration_acceptance_blocked");
    expect(panel.textContent).toContain("required_stage_missing:independent_review");
    expect(panel.textContent).toContain("ci/verify");
    expect(panel.textContent).toContain("No active pull request");
    expect(panel.textContent).toContain("Integration attempts");

    fireEvent.click(screen.getByRole("button", { name: "Merge to integration" }));
    await waitFor(() => expect(landed).toEqual(["run-1"]));
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

  test("DispatchControl exposes attempt budget, retained work, grants and controls", async () => {
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
      ownership_generation: 3,
      lap: 3,
      state: "failed" as const,
      actor: "operator",
      command_request_id: "cmd-3",
      branch: "factory/standalone-714",
      worktree_path: "/tmp/worktree",
      base_sha: "c".repeat(40),
      owner_pid: 1,
      owner_token: "token",
      lease_expires_at: null,
      head_sha: null,
      error: "runner rejected",
      launched_at: 1,
      finished_at: 3,
      created_at: 3,
      updated_at: 3,
    };
    const detail = {
      run,
      budget: {
        scopeId: "budget-1",
        projectId: "proj-1",
        deliveryId: "del-1",
        planId: "plan-1",
        workId: "work-1",
        gateProfile: "standalone" as const,
        baseLimit: 3,
        grantedAttempts: 0,
        consumedAttempts: 3,
        allowedAttempts: 3,
        remainingAttempts: 0,
        status: "exhausted" as const,
        exhaustedAt: 3,
        lastRejection: "runner rejected",
        retainedWorktreePath: "/tmp/worktree",
        retainedBranch: "factory/standalone-714",
        retainedRunId: "run-1",
        retainedHeadSha: null,
      },
      control: null,
      grants: [
        {
          id: "grant-1",
          projectId: "proj-1",
          scopeId: "budget-1",
          deliveryId: "del-1",
          workId: "work-1",
          gateProfile: "standalone" as const,
          amount: 1,
          reason: "operator allows one more",
          actor: "operator",
          commandRequestId: "cmd-grant",
          idempotencyKey: "grant-key-1",
          createdAt: 4,
        },
      ],
      attempts: [
        {
          runId: "run-1",
          lap: 3,
          ownershipGeneration: 3,
          state: "failed" as const,
          issueNumber: 714,
          headSha: null,
          error: "runner rejected",
          createdAt: 3,
          finishedAt: 3,
        },
      ],
      process: {
        ownerPid: 1,
        ownerAlive: false,
        workerPid: null,
        workerPgid: null,
        workerAlive: false,
        worktreeLockPid: null,
        worktreeLockAlive: false,
      },
      acceptanceCriteria: [
        { acKey: "AC1", text: "prepared criterion", openFindingIds: ["find-1"] },
      ],
      openFindings: [
        {
          id: "find-1",
          projectId: "proj-1",
          deliveryId: "del-1",
          runId: "run-1",
          workId: "work-1",
          issueNumber: 714,
          acKey: "AC1",
          severity: "blocking" as const,
          fileContext: "apps/backend/src/example.ts:42",
          summary: "unresolved defect",
          originObservationId: "obs-1",
          status: "open" as const,
          createdAt: 3,
          resolvedAt: null,
          events: [],
        },
      ],
      acceptance: {
        runId: "run-1",
        projectId: "proj-1",
        deliveryId: "del-1",
        gateProfile: "standalone" as const,
        candidateHeadSha: null,
        targetTipSha: "c".repeat(40),
        mergeBaseSha: null,
        integrationLineage: "a".repeat(64) + "@main",
        authorized: false,
        reasons: ["budget_exhausted", "run_not_succeeded"],
        builderObservationId: "obs-0",
        independentObservationId: null,
        openBlockingFindingIds: ["find-1"],
        verifiedArtifactIds: [],
      },
    };
    const grants: Array<{
      amount: number;
      reason: string;
      actor: string;
      idempotency_key?: string;
    }> = [];
    const controls: string[] = [];
    let grantAttempts = 0;
    const factory = {
      projects: async () => [mockProjects[0]!],
      forProject: () => ({
        plans: async () => [plan],
        dispatchRuns: async () => [run],
        dispatchPlan: async () => {
          throw new Error("must not dispatch");
        },
        dispatchRunDetail: async () => detail,
        grantDispatchBudget: async (_runId: string, submission: any) => {
          grants.push(submission);
          grantAttempts += 1;
          if (grantAttempts === 1) throw new Error("ambiguous network response");
          return {
            grant: { ...detail.grants[0]!, amount: submission.amount, reason: submission.reason },
            budget: {
              ...detail.budget,
              status: "active",
              grantedAttempts: 1,
              allowedAttempts: 4,
              remainingAttempts: 1,
            },
            replayed: false,
            commandRequestId: "cmd-grant-2",
          };
        },
        controlDispatchRun: async (_runId: string, submission: any) => {
          controls.push(submission.action);
          return {
            run,
            control: {
              status: "held",
              reason: submission.reason,
              actor: submission.actor,
              commandRequestId: "cmd-control",
              stopSignal: null,
              stopRequestedAt: null,
              stoppedAt: null,
              updatedAt: 5,
            },
            budget: detail.budget,
            confirmed: true,
            commandRequestId: "cmd-control",
            detail: "held",
          };
        },
      }),
    } as any;

    render(<DispatchControl factory={factory} />);
    const dispatchButton = (await screen.findByRole("button", {
      name: "Dispatch",
    })) as HTMLButtonElement;
    await waitFor(() => expect(dispatchButton.disabled).toBe(true));
    expect(dispatchButton.getAttribute("title")).toContain("exhausted");
    // The selected run detail is loaded before the panel is opened.
    expect(screen.queryByTestId("run-budget-run-1")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Budget & controls" }));
    const panel = await screen.findByTestId("run-budget-run-1");
    expect(panel.textContent).toContain("Needs owner");
    expect(panel.textContent).toContain("3/3 used");
    expect(panel.textContent).toContain("/tmp/worktree");
    expect(panel.textContent).toContain("unresolved defect");
    expect(panel.textContent).toContain("operator allows one more");
    expect(panel.textContent).toContain("lap 3 · failed");

    fireEvent.change(screen.getByLabelText("Additional attempts"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Grant reason"), {
      target: { value: "unblock after diagnosis" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant attempt" }));
    await waitFor(() => expect(grants).toHaveLength(1));
    expect(grants[0]).toMatchObject({
      amount: 2,
      reason: "unblock after diagnosis",
      actor: "operator",
    });
    expect(typeof grants[0]!.idempotency_key).toBe("string");
    await waitFor(() => expect(screen.getByText("ambiguous network response")).toBeTruthy());

    // A retry after an ambiguous response reuses the same submission key.
    fireEvent.click(screen.getByRole("button", { name: "Grant attempt" }));
    await waitFor(() => expect(grants).toHaveLength(2));
    expect(grants[1]!.idempotency_key).toBe(grants[0]!.idempotency_key);
    await waitFor(() => expect(screen.getByText(/grant \+2/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    await waitFor(() => expect(controls).toEqual(["hold"]));
  });

  test("DispatchControl exposes the full-delivery gate, manual merge wait and verified merge", async () => {
    const plan = {
      id: "plan-gate",
      project_id: "proj-1",
      kind: "standalone" as const,
      root_work_id: "work-gate",
      root_issue_number: 1800,
      root_title: "Standalone delivery gate",
      graph_hash: "a".repeat(64),
      authority: "admitted" as const,
      member_count: 1,
      ticket_count: 1,
      hold_count: 0,
      accepted_revision_id: "rev-gate",
      created_at: 1,
      updated_at: 1,
    };
    const run = {
      id: "run-gate",
      project_id: "proj-1",
      delivery_id: "del-gate",
      plan_id: "plan-gate",
      work_id: "work-gate",
      revision_id: "rev-gate",
      content_hash: "b".repeat(64),
      issue_number: 1800,
      role: "ticket" as const,
      gate_profile: "standalone" as const,
      merge_policy: "manual" as const,
      target_branch: "main",
      ownership_generation: 1,
      lap: 1,
      state: "succeeded" as const,
      actor: "operator",
      command_request_id: "cmd-gate",
      branch: "factory/standalone-1800",
      worktree_path: "/tmp/gate-worktree",
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
    const acceptance = {
      runId: run.id,
      projectId: "proj-1",
      deliveryId: "del-gate",
      gateProfile: "standalone" as const,
      candidateHeadSha: run.head_sha,
      targetTipSha: run.base_sha,
      mergeBaseSha: run.base_sha,
      integrationLineage: `${"a".repeat(64)}@main`,
      authorized: true,
      reasons: [],
      builderObservationId: "obs-builder",
      independentObservationId: "obs-review",
      openBlockingFindingIds: [],
      verifiedArtifactIds: [],
    };
    const stages = [
      {
        name: "builder_execution",
        status: "passed" as const,
        detail: "committed candidate",
        observationId: "obs-builder",
      },
      {
        name: "independent_review",
        status: "passed" as const,
        detail: "review passed",
        observationId: "obs-review",
      },
      {
        name: "final_acceptance",
        status: "passed" as const,
        detail: "acceptance passed",
        observationId: "obs-final",
      },
      {
        name: "acceptance_criteria",
        status: "passed" as const,
        detail: "1 acceptance criterion independently verified",
        observationId: "obs-final",
      },
      {
        name: "regression",
        status: "passed" as const,
        detail: "regression passed",
        observationId: "obs-final",
      },
      {
        name: "remote_ci",
        status: "passed" as const,
        detail: "remote ci passed",
        observationId: "obs-final",
      },
      {
        name: "review",
        status: "passed" as const,
        detail: "standards review passed",
        observationId: "obs-review",
      },
      {
        name: "publication_audit",
        status: "passed" as const,
        detail: "audit complete",
        observationId: null,
      },
      {
        name: "remote_pull_request",
        status: "passed" as const,
        detail: "PR #1 OPEN",
        observationId: null,
      },
      {
        name: "target_lineage",
        status: "not_applicable" as const,
        detail: "not merged yet",
        observationId: null,
      },
    ];
    const readyGate = {
      runId: run.id,
      projectId: "proj-1",
      deliveryId: "del-gate",
      planId: plan.id,
      workId: run.work_id,
      issueNumber: 1800,
      gateProfile: "standalone" as const,
      mergePolicy: "manual" as const,
      sourceBranch: run.branch,
      targetBranch: "main",
      candidateHeadSha: run.head_sha,
      targetTipSha: run.base_sha,
      mergeBaseSha: run.base_sha,
      integrationLineage: acceptance.integrationLineage,
      gateProfileVersion: 2,
      state: "ready_for_operator_review" as const,
      reasons: [],
      stages,
      acceptance,
      publication: {
        targetId: "pub-gate",
        state: "published" as const,
        auditComplete: true,
        pullRequestId: "pr-gate",
        prNumber: 1,
        url: "https://github.com/org/repo/pull/1",
        headBranch: run.branch,
        baseBranch: "main",
        remoteState: "open" as const,
        draft: true,
        headRefOid: run.head_sha,
      },
      merge: {
        state: "not_merged" as const,
        verified: false,
        verification: null,
        remoteTargetTipSha: null,
        detail: "remote pull request is not merged",
      },
      manualMergeRequired: true,
    };
    const deliveredGate = {
      ...readyGate,
      state: "delivered" as const,
      merge: {
        state: "verified" as const,
        verified: true,
        verification: {
          id: "dmv-1",
          projectId: "proj-1",
          deliveryId: "del-gate",
          planId: plan.id,
          workId: run.work_id,
          runId: run.id,
          gateProfile: "standalone" as const,
          targetId: "pub-gate",
          pullRequestId: "pr-gate",
          repository: "org/repo",
          prNumber: 1,
          sourceBranch: run.branch,
          targetBranch: "main",
          candidateHeadSha: run.head_sha,
          remoteHeadRefOid: run.head_sha,
          remoteTargetTipSha: run.head_sha,
          mergeCommitSha: null,
          verifiedAt: 9,
          verifiedBy: "operator",
        },
        remoteTargetTipSha: run.head_sha,
        detail: "verified merge of PR #1 into main",
      },
    };
    const awaitingGate = {
      ...readyGate,
      state: "awaiting_merge_verification" as const,
      reasons: ["merge_verification_required"],
      publication: { ...readyGate.publication, remoteState: "merged" as const, draft: false },
      merge: {
        state: "unverified" as const,
        verified: false,
        verification: null,
        remoteTargetTipSha: run.head_sha,
        detail: `candidate ${run.head_sha} is in remote main ${run.head_sha}`,
      },
    };
    let currentGate: typeof readyGate | typeof awaitingGate = readyGate;
    const gateReads: string[] = [];
    const mergeVerifications: string[] = [];
    const factory = {
      projects: async () => [mockProjects[0]!],
      forProject: () => ({
        plans: async () => [plan],
        dispatchRuns: async () => [run],
        deliveryGate: async (runId: string) => {
          gateReads.push(runId);
          return currentGate;
        },
        verifyDeliveryMerge: async (runId: string, actor: string) => {
          mergeVerifications.push(`${runId}:${actor}`);
          return deliveredGate;
        },
      }),
    } as any;

    render(<DispatchControl factory={factory} />);
    const gateButton = await screen.findByRole("button", { name: "Delivery gate" });
    expect(gateButton.getAttribute("aria-expanded")).toBe("false");
    expect(gateButton.getAttribute("aria-controls")).toBe("run-gate-run-gate");
    fireEvent.click(gateButton);

    const panel = await screen.findByTestId("run-gate-run-gate");
    expect(gateReads).toEqual([run.id]);
    expect(panel.textContent).toContain("ready_for_operator_review");
    expect(panel.textContent).toContain("merge manual");
    expect(panel.textContent).toContain("Operator review required");
    expect(panel.textContent).toContain("final_acceptance");
    expect(panel.textContent).toContain("remote_ci");
    expect(panel.textContent).not.toContain("delivered");
    expect(screen.queryByRole("button", { name: "Verify merge" })).toBeNull();

    // GitHub changes outside this process. Reopening the panel re-reads the gate
    // instead of trusting the earlier cached projection.
    currentGate = awaitingGate;
    fireEvent.click(screen.getByRole("button", { name: "Hide gate" }));
    await waitFor(() => expect(screen.queryByTestId("run-gate-run-gate")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Delivery gate" }));
    await waitFor(() =>
      expect(screen.getByTestId("run-gate-run-gate").textContent).toContain(
        "awaiting_merge_verification",
      ),
    );
    expect(gateReads).toEqual([run.id, run.id]);

    fireEvent.click(screen.getByRole("button", { name: "Verify merge" }));
    await waitFor(() => expect(mergeVerifications).toEqual([`${run.id}:operator`]));
    await waitFor(() =>
      expect(screen.getByTestId("run-gate-run-gate").textContent).toContain("delivered"),
    );
    expect(screen.getByTestId("run-gate-run-gate").textContent).toContain("verified");
    expect(screen.getByLabelText("Delivery gate stages")).toBeTruthy();
  });
});
