import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrakeService } from "../command/brakes";
import { ProjectRegistryService } from "../registry/service";
import { ProjectOnboardingService, verifyRepositoryIdentity } from "../registry/onboarding";
import type { Project, ProjectMonitorStatus, MonitoringStatus } from "@animus/contracts/operator";
import {
  resolveProjectWorkspace,
  evaluateWorkspacePreflight,
  isPidAlive,
} from "@animus/contracts/paths";
import type { MonitorRuntime } from "./runtime";

export class RegisteredProjectMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private stopped = false;
  private pending = new Map<string, Promise<void>>();
  private pendingWake = new Set<string>();
  private inFlightTriage = new Map<string, Promise<void>>();
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
    const projects = this.registry.listProjects().map((project) => {
      const existing = this.statuses.get(project.id);
      if (existing) {
        return {
          ...existing,
          pending_wake: this.pendingWake.has(project.id),
        };
      }
      return {
        project_id: project.id,
        state: "idle" as const,
        reason:
          project.status === "active" ? "not_checked" : (project.status_reason ?? project.status),
        checked_at: null,
        next_check_at: null,
        pending_wake: this.pendingWake.has(project.id),
      };
    });
    return {
      enabled: this.enabled,
      stopping: this.stopped,
      interval_ms: this.intervalMs,
      error: this.lastError,
      projects,
    };
  }

  isPendingWake(projectId: string): boolean {
    return this.pendingWake.has(projectId);
  }

  wakeProject(projectId: string): { triggered: boolean; pending_wake: boolean } {
    if (this.stopped) {
      return { triggered: false, pending_wake: false };
    }

    let project: Project;
    try {
      project = this.registry.getProject(projectId);
    } catch {
      return { triggered: false, pending_wake: false };
    }

    if (project.status !== "active") {
      return { triggered: false, pending_wake: false };
    }

    const isBusy =
      this.pending.has(projectId) ||
      this.registry.getActiveRunCount(projectId) > 0 ||
      this.hasCapacityFull(project.checkout_path);

    if (isBusy) {
      this.pendingWake.add(projectId);
      const current = this.statuses.get(projectId);
      if (current) {
        current.pending_wake = true;
        if (this.hasCapacityFull(project.checkout_path)) {
          current.reason = "capacity_full";
        }
      } else {
        this.statuses.set(projectId, {
          project_id: projectId,
          state: this.hasCapacityFull(project.checkout_path) ? "skipped" : "idle",
          reason: this.hasCapacityFull(project.checkout_path)
            ? "capacity_full"
            : this.registry.getActiveRunCount(projectId) > 0
              ? "project_has_active_runs"
              : "checking",
          checked_at: new Date().toISOString(),
          next_check_at: null,
          pending_wake: true,
        });
      }
      return { triggered: false, pending_wake: true };
    }

    const current = this.statuses.get(projectId);
    if (current) {
      current.next_check_at = null;
    }
    void this.triggerProjectCheck(project, true);
    return { triggered: true, pending_wake: false };
  }

  notifyLapFinished(projectId: string): void {
    if (this.stopped) return;
    if (this.pendingWake.has(projectId) && !this.pending.has(projectId)) {
      let project: Project;
      try {
        project = this.registry.getProject(projectId);
      } catch {
        return;
      }
      if (project.status === "active") {
        const current = this.statuses.get(projectId);
        if (current) {
          current.next_check_at = null;
        }
        this.pendingWake.delete(projectId);
        if (current) {
          current.pending_wake = false;
        }
        void this.triggerProjectCheck(project, false);
      }
    }
  }

  private hasCapacityFull(checkoutPath: string): boolean {
    if (this.options.runtime.hasCapacityFull) {
      try {
        return this.options.runtime.hasCapacityFull(checkoutPath);
      } catch {
        return false;
      }
    }
    return false;
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
      try {
        this.triggerTriage(project);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        let status = this.statuses.get(project.id);
        if (!status) {
          status = {
            project_id: project.id,
            state: "idle",
            reason: "checking",
            checked_at: null,
            next_check_at: null,
          };
          this.statuses.set(project.id, status);
        }
        status.triage = {
          state: "error",
          checked_at: new Date().toISOString(),
          error: errMsg,
        };
      }

      if (this.pending.has(project.id)) {
        continue;
      }
      const status = this.statuses.get(project.id);
      if (
        !this.pendingWake.has(project.id) &&
        status?.next_check_at &&
        Date.parse(status.next_check_at) > Date.now()
      )
        continue;
      void this.triggerProjectCheck(project, false);
    }
  }

  private triggerProjectCheck(project: Project, fromWake = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.pending.get(project.id);
    if (existing) return existing;

    const task = (async () => {
      try {
        await this.checkProject(project, fromWake);
      } finally {
        this.pending.delete(project.id);
        this.onCheckFinished(project);
      }
    })();
    this.pending.set(project.id, task);
    return task;
  }

  private onCheckFinished(project: Project): void {
    if (this.stopped) return;
    if (!this.pendingWake.has(project.id)) return;

    const status = this.statuses.get(project.id);
    if (status?.reason === "capacity_full") {
      return;
    }

    this.pendingWake.delete(project.id);
    if (status) {
      status.pending_wake = false;
      status.next_check_at = null;
    }
    void this.triggerProjectCheck(project, false);
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0 || this.inFlightTriage.size > 0) {
      await Promise.all([...this.pending.values(), ...this.inFlightTriage.values()]);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingWake.clear();
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

  private triggerTriage(project: Project): void {
    if (this.stopped) return;
    if (this.inFlightTriage.has(project.id)) {
      // Avoid duplicate per-project in-flight triage
      return;
    }

    const runtime = this.options.runtime;
    if (!runtime.triage) return;

    // Isolate all sync checks per project into caught status
    try {
      // Must verify current active registry before dispatch
      const currentProject = this.registry.getProject(project.id);
      if (!currentProject || currentProject.status !== "active") return;

      // Check checkout directory exists on disk
      if (!existsSync(project.checkout_path)) {
        return;
      }

      // Preflight: check filesystem brakes, relational brakes, and work window via unified preflight
      const preflight = evaluateWorkspacePreflight(project.checkout_path, {
        brakes: this.brakes,
        projectId: project.id,
        mode: "schedule",
        ignoreCapacity: true,
      });
      if (!preflight.ok) return;
    } catch (preErr) {
      const errMsg = preErr instanceof Error ? preErr.message : String(preErr);
      let status = this.statuses.get(project.id);
      if (!status) {
        status = {
          project_id: project.id,
          state: "idle",
          reason: "checking",
          checked_at: null,
          next_check_at: null,
        };
        this.statuses.set(project.id, status);
      }
      status.triage = {
        state: "error",
        checked_at: new Date().toISOString(),
        error: errMsg,
      };
      return;
    }

    let status = this.statuses.get(project.id);
    if (!status) {
      status = {
        project_id: project.id,
        state: "idle",
        reason: "checking",
        checked_at: null,
        next_check_at: null,
      };
      this.statuses.set(project.id, status);
    }

    status.triage = {
      state: "running",
      checked_at: new Date().toISOString(),
    };

    const triagePromise = (async () => {
      try {
        // Verify forge identity before dispatch
        await this.verifyCheckout(project);

        await runtime.inspect(project.checkout_path);

        // RECHECK EVERYTHING immediately before dispatch after awaits!
        if (this.stopped) return;

        // Current active registry
        const recheckProject = this.registry.getProject(project.id);
        if (!recheckProject || recheckProject.status !== "active") return;

        // Forge identity
        await this.verifyCheckout(project);

        // Recheck preflight immediately before dispatch
        const recheckPreflight = evaluateWorkspacePreflight(project.checkout_path, {
          brakes: this.brakes,
          projectId: project.id,
          mode: "schedule",
          ignoreCapacity: true,
        });
        if (!recheckPreflight.ok) return;

        const stateRoot = runtime.resolveTriageStateRoot
          ? runtime.resolveTriageStateRoot(project.checkout_path)
          : resolveProjectWorkspace(project.checkout_path).triageStateRoot;

        const result = await runtime.triage!({
          root: project.checkout_path,
          repo: project.repo_name,
          stateRoot,
        });

        const current = this.statuses.get(project.id);
        if (current) {
          if (result.failureCount > 0) {
            const firstErr =
              result.processed.find((p) => p.error)?.error ||
              `Triage failed for ${result.failureCount} issue(s)`;
            current.triage = {
              state: "error",
              checked_at: new Date().toISOString(),
              processed_count: result.processed.length,
              error: firstErr,
            };
          } else {
            current.triage = {
              state: "completed",
              checked_at: new Date().toISOString(),
              processed_count: result.processed.length,
            };
          }
        }
      } catch (error) {
        // Honest status errors inspectable no unhandled promises
        const current = this.statuses.get(project.id);
        const errMsg = error instanceof Error ? error.message : String(error);
        if (current) {
          current.triage = {
            state: "error",
            checked_at: new Date().toISOString(),
            error: errMsg,
          };
        }
      } finally {
        this.inFlightTriage.delete(project.id);
      }
    })();

    this.inFlightTriage.set(project.id, triagePromise);
  }

  private async checkProject(project: Project, fromWake = false): Promise<void> {
    const existing = this.statuses.get(project.id);
    const status: ProjectMonitorStatus = {
      project_id: project.id,
      state: "running",
      reason: "checking",
      checked_at: new Date().toISOString(),
      next_check_at: null,
      pending_wake: this.pendingWake.has(project.id),
      ...(existing?.triage ? { triage: existing.triage } : {}),
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
        if (fromWake) {
          this.pendingWake.add(project.id);
          status.pending_wake = true;
        }
        // Monitor must trigger triage even when registry.activeRunCount > 0
        this.triggerTriage(project);
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
      const { primary } = await runtime.inspect(project.checkout_path);

      // Trigger triage as a separate background operation
      this.triggerTriage(project);

      const workspace = resolveProjectWorkspace(project.checkout_path);
      const stateRoot = workspace.stateRoot;
      await mkdir(stateRoot, { recursive: true });
      const candidateLock = join(stateRoot, "registered-project-monitor.lock");
      const ownerPath = join(candidateLock, "owner.json");
      let acquired = false;
      try {
        await mkdir(candidateLock);
        await writeFile(
          ownerPath,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        );
        lock = candidateLock;
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        // Check stale lock ownership: only reclaim when owner.json has a dead PID (ESRCH).
        // If owner.json is missing or malformed, fail closed (age never proves dead).
        let isStale = false;
        try {
          if (existsSync(ownerPath)) {
            const raw = readFileSync(ownerPath, "utf-8");
            const owner = JSON.parse(raw);
            if (
              typeof owner.pid === "number" &&
              Number.isInteger(owner.pid) &&
              owner.pid > 0 &&
              !isPidAlive(owner.pid)
            ) {
              // Dead PID (ESRCH): safe to reclaim stale lock
              isStale = true;
            }
          }
        } catch {}

        if (isStale) {
          try {
            await rm(candidateLock, { recursive: true, force: true });
            await mkdir(candidateLock);
            await writeFile(
              ownerPath,
              JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
            );
            lock = candidateLock;
            acquired = true;
          } catch {}
        }

        if (!acquired) {
          status.state = "skipped";
          status.reason = "project_locked";
          if (fromWake) {
            this.pendingWake.add(project.id);
            status.pending_wake = true;
          }
          return;
        }
      }
      this.assertDispatch(project);
      await new ProjectOnboardingService(this.registry).prepareLabels(project.repo_name);
      const result = await runtime.schedule({
        root: project.checkout_path,
        sharedRoot: primary,
        runsDir: workspace.runsDir,
        stateRoot: workspace.stateRoot,
        repo: project.repo_name,
        projectId: project.id,
        brakes: this.brakes,
        triage: null,
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
      if (result.reason === "capacity_full") {
        this.pendingWake.add(project.id);
        status.pending_wake = true;
      }
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
          await rm(lock, { recursive: true, force: true });
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
