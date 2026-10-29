import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorkWindowConfig {
  enabled: boolean;
  start_time: string; // "HH:MM" 24h
  end_time: string; // "HH:MM" 24h
  timezone: string; // e.g. "Asia/Jakarta" or "UTC"
}

export interface ScheduleConfig {
  workflow: string;
  parallel: number;
  max_laps: number;
  interval_seconds: number;
  inputs?: Record<string, unknown>;
  work_window?: WorkWindowConfig;
}

export interface BacklogCandidate {
  number: number;
  title?: string;
  state: string; // "OPEN" | "CLOSED"
  labels: string[];
  dependencies: number[];
  activeClaim?: boolean;
}

export type TickSkipReason =
  | "stop_brake_set"
  | "pause_brake_set"
  | "outside_work_window"
  | "capacity_full"
  | "no_admitted_issues"
  | "launch_failed";

export type TickLaunchReason = "launch_successful";

export interface SchedulerTickResult {
  action: "launched" | "skipped";
  reason: TickSkipReason | TickLaunchReason;
  targetIssueNumber?: number;
  runId?: string;
  activeLapsCount: number;
  admittedIssuesCount?: number;
  detail?: string;
  error?: string;
}

export const BLOCKING_LABELS = new Set([
  "needs-info",
  "ready-for-human",
  "needs-triage",
  "wontfix",
  "needs-owner",
]);

export function loadScheduleConfig(root: string): ScheduleConfig {
  const schedulePath = join(root, ".factory/schedule.json");
  const defaults: ScheduleConfig = {
    workflow: "archon-loop",
    parallel: 1,
    max_laps: 3,
    interval_seconds: 300,
    inputs: { merge: "approve" },
    work_window: {
      enabled: false,
      start_time: "20:00",
      end_time: "05:00",
      timezone: "Asia/Jakarta",
    },
  };

  if (!existsSync(schedulePath)) return defaults;

  try {
    const raw = JSON.parse(readFileSync(schedulePath, "utf-8"));
    return {
      workflow: typeof raw.workflow === "string" ? raw.workflow : defaults.workflow,
      parallel: typeof raw.parallel === "number" && raw.parallel > 0 ? raw.parallel : defaults.parallel,
      max_laps: typeof raw.max_laps === "number" && raw.max_laps > 0 ? raw.max_laps : defaults.max_laps,
      interval_seconds:
        typeof raw.interval_seconds === "number" && raw.interval_seconds > 0
          ? raw.interval_seconds
          : defaults.interval_seconds,
      inputs: typeof raw.inputs === "object" && raw.inputs !== null ? raw.inputs : defaults.inputs,
      work_window:
        typeof raw.work_window === "object" && raw.work_window !== null
          ? {
              enabled: Boolean(raw.work_window.enabled),
              start_time: raw.work_window.start_time || "20:00",
              end_time: raw.work_window.end_time || "05:00",
              timezone: raw.work_window.timezone || "Asia/Jakarta",
            }
          : defaults.work_window,
    };
  } catch {
    return defaults;
  }
}

export function checkBrakes(
  root: string,
  sharedRoot?: string,
): { active: boolean; type?: "stop" | "pause"; path?: string } {
  const candidates: Array<{ path: string; type: "stop" | "pause" }> = [
    { path: join(root, ".factory/STOP"), type: "stop" },
    { path: join(root, ".factory/PAUSE"), type: "pause" },
  ];

  if (sharedRoot && sharedRoot !== root) {
    candidates.push(
      { path: join(sharedRoot, ".factory/STOP"), type: "stop" },
      { path: join(sharedRoot, ".factory/PAUSE"), type: "pause" },
    );
  }

  for (const c of candidates) {
    if (existsSync(c.path)) {
      return { active: true, type: c.type, path: c.path };
    }
  }

  return { active: false };
}

