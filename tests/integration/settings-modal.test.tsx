// @vitest-environment jsdom
import React from "react";
import { describe, expect, test, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SettingsModal } from "../../apps/web/src/features/settings/settings-modal";
import type { Preferences } from "../../apps/web/src/lib/preferences";
import type { Project } from "@animus/contracts/operator";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

const defaultPreferences: Preferences = {
  cardDensity: "comfortable",
  startupView: "inbox",
  notifyNeedsAttention: true,
  notifyFailedJobs: true,
};

const mockProjects: Project[] = [
  {
    id: "proj-1",
    name: "animus-core",
    repo_id: 101,
    repo_name: "efishery/animus-core",
    checkout_path: "/workspace/animus",
    status: "active",
    status_reason: null,
    created_at: new Date(1700000000).toISOString(),
    updated_at: new Date(1700000000).toISOString(),
  },
];

describe("SettingsModal Component (R5yIDY / vybWU / KanXI)", () => {
  test("renders navigation scopes (Personal, Platform, Project) and defaults to Personal Preferences", () => {
    const handleSave = vi.fn();
    const handleClose = vi.fn();

    render(
      <SettingsModal
        preferences={defaultPreferences}
        projects={mockProjects}
        onSave={handleSave}
        onClose={handleClose}
      />,
    );

    // Verify Scope buttons
    expect(screen.getByRole("button", { name: /Personal/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Platform/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Project/i })).toBeDefined();

    // Verify Default Preferences section is displayed
    expect(screen.getByText("Personal settings / Only you")).toBeDefined();
    expect(screen.getByText("Appearance")).toBeDefined();
    expect(screen.getByText("Navigation")).toBeDefined();
    expect(screen.getByText("Notifications")).toBeDefined();
  });

  test("navigates to Platform / System and eliminates technical 0600 / 0700 permissions", () => {
    const handleSave = vi.fn();
    const handleClose = vi.fn();

    render(
      <SettingsModal
        preferences={defaultPreferences}
        projects={mockProjects}
        onSave={handleSave}
        onClose={handleClose}
      />,
    );

    // Switch to Platform scope
    fireEvent.click(screen.getByRole("button", { name: /Platform/i }));

    // Click System section
    fireEvent.click(screen.getByRole("button", { name: /System/i }));

    // Check Header
    expect(screen.getByText("Platform settings / This installation")).toBeDefined();

    // Ensure NO "Permissions: 0600" or raw permission modes exist
    expect(screen.queryByText(/0600/i)).toBeNull();
    expect(screen.queryByText(/0700/i)).toBeNull();

    // Verify human-readable security and maintenance labels
    expect(screen.getByText("Remote access")).toBeDefined();
    expect(screen.getByText("Operator token")).toBeDefined();
    expect(screen.getByText(/Protected & Encrypted/i)).toBeDefined();
    expect(screen.getByText("Database backup")).toBeDefined();
    expect(screen.getByText("Reconcile commands")).toBeDefined();
    expect(screen.getByText("Engine host")).toBeDefined();
    expect(screen.getByText(/Isolated sandbox/i)).toBeDefined();
  });

  test("navigates to Platform / Providers and displays detected harnesses", () => {
    const handleSave = vi.fn();
    const handleClose = vi.fn();

    render(
      <SettingsModal
        preferences={defaultPreferences}
        projects={mockProjects}
        onSave={handleSave}
        onClose={handleClose}
      />,
    );

    // Switch to Platform scope
    fireEvent.click(screen.getByRole("button", { name: /Platform/i }));

    // Click Providers section
    fireEvent.click(screen.getByRole("button", { name: /Providers/i }));

    // Verify Providers Content
    expect(screen.getByText("Platform defaults")).toBeDefined();
    expect(screen.getByText("Pi Coding Agent")).toBeDefined();
    expect(screen.getByText("Claude Code")).toBeDefined();
    expect(screen.getByText("Oh-My-Pi (OMP)")).toBeDefined();
    expect(screen.getByText("OpenAI Codex CLI")).toBeDefined();
  });

  test("navigates to Project scope and shows project selector and project sections", () => {
    const handleSave = vi.fn();
    const handleClose = vi.fn();
    const handleSelectProject = vi.fn();

    render(
      <SettingsModal
        preferences={defaultPreferences}
        projects={mockProjects}
        currentProjectId="proj-1"
        onSelectProject={handleSelectProject}
        onSave={handleSave}
        onClose={handleClose}
      />,
    );

    // Switch to Project scope
    fireEvent.click(screen.getByRole("button", { name: /Project/i }));

    // Verify Project Scope is active with project picker
    expect(screen.getByText("Project settings / efishery/animus-core")).toBeDefined();

    // Check project sections: Models, Checks, Memory, Releases
    expect(screen.getByRole("button", { name: /Models/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Checks/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Memory/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Releases/i })).toBeDefined();
  });

  test("navigates to Project / Memory and displays lessons with veto capability", () => {
    const handleSave = vi.fn();
    const handleClose = vi.fn();

    render(
      <SettingsModal
        preferences={defaultPreferences}
        projects={mockProjects}
        currentProjectId="proj-1"
        onSave={handleSave}
        onClose={handleClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project/i }));
    fireEvent.click(screen.getByRole("button", { name: /Memory/i }));

    expect(screen.getByText("Harness memory governance")).toBeDefined();
    expect(screen.getByText("Evidence-backed lessons")).toBeDefined();
    expect(screen.getByText("Monitor lock recovery")).toBeDefined();
    expect(screen.getByText("SQLite busy timeout")).toBeDefined();
    expect(screen.getByText("VETOED")).toBeDefined();
  });

  test("saves preferences and closes modal when Save changes is clicked", () => {
    const handleSave = vi.fn();
    const handleClose = vi.fn();

    render(
      <SettingsModal preferences={defaultPreferences} onSave={handleSave} onClose={handleClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(handleSave).toHaveBeenCalledTimes(1);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
