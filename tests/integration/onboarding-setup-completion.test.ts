import { afterEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupCommand } from "../../scripts/cli/commands/setup";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function checkout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "onboarding-complete-")));
  roots.push(root);
  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "https://github.com/owner/product.git",
  ]);
  return root;
}

describe("setup enrollment completion", () => {
  test("setup registers its configured checkout through the factory and prints one verified result", async () => {
    const root = checkout();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runSetupCommand(
      { repoRoot: root, json: true, nonInteractive: true, factoryUrl: "http://127.0.0.1:3210" },
      {
        detectHarnesses: () => [],
        registrationFetch: async (url, init) => {
          expect(url).toBe("http://127.0.0.1:3210/api/v1/projects");
          expect(init?.method).toBe("POST");
          if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
          const body = JSON.parse(init.body);
          expect(body).toEqual({ method: "local_checkout", name: "product", checkout_path: root });
          expect(existsSync(join(root, ".animus/config.yaml"))).toBe(true);
          return Response.json({
            id: "proj_test",
            name: "product",
            repo_id: 42,
            repo_name: "owner/product",
            checkout_path: root,
            status: "active",
            status_reason: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          });
        },
      },
    );
    expect(code).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    const result = JSON.parse(String(output.mock.calls[0]![0]));
    expect(result.registration.project.id).toBe("proj_test");
    expect(existsSync(join(root, ".factory/state/console.db"))).toBe(false);
  });

  test("factory failure leaves local files but fails setup without claiming enrollment", async () => {
    const root = checkout();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runSetupCommand(
      { repoRoot: root, json: true, nonInteractive: true },
      {
        detectHarnesses: () => [],
        registrationFetch: async () => {
          throw new Error("offline");
        },
      },
    );
    expect(code).toBe(1);
    const result = JSON.parse(String(output.mock.calls[0]![0]));
    expect(result.registration.status).toBe("failed");
    expect(result.error).toContain("Local setup complete");
    expect(existsSync(join(root, ".animus/config.yaml"))).toBe(true);
  });

  test("explicit local-only setup does not attempt enrollment", async () => {
    const root = checkout();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const transport = vi.fn(async () => {
      throw new Error("must not connect");
    });
    expect(
      await runSetupCommand(
        { repoRoot: root, json: true, nonInteractive: true, localOnly: true },
        { detectHarnesses: () => [], registrationFetch: transport },
      ),
    ).toBe(0);
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0]![0])).registration.status).toBe("skipped");
  });
});
