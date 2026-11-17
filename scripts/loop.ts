import {
  bindIssueContract,
  type BoundIssueContract,
  type GithubRead,
} from "../apps/backend/src/intake";

export { bindIssueContract, type BoundIssueContract, type GithubRead };

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
