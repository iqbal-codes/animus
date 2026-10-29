import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
}

async function githubWorker(
  operation: string,
  root: string,
  repo: string,
  number?: number,
): Promise<unknown> {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
      operation,
      root,
      repo,
      String(number ?? ""),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`GitHub ${operation} failed: ${error.trim()}`);
    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadMonitorRuntime(
  overrides: {
    githubRead?: (args: string[], cwd: string) => unknown;
    fetchBacklog?: MonitorRuntime["fetchBacklog"];
    launch?: MonitorRuntime["launch"];
  } = {},
): Promise<MonitorRuntime> {
  // Resolve from the installed factory, never from a registered project's source tree.
  const factory = new URL("../../../../", import.meta.url);
  const [scheduler, loop, contracts, config] = await Promise.all([
    import(new URL("scripts/loop/scheduler.ts", factory).href),
    import(new URL("scripts/local-loop.ts", factory).href),
    import(new URL("scripts/loop.ts", factory).href),
    import(new URL("scripts/loop/config.ts", factory).href),
  ]);
  return {
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
      let raw: Record<string, any>;
      try {
        raw = JSON.parse(readFileSync(`${root}/.factory/schedule.json`, "utf-8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (
        raw.interval_seconds !== undefined &&
        (!Number.isFinite(raw.interval_seconds) || raw.interval_seconds <= 0)
      )
        throw new Error("Invalid schedule interval");
      if (raw.parallel !== undefined && (!Number.isSafeInteger(raw.parallel) || raw.parallel <= 0))
        throw new Error("Invalid schedule parallel capacity");
      if (raw.work_window?.enabled) {
        const window = raw.work_window;
        if (
          ![window.start_time, window.end_time].every(
            (time) => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
          )
        )
          throw new Error("Invalid schedule work window");
        new Intl.DateTimeFormat("en-US", { timeZone: window.timezone }).format();
      }
    },
    interval: (root) => scheduler.loadScheduleConfig(root).interval_seconds * 1000,
    schedule: scheduler.runSchedulerTick,
    fetchBacklog:
      overrides.fetchBacklog ??
      (async (root, repo) => {
        const data = (await githubWorker("backlog", root, repo)) as {
          issues: MonitorCandidate[];
          closedNumbers: number[];
        };
        return { ...data, closedNumbers: new Set(data.closedNumbers) };
      }),
    readContract: async (root, number, repo) =>
      overrides.githubRead
        ? contracts.readIssueContract(root, number, repo, overrides.githubRead)
        : ((await githubWorker("contract", root, repo, number)) as MonitorIssue),
    launch: overrides.launch ?? ((root, issue) => loop.runLocalLoop(root, issue, { push: true })),
  };
}