export function isWithinWorkWindow(window?: WorkWindowConfig, now = new Date()): boolean {
  if (!window || !window.enabled) return true;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: window.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const currentMinutes = hour * 60 + minute;

    const [startH, startM] = window.start_time.split(":").map(Number);
    const [endH, endM] = window.end_time.split(":").map(Number);
    const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
    const endMinutes = (endH ?? 0) * 60 + (endM ?? 0);

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Overnight window (e.g. 20:00 to 05:00)
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  } catch {
    // If timezone parsing fails, fail open
    return true;
  }
}

export function countActiveLaps(runsDir: string): number {
  if (!existsSync(runsDir)) return 0;
  let active = 0;
  try {
    for (const entry of readdirSync(runsDir)) {
      const statePath = join(runsDir, entry, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        if (
          state.status === "preparing" ||
          state.status === "building" ||
          state.status === "checking" ||
          state.status === "qa" ||
          state.status === "reviewing" ||
          state.status === "reflecting"
        ) {
          active++;
        }
      } catch {}
    }
  } catch {}
  return active;
}

export function getIssuesWaitingApproval(runsDir: string): Set<number> {
  const waiting = new Set<number>();
  if (!existsSync(runsDir)) return waiting;
  try {
    for (const entry of readdirSync(runsDir)) {
      const statePath = join(runsDir, entry, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        if (state.status === "waiting_approval") {
          const match = /\/issues\/(\d+)$/.exec(state.issue ?? "");
          if (match && match[1]) {
            waiting.add(Number(match[1]));
          }
        }
      } catch {}
    }
  } catch {}
  return waiting;
}

export interface FilterAdmittedIssuesOptions {
  waitingApprovalIssueNumbers?: Set<number>;
}

export function filterAdmittedIssues(
  issues: BacklogCandidate[],
  closedIssueNumbers: Set<number>,
  options: FilterAdmittedIssuesOptions = {},
): BacklogCandidate[] {
  const admitted: BacklogCandidate[] = [];

  for (const issue of issues) {
    if (issue.state.toUpperCase() !== "OPEN") continue;

    const normalizedLabels = issue.labels.map((l) => l.toLowerCase());
    const hasReady = normalizedLabels.includes("ready-for-agent");
    if (!hasReady) continue;

    const hasBlocker = normalizedLabels.some((l) => BLOCKING_LABELS.has(l));
    if (hasBlocker) continue;

    if (issue.activeClaim) continue;

    // Skip issues already delivered and waiting for human approval
    if (options.waitingApprovalIssueNumbers?.has(issue.number)) continue;

    // Verify all dependencies are in closedIssueNumbers
    const allDepsSatisfied = issue.dependencies.every((dep) => closedIssueNumbers.has(dep));
    if (!allDepsSatisfied) continue;

    admitted.push(issue);
  }

  // Sort deterministically: priority issues first, then lowest number
  return admitted.sort((a, b) => {
    const aPriority = a.labels.some((l) => l.toLowerCase() === "priority");
    const bPriority = b.labels.some((l) => l.toLowerCase() === "priority");
    if (aPriority && !bPriority) return -1;
    if (!aPriority && bPriority) return 1;
    return a.number - b.number;
  });
}

export interface SchedulerTickOptions {
  root: string;
  config?: Partial<ScheduleConfig>;
  sharedRoot?: string;
  now?: Date;
  runsDir?: string;
  fetchBacklog: () => Promise<{ issues: BacklogCandidate[]; closedNumbers: Set<number> }>;
  launchLap: (issue: BacklogCandidate) => Promise<{ runId: string }>;
}

