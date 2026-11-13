import React, { useCallback, useEffect, useState } from "react";
import type { Health } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { AppSidebar, type NavId } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { JobsScreen } from "@/features/jobs/jobs-screen";
import { InboxScreen } from "@/features/inbox/inbox-screen";
import { SettingsModal } from "@/features/settings/settings-modal";
import type { Scope, SectionId } from "@/features/settings/settings-types";
import {
  ALL_PROJECTS_ID,
  emptyBoard,
  mapOperatorBoard,
  mergeOperatorBoards,
  selectInbox,
} from "@/features/jobs/jobs-model";
import { useOperatorBoard } from "@/features/jobs/use-board";
import type { BackendState } from "@/features/jobs/factory-status";
import { loadPreferences, savePreferences, type Preferences } from "@/lib/preferences";

const SHELL_STYLE = {
  "--sidebar-width": "15rem",
  "--sidebar-width-icon": "4rem",
} as React.CSSProperties;

export function App() {
  const query = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const initialSettingsOpen = query?.get("settings") === "true";
  const initialScope = (query?.get("scope") as Scope) || undefined;
  const initialSection = (query?.get("section") as SectionId) || undefined;
  const initialTab = (query?.get("tab") as NavId) || undefined;

  const [preferences, setPreferences] = useState<Preferences>(loadPreferences);
  const [tab, setTab] = useState<NavId>(initialTab || preferences.startupView);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const { state: boardState, projectId, projects, reload, selectProject } = useOperatorBoard();

  const checkHealth = useCallback(async () => {
    try {
      setHealth(await client.health());
    } catch {
      setHealth(null);
    } finally {
      setHealthChecked(true);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const backendState: BackendState = health
    ? "connected"
    : healthChecked
      ? "disconnected"
      : "connecting";

  const board =
    boardState.phase === "ready"
      ? projectId === ALL_PROJECTS_ID
        ? mergeOperatorBoards(boardState.boards)
        : boardState.board
          ? mapOperatorBoard(boardState.board)
          : emptyBoard()
      : emptyBoard();
  const boardLoading = boardState.phase === "loading";
  const boardError = boardState.phase === "error" ? boardState.message : null;
  const inboxItems = selectInbox(board, { includeFailed: preferences.notifyFailedJobs });

  const handleSave = (next: Preferences) => {
    savePreferences(next);
    setPreferences(next);
  };

  return (
    <SidebarProvider
      style={SHELL_STYLE}
      className="h-svh overflow-hidden bg-background text-foreground antialiased"
    >
      <TooltipProvider>
        <div className="contents" inert={settingsOpen ? true : undefined}>
          <AppSidebar
            activeId={tab}
            onSelect={setTab}
            jobCount={board.totalJobs}
            inboxCount={preferences.notifyNeedsAttention ? inboxItems.length : undefined}
            settingsOpen={settingsOpen}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
            {tab === "inbox" && (
              <InboxScreen
                board={board}
                backendState={backendState}
                includeFailed={preferences.notifyFailedJobs}
                projectId={projectId}
                projects={projects}
                onSelectProject={(id) => void selectProject(id)}
                loading={boardLoading}
                error={boardError}
                onRefresh={() => void reload()}
                onOpenJobs={() => setTab("jobs")}
              />
            )}
            {tab === "jobs" && (
              <JobsScreen
                board={board}
                backendState={backendState}
                density={preferences.cardDensity}
                projectId={projectId}
                projects={projects}
                onSelectProject={(id) => void selectProject(id)}
                loading={boardLoading}
                error={boardError}
                onRefresh={() => void reload()}
              />
            )}
          </SidebarInset>
        </div>

        {settingsOpen && (
          <SettingsModal
            preferences={preferences}
            projects={projects}
            currentProjectId={projectId}
            initialScope={initialScope}
            initialSection={initialSection}
            onSelectProject={(id) => void selectProject(id)}
            onSave={handleSave}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </TooltipProvider>
    </SidebarProvider>
  );
}
