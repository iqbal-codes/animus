import { join, resolve } from "node:path";
import { githubJson, issueSpecification, readIssueContract } from "../../loop";
import { inspectLocalLoop, runLocalLoop } from "../../local-loop";
import { findRun, watchRun } from "../../loop-watch";
import { fetchGithubBacklog, logTickResult } from "../../scheduler";
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
  const sub = opts.subcommand ?? "run";

  try {
    if (sub === "run") {
      const rawIssue = opts.issue ?? opts.positionals[2];
      if (!rawIssue || !/^[1-9]\d*$/.test(rawIssue)) {
        throw new Error(
          "Usage: factory loop run --issue <positive issue number> [--dry-run] [--no-push]",
        );
      }
      const issueNum = Number(rawIssue);
      const repository = githubJson(["repo", "view", "--json", "nameWithOwner"], opts.repoRoot) as {
        nameWithOwner?: string;
      };
      if (!repository.nameWithOwner) throw new Error("Unable to identify repository");
      const contract = readIssueContract(opts.repoRoot, issueNum, repository.nameWithOwner);
      const local = await inspectLocalLoop(opts.repoRoot);

      if (opts.dryRun) {
        console.log(
          JSON.stringify(
            {
              dryRun: true,
              engine: "local-pi",
              repository: repository.nameWithOwner,
              issue: contract,
              merge: "approve",
              model: process.env.FACTORY_LOOP_MODEL || "Pi configured default",
              stateDirectory: resolve(local.common, "factory-local-loop"),
              specification: issueSpecification(contract.url),
            },
            null,
            2,
          ),
        );
        return 0;
      }

      console.error(
        "Local trusted-code execution, not a sandbox. No automatic publication or merge.",
      );
      const result = await runLocalLoop(opts.repoRoot, contract, { push: !opts.noPush });
      console.log(JSON.stringify(result, null, 2));
      return result.status === "waiting_approval" ? 0 : 1;
    }

    if (sub === "watch") {
      const rawIssue = opts.issue;
      if (rawIssue && (!/^[1-9]\d*$/.test(rawIssue) || !Number.isSafeInteger(Number(rawIssue)))) {
        throw new Error("Invalid issue number");
      }
      if (rawIssue && opts.run) {
        throw new Error("Use --issue or --run, not both");
      }
      const result = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
        cwd: opts.repoRoot,
      });
      if (result.exitCode !== 0) throw new Error("Unable to resolve repository state directory");
      const common = resolve(opts.repoRoot, result.stdout.toString().trim());
      const directory = await findRun(
        join(common, "factory-local-loop", "runs"),
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

    throw new Error(`Unknown loop subcommand: ${sub}. Expected run, watch, or evidence.`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

export async function runSchedulerCliCommand(opts: {
  repoRoot: string;
  once?: boolean;
  dryRun?: boolean;
  interval?: string;
  json?: boolean;
}): Promise<number> {
  try {
    const interval = opts.interval ? Number(opts.interval) : undefined;
    if (interval !== undefined && (!Number.isSafeInteger(interval) || interval <= 0)) {
      throw new Error("Interval must be a positive integer in seconds");
    }

    const repoRes = Bun.spawnSync(["gh", "repo", "view", "--json", "nameWithOwner"], {
      cwd: opts.repoRoot,
    });
    if (repoRes.exitCode !== 0) {
      throw new Error("Unable to identify repository; ensure gh CLI is authenticated");
    }
    const repo = (JSON.parse(repoRes.stdout.toString()) as { nameWithOwner: string }).nameWithOwner;

    const gitCommonRes = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: opts.repoRoot,
    });
    const gitCommon =
      gitCommonRes.exitCode === 0 ? gitCommonRes.stdout.toString().trim() : ".git";
    const common = resolve(opts.repoRoot, gitCommon);
    const sharedRoot = resolve(common, "..");
    const runsDir = join(common, "factory-local-loop", "runs");

    const fetchBacklog = async () => fetchGithubBacklog(opts.repoRoot, repo);

    const launchLap = async (issue: BacklogCandidate): Promise<{ runId: string }> => {
      if (opts.dryRun) {
        console.log(
          `[DRY-RUN] Would launch autonomous lap for issue #${issue.number}: ${issue.title}`,
        );
        return { runId: `dry-run-issue-${issue.number}` };
      }
      console.log(`Launching autonomous lap for issue #${issue.number}...`);
      const contract = readIssueContract(opts.repoRoot, issue.number, repo);
      const result = await runLocalLoop(opts.repoRoot, contract, { push: true });
      return { runId: result.candidate || `issue-${issue.number}` };
    };

    if (opts.once) {
      const result = await runSchedulerTick({
        root: opts.repoRoot,
        sharedRoot,
        runsDir,
        config: interval ? { interval_seconds: interval } : undefined,
        fetchBacklog,
        launchLap,
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else logTickResult(result);
      return 0;
    }

    console.log(
      `Starting Factory Autonomous Scheduler (repository: ${repo}, interval: ${interval ?? loadScheduleConfig(opts.repoRoot).interval_seconds}s)...`,
    );
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());

    const loop = startSchedulerLoop({
      root: opts.repoRoot,
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
    return 0;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}
