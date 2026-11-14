import {
  CircleAlert,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  Pause,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type { ExecutionIcon, TaskCardJob } from "./jobs-model";
import { specProgressLabel } from "./jobs-model";
import { INK_TEXT, SURFACE_BG } from "./tone";
import type { CardDensity } from "@/lib/preferences";

const EXECUTION_ICONS: Record<ExecutionIcon, LucideIcon> = {
  "loader-circle": LoaderCircle,
  pause: Pause,
  "circle-alert": CircleAlert,
  "git-pull-request": GitPullRequest,
  "git-merge": GitMerge,
};

export type TaskCardProps = {
  job: TaskCardJob;
  density?: CardDensity;
  selected?: boolean;
  onOpen?: () => void;
};

/**
 * `Animus / Task card` (`ENO1O`) with the per-instance overrides from the
 * Kanban board. Every optional row below is a descendant the source enables or
 * disables per state; the header/footer defaults stay as authored.
 */
export function TaskCard({
  job,
  density = "comfortable",
  selected = false,
  onOpen,
}: TaskCardProps) {
  const ExecutionIcon = job.execution ? EXECUTION_ICONS[job.execution.icon] : null;

  return (
    <article
      data-job={job.ref}
      onClick={(e) => {
        if (!onOpen) return;
        if ((e.target as Element).closest("button, a")) return;
        onOpen();
      }}
      className={cn(
        "flex w-full flex-col rounded-[12px] border border-[var(--border-subtle)] bg-card",
        density === "compact" ? "gap-1.5 p-2.5" : "gap-2.5 p-3.5",
        onOpen &&
          "cursor-pointer transition-colors duration-150 ease-out hover:border-[var(--elevation-edge)] hover:bg-[var(--elevation-2-surface)]/50",
        selected &&
          "border-[var(--foreground)]/40 bg-[var(--elevation-2-surface)]/75 ring-1 ring-[var(--foreground)]/15",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {ExecutionIcon && job.execution && (
            <ExecutionIcon
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0",
                INK_TEXT[job.execution.ink],
                job.execution.icon === "loader-circle" && "animate-spin motion-reduce:animate-none",
              )}
            />
          )}
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="shrink-0 cursor-pointer font-mono text-[11px] leading-[1.45] text-text-secondary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              {job.ref}
            </button>
          ) : (
            <span className="shrink-0 font-mono text-[11px] leading-[1.45] text-text-secondary">
              {job.ref}
            </span>
          )}

          {job.repository && (
            <span className="flex h-6 items-center justify-center rounded-full border border-[var(--input)] bg-background px-2.5 text-[11px] leading-none font-medium text-foreground">
              {job.repository}
            </span>
          )}

          <span
            title={job.stage.label}
            className={cn(
              "inline-block max-w-[165px] truncate rounded-full px-1.5 py-[3px] text-[11px] leading-[12px] font-medium",
              SURFACE_BG[job.stage.surface],
              INK_TEXT[job.stage.ink],
            )}
          >
            {job.stage.label}
          </span>
        </div>

        {(job.pullRequest || job.lap) && (
          <div className="flex shrink-0 items-center gap-1.5">
            {job.pullRequest && (
              <span className={cn("text-[11px] leading-[1.45]", INK_TEXT[job.pullRequest.ink])}>
                {job.pullRequest.label}
              </span>
            )}
            {job.lap && (
              <span className="text-[11px] leading-[1.45] text-text-secondary">{job.lap}</span>
            )}
          </div>
        )}
      </div>

      <h3 className="text-sm leading-[1.45] font-medium text-foreground">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open details for ${job.ref} ${job.title}`}
            className="inline-flex min-h-11 items-center text-left underline-offset-2 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] sm:min-h-0"
          >
            {job.title}
          </button>
        ) : (
          job.title
        )}
      </h3>

      {(job.parentRef || job.specProgress) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {job.parentRef && (
            <span
              data-testid="card-parent"
              title={job.parentRef.title}
              className="inline-flex max-w-full items-center rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] leading-[1.4] text-text-secondary"
            >
              Part of #{job.parentRef.issueNumber}
            </span>
          )}
          {job.specProgress && (
            <span
              data-testid="card-spec-progress"
              className="inline-flex min-w-0 items-center text-[10px] leading-[1.4] text-text-secondary"
            >
              {specProgressLabel(job.specProgress)}
            </span>
          )}
        </div>
      )}

      {job.summary && (
        <p
          title={job.summary.text}
          className={cn("line-clamp-2 text-[11px] leading-[1.45]", INK_TEXT[job.summary.ink])}
        >
          {job.summary.text}
        </p>
      )}
      {job.detail && (
        <p
          title={job.detail}
          className="line-clamp-2 text-[11px] leading-[1.45] text-text-secondary"
        >
          {job.detail}
        </p>
      )}
      {job.timestamp && (
        <p className="text-[11px] leading-[1.45] text-text-secondary">{job.timestamp}</p>
      )}

      {job.action && (
        <button
          type="button"
          className={cn(
            "h-8 w-full rounded-full bg-secondary px-3 text-sm leading-[1.43] font-medium transition-[color,background-color,border-color,scale] duration-150 ease-out hover:bg-secondary/80 enabled:active:scale-[0.96] motion-reduce:transform-none",
            INK_TEXT[job.action.ink],
          )}
        >
          {job.action.label}
        </button>
      )}

      {job.metrics && (
        <div className="flex items-center gap-[5px] text-[11px] leading-[1.45] text-text-secondary">
          <span>{job.metrics.harness}</span>
          <span className="flex-1" />
          {job.metrics.lapSpend && <span className="font-mono">{job.metrics.lapSpend}</span>}
          {job.metrics.totalSpend && (
            <span className="text-xs leading-[1.45]">{job.metrics.totalSpend}</span>
          )}
        </div>
      )}
    </article>
  );
}
