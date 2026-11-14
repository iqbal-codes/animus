import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  CircleX,
  FileText,
  GitPullRequest,
  Info,
  Maximize2,
  MessageCircle,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import { cn } from "cn";
import type { Project } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { JobsHeader } from "@/features/jobs/jobs-header";
import { HEALTH, type BackendState } from "@/features/jobs/factory-status";
import {
  INBOX_KIND_LABEL,
  selectInbox,
  type InboxItem,
  type InboxKind,
  type JobsBoardModel,
} from "@/features/jobs/jobs-model";
import { INK_TEXT } from "@/features/jobs/tone";

const ATTENTION_ICON = {
  "message-circle": MessageCircle,
  "file-text": FileText,
  "circle-x": CircleX,
  "git-pull-request": GitPullRequest,
} as const;

/**
 * Ink per attention kind, observed in `Ht4rv`: clarification and review events
 * are warning-toned, failures are error-toned.
 */
const KIND_INK: Record<InboxKind, string> = {
  clarification: "text-[var(--warning)]",
  review: "text-[var(--warning)]",
  failed: "text-[var(--error)]",
};

const KIND_BADGE: Record<InboxKind, string> = {
  clarification: "bg-[var(--warning-bg)] text-[var(--warning)]",
  review: "bg-[var(--warning-bg)] text-[var(--warning)]",
  failed: "bg-[var(--error-bg)] text-[var(--error)]",
};

const FILTERS: { id: "all" | InboxKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "clarification", label: INBOX_KIND_LABEL.clarification },
  { id: "review", label: INBOX_KIND_LABEL.review },
  { id: "failed", label: INBOX_KIND_LABEL.failed },
];

/**
 * Inbox (`Ht4rv`, "Animus / Inbox / Needs attention"): the attention queue on
 * the left and the selected issue on the right. Reading an item never resolves
 * it, so selection only changes what the detail pane shows.
 */
