import { Bell, ChevronDown, Columns3, List, LoaderCircle, Pause, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import type { JobsBoardModel } from "./jobs-model";

/** GitHub mark: lucide dropped brand glyphs, so the source icon is inlined. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Jobs header (`CPB4j`): 76 high, 28 side inset, 20 gap. Title, repository pill,
 * view-mode segmented control, factory-state toggle, notifications, New job.
 */
export function JobsHeader({
  board,
  title = "Jobs",
  showViewMode = true,
  showNotifications = true,
}: {
  board: JobsBoardModel;
  title?: string;
  showViewMode?: boolean;
  showNotifications?: boolean;
}) {
  const { state } = useSidebar();

  return (
    <header className="flex h-[76px] shrink-0 items-center gap-5 border-b border-[var(--border-subtle)] px-7">
      {state === "collapsed" && <SidebarTrigger className="-ml-2" />}

      <h1 className="text-[20px] leading-[1.4] font-medium text-foreground">{title}</h1>

      <button
        type="button"
        disabled
        title="Repository picker arrives with the Repositories screens"
        className="flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-[9px] disabled:cursor-default disabled:opacity-100"
      >
        <GithubMark className="size-4 shrink-0 text-foreground" />
        <span className="text-xs leading-[1.4] text-foreground">{board.repository}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-text-secondary" />
      </button>

      <span className="flex-1" />

      {showViewMode && (
        <div
          role="group"
          aria-label="Job view"
          className="flex h-9 items-center gap-1 rounded-[10px] border border-[var(--border-subtle)] bg-muted p-[3px]"
        >
          <button
            type="button"
            disabled
            title="List view is not implemented yet"
            className="flex h-[30px] items-center gap-[7px] rounded-[6px] px-[11px] text-xs leading-[1.4] text-text-secondary disabled:cursor-default disabled:opacity-50"
          >
            <List aria-hidden="true" className="size-3.5 shrink-0" />
            <span>List</span>
          </button>
          <button
            type="button"
            aria-pressed="true"
            className="flex h-[30px] items-center gap-[7px] rounded-[6px] bg-secondary px-[11px] text-xs leading-[1.4] text-foreground"
          >
            <Columns3 aria-hidden="true" className="size-3.5 shrink-0" />
            <span>Kanban</span>
          </button>
        </div>
      )}

      <div
        role="group"
        aria-label="Factory state"
        className="flex h-9 items-center gap-1 rounded-[10px] border border-[var(--border)] bg-muted p-[3px]"
      >
        <button
          type="button"
          aria-pressed="true"
          className="flex h-[30px] items-center gap-[5px] rounded-[6px] bg-secondary px-2 py-[5px]"
        >
          <LoaderCircle
            aria-hidden="true"
            className="size-[11px] shrink-0 animate-spin text-accent motion-reduce:animate-none"
          />
          <span className="text-[11.5px] leading-[1.2] font-medium text-foreground">Running</span>
        </button>
        <button
          type="button"
          disabled
          title="Paused jobs are not wired yet"
          className="flex h-[30px] items-center gap-[5px] rounded-[6px] px-2 py-[5px] disabled:cursor-default disabled:opacity-50"
        >
          <Pause aria-hidden="true" className="size-[11px] shrink-0 text-text-secondary" />
          <span className="text-[11.5px] leading-[1.2] text-text-secondary">Paused</span>
        </button>
        <button
          type="button"
          disabled
          title="Stopped jobs are not wired yet"
          className="flex h-[30px] items-center gap-[5px] rounded-[6px] px-2 py-[5px] disabled:cursor-default disabled:opacity-50"
        >
          <Square aria-hidden="true" className="size-[11px] shrink-0 text-text-secondary" />
          <span className="text-[11.5px] leading-[1.2] text-text-secondary">Stopped</span>
        </button>
      </div>

      {showNotifications && (
        <button
          type="button"
          aria-label="Notifications, 2 unread"
          title="Notifications, 2 unread"
          className="flex items-center px-1 py-2 text-foreground transition-colors hover:text-text-secondary"
        >
          <Bell aria-hidden="true" className="size-[18px]" />
        </button>
      )}

      <Button size="default" title="New job arrives with the job creation flow" disabled>
        New job
        <ChevronDown aria-hidden="true" className="size-5 shrink-0" />
      </Button>
    </header>
  );
}
