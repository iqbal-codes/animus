import React, { useCallback, useEffect, useState } from "react";
import type { Health } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { AppSidebar, type NavId } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { JobsScreen } from "@/features/jobs/jobs-screen";
import { InboxScreen } from "@/features/inbox/inbox-screen";
import { DraftsScreen } from "@/features/drafts/drafts-screen";
import { SettingsModal } from "@/features/settings/settings-modal";
import { JOBS_BOARD, selectInbox } from "@/features/jobs/jobs-model";
import type { BackendState } from "@/features/jobs/factory-status";
import { loadPreferences, savePreferences, type Preferences } from "@/lib/preferences";

const SHELL_STYLE = {
  "--sidebar-width": "15rem",
  "--sidebar-width-icon": "4rem",
} as React.CSSProperties;

export function App() {
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences);
  const [tab, setTab] = useState<NavId>(preferences.startupView);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);

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

  const inboxItems = selectInbox(JOBS_BOARD, { includeFailed: preferences.notifyFailedJobs });

  const handleSave = (next: Preferences) => {
    savePreferences(next);
    setPreferences(next);
  };

  return (
    <SidebarProvider style={SHELL_STYLE} className="bg-background text-foreground antialiased">
      <TooltipProvider>
        <div className="contents" inert={settingsOpen ? true : undefined}>
          <AppSidebar
            activeId={tab}
            onSelect={setTab}
            jobCount={JOBS_BOARD.totalJobs}
            inboxCount={preferences.notifyNeedsAttention ? inboxItems.length : undefined}
            settingsOpen={settingsOpen}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          <SidebarInset className="min-w-0">
            {tab === "inbox" && (
              <InboxScreen
                board={JOBS_BOARD}
                backendState={backendState}
                includeFailed={preferences.notifyFailedJobs}
                onOpenJobs={() => setTab("jobs")}
              />
            )}
            {tab === "jobs" && (
              <JobsScreen
                board={JOBS_BOARD}
                backendState={backendState}
                density={preferences.cardDensity}
              />
            )}
            {tab === "drafts" && <DraftsScreen />}
          </SidebarInset>
        </div>

        {settingsOpen && (
          <SettingsModal
            preferences={preferences}
            onSave={handleSave}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </TooltipProvider>
    </SidebarProvider>
  );
}
