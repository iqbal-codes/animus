import { resolve } from "node:path";
import {
  LegacyLauncherRemovedError,
  readExecutionAuthority,
} from "@animus/contracts/execution-authority";
import { resolveProjectWorkspace } from "../../../packages/contracts/src/paths";
import { findRun, watchRun } from "../../loop-watch";
import { logTickResult, toSchedulerTick } from "../../scheduler";
import {
  DispatchService,
  runLocalDispatchTick,
  type DispatchEngineOptions,
} from "../../../apps/backend/src/dispatch";
import {
  initializeDatabase,
  ProjectRegistryService,
  SystemForgeAdapter,
} from "../../../apps/backend/src/registry";
import { PlanService } from "../../../apps/backend/src/plans";
import { CommandLedger } from "../../../apps/backend/src/command/ledger";
import { BrakeService } from "../../../apps/backend/src/command/brakes";
import { ExecutionObservationService } from "../../../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../../../apps/backend/src/work/budget";
import { createLocalExecutionRuntime } from "../../../apps/backend/src/local-runtime";
import { assertInstallationNotHeldAtStateDir } from "@animus/contracts/installation-hold";
import {
  loadScheduleConfig,
  runSchedulerTick,
  startSchedulerLoop,
  type BacklogCandidate,
} from "../../loop/scheduler";
import {
  bindEvidenceMapping,
  previewEvidenceCaptures,
  publishBoundEvidence,
  resolveRunDirectory,
} from "../../loop/evidence-manager";

