import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getProjectRunsDir, resolveAnimusHome, getProjectSlug } from "../../packages/contracts/src/paths";
import { loadIssueDossier } from "./dossier";
import { reconcileWaitingApprovalPrCi, type GhRunner, type checkPrCiStatus } from "./ci";
import { runTriagePass } from "./triage";
import { resolveTriageStateRoot } from "./triage-state";

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

export interface SchedulerTriageStatus {
  status: "scheduled" | "inflight" | "skipped" | "completed" | "error";
  reason?: string;
  error?: string;
}

export interface TriagePassContext {
  root: string;
  repo: string;
  stateRoot: string;
}

export type TriagePassHandler = (context: TriagePassContext) => Promise<unknown>;

export interface BrakeChecker {
  isScheduledLaunchPermitted(projectId?: string | null): { permitted: boolean; reason?: string };
}

export interface SchedulerTickResult {
  action: "launched" | "skipped";
  reason: TickSkipReason | TickLaunchReason;
  targetIssueNumber?: number;
  runId?: string;
  activeLapsCount: number;
  admittedIssuesCount?: number;
  detail?: string;
  error?: string;
  triage?: SchedulerTriageStatus;
  triageStatus?: SchedulerTriageStatus["status"];
}

export const BLOCKING_LABELS = new Set([
  "needs-info",
  "ready-for-human",
  "needs-triage",
  "wontfix",
  "needs-owner",
]);
export function parseScheduleJson(filePath: string): Partial<ScheduleConfig> | null {
  if (!existsSync(filePath)) return null;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err: any) {
    throw new Error(`Malformed schedule config in '${filePath}': ${err?.message || "invalid JSON"}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid schedule config in '${filePath}': expected an object`);
  }

  if (raw.interval_seconds !== undefined && (!Number.isFinite(raw.interval_seconds) || raw.interval_seconds <= 0)) {
    throw new Error(`Invalid schedule interval in '${filePath}': must be a positive number`);
  }
  if (raw.parallel !== undefined && (!Number.isSafeInteger(raw.parallel) || raw.parallel <= 0)) {
    throw new Error(`Invalid schedule parallel capacity in '${filePath}': must be a positive integer`);
  }
  if (raw.max_laps !== undefined && (!Number.isSafeInteger(raw.max_laps) || raw.max_laps <= 0)) {
    throw new Error(`Invalid schedule max_laps in '${filePath}': must be a positive integer`);
  }

  if (raw.work_window !== undefined && raw.work_window !== null) {
    if (typeof raw.work_window !== "object" || Array.isArray(raw.work_window)) {
      throw new Error(`Invalid schedule work_window in '${filePath}': expected an object`);
    }
    const window = raw.work_window;
    if (window.enabled) {
      if (
        typeof window.start_time !== "string" ||
        typeof window.end_time !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start_time) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.end_time)
      ) {
        throw new Error(`Invalid schedule work window times in '${filePath}': expected HH:MM format`);
      }
      const tz = window.timezone || "Asia/Jakarta";
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
      } catch {
        throw new Error(`Invalid timezone in schedule config '${filePath}': '${tz}'`);
      }
    }
  }

  return {
    ...(typeof raw.workflow === "string" ? { workflow: raw.workflow } : {}),
    ...(typeof raw.parallel === "number" && raw.parallel > 0 ? { parallel: raw.parallel } : {}),
    ...(typeof raw.max_laps === "number" && raw.max_laps > 0 ? { max_laps: raw.max_laps } : {}),
    ...(typeof raw.interval_seconds === "number" && raw.interval_seconds > 0
      ? { interval_seconds: raw.interval_seconds }
      : {}),
    ...(typeof raw.inputs === "object" && raw.inputs !== null ? { inputs: raw.inputs } : {}),
    ...(typeof raw.work_window === "object" && raw.work_window !== null
      ? {
          work_window: {
            enabled: Boolean(raw.work_window.enabled),
            start_time: raw.work_window.start_time || "20:00",
            end_time: raw.work_window.end_time || "05:00",
            timezone: raw.work_window.timezone || "Asia/Jakarta",
          },
        }
      : {}),
  };
}

