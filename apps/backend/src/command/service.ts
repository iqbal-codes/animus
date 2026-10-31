import type { DatabaseSync } from "node:sqlite";
import type {
  CommandRecord,
  CommandSubmission,
  CommandOutcome,
  CommandReconciliationResult,
  BackupResult,
  OperatorErrorCode,
} from "@animus/contracts/operator";
import { applyCommandMigrations } from "./db";
import { CommandLedger, CommandStorageError } from "./ledger";
import { BrakeService } from "./brakes";
import {
  CommandReconciliationService,
  type EngineReconciliationAdapter,
  type ForgeReconciliationAdapter,
} from "./reconciliation";

export class CommandError extends Error {
  constructor(
    public readonly code: OperatorErrorCode,
    public readonly commandRecord?: CommandRecord,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CommandError";
  }
}

export interface DispatchExecutionResult {
  result?: unknown;
  error?: string;
  evidenceLinks?: string[];
  partial?: boolean;
  state?: "acknowledged" | "succeeded" | "failed" | "partial" | "unknown";
}

export class CommandService {
  public readonly ledger: CommandLedger;
  public readonly brakes: BrakeService;
  public readonly reconciliation: CommandReconciliationService;

  constructor(
    private db: DatabaseSync,
    options?: {
      engineAdapter?: EngineReconciliationAdapter;
      forgeAdapter?: ForgeReconciliationAdapter;
    },
  ) {
    applyCommandMigrations(db);
    this.ledger = new CommandLedger(db);
    this.brakes = new BrakeService(db);
    this.reconciliation = new CommandReconciliationService(
      this.ledger,
      options?.engineAdapter,
      options?.forgeAdapter,
    );
  }

  async dispatch(
    submission: CommandSubmission,
    executor: (cmd: CommandRecord) => Promise<DispatchExecutionResult>,
    options?: { isScheduled?: boolean },
  ): Promise<CommandRecord> {
    const isLaunch = submission.action === "launch";

    // 1. Check brakes fail-closed
    if (isLaunch) {
      const brakeCheck = options?.isScheduled
        ? this.brakes.isScheduledLaunchPermitted(submission.projectId)
        : this.brakes.isLaunchPermitted(submission.projectId);

      if (!brakeCheck.permitted) {
        const reason = brakeCheck.reason ?? "launch_brake_set";
        let rejected: CommandRecord | undefined;
        try {
          rejected = this.ledger.recordRejection({
            requestId: submission.requestId,
            actor: submission.actor,
            projectId: submission.projectId,
            action: submission.action,
            target: submission.target,
            reason,
          });
        } catch (err) {
          throw new CommandError(
            "storage_failed",
            undefined,
            err instanceof Error ? err.message : String(err),
          );
        }
        const errCode = (
          reason === "schedule_paused"
            ? "schedule_paused"
            : reason === "brake_state_unknown"
              ? "brake_state_unknown"
              : "launch_brake_set"
        ) as OperatorErrorCode;
        throw new CommandError(errCode, rejected);
      }
    }

    // 2. Durable write to SQLite WAL before dispatch (AC1 / Invariant 1)
    let commandRecord: CommandRecord;
    try {
      commandRecord = this.ledger.recordBeforeDispatch({
        requestId: submission.requestId,
        actor: submission.actor,
        projectId: submission.projectId,
        action: submission.action,
        target: submission.target,
      });
    } catch (err) {
      if (err instanceof CommandStorageError) {
        throw new CommandError("storage_failed", undefined, err.message);
      }
      throw new CommandError("storage_failed", undefined, String(err));
    }

    // 3. Dispatch to executor
    const now = new Date().toISOString();
    try {
      const execResult = await executor(commandRecord);

      if (execResult.error) {
        const outcomeState = execResult.state ?? (execResult.partial ? "partial" : "failed");
        const outcome: CommandOutcome = {
          state: outcomeState,
          provenance: {
            source: outcomeState === "unknown" ? "backend" : "engine_host",
            timestamp: now,
            actor: submission.actor,
            details: execResult.error,
          },
          error: execResult.error,
          result: execResult.result,
        };
        return this.ledger.updateOutcome(
          commandRecord.requestId,
          outcome,
          execResult.evidenceLinks,
        );
      }

      const outcomeState = execResult.state ?? (isLaunch ? "acknowledged" : "succeeded");
      const outcome: CommandOutcome = {
        state: outcomeState,
        provenance: {
          source: "engine_host",
          timestamp: now,
          actor: submission.actor,
        },
        result: execResult.result,
      };
      return this.ledger.updateOutcome(commandRecord.requestId, outcome, execResult.evidenceLinks);
    } catch (err: any) {
      const isTimeout =
        err?.name === "TimeoutError" ||
        err?.name === "AbortError" ||
        err?.message?.toLowerCase().includes("timeout") ||
        err?.message?.toLowerCase().includes("aborted");

      if (isTimeout) {
        // AC3: Timeouts result in unknown/partial pending reconciliation
        const outcome: CommandOutcome = {
          state: "unknown",
          provenance: {
            source: "backend",
            timestamp: now,
            actor: submission.actor,
            details: "dispatch_timeout",
          },
          error: "dispatch_timeout",
        };
        this.ledger.updateOutcome(commandRecord.requestId, outcome);
        throw new CommandError(
          "host_unavailable",
          this.ledger.getCommand(commandRecord.requestId)!,
          "Timeout awaiting dispatch acknowledgment",
        );
      }

      const outcome: CommandOutcome = {
        state: "failed",
        provenance: {
          source: "backend",
          timestamp: now,
          actor: submission.actor,
          details: err?.message ?? String(err),
        },
        error: err?.message ?? "dispatch_failed",
      };
      this.ledger.updateOutcome(commandRecord.requestId, outcome);
      throw err;
    }
  }

  getCommand(requestId: string): CommandRecord | null {
    return this.ledger.getCommand(requestId);
  }

  listCommands(opts?: {
    projectId?: string | null;
    state?: CommandRecord["state"];
    limit?: number;
  }): CommandRecord[] {
    return this.ledger.listCommands(opts);
  }

  async reconcile(): Promise<CommandReconciliationResult> {
    return this.reconciliation.reconcile();
  }

  backupDatabase(destinationPath: string): BackupResult {
    try {
      this.ledger.backup(destinationPath);
      return {
        success: true,
        destinationPath,
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      throw new CommandError("backup_failed", undefined, err?.message ?? String(err));
    }
  }
}
