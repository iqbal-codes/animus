import React, { useEffect, useState, useCallback } from "react";
import type { ProjectList } from "@labq/contracts/operator";
import { client } from "@/lib/factory-client";
import { ProjectList as ProjectListView } from "@/features/projects/project-list";
import { ProjectDetail } from "@/features/projects/project-detail";
import { OperationsView } from "@/features/operations/operations-view";
import { FolderGit2, Cpu } from "lucide-react";

export function App() {
  const [tab, setTab] = useState<"projects" | "operations">("projects");
  const [projects, setProjects] = useState<ProjectList>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isBackendHealthy, setIsBackendHealthy] = useState<boolean | null>(null);

  const fetchProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await client.projects();
      setProjects(data);
      if (data.length > 0 && !selectedProjectId) {
        setSelectedProjectId(data[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [selectedProjectId]);

  const checkHealth = useCallback(async () => {
    try {
      const res = await client.health();
      setIsBackendHealthy(res.status === "healthy");
    } catch {
      setIsBackendHealthy(false);
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
    void checkHealth();
  }, [fetchProjects, checkHealth]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;

  return (
    <div className="min-h-screen flex flex-col bg-[#0A0A0A] text-[#EDEDED] font-sans antialiased">
      {/* Top Console Navigation Bar */}
      <header className="border-b border-[var(--border)] bg-[#121316] sticky top-0 z-20 px-4 md:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-base font-bold text-[var(--foreground)] tracking-tight">
                labq<span className="text-[var(--accent)] font-normal">/</span>factory
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-[#1A1A1A] border border-[var(--border)] text-[var(--muted-foreground)] font-mono">
                console
              </span>
            </div>

            <nav className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setTab("projects")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  tab === "projects"
                    ? "bg-[#1F2228] text-[var(--foreground)]"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[#1A1A1A]",
                )}
                aria-current={tab === "projects" ? "page" : undefined}
              >
                <FolderGit2 className="h-3.5 w-3.5" />
                <span>Projects</span>
              </button>
              <button
                type="button"
                onClick={() => setTab("operations")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  tab === "operations"
                    ? "bg-[#1F2228] text-[var(--foreground)]"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[#1A1A1A]",
                )}
                aria-current={tab === "operations" ? "page" : undefined}
              >
                <Cpu className="h-3.5 w-3.5" />
                <span>Operations</span>
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <div
              className="flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded bg-[#1A1A1A] border border-[var(--border)]"
              title={
                isBackendHealthy === true
                  ? "Backend connected on loopback origin"
                  : isBackendHealthy === false
                    ? "Backend link unreachable"
                    : "Checking backend link..."
              }
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  isBackendHealthy === true
                    ? "bg-emerald-500"
                    : isBackendHealthy === false
                      ? "bg-red-500"
                      : "bg-amber-500 animate-pulse",
                )}
              />
              <span className="text-[var(--muted-foreground)]">
                {isBackendHealthy === true
                  ? "Connected"
                  : isBackendHealthy === false
                    ? "Disconnected"
                    : "Connecting"}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-8 space-y-6">
        {tab === "projects" ? (
          <div className="space-y-6">
            <ProjectListView
              projects={projects}
              selectedProjectId={selectedProjectId}
              onSelectProject={(id) => setSelectedProjectId(id)}
              isLoading={isLoading}
              error={error}
              onRefresh={fetchProjects}
            />

            {selectedProject && (
              <ProjectDetail project={selectedProject} onClose={() => setSelectedProjectId(null)} />
            )}
          </div>
        ) : (
          <OperationsView />
        )}
      </main>

      {/* Footer Bar */}
      <footer className="border-t border-[var(--border)] bg-[#0E0F12] px-4 md:px-8 py-3 text-xs text-[var(--muted-foreground)] font-mono">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-2">
          <span>Software Factory local-first console</span>
          <span>Single-origin loopback: 127.0.0.1</span>
        </div>
      </footer>
    </div>
  );
}

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

export default App;
