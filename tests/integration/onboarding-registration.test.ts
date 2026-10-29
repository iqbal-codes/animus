import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeRepositoryOnboarding } from "../../scripts/cli/commands/onboarding-registration";

const registered = (checkout: string) => ({
  id: "proj_example",
  name: "example",
  repo_id: 42,
  repo_name: "acme/example",
  checkout_path: checkout,
  status: "active",
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
});

describe("repository onboarding factory registration", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "onboarding-registration-")));
    execFileSync("git", ["init", "--quiet", repoRoot]);
    execFileSync("git", [
      "-C",
      repoRoot,
      "remote",
      "add",
      "origin",
      "git@github.com:acme/example.git",
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("enrolls the configured local checkout through the factory API without a local database", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:3000/api/v1/projects");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(typeof init?.body === "string" ? init.body : "null")).toEqual({
        method: "local_checkout",
        name: "example",
        checkout_path: repoRoot,
      });
      return Response.json(registered(repoRoot));
    });
    expect(await completeRepositoryOnboarding({ repoRoot }, { fetch, json: true })).toBe(0);
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
    expect(output.registration.project.id).toBe("proj_example");
    expect(output.registration.status).toBe("registered");
    expect(existsSync(join(repoRoot, ".factory/state/console.db"))).toBe(false);
  });

  test("remote enrollment clones on the factory and never sends the laptop checkout", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://factory.example/api/v1/projects");
      expect(JSON.parse(typeof init?.body === "string" ? init.body : "null")).toEqual({
        method: "github_clone",
        name: "example",
        repo: "acme/example",
      });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer operator-secret");
      return Response.json(registered("/srv/factory/checkouts/example"));
    });
    expect(
      await completeRepositoryOnboarding(
        { repoRoot },
        {
          repo: "acme/example",
          factoryUrl: "https://factory.example",
          factoryToken: "operator-secret",
          fetch,
        },
      ),
    ).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("rejects local registration to a remote factory before sending any path", async () => {
    const fetch = vi.fn();
    expect(
      await completeRepositoryOnboarding(
        { repoRoot },
        { factoryUrl: "https://factory.example", fetch },
      ),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain("Use project register --repo");
  });

  test("local-only is an honest explicit opt-out, even when the factory is unreachable", async () => {
    const fetch = vi.fn();
    expect(
      await completeRepositoryOnboarding({ repoRoot }, { localOnly: true, fetch, json: true }),
    ).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string).registration).toEqual({
      status: "skipped",
      reason: "local-only",
    });
  });

  test("authentication failure preserves local success but reports enrollment failure", async () => {
    const fetch = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    expect(await completeRepositoryOnboarding({ repoRoot }, { fetch, json: true })).toBe(1);
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
    expect(output.ok).toBe(false);
    expect(output.error).toContain("Local setup complete; factory registration failed:");
    expect(output.error).toContain("--factory-token");
    expect(output.registration.status).toBe("failed");
  });

  test("returns an existing active registration only for matching repo identity and local path", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ error: "project_already_exists" }, { status: 409 })
        : Response.json([registered(repoRoot)]),
    );
    expect(await completeRepositoryOnboarding({ repoRoot }, { fetch, json: true })).toBe(0);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string).registration.status).toBe(
      "existing",
    );
  });

  test.each([
    { checkout_path: "/other/checkout" },
    { repo_name: "other/example" },
    { status: "held", status_reason: "checkout_missing" },
    { status: "tombstone" },
  ])("does not silently accept a conflicting or unavailable duplicate %j", async (change) => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ error: "project_already_exists" }, { status: 409 })
        : Response.json([{ ...registered(repoRoot), ...change }]),
    );
    expect(await completeRepositoryOnboarding({ repoRoot }, { fetch })).toBe(1);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain(
      "not as an active project at this local checkout",
    );
  });

  test.each([
    {},
    { repo_id: -1 },
    { repo_name: "wrong/repo" },
    { checkout_path: "/other/checkout" },
    { status: "held" },
  ])("rejects an invalid or mismatched success response %j", async (change) => {
    const body = Object.keys(change).length ? { ...registered(repoRoot), ...change } : {};
    const fetch = vi.fn(async () => Response.json(body));
    expect(await completeRepositoryOnboarding({ repoRoot }, { fetch })).toBe(1);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain("registration failed");
  });

  test("does not fall back to clone when a local checkout is rejected", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: "project_checkout_invalid" }, { status: 400 }),
    );
    expect(await completeRepositoryOnboarding({ repoRoot }, { fetch })).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test.each([401, 403])(
    "remote clone authentication failure %s remains nonzero",
    async (status) => {
      const fetch = vi.fn(async () => new Response("not authenticated", { status }));
      expect(
        await completeRepositoryOnboarding(
          { repoRoot },
          { repo: "acme/example", factoryUrl: "https://factory.example", fetch },
        ),
      ).toBe(1);
      expect(vi.mocked(console.error).mock.calls[0]![0]).toContain("Factory authentication failed");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  test.each([
    {},
    { ...registered("/srv/checkout"), repo_name: "other/repo" },
    { ...registered("/srv/checkout"), status: "held" },
  ])("remote clone rejects unverifiable API success %j", async (body) => {
    const fetch = vi.fn(async () => Response.json(body));
    expect(
      await completeRepositoryOnboarding(
        { repoRoot },
        { repo: "acme/example", factoryUrl: "https://factory.example", fetch },
      ),
    ).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
  });

  test("remote clone duplicate never accepts an unrelated server checkout as the requested local path", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: "project_already_exists" }, { status: 409 }),
    );
    expect(
      await completeRepositoryOnboarding(
        { repoRoot },
        { repo: "acme/example", factoryUrl: "https://factory.example", fetch },
      ),
    ).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test.each([
    "file:///tmp/factory",
    "https://user:secret@factory.example",
    "https://factory.example/prefix",
    "not-a-url",
  ])("rejects invalid factory origin %s before networking", async (factoryUrl) => {
    const fetch = vi.fn();
    expect(
      await completeRepositoryOnboarding({ repoRoot }, { repo: "acme/example", factoryUrl, fetch }),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls[0]![0]).not.toContain("secret");
  });

  test("does not combine clone enrollment with a local path", async () => {
    const fetch = vi.fn();
    expect(
      await completeRepositoryOnboarding(
        { repoRoot },
        { repo: "acme/example", path: repoRoot, fetch },
      ),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("all registration requests are bounded and JSON never includes the operator token", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return Response.json(registered(repoRoot));
    });
    expect(
      await completeRepositoryOnboarding(
        { repoRoot },
        { fetch, factoryToken: "do-not-print", json: true },
      ),
    ).toBe(0);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("do-not-print");
  });

  test("an unresponsive factory aborts and returns nonzero instead of hanging", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Request has no deadline");
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    expect(await completeRepositoryOnboarding({ repoRoot }, { fetch })).toBe(1);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain("Factory is unavailable");
  });

  test("operator credentials are never sent over non-loopback plain HTTP", async () => {
    const fetch = vi.fn();
    expect(
      await completeRepositoryOnboarding(
        { repoRoot },
        {
          repo: "acme/example",
          factoryUrl: "http://192.168.1.2:3000",
          factoryToken: "secret-token",
          fetch,
        },
      ),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain("HTTPS");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret-token");
  });

  test("transport failures never echo credentials from the thrown error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("request failed token=do-not-print");
    });
    expect(
      await completeRepositoryOnboarding(
        { repoRoot },
        { repo: "acme/example", fetch, factoryToken: "do-not-print", json: true },
      ),
    ).toBe(1);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("do-not-print");
  });

  test("network failures are nonzero and do not claim enrollment succeeded", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    });
    expect(await completeRepositoryOnboarding({ repoRoot }, { fetch })).toBe(1);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toContain("Factory is unavailable");
    expect(console.log).not.toHaveBeenCalled();
  });
});
