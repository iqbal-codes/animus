import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../../scripts/cli/args";
import { renderHelp } from "../../scripts/cli/help";
import { runProjectCommand } from "../../scripts/cli/commands/operations";
import { runCli, resolveRepoRoot } from "../../scripts/cli/cli";

const project = {
  id: "proj_test",
  name: "example",
  repo_id: 42,
  repo_name: "acme/example",
  checkout_path: "/srv/factory/example",
  status: "active",
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("project registry CLI HTTP boundary", () => {
  test("parses and documents enrollment options and setup-only opt out", () => {
    const parsed = parseCliArgs([
      "setup",
      "--factory-url",
      "https://factory.example",
      "--factory-token",
      "operator-token",
      "--local-only",
    ]);
    expect(parsed.values["factory-url"]).toBe("https://factory.example");
    expect(parsed.values["factory-token"]).toBe("operator-token");
    expect(parsed.values["local-only"]).toBe(true);
    expect(renderHelp("setup")).toContain("--local-only");
    expect(renderHelp("setup")).toContain("--factory-url");
    expect(renderHelp("project")).toContain("--repo");
    expect(renderHelp("project")).toContain("--path");
  });

  test.each([
    ["list", [], "GET", "/api/v1/projects", [project]],
    ["get", ["proj_test"], "GET", "/api/v1/projects/proj_test", project],
    [
      "remove",
      ["proj_test"],
      "DELETE",
      "/api/v1/projects/proj_test",
      { id: "proj_test", status: "tombstone" },
    ],
  ] as const)(
    "%s uses the selected factory and never creates a local registry database",
    async (subcommand, args, method, path, body) => {
      const root = mkdtempSync(join(tmpdir(), "onboarding-registration-api-"));
      try {
        const fetch = vi.fn(async (url: string, init?: RequestInit) => {
          expect(url).toBe(`https://factory.example${path}`);
          expect(init?.method).toBe(method);
          expect(init?.redirect).toBe("error");
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer operator-token");
          return Response.json(body);
        });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        expect(
          await runProjectCommand({
            subcommand,
            positionals: ["project", subcommand, ...args],
            repoRoot: root,
            stateDir: join(root, "ledger-state"),
            factoryUrl: "https://factory.example",
            factoryToken: "operator-token",
            fetch,
            json: true,
          }),
        ).toBe(0);
        expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(body);
        expect(fetch).toHaveBeenCalledOnce();
        expect(existsSync(join(root, "ledger-state"))).toBe(false);
        expect(existsSync(join(root, ".factory"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("runCli forwards remote clone and authentication options without sending cwd", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://factory.example/api/v1/projects");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer cli-token");
      expect(JSON.parse(typeof init?.body === "string" ? init.body : "null")).toEqual({
        method: "github_clone",
        name: "Display name",
        repo: "acme/example",
      });
      return Response.json(project);
    });
    vi.stubGlobal("fetch", fetch);
    expect(
      await runCli([
        "project",
        "register",
        "--repo",
        "acme/example",
        "--name",
        "Display name",
        "--factory-url",
        "https://factory.example",
        "--factory-token",
        "cli-token",
        "--json",
      ]),
    ).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("source CLI registers the actual cwd, while service source root remains stable", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "onboarding-registration-cwd-")));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", [
        "-C",
        root,
        "remote",
        "add",
        "origin",
        "https://github.com/acme/example.git",
      ]);
      const sourceRoot = resolveRepoRoot();
      vi.spyOn(process, "cwd").mockReturnValue(root);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(JSON.parse(typeof init?.body === "string" ? init.body : "null").checkout_path).toBe(
          root,
        );
        return Response.json({ ...project, checkout_path: root });
      });
      vi.stubGlobal("fetch", fetch);
      expect(await runCli(["project", "register", "--json"])).toBe(0);
      expect(fetch).toHaveBeenCalledOnce();
      expect(resolveRepoRoot()).toBe(sourceRoot);
      expect(resolveRepoRoot()).not.toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses factory environment defaults and explicit flags take precedence", async () => {
    vi.stubEnv("FACTORY_URL", "https://environment.example");
    vi.stubEnv("FACTORY_TOKEN", "environment-token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([]));
    expect(
      await runProjectCommand({ positionals: ["project", "list"], repoRoot: "/unused", fetch }),
    ).toBe(0);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://environment.example/api/v1/projects");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer environment-token",
    );
    expect(
      await runProjectCommand({
        positionals: ["project", "list"],
        repoRoot: "/unused",
        factoryUrl: "https://flag.example",
        factoryToken: "flag-token",
        fetch,
      }),
    ).toBe(0);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://flag.example/api/v1/projects");
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer flag-token",
    );
  });

  test.each(["list", "get", "remove"])(
    "%s rejects malformed API success responses",
    async (subcommand) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      expect(
        await runProjectCommand({
          subcommand,
          positionals: ["project", subcommand, "proj_test"],
          repoRoot: "/unused",
          fetch,
          json: true,
        }),
      ).toBe(1);
      expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string).error).toContain(
        "invalid API response",
      );
    },
  );
});
