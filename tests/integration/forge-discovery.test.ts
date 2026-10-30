import { describe, expect, test } from "vitest";
import { SystemForgeAdapter, SyntheticForgeAdapter } from "../../apps/backend/src/registry/forge";

const connection = (nodes: unknown[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
const issue = (number: number) => ({
  number,
  title: `Ticket ${number}`,
  state: "OPEN",
  body: "Depends on: #999\nFull body",
  labels: connection([{ name: "ready-for-agent" }]),
  comments: connection([{ body: "claim: original" }]),
});
function transport(responses: unknown[]) {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (cmd: string[]) => {
      calls.push(cmd);
      if (!responses.length) throw new Error("Unexpected request");
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return JSON.stringify(response);
    },
  };
}
function query(cmd: string[]) {
  expect(cmd.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
  return cmd.find((arg) => arg.startsWith("query="))!.slice(6);
}

describe("SystemForgeAdapter discovery", () => {
  test("ALL explicitly includes closed issues across pages with complete comments", async () => {
    const mock = transport([
      { data: { repository: { issues: connection([issue(1)], "next") } } },
      {
        data: {
          repository: {
            issues: connection([
              { ...issue(2), state: "CLOSED", comments: connection([], "more-comments") },
            ]),
          },
        },
      },
      {
        data: {
          repository: { issue: { comments: connection([{ body: "closed child evidence" }]) } },
        },
      },
    ]);
    const result = await new SystemForgeAdapter(mock.runner).listIssues("owner/repo", "ALL");
    expect(result.map(({ number, state }) => ({ number, state }))).toEqual([
      { number: 1, state: "OPEN" },
      { number: 2, state: "CLOSED" },
    ]);
    expect(result[1]?.comments).toEqual([{ body: "closed child evidence" }]);
    expect(query(mock.calls[0]!)).toContain("states: [OPEN, CLOSED]");
    expect(query(mock.calls[1]!)).toContain("states: [OPEN, CLOSED]");
    expect(mock.calls[1]).toContain("cursor=next");
  });

  test("synthetic discovery defaults to OPEN and ALL includes closed children", async () => {
    const forge = new SyntheticForgeAdapter();
    forge.addIssue("owner/repo", { number: 1, title: "Open", state: "OPEN" });
    forge.addIssue("owner/repo", { number: 2, title: "Closed", state: "CLOSED" });
    expect((await forge.listIssues("owner/repo")).map((item) => item.number)).toEqual([1]);
    expect((await forge.listIssues("owner/repo", "OPEN")).map((item) => item.number)).toEqual([1]);
    expect((await forge.listIssues("owner/repo", "ALL")).map((item) => item.number)).toEqual([
      1, 2,
    ]);
    expect(await forge.listIssues("missing/repo", "ALL")).toEqual([]);
  });
  test.each(["list", "targeted"])(
    "%s reads paginate comments and labels independently",
    async (mode) => {
      const raw = {
        ...issue(7),
        state: mode === "targeted" ? "CLOSED" : "OPEN",
        labels: connection([{ name: "ready-for-agent" }], "labels-next"),
        comments: connection([{ body: "claim: original" }], "comments-next"),
      };
      const mock = transport([
        { data: { repository: mode === "list" ? { issues: connection([raw]) } : { issue: raw } } },
        { data: { repository: { issue: { labels: connection([{ name: "blocked" }]) } } } },
        {
          data: {
            repository: {
              issue: { comments: connection([{ body: "claim: renewed" }], "comments-last") },
            },
          },
        },
        {
          data: { repository: { issue: { comments: connection([{ body: "Depends on: #456" }]) } } },
        },
      ]);
      const forge = new SystemForgeAdapter(mock.runner);
      const result =
        mode === "list"
          ? (await forge.listIssues("https://github.com/owner/repo.git"))[0]
          : await forge.getIssue("owner/repo", 7);
      expect(result).toEqual({
        number: 7,
        title: "Ticket 7",
        state: mode === "targeted" ? "CLOSED" : "OPEN",
        body: "Depends on: #999\nFull body",
        labels: [{ name: "ready-for-agent" }, { name: "blocked" }],
        comments: [
          { body: "claim: original" },
          { body: "claim: renewed" },
          { body: "Depends on: #456" },
        ],
      });
      expect(mock.calls[1]).toContain("cursor=labels-next");
      expect(mock.calls[2]).toContain("cursor=comments-next");
      expect(mock.calls[3]).toContain("cursor=comments-last");
    },
  );

  test("malformed JSON rejects rather than producing an empty result", async () => {
    const forge = new SystemForgeAdapter(async () => "not-json");
    await expect(forge.listIssues("owner/repo")).rejects.toThrow();
    await expect(forge.getIssue("owner/repo", 7)).rejects.toThrow();
    await expect(forge.getIssueStates("owner/repo", [7])).rejects.toThrow();
  });

  test.each([
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
    { nodes: [], pageInfo: { hasNextPage: false } },
    { nodes: [null], pageInfo: { hasNextPage: false, endCursor: null } },
    { nodes: null, pageInfo: { hasNextPage: false, endCursor: null } },
  ])("incomplete discovery connections reject: %j", async (issues) => {
    const mock = transport([{ data: { repository: { issues } } }]);
    await expect(new SystemForgeAdapter(mock.runner).listIssues("owner/repo")).rejects.toThrow();
  });

  test("a missing alias after a successful batch rejects the whole state lookup", async () => {
    const mock = transport([
      {
        data: {
          repository: Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [
              `issue_${i + 1}`,
              { number: i + 1, state: "CLOSED" },
            ]),
          ),
        },
      },
      { data: { repository: {} } },
    ]);
    await expect(
      new SystemForgeAdapter(mock.runner).getIssueStates(
        "owner/repo",
        Array.from({ length: 51 }, (_, i) => i + 1),
      ),
    ).rejects.toThrow();
  });

  test("empty discovery terminates without extra requests", async () => {
    const mock = transport([{ data: { repository: { issues: connection([]) } } }]);
    expect(await new SystemForgeAdapter(mock.runner).listIssues("owner/repo")).toEqual([]);
    expect(mock.calls).toHaveLength(1);
  });

  test("batches targeted states, deduplicates and preserves unavailable numbers", async () => {
    const mock = transport([
      {
        data: {
          repository: Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [
              `issue_${i + 1}`,
              { number: i + 1, state: i === 0 ? "OPEN" : "CLOSED" },
            ]),
          ),
        },
      },
      {
        data: { repository: { issue_51: null, issue_52: { number: 52, state: "CLOSED" } } },
        errors: [{ type: "NOT_FOUND", path: ["repository", "issue_51"] }],
      },
    ]);
    const result = await new SystemForgeAdapter(mock.runner).getIssueStates("owner/repo", [
      ...Array.from({ length: 52 }, (_, i) => i + 1),
      1,
    ]);
    expect(result.size).toBe(52);
    expect(result.get(1)).toBe("OPEN");
    expect(result.get(50)).toBe("CLOSED");
    expect(result.get(51)).toBeNull();
    expect(result.get(52)).toBe("CLOSED");
    expect(mock.calls).toHaveLength(2);
    expect(query(mock.calls[0]!).match(/: issue\(/g)).toHaveLength(50);
    expect(query(mock.calls[1]!).match(/: issue\(/g)).toHaveLength(2);
    expect(query(mock.calls[0]!)).not.toMatch(/body|comments|labels/);
  });

  test("empty state lookup makes no request and invalid numbers reject before transport", async () => {
    const mock = transport([]);
    const forge = new SystemForgeAdapter(mock.runner);
    expect(await forge.getIssueStates("owner/repo", [])).toEqual(new Map());
    for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(forge.getIssueStates("owner/repo", [number])).rejects.toThrow();
      await expect(forge.getIssue("owner/repo", number)).rejects.toThrow();
    }
    expect(mock.calls).toEqual([]);
  });

  test.each([false, true])(
    "targeted missing issue returns null (NOT_FOUND=%s)",
    async (withError) => {
      const mock = transport([
        {
          data: { repository: { issue: null } },
          ...(withError ? { errors: [{ type: "NOT_FOUND", path: ["repository", "issue"] }] } : {}),
        },
      ]);
      expect(await new SystemForgeAdapter(mock.runner).getIssue("owner/repo", 7)).toBeNull();
    },
  );

  test.each([
    new Error("transport failed"),
    { data: { repository: null } },
    { data: { repository: {} } },
    { data: { repository: { issue_7: { number: 7, state: "MERGED" } } } },
    { data: { repository: { issue_7: { number: 8, state: "OPEN" } } } },
    {
      data: { repository: { issue_7: null } },
      errors: [{ type: "FORBIDDEN", path: ["repository", "issue_7"] }],
    },
    {
      data: { repository: { issue_7: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository"] }],
    },
    {
      data: { repository: { issue_7: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "other"] }],
    },
  ])("state errors never become unavailable statuses: %j", async (response) => {
    const mock = transport([response]);
    await expect(
      new SystemForgeAdapter(mock.runner).getIssueStates("owner/repo", [7]),
    ).rejects.toThrow();
  });

  test.each([
    new Error("transport failed"),
    { data: { repository: {} } },
    { data: { repository: { issue: { ...issue(7), body: undefined } } } },
    { data: { repository: { issue: { ...issue(7), comments: undefined } } } },
    {
      data: { repository: { issue: null } },
      errors: [{ type: "FORBIDDEN", path: ["repository", "issue"] }],
    },
  ])("targeted errors never become missing issues: %j", async (response) => {
    await expect(
      new SystemForgeAdapter(transport([response]).runner).getIssue("owner/repo", 7),
    ).rejects.toThrow();
  });

  test("discovery rejects partial GraphQL data even when issue nodes are present", async () => {
    const response = {
      data: { repository: { issues: connection([issue(7)]) } },
      errors: [{ type: "FORBIDDEN", path: ["repository", "issues", "nodes", 0, "comments"] }],
    };
    await expect(
      new SystemForgeAdapter(transport([response]).runner).listIssues("owner/repo"),
    ).rejects.toThrow();
  });

  test.each(["issues", "comments"])(
    "rejects stalled %s pagination instead of returning truncated data",
    async (field) => {
      const raw = { ...issue(7), comments: connection([], "stalled") };
      const responses =
        field === "issues"
          ? [
              { data: { repository: { issues: connection([], "stalled") } } },
              { data: { repository: { issues: connection([], "stalled") } } },
            ]
          : [
              { data: { repository: { issues: connection([raw]) } } },
              { data: { repository: { issue: { comments: connection([], "stalled") } } } },
            ];
      await expect(
        new SystemForgeAdapter(transport(responses).runner).listIssues("owner/repo"),
      ).rejects.toThrow("cursor");
    },
  );

  test("later comment transport failure rejects the entire discovery", async () => {
    const mock = transport([
      {
        data: {
          repository: { issues: connection([{ ...issue(7), comments: connection([], "next") }]) },
        },
      },
      new Error("offline"),
    ]);
    await expect(new SystemForgeAdapter(mock.runner).listIssues("owner/repo")).rejects.toThrow(
      "offline",
    );
  });
  test("discovers beyond 100 OPEN issues and retains complete metadata", async () => {
    const first = Array.from({ length: 100 }, (_, i) => issue(i + 1));
    const mock = transport([
      { data: { repository: { issues: connection(first, "next-issues") } } },
      { data: { repository: { issues: connection([issue(101)]) } } },
    ]);
    const result = await new SystemForgeAdapter(mock.runner).listIssues("owner/repo");
    expect(result).toHaveLength(101);
    expect(result[100]).toEqual({
      number: 101,
      title: "Ticket 101",
      state: "OPEN",
      body: "Depends on: #999\nFull body",
      labels: [{ name: "ready-for-agent" }],
      comments: [{ body: "claim: original" }],
    });
    expect(query(mock.calls[0]!)).toContain("states: OPEN");
    expect(mock.calls[1]).toContain("cursor=next-issues");
  });
});
