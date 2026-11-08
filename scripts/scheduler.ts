import { parseArgs } from "node:util";
import { SystemForgeAdapter, type IssueForgeAdapter } from "../apps/backend/src/registry/forge";
import { join, resolve } from "node:path";
import {
  loadScheduleConfig,
  runSchedulerTick,
  startSchedulerLoop,
  type BacklogCandidate,
  type SchedulerTickResult,
  type TickSkipReason,
} from "./loop/scheduler";
import { readIssueContract } from "./loop";
import { runAnimusLoop } from "./animus-loop";
import { readExecutionAuthority } from "@animus/contracts/execution-authority";
import { resolveProjectWorkspace } from "../packages/contracts/src/paths";
import { parseDependencies, isActiveClaim } from "../apps/backend/src/intake/parser";
import { initializeDatabase, ProjectRegistryService } from "../apps/backend/src/registry";
import { PlanService } from "../apps/backend/src/plans";
import { CommandLedger } from "../apps/backend/src/command/ledger";
import { BrakeService } from "../apps/backend/src/command/brakes";
import { ExecutionObservationService } from "../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../apps/backend/src/work/budget";
import { createLocalExecutionRuntime } from "../apps/backend/src/local-runtime";
import { assertInstallationNotHeldAtStateDir } from "@animus/contracts/installation-hold";
import {
  DispatchService,
  runLocalDispatchTick,
  type LocalDispatchTickResult,
} from "../apps/backend/src/dispatch";

export function parseSchedulerCliArgs(args: string[]): {
  once: boolean;
  dryRun: boolean;
  interval?: number;
} {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      once: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      interval: { type: "string" },
    },
  });

  const interval = values.interval ? Number(values.interval) : undefined;
  if (interval !== undefined && (!Number.isSafeInteger(interval) || interval <= 0)) {
    throw new Error("Interval must be a positive integer in seconds");
  }

  return {
    once: values.once ?? false,
    dryRun: values["dry-run"] ?? false,
    interval,
  };
}

