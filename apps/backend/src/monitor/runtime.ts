import { readFileSync } from "node:fs";
import {
  resolveProjectWorkspace,
  loadCascadedScheduleConfig,
  countActiveLaps,
  isWithinWorkWindow,
  resolveTriageStateRoot,
} from "@animus/contracts/paths";
import { SystemForgeAdapter, type ForgeAdapter, type IssueForgeAdapter } from "../registry/forge";

export interface MonitorIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  comments: string[];
  dependencies: { number: number; state: string }[];
  activeClaim: boolean;
}
export interface MonitorCandidate {
  number: number;
  title?: string;
  state: string;
  labels: string[];
  dependencies: number[];
  activeClaim?: boolean;
}
export interface MonitorBacklog {
  issues: MonitorCandidate[];
  closedNumbers: Set<number>;
}
export interface MonitorTickResult {
  action: "launched" | "skipped";
  reason: string;
  targetIssueNumber?: number;
  runId?: string;
  activeLapsCount: number;
  admittedIssuesCount?: number;
  detail?: string;
  error?: string;
  triage?: {
    status: string;
    reason?: string;
    error?: string;
  };
}
export interface MonitorTriageOptions {
  root: string;
  repo: string;
  stateRoot: string;
  issueNumber?: number;
  dryRun?: boolean;
}
export interface MonitorTriageResult {
  processed: Array<{
    issueNumber: number;
    status: string;
    action?: string;
    reason?: string;
    error?: string;
  }>;
  skippedCount: number;
  successCount: number;
  failureCount: number;
  heldCount: number;
}
export interface MonitorRuntime {
  inspect(this: void, root: string): Promise<{ common: string; primary: string }>;
  setup(this: void, root: string): void;
  interval(this: void, root: string): number;
  schedule(
    this: void,
    options: {
      root: string;
      sharedRoot: string;
      runsDir: string;
      stateRoot?: string;
      repo?: string;
      projectId?: string;
      brakes?: any;
      triage?: any;
      fetchBacklog: () => Promise<MonitorBacklog>;
      launchLap: (issue: MonitorCandidate) => Promise<{ runId: string }>;
    },
  ): Promise<MonitorTickResult>;
  fetchBacklog(this: void, root: string, repo: string): Promise<MonitorBacklog>;
  readContract(this: void, root: string, number: number, repo: string): Promise<MonitorIssue>;
  launch(
    this: void,
    root: string,
    issue: MonitorIssue,
  ): Promise<{ runId: string; status: string; error?: string }>;
  hasCapacityFull?(this: void, root: string): boolean;
  triage?(this: void, options: MonitorTriageOptions): Promise<MonitorTriageResult>;
  checkWorkWindow?(this: void, root: string): boolean;
  resolveTriageStateRoot?(this: void, root: string, customStateRoot?: string): string;
}