export function InboxScreen({
  board,
  backendState,
  includeFailed,
  projectId = null,
  projects,
  onSelectProject,
  onOpenJobs,
  loading = false,
  error = null,
  onRefresh,
  factory = client,
}: {
  board: JobsBoardModel;
  backendState: BackendState;
  includeFailed: boolean;
  projectId?: string | null;
  projects?: Project[];
  onSelectProject?: (projectId: string) => void;
  onOpenJobs: () => void;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  factory?: typeof client;
}) {
  const items = useMemo(() => selectInbox(board, { includeFailed }), [board, includeFailed]);
  const [filter, setFilter] = useState<"all" | InboxKind>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => selectInbox(board, { includeFailed })[0]?.job.id ?? null,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const base: Record<"all" | InboxKind, number> = {
      all: items.length,
      clarification: 0,
      review: 0,
      failed: 0,
    };
    for (const item of items) base[item.kind] += 1;
    return base;
  }, [items]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (filter !== "all" && item.kind !== filter) return false;
        if (!needle) return true;
        return `${item.job.ref} ${item.job.title} ${item.reason} ${item.context ?? ""}`
          .toLowerCase()
          .includes(needle);
      }),
    [items, filter, needle],
  );

  const selected = visible.find((item) => item.job.id === selectedId) ?? null;
  const health = HEALTH[backendState];
  const updates = board.lanes.find((lane) => lane.id === "merged")?.count ?? 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const move = (delta: number) => {
    if (visible.length === 0) return;
    const index = visible.findIndex((item) => item.job.id === selectedId);
    const next = index === -1 ? 0 : Math.min(Math.max(index + delta, 0), visible.length - 1);
    setSelectedId(visible[next].job.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <JobsHeader
        board={board}
        title="Inbox"
        projects={projects}
        currentProjectId={projectId}
        onSelectProject={onSelectProject}
        onProjectAdded={() => onRefresh?.()}
        onRefresh={onRefresh}
        factory={factory}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-[22px] px-7 pt-7 pb-5">
        {loading && (
          <p role="status" data-testid="inbox-loading" className="text-xs text-text-secondary">
            Loading the attention queue from canonical factory state…
          </p>
        )}
        {error && !loading && (
          <p
            role="alert"
            data-testid="inbox-error"
            className="break-words text-xs text-[var(--error)]"
          >
            Attention queue unavailable: {error}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl leading-[1.4] font-medium text-foreground">
            Needs your attention
          </h2>
          <p className="text-[13px] leading-[1.4] text-text-secondary">
            {items.length === 1
              ? "1 job waiting for context, review, or recovery."
              : `${items.length} jobs waiting for context, review, or recovery.`}
          </p>
        </div>

        <div className="flex h-11 shrink-0 items-center gap-6 border-b border-[var(--border-subtle)]">
          <button
            type="button"
            aria-current="page"
            className="flex h-full items-center gap-2 border-b-2 border-[var(--foreground)] text-xs font-medium text-foreground"
          >
            Needs attention
            <span className="font-mono text-[11px] font-normal text-text-secondary">
              {items.length}
            </span>
          </button>
          <button
            type="button"
            disabled
            title="Updates are not wired yet"
            className="flex h-full items-center gap-2 text-xs text-text-secondary disabled:cursor-default"
          >
            Updates
            <span className="font-mono text-[11px] text-text-secondary">{updates}</span>
          </button>
          <button
            type="button"
            disabled
            title="Archiving is not wired yet"
            className="flex h-full items-center gap-2 text-xs text-text-secondary disabled:cursor-default"
          >
            Archived
          </button>

          <span className="flex-1" />

          <div
            data-focus-ring="container"
            className="flex h-8 w-[204px] items-center justify-between rounded-full border border-[var(--border)] px-3 transition-colors focus-within:border-[var(--ring)]"
          >
            <label className="flex min-w-0 items-center gap-2">
              <Search aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search inbox"
                placeholder="Search inbox…"
                className="w-full min-w-0 bg-transparent text-xs leading-[1.4] text-foreground outline-none placeholder:text-text-secondary"
              />
            </label>
            <span className="shrink-0 text-[10px] leading-[1.4] text-text-secondary">⌘ K</span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 gap-6">
          <div className="flex w-[620px] shrink-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 pb-4">
              {FILTERS.map((entry) => {
                const active = filter === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(entry.id)}
                    className={cn(
                      "rounded-full px-[10px] py-[7px] text-[11px] leading-[1.4] transition-colors",
                      active
                        ? "bg-[var(--secondary)] text-foreground"
                        : "bg-transparent text-text-secondary hover:text-foreground",
                    )}
                  >
                    {entry.label} {counts[entry.id]}
                  </button>
                );
              })}
            </div>

            <div
              ref={listRef}
              role="listbox"
              aria-label="Jobs needing attention"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  move(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  move(-1);
                } else if (event.key === "Enter" && selected) {
                  event.preventDefault();
                  document.getElementById("inbox-issue-pane")?.focus();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setSelectedId(null);
                }
              }}
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              {visible.length === 0 ? (
                <div className="flex flex-col items-start gap-3 rounded-lg border border-[var(--border-subtle)] px-4 py-6">
                  <p className="text-[13px] leading-[1.4] text-foreground">
                    {items.length === 0
                      ? "Nothing needs your attention"
                      : "No jobs match this view"}
                  </p>
                  <button
                    type="button"
                    onClick={
                      items.length === 0
                        ? onOpenJobs
                        : () => {
                            setFilter("all");
                            setQuery("");
                          }
                    }
                    className="text-[11px] leading-[1.4] text-foreground underline underline-offset-2"
                  >
                    {items.length === 0 ? "Open Jobs" : "Clear filters"}
                  </button>
                </div>
              ) : (
                visible.map((item) => (
                  <AttentionRow
                    key={item.job.id}
                    item={item}
                    selected={item.job.id === selectedId}
                    onSelect={() => setSelectedId(item.job.id)}
                  />
                ))
              )}
            </div>

            <div className="flex shrink-0 items-start gap-[7px] px-3.5 pt-[18px]">
              <Info aria-hidden="true" className="mt-0.5 size-[13px] shrink-0 text-text-muted" />
              <p className="text-[11px] leading-[1.4] text-text-secondary">
                Reading an item does not resolve it. Jobs stay here until the required action is
                complete.
              </p>
            </div>
          </div>

          {selected && <IssuePane item={selected} onClose={() => setSelectedId(null)} />}
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-t border-[var(--border-subtle)] px-7 pt-2">
        <span className="flex items-center gap-1.5">
          <span className={cn("size-[5px] rounded-full", health.dot)} />
          <span className="text-[10px] leading-[1.4] text-text-secondary">{health.label}</span>
        </span>
        <span className="text-[10px] leading-[1.4] text-text-secondary">{board.freshness}</span>
      </div>
    </div>
  );
}