export async function runSchedulerTick(options: SchedulerTickOptions): Promise<SchedulerTickResult> {
  const { root, sharedRoot } = options;
  const mergedConfig: ScheduleConfig = {
    ...loadScheduleConfig(root),
    ...options.config,
  };

  // 1. Check brakes
  const brake = checkBrakes(root, sharedRoot);
  if (brake.active) {
    return {
      action: "skipped",
      reason: brake.type === "stop" ? "stop_brake_set" : "pause_brake_set",
      activeLapsCount: 0,
      detail: brake.path,
    };
  }

  // 2. Check work window
  if (!isWithinWorkWindow(mergedConfig.work_window, options.now)) {
    return {
      action: "skipped",
      reason: "outside_work_window",
      activeLapsCount: 0,
      detail: `Outside work window (${mergedConfig.work_window?.start_time}-${mergedConfig.work_window?.end_time} in ${mergedConfig.work_window?.timezone})`,
    };
  }

  // 3. Count capacity & check waiting-approval items
  const runsDir = options.runsDir ?? join(root, ".factory-local-loop", "runs");
  const activeCount = countActiveLaps(runsDir);
  const waitingApprovalNumbers = getIssuesWaitingApproval(runsDir);
  if (activeCount >= mergedConfig.parallel) {
    return {
      action: "skipped",
      reason: "capacity_full",
      activeLapsCount: activeCount,
      detail: `Active laps (${activeCount}) reached parallel limit (${mergedConfig.parallel})`,
    };
  }

  // 4. Fetch & filter backlog
  let backlog: { issues: BacklogCandidate[]; closedNumbers: Set<number> };
  try {
    backlog = await options.fetchBacklog();
  } catch (err) {
    return {
      action: "skipped",
      reason: "launch_failed",
      activeLapsCount: activeCount,
      error: `Failed to fetch backlog: ${String(err)}`,
    };
  }

  const admitted = filterAdmittedIssues(backlog.issues, backlog.closedNumbers, {
    waitingApprovalIssueNumbers: waitingApprovalNumbers,
  });
  if (admitted.length === 0) {
    return {
      action: "skipped",
      reason: "no_admitted_issues",
      activeLapsCount: activeCount,
      admittedIssuesCount: 0,
    };
  }

  // 5. Select frontier issue
  const target = admitted[0]!;

  // 6. Launch lap
  try {
    const ack = await options.launchLap(target);
    return {
      action: "launched",
      reason: "launch_successful",
      targetIssueNumber: target.number,
      runId: ack.runId,
      activeLapsCount: activeCount + 1,
      admittedIssuesCount: admitted.length,
    };
  } catch (err) {
    return {
      action: "skipped",
      reason: "launch_failed",
      targetIssueNumber: target.number,
      activeLapsCount: activeCount,
      admittedIssuesCount: admitted.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SchedulerLoopOptions {
  root: string;
  config?: Partial<ScheduleConfig>;
  intervalMs?: number;
  runsDir?: string;
  sharedRoot?: string;
  fetchBacklog: () => Promise<{ issues: BacklogCandidate[]; closedNumbers: Set<number> }>;
  launchLap: (issue: BacklogCandidate) => Promise<{ runId: string }>;
  onTick?: (result: SchedulerTickResult) => void;
  signal?: AbortSignal;
}

export interface SchedulerLoopHandle {
  stop: () => void;
  done: Promise<void>;
}

export function startSchedulerLoop(options: SchedulerLoopOptions): SchedulerLoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerResolve: (() => void) | null = null;

  const controller = new AbortController();
  const cancelWait = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (timerResolve) {
      timerResolve();
      timerResolve = null;
    }
  };

  if (options.signal) {
    options.signal.addEventListener("abort", cancelWait);
  }

  const rootConfig = loadScheduleConfig(options.root);
  const interval =
    options.intervalMs ??
    (options.config?.interval_seconds ?? rootConfig.interval_seconds) * 1000;

  const done = (async () => {
    while (!stopped && !options.signal?.aborted) {
      try {
        const result = await runSchedulerTick({
          root: options.root,
          config: options.config,
          runsDir: options.runsDir,
          sharedRoot: options.sharedRoot,
          fetchBacklog: options.fetchBacklog,
          launchLap: options.launchLap,
        });

        if (options.onTick) {
          options.onTick(result);
        }
      } catch (err) {
        if (options.onTick) {
          options.onTick({
            action: "skipped",
            reason: "launch_failed",
            activeLapsCount: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (stopped || options.signal?.aborted) break;

      await new Promise<void>((resolve) => {
        timerResolve = resolve;
        timer = setTimeout(() => {
          timerResolve = null;
          resolve();
        }, interval);
      });
    }
  })();

  return {
    stop: () => {
      cancelWait();
      controller.abort();
    },
    done,
  };
}