export async function runLoopCliCommand(opts: {
  subcommand?: string;
  positionals: string[];
  repoRoot: string;
  issue?: string;
  run?: string;
  dryRun?: boolean;
  noPush?: boolean;
  once?: boolean;
  history?: boolean;
  json?: boolean;
  mapping?: string;
  publish?: boolean;
  candidate?: string;
}): Promise<number> {
  const sub = opts.subcommand;

  if (!sub) {
    const usage = [
      "Usage: animus loop <watch|evidence> [options]",
      "  watch     follow a local loop run directory (--issue <n> or --run <id>)",
      "  evidence  preview, bind or publish evidence for a run (--issue <n> or --run <id>)",
      "The legacy single-issue lap launcher is removed; dispatch an admitted plan instead.",
    ].join("\n");
    if (opts.json) console.log(JSON.stringify({ ok: false, error: usage }));
    else console.error(usage);
    return 1;
  }

  try {
    if (sub === "watch") {
      const rawIssue = opts.issue;
      if (rawIssue && (!/^[1-9]\d*$/.test(rawIssue) || !Number.isSafeInteger(Number(rawIssue)))) {
        throw new Error("Invalid issue number");
      }
      if (rawIssue && opts.run) {
        throw new Error("Use --issue or --run, not both");
      }
      const workspace = resolveProjectWorkspace(opts.repoRoot);
      const directory = await findRun(
        workspace.runsDir,
        rawIssue ? Number(rawIssue) : undefined,
        opts.run,
      );
      console.log(`Following ${directory}\nCtrl+C stops watching only.`);
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      await watchRun(directory, Boolean(opts.once), controller.signal, Boolean(opts.history));
      return 0;
    }

    if (sub === "evidence") {
      const rawIssue = opts.issue ?? opts.positionals[2];
      const issueNum = rawIssue && /^[1-9]\d*$/.test(rawIssue) ? Number(rawIssue) : undefined;
      const runDir = await resolveRunDirectory(opts.repoRoot, {
        runId: opts.run,
        issue: issueNum,
      });

      if (opts.mapping) {
        const mappingPath = resolve(opts.repoRoot, opts.mapping);
        const bound = bindEvidenceMapping({
          runDirectory: runDir,
          mappingFilePath: mappingPath,
          explicitCandidate: opts.candidate,
        });

        if (opts.publish) {
          const pubResult = await publishBoundEvidence({
            repoRoot: opts.repoRoot,
            runDirectory: runDir,
            noPush: opts.noPush,
          });
          if (opts.json) {
            console.log(JSON.stringify({ ok: true, bound, publish: pubResult }, null, 2));
          } else {
            console.log(
              `Bound ${bound.boundCount} capture(s) for candidate ${bound.candidate}.\n${pubResult.message}`,
            );
          }
          return pubResult.ok ? 0 : 1;
        }

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, bound }, null, 2));
        } else {
          console.log(
            `Bound ${bound.boundCount} capture(s) for candidate ${bound.candidate}. Run with --publish to update PR.`,
          );
        }
        return 0;
      }

      if (opts.publish) {
        const pubResult = await publishBoundEvidence({
          repoRoot: opts.repoRoot,
          runDirectory: runDir,
          noPush: opts.noPush,
        });
        if (opts.json) {
          console.log(JSON.stringify(pubResult, null, 2));
        } else {
          console.log(pubResult.message);
        }
        return pubResult.ok ? 0 : 1;
      }

      const preview = previewEvidenceCaptures(runDir);
      if (opts.json) {
        console.log(JSON.stringify(preview, null, 2));
      } else {
        console.log(preview.checklist.join("\n"));
      }
      return 0;
    }

    throw new Error(`Unknown loop subcommand: ${sub}. Expected watch or evidence.`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

export async function runLocalSchedulerCommand(
  opts: {
    repoRoot: string;
    once?: boolean;
    dryRun?: boolean;
    interval?: string;
    json?: boolean;
    engine?: DispatchEngineOptions;
  },
  interval: number | undefined,
): Promise<number> {
  assertInstallationNotHeldAtStateDir();
  const db = initializeDatabase();
  try {
    const registry = new ProjectRegistryService(db, new SystemForgeAdapter());
    const plans = new PlanService(db, registry.getForge());
    const brakes = new BrakeService(db);
    const observations = new ExecutionObservationService(db);
    const budget = new ExecutionBudgetService(db);
    const dispatch = new DispatchService(db, {
      plans,
      ledger: new CommandLedger(db),
      brakes,
      observations,
      budget,
      engine: opts.engine,
    });
    const runtime = createLocalExecutionRuntime({
      db,
      plans,
      dispatch,
      forge: registry.getForge(),
      observations,
      budget,
      ...(opts.engine
        ? {
            engine: {
              ...(opts.engine.transport ? { transport: opts.engine.transport } : {}),
              ...(opts.engine.provider ? { provider: opts.engine.provider } : {}),
              ...(opts.engine.model ? { model: opts.engine.model } : {}),
              ...(opts.engine.effort ? { effort: opts.engine.effort } : {}),
              ...(opts.engine.maxContinuations !== undefined
                ? { maxContinuations: opts.engine.maxContinuations }
                : {}),
            },
          }
        : {}),
    });
    try {
      dispatch.reconcile();
    } catch {}

    const workspace = resolveProjectWorkspace(opts.repoRoot);
    const dispatchLocal = async () =>
      toSchedulerTick(
        await runLocalDispatchTick({
          db,
          registry,
          plans,
          dispatch,
          actor: "scheduler",
          dryRun: opts.dryRun,
          deliveryRuntime: runtime.delivery,
          finalDeliveryRuntime: runtime.final,
        }),
      );
    const emptyBacklog = async (): Promise<{
      issues: BacklogCandidate[];
      closedNumbers: Set<number>;
    }> => ({ issues: [], closedNumbers: new Set<number>() });
    const legacyLaunchDisabled = async (): Promise<{ runId: string }> => {
      throw new LegacyLauncherRemovedError();
    };

    if (opts.once) {
      const result = await runSchedulerTick({
        root: opts.repoRoot,
        sharedRoot: workspace.primaryRoot,
        runsDir: workspace.runsDir,
        repo: "",
        config: interval ? { interval_seconds: interval } : undefined,
        brakes,
        fetchBacklog: emptyBacklog,
        launchLap: legacyLaunchDisabled,
        dispatchLocal,
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else logTickResult(result);
      return 0;
    }

    console.log(
      `Starting local plan scheduler (interval: ${interval ?? loadScheduleConfig(opts.repoRoot).interval_seconds}s)...`,
    );
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    const loop = startSchedulerLoop({
      root: opts.repoRoot,
      sharedRoot: workspace.primaryRoot,
      runsDir: workspace.runsDir,
      repo: "",
      config: interval ? { interval_seconds: interval } : undefined,
      intervalMs: interval ? interval * 1000 : undefined,
      brakes,
      fetchBacklog: emptyBacklog,
      launchLap: legacyLaunchDisabled,
      dispatchLocal,
      onTick: logTickResult,
      signal: controller.signal,
    });
    await loop.done;
    return 0;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

export async function runSchedulerCliCommand(opts: {
  repoRoot: string;
  once?: boolean;
  dryRun?: boolean;
  interval?: string;
  json?: boolean;
  engine?: DispatchEngineOptions;
}): Promise<number> {
  try {
    const interval = opts.interval ? Number(opts.interval) : undefined;
    if (interval !== undefined && (!Number.isSafeInteger(interval) || interval <= 0)) {
      throw new Error("Interval must be a positive integer in seconds");
    }

    assertInstallationNotHeldAtStateDir();
    // A single mutually exclusive authority: once the validated local authority is
    // active this command never resolves a GitHub repository or fetches backlog.
    const authority = readExecutionAuthority().authority;
    if (authority === "migrating") {
      throw new Error(
        "execution_authority_moved: the installation is fenced for the validated #165 cutover; finish or abort it before scheduling",
      );
    }
    if (authority !== "local") {
      throw new LegacyLauncherRemovedError();
    }
    return await runLocalSchedulerCommand(opts, interval);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}
