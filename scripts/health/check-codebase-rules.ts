#!/usr/bin/env bun
/**
 * Commit-time enforcement for `mode: "block"` entries in `.animus/codebase-rules.json`.
 *
 * The edit-time guard (`.animus/hooks/loop-guard.ts`) fails open when the config is
 * missing or unparseable, which is reasonable for an interactive hook and wrong for a
 * gate. This gate parses the config loudly and reuses the guard's own evaluation
 * (glob + regex semantics), so a blocking rule holds whether the change arrived through
 * an agent edit or a plain `git commit`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { evaluateCodebaseRulesOnEdit } from "../../.animus/hooks/loop-guard";

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".trail",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css|scss|sass)$/;

type RuleEntry = { id?: unknown; file_glob?: unknown; mode?: unknown };
type BlockRule = { id: string; file_glob: string };

function findConfig(cwd: string): string | null {
  for (const candidate of [".animus/codebase-rules.json", ".factory/codebase-rules.json"]) {
    const full = join(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * Literal directory prefix every match must live under. Empty when the glob starts with
 * a wildcard, which correctly widens the scan to the whole tree.
 */
function literalPrefix(glob: string): string {
  const wildcard = glob.search(/[*?[{]/);
  return wildcard === -1 ? glob : glob.slice(0, wildcard);
}

function collectSources(cwd: string, dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSources(cwd, full, out);
      continue;
    }
    if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      out.push(relative(cwd, full).split(sep).join("/"));
    }
  }
  return out;
}

function main(): number {
  const cwd = process.cwd();
  const configPath = findConfig(cwd);
  if (!configPath) {
    console.log("Codebase rules: no config found, nothing to enforce.");
    return 0;
  }

  let parsed: { rules?: unknown };
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8")) as { rules?: unknown };
  } catch (error) {
    console.error(
      `Codebase rules: ${relative(cwd, configPath)} is not valid JSON — ${(error as Error).message}`,
    );
    return 1;
  }

  const entries = Array.isArray(parsed.rules) ? (parsed.rules as RuleEntry[]) : [];
  const blockRules = entries.filter(
    (rule): rule is BlockRule =>
      rule?.mode === "block" && typeof rule.id === "string" && typeof rule.file_glob === "string",
  );
  if (blockRules.length === 0) {
    console.log(`Codebase rules: no blocking rules in ${relative(cwd, configPath)}.`);
    return 0;
  }

  const prefixes = [
    ...new Set(blockRules.map((rule) => literalPrefix(rule.file_glob)).filter(Boolean)),
  ];
  const candidates = collectSources(cwd, cwd, []).filter(
    (rel) => prefixes.length === 0 || prefixes.some((prefix) => rel.startsWith(prefix)),
  );

  const violations: string[] = [];
  for (const rel of candidates) {
    const content = readFileSync(join(cwd, rel), "utf-8");
    for (const reason of evaluateCodebaseRulesOnEdit(cwd, rel, content).reasons) {
      violations.push(`${rel}: ${reason}`);
    }
  }

  if (violations.length > 0) {
    console.error("Codebase rule check failed (mode: block):");
    for (const violation of violations) console.error("  -", violation);
    return 1;
  }

  console.log(
    `Codebase rules passed cleanly (${blockRules.length} blocking rule(s), ${candidates.length} candidate file(s)).`,
  );
  return 0;
}

process.exit(main());
