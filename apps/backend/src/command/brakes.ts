import type { DatabaseSync } from "node:sqlite";
import type { GlobalBrakeState, ProjectBrakeState } from "@labq/contracts/operator";

interface BrakeRow {
  id: string;
  scope: "global" | "project";
  project_id: string | null;
  brake_type: "launch_brake" | "schedule_pause";
  active: number;
  reason: string | null;
  updated_by: string | null;
  updated_at: string;
}

export class BrakeService {
  constructor(private db: DatabaseSync) {}

  private getBrakeRow(
    scope: "global" | "project",
    brakeType: "launch_brake" | "schedule_pause",
    projectId?: string | null,
  ): BrakeRow | null {
    const id =
      scope === "global" ? `global:${brakeType}` : `project:${projectId ?? ""}:${brakeType}`;
    const row = this.db.prepare("SELECT * FROM brakes WHERE id = ?").get(id) as unknown as
      | BrakeRow
      | undefined;
    return row ?? null;
  }

  private setBrakeRow(params: {
    scope: "global" | "project";
    brakeType: "launch_brake" | "schedule_pause";
    projectId?: string | null;
    active: boolean;
    actor?: string;
    reason?: string;
  }): void {
    const id =
      params.scope === "global"
        ? `global:${params.brakeType}`
        : `project:${params.projectId ?? ""}:${params.brakeType}`;
    const now = new Date().toISOString();
    const activeInt = params.active ? 1 : 0;
    const actor = params.actor ?? "operator";
    const reason = params.reason ?? null;
    const projectId = params.scope === "global" ? null : (params.projectId ?? null);

    this.db
      .prepare(`
        INSERT INTO brakes (id, scope, project_id, brake_type, active, reason, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          active = excluded.active,
          reason = excluded.reason,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `)
      .run(id, params.scope, projectId, params.brakeType, activeInt, reason, actor, now);
  }

  getGlobalBrakeState(): GlobalBrakeState {
    const launchRow = this.getBrakeRow("global", "launch_brake");
    const scheduleRow = this.getBrakeRow("global", "schedule_pause");

    const launchActive = Boolean(launchRow?.active);
    const scheduleActive = Boolean(scheduleRow?.active);

    const latestUpdate =
      [launchRow?.updated_at, scheduleRow?.updated_at]
        .filter((d): d is string => Boolean(d))
        .sort((a, b) => a.localeCompare(b))
        .pop() ?? new Date().toISOString();

    return {
      global_launch_brake: launchActive,
      schedule_pause: scheduleActive,
      updated_at: latestUpdate,
    };
  }

  getProjectBrakeState(projectId: string): ProjectBrakeState {
    const globalState = this.getGlobalBrakeState();
    const projLaunchRow = this.getBrakeRow("project", "launch_brake", projectId);
    const projScheduleRow = this.getBrakeRow("project", "schedule_pause", projectId);

    const projLaunchActive = Boolean(projLaunchRow?.active);
    const projScheduleActive = Boolean(projScheduleRow?.active);

    const effectiveLaunch = globalState.global_launch_brake || projLaunchActive;
    const effectiveSchedule = globalState.schedule_pause || projScheduleActive;

    const latestUpdate =
      [globalState.updated_at, projLaunchRow?.updated_at, projScheduleRow?.updated_at]
        .filter((d): d is string => Boolean(d))
        .sort((a, b) => a.localeCompare(b))
        .pop() ?? new Date().toISOString();

    return {
      project_id: projectId,
      launch_brake: projLaunchActive,
      schedule_pause: projScheduleActive,
      effective_launch_brake: effectiveLaunch,
      effective_schedule_pause: effectiveSchedule,
      updated_at: latestUpdate,
    };
  }

  setGlobalLaunchBrake(active: boolean, actor?: string, reason?: string): GlobalBrakeState {
    this.setBrakeRow({
      scope: "global",
      brakeType: "launch_brake",
      active,
      actor,
      reason,
    });
    return this.getGlobalBrakeState();
  }

  setGlobalSchedulePause(active: boolean, actor?: string, reason?: string): GlobalBrakeState {
    this.setBrakeRow({
      scope: "global",
      brakeType: "schedule_pause",
      active,
      actor,
      reason,
    });
    return this.getGlobalBrakeState();
  }

  setProjectLaunchBrake(
    projectId: string,
    active: boolean,
    actor?: string,
    reason?: string,
  ): ProjectBrakeState {
    this.setBrakeRow({
      scope: "project",
      brakeType: "launch_brake",
      projectId,
      active,
      actor,
      reason,
    });
    return this.getProjectBrakeState(projectId);
  }

  setProjectSchedulePause(
    projectId: string,
    active: boolean,
    actor?: string,
    reason?: string,
  ): ProjectBrakeState {
    this.setBrakeRow({
      scope: "project",
      brakeType: "schedule_pause",
      projectId,
      active,
      actor,
      reason,
    });
    return this.getProjectBrakeState(projectId);
  }

  /**
   * Direct launch check.
   * Fails-closed if global brake active, project brake active, or brake state unknown.
   */
  isLaunchPermitted(projectId?: string | null): { permitted: boolean; reason?: string } {
    try {
      const globalLaunchRow = this.getBrakeRow("global", "launch_brake");
      if (globalLaunchRow?.active) {
        return { permitted: false, reason: "launch_brake_set" };
      }

      if (projectId) {
        const projLaunchRow = this.getBrakeRow("project", "launch_brake", projectId);
        if (projLaunchRow?.active) {
          return { permitted: false, reason: "launch_brake_set" };
        }
      }

      return { permitted: true };
    } catch {
      // Fail closed if brake state cannot be verified
      return { permitted: false, reason: "brake_state_unknown" };
    }
  }

  /**
   * Scheduled launch check.
   * Fails-closed if schedule is paused, launch brakes are active, or state is unknown.
   */
  isScheduledLaunchPermitted(projectId?: string | null): { permitted: boolean; reason?: string } {
    try {
      const globalScheduleRow = this.getBrakeRow("global", "schedule_pause");
      if (globalScheduleRow?.active) {
        return { permitted: false, reason: "schedule_paused" };
      }

      if (projectId) {
        const projScheduleRow = this.getBrakeRow("project", "schedule_pause", projectId);
        if (projScheduleRow?.active) {
          return { permitted: false, reason: "schedule_paused" };
        }
      }

      // Also check launch brakes
      return this.isLaunchPermitted(projectId);
    } catch {
      // Fail closed
      return { permitted: false, reason: "brake_state_unknown" };
    }
  }
}
