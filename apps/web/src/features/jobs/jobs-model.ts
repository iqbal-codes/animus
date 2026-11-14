import type {
  OperatorBoard,
  OperatorBoardCard,
  OperatorWorkDetail,
} from "@animus/contracts/operator";

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

export const ALL_PROJECTS_ID = "all";

export type TaskCardJob = {
  id: string;
  ref: string;
  projectId?: string;
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

export function mapBoardCard(
  card: OperatorBoardCard,
  now = Date.now(),
  context?: { projectId?: string; repository?: string },
): TaskCardJob {
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
    ...(context?.projectId ? { projectId: context.projectId } : {}),
    ...(context?.repository ? { repository: context.repository } : {}),
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
    summary: card.detail ? { text: card.detail, ink: "secondary" } : undefined,
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

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function buildBoardKpis(params: {
  counts: OperatorBoard["counts"];
  usage: OperatorBoard["usage"];
  needsOwner: number;
  approval: number;
}): KpiModel[] {
  const { counts, usage, needsOwner, approval } = params;
  const availableSlots = Math.max(0, counts.capacity - counts.workers);
  const tokens =
    usage.available && usage.tokensIn !== null && usage.tokensOut !== null
      ? usage.tokensIn + usage.tokensOut
      : null;

  return [
    {
      label: "Executable tickets",
      value: String(counts.tickets),
      description: `${counts.specs} specs · ${counts.unplanned} unplanned`,
      icon: "layers",
    },
    {
      label: "Active workers",
      value: `${counts.workers} / ${counts.capacity}`,
      description:
        counts.workers > counts.capacity
          ? "Above configured capacity"
          : `${availableSlots} slots available`,
      ink: counts.workers > 0 ? "success" : "secondary",
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
}

/**
 * Project the canonical backend board into the existing Kanban model. Columns,
 * ordering and card styling are preserved; only real facts fill the cells.
 */
export function mapOperatorBoard(board: OperatorBoard, now = Date.now()): JobsBoardModel {
  const needsOwner = board.lanes.find((lane) => lane.id === "needs-owner")?.count ?? 0;
  const approval = board.lanes.find((lane) => lane.id === "approval")?.count ?? 0;
  const totalJobs = board.lanes.reduce((sum, lane) => sum + lane.count, 0);

  const kpis = buildBoardKpis({
    counts: board.counts,
    usage: board.usage,
    needsOwner,
    approval,
  });

  const lanes: KanbanLaneModel[] = BOARD_LANE_TEMPLATE.map((template) => {
    const projected = board.lanes.find((lane) => lane.id === template.id);
    return {
      id: template.id,
      title: template.title,
      icon: template.icon,
      iconInk: template.iconInk,
      count: projected?.count ?? 0,
      cards: (projected?.cards ?? []).map((card) =>
        mapBoardCard(card, now, { projectId: board.projectId }),
      ),
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

/**
 * Aggregate multiple project boards into one combined Kanban/Inbox projection,
 * tagging every card with its source projectId and repository pill.
 */
export function mergeOperatorBoards(boards: OperatorBoard[], now = Date.now()): JobsBoardModel {
  if (boards.length === 0) return emptyBoard("All repositories");
  if (boards.length === 1) return mapOperatorBoard(boards[0]!, now);

  const machineCapacity = Math.max(...boards.map((b) => b.counts.capacity), 1);

  const counts: OperatorBoard["counts"] = {
    tickets: 0,
    specs: 0,
    unplanned: 0,
    workers: 0,
    capacity: machineCapacity,
  };
  let anyUsage = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let anyCacheRead = false;
  let costMicros = 0;
  let anyCost = false;
  let latestGeneratedAt = 0;

  for (const board of boards) {
    counts.tickets += board.counts.tickets;
    counts.specs += board.counts.specs;
    counts.unplanned += board.counts.unplanned;
    counts.workers += board.counts.workers;
    if (board.generatedAt > latestGeneratedAt) latestGeneratedAt = board.generatedAt;
    if (board.usage.available) {
      anyUsage = true;
      tokensIn += board.usage.tokensIn ?? 0;
      tokensOut += board.usage.tokensOut ?? 0;
      if (board.usage.cacheReadTokens !== null) {
        anyCacheRead = true;
        cacheReadTokens += board.usage.cacheReadTokens;
      }
      if (board.usage.costMicros !== null) {
        anyCost = true;
        costMicros += board.usage.costMicros;
      }
    }
  }

  const lanes: KanbanLaneModel[] = BOARD_LANE_TEMPLATE.map((template) => {
    let count = 0;
    const cards: TaskCardJob[] = [];
    for (const board of boards) {
      const projected = board.lanes.find((lane) => lane.id === template.id);
      if (!projected) continue;
      count += projected.count;
      for (const card of projected.cards) {
        cards.push(
          mapBoardCard(card, now, {
            projectId: board.projectId,
            repository: board.repository,
          }),
        );
      }
    }
    return {
      id: template.id,
      title: template.title,
      icon: template.icon,
      iconInk: template.iconInk,
      count,
      cards,
    };
  });

  const needsOwner = lanes.find((lane) => lane.id === "needs-owner")?.count ?? 0;
  const approval = lanes.find((lane) => lane.id === "approval")?.count ?? 0;
  const totalJobs = lanes.reduce((sum, lane) => sum + lane.count, 0);

  const usage: OperatorBoard["usage"] = {
    available: anyUsage,
    tokensIn: anyUsage ? tokensIn : null,
    tokensOut: anyUsage ? tokensOut : null,
    cacheReadTokens: anyCacheRead ? cacheReadTokens : null,
    costMicros: anyCost ? costMicros : null,
    detail: anyUsage
      ? "Aggregated across repositories"
      : (boards[0]?.usage.detail ?? "No usage records available"),
  };

  return {
    repository: "All repositories",
    totalJobs,
    freshness: `Updated ${formatRelative(latestGeneratedAt, now)}`,
    kpis: buildBoardKpis({ counts, usage, needsOwner, approval }),
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

export type IssueTimelineMilestone = {
  id: string;
  label: string;
  time?: string;
  status: "completed" | "active" | "pending" | "failed";
};

export type IssueHarnessMetrics = {
  provider: string;
  model: string;
  tier?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  costFormatted?: string;
};

export function mapTimelineMilestones(
  detail: OperatorWorkDetail,
  now = Date.now(),
): IssueTimelineMilestone[] {
  const isMerged =
    detail.lane === "merged" ||
    detail.final?.state === "delivered" ||
    detail.gate?.state === "delivered";
  const isFailed = detail.lane === "failed";
  const isWorking = detail.lane === "working";
  const isApproval = detail.lane === "approval";
  const isReady = detail.lane === "ready";
  const hasRuns = detail.runs.length > 0;
  const isRunActive = detail.latestRun?.run.state === "running";

  return [
    {
      id: "created",
      label: "Created",
      time: formatRelative(detail.work.created_at, now),
      status: "completed",
    },
    {
      id: "triage",
      label: "Triage",
      time:
        detail.planId || hasRuns || detail.lane !== "triage"
          ? formatRelative(detail.work.updated_at, now)
          : undefined,
      status: detail.planId || hasRuns || detail.lane !== "triage" ? "completed" : "active",
    },
    {
      id: "ready",
      label: "Ready",
      status:
        hasRuns || isWorking || isApproval || isMerged
          ? "completed"
          : isReady
            ? "active"
            : detail.lane === "triage"
              ? "pending"
              : "completed",
    },
    {
      id: "implement",
      label: "Implement",
      time: detail.latestRun?.run.launched_at
        ? formatRelative(detail.latestRun.run.launched_at, now)
        : undefined,
      status: isRunActive
        ? "active"
        : isFailed && hasRuns && !detail.evidence
          ? "failed"
          : isApproval || isMerged || (hasRuns && !isWorking)
            ? "completed"
            : isWorking
              ? "active"
              : "pending",
    },
    {
      id: "verification",
      label: "Verification",
      time: detail.latestRun?.run.finished_at
        ? formatRelative(detail.latestRun.run.finished_at, now)
        : undefined,
      status:
        detail.evidence || detail.gate || detail.final
          ? isFailed && detail.evidence?.acceptance?.authorized === false
            ? "failed"
            : "completed"
          : isApproval
            ? "active"
            : isMerged
              ? "completed"
              : "pending",
    },
    {
      id: "review",
      label: "Code review",
      status: isMerged
        ? "completed"
        : isApproval
          ? "active"
          : isFailed && detail.evidence
            ? "failed"
            : "pending",
    },
    {
      id: "merged",
      label: "Merged",
      status: isMerged ? "completed" : isFailed ? "failed" : "pending",
    },
  ];
}

export function mapHarnessMetrics(detail: OperatorWorkDetail): IssueHarnessMetrics {
  const usage = detail.usage;
  const cost =
    usage.available && usage.costMicros !== null
      ? formatCost(usage.costMicros)
      : usage.available
        ? "$0.00"
        : "Cost not recorded";
  const tokensIn = usage.available && usage.tokensIn !== null ? usage.tokensIn : undefined;
  const tokensOut = usage.available && usage.tokensOut !== null ? usage.tokensOut : undefined;
  const cacheReadTokens =
    usage.available && usage.cacheReadTokens !== null ? usage.cacheReadTokens : undefined;

  const plannerMeta = (detail.draft?.latest_revision?.planner_metadata ?? null) as Record<
    string,
    unknown
  > | null;
  const recordedModel =
    typeof plannerMeta?.model === "string"
      ? plannerMeta.model
      : typeof (usage as Record<string, unknown>).model === "string"
        ? String((usage as Record<string, unknown>).model)
        : null;
  const recordedProvider = typeof plannerMeta?.provider === "string" ? plannerMeta.provider : null;

  const provider =
    recordedProvider ??
    (detail.process ? "Command Code" : detail.latestRun ? "Pi Local Loop" : "Local Runner");

  const model =
    recordedModel ??
    (usage.available && usage.detail
      ? usage.detail
      : usage.available
        ? "Local Model"
        : "Not recorded");

  return {
    provider,
    model,
    tier: "Standard",
    tokensIn,
    tokensOut,
    cacheReadTokens,
    costFormatted: cost,
  };
}
