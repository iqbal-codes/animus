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

/**
 * `Animus / Task card` (`ENO1O`) with the per-instance overrides from the
 * Kanban board. Every optional row below is a descendant the source enables or
 * disables per state; the header/footer defaults stay as authored.
 */
export function TaskCard({
  job,
  density = "comfortable",
  onOpen,
}: {
  job: TaskCardJob;
  density?: CardDensity;
  onOpen?: () => void;
}) {
  const ExecutionIcon = job.execution ? EXECUTION_ICONS[job.execution.icon] : null;

  return (
    <article
      data-job={job.ref}
      className={cn(
        "flex w-full flex-col rounded-[12px] border border-[var(--border-subtle)] bg-card",
        density === "compact" ? "gap-1.5 p-2.5" : "gap-2.5 p-3.5",
      )}
    >
      <div className="flex items-center gap-2">
        {ExecutionIcon && job.execution && (
          <ExecutionIcon
            aria-hidden="true"
            className={cn("size-3 shrink-0", INK_TEXT[job.execution.ink])}
          />
        )}
        <span className="font-mono text-[11px] leading-[1.45] text-text-secondary">{job.ref}</span>

        {job.repository && (
          <span className="flex h-6 items-center justify-center rounded-full border border-[var(--input)] bg-background px-2.5 text-[11px] leading-none font-medium text-foreground">
            {job.repository}
          </span>
        )}

        <span
          className={cn(
            "flex h-[18px] items-center justify-center rounded-full px-1.5 text-[11px] leading-none font-medium",
            SURFACE_BG[job.stage.surface],
            INK_TEXT[job.stage.ink],
          )}
        >
          {job.stage.label}
        </span>

        <span className="flex-1" />

        {job.pullRequest && (
          <span className={cn("text-[11px] leading-[1.45]", INK_TEXT[job.pullRequest.ink])}>
            {job.pullRequest.label}
          </span>
        )}
        {job.lap && (
          <span className="text-[11px] leading-[1.45] text-text-secondary">{job.lap}</span>
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
        <p className={cn("text-[11px] leading-[1.45]", INK_TEXT[job.summary.ink])}>
          {job.summary.text}
        </p>
      )}
      {job.detail && <p className="text-[11px] leading-[1.45] text-text-secondary">{job.detail}</p>}
      {job.timestamp && (
        <p className="text-[11px] leading-[1.45] text-text-secondary">{job.timestamp}</p>
      )}

      {job.action && (
        <button
          type="button"
          className={cn(
            "h-8 w-full rounded-full bg-secondary px-3 text-sm leading-[1.43] font-medium transition-colors hover:bg-secondary/80",
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
