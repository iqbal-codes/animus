import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, LoaderCircle, Pause, Plus, Square } from "lucide-react";
import type { FactoryEngineMode, FactoryEngineState, Project } from "@animus/contracts/operator";
import { cn } from "cn";
import { client } from "@/lib/factory-client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { RepositorySelector } from "@/features/projects/repository-selector";
import type { JobsBoardModel } from "./jobs-model";
import { NewJobModal } from "./new-job-modal";

/** GitHub mark: lucide dropped brand glyphs, so the source icon is inlined. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Shared surface header (`CPB4j`): 76 high, 28 side inset, 20 gap.
 * Title, repository selector (with "All repositories" support), global
 * 3-state Animus engine control (Running / Paused / Stopped), and New job.
 */
export function JobsHeader({
  board,
  title = "Jobs",
  projects,
  currentProjectId,
  onSelectProject,
  onProjectAdded,
  onRefresh,
  factory = client,
}: {
  board: JobsBoardModel;
  title?: string;
  projects?: Project[];
  currentProjectId?: string | null;
  onSelectProject?: (projectId: string) => void;
  onProjectAdded?: (project: Project) => void;
  onRefresh?: () => void;
  factory?: typeof client;
}) {
  const { state, isMobile } = useSidebar();
  const [engineState, setEngineState] = useState<FactoryEngineState | null>(null);
  const [engineBusy, setEngineBusy] = useState<FactoryEngineMode | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [newJobOpen, setNewJobOpen] = useState(false);

  const selectableProjects = useMemo(
    () => (projects ?? []).filter((project) => project.status !== "tombstone"),
    [projects],
  );

  const loadEngineState = useCallback(async () => {
    if (typeof factory?.engineState !== "function") return;
    try {
      const next = await factory.engineState();
      setEngineState(next);
    } catch {
      // Isolated UI tests and offline renders may mount without an active backend.
    }
  }, [factory]);

  useEffect(() => {
    void loadEngineState();
  }, [loadEngineState]);

  const currentMode: FactoryEngineMode = engineState?.mode ?? "running";

  const applyEngineMode = async (mode: FactoryEngineMode) => {
    if (typeof factory?.setEngineState !== "function") return;
    setEngineBusy(mode);
    setEngineError(null);
    try {
      const next = await factory.setEngineState({ mode, actor: "operator" });
      setEngineState(next);
      onRefresh?.();
    } catch (err) {
      setEngineError(err instanceof Error ? err.message : String(err));
    } finally {
      setEngineBusy(null);
    }
  };

  const handleEngineClick = (mode: FactoryEngineMode) => {
    if (engineBusy !== null || mode === currentMode) return;
    if (mode === "stopped") {
      void loadEngineState();
      setStopConfirmOpen(true);
      return;
    }
    void applyEngineMode(mode);
  };

  const activeRuns = engineState?.active_runs ?? 0;

  return (
    <>
      <header className="flex min-h-[76px] shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] px-7 py-3 sm:gap-5">
        {(isMobile || state === "collapsed") && <SidebarTrigger className="-ml-2" />}

        <h1 className="text-[20px] leading-[1.4] font-medium text-foreground">{title}</h1>

        {onSelectProject ? (
          <RepositorySelector
            currentRepository={board.repository}
            currentProjectId={currentProjectId}
            projects={projects ?? []}
            allowAll
            onSelectProject={onSelectProject}
            onProjectAdded={onProjectAdded}
          />
        ) : (
          <button
            type="button"
            disabled
            title="Repository picker unavailable"
            className="flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-[9px] disabled:cursor-default disabled:opacity-100"
          >
            <GithubMark className="size-4 shrink-0 text-foreground" />
            <span className="text-xs leading-[1.4] text-foreground">{board.repository}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-text-secondary" />
          </button>
        )}

        <span className="flex-1" />

        {engineError && (
          <span role="alert" className="text-[11px] text-[var(--error)]">
            {engineError}
          </span>
        )}

        <div
          role="group"
          aria-label="Factory state"
          className="flex h-9 items-center gap-1 rounded-[10px] border border-[var(--border)] bg-muted p-[3px]"
        >
          <button
            type="button"
            aria-pressed={currentMode === "running"}
            disabled={engineBusy !== null}
            onClick={() => handleEngineClick("running")}
            title="Resume automated triage, dispatch, and execution"
            className={cn(
              "flex h-[30px] items-center gap-[5px] rounded-[6px] px-2 py-[5px] transition-colors disabled:opacity-60",
              currentMode === "running"
                ? "bg-secondary text-foreground"
                : "text-text-secondary hover:text-foreground",
            )}
          >
            <LoaderCircle
              aria-hidden="true"
              className={cn(
                "size-[11px] shrink-0",
                currentMode === "running"
                  ? "animate-spin text-accent motion-reduce:animate-none"
                  : "text-text-secondary",
              )}
            />
            <span
              className={cn(
                "text-[11.5px] leading-[1.2]",
                currentMode === "running" ? "font-medium text-foreground" : "text-text-secondary",
              )}
            >
              Running
            </span>
          </button>

          <button
            type="button"
            aria-pressed={currentMode === "paused"}
            disabled={engineBusy !== null}
            onClick={() => handleEngineClick("paused")}
            title="Pause scheduled work; active AI runs finish cleanly"
            className={cn(
              "flex h-[30px] items-center gap-[5px] rounded-[6px] px-2 py-[5px] transition-colors disabled:opacity-60",
              currentMode === "paused"
                ? "bg-secondary text-foreground"
                : "text-text-secondary hover:text-foreground",
            )}
          >
            <Pause
              aria-hidden="true"
              className={cn(
                "size-[11px] shrink-0",
                currentMode === "paused" ? "text-[var(--warning)]" : "text-text-secondary",
              )}
            />
            <span
              className={cn(
                "text-[11.5px] leading-[1.2]",
                currentMode === "paused" ? "font-medium text-foreground" : "text-text-secondary",
              )}
            >
              Paused
            </span>
          </button>

          <button
            type="button"
            aria-pressed={currentMode === "stopped"}
            disabled={engineBusy !== null}
            onClick={() => handleEngineClick("stopped")}
            title="Emergency stop: freeze all launches and terminate active AI runs"
            className={cn(
              "flex h-[30px] items-center gap-[5px] rounded-[6px] px-2 py-[5px] transition-colors disabled:opacity-60",
              currentMode === "stopped"
                ? "bg-secondary text-foreground"
                : "text-text-secondary hover:text-foreground",
            )}
          >
            <Square
              aria-hidden="true"
              className={cn(
                "size-[11px] shrink-0",
                currentMode === "stopped" ? "text-[var(--error)]" : "text-text-secondary",
              )}
            />
            <span
              className={cn(
                "text-[11.5px] leading-[1.2]",
                currentMode === "stopped" ? "font-medium text-foreground" : "text-text-secondary",
              )}
            >
              Stopped
            </span>
          </button>
        </div>

        <Button
          size="default"
          disabled={selectableProjects.length === 0}
          title={
            selectableProjects.length === 0
              ? "Add a repository before creating a job"
              : "Create a new job in the backlog"
          }
          onClick={() => setNewJobOpen(true)}
        >
          <Plus aria-hidden="true" className="size-4 shrink-0" />
          New job
        </Button>
      </header>

      <AlertDialog open={stopConfirmOpen} onOpenChange={setStopConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop Animus engine?</AlertDialogTitle>
            <AlertDialogDescription>
              {activeRuns > 0
                ? `This will freeze all scheduled and manual launches across every repository and send SIGTERM to ${activeRuns} active AI ${activeRuns === 1 ? "run" : "runs"}.`
                : "This will freeze all scheduled and manual launches across every repository until you switch back to Running."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setStopConfirmOpen(false);
                void applyEngineMode("stopped");
              }}
            >
              Stop factory
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <NewJobModal
        open={newJobOpen}
        onOpenChange={setNewJobOpen}
        projects={projects ?? []}
        currentProjectId={currentProjectId}
        factory={factory}
        onCreated={() => onRefresh?.()}
      />
    </>
  );
}
