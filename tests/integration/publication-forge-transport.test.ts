import { describe, expect, test } from "vitest";
import { SystemForgeAdapter } from "../../apps/backend/src/registry";

function prJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 12,
    title: "Delivery",
    body: "body",
    headRefName: "factory/standalone-900",
    baseRefName: "main",
    state: "OPEN",
    url: "https://github.com/owner/repo/pull/12",
    isDraft: true,
    headRefOid: "a".repeat(40),
    ...overrides,
  });
}

function failure(message: string): Error {
  return Object.assign(new Error(message), {
    code: 1,
    stdout: "",
    stderr: message,
  });
}

describe("SystemForgeAdapter pull request command transport", () => {
  test("uses the bounded runner and requests the remote head SHA", async () => {
    const argv: string[] = [];
    const forge = new SystemForgeAdapter(async (cmd) => {
      argv.push(...cmd);
      return prJson({ state: "CLOSED" });
    });

    const pr = await forge.getPullRequest("owner/repo", 12);

    expect(argv.slice(0, 4)).toEqual(["gh", "pr", "view", "12"]);
    expect(argv.join(" ")).toContain("headRefOid");
    expect(pr).toMatchObject({
      number: 12,
      head: "factory/standalone-900",
      base: "main",
      state: "CLOSED",
      headRefOid: "a".repeat(40),
      repository: "owner/repo",
    });
  });

  test("a genuine not-found response is an absent PR", async () => {
    const forge = new SystemForgeAdapter(async () => {
      throw failure(
        "GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)",
      );
    });

    await expect(forge.getPullRequest("owner/repo", 99)).resolves.toBeNull();
  });

  test("an upstream outage throws instead of reporting a closed PR", async () => {
    const forge = new SystemForgeAdapter(async () => {
      throw failure("HTTP 502 Bad Gateway");
    });

    await expect(forge.getPullRequest("owner/repo", 12)).rejects.toThrow(/502/);
  });

  test("an authentication failure throws instead of reporting a closed PR", async () => {
    const forge = new SystemForgeAdapter(async () => {
      throw failure("gh: To get started with GitHub CLI, please run: gh auth login");
    });

    await expect(forge.getPullRequest("owner/repo", 12)).rejects.toThrow(/auth login/);
  });

  test("a malformed response throws instead of reporting a closed PR", async () => {
    const forge = new SystemForgeAdapter(async () => "not json");

    await expect(forge.getPullRequest("owner/repo", 12)).rejects.toThrow();
  });

  test("a JSON response without the binding fields throws", async () => {
    const forge = new SystemForgeAdapter(async () => JSON.stringify({ number: 12 }));

    await expect(forge.getPullRequest("owner/repo", 12)).rejects.toThrow(/Malformed/);
  });
});
