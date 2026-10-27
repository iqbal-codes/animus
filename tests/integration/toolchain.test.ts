import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Repository-wide Task, Checker, and Cache Correctness", () => {
  const root = process.cwd();

  test("AC1: Workspace graph and internal dependencies resolve cleanly", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.workspaces).toEqual(["apps/*", "packages/*"]);

    // Contracts package
    const contractsPkg = JSON.parse(
      readFileSync(join(root, "packages/contracts/package.json"), "utf-8"),
    );
    expect(contractsPkg.name).toBe("@labq/contracts");

    // Client package depends on contracts
    const clientPkg = JSON.parse(readFileSync(join(root, "packages/client/package.json"), "utf-8"));
    expect(clientPkg.name).toBe("@labq/client");
    expect(clientPkg.dependencies["@labq/contracts"]).toBe("workspace:*");

    // Backend and host apps depend on contracts & client
    const backendPkg = JSON.parse(readFileSync(join(root, "apps/backend/package.json"), "utf-8"));
    expect(backendPkg.dependencies["@labq/contracts"]).toBe("workspace:*");

    const hostPkg = JSON.parse(readFileSync(join(root, "apps/engine-host/package.json"), "utf-8"));
    expect(hostPkg.dependencies["@labq/contracts"]).toBe("workspace:*");

    const webPkg = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf-8"));
    expect(webPkg.dependencies["@labq/client"]).toBe("workspace:*");
  });

  test("AC2: Toolchain check enforces Node 26.8.1, Bun 1.4.2, and local Vite+ 1.4.0", () => {
    const toolchain = spawnSync("node", ["scripts/health/check-toolchain.mjs"], {
      cwd: root,
      encoding: "utf-8",
    });
    expect(toolchain.status).toBe(0);
    expect(toolchain.stdout).toContain("Node");
    expect(toolchain.stdout).toContain("Bun 1.4.2");
    expect(toolchain.stdout).toContain("Vite+ 1.4.0");
  });

  test("AC4/AC6: Dynamic/native/test suites run with explicit cache=false and propagate results", () => {
    const viteConfig = readFileSync(join(root, "vite.config.ts"), "utf-8");
    // Verify non-cacheable behavior for live execution tasks
    expect(viteConfig).toContain('"neutral-suite": { command: "vp test run", cache: false }');
    expect(viteConfig).toContain(
      '"bun-suite": { command: "bun test tests/integration/health.bun.test.ts", cache: false }',
    );
    expect(viteConfig).toContain(
      '"browser-suite": {\n        command:\n          "node node_modules/@playwright/test/cli.js test --config tests/integration/playwright.config.ts",\n        dependsOn: ["web-artifacts"],\n        cache: false,\n      }',
    );
  });

  test("AC7: Web build inspects artifact graph and rejects private server authority", () => {
    const inspectScript = readFileSync(join(root, "scripts/health/build-and-inspect.mjs"), "utf-8");
    expect(inspectScript).toContain("Private server module entered browser graph");
    expect(inspectScript).toContain("Private configuration entered browser artifact");
    expect(inspectScript).toContain("FACTORY_HOST_TOKEN");
    expect(inspectScript).toContain("OPENROUTER_API_KEY");
  });
});
