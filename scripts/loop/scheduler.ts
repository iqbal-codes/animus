import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type WorkWindowConfig,
  type ScheduleConfig,
  type RelationalBrakeChecker,
  getProjectRunsDir,
  resolveAnimusHome,
  getProjectSlug,
  resolveProjectWorkspace,
  evaluateWorkspacePreflight,
  parseScheduleJson,
  loadScheduleConfig,
  loadCascadedScheduleConfig,
  checkBrakes,
  checkWorkspaceBrakes,
  isWithinWorkWindow,
  isPidAlive,
  countActiveLaps,
  getIssuesWaitingApproval,
  getMergedIssueNumbers,
} from "../../packages/contracts/src/paths";
import { loadIssueDossier } from "./dossier";
import { reconcileWaitingApprovalPrCi, type GhRunner, type checkPrCiStatus } from "./ci";
import { runTriagePass } from "./triage";
import { resolveTriageStateRoot } from "./triage-state";
import {
  evaluateIssueAdmission,
  readRunStates,
  readVerifiedBranchIntegrations,
  type RawIssue,
} from "../../apps/backend/src/intake/admission";

export type BrakeChecker = RelationalBrakeChecker;

export {
  type WorkWindowConfig,
  type ScheduleConfig,
  parseScheduleJson,
  loadScheduleConfig,
  loadCascadedScheduleConfig,
  checkBrakes,
  checkWorkspaceBrakes,
  isWithinWorkWindow,
  isPidAlive,
  countActiveLaps,
  getIssuesWaitingApproval,
  getMergedIssueNumbers,
};

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

export interface FilterAdmittedIssuesOptions {
  waitingApprovalIssueNumbers?: Set<number>;
  mergedIssueNumbers?: Set<number>;
  stateRoot?: string;
  maxLaps?: number;
  runsDir?: string;
  dossiersDir?: string;
  runStates?: Map<number, string>;
  db?: any;
  dbPath?: string;
  projectId?: string;
  root?: string;
}

export function filterAdmittedIssues(
  issues: BacklogCandidate[],
  closedIssueNumbers: Set<number>,
  options: FilterAdmittedIssuesOptions = {},
): BacklogCandidate[] {
  const runsDir =
    options.runsDir ??
    (options.stateRoot ? join(options.stateRoot, "runs") : undefined);
  const runStates =
    options.runStates ?? (runsDir ? readRunStates(runsDir) : new Map<number, string>());
  const mergedSet =
    options.mergedIssueNumbers ??
    (runsDir ? getMergedIssueNumbers(runsDir) : new Set<number>());
  const waitingApprovalSet =
    options.waitingApprovalIssueNumbers ??
    (runsDir ? getIssuesWaitingApproval(runsDir) : new Set<number>());

  const verifiedIntegrations = readVerifiedBranchIntegrations({
    db: options.db,
    dbPath: options.dbPath,
    projectId: options.projectId,
    root: options.root,
  });

  const rawIssues: RawIssue[] = issues.map((c) => ({
    number: c.number,
    title: c.title,
    state: c.state,
    labels: c.labels,
    dependencies: c.dependencies,
    activeClaim: c.activeClaim,
  }));

  const allByNumber = new Map<number, RawIssue>();
  for (const n of closedIssueNumbers) {
    allByNumber.set(n, { number: n, title: "", state: "CLOSED" });
  }

  const candidateMap = new Map(issues.map((i) => [i.number, i]));
  const admitted: BacklogCandidate[] = [];

  for (const raw of rawIssues) {
    const evaluated = evaluateIssueAdmission(raw, allByNumber, {
      closedIssueNumbers,
      mergedIssueNumbers: mergedSet,
      waitingApprovalIssueNumbers: waitingApprovalSet,
      runStates,
      runsDir,
      stateRoot: options.stateRoot,
      dossiersDir: options.dossiersDir,
      maxLaps: options.maxLaps,
      integratedBranchIssues: verifiedIntegrations,
    });
    if (evaluated.admission_status === "admitted") {
      const candidate = candidateMap.get(raw.number);
      if (candidate) admitted.push(candidate);
    }
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
  db?: any;
  dbPath?: string;
}

export async function runSchedulerTick(options: SchedulerTickOptions): Promise<SchedulerTickResult> {
  const { root, sharedRoot } = options;
  const workspace = resolveProjectWorkspace(root, {
    stateRoot: options.stateRoot,
    customRunsDir: options.runsDir,
  });

  // Evaluate operational readiness preflight (brakes, cascaded schedule, work window)
  const preflight = evaluateWorkspacePreflight(workspace, {
    brakes: options.brakes,
    projectId: options.projectId,
    config: options.config,
    now: options.now,
    mode: "schedule",
    ignoreCapacity: true, // We dispatch triage before checking capacity
  });

  if (!preflight.ok) {
    let skipReason: TickSkipReason;
    if (preflight.reason === "stop_brake_set" || preflight.reason === "launch_brake_set") {
      skipReason = "stop_brake_set";
    } else if (preflight.reason === "pause_brake_set" || preflight.reason === "schedule_paused") {
      skipReason = "pause_brake_set";
    } else if (preflight.reason === "outside_work_window") {
      skipReason = "outside_work_window";
    } else {
      skipReason = "stop_brake_set";
    }

    return {
      action: "skipped",
      reason: skipReason,
      activeLapsCount: 0,
      detail: preflight.detail,
      triage: {
        status: "skipped",
        reason: skipReason,
      },
      triageStatus: "skipped",
    };
  }

  const mergedConfig = preflight.schedule;
  const runsDir = options.runsDir ?? workspace.runsDir;
  const stateRoot = options.stateRoot ?? workspace.stateRoot;
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

  // 6. Check active builder laps & capacity across candidate run directories
  const candidateRunsDirs = [runsDir, ...(workspace.fallbackRunsDirs ?? [])];
  let activeCount = 0;
  const waitingApprovalNumbers = new Set<number>();
  const mergedNumbers = new Set<number>();
  for (const dir of candidateRunsDirs) {
    if (existsSync(dir)) {
      activeCount += countActiveLaps(dir);
      for (const n of getIssuesWaitingApproval(dir)) waitingApprovalNumbers.add(n);
      for (const n of getMergedIssueNumbers(dir)) mergedNumbers.add(n);
    }
  }
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
    runsDir,
    stateRoot,
    maxLaps: mergedConfig.max_laps,
    db: options.db,
    dbPath: options.dbPath,
    projectId: options.projectId,
    root,
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
