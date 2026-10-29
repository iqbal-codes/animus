import { mkdir, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrakeService } from "../command/brakes";
import { ProjectRegistryService } from "../registry/service";
import { ProjectOnboardingService, verifyRepositoryIdentity } from "../registry/onboarding";
import type { Project, ProjectMonitorStatus, MonitoringStatus } from "@labq/contracts/operator";
import type { MonitorRuntime } from "./runtime";

export class RegisteredProjectMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private stopped = false;
  private pending = new Map<string, Promise<void>>();
  private statuses = new Map<string, ProjectMonitorStatus>();
  private brakes: BrakeService;
  private intervalMs: number;
  private scan: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(
    private registry: ProjectRegistryService,
    private options: { runtime: MonitorRuntime; intervalMs?: number },
  ) {
    this.intervalMs = options.intervalMs ?? 1000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1)
      throw new Error("Monitor interval must be a positive integer in milliseconds");
    this.brakes = new BrakeService(registry.getDb());
  }

  status(): MonitoringStatus {
    const projects = this.registry.listProjects().map(
      (project) =>
        this.statuses.get(project.id) ?? {
          project_id: project.id,
          state: "idle" as const,
          reason:
            project.status === "active" ? "not_checked" : (project.status_reason ?? project.status),
          checked_at: null,
          next_check_at: null,
        },
    );
    return {
      enabled: this.enabled,
      stopping: this.stopped,
      interval_ms: this.intervalMs,
      error: this.lastError,
      projects,
    };
  }

  start(): void {
    if (this.enabled || this.stopped) return;
    this.enabled = true;
    const scan = async () => {
      try {
        await this.tick();
        this.lastError = null;
      } catch (error) {
        this.lastError = String(error);
      }
      if (this.enabled)
        this.timer = setTimeout(() => {
          void scan();
        }, this.intervalMs);
    };
    void scan();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.scan) return this.scan;
    this.scan = this.scanProjects();
    try {
      await this.scan;
    } finally {
      this.scan = null;
    }
  }

  private async scanProjects(): Promise<void> {
    for (const project of this.registry.listProjects()) {
      if (this.pending.has(project.id)) continue;
      const status = this.statuses.get(project.id);
      if (status?.next_check_at && Date.parse(status.next_check_at) > Date.now()) continue;
      const task = this.checkProject(project).finally(() => {
        this.pending.delete(project.id);
      });
      this.pending.set(project.id, task);
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending.values());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.scan) await this.scan;
    // In-flight laps finish safely. Stopping never abandons a live lock or starts another lap.
    await this.drain();
  }

  private assertDispatch(project: Project): void {
    if (this.stopped) throw new Error("monitor_stopped");
    const current = this.registry.getProject(project.id);
    if (
      current.status !== "active" ||
      current.checkout_path !== project.checkout_path ||
      current.repo_id !== project.repo_id
    )
      throw new Error("Project changed or held before dispatch");
    const gate = this.brakes.isScheduledLaunchPermitted(project.id);
    if (!gate.permitted) throw new Error(gate.reason ?? "brake_state_unknown");
  }

  private async verifyCheckout(project: Project): Promise<void> {
    const identity = await this.registry.getForge().detectLocalCheckout(project.checkout_path);
    verifyRepositoryIdentity(identity);
    if (
      identity.id !== project.repo_id ||
      identity.repoName.toLowerCase() !== project.repo_name.toLowerCase()
    )
      throw new Error("checkout_identity_mismatch");
  }

  private async checkProject(project: Project): Promise<void> {
    const status: ProjectMonitorStatus = {
      project_id: project.id,
      state: "running",
      reason: "checking",
      checked_at: new Date().toISOString(),
      next_check_at: null,
    };
    this.statuses.set(project.id, status);
    let lock: string | null = null;
    let interval = this.intervalMs;
    try {
      if (project.status !== "active") {
        status.state = "held";
        status.reason = project.status_reason ?? project.status;
        return;
      }
      if (this.registry.getActiveRunCount(project.id) > 0) {
        status.state = "held";
        status.reason = "project_has_active_runs";
        return;
      }
      const permitted = this.brakes.isScheduledLaunchPermitted(project.id);
      if (!permitted.permitted) {
        status.state = "skipped";
        status.reason = permitted.reason ?? "brake_state_unknown";
        return;
      }
      await this.verifyCheckout(project);
      const runtime = this.options.runtime;
      try {
        runtime.setup(project.checkout_path);
      } catch (error) {
        status.state = "held";
        status.reason = "setup_incomplete";
        status.error = String(error);
        return;
      }
      interval = runtime.interval(project.checkout_path);
      const { common, primary } = await runtime.inspect(project.checkout_path);
      const stateRoot = join(common, "factory-local-loop");
      await mkdir(stateRoot, { recursive: true });
      const candidateLock = join(stateRoot, "registered-project-monitor.lock");
      try {
        await mkdir(candidateLock);
        lock = candidateLock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        status.state = "skipped";
        status.reason = "project_locked";
        return;
      }
      this.assertDispatch(project);
      await new ProjectOnboardingService(this.registry).prepareLabels(project.repo_name);
      const result = await runtime.schedule({
        root: project.checkout_path,
        sharedRoot: primary,
        runsDir: join(stateRoot, "runs"),
        fetchBacklog: () => runtime.fetchBacklog(project.checkout_path, project.repo_name),
        launchLap: async (candidate) => {
          const issue = await runtime.readContract(
            project.checkout_path,
            candidate.number,
            project.repo_name,
          );
          await this.verifyCheckout(project);
          await runtime.inspect(project.checkout_path);
          runtime.setup(project.checkout_path);
          this.assertDispatch(project);
          status.reason = "lap_running";
          const trackingId = `monitor_${randomUUID()}`;
          this.registry.recordRun(trackingId, project.id);
          status.run_id = trackingId;
          status.run_status = "running";
          try {
            const result = await runtime.launch(project.checkout_path, issue);
            this.registry.completeTrackedRun(trackingId, result.runId, result.status);
            status.run_id = result.runId;
            status.run_status = result.status;
            if (result.error || result.status === "failed")
              throw new Error(result.error ?? "Local lap failed");
            return { runId: result.runId };
          } catch (error) {
            this.registry.updateRunStatus(trackingId, "failed");
            status.run_status = "failed";
            throw error;
          }
        },
      });
      status.tick = result;
      status.reason = result.reason;
      status.state =
        result.action === "launched" ? "completed" : result.error ? "error" : "skipped";
      if (result.error) status.error = result.error;
    } catch (error) {
      status.state = "error";
      status.reason = "monitor_check_failed";
      status.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (lock) {
        try {
          await rmdir(lock);
        } catch (error) {
          status.state = "error";
          status.reason = "lock_release_failed";
          status.error = String(error);
        }
      }
      status.next_check_at = new Date(Date.now() + interval).toISOString();
    }
  }
}
