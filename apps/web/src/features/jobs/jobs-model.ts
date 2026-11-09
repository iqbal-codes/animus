import type { OperatorBoard, OperatorBoardCard } from "@animus/contracts/operator";

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

export type SpecProgress = {
  integrated: number;
  required: number;
  delivered: boolean;
  finalState: string | null;
};

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
   * until a person acts.
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
  /** Projection metadata: spec parent and progress, or a child's parent reference. */
  kind?: "spec" | "ticket" | "unplanned";
  workId?: string;
  parentRef?: { issueNumber: number; title: string };
  specProgress?: SpecProgress;
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

/**
 * The established Kanban columns, in their existing order and styling. Lane ids
 * match the backend projection; the board never adds or reorders columns.
 */
export const BOARD_LANE_TEMPLATE: readonly {
  id: string;
  title: string;
  icon: LaneIcon;
  iconInk: Ink;
}[] = [
  { id: "triage", title: "Triage", icon: "inbox", iconInk: "secondary" },
  { id: "ready", title: "Ready", icon: "circle-dashed", iconInk: "secondary" },
  { id: "working", title: "Working", icon: "code", iconInk: "accent" },
  { id: "approval", title: "Approval", icon: "git-pull-request", iconInk: "warning" },
  { id: "needs-owner", title: "Needs owner", icon: "circle-alert", iconInk: "error" },
  { id: "parked", title: "Parked", icon: "pause", iconInk: "muted" },
  { id: "merged", title: "Merged", icon: "git-merge", iconInk: "success" },
  { id: "failed", title: "Failed", icon: "circle-alert", iconInk: "error" },
];

const LANE_SURFACE: Record<string, Surface> = {
  triage: "surface",
  ready: "background",
  working: "accent-bg",
  approval: "accent-bg",
  "needs-owner": "error-bg",
  parked: "surface",
  merged: "success-bg",
  failed: "error-bg",
};

const LANE_INK: Record<string, Ink> = {
  triage: "secondary",
  ready: "foreground",
  working: "accent",
  approval: "accent",
  "needs-owner": "error",
  parked: "muted",
  merged: "success",
  failed: "error",
};

const EXECUTION: Record<string, { icon: ExecutionIcon; ink: Ink } | undefined> = {
  working: { icon: "loader-circle", ink: "success" },
  approval: { icon: "git-pull-request", ink: "warning" },
  "needs-owner": { icon: "circle-alert", ink: "error" },
  parked: { icon: "pause", ink: "muted" },
  merged: { icon: "git-merge", ink: "success" },
  failed: { icon: "circle-alert", ink: "error" },
};

const FINAL_STATE_LABEL: Record<string, string> = {
  waiting_children: "waiting for children",
  blocked: "blocked",
  verifying: "final verification",
  needs_owner: "needs owner",
  awaiting_manual_merge: "awaiting manual merge",
  awaiting_merge_verification: "awaiting merge verification",
  remote_unavailable: "remote unavailable",
  delivered: "delivered",
};

export function formatRelative(epoch: number, now = Date.now()): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return "unknown";
  const delta = Math.max(0, now - epoch);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function specProgressLabel(progress: SpecProgress): string {
  const base = `${progress.integrated}/${progress.required} tickets integrated`;
  if (progress.delivered) return `${base} · delivered`;
  if (progress.finalState && FINAL_STATE_LABEL[progress.finalState]) {
    return `${base} · ${FINAL_STATE_LABEL[progress.finalState]}`;
  }
  return base;
}

function attentionOf(card: OperatorBoardCard, since: string): TaskCardJob["attention"] {
  if (card.lane === "needs-owner") {
    return {
      kind: "failed",
      icon: "circle-x",
      reason: "Needs owner",
      context: card.detail,
      since,
    };
  }
  if (card.lane === "failed") {
    return {
      kind: "failed",
      icon: "circle-x",
      reason: "Failed",
      context: card.detail,
      since,
    };
  }
  if (card.lane === "approval") {
    const evidence: { text: string; ink: Ink }[] = [];
    if (card.pullRequest) {
      evidence.push({
        text: `PR #${card.pullRequest.number}`,
        ink: card.pullRequest.state === "merged" ? "success" : "secondary",
      });
    }
    if (card.specProgress) {
      evidence.push({ text: specProgressLabel(card.specProgress), ink: "secondary" });
    }
    return {
      kind: "review",
      icon: "git-pull-request",
      reason: card.stageLabel,
      evidence: evidence.length > 0 ? evidence : undefined,
      context: evidence.length > 0 ? undefined : card.detail,
      since,
    };
  }
  if (card.lane === "triage") {
    return {
      kind: "clarification",
      icon: card.planKind === null ? "message-circle" : "file-text",
      reason: card.stageLabel,
      context: card.detail,
      since,
    };
  }
  return undefined;
}