function AttentionRow({
  item,
  selected,
  onSelect,
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = ATTENTION_ICON[item.icon];
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex h-[99px] w-full shrink-0 gap-3 rounded-[var(--radius-news)] border border-[var(--border-subtle)] p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        selected ? "bg-[var(--card)]" : "bg-transparent hover:bg-[var(--card)]/50",
      )}
    >
      <span className="flex w-[18px] shrink-0 justify-center pt-px">
        <Icon aria-hidden="true" className={cn("size-4", KIND_INK[item.kind])} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <span className="flex items-center gap-2">
          <span className={cn("text-[11px] leading-[1.4] font-medium", KIND_INK[item.kind])}>
            {item.reason}
          </span>
          <span className="flex-1" />
          <span className="text-[10px] leading-[1.4] text-text-secondary">{item.since}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11px] leading-[1.4] text-text-secondary">
            {item.job.ref}
          </span>
          {item.job.repository && (
            <span className="shrink-0 rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] leading-none text-text-secondary">
              {item.job.repository}
            </span>
          )}
          <span className="truncate text-[13px] leading-[1.4] font-medium text-foreground">
            {item.job.title}
          </span>
        </span>
        {item.evidence ? (
          <span className="flex min-w-0 items-center gap-[9px] text-[11px] leading-[1.4]">
            {item.evidence.map((evidence) => (
              <span key={evidence.text} className={cn("shrink-0", INK_TEXT[evidence.ink])}>
                {evidence.text}
              </span>
            ))}
          </span>
        ) : (
          <span className="truncate text-[11px] leading-[1.4] text-text-secondary">
            {item.context}
          </span>
        )}
      </span>
    </button>
  );
}

