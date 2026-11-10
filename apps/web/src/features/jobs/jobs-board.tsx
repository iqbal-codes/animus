import { useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { JobsBoardModel } from "./jobs-model";
import { HEALTH, type BackendState } from "./factory-status";
import { KanbanLane } from "./kanban-lane";
import { KpiCard } from "./kpi-card";
import type { CardDensity } from "@/lib/preferences";

/**
 * Jobs content (`QaoKo`): KPI row, board toolbar, horizontally scrolled lanes
 * with a 5 px custom scrollbar, and the factory status footer.
 */
export function JobsBoard({
  board,
  backendState,
  density,
  loading = false,
  error = null,
  onRefresh,
  onOpenWork,
}: {
  board: JobsBoardModel;
  backendState: BackendState;
  density?: CardDensity;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  onOpenWork?: (workId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ thumb: 1, progress: 0 });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth;
      setScroll({
        thumb: el.scrollWidth > 0 ? el.clientWidth / el.scrollWidth : 1,
        progress: max > 0 ? el.scrollLeft / max : 0,
      });
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, []);

  const dragThumb = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const thumb = event.currentTarget;
    const startX = event.clientX;
    const startScroll = el.scrollLeft;
    const travel = track.clientWidth - thumb.clientWidth;
    if (travel <= 0) return;
    const max = el.scrollWidth - el.clientWidth;

    const move = (moveEvent: PointerEvent) => {
      el.scrollLeft = startScroll + ((moveEvent.clientX - startX) / travel) * max;
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const needle = query.trim().toLowerCase();
  const health = HEALTH[backendState];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[26px] pt-7 pb-5">
      {(loading || error) && (
        <div className="mx-7 flex flex-wrap items-center gap-3 rounded-[10px] border border-[var(--border-subtle)] px-3 py-2">
          {loading ? (
            <p role="status" data-testid="board-loading" className="text-xs text-text-secondary">
              Loading the project board from canonical factory state…
            </p>
          ) : (
            <>
              <p
                role="alert"
                data-testid="board-error"
                className="min-w-0 break-words text-xs text-[var(--error)]"
              >
                Board unavailable: {error}
              </p>
              {onRefresh && (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  onClick={onRefresh}
                >
                  Retry
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {board.totalJobs === 0 && !loading && !error && (
        <p data-testid="board-empty" className="sr-only">
          No work is recorded for this project yet. Import and approve a plan to populate the
          existing columns.
        </p>
      )}

      <div className="grid shrink-0 grid-cols-2 items-stretch gap-3 px-7 sm:grid-cols-5">
        {board.kpis.map((kpi) => (
          <KpiCard key={kpi.label} kpi={kpi} />
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-3 px-7">
          <h2 className="text-sm leading-[1.45] font-medium text-foreground">All jobs</h2>
          <span className="text-xs leading-[1.45] text-text-muted">{board.totalJobs}</span>
          <span className="flex-1" />

          <div
            data-focus-ring="container"
            className="flex h-8 w-52 items-center justify-between rounded-full border border-[var(--border)] px-3 transition-colors focus-within:border-[var(--ring)]"
          >
            <label className="flex min-w-0 items-center gap-2">
              <Search aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search jobs"
                placeholder="Search jobs…"
                className="w-full min-w-0 bg-transparent text-xs leading-[1.45] text-foreground outline-none placeholder:text-text-muted"
              />
            </label>
            <span className="shrink-0 text-[10px] leading-[1.45] text-text-muted">⌘ K</span>
          </div>

          <button
            type="button"
            disabled
            title="Job filters are not implemented yet"
            className="flex items-center gap-[7px] px-[10px] py-[7px] disabled:cursor-default disabled:opacity-50"
          >
            <SlidersHorizontal
              aria-hidden="true"
              className="size-3.5 shrink-0 text-text-secondary"
            />
            <span className="text-xs leading-[1.45] text-text-secondary">Filter</span>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-0.5">
          <div
            ref={viewportRef}
            className="min-h-0 flex-1 overflow-x-auto overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="flex w-max min-h-full items-start gap-4 px-7">
              {board.lanes.map((lane) => {
                const cards = needle
                  ? lane.cards.filter((job) =>
                      `${job.ref} ${job.title}`.toLowerCase().includes(needle),
                    )
                  : lane.cards;
                return (
                  <KanbanLane
                    key={lane.id}
                    lane={lane}
                    cards={cards}
                    density={density}
                    onOpenWork={onOpenWork}
                  />
                );
              })}
            </div>
          </div>

          <div
            ref={trackRef}
            aria-hidden="true"
            className="h-[5px] shrink-0 overflow-hidden rounded-full bg-white/[0.04]"
          >
            <div
              onPointerDown={dragThumb}
              style={{
                width: `${scroll.thumb * 100}%`,
                transform: `translateX(${(scroll.progress * (1 - scroll.thumb) * 100) / Math.max(scroll.thumb, 0.001)}%)`,
              }}
              className="h-full touch-none rounded-full bg-white/25"
            />
          </div>

          <div className="flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-subtle)] px-7 pt-2">
            <span className="flex items-center gap-1.5">
              <span className={cn("size-[5px] rounded-full", health.dot)} />
              <span className="text-[10px] leading-[1.45] text-text-muted">{health.label}</span>
            </span>
            <span className="text-[10px] leading-[1.45] text-text-muted">{board.freshness}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
