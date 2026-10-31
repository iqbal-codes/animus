import type {
  CommandRecord,
  CommandOutcome,
  CommandReconciliationResult,
} from "@animus/contracts/operator";
import type { CommandLedger } from "./ledger";

export interface LapReconciliationInfo {
  id: string;
  native_status: string;
  product_status: string;
  completed_at?: string | null;
}

export interface EngineReconciliationAdapter {
  getLap(lapId: string): Promise<LapReconciliationInfo | null>;
  listLaps(): Promise<LapReconciliationInfo[]>;
}

export interface ForgeReconciliationAdapter {
  checkPr(
    repoId: number,
    prNumber?: number,
  ): Promise<{ exists: boolean; merged: boolean; url?: string } | null>;
}

export class CommandReconciliationService {
  private isReconciling = false;

  constructor(
    private ledger: CommandLedger,
    private engineAdapter?: EngineReconciliationAdapter,
    private forgeAdapter?: ForgeReconciliationAdapter,
  ) {}

  async reconcile(): Promise<CommandReconciliationResult> {
    if (this.isReconciling) {
      return {
        reconciledCount: 0,
        commands: [],
        timestamp: new Date().toISOString(),
      };
    }
    this.isReconciling = true;
    try {
      const activeCommands = this.ledger.getActiveOrDispatchedCommands();
      const reconciledCommands: CommandRecord[] = [];
      const now = new Date().toISOString();

      for (const cmd of activeCommands) {
        if (cmd.action === "launch") {
          const reconciled = await this.reconcileLaunchCommand(cmd);
          reconciledCommands.push(reconciled);
        } else if (cmd.action === "promotion") {
          const reconciled = await this.reconcilePromotionCommand(cmd);
          reconciledCommands.push(reconciled);
        } else {
          // Unknown or custom action in dispatched state without handler
          const outcome: CommandOutcome = {
            state: "unknown",
            provenance: {
              source: "ledger_reconciliation",
              timestamp: now,
              details: `Unrecognized action ${cmd.action} pending manual reconciliation`,
            },
            error: "unrecognized_action",
          };
          const updated = this.ledger.markReconciled(cmd.requestId, outcome);
          reconciledCommands.push(updated);
        }
      }

      return {
        reconciledCount: reconciledCommands.length,
        commands: reconciledCommands,
        timestamp: now,
      };
    } finally {
      this.isReconciling = false;
    }
  }

