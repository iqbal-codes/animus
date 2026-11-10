// @vitest-environment jsdom
import React from "react";
import { describe, expect, test, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { RepositorySelector } from "../../apps/web/src/features/projects/repository-selector";
import { AddRepositoryModal } from "../../apps/web/src/features/projects/add-repository-modal";
import { client } from "../../apps/web/src/lib/factory-client";
import type { Project } from "@animus/contracts/operator";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

// Mock pointer capture for jsdom
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

const mockProjects: Project[] = [
  {
    id: "proj-1",
    name: "animus",
    repo_id: 101,
    repo_name: "efishery/animus",
    checkout_path: "/workspace/animus",
    status: "active",
    status_reason: null,
    created_at: new Date(1700000000).toISOString(),
    updated_at: new Date(1700000000).toISOString(),
  },
  {
    id: "proj-2",
    name: "aquaculture-core",
    repo_id: 102,
    repo_name: "efishery/aquaculture-core",
    checkout_path: "/workspace/aqua",
    status: "active",
    status_reason: null,
    created_at: new Date(1700000000).toISOString(),
    updated_at: new Date(1700000000).toISOString(),
  },
];

describe("RepositorySelector Component (Frame li3jI)", () => {
  test("renders trigger with current repository name and opens popover on click", async () => {
    const handleSelect = vi.fn();
    render(
      <RepositorySelector
        currentRepository="efishery/animus"
        currentProjectId="proj-1"
        projects={mockProjects}
        onSelectProject={handleSelect}
      />,
    );

    const trigger = screen.getByRole("button", { name: /efishery\/animus/i });
    expect(trigger).toBeDefined();

    fireEvent.click(trigger);

    // Verify popover elements
    expect(screen.getByPlaceholderText(/search repositories/i)).toBeDefined();
    expect(screen.getByText("Repositories")).toBeDefined();
    expect(screen.getAllByText("efishery/animus").length).toBe(2); // In trigger + in list
    expect(screen.getByText("efishery/aquaculture-core")).toBeDefined();
    expect(screen.getByRole("button", { name: /add repository/i })).toBeDefined();
  });

  test("filters repository list based on search query", async () => {
    const handleSelect = vi.fn();
    render(
      <RepositorySelector
        currentRepository="efishery/animus"
        currentProjectId="proj-1"
        projects={mockProjects}
        onSelectProject={handleSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /efishery\/animus/i }));

    const searchInput = screen.getByPlaceholderText(/search repositories/i);
    fireEvent.change(searchInput, { target: { value: "aqua" } });

    // "efishery/animus" only remains on the trigger pill, not in the filtered list
    expect(screen.getAllByText("efishery/animus").length).toBe(1);
    expect(screen.getByText("efishery/aquaculture-core")).toBeDefined();
  });

  test("calls onSelectProject when a repository item is clicked", async () => {
    const handleSelect = vi.fn();
    render(
      <RepositorySelector
        currentRepository="efishery/animus"
        currentProjectId="proj-1"
        projects={mockProjects}
        onSelectProject={handleSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /efishery\/animus/i }));
    fireEvent.click(screen.getByText("efishery/aquaculture-core"));

    expect(handleSelect).toHaveBeenCalledWith("proj-2");
  });
});

describe("AddRepositoryModal Component (Frame Xlk78)", () => {
  test("renders 3 onboarding options in chooser mode", () => {
    render(<AddRepositoryModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);

    expect(screen.getByText("Add repository")).toBeDefined();
    expect(screen.getByText("Choose how to add a repository to Animus.")).toBeDefined();

    expect(screen.getByText("Select local folder")).toBeDefined();
    expect(screen.getByText("Select Remote repository")).toBeDefined();
    expect(screen.getByText("Create new repo")).toBeDefined();
  });

  test("transitions to local folder form and registers repository", async () => {
    const handleSuccess = vi.fn();
    const handleOpenChange = vi.fn();

    const registerSpy = vi.spyOn(client, "registerProject").mockResolvedValueOnce({
      id: "proj-new",
      name: "my-local-app",
      repo_id: 999,
      repo_name: "local/my-local-app",
      checkout_path: "/Users/test/my-local-app",
      status: "active",
      status_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    render(
      <AddRepositoryModal open={true} onOpenChange={handleOpenChange} onSuccess={handleSuccess} />,
    );

    fireEvent.click(screen.getByText("Select local folder"));

    expect(
      screen.getByText(/provide the filesystem path to an existing git repository/i),
    ).toBeDefined();
    const pathInput = screen.getByPlaceholderText(/\/users\/username\/workspace\/repo/i);
    fireEvent.change(pathInput, { target: { value: "/Users/test/my-local-app" } });

    const submitBtn = screen.getByRole("button", { name: /add repository/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledWith({
        method: "local_checkout",
        name: "my-local-app",
        checkout_path: "/Users/test/my-local-app",
      });
      expect(handleSuccess).toHaveBeenCalled();
      expect(handleOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("transitions to remote clone form and allows navigation back to chooser", () => {
    render(<AddRepositoryModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);

    fireEvent.click(screen.getByText("Select Remote repository"));
    expect(
      screen.getByText(/clone a repository from github and enroll it in animus/i),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText("Choose how to add a repository to Animus.")).toBeDefined();
  });
});