export function loadScheduleConfig(root: string): ScheduleConfig {
  const defaults: ScheduleConfig = {
    workflow: "animus-loop",
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

  const repoSchedule = parseScheduleJson(join(root, ".factory/schedule.json"));
  const userGlobal = parseScheduleJson(join(resolveAnimusHome(), "schedule.json"));
  const userProject = parseScheduleJson(
    join(resolveAnimusHome(), "projects", getProjectSlug(root), "schedule.json"),
  );

  return {
    ...defaults,
    ...repoSchedule,
    ...userGlobal,
    ...userProject,
    inputs: {
      ...defaults.inputs,
      ...repoSchedule?.inputs,
      ...userGlobal?.inputs,
      ...userProject?.inputs,
    },
    work_window: {
      enabled:
        userProject?.work_window?.enabled ??
        userGlobal?.work_window?.enabled ??
        repoSchedule?.work_window?.enabled ??
        defaults.work_window!.enabled,
      start_time:
        userProject?.work_window?.start_time ??
        userGlobal?.work_window?.start_time ??
        repoSchedule?.work_window?.start_time ??
        defaults.work_window!.start_time,
      end_time:
        userProject?.work_window?.end_time ??
        userGlobal?.work_window?.end_time ??
        repoSchedule?.work_window?.end_time ??
        defaults.work_window!.end_time,
      timezone:
        userProject?.work_window?.timezone ??
        userGlobal?.work_window?.timezone ??
        repoSchedule?.work_window?.timezone ??
        defaults.work_window!.timezone,
    },
  };
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
}
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
          if (typeof state.pid === "number" && !isProcessAlive(state.pid)) {
            continue;
          }
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
        if (
          state.status === "waiting_approval" ||
          state.status === "interrupted" ||
          state.status === "needs_owner"
        ) {
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

export function getMergedIssueNumbers(runsDir: string): Set<number> {
  const merged = new Set<number>();
  if (!existsSync(runsDir)) return merged;
  try {
    for (const entry of readdirSync(runsDir)) {
      const statePath = join(runsDir, entry, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        if (state.status === "merged") {
          const match = /\/issues\/(\d+)$/.exec(state.issue ?? "");
          if (match && match[1]) {
            merged.add(Number(match[1]));
          }
        }
      } catch {}
    }
  } catch {}
  return merged;
}

export interface FilterAdmittedIssuesOptions {
  waitingApprovalIssueNumbers?: Set<number>;
  mergedIssueNumbers?: Set<number>;
  stateRoot?: string;
  maxLaps?: number;
}

export function filterAdmittedIssues(
  issues: BacklogCandidate[],
  closedIssueNumbers: Set<number>,
  options: FilterAdmittedIssuesOptions = {},
): BacklogCandidate[] {
  const admitted: BacklogCandidate[] = [];
  const mergedSet =
    options.mergedIssueNumbers ??
    (options.stateRoot ? getMergedIssueNumbers(join(options.stateRoot, "runs")) : new Set<number>());

  for (const issue of issues) {
    if (issue.state.toUpperCase() !== "OPEN") continue;

    const normalizedLabels = issue.labels.map((l) => l.toLowerCase());
    const hasReady = normalizedLabels.includes("ready-for-agent");
    if (!hasReady) continue;

    const hasBlocker = normalizedLabels.some((l) => BLOCKING_LABELS.has(l));
    if (hasBlocker) continue;

    if (issue.activeClaim) continue;

    // Skip issues already delivered and waiting for human approval, already auto-merged, or escalated
    if (options.waitingApprovalIssueNumbers?.has(issue.number) || mergedSet.has(issue.number)) {
      continue;
    }

    // Skip issues that have reached or exceeded maxLaps in their issue dossier
    if (options.stateRoot && options.maxLaps !== undefined) {
      const dossier = loadIssueDossier(options.stateRoot, issue.number);
      if (dossier && dossier.attempts.length >= options.maxLaps) {
        continue;
      }
    }
    // Verify all dependencies are in closedIssueNumbers or mergedSet
    const allDepsSatisfied = issue.dependencies.every(
      (dep) => closedIssueNumbers.has(dep) || mergedSet.has(dep),
    );
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

export function detectRepo(root: string): string | undefined {
  try {
    const res = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], { cwd: root });
    if (res.exitCode === 0) {
      const url = res.stdout.toString().trim();
      const match = /(?:github\.com[:/]|git@github\.com:)([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
      if (match && match[1] && match[2]) {
        return `${match[1]}/${match[2]}`;
      }
    }
  } catch {}
  try {
    const res = Bun.spawnSync(["gh", "repo", "view", "--json", "nameWithOwner"], { cwd: root });
    if (res.exitCode === 0) {
      const data = JSON.parse(res.stdout.toString()) as { nameWithOwner?: string };
      if (data.nameWithOwner) return data.nameWithOwner;
    }
  } catch {}
  return undefined;
}

export async function defaultSafeTriagePass(context: TriagePassContext): Promise<unknown> {
  if (!context.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repo.trim())) {
    return {
      status: "skipped",
      reason: "no_repo_identity",
    };
  }
  return await runTriagePass({
    root: context.root,
    repo: context.repo,
    stateRoot: context.stateRoot,
  });
}

interface InFlightTriageEntry {
  promise: Promise<unknown>;
  status: "inflight" | "completed" | "error";
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  result?: unknown;
}

export interface TriageResultState {
  status: "completed" | "error" | "skipped" | "held";
  error?: string;
  reason?: string;
  counters?: {
    processed: number;
    success: number;
    failure: number;
    held: number;
    skipped: number;
  };
}

const inFlightTriageMap = new Map<string, InFlightTriageEntry>();
const lastTriageErrorMap = new Map<string, string>();
const lastTriageStateMap = new Map<string, TriageResultState>();

export function getInFlightTriage(root?: string): Promise<unknown> | null {
  if (root) {
    const key = resolve(root);
    const entry = inFlightTriageMap.get(key);
    return entry && entry.status === "inflight" ? entry.promise : null;
  }
  for (const entry of inFlightTriageMap.values()) {
    if (entry.status === "inflight") return entry.promise;
  }
  return null;
}

export function getLastTriageError(root: string): string | undefined {
  return lastTriageErrorMap.get(resolve(root));
}

export function getLastTriageState(root: string): TriageResultState | undefined {
  return lastTriageStateMap.get(resolve(root));
}

export function clearTriageTracking(root?: string): void {
  if (root) {
    const key = resolve(root);
    inFlightTriageMap.delete(key);
    lastTriageErrorMap.delete(key);
    lastTriageStateMap.delete(key);
  } else {
    inFlightTriageMap.clear();
    lastTriageErrorMap.clear();
    lastTriageStateMap.clear();
  }
}

export async function awaitInFlightTriage(root?: string): Promise<void> {
  if (root) {
    const key = resolve(root);
    const entry = inFlightTriageMap.get(key);
    if (entry && entry.status === "inflight") {
      try {
        await entry.promise;
      } catch {}
    }
  } else {
    const entries = Array.from(inFlightTriageMap.values()).filter((e) => e.status === "inflight");
    await Promise.all(entries.map((e) => e.promise.catch(() => {})));
  }
}

function dispatchTriagePass(params: {
  root: string;
  repo: string;
  stateRoot?: string;
  triageFn?: TriagePassHandler | null;
}): SchedulerTriageStatus {
  const key = resolve(params.root);

  // If triage is explicitly disabled with null
  if (params.triageFn === null) {
    const pendingError = lastTriageErrorMap.get(key);
    if (pendingError) {
      return {
        status: "error",
        error: pendingError,
        reason: "previous_triage_failed",
      };
    }
    return {
      status: "skipped",
      reason: "triage_disabled",
    };
  }

  // Check if there is already an in-flight pass for this root
  const existing = inFlightTriageMap.get(key);
  if (existing && existing.status === "inflight") {
    return {
      status: "inflight",
      reason: "triage_pass_already_in_flight",
    };
  }

  // Check if a previous background triage errored
  const pendingError = lastTriageErrorMap.get(key);
  if (pendingError) {
    return {
      status: "error",
      error: pendingError,
      reason: "previous_triage_failed",
    };
  }

  // If default triage and repo cannot be resolved, skip safely
  if (
    params.triageFn === undefined &&
    (!params.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(params.repo.trim()))
  ) {
    return {
      status: "skipped",
      reason: "no_repo_identity",
    };
  }

  const fn = params.triageFn ?? defaultSafeTriagePass;
  const triageStateRoot = resolveTriageStateRoot(params.root, params.stateRoot);

  // A new triage pass is starting: reset previous error/state
  lastTriageErrorMap.delete(key);
  lastTriageStateMap.delete(key);

  let rawPromise: Promise<unknown>;
  try {
    rawPromise = fn({
      root: params.root,
      repo: params.repo,
      stateRoot: triageStateRoot,
    });
  } catch (syncErr) {
    const errStr = syncErr instanceof Error ? syncErr.message : String(syncErr);
    lastTriageErrorMap.set(key, errStr);
    lastTriageStateMap.set(key, {
      status: "error",
      error: errStr,
      reason: "triage_launch_failed",
    });
    return {
      status: "error",
      error: errStr,
      reason: "triage_launch_failed",
    };
  }

  const entry: InFlightTriageEntry = {
    promise: Promise.resolve(),
    status: "inflight",
    startedAt: new Date(),
  };

  const trackedPromise = Promise.resolve(rawPromise)
    .then((res: any) => {
      entry.completedAt = new Date();
      entry.result = res;

      if (res && typeof res === "object") {
        const failureCount = typeof res.failureCount === "number" ? res.failureCount : 0;
        const heldCount = typeof res.heldCount === "number" ? res.heldCount : 0;
        const successCount = typeof res.successCount === "number" ? res.successCount : 0;
        const skippedCount = typeof res.skippedCount === "number" ? res.skippedCount : 0;
        const processedCount = Array.isArray(res.processed) ? res.processed.length : 0;

        if (failureCount > 0) {
          entry.status = "error";
          const firstErr = Array.isArray(res.processed)
            ? res.processed.find((p: any) => p.error)?.error
            : undefined;
          const errMsg = firstErr ?? `Triage pass failed for ${failureCount} issue(s)`;
          entry.error = errMsg;
          lastTriageErrorMap.set(key, errMsg);
          lastTriageStateMap.set(key, {
            status: "error",
            error: errMsg,
            reason: "triage_pass_failed",
            counters: {
              processed: processedCount,
              success: successCount,
              failure: failureCount,
              held: heldCount,
              skipped: skippedCount,
            },
          });
        } else if (res.status === "held" || (heldCount > 0 && successCount === 0 && processedCount > 0)) {
          entry.status = "completed";
          lastTriageStateMap.set(key, {
            status: "held",
            reason: res.reason ?? "triage_issues_held",
            counters: {
              processed: processedCount,
              success: successCount,
              failure: failureCount,
              held: heldCount,
              skipped: skippedCount,
            },
          });
        } else {
          entry.status = "completed";
          lastTriageStateMap.set(key, {
            status: "completed",
            counters: {
              processed: processedCount,
              success: successCount,
              failure: failureCount,
              held: heldCount,
              skipped: skippedCount,
            },
          });
        }
      } else {
        entry.status = "completed";
        lastTriageStateMap.set(key, { status: "completed" });
      }

      inFlightTriageMap.delete(key);
      return res;
    })
    .catch((err) => {
      const errStr = err instanceof Error ? err.message : String(err);
      entry.status = "error";
      entry.error = errStr;
      entry.completedAt = new Date();
      lastTriageErrorMap.set(key, errStr);
      lastTriageStateMap.set(key, {
        status: "error",
        error: errStr,
        reason: "triage_pass_threw",
      });
      inFlightTriageMap.delete(key);
      return undefined;
    });

  entry.promise = trackedPromise;
  inFlightTriageMap.set(key, entry);

  return {
    status: "scheduled",
  };
}

export interface SchedulerTickOptions {
  root: string;
  config?: Partial<ScheduleConfig>;
  sharedRoot?: string;
  now?: Date;
  runsDir?: string;
  stateRoot?: string;
  repo?: string;
  projectId?: string;
  brakes?: BrakeChecker;
  reconcileCi?: boolean;
  ghRun?: GhRunner;
  checkPrCi?: typeof checkPrCiStatus;
  triage?: TriagePassHandler | null;
  fetchBacklog: () => Promise<{ issues: BacklogCandidate[]; closedNumbers: Set<number> }>;
  launchLap: (issue: BacklogCandidate) => Promise<{ runId: string }>;
}

export async function runSchedulerTick(options: SchedulerTickOptions): Promise<SchedulerTickResult> {
  const { root, sharedRoot } = options;
  const mergedConfig: ScheduleConfig = {
    ...loadScheduleConfig(root),
    ...options.config,
  };

  // 1. Check file brakes (root and sharedRoot)
  const brake = checkBrakes(root, sharedRoot);
  if (brake.active) {
    const skipReason: TickSkipReason = brake.type === "stop" ? "stop_brake_set" : "pause_brake_set";
    return {
      action: "skipped",
      reason: skipReason,
      activeLapsCount: 0,
      detail: brake.path,
      triage: {
        status: "skipped",
        reason: skipReason,
      },
      triageStatus: "skipped",
    };
  }

  // 1b. Check BrakeService (if provided)
  const brakeService = options.brakes;
  if (brakeService) {
    let permitted: { permitted: boolean; reason?: string };
    try {
      permitted = brakeService.isScheduledLaunchPermitted(options.projectId);
    } catch {
      permitted = { permitted: false, reason: "brake_state_unknown" };
    }
    if (!permitted.permitted) {
      const skipReason: TickSkipReason =
        permitted.reason === "schedule_paused" ? "pause_brake_set" : "stop_brake_set";
      return {
        action: "skipped",
        reason: skipReason,
        activeLapsCount: 0,
        detail: permitted.reason ?? "brake_service_disallowed",
        triage: {
          status: "skipped",
          reason: skipReason,
        },
        triageStatus: "skipped",
      };
    }
  }

  // 2. Check work window
  if (!isWithinWorkWindow(mergedConfig.work_window, options.now)) {
    return {
      action: "skipped",
      reason: "outside_work_window",
      activeLapsCount: 0,
      detail: `Outside work window (${mergedConfig.work_window?.start_time}-${mergedConfig.work_window?.end_time} in ${mergedConfig.work_window?.timezone})`,
      triage: {
        status: "skipped",
        reason: "outside_work_window",
      },
      triageStatus: "skipped",
    };
  }

  // 3. Resolve runsDir, stateRoot, and repo
  const runsDir =
    options.runsDir ??
    (() => {
      if (process.env.ANIMUS_RUNS_DIR || process.env.ANIMUS_HOME) {
        return getProjectRunsDir(root);
      }
      try {
        const gitRes = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: root });
        if (gitRes.exitCode === 0) {
          const common = resolve(root, gitRes.stdout.toString().trim());
          const commonRuns = join(common, "factory-local-loop", "runs");
          if (existsSync(commonRuns)) return commonRuns;
        }
      } catch {}
      const projectRuns = getProjectRunsDir(root);
      if (existsSync(projectRuns)) return projectRuns;
      return join(root, ".factory-local-loop", "runs");
    })();

  const stateRoot = options.stateRoot ?? resolve(runsDir, "..");
  const repo = options.repo ?? detectRepo(root) ?? "";

  // 4. Reconcile PR CI status for runs waiting approval
  if (options.reconcileCi !== false) {
    try {
      await reconcileWaitingApprovalPrCi(runsDir, root, {
        ghRun: options.ghRun,
        maxLaps: mergedConfig.max_laps,
        checkPrCi: options.checkPrCi,
      });
    } catch (reconcileErr) {
      console.error("Warning: CI reconciliation failed:", reconcileErr);
    }
  }

  // 5. Dispatch non-blocking triage pass BEFORE builder capacity check so triage
  // executes regardless of builder capacity without blocking builder scheduling
  const triageResult = dispatchTriagePass({
    root,
    repo,
    stateRoot,
    triageFn: options.triage,
  });

  // 6. Check active builder laps & capacity
  const activeCount = countActiveLaps(runsDir);
  const waitingApprovalNumbers = getIssuesWaitingApproval(runsDir);
  const mergedNumbers = getMergedIssueNumbers(runsDir);
  if (activeCount >= mergedConfig.parallel) {
    return {
      action: "skipped",
      reason: "capacity_full",
      activeLapsCount: activeCount,
      detail: `Active laps (${activeCount}) reached parallel limit (${mergedConfig.parallel})`,
      triage: triageResult,
      triageStatus: triageResult.status,
    };
  }

  // 7. Fetch & filter backlog
  let backlog: { issues: BacklogCandidate[]; closedNumbers: Set<number> };
  try {
    backlog = await options.fetchBacklog();
  } catch (err) {
    return {
      action: "skipped",
      reason: "launch_failed",
      activeLapsCount: activeCount,
      error: `Failed to fetch backlog: ${String(err)}`,
      triage: triageResult,
      triageStatus: triageResult.status,
    };
  }

  const admitted = filterAdmittedIssues(backlog.issues, backlog.closedNumbers, {
    waitingApprovalIssueNumbers: waitingApprovalNumbers,
    mergedIssueNumbers: mergedNumbers,
    stateRoot,
    maxLaps: mergedConfig.max_laps,
  });
  if (admitted.length === 0) {
    return {
      action: "skipped",
      reason: "no_admitted_issues",
      activeLapsCount: activeCount,
      admittedIssuesCount: 0,
      triage: triageResult,
      triageStatus: triageResult.status,
    };
  }

  // 8. Select frontier issue
  const target = admitted[0]!;

  // 9. Launch lap
  try {
    const ack = await options.launchLap(target);
    return {
      action: "launched",
      reason: "launch_successful",
      targetIssueNumber: target.number,
      runId: ack.runId,
      activeLapsCount: activeCount + 1,
      admittedIssuesCount: admitted.length,
      triage: triageResult,
      triageStatus: triageResult.status,
    };
  } catch (err) {
    return {
      action: "skipped",
      reason: "launch_failed",
      targetIssueNumber: target.number,
      activeLapsCount: activeCount,
      admittedIssuesCount: admitted.length,
      error: err instanceof Error ? err.message : String(err),
      triage: triageResult,
      triageStatus: triageResult.status,
    };
  }
}

export interface SchedulerLoopOptions {
  root: string;
  config?: Partial<ScheduleConfig>;
  intervalMs?: number;
  runsDir?: string;
  stateRoot?: string;
  repo?: string;
  sharedRoot?: string;
  projectId?: string;
  brakes?: BrakeChecker;
  triage?: TriagePassHandler | null;
  awaitTriageOnStop?: boolean;
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
          stateRoot: options.stateRoot,
          repo: options.repo,
          sharedRoot: options.sharedRoot,
          projectId: options.projectId,
          brakes: options.brakes,
          triage: options.triage,
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

    if (options.awaitTriageOnStop !== false) {
      await awaitInFlightTriage(options.root);
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