function IssuePane({ item, onClose }: { item: InboxItem; onClose: () => void }) {
  const job = item.job;
  const [context, setContext] = useState("");
  const action = job.action?.label ?? "Provide context";

  return (
    <aside
      id="inbox-issue-pane"
      tabIndex={-1}
      aria-label={`${job.ref} ${job.title}`}
      className="flex min-h-0 flex-1 flex-col rounded-[10px] border border-[var(--border-subtle)] bg-[var(--elevation-stage)] outline-none"
    >
      <header className="flex shrink-0 flex-col gap-3 border-b border-[var(--border-subtle)] px-6 py-[18px]">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[11px] leading-[1.4] text-text-secondary">
            {job.ref} · New issue
          </span>
          <span className="flex-1" />
          <PaneChip icon={Maximize2} label="Expand" />
          <PaneChip icon={X} label="Close" onClick={onClose} />
        </div>
        <h2 className="text-xl leading-[1.4] font-medium text-foreground">{job.title}</h2>
        <div className="flex items-center gap-2.5">
          <span className="rounded-full bg-white/[0.04] px-2 py-[3px] text-[11px] leading-[1.4] text-text-secondary">
            {job.stage.label}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-[3px] text-[11px] leading-[1.4]",
              KIND_BADGE[item.kind],
            )}
          >
            {item.reason}
          </span>
          <span className="flex-1" />
          <PaneChip icon={ArrowUpRight} label="Issue" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 pb-6">
        <section className="flex flex-col gap-3 border-b border-[var(--border-subtle)] py-[18px]">
          <h3 className="text-[13px] leading-[1.4] font-medium text-foreground">Original issue</h3>
          <p className="text-[13px] leading-[1.45] text-text-secondary">
            {item.context ?? job.detail ?? job.summary?.text ?? "—"}
          </p>
          <p className="text-[11px] leading-[1.4] text-text-secondary">
            Created {item.since} · {job.ref}
          </p>
        </section>

        <section className="flex flex-col gap-3 py-[18px]">
          <h3 className="text-[13px] leading-[1.4] font-medium text-foreground">
            {item.kind === "clarification" ? "Clarification needed" : "Action required"}
          </h3>
          <div className="flex items-center gap-2.5">
            <MessageCircle
              aria-hidden="true"
              className={cn("size-[17px] shrink-0", KIND_INK[item.kind])}
            />
            <span className={cn("text-sm leading-[1.4] font-medium", KIND_INK[item.kind])}>
              {item.kind === "clarification"
                ? "Waiting for your context"
                : item.kind === "review"
                  ? "Waiting for your review"
                  : "Waiting for a recovery decision"}
            </span>
          </div>
          <p className="text-[13px] leading-[1.45] text-text-secondary">
            {item.context ??
              "The required action is not recorded on this job yet. Open it in Jobs for the full run history."}
          </p>

          {item.kind === "clarification" && (
            <>
              <ol className="flex flex-col gap-[9px] text-[13px] leading-[1.45] text-text-secondary">
                <li>1. Where are new users getting stuck today?</li>
                <li>2. What should a successful first session include?</li>
              </ol>

              <div className="flex flex-col gap-[9px]">
                <label htmlFor="inbox-context" className="text-xs leading-[1.4] text-foreground">
                  Additional context
                </label>
                <div className="flex flex-col gap-3 rounded-lg border border-[var(--input)] p-3">
                  <textarea
                    id="inbox-context"
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                    rows={3}
                    placeholder="Describe the expected flow, examples, or links…"
                    className="w-full resize-none bg-transparent text-[13px] leading-[1.45] text-foreground outline-none placeholder:text-text-secondary"
                  />
                  <button
                    type="button"
                    disabled
                    title="File attachment is not wired yet"
                    className="flex w-fit items-center gap-2.5 text-[11px] leading-[1.4] text-text-secondary disabled:cursor-default"
                  >
                    <Paperclip aria-hidden="true" className="size-[15px]" />
                    Attach files
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="flex items-center gap-2.5">
            <p className="flex-1 text-[11px] leading-[1.4] text-text-secondary">
              {item.kind === "clarification"
                ? "The triage agent will refine the ticket."
                : "Job state changes land with the jobs API."}
            </p>
            <button
              type="button"
              disabled
              title="Submitting from the inbox arrives with the jobs API"
              className="flex items-center gap-[7px] rounded-full bg-foreground px-[11px] py-[7px] text-xs leading-[1.4] text-[var(--background)] disabled:cursor-default disabled:opacity-50"
            >
              <ArrowUp aria-hidden="true" className="size-3.5" />
              {action}
            </button>
          </div>
        </section>
      </div>
    </aside>
  );
}

function PaneChip({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof X;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex items-center gap-[7px] rounded-full border border-[var(--border)] bg-[var(--card)] px-[11px] py-[7px] text-xs leading-[1.4] text-foreground transition-colors hover:bg-[var(--secondary)] disabled:cursor-default disabled:hover:bg-[var(--card)]"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-text-secondary" />
      {label}
    </button>
  );
}