export async function loadMonitorRuntime(
  overrides: {
    githubRead?: (args: string[], cwd: string) => unknown;
    fetchBacklog?: MonitorRuntime["fetchBacklog"];
    launch?: MonitorRuntime["launch"];
    hasCapacityFull?: MonitorRuntime["hasCapacityFull"];
    triage?: MonitorRuntime["triage"];
    forge?: ForgeAdapter | IssueForgeAdapter;
  } = {},
): Promise<MonitorRuntime> {
  // Resolve from the installed factory, never from a registered project's source tree.
  const factory = new URL("../../../../", import.meta.url);
  const [scheduler, loop, contracts, config, triageModule, backlogModule, processModule] =
    await Promise.all([
      import(new URL("scripts/loop/scheduler.ts", factory).href),
      import(new URL("scripts/local-loop.ts", factory).href),
      import(new URL("scripts/loop.ts", factory).href),
      import(new URL("scripts/loop/config.ts", factory).href),
      import(new URL("scripts/loop/triage.ts", factory).href),
      import(new URL("scripts/scheduler.ts", factory).href),
      import(new URL("scripts/loop/process.ts", factory).href),
    ]);
  const runtime: MonitorRuntime = {
    inspect: loop.inspectLocalLoop,
    setup(root) {
      const harness = JSON.parse(readFileSync(`${root}/harness/harness.config.json`, "utf-8"));
      const checks = [harness.static, harness.unit].filter(
        (value): value is string => typeof value === "string" && !!value.trim(),
      );
      if (
        !checks.length ||
        checks.some((value) => /^(?:true|:|echo(?:\s.*)?|exit\s+0)\s*;?$/.test(value.trim()))
      )
        throw new Error("Missing real ordinary project checks");
      for (const role of ["builder", "qa", "reviewer", "reflector"]) {
        if (!config.resolveModelForRole(root, role)?.trim())
          throw new Error(`Missing configured model for ${role}`);
      }
      // Malformed schedule data must not silently fall back to an unrestricted schedule.
      // Delegated to shared cascaded schedule config preflight
      loadCascadedScheduleConfig(root);
    },
    interval: (root) => scheduler.loadScheduleConfig(root).interval_seconds * 1000,
    schedule: scheduler.runSchedulerTick,
    fetchBacklog:
      overrides.fetchBacklog ??
      (async (root, repo) => {
        const forge = overrides.forge
          ? (overrides.forge as IssueForgeAdapter)
          : new SystemForgeAdapter();
        return await backlogModule.fetchGithubBacklog(root, repo, forge);
      }),
    readContract: async (root, number, repo) =>
      overrides.githubRead
        ? contracts.readIssueContract(root, number, repo, overrides.githubRead)
        : contracts.readIssueContract(root, number, repo),
    launch: overrides.launch ?? ((root, issue) => loop.runLocalLoop(root, issue, { push: true })),
    hasCapacityFull:
      overrides.hasCapacityFull ??
      ((root) => {
        const ws = resolveProjectWorkspace(root);
        const cfg = loadCascadedScheduleConfig(ws);
        const parallel = cfg.parallel ?? 1;
        return countActiveLaps(ws.runsDir) >= parallel;
      }),
    triage:
      overrides.triage ??
      (async (options) => {
        const canonicalStateRoot = resolveTriageStateRoot(options.root, options.stateRoot);
        const forge = overrides.forge
          ? (overrides.forge as IssueForgeAdapter)
          : new SystemForgeAdapter();
        const transport = (req: {
          argv: string[];
          cwd: string;
          timeoutMs?: number;
          env?: Record<string, string | undefined>;
        }) =>
          processModule.processRun(
            req.argv,
            req.cwd,
            req.timeoutMs,
            req.env as Record<string, string>,
            { manageSignals: false },
          );
        return await triageModule.runTriagePass({
          root: options.root,
          repo: options.repo,
          stateRoot: canonicalStateRoot,
          issueNumber: options.issueNumber,
          dryRun: options.dryRun,
          forge,
          transport,
        });
      }),
    checkWorkWindow: (root) => {
      const scheduleConfig = loadCascadedScheduleConfig(root);
      return isWithinWorkWindow(scheduleConfig.work_window);
    },
    resolveTriageStateRoot: (root, customStateRoot) =>
      resolveTriageStateRoot(root, customStateRoot),
  };
  return {
    ...runtime,
    inspect: (...args) =>
      processModule.withProcessPolicy({ manageSignals: false }, () => runtime.inspect(...args)),
    schedule: (...args) =>
      processModule.withProcessPolicy({ manageSignals: false }, () => runtime.schedule(...args)),
    fetchBacklog: (...args) =>
      processModule.withProcessPolicy({ manageSignals: false }, () =>
        runtime.fetchBacklog(...args),
      ),
    readContract: (...args) =>
      processModule.withProcessPolicy({ manageSignals: false }, () =>
        runtime.readContract(...args),
      ),
    launch: (...args) =>
      processModule.withProcessPolicy({ manageSignals: false }, () => runtime.launch(...args)),
    ...(runtime.triage
      ? {
          triage: (...args: Parameters<NonNullable<MonitorRuntime["triage"]>>) =>
            processModule.withProcessPolicy({ manageSignals: false }, () =>
              runtime.triage!(...args),
            ),
        }
      : {}),
  };
}
