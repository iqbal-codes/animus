import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import {
  loadScheduleConfig,
  runSchedulerTick,
  startSchedulerLoop,
  type BacklogCandidate,
  type SchedulerTickResult,
} from "./loop/scheduler";
import { readIssueContract } from "./loop";
import { runLocalLoop } from "./local-loop";
import { parseDependencies, isActiveClaim } from "../apps/backend/src/intake/parser";

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

export function fetchGithubBacklog(root: string, repo: string): {
  issues: BacklogCandidate[];
  closedNumbers: Set<number>;
} {
  const openRes = Bun.spawnSync(
    [
      "gh",
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,state,labels,body,comments",
    ],
    { cwd: root, timeout: 30_000 },
  );

  if (openRes.exitCode !== 0) {
    throw new Error(`GitHub open issue lookup failed: ${openRes.stderr.toString().trim()}`);
  }

  const closedRes = Bun.spawnSync(
    [
      "gh",
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "closed",
      "--limit",
      "200",
      "--json",
      "number",
    ],
    { cwd: root, timeout: 30_000 },
  );

  if (closedRes.exitCode !== 0) {
    throw new Error(`GitHub closed issue lookup failed: ${closedRes.stderr.toString().trim()}`);
  }

  const rawOpen = JSON.parse(openRes.stdout.toString()) as Array<{
    number: number;
    title: string;
    state: string;
    labels?: Array<{ name: string }>;
    body?: string;
    comments?: Array<{ body: string }>;
  }>;

  const rawClosed = JSON.parse(closedRes.stdout.toString()) as Array<{ number: number }>;
  const closedNumbers = new Set(rawClosed.map((c) => c.number));

  const issues: BacklogCandidate[] = rawOpen.map((item) => {
    const body = item.body ?? "";
    const comments = (item.comments ?? []).map((c) => c.body ?? "");
    const combinedText = [body, ...comments].join("\n");
    const dependencies = parseDependencies(combinedText);
    const activeClaim = isActiveClaim(item.comments ?? [], body);

    return {
      number: item.number,
      title: item.title,
      state: item.state,
      labels: (item.labels ?? []).map((l) => l.name),
      dependencies,
      activeClaim,
    };
  });

  return { issues, closedNumbers };
}

export function logTickResult(res: SchedulerTickResult): void {
  const time = new Date().toISOString();
  if (res.action === "launched") {
    console.log(
      `[${time}] SCHEDULER LAUNCH: target=#${res.targetIssueNumber} runId=${res.runId} (active=${res.activeLapsCount}, admitted=${res.admittedIssuesCount})`,
    );
  } else {
    const detail = res.detail ? ` (${res.detail})` : res.error ? ` [ERROR: ${res.error}]` : "";
    console.log(
      `[${time}] SCHEDULER TICK: skipped reason=${res.reason} active=${res.activeLapsCount}${detail}`,
    );
  }
}

if (import.meta.main) {
  try {
    const { once, dryRun, interval } = parseSchedulerCliArgs(process.argv.slice(2));
    const root = resolve(import.meta.dir, "..");

    const repoRes = Bun.spawnSync(["gh", "repo", "view", "--json", "nameWithOwner"], { cwd: root });
    if (repoRes.exitCode !== 0) {
      throw new Error("Unable to identify repository; ensure gh CLI is authenticated");
    }
    const repo = (JSON.parse(repoRes.stdout.toString()) as { nameWithOwner: string }).nameWithOwner;

    const gitCommonRes = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: root });
    const gitCommon = gitCommonRes.exitCode === 0 ? gitCommonRes.stdout.toString().trim() : ".git";
    const common = resolve(root, gitCommon);
    const sharedRoot = resolve(common, "..");
    const runsDir = join(common, "factory-local-loop", "runs");

    const fetchBacklog = async () => fetchGithubBacklog(root, repo);

    const launchLap = async (issue: BacklogCandidate): Promise<{ runId: string }> => {
      if (dryRun) {
        console.log(`[DRY-RUN] Would launch autonomous lap for issue #${issue.number}: ${issue.title}`);
        return { runId: `dry-run-issue-${issue.number}` };
      }

      console.log(`Launching autonomous lap for issue #${issue.number}...`);
      const contract = readIssueContract(root, issue.number, repo);
      const result = await runLocalLoop(root, contract, { push: true });
      return { runId: result.candidate || `issue-${issue.number}` };
    };

    if (once) {
      const result = await runSchedulerTick({
        root,
        sharedRoot,
        runsDir,
        config: interval ? { interval_seconds: interval } : undefined,
        fetchBacklog,
        launchLap,
      });
      logTickResult(result);
    } else {
      console.log(
        `Starting Factory Autonomous Scheduler (repository: ${repo}, interval: ${interval ?? loadScheduleConfig(root).interval_seconds}s)...`,
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
        sharedRoot,
        runsDir,
        config: interval ? { interval_seconds: interval } : undefined,
        intervalMs: interval ? interval * 1000 : undefined,
        fetchBacklog,
        launchLap,
        onTick: logTickResult,
        signal: controller.signal,
      });

      await loop.done;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
