import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { inspectLocalLoop, runAnimusLoop, type LocalIssue } from "./animus-loop";
import { getMergedIssueNumbers, resolveProjectWorkspace } from "../packages/contracts/src/paths";
import { isActiveClaim, parseDependencies } from "../apps/backend/src/intake/parser";
import {
  bindIssueContract,
  type BoundIssueContract,
  type GithubRead,
} from "../apps/backend/src/intake";

export { bindIssueContract, type BoundIssueContract, type GithubRead };

export function parseIssueArgs(args: string[]): { issue: number; dryRun: boolean; push: boolean } {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      issue: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-push": { type: "boolean", default: false },
    },
  });
  if (!values.issue || !/^[1-9]\d*$/.test(values.issue)) {
    throw new Error("Usage: bun run loop --issue <positive issue number> [--dry-run] [--no-push]");
  }
  const issue = Number(values.issue);
  if (!Number.isSafeInteger(issue)) throw new Error("Issue number is too large");
  return { issue, dryRun: values["dry-run"] ?? false, push: !values["no-push"] };
}

export function issueSpecification(url: string): string {
  return [
    `Work exclusively on this issue: ${url}`,
    "Read its complete body, comments, acceptance criteria, dependencies and linked pull requests.",
    "Do not select another issue or perform unrelated backlog bookkeeping.",
    "This local engine creates a new local branch; existing delivery PRs require human coordination before execution.",
    "Respect readiness labels, dependencies, live claims, project policy and all normal verification/review gates.",
    "If the issue is blocked, claimed, unclear or otherwise ineligible, do no implementation and report the reason; never substitute another task.",
    "Keep all implementation, PR references, verification and review bound to this issue.",
    "Merging is approval-only; do not merge automatically.",
  ].join("\n");
}

export function githubJson(args: string[], cwd: string): unknown {
  const result = Bun.spawnSync(["gh", ...args], { cwd, timeout: 30_000 });
  if (result.exitCode !== 0)
    throw new Error(
      `GitHub lookup failed (${args[0]}); check gh authentication and repository access`,
    );
  return JSON.parse(result.stdout.toString());
}

export function validateIssue(value: unknown, expected: number, repo: string): string {
  const issue = value as {
    number?: number;
    url?: string;
    state?: string;
    labels?: { name: string }[];
    isPullRequest?: boolean;
  } | null;
  const expectedUrl = `https://github.com/${repo}/issues/${expected}`;
  if (!issue || issue.number !== expected || issue.url !== expectedUrl || issue.isPullRequest) {
    throw new Error("GitHub did not return the requested issue in the selected repository");
  }
  if (issue.state !== "OPEN") throw new Error("Requested issue is not open");
  const labels = new Set((issue.labels ?? []).map((label) => label.name.toLowerCase()));
  if (
    !labels.has("ready-for-agent") ||
    ["needs-info", "ready-for-human", "needs-triage", "wontfix", "needs-owner"].some((label) =>
      labels.has(label),
    )
  ) {
    throw new Error("Requested issue is not ready for agent execution");
  }
  return expectedUrl;
}

/** All forge access is read-only; ambiguous or missing prerequisite data refuses execution. */
export function readIssueContract(
  root: string,
  number: number,
  repo: string,
  read: GithubRead = githubJson,
  validateSections = false,
): BoundIssueContract {
  return bindIssueContract({ root, number, repo, read, validateSections });
}

if (import.meta.main) {
  try {
    const { issue, dryRun, push } = parseIssueArgs(process.argv.slice(2));
    const root = resolve(import.meta.dir, "..");
    const repository = githubJson(["repo", "view", "--json", "nameWithOwner"], root) as {
      nameWithOwner?: string;
    };
    if (!repository.nameWithOwner) throw new Error("Unable to identify repository");
    const contract = readIssueContract(root, issue, repository.nameWithOwner);
    const workspace = resolveProjectWorkspace(root);
    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            engine: "local-pi",
            repository: repository.nameWithOwner,
            issue: contract,
            merge: "approve",
            model: process.env.FACTORY_LOOP_MODEL || "Pi configured default",
            stateDirectory: workspace.stateRoot,
            specification: issueSpecification(contract.url),
          },
          null,
          2,
        ),
      );
    } else {
      console.error(
        "Local trusted-code execution, not a sandbox. No automatic publication or merge. Holdouts are omitted from checkout but Git history/host remain reachable.",
      );
      const result = await runAnimusLoop(root, contract, { push });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "waiting_approval" && result.status !== "merged") process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Loop launch failed");
    process.exitCode = 1;
  }
}
