import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(
  new URL("../../scripts/health/check-codebase-rules.ts", import.meta.url),
);

type Rule = {
  id: string;
  description: string;
  file_glob: string;
  replacement_hint: string;
  forbid_regex?: string;
  require_regex?: string;
  mode?: "warn" | "block";
};

const NO_ANY: Rule = {
  id: "no-any",
  description: "TypeScript `any` is banned at seams",
  file_glob: "src/**/*.ts",
  forbid_regex: ":\\s*any\\b",
  replacement_hint: "Use the domain type, or `unknown` plus narrowing",
  mode: "block",
};

let dir = "";

function writeRules(rules: Rule[], raw?: string): void {
  mkdirSync(join(dir, ".animus"), { recursive: true });
  writeFileSync(
    join(dir, ".animus/codebase-rules.json"),
    raw ?? JSON.stringify({ schema_version: 1, rules }, null, 2),
  );
}

function writeSource(relPath: string, content: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function runGate(): { code: number; output: string } {
  const proc = spawnSync("bun", [GATE], { cwd: dir, encoding: "utf-8" });
  return { code: proc.status ?? -1, output: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "animus-rules-gate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("codebase rules commit gate", () => {
  test("passes when the repo has no rules config", () => {
    writeSource("src/app.ts", "export const value = 1;\n");

    const result = runGate();

    expect(result.code).toBe(0);
    expect(result.output).toContain("no config found");
  });

  test("fails on a blocking rule violation and names the rule", () => {
    writeRules([NO_ANY]);
    writeSource("src/app.ts", "export function parse(input: any) { return input; }\n");

    const result = runGate();

    expect(result.code).toBe(1);
    expect(result.output).toContain("[no-any]");
    expect(result.output).toContain("src/app.ts");
    expect(result.output).toContain("domain type");
  });

  test("passes when a blocking rule is not violated", () => {
    writeRules([NO_ANY]);
    writeSource("src/app.ts", "export function parse(input: unknown) { return input; }\n");

    const result = runGate();

    expect(result.code).toBe(0);
    expect(result.output).toContain("passed cleanly");
  });

  test("does not block warn-mode violations at commit time", () => {
    writeRules([{ ...NO_ANY, mode: "warn" }]);
    writeSource("src/app.ts", "export function parse(input: any) { return input; }\n");

    const result = runGate();

    expect(result.code).toBe(0);
  });

  test("ignores files outside the rule glob", () => {
    writeRules([NO_ANY]);
    writeSource("scripts/tool.ts", "export function parse(input: any) { return input; }\n");

    const result = runGate();

    expect(result.code).toBe(0);
    expect(result.output).toContain("passed cleanly");
  });

  test("fails closed when the config is unparseable", () => {
    writeRules([NO_ANY], '{ "schema_version": 1, "rules": [ }');

    const result = runGate();

    expect(result.code).toBe(1);
    expect(result.output).toContain("not valid JSON");
  });
});
