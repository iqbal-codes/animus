import { expect, test } from "bun:test";
import { fetchGithubBacklog } from "../../scripts/scheduler";
import {
  SyntheticForgeAdapter,
  type IssueForgeAdapter,
} from "../../apps/backend/src/registry/forge";

test("scheduler resolves only shared dependencies of ready open candidates", async () => {
  const forge: IssueForgeAdapter = new SyntheticForgeAdapter({ "owner/repo": 1 });
  forge.listIssues = async () => [
    {
      number: 200,
      title: "first",
      state: "OPEN",
      labels: ["ready-for-agent"],
      body: "Depends on: #1",
      comments: [],
    },
    {
      number: 201,
      title: "second",
      state: "OPEN",
      labels: ["ready-for-agent"],
      body: "Depends on: #1, #200",
      comments: [],
    },
    {
      number: 202,
      title: "triage",
      state: "OPEN",
      labels: ["needs-triage"],
      body: "Depends on: #99",
      comments: [],
    },
  ];
  let requested: number[] = [];
  forge.getIssueStates = async (_repo, numbers) => {
    requested = numbers;
    return new Map([[1, "CLOSED"]]);
  };
  const result = await fetchGithubBacklog("/unused", "owner/repo", forge);
  expect(result.issues.map((issue) => issue.number)).toEqual([200, 201]);
  expect(requested).toEqual([1]);
  expect([...result.closedNumbers]).toEqual([1]);
});

test("scheduler dependency outage refuses discovery instead of admitting work", async () => {
  const forge: IssueForgeAdapter = new SyntheticForgeAdapter({ "owner/repo": 1 });
  forge.listIssues = async () => [
    {
      number: 200,
      title: "first",
      state: "OPEN",
      labels: ["ready-for-agent"],
      body: "Depends on: #1",
    },
  ];
  forge.getIssueStates = async () => {
    throw new Error("lookup unavailable");
  };
  const result = await fetchGithubBacklog("/unused", "owner/repo", forge).catch(
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe("lookup unavailable");
});
