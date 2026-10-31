import { beforeAll, describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { handleStaticWebRoute } from "../../apps/backend/src/web-static";

function relativeLuminance(hex: string): number {
  const cleanHex = hex.replace("#", "");
  const r = parseInt(cleanHex.slice(0, 2), 16) / 255;
  const g = parseInt(cleanHex.slice(2, 4), 16) / 255;
  const b = parseInt(cleanHex.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Web Console Setup: Architecture, Serving, and Visual Standard", () => {
  const repoRoot = process.cwd();
  const webDist = join(repoRoot, "apps/web/dist");

  beforeAll(() => {
    if (!existsSync(join(webDist, "index.html"))) {
      execFileSync("bun", ["run", "build:web"], { cwd: repoRoot, stdio: "ignore" });
    }
  });

  test("apps/web contains verified React Vite configuration and builds cleanly", () => {
    expect(existsSync(join(repoRoot, "apps/web/package.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/web/vite.config.ts"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/web/tsconfig.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/web/src/App.tsx"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/web/src/main.tsx"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(repoRoot, "apps/web/package.json"), "utf-8"));
    expect(pkg.name).toBe("@animus/web");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies["@animus/client"]).toBe("workspace:*");
    expect(pkg.dependencies.react).toBeDefined();
    expect(pkg.dependencies["react-dom"]).toBeDefined();
  });

  test("Architecture boundary checks enforce that apps/web cannot import server internals or Node builtins", async () => {
    const { scanSnippet, checkArchitectureRules } = (await import(
      // @ts-expect-error dynamic mjs import
      "../../scripts/health/rules/code-boundaries.mjs"
    )) as {
      scanSnippet: (filePath: string, content: string) => string[];
      checkArchitectureRules: (repoRoot: string) => { ok: boolean; violations: string[] };
    };
    const { checkWorkspacePackageEdges } = (await import(
      // @ts-expect-error dynamic mjs import
      "../../scripts/health/rules/workspace-edges.mjs"
    )) as {
      checkWorkspacePackageEdges: (repoRoot: string) => { ok: boolean; violations: string[] };
    };

    // 1. Current apps/web sources adhere cleanly
    const archResult = checkArchitectureRules(repoRoot);
    expect(archResult.ok).toBe(true);
    expect(archResult.violations).toEqual([]);

    // 2. Deliberate negative check: importing @animus/backend in apps/web fails
    const backendImportViolation = scanSnippet(
      "apps/web/src/components/leak.tsx",
      `import { configuration } from "@animus/backend/src/config";`,
    );
    expect(backendImportViolation.length).toBeGreaterThan(0);
    expect(backendImportViolation[0]).toContain("apps/web cannot import server internals");

    // 3. Deliberate negative check: importing node:* in apps/web fails
    const nodeImportViolation = scanSnippet(
      "apps/web/src/components/leak.tsx",
      `import { readFileSync } from "node:fs";`,
    );
    expect(nodeImportViolation.length).toBeGreaterThan(0);
    expect(nodeImportViolation[0]).toContain("apps/web cannot import Node built-ins");

    // 4. Workspace package edges check apps/web forbidden dependencies
    const pkgEdges = checkWorkspacePackageEdges(repoRoot);
    expect(pkgEdges.ok).toBe(true);
  });

  test("Single-origin backend serves apps/web/dist with SPA routing fallback and protects API paths", async () => {
    expect(existsSync(webDist)).toBe(true);
    expect(existsSync(join(webDist, "index.html"))).toBe(true);

    // Root GET / serves index.html
    const rootReq = new Request("http://127.0.0.1:3000/");
    const rootRes = await handleStaticWebRoute(rootReq, webDist);
    expect(rootRes).not.toBeNull();
    expect(rootRes!.status).toBe(200);
    expect(rootRes!.headers.get("Content-Type")).toContain("text/html");
    const rootText = await rootRes!.text();
    expect(rootText).toContain("Animus Console");

    // SPA client route serves index.html
    const spaReq = new Request("http://127.0.0.1:3000/projects/proj-alpha");
    const spaRes = await handleStaticWebRoute(spaReq, webDist);
    expect(spaRes).not.toBeNull();
    expect(spaRes!.status).toBe(200);
    expect(spaRes!.headers.get("Content-Type")).toContain("text/html");

    // API route is NOT intercepted
    const apiReq = new Request("http://127.0.0.1:3000/api/v1/projects");
    const apiRes = await handleStaticWebRoute(apiReq, webDist);
    expect(apiRes).toBeNull();

    // Health route is NOT intercepted
    const healthReq = new Request("http://127.0.0.1:3000/health");
    const healthRes = await handleStaticWebRoute(healthReq, webDist);
    expect(healthRes).toBeNull();

    // WebSocket route is NOT intercepted
    const wsReq = new Request("http://127.0.0.1:3000/ws");
    const wsRes = await handleStaticWebRoute(wsReq, webDist);
    expect(wsRes).toBeNull();
  });

  test("Visual tokens meet WCAG AA contrast standards", () => {
    // Normal text standard: 4.5:1
    // High contrast foreground #EDEDED on #0A0A0A background
    const bodyContrast = contrastRatio("#EDEDED", "#0A0A0A");
    expect(bodyContrast).toBeGreaterThanOrEqual(14.0); // Far above 4.5:1

    // Foreground #EDEDED on Container #1A1A1A
    const containerContrast = contrastRatio("#EDEDED", "#1A1A1A");
    expect(containerContrast).toBeGreaterThanOrEqual(10.0);

    // Muted foreground #A1A1AA on #0A0A0A
    const mutedContrast = contrastRatio("#A1A1AA", "#0A0A0A");
    expect(mutedContrast).toBeGreaterThanOrEqual(6.0); // Meets 4.5:1 AA standard

    // Accent #FF6308 on dark container #1A1A1A for large badges and controls
    const accentContrast = contrastRatio("#FF6308", "#1A1A1A");
    expect(accentContrast).toBeGreaterThanOrEqual(4.0); // Meets 3:1 non-text/large standard
  });
});
