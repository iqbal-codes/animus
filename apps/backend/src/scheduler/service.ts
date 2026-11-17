import { loadCascadedScheduleConfig } from "@animus/contracts/paths";
import type { ExecutionAuthority } from "@animus/contracts/execution-authority";

export interface SchedulerProject {
  id: string;
  status: string;
  checkout_path: string;
}

export interface SchedulerProjects {
  listProjects(): SchedulerProject[];
}

export interface SchedulerIntake {
  evaluateProjectBacklog(projectId: string, forceRefresh?: boolean): Promise<unknown>;
}

export interface BackendSchedulerOptions {
  projects: SchedulerProjects;
  intake: SchedulerIntake;
  authority: () => ExecutionAuthority;
  /** Global frozen-plan tick: advances delivery (remote CI, publication, integration) and dispatches. */
  dispatchLocal: () => Promise<unknown>;
  /** Per-project override; otherwise the project's `interval_seconds` decides. */
  intervalMs?: number;
  /** How often due projects are looked for. Local work only. */
  scanIntervalMs?: number;
  now?: () => number;
  onCycle?: (cycle: SchedulerCycle) => void;
}

export interface SchedulerCycle {
  at: string;
  projects: Array<{ project_id: string; intake_count: number | null; error: string | null }>;
  dispatch: string | null;
  authority: ExecutionAuthority;
}

export interface ProjectScheduleStatus {
  project_id: string;
  last_checked_at: string | null;
  next_check_at: string | null;
  last_error: string | null;
}

const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_MS = 1_000;

/**
 * Periodic GitHub work for the backend: refresh each project's intake (issues,
 * admission, canonical plan fast-track) and run the frozen-plan dispatch tick so
 * delivery stages re-read remote CI and advance. It never selects work from the
 * GitHub backlog and never launches a lap.
 */
export class BackendScheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private readonly nextDue = new Map<string, number>();
  private readonly statuses = new Map<string, ProjectScheduleStatus>();
  private readonly scanIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: BackendSchedulerOptions) {
    this.scanIntervalMs = Math.max(1, options.scanIntervalMs ?? 1_000);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.scanIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.inFlight) await this.inFlight;
  }

  status(): ProjectScheduleStatus[] {
    return [...this.statuses.values()].map((entry) => ({ ...entry }));
  }

  /** Runs every project whose interval elapsed, then one global dispatch tick. */
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped) return Promise.resolve();
    this.inFlight = this.runCycle().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCycle(): Promise<void> {
    const nowMs = this.now();
    const due = this.options.projects
      .listProjects()
      .filter((project) => project.status === "active")
      .filter((project) => nowMs >= (this.nextDue.get(project.id) ?? 0));
    if (due.length === 0) return;

    const projects: SchedulerCycle["projects"] = [];
    for (const project of due) {
      const interval = this.intervalFor(project.checkout_path);
      this.nextDue.set(project.id, nowMs + interval);
      const status = this.statusFor(project.id);
      status.last_checked_at = new Date(nowMs).toISOString();
      status.next_check_at = new Date(nowMs + interval).toISOString();
      try {
        const result = await this.options.intake.evaluateProjectBacklog(project.id, true);
        const count = readTotalCount(result);
        status.last_error = null;
        projects.push({ project_id: project.id, intake_count: count, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.last_error = message;
        projects.push({ project_id: project.id, intake_count: null, error: message });
      }
    }

    const authority = this.options.authority();
    let dispatch: string | null = null;
    if (authority === "local") {
      try {
        dispatch = readDispatchReason(await this.options.dispatchLocal());
        if (dispatch === "launch_successful") {
          console.log(
            JSON.stringify({
              event: "backend_scheduler",
              status: "dispatched",
              at: new Date(nowMs).toISOString(),
            }),
          );
        }
      } catch (error) {
        dispatch = `failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(
          JSON.stringify({
            event: "backend_scheduler",
            status: "dispatch_failed",
            error: dispatch,
          }),
        );
      }
    } else {
      dispatch = `skipped: ${authority}_authority`;
    }

    this.options.onCycle?.({
      at: new Date(nowMs).toISOString(),
      projects,
      dispatch,
      authority,
    });
  }

  private intervalFor(checkoutPath: string): number {
    if (this.options.intervalMs !== undefined) {
      return Math.max(MIN_INTERVAL_MS, this.options.intervalMs);
    }
    const env = Number(process.env.FACTORY_SCHEDULER_INTERVAL_MS);
    if (Number.isFinite(env) && env > 0) return Math.max(MIN_INTERVAL_MS, env);
    let seconds = DEFAULT_INTERVAL_SECONDS;
    try {
      seconds =
        loadCascadedScheduleConfig(checkoutPath).interval_seconds ?? DEFAULT_INTERVAL_SECONDS;
    } catch {
      // An unreadable schedule must not stop GitHub checks; the default applies.
    }
    return Math.max(MIN_INTERVAL_MS, seconds * 1_000);
  }

  private statusFor(projectId: string): ProjectScheduleStatus {
    const existing = this.statuses.get(projectId);
    if (existing) return existing;
    const created: ProjectScheduleStatus = {
      project_id: projectId,
      last_checked_at: null,
      next_check_at: null,
      last_error: null,
    };
    this.statuses.set(projectId, created);
    return created;
  }
}

function readTotalCount(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("total_count" in value)) return null;
  const total = value.total_count;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

function readDispatchReason(value: unknown): string {
  if (typeof value !== "object" || value === null) return "done";
  if ("error" in value && typeof value.error === "string" && value.error.trim() !== "") {
    return `error: ${value.error}`;
  }
  if ("reason" in value && typeof value.reason === "string" && value.reason.trim() !== "") {
    return value.reason;
  }
  if ("action" in value && typeof value.action === "string" && value.action.trim() !== "") {
    return value.action;
  }
  return "done";
}
