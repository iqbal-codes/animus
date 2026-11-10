import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";

// @ts-expect-error dynamic mjs import
import { checkDocumentLifecycle } from "../../scripts/health/check-docs.mjs";

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "animus-docs-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function index(entries: string[]): string {
  return ["# Documentation index", "", ...entries.map((entry) => `- [${entry}](/${entry})`)].join(
    "\n",
  );
}

function backend(routes: string[]): string {
  return routes.map((route) => `if (path === "${route}") return new Response();`).join("\n");
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("accepts active docs whose references, anchors, links, and route families resolve", () => {
  const root = fixture({
    "apps/backend/src/main.ts": backend(["/api/v1/laps", "/api/v1/projects"]),
    "docs/README.md": index(["docs/runtime.md"]),
    "docs/runtime.md": [
      "- **Status:** Active",
      "",
      "Start from `apps/backend/src/main.ts:1`.",
      "Read the [index](README.md) and call `GET /api/v1/laps`.",
    ].join("\n"),
  });

  expect(checkDocumentLifecycle(root)).toEqual({ ok: true, violations: [] });
});

test("rejects a governed doc without a Status header", () => {
  const root = fixture({
    "apps/backend/src/main.ts": backend(["/api/v1/laps"]),
    "docs/README.md": index(["docs/runtime.md"]),
    "docs/runtime.md": "# Runtime\n",
  });

  const result = checkDocumentLifecycle(root);
  expect(result.ok).toBe(false);
  expect(result.violations).toContain("docs/runtime.md: missing Status header");
});

test("rejects dead file references and out-of-range line anchors in active docs", () => {
  const root = fixture({
    "docs/README.md": index(["docs/runtime.md", "docs/old.md"]),
    "docs/runtime.md": [
      "- **Status:** Active",
      "See `docs/deleted.md` and `docs/runtime.md:99`.",
    ].join("\n"),
    "docs/old.md": "- **Status:** Historical\nSee `docs/deleted.md:1`.",
  });

  const result = checkDocumentLifecycle(root);
  expect(result.ok).toBe(false);
  expect(result.violations).toContain("docs/runtime.md: references missing path docs/deleted.md");
  expect(result.violations.some((v: string) => v.includes("docs/runtime.md:99"))).toBe(true);
  expect(result.violations.some((v: string) => v.includes("docs/old.md"))).toBe(false);
});

test("rejects broken relative links in active docs", () => {
  const root = fixture({
    "docs/README.md": index(["docs/runtime.md"]),
    "docs/runtime.md": "- **Status:** Active\nSee [missing](missing.md).",
  });

  const result = checkDocumentLifecycle(root);
  expect(result.ok).toBe(false);
  expect(result.violations).toContain("docs/runtime.md: broken link missing.md -> docs/missing.md");
});

test("rejects route families that the backend does not serve", () => {
  const root = fixture({
    "apps/backend/src/main.ts": backend(["/api/v1/laps"]),
    "docs/README.md": index(["docs/runtime.md"]),
    "docs/runtime.md": "- **Status:** Active\nCall `POST /api/laps`.",
  });

  const result = checkDocumentLifecycle(root);
  expect(result.ok).toBe(false);
  expect(result.violations.some((v: string) => v.includes("/api/laps"))).toBe(true);
});

test("rejects a docs index that does not list every governed document", () => {
  const root = fixture({
    "docs/README.md": index(["docs/runtime.md"]),
    "docs/runtime.md": "- **Status:** Active\n",
    "docs/unlisted.md": "- **Status:** Historical\n",
  });

  const result = checkDocumentLifecycle(root);
  expect(result.ok).toBe(false);
  expect(result.violations).toContain("docs/README.md: index is missing docs/unlisted.md");
});

test("requires Superseded docs to name their replacement", () => {
  const root = fixture({
    "docs/README.md": index(["docs/old.md"]),
    "docs/old.md": "- **Status:** Superseded\n",
  });

  const result = checkDocumentLifecycle(root);
  expect(result.ok).toBe(false);
  expect(result.violations).toContain(
    "docs/old.md: Superseded docs require a Superseded by reference",
  );
});
