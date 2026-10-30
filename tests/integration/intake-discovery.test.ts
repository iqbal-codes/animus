import { expect, test } from "vitest";
import { IntakeService } from "../../apps/backend/src/intake/service";
import { SyntheticForgeAdapter } from "../../apps/backend/src/registry/forge";

function issue(number: number, body = "", state = "OPEN") {
  return {
    number,
    title: `Issue ${number}`,
    body,
    state,
    labels: [{ name: "ready-for-agent" }],
    comments: [],
  };
}

test("open discovery resolves shared closed dependencies once without returning closed work", async () => {
  const forge = new SyntheticForgeAdapter({ "owner/repo": 1 });
  const calls: number[] = [];
  forge.listIssues = async () => [
    issue(201, "Depends on: #1"),
    issue(202, "Depends on: #1"),
    issue(203, "Depends on: #404"),
  ];
  forge.getIssue = async (_repo, number) => {
    calls.push(number);
    return number === 1 ? issue(1, "", "CLOSED") : null;
  };
  const service = new IntakeService({ repo: "owner/repo" }, forge);
  const result = await service.evaluateBacklog();
  expect(result.issues.map((i) => [i.number, i.admission_status])).toEqual([
    [201, "admitted"],
    [202, "admitted"],
    [203, "held"],
  ]);
  expect(calls.sort((a, b) => a - b)).toEqual([1, 404]);
  expect((await service.evaluateBacklog()).cached).toBe(true);
  expect(calls).toHaveLength(2);
  await service.evaluateBacklog(true);
  expect(calls).toHaveLength(4);
});

test("single issue lookup bypasses backlog and rechecks dependency state on each request", async () => {
  const forge = new SyntheticForgeAdapter({ "owner/repo": 1 });
  forge.listIssues = async () => {
    throw new Error("must not list backlog");
  };
  let state = "CLOSED";
  forge.getIssue = async (_repo, number) =>
    number === 201 ? issue(201, "Depends on: #1") : issue(1, "", state);
  const service = new IntakeService({ repo: "owner/repo" }, forge);
  expect((await service.getIssue(201))?.admission_status).toBe("admitted");
  state = "OPEN";
  expect((await service.getIssue(201))?.admission_status).toBe("held");
});

test("backlog admission never waits on advisory for unlabeled or triage issues", async () => {
  const forge = new SyntheticForgeAdapter({ "owner/repo": 1 });
  let advisoryCalls = 0;
  forge.listIssues = async () => [
    { ...issue(1), labels: [] },
    { ...issue(2), labels: [{ name: "needs-triage" }] },
    issue(3),
  ];
  const service = new IntakeService(
    {
      repo: "owner/repo",
      jevFetcher: async () => {
        advisoryCalls++;
        throw new Error("unavailable");
      },
    },
    forge,
  );
  const result = await service.evaluateBacklog();
  expect(result.issues.map((item) => item.admission_status)).toEqual(["held", "held", "admitted"]);
  expect(advisoryCalls).toBe(0);
});

test("dependency lookup outages hold candidates without invoking advisory", async () => {
  const forge = new SyntheticForgeAdapter({ "owner/repo": 1 });
  forge.listIssues = async () => [issue(201, "Depends on: #1")];
  forge.getIssue = async () => {
    throw new Error("offline");
  };
  const service = new IntakeService(
    {
      repo: "owner/repo",
      jevFetcher: async () => {
        throw new Error("advisory must not run");
      },
    },
    forge,
  );
  const result = await service.evaluateBacklog();
  expect(result.issues[0]?.reason).toBe("dependency_lookup_failed:#1");
  expect(result.admitted_count).toBe(0);
});