export function mapBoardCard(card: OperatorBoardCard, now = Date.now()): TaskCardJob {
  const since = formatRelative(card.updatedAt, now);
  const specProgress = card.specProgress
    ? {
        integrated: card.specProgress.integrated,
        required: card.specProgress.required,
        delivered: card.specProgress.delivered,
        finalState: card.specProgress.finalState,
      }
    : undefined;
  return {
    id: card.id,
    ref: card.ref,
    stage: {
      label: card.stageLabel,
      surface: LANE_SURFACE[card.lane] ?? "surface",
      ink: LANE_INK[card.lane] ?? "secondary",
    },
    pullRequest: card.pullRequest
      ? {
          label: `PR #${card.pullRequest.number}`,
          ink: card.pullRequest.state === "merged" ? "success" : "secondary",
        }
      : undefined,
    lap: card.latestRun ? `Lap ${card.latestRun.lap}` : undefined,
    title: card.title,
    summary: card.detail
      ? { text: card.detail, ink: LANE_INK[card.lane] ?? "secondary" }
      : undefined,
    timestamp: since,
    execution: EXECUTION[card.lane],
    attention: attentionOf(card, since),
    kind: card.kind,
    workId: card.workId,
    parentRef: card.parent
      ? { issueNumber: card.parent.issueNumber, title: card.parent.title }
      : undefined,
    specProgress,
  };
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * Project the canonical backend board into the existing Kanban model. Columns,
 * ordering and card styling are preserved; only real facts fill the cells.
 */
export function mapOperatorBoard(board: OperatorBoard, now = Date.now()): JobsBoardModel {
  const needsOwner = board.lanes.find((lane) => lane.id === "needs-owner")?.count ?? 0;
  const approval = board.lanes.find((lane) => lane.id === "approval")?.count ?? 0;
  const totalJobs = board.lanes.reduce((sum, lane) => sum + lane.count, 0);
  const availableSlots = Math.max(0, board.counts.capacity - board.counts.workers);
  const usage = board.usage;
  const tokens =
    usage.available && usage.tokensIn !== null && usage.tokensOut !== null
      ? usage.tokensIn + usage.tokensOut
      : null;

  const kpis: KpiModel[] = [
    {
      label: "Executable tickets",
      value: String(board.counts.tickets),
      description: `${board.counts.specs} specs · ${board.counts.unplanned} unplanned`,
      icon: "layers",
    },
    {
      label: "Active workers",
      value: `${board.counts.workers} / ${board.counts.capacity}`,
      description:
        board.counts.workers > board.counts.capacity
          ? "Above configured capacity"
          : `${availableSlots} slots available`,
      ink: board.counts.workers > 0 ? "success" : "secondary",
      icon: "cpu",
    },
    {
      label: "Needs you",
      value: String(needsOwner + approval),
      description: `${approval} approval · ${needsOwner} escalated`,
      ink: needsOwner + approval > 0 ? "warning" : "secondary",
      icon: "git-pull-request",
    },
    {
      label: "Tokens used",
      value: tokens === null ? "Unavailable" : formatTokens(tokens),
      description: usage.available ? "Recorded input + output tokens" : usage.detail,
      ink: "secondary",
      icon: "chart-no-axes-column",
    },
    {
      label: "Total cost",
      value:
        usage.available && usage.costMicros !== null ? formatCost(usage.costMicros) : "Unavailable",
      description: usage.available ? "Recorded usage cost" : usage.detail,
      ink: "secondary",
      icon: "wallet",
    },
  ];

  const lanes: KanbanLaneModel[] = BOARD_LANE_TEMPLATE.map((template) => {
    const projected = board.lanes.find((lane) => lane.id === template.id);
    return {
      id: template.id,
      title: template.title,
      icon: template.icon,
      iconInk: template.iconInk,
      count: projected?.count ?? 0,
      cards: (projected?.cards ?? []).map((card) => mapBoardCard(card, now)),
    };
  });

  return {
    repository: board.repository,
    totalJobs,
    freshness: `Updated ${formatRelative(board.generatedAt, now)}`,
    kpis,
    lanes,
  };
}

export function emptyBoard(repository = "No repository selected"): JobsBoardModel {
  return {
    repository,
    totalJobs: 0,
    freshness: "Not loaded",
    kpis: [
      {
        label: "Executable tickets",
        value: "0",
        description: "0 specs · 0 unplanned",
        icon: "layers",
      },
      {
        label: "Active workers",
        value: "0 / 1",
        description: "No project data",
        ink: "secondary",
        icon: "cpu",
      },
      {
        label: "Needs you",
        value: "0",
        description: "0 approval · 0 escalated",
        ink: "secondary",
        icon: "git-pull-request",
      },
      {
        label: "Tokens used",
        value: "Unavailable",
        description: "No usage records available",
        ink: "secondary",
        icon: "chart-no-axes-column",
      },
      {
        label: "Total cost",
        value: "Unavailable",
        description: "No usage records available",
        ink: "secondary",
        icon: "wallet",
      },
    ],
    lanes: BOARD_LANE_TEMPLATE.map((template) => ({
      id: template.id,
      title: template.title,
      icon: template.icon,
      iconInk: template.iconInk,
      count: 0,
      cards: [],
    })),
  };
}

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
 * Jobs that stay blocked until a person acts, newest first. Reading or archiving
 * never changes job status, so this is a projection of the board rather than a
 * second source of truth.
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
