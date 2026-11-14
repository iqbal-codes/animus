import {
  CircleAlert,
  CircleDashed,
  Code,
  GitMerge,
  GitPullRequest,
  Inbox,
  Pause,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type { KanbanLaneModel, LaneIcon, TaskCardJob } from "./jobs-model";
import type { CardDensity } from "@/lib/preferences";
import { INK_TEXT } from "./tone";
import { TaskCard } from "./task-card";

const LANE_ICONS: Record<LaneIcon, LucideIcon> = {
  inbox: Inbox,
  "circle-dashed": CircleDashed,
  code: Code,
  "git-pull-request": GitPullRequest,
  "circle-alert": CircleAlert,
  pause: Pause,
  "git-merge": GitMerge,
};

/** One Kanban column: 288 wide, 12 gap, hairline heading rule, stacked task cards. */
export function KanbanLane({
  lane,
  cards,
  density,
  selectedWorkId,
  onOpenWork,
}: {
  lane: KanbanLaneModel;
  cards: TaskCardJob[];
  density?: CardDensity;
  selectedWorkId?: string | null;
  onOpenWork?: (workId: string) => void;
}) {
  const Icon = LANE_ICONS[lane.icon];

  return (
    <section aria-label={lane.title} className="flex w-[288px] shrink-0 flex-col gap-3">
      <header className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-[var(--border-subtle)] bg-background px-0.5 pt-1 pb-2.5">
        <div className="flex items-center gap-2">
          <Icon aria-hidden="true" className={cn("size-[15px] shrink-0", INK_TEXT[lane.iconInk])} />
          <h2 className="text-[13px] leading-[1.45] font-medium text-foreground">{lane.title}</h2>
          <span className="rounded-full bg-[var(--elevation-2-surface)] px-1.5 py-0.5 font-mono text-[11px] leading-[14px] text-text-secondary tabular-nums">
            {lane.count}
          </span>
        </div>
      </header>

      {cards.length === 0 ? (
        <div className="flex min-h-[140px] items-center justify-center rounded-[12px] border border-dashed border-[var(--border-subtle)] p-4 text-center">
          <span className="text-[11px] leading-[1.45] text-text-muted">
            No jobs in {lane.title.toLowerCase()}
          </span>
        </div>
      ) : (
        cards.map((job) => (
          <TaskCard
            key={job.id}
            job={job}
            density={density}
            selected={Boolean(selectedWorkId && job.workId === selectedWorkId)}
            onOpen={job.workId && onOpenWork ? () => onOpenWork(job.workId!) : undefined}
          />
        ))
      )}
    </section>
  );
}
