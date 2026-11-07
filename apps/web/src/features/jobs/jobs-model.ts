/**
 * Jobs surface model.
 *
 * Content is transcribed verbatim from `animus.pen` frame `TAufE`
 * ("Animus / Jobs / Kanban / Sidebar expanded", 1440 × 1080). No jobs API
 * exists yet, so `JOBS_BOARD` is the single seam to replace when the engine
 * feed lands: swap this constant for parsed operator data and the components
 * below stay unchanged.
 */

export type Ink =
  | "foreground"
  | "secondary"
  | "muted"
  | "accent"
  | "info"
  | "warning"
  | "success"
  | "error";

export type Surface =
  | "background"
  | "surface"
  | "card"
  | "secondary"
  | "accent-bg"
  | "info-bg"
  | "warning-bg"
  | "success-bg"
  | "error-bg";

export type ExecutionIcon =
  | "loader-circle"
  | "pause"
  | "circle-alert"
  | "git-pull-request"
  | "git-merge";

export type StageChip = { label: string; surface: Surface; ink: Ink };

export type TaskCardJob = {
  id: string;
  ref: string;
  repository?: string;
  stage: StageChip;
  pullRequest?: { label: string; ink: Ink };
  lap?: string;
  title: string;
  summary?: { text: string; ink: Ink };
  detail?: string;
  timestamp?: string;
  action?: { label: string; ink: Ink };
  execution?: { icon: ExecutionIcon; ink: Ink };
  /**
   * Inbox metadata, transcribed from `Ht4rv`. Present only for jobs that stop
   * until a person acts: the six jobs the Inbox queues.
   */
  attention?: {
    kind: "clarification" | "review" | "failed";
    icon: "message-circle" | "file-text" | "circle-x" | "git-pull-request";
    reason: string;
    context?: string;
    /** Review rows carry PR, checks and diff evidence instead of a context line. */
    evidence?: { text: string; ink: Ink }[];
    since: string;
  };
  metrics?: { harness: string; lapSpend?: string; totalSpend?: string };
};

export type LaneIcon =
  | "inbox"
  | "circle-dashed"
  | "code"
  | "git-pull-request"
  | "circle-alert"
  | "pause"
  | "git-merge";

export type KanbanLaneModel = {
  id: string;
  title: string;
  icon: LaneIcon;
  iconInk: Ink;
  count: number;
  cards: TaskCardJob[];
};

export type KpiIcon = "layers" | "cpu" | "git-pull-request" | "chart-no-axes-column" | "wallet";

export type KpiModel = {
  label: string;
  value: string;
  description: string;
  ink?: Ink;
  icon: KpiIcon;
};

export type JobsBoardModel = {
  repository: string;
  totalJobs: number;
  freshness: string;
  kpis: KpiModel[];
  lanes: KanbanLaneModel[];
};

const ready = (label: string): StageChip => ({ label, surface: "background", ink: "foreground" });