  private async reconcileLaunchCommand(cmd: CommandRecord): Promise<CommandRecord> {
    const now = new Date().toISOString();

    if (!this.engineAdapter) {
      const outcome: CommandOutcome = {
        state: "unknown",
        provenance: {
          source: "backend",
          timestamp: now,
          details: "authority_unavailable",
        },
        error: "engine_adapter_not_configured",
      };
      return this.ledger.markReconciled(cmd.requestId, outcome);
    }

    // Determine target lapId from outcome ack or target
    let lapId = (cmd.target as any)?.lapId as string | undefined;
    const outcomeResult = cmd.outcome?.result as any;
    if (!lapId && outcomeResult?.id) {
      lapId = String(outcomeResult.id);
    }

    try {
      let lapInfo: LapReconciliationInfo | null = null;
      if (lapId) {
        lapInfo = await this.engineAdapter.getLap(lapId);
      } else {
        // Lap ID was not recorded prior to crash. Check list of laps
        const laps = await this.engineAdapter.listLaps();
        if (laps.length > 0) {
          const spec = (cmd.target as any)?.specification;
          if (spec) {
            const cmdTimeMs = new Date(cmd.timestamp).getTime();
            // Avoid matching historical runs from previous days/hours:
            // Lap must have started after or near this command's dispatch timestamp
            lapInfo =
              laps
                .filter((l) => {
                  const matchesSpec = (l as any).work_item === spec || l.id === spec;
                  if (!matchesSpec) return false;
                  const lapTime = (l as any).started_at || l.completed_at;
                  if (!lapTime) return true;
                  const lapTimeMs = new Date(lapTime).getTime();
                  return lapTimeMs >= cmdTimeMs - 60000;
                })
                .sort((a, b) => {
                  const tA = (a as any).started_at || a.completed_at || "";
                  const tB = (b as any).started_at || b.completed_at || "";
                  return tB.localeCompare(tA);
                })[0] ?? null;
          }
        }
      }

      if (lapInfo) {
        const native = lapInfo.native_status.toLowerCase();
        const product = lapInfo.product_status.toLowerCase();

        const isSuccess =
          Boolean(lapInfo.completed_at) ||
          native === "completed" ||
          native === "succeeded" ||
          product === "completed" ||
          product === "succeeded";

        const isFailed =
          native === "failed" ||
          native === "cancelled" ||
          native === "stopped" ||
          native === "refused" ||
          product === "failed" ||
          product === "stopped";

        if (isSuccess) {
          const evidenceLink = `/api/v1/laps/${encodeURIComponent(lapInfo.id)}/evidence`;
          const outcome: CommandOutcome = {
            state: "succeeded",
            provenance: {
              source: "engine_host",
              timestamp: now,
              details: `Reconciled from engine lap ${lapInfo.id} (${lapInfo.product_status})`,
            },
            result: { lapId: lapInfo.id, status: lapInfo.product_status },
          };
          return this.ledger.markReconciled(cmd.requestId, outcome, [evidenceLink]);
        }

        if (isFailed) {
          const outcome: CommandOutcome = {
            state: "failed",
            provenance: {
              source: "engine_host",
              timestamp: now,
              details: `Reconciled as failed from engine lap ${lapInfo.id} (${lapInfo.product_status})`,
            },
            error: "engine_lap_failed",
            result: { lapId: lapInfo.id, status: lapInfo.product_status },
          };
          return this.ledger.markReconciled(cmd.requestId, outcome);
        }

        // Running or pending
        const outcome: CommandOutcome = {
          state: "running",
          provenance: {
            source: "engine_host",
            timestamp: now,
            details: `Reconciled as running from engine lap ${lapInfo.id}`,
          },
          result: { lapId: lapInfo.id, status: lapInfo.product_status },
        };
        return this.ledger.markReconciled(cmd.requestId, outcome);
      }

      // Engine host is reachable, but lap does not exist on engine
      // DO NOT re-execute! Mark as failed.
      const outcome: CommandOutcome = {
        state: "failed",
        provenance: {
          source: "ledger_reconciliation",
          timestamp: now,
          details: "Command not found on engine host; avoiding duplicate dispatch",
        },
        error: "dispatch_unmaterialized",
      };
      return this.ledger.markReconciled(cmd.requestId, outcome);
    } catch {
      // External authority unavailable
      const outcome: CommandOutcome = {
        state: "unknown",
        provenance: {
          source: "engine_host",
          timestamp: now,
          details: "authority_unavailable",
        },
        error: "engine_host_unavailable",
      };
      return this.ledger.markReconciled(cmd.requestId, outcome);
    }
  }

  private async reconcilePromotionCommand(cmd: CommandRecord): Promise<CommandRecord> {
    const now = new Date().toISOString();

    if (!this.forgeAdapter) {
      const outcome: CommandOutcome = {
        state: "unknown",
        provenance: {
          source: "backend",
          timestamp: now,
          details: "authority_unavailable",
        },
        error: "forge_adapter_not_configured",
      };
      return this.ledger.markReconciled(cmd.requestId, outcome);
    }

    const repoId = (cmd.target as any)?.repoId as number | undefined;
    const prNumber = (cmd.target as any)?.prNumber as number | undefined;

    if (!repoId) {
      const outcome: CommandOutcome = {
        state: "failed",
        provenance: {
          source: "ledger_reconciliation",
          timestamp: now,
          details: "Missing repoId in promotion command target",
        },
        error: "invalid_command_target",
      };
      return this.ledger.markReconciled(cmd.requestId, outcome);
    }

    try {
      const prInfo = await this.forgeAdapter.checkPr(repoId, prNumber);
      if (prInfo?.exists) {
        const outcome: CommandOutcome = {
          state: "succeeded",
          provenance: {
            source: "github",
            timestamp: now,
            details: `Reconciled existing PR from GitHub: ${prInfo.url ?? "exists"}`,
          },
          result: prInfo,
        };
        return this.ledger.markReconciled(cmd.requestId, outcome, prInfo.url ? [prInfo.url] : []);
      }

      // Not found
      const outcome: CommandOutcome = {
        state: "failed",
        provenance: {
          source: "ledger_reconciliation",
          timestamp: now,
          details: "Promotion PR not found on GitHub",
        },
        error: "pr_not_found",
      };
      return this.ledger.markReconciled(cmd.requestId, outcome);
    } catch {
      const outcome: CommandOutcome = {
        state: "unknown",
        provenance: {
          source: "github",
          timestamp: now,
          details: "authority_unavailable",
        },
        error: "forge_unavailable",
      };
      return this.ledger.markReconciled(cmd.requestId, outcome);
    }
  }
}