export async function fetchGithubBacklog(
  _root: string,
  repo: string,
  adapter?: IssueForgeAdapter,
): Promise<{
  issues: BacklogCandidate[];
  closedNumbers: Set<number>;
}> {
  const forge = adapter ?? new SystemForgeAdapter();
  const rawOpen = await forge.listIssues(repo);
  const readyOpen = rawOpen.filter((item) =>
    (item.labels ?? []).some(
      (label) =>
        (typeof label === "string" ? label : label.name).toLowerCase() === "ready-for-agent",
    ),
  );

  const nativeDepsMap = new Map<number, number[]>();
  if (forge.getIssueDependencies) {
    for (const item of readyOpen) {
      const deps = await forge.getIssueDependencies(repo, item.number);
      if (deps && deps.length > 0) {
        nativeDepsMap.set(item.number, deps);
      }
    }
  }

  const issues: BacklogCandidate[] = readyOpen.map((item) => {
    const textDeps = parseDependencies(
      [item.body ?? "", ...(item.comments ?? []).map((comment) => comment.body ?? "")].join("\n"),
    );
    const nativeDeps = nativeDepsMap.get(item.number) ?? [];
    const allDeps = Array.from(new Set([...textDeps, ...nativeDeps]));

    return {
      number: item.number,
      title: item.title,
      state: item.state,
      labels: (item.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
      dependencies: allDeps,
      activeClaim: isActiveClaim(item.comments ?? [], item.body ?? ""),
    };
  });
  const openNumbers = new Set(rawOpen.map((issue) => issue.number));
  const dependencies = [...new Set(issues.flatMap((issue) => issue.dependencies))].filter(
    (number) => !openNumbers.has(number),
  );
  const states = new Map<number, string | null>();
  if (dependencies.length) {
    if (forge.getIssueStates) {
      for (const [number, state] of await forge.getIssueStates(repo, dependencies))
        states.set(number, state);
    } else {
      for (const number of dependencies)
        states.set(number, (await forge.getIssue(repo, number))?.state ?? null);
    }
  }
  const closedNumbers = new Set<number>();
  for (const [number, state] of states) if (state === "CLOSED") closedNumbers.add(number);
  return { issues, closedNumbers };
}

export function logTickResult(res: SchedulerTickResult): void {
  const time = new Date().toISOString();
  const triagePart = res.triage
    ? ` [triage: ${res.triage.status}${res.triage.reason ? ` (${res.triage.reason})` : ""}${res.triage.error ? ` (error: ${res.triage.error})` : ""}]`
    : "";
  if (res.action === "launched") {
    console.log(
      `[${time}] SCHEDULER LAUNCH: target=#${res.targetIssueNumber} runId=${res.runId} (active=${res.activeLapsCount}, admitted=${res.admittedIssuesCount})${triagePart}`,
    );
  } else {
    const detail = res.detail ? ` (${res.detail})` : res.error ? ` [ERROR: ${res.error}]` : "";
    console.log(
      `[${time}] SCHEDULER TICK: skipped reason=${res.reason} active=${res.activeLapsCount}${detail}${triagePart}`,
    );
  }
}

function toSchedulerTick(local: LocalDispatchTickResult): SchedulerTickResult {
  if (local.action === "launched") {
    return {
      action: "launched",
      reason: "launch_successful",
      targetIssueNumber: local.issueNumber,
      runId: local.runId,
      activeLapsCount: 0,
      detail: local.detail,
    };
  }
  const reasons: Record<string, TickSkipReason> = {
    no_active_projects: "no_admitted_issues",
    no_admitted_plans: "no_admitted_issues",
    no_eligible_work: "no_admitted_issues",
    dry_run: "no_admitted_issues",
    authority_not_activated: "no_admitted_issues",
    stop_brake_set: "stop_brake_set",
    pause_brake_set: "pause_brake_set",
    capacity_full: "capacity_full",
    launch_failed: "launch_failed",
  };
  return {
    action: "skipped",
    reason: reasons[local.reason] ?? "launch_failed",
    activeLapsCount: 0,
    detail: local.detail ?? local.reason,
    error: local.error,
  };
}

export { toSchedulerTick };

if (import.meta.main) {
  const authority = readExecutionAuthority();
  if (authority.authority !== "local") {
    console.log(
      JSON.stringify({
        action: "skipped",
        reason: "authority_not_activated",
        detail:
          "Local execution authority is not activated. Complete the validated #165 cutover before running the local scheduler.",
      }),
    );
  } else {
  let db: ReturnType<typeof initializeDatabase> | null = null;
  try {
    const { once, dryRun, interval } = parseSchedulerCliArgs(process.argv.slice(2));
    assertInstallationNotHeldAtStateDir();
    const root = resolve(import.meta.dir, "..");
    const workspace = resolveProjectWorkspace(root);

    db = initializeDatabase();
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
    });
    const runtime = createLocalExecutionRuntime({
      db,
      plans,
      dispatch,
      forge: registry.getForge(),
      observations,
      budget,
    });

    // Preserve interrupted/unknown ownership before a new scheduling tick.
    try {
      dispatch.reconcile();
    } catch {}

    const dispatchLocal = async (): Promise<SchedulerTickResult> =>
      toSchedulerTick(
        await runLocalDispatchTick({
          db: db!,
          registry,
          plans,
          dispatch,
          actor: "scheduler",
          dryRun,
          deliveryRuntime: runtime.delivery,
          finalDeliveryRuntime: runtime.final,
        }),
      );

    const emptyBacklog = async (): Promise<{
      issues: BacklogCandidate[];
      closedNumbers: Set<number>;
    }> => ({ issues: [], closedNumbers: new Set<number>() });
    const legacyLaunchDisabled = async (): Promise<{ runId: string }> => {
      throw new Error("Legacy GitHub launch path is disabled for local dispatch");
    };

    if (once) {
      const result = await runSchedulerTick({
        root,
        sharedRoot: workspace.primaryRoot,
        runsDir: workspace.runsDir,
        repo: "",
        config: interval ? { interval_seconds: interval } : undefined,
        brakes,
        fetchBacklog: emptyBacklog,
        launchLap: legacyLaunchDisabled,
        dispatchLocal,
      });
      logTickResult(result);
    } else {
      console.log(
        `Starting local plan scheduler (interval: ${interval ?? loadScheduleConfig(root).interval_seconds}s)...`,
      );
      console.log("Press Ctrl+C to stop.");

      const controller = new AbortController();
      process.once("SIGINT", () => {
        console.log("\nStopping scheduler...");
        controller.abort();
      });
      process.once("SIGTERM", () => {
        console.log("\nStopping scheduler...");
        controller.abort();
      });

      const loop = startSchedulerLoop({
        root,
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
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    try {
      db?.close();
    } catch {}
  }
  }
}