export const JOBS_BOARD: JobsBoardModel = {
  repository: "animus/platform",
  totalJobs: 18,
  freshness: "Updated just now",
  kpis: [
    { label: "Total jobs", value: "18", description: "Across all stages", icon: "layers" },
    {
      label: "Active workers",
      value: "3 / 8",
      description: "5 slots available",
      ink: "success",
      icon: "cpu",
    },
    {
      label: "Needs you",
      value: "3",
      description: "2 approval · 1 escalated",
      ink: "warning",
      icon: "git-pull-request",
    },
    {
      label: "Tokens used",
      value: "120.0M",
      description: "Input + output tokens",
      icon: "chart-no-axes-column",
    },
    { label: "Total cost", value: "$35.60", description: "Usage this period", icon: "wallet" },
  ],
  lanes: [
    {
      id: "triage",
      title: "Triage",
      icon: "inbox",
      iconInk: "secondary",
      count: 2,
      cards: [
        {
          id: "153",
          ref: "#153",
          attention: {
            kind: "clarification",
            reason: "Needs clarification",
            icon: "message-circle",
            context: "Define the user flow and acceptance criteria.",
            since: "4m ago",
          },
          stage: { label: "Needs info", surface: "info-bg", ink: "info" },
          title: "Improve onboarding",
          summary: { text: "Needs clarification", ink: "warning" },
          detail: "Define the user flow and acceptance criteria.",
          timestamp: "New job · 4m ago",
        },
        {
          id: "152",
          ref: "#152",
          attention: {
            kind: "clarification",
            reason: "Needs a specification",
            icon: "file-text",
            context: "Identify the failure cases and expected behavior.",
            since: "16m ago",
          },
          stage: { label: "Needs triage", surface: "surface", ink: "secondary" },
          title: "Make jobs easier to debug",
          summary: { text: "Needs a specification", ink: "warning" },
          detail: "Identify the failure cases and expected behavior.",
          timestamp: "New job · 16m ago",
        },
      ],
    },
    {
      id: "ready",
      title: "Ready",
      icon: "circle-dashed",
      iconInk: "secondary",
      count: 4,
      cards: [
        {
          id: "149",
          ref: "#149",
          stage: ready("Ready"),
          title: "Add repository webhooks",
          summary: { text: "Brake: pause set", ink: "warning" },
          timestamp: "Queued · 12m ago",
        },
        {
          id: "148",
          ref: "#148",
          stage: ready("Ready"),
          title: "Retry failed workflow steps",
          summary: { text: "Waiting for a free slot", ink: "secondary" },
          detail: "Capacity 1 / 1 active",
          timestamp: "Queued · 24m ago",
        },
        {
          id: "147",
          ref: "#147",
          stage: ready("Ready"),
          title: "Cache dependency installs",
          summary: { text: "Blocked by #146", ink: "warning" },
          timestamp: "Queued · 36m ago",
        },
        {
          id: "146",
          ref: "#146",
          stage: ready("Ready"),
          title: "Fix timezone in job history",
          summary: { text: "Outside work window", ink: "secondary" },
          timestamp: "Queued · 1h ago",
        },
      ],
    },
    {
      id: "working",
      title: "Working",
      icon: "code",
      iconInk: "accent",
      count: 3,
      cards: [
        {
          id: "145",
          ref: "#145",
          execution: { icon: "loader-circle", ink: "success" },
          stage: { label: "Build", surface: "surface", ink: "secondary" },
          pullRequest: { label: "PR #145", ink: "secondary" },
          lap: "Lap 1/3",
          title: "Add organization-level API keys",
          metrics: { harness: "pi · 8m 42s", lapSpend: "$1.24", totalSpend: "$4.21" },
        },
        {
          id: "144",
          ref: "#144",
          execution: { icon: "loader-circle", ink: "success" },
          stage: { label: "QA", surface: "warning-bg", ink: "warning" },
          title: "Stream live job logs",
          metrics: { harness: "pi · 5m 18s" },
        },
        {
          id: "143",
          ref: "#143",
          execution: { icon: "loader-circle", ink: "success" },
          stage: { label: "Review", surface: "accent-bg", ink: "accent" },
          title: "Fix concurrent job scheduling",
          metrics: { harness: "claude · 4m 02s" },
        },
      ],
    },
    {
      id: "approval",
      title: "Approval",
      icon: "git-pull-request",
      iconInk: "warning",
      count: 2,
      cards: [
        {
          id: "142",
          ref: "#142",
          attention: {
            kind: "review",
            reason: "Review changes",
            icon: "git-pull-request",
            evidence: [
              { text: "PR #87", ink: "secondary" },
              { text: "18 / 18 checks passed", ink: "success" },
              { text: "+248 −32", ink: "secondary" },
            ],
            since: "18m ago",
          },
          execution: { icon: "git-pull-request", ink: "warning" },
          stage: { label: "Approval", surface: "accent-bg", ink: "accent" },
          pullRequest: { label: "PR #87", ink: "secondary" },
          lap: "Lap 1/3",
          title: "Add usage limits per workspace",
          summary: { text: "18 / 18 checks passed", ink: "success" },
          detail: "+248 −32",
          timestamp: "Opened 18m ago",
          action: { label: "Review changes", ink: "warning" },
        },
        {
          id: "141",
          ref: "#141",
          attention: {
            kind: "review",
            reason: "Review changes",
            icon: "git-pull-request",
            evidence: [
              { text: "PR #86", ink: "secondary" },
              { text: "12 / 12 checks passed", ink: "success" },
              { text: "+96 −14", ink: "secondary" },
            ],
            since: "42m ago",
          },
          execution: { icon: "git-pull-request", ink: "warning" },
          stage: { label: "Approval", surface: "accent-bg", ink: "accent" },
          pullRequest: { label: "PR #86", ink: "secondary" },
          lap: "Lap 1/3",
          title: "Persist repository preferences",
          summary: { text: "12 / 12 checks passed", ink: "success" },
          detail: "+96 −14",
          timestamp: "Opened 42m ago",
          action: { label: "Review changes", ink: "warning" },
        },
      ],
    },
    {
      id: "needs-owner",
      title: "Needs owner",
      icon: "circle-alert",
      iconInk: "error",
      count: 1,
      cards: [
        {
          id: "137",
          ref: "#137",
          execution: { icon: "circle-alert", ink: "error" },
          stage: { label: "Needs owner", surface: "error-bg", ink: "error" },
          pullRequest: { label: "PR #91", ink: "secondary" },
          lap: "Lap 3/3",
          title: "Consolidate retry policy across workers",
          summary: { text: "Review rejected · lap budget exhausted", ink: "error" },
          detail: "Standards axis: 2 blocking findings left open.",
          timestamp: "Escalated · 6m ago",
          action: { label: "Take over", ink: "error" },
        },
      ],
    },
    {
      id: "parked",
      title: "Parked",
      icon: "pause",
      iconInk: "muted",
      count: 1,
      cards: [
        {
          id: "136",
          ref: "#136",
          execution: { icon: "pause", ink: "muted" },
          stage: ready("Parked"),
          lap: "Lap 1/3",
          title: "Reindex symbol graph on branch switch",
          summary: { text: "Run cancelled · deadline reached", ink: "warning" },
          detail: "Worktree local-loop/issue-136 kept for resume.",
          timestamp: "Parked · 22m ago",
          action: { label: "Resume", ink: "foreground" },
        },
      ],
    },
    {
      id: "merged",
      title: "Merged",
      icon: "git-merge",
      iconInk: "success",
      count: 3,
      cards: [
        {
          id: "140",
          ref: "#140",
          execution: { icon: "git-merge", ink: "success" },
          stage: { label: "Merged", surface: "success-bg", ink: "success" },
          pullRequest: { label: "PR #85", ink: "success" },
          title: "Add job cancellation support",
          summary: { text: "On develop · not promoted", ink: "warning" },
          timestamp: "Merged · 1h ago",
        },
        {
          id: "139",
          ref: "#139",
          execution: { icon: "git-merge", ink: "success" },
          stage: { label: "Merged", surface: "success-bg", ink: "success" },
          pullRequest: { label: "PR #84", ink: "success" },
          title: "Fix token usage aggregation",
          timestamp: "Merged · 2h ago",
        },
        {
          id: "138",
          ref: "#138",
          execution: { icon: "git-merge", ink: "success" },
          stage: { label: "Merged", surface: "success-bg", ink: "success" },
          pullRequest: { label: "PR #83", ink: "success" },
          title: "Show worker health in settings",
          summary: { text: "Released to main", ink: "success" },
          timestamp: "Merged · 3h ago",
        },
      ],
    },
    {
      id: "failed",
      title: "Failed",
      icon: "circle-alert",
      iconInk: "error",
      count: 2,
      cards: [
        {
          id: "151",
          ref: "#151",
          attention: {
            kind: "failed",
            reason: "Max laps reached",
            icon: "circle-x",
            context: "Delivery ordering is still unresolved after the final lap.",
            since: "8m ago",
          },
          execution: { icon: "circle-alert", ink: "error" },
          stage: { label: "Failed", surface: "error-bg", ink: "error" },
          lap: "Lap 2/3",
          title: "Stabilize webhook delivery",
          summary: { text: "Transport error · stream aborted", ink: "error" },
          detail: "Provider stream ended before the candidate was committed.",
          timestamp: "Stopped · 8m ago",
          action: { label: "View failure", ink: "foreground" },
        },
        {
          id: "150",
          ref: "#150",
          attention: {
            kind: "failed",
            reason: "CI gate error",
            icon: "circle-x",
            context: "Migration checks failed. Merge is blocked.",
            since: "22m ago",
          },
          execution: { icon: "circle-alert", ink: "error" },
          stage: { label: "Failed", surface: "error-bg", ink: "error" },
          title: "Upgrade database client",
          summary: { text: "Tool error · build step crashed", ink: "error" },
          detail: "Migration checks failed. Merge is blocked.",
          timestamp: "Stopped · 22m ago",
          action: { label: "View failure", ink: "foreground" },
        },
      ],
    },
  ],
};

