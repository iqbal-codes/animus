import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { inspectLocalLoop, runLocalLoop, type LocalIssue } from "./local-loop";
import { isActiveClaim, parseDependencies } from "../apps/backend/src/intake/parser";

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

export type GithubRead = (args: string[], cwd: string) => unknown;

/** All forge access is read-only; ambiguous or missing prerequisite data refuses execution. */
export function readIssueContract(
  root: string,
  number: number,
  repo: string,
  read: GithubRead = githubJson,
): LocalIssue {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository identity");
  const issue = read(
    [
      "issue",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,url,state,labels,title,body,comments",
    ],
    root,
  ) as { number: number; url: string; title: string; body: string; comments: { body: string }[] };
  const url = validateIssue(issue, number, repo);
  if (
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    !issue.body.trim() ||
    !Array.isArray(issue.comments) ||
    issue.comments.some((c) => typeof c.body !== "string")
  )
    throw new Error("Incomplete issue body/comments");
  // REST pagination avoids GraphQL issue-view comment truncation.
  const pages = read(
    ["api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--slurp"],
    root,
  ) as { body: string }[][];
  if (
    !Array.isArray(pages) ||
    pages.some((page) => !Array.isArray(page) || page.some((c) => typeof c.body !== "string"))
  )
    throw new Error("Unable to verify complete comments");
  const comments = pages.flat();
  if (isActiveClaim(comments, issue.body))
    throw new Error("Requested issue has a loop claim; resolve ownership before running");
  const dependencyPages = read(
    ["api", `repos/${repo}/issues/${number}/dependencies/blocked_by`, "--paginate", "--slurp"],
    root,
  ) as { number: number; state: string; repository_url: string }[][];
  if (!Array.isArray(dependencyPages) || dependencyPages.some((p) => !Array.isArray(p)))
    throw new Error("Unable to verify native dependencies");
  const dependencies = new Set(
    parseDependencies([issue.body, ...comments.map((c) => c.body)].join("\n")),
  );
  for (const dependency of dependencyPages.flat()) {
    if (
      dependency.repository_url !== `https://api.github.com/repos/${repo}` ||
      !Number.isSafeInteger(dependency.number)
    )
      throw new Error(
        "Cross-repository or malformed native dependency requires human verification",
      );
    dependencies.add(dependency.number);
  }
  const resolved = [...dependencies].map((dependency) => {
    const data = read(
      ["issue", "view", String(dependency), "--repo", repo, "--json", "number,url,state"],
      root,
    ) as { number: number; url: string; state: string };
    if (
      data.number !== dependency ||
      data.url !== `https://github.com/${repo}/issues/${dependency}` ||
      data.state !== "CLOSED" ||
      dependency === number
    )
      throw new Error(`Unresolved dependency #${dependency}`);
    return { number: dependency, state: data.state };
  });
  return {
    number,
    url,
    title: issue.title,
    body: issue.body,
    comments: comments.map((c) => c.body),
    dependencies: resolved,
    activeClaim: false,
    labels: Array.isArray((issue as any).labels)
      ? (issue as any).labels.map((l: any) => (typeof l === "string" ? l : l.name)).filter(Boolean)
      : [],
  };
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
    const local = await inspectLocalLoop(root);
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
            stateDirectory: resolve(local.common, "factory-local-loop"),
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
      const result = await runLocalLoop(root, contract, { push });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "waiting_approval") process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Loop launch failed");
    process.exitCode = 1;
  }
}
