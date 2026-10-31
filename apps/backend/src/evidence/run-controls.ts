import type { DatabaseSync } from "node:sqlite";
import type { RunCancellationSubmission, RunCancellationResult } from "@animus/contracts/operator";
import { EvidenceError } from "./errors";

export type ProcessTreeTerminator = (
  pids: number[],
  signal: "SIGTERM" | "SIGKILL",
) => Promise<{ killed: number[]; verifiedDead: boolean }>;

function defaultProcessTreeTerminator(
  pids: number[],
  signal: "SIGTERM" | "SIGKILL",
): Promise<{ killed: number[]; verifiedDead: boolean }> {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      killed.push(pid);
    } catch {
      // ESRCH: process already dead; EPERM: permission error
    }
  }

  // Verify dead via kill(pid, 0)
  let verifiedDead = true;
  for (const pid of pids) {
    try {
      process.kill(pid, 0); // test if process exists
      // If no exception, process is still alive!
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      try {
        process.kill(pid, 0);
        verifiedDead = false;
      } catch {
        // Now dead
      }
    } catch {
      // Process is dead
    }
  }

  return Promise.resolve({ killed, verifiedDead });
}

export class RunControlManager {
  constructor(private db: DatabaseSync) {}

  registerRunProcess(params: {
    runId: string;
    projectId: string;
    pid: number;
    childPids?: number[];
  }): void {
    const now = new Date().toISOString();
    const childPidsJson = JSON.stringify(params.childPids || []);

    this.db
      .prepare(
        `INSERT INTO run_processes (run_id, project_id, pid, child_pids, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)
         ON CONFLICT(run_id) DO UPDATE SET
           pid = excluded.pid,
           child_pids = excluded.child_pids,
           status = 'running'`,
      )
      .run(params.runId, params.projectId, params.pid, childPidsJson, now);
  }

  async cancelRun(
    submission: RunCancellationSubmission,
    options: {
      projectId: string;
      terminator?: ProcessTreeTerminator;
    },
  ): Promise<RunCancellationResult> {
    const { runId, signal } = submission;
    const { projectId } = options;

    // 1. Authorization & Scope Verification
    const row = this.db.prepare("SELECT * FROM run_processes WHERE run_id = ?").get(runId) as any;

    if (!row) {
      // Also check project_runs
      const runRow = this.db.prepare("SELECT * FROM project_runs WHERE id = ?").get(runId) as any;

      if (!runRow || runRow.project_id !== projectId) {
        throw new EvidenceError(
          "unauthorized_control",
          `Run control rejected: run '${runId}' does not belong to project '${projectId}' or is not authorized.`,
          { runId, projectId },
        );
      }

      // If run exists in project_runs but has no tracked process, it cannot be process-cancelled
      if (["completed", "failed", "cancelled", "stopped"].includes(runRow.status.toLowerCase())) {
        throw new EvidenceError(
          "run_not_cancellable",
          `Run '${runId}' is already in terminal status '${runRow.status}'.`,
          { runId, status: runRow.status },
        );
      }

      throw new EvidenceError(
        "operation_unsupported",
        `Run '${runId}' does not support process tree cancellation.`,
        { runId },
      );
    }

    if (row.project_id !== projectId) {
      throw new EvidenceError(
        "unauthorized_control",
        `Run control rejected: run '${runId}' belongs to project '${row.project_id}', not '${projectId}'.`,
        { runId, projectId, actualProjectId: row.project_id },
      );
    }

    // 2. Status verification
    if (["completed", "terminated", "cancelled", "failed"].includes(row.status)) {
      throw new EvidenceError(
        "run_not_cancellable",
        `Run '${runId}' is already in terminal state '${row.status}'.`,
        { runId, status: row.status },
      );
    }

    // 3. Child Process Hierarchy & Termination
    const pids: number[] = [row.pid];
    try {
      const childPids = JSON.parse(row.child_pids || "[]");
      if (Array.isArray(childPids)) {
        pids.push(...childPids);
      }
    } catch {}

    const terminator = options.terminator ?? defaultProcessTreeTerminator;
    const { killed, verifiedDead } = await terminator(pids, signal ?? "SIGTERM");

    if (!verifiedDead) {
      throw new EvidenceError(
        "process_tree_termination_failed",
        `Failed to verify termination of process tree for run '${runId}'. Some descendants are still active.`,
        { runId, pids, killed },
      );
    }

    // 4. Update status in database
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE run_processes SET status = 'cancelled', terminated_at = ? WHERE run_id = ?")
      .run(now, runId);

    // Also update project_runs truthfully to 'cancelled' (AC13 truthful status)
    this.db
      .prepare("UPDATE project_runs SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now, runId);

    return {
      success: true,
      runId,
      status: "cancelled",
      cleanupVerified: true,
      killedPids: killed,
    };
  }
}
