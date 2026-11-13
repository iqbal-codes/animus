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
    expect(screen.getByText("Choose how you want to bring a codebase into Animus.")).toBeDefined();

    expect(screen.getByText("Select local folder")).toBeDefined();
    expect(screen.getByText("Clone repository")).toBeDefined();
    expect(screen.getByText("Create new repo")).toBeDefined();
  });

  test("browses local folders, previews git metadata, registers, and opens repository", async () => {
    const handleSuccess = vi.fn();
    const handleOpenChange = vi.fn();

    vi.spyOn(client, "browseDirectories").mockResolvedValueOnce({
      currentPath: "/Users/test",
      parentPath: "/Users",
      homePath: "/Users/test",
      projectsPath: "/Users/test/.animus/projects",
      entries: [{ name: "my-local-app", path: "/Users/test/my-local-app", isGitRepo: true }],
      error: null,
    });

    vi.spyOn(client, "inspectLocalProject").mockResolvedValueOnce({
      path: "/Users/test/my-local-app",
      exists: true,
      isDirectory: true,
      readable: true,
      isGitRepo: true,
      isWorktree: false,
      name: "my-local-app",
      branch: "main",
      remoteUrl: "https://github.com/efishery/my-local-app.git",
      repoName: "efishery/my-local-app",
      alreadyEnrolled: false,
      existingProject: null,
      errorCode: null,
      errorMessage: null,
    });

    const registerSpy = vi.spyOn(client, "registerProject").mockResolvedValueOnce({
      id: "proj-new",
      name: "my-local-app",
      repo_id: 999,
      repo_name: "efishery/my-local-app",
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
    fireEvent.click(screen.getByRole("button", { name: /browse folders/i }));

    await waitFor(() => {
      expect(screen.getByText("my-local-app")).toBeDefined();
    });

    fireEvent.click(screen.getByText("my-local-app"));

    await waitFor(() => {
      expect(screen.getByTestId("local-repo-preview")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /add repository/i }));

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledWith({
        method: "local_checkout",
        name: "my-local-app",
        checkout_path: "/Users/test/my-local-app",
      });
      expect(screen.getByTestId("repository-added-step")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /open repository/i }));
    expect(handleSuccess).toHaveBeenCalled();
    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });

  test("validates clone link, shows cloning state, and cancels in-flight clone", async () => {
    vi.spyOn(client, "inspectRemoteRepository").mockResolvedValueOnce({
      inputUrl: "https://github.com/acme/console",
      valid: true,
      normalizedUrl: "https://github.com/acme/console",
      repoName: "acme/console",
      suggestedName: "console",
      defaultBranch: "main",
      destinationPath: "/Users/test/.animus/projects/console",
      destinationExists: false,
      alreadyEnrolled: false,
      existingProject: null,
      errorCode: null,
      errorMessage: null,
    });

    vi.spyOn(client, "startProjectClone").mockResolvedValueOnce({
      jobId: "clone_123",
      status: "cloning",
      phaseLabel: "Cloning repository…",
      destinationPath: "/Users/test/.animus/projects/console",
      repoName: "acme/console",
      project: null,
      errorCode: null,
      errorMessage: null,
    });

    const cancelSpy = vi.spyOn(client, "cancelProjectClone").mockResolvedValueOnce({
      jobId: "clone_123",
      status: "cancelled",
      phaseLabel: "Clone cancelled",
      destinationPath: "/Users/test/.animus/projects/console",
      repoName: "acme/console",
      project: null,
      errorCode: "clone_cancelled",
      errorMessage: "Clone was cancelled.",
    });

    render(<AddRepositoryModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);

    fireEvent.click(screen.getByText("Clone repository"));
    const input = screen.getByPlaceholderText("https://github.com/owner/repo");
    fireEvent.change(input, { target: { value: "https://github.com/acme/console" } });
    fireEvent.click(screen.getByRole("button", { name: /^validate$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("remote-repo-preview")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /clone repository/i }));

    await waitFor(() => {
      expect(screen.getByTestId("clone-progress-card")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /cancel clone/i }));

    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledWith("clone_123");
      expect(screen.getByText("Clone cancelled")).toBeDefined();
    });
  });

  test("creates local-only repository automatically in ~/.animus/projects", async () => {
    vi.spyOn(client, "browseDirectories").mockResolvedValueOnce({
      currentPath: "/Users/test",
      parentPath: "/Users",
      homePath: "/Users/test",
      projectsPath: "/Users/test/.animus/projects",
      entries: [],
      error: null,
    });

    const registerSpy = vi.spyOn(client, "registerProject").mockResolvedValueOnce({
      id: "proj-local-init",
      name: "my-agent-system",
      repo_id: 0,
      repo_name: "my-agent-system",
      checkout_path: "/Users/test/.animus/projects/my-agent-system",
      status: "active",
      status_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    render(<AddRepositoryModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);

    fireEvent.click(screen.getByText("Create new repo"));
    const nameInput = screen.getByPlaceholderText("my-agent-system");
    fireEvent.change(nameInput, { target: { value: "my-agent-system" } });
    fireEvent.click(screen.getByRole("button", { name: /create repository/i }));

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledWith({
        method: "local_init",
        name: "my-agent-system",
        default_branch: "main",
      });
      expect(screen.getByTestId("repository-added-step")).toBeDefined();
    });
  });
});
