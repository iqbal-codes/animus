import type {
  Diagnostics,
  WorkflowCatalog,
  LapSummary,
  LapDetail,
  LapEvidence,
  LaunchAck,
  LaunchSubmission,
  ControlState,
  ControlAction,
} from "./operator";

export interface SyntheticEngineOptions {
  status?: "healthy" | "degraded" | "unavailable";
  revision?: string;
  digest?: string;
  sourceDirectory?: string;
  workflows?: Array<{
    name: string;
    description: string;
    default_inputs?: Record<string, string>;
  }>;
  laps?: LapSummary[];
}

export class SyntheticEngineAdapter {
  private status: "healthy" | "degraded" | "unavailable";
  private revision: string;
  private digest: string;
  private sourceDirectory: string;
  private workflows: Array<{
    name: string;
    description: string;
    default_inputs?: Record<string, string>;
  }>;
  private laps: Map<string, LapSummary> = new Map();
  private reports: Map<string, string> = new Map();
  private controlState: ControlState = {
    halted: false,
    paused: false,
    active_brake: "none",
    updated_at: new Date().toISOString(),
  };

  constructor(opts: SyntheticEngineOptions = {}) {
    this.status = opts.status ?? "healthy";
    this.revision = opts.revision ?? "5c4f5e484262185926b37b070457fabb9bfedae0";
    this.digest = opts.digest ?? "synthetic-engine-digest-0000000000000000";
    this.sourceDirectory = opts.sourceDirectory ?? ".animus/workflows/sdlc";
    this.workflows = opts.workflows ?? [
      {
        name: "animus-loop",
        description: "Synthetic Animus Loop workflow for offline tests",
        default_inputs: { merge: "approve" },
      },
    ];

    if (opts.laps) {
      for (const lap of opts.laps) {
        this.laps.set(lap.id, lap);
      }
    }
  }

  getDiagnostics(): Diagnostics {
    return {
      status: this.status,
      revision_required: this.revision,
      digest: this.digest,
      captured_at: new Date().toISOString(),
      source_directory: this.sourceDirectory,
      file_count: 42,
      default_workflows_loaded: this.status === "healthy",
    };
  }

  getCatalog(): WorkflowCatalog {
    return {
      workflows: [...this.workflows],
    };
  }

  getLaps(): LapSummary[] {
    return Array.from(this.laps.values());
  }

  getLapDetail(lapId: string): LapDetail {
    const lap = this.laps.get(lapId);
    if (!lap) {
      throw new Error("lap_not_found");
    }

    return {
      ...lap,
      source_commit: lap.candidate_head,
      session: {
        conversation_id: `session-synthetic-${lap.id}`,
        working_path: `/tmp/animus-worktree-${lap.id}`,
        agents: [
          { node_name: "builder", session_id: `agent-builder-${lap.id}` },
          { node_name: "reviewer", session_id: `agent-reviewer-${lap.id}` },
        ],
      },
      tokens: { in: 1000, out: 500, cache_read: 200, cost_usd: 0.05 },
    };
  }

  getLapEvidence(lapId: string): LapEvidence {
    const detail = this.getLapDetail(lapId);
    return {
      id: detail.id,
      workflow_name: detail.workflow_name,
      candidate_head: detail.candidate_head || "a7338e65fa30a37748d0acde86a6fc6c0fc3ba49",
      runtime_verification: {
        status: "verified",
        verdict: "PASS",
        lines: [{ id: "ac1", kind: "behavior", verdict: "PASS" }],
        holdout: { verdict: "PASS", lines: [] },
      },
      peer_review: {
        status: "ready",
        sha: detail.candidate_head || "a7338e65fa30a37748d0acde86a6fc6c0fc3ba49",
        outcome: "approved",
        independent: true,
        reviewer_session: "session-review-synthetic",
        blocking_findings: 0,
        report: {
          available: true,
          path: "reviewer/report.md",
          url: `/api/v1/laps/${encodeURIComponent(detail.id)}/evidence/report`,
        },
      },
    };
  }

  getLapReport(lapId: string): string {
    const report = this.reports.get(lapId);
    if (!report) {
      return `# Synthetic Review Report for Lap ${lapId}\n\nOutcome: Approved\nBlocking findings: 0`;
    }
    return report;
  }

  launchLap(submission: LaunchSubmission): LaunchAck {
    if (this.controlState.halted || this.controlState.paused) {
      throw new Error("launch_brake_set");
    }

    if (!submission.specification || submission.specification.trim() === "") {
      throw new Error("invalid_payload");
    }

    const lapId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `synthetic-lap-${Date.now()}`;
    const now = new Date().toISOString();
    const summary: LapSummary = {
      id: lapId,
      workflow_name: "animus-loop",
      native_status: "running",
      product_status: "running",
      started_at: now,
      completed_at: null,
      last_activity_at: now,
      candidate_head: "a7338e65fa30a37748d0acde86a6fc6c0fc3ba49",
      work_item: submission.specification,
      pull_request: null,
      transitions: [],
    };

    this.laps.set(lapId, summary);
    return {
      id: lapId,
      status: "pending",
    };
  }

  getControlState(): ControlState {
    return { ...this.controlState };
  }

  applyControl(action: ControlAction): ControlState {
    switch (action) {
      case "halt":
        this.controlState.halted = true;
        break;
      case "unhalt":
        this.controlState.halted = false;
        break;
      case "pause":
        this.controlState.paused = true;
        break;
      case "unpause":
        this.controlState.paused = false;
        break;
      default:
        throw new Error("invalid_payload");
    }

    if (this.controlState.halted && this.controlState.paused) {
      this.controlState.active_brake = "both";
    } else if (this.controlState.halted) {
      this.controlState.active_brake = "stop";
    } else if (this.controlState.paused) {
      this.controlState.active_brake = "pause";
    } else {
      this.controlState.active_brake = "none";
    }

    this.controlState.updated_at = new Date().toISOString();
    return { ...this.controlState };
  }
}