export type InboxKind = NonNullable<TaskCardJob["attention"]>["kind"];

export type InboxItem = {
  job: TaskCardJob;
  laneId: string;
  laneTitle: string;
  kind: InboxKind;
  icon: NonNullable<TaskCardJob["attention"]>["icon"];
  reason: string;
  context?: string;
  evidence?: { text: string; ink: Ink }[];
  since: string;
};

export const INBOX_KIND_LABEL: Record<InboxKind, string> = {
  clarification: "Clarification",
  review: "Review",
  failed: "Failed",
};

const MINUTES_AGO = (since: string): number => {
  const match = /^(\d+)\s*(m|h|d)/i.exec(since);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  return unit === "m" ? value : unit === "h" ? value * 60 : value * 1440;
};

/**
 * Jobs that stay blocked until a person acts, newest first — the six rows of
 * `Ht4rv`'s attention queue. Reading or archiving never changes job status, so
 * this is a projection of the board rather than a second source of truth.
 */
export function selectInbox(
  board: JobsBoardModel,
  options: { includeFailed?: boolean } = {},
): InboxItem[] {
  const includeFailed = options.includeFailed ?? true;
  return board.lanes
    .flatMap((lane) =>
      lane.cards.flatMap((job): InboxItem[] => {
        const attention = job.attention;
        if (!attention) return [];
        if (!includeFailed && attention.kind === "failed") return [];
        return [
          {
            job,
            laneId: lane.id,
            laneTitle: lane.title,
            kind: attention.kind,
            icon: attention.icon,
            reason: attention.reason,
            context: attention.context,
            evidence: attention.evidence,
            since: attention.since,
          },
        ];
      }),
    )
    .sort((a, b) => MINUTES_AGO(a.since) - MINUTES_AGO(b.since));
}
