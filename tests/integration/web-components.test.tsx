// @vitest-environment jsdom
import React from "react";
import { describe, expect, test, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

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
});
