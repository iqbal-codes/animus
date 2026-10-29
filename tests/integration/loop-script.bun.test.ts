import { expect, test } from "bun:test";
import {
  issueSpecification,
  parseIssueArgs,
  readIssueContract,
  validateIssue,
  type GithubRead,
} from "../../scripts/loop";

test("parses the requested issue and refuses missing, malformed or unsafe IDs", () => {
  expect(parseIssueArgs(["--issue", "72", "--dry-run"])).toEqual({
    issue: 72,
    dryRun: true,
    push: true,
  });
  expect(parseIssueArgs(["--issue", "72", "--no-push"])).toEqual({
    issue: 72,
    dryRun: false,
    push: false,
  });
  for (const id of ["0", "-1", "72abc", "1.2", "9007199254740992"]) {
    expect(() => parseIssueArgs(["--issue", id])).toThrow();
  }
  expect(() => parseIssueArgs([])).toThrow();
  expect(() => parseIssueArgs(["--issue", "72", "--merge", "auto"])).toThrow();
});

test("refuses a different repository, issue, closed issue or blocking label", () => {
  const issue = {
    number: 72,
    url: "https://github.com/owner/repo/issues/72",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
  };
  expect(validateIssue(issue, 72, "owner/repo")).toBe(issue.url);
  expect(() => validateIssue(issue, 73, "owner/repo")).toThrow();
  expect(() => validateIssue(issue, 72, "other/repo")).toThrow();
  expect(() => validateIssue({ ...issue, state: "CLOSED" }, 72, "owner/repo")).toThrow();
  expect(() => validateIssue({ ...issue, labels: [] }, 72, "owner/repo")).toThrow();
  for (const name of ["needs-info", "ready-for-human", "needs-triage", "wontfix", "needs-owner"]) {
    expect(() =>
      validateIssue({ ...issue, labels: [...issue.labels, { name }] }, 72, "owner/repo"),
    ).toThrow();
  }
});

test("read-only preflight includes paginated historical dependencies and native edges", () => {
  const issue = {
    number: 72,
    url: "https://github.com/owner/repo/issues/72",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    title: "Deliver",
    body: "Depends on: #10",
    comments: [],
  };
  const read: GithubRead = (args) => {
    if (args[0] === "api") {
      expect(args).toContain("--paginate");
      expect(args).toContain("--slurp");
      return args[1]!.endsWith("comments")
        ? [[{ body: "Depends on: #11" }], [{ body: "AC: verify output" }]]
        : [
            [
              {
                number: 12,
                state: "closed",
                repository_url: "https://api.github.com/repos/owner/repo",
              },
            ],
          ];
    }
    expect(args.slice(0, 2)).toEqual(["issue", "view"]);
    return args[2] === "72"
      ? issue
      : {
          number: Number(args[2]),
          url: `https://github.com/owner/repo/issues/${args[2]}`,
          state: "CLOSED",
        };
  };
  const contract = readIssueContract("/unused", 72, "owner/repo", read);
  expect(contract.comments).toEqual(["Depends on: #11", "AC: verify output"]);
  expect(contract.dependencies.map((d) => d.number)).toEqual([10, 11, 12]);
  expect(() =>
    readIssueContract("/unused", 72, "owner/repo", (args, cwd) =>
      args[0] === "api" && args[1]!.endsWith("comments")
        ? [[{ body: "Loop claim: run abc123" }]]
        : read(args, cwd),
    ),
  ).toThrow("claim");
  expect(() =>
    readIssueContract("/unused", 72, "owner/repo", (args, cwd) =>
      args[2] === "10"
        ? { number: 10, url: "https://github.com/owner/repo/issues/10", state: "OPEN" }
        : read(args, cwd),
    ),
  ).toThrow("Unresolved");
});

test("requests only the named task without bypassing checks or approval", () => {
  const specification = issueSpecification("https://github.com/owner/repo/issues/72");
  expect(specification).toContain(
    "Work exclusively on this issue: https://github.com/owner/repo/issues/72",
  );
  expect(specification).toContain("never substitute another task");
  expect(specification).toContain("normal verification/review gates");
  expect(specification).toContain("do not merge automatically");
});
