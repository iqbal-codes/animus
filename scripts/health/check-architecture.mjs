import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {string[]}
 */
export function scanSnippet(filePath, content) {
  const violations = [];
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Rule 1: apps/web cannot import backend, engine-host, or node builtins
  if (normalizedPath.startsWith("apps/web/") || normalizedPath.includes("/apps/web/")) {
    if (/@labq\/backend/i.test(content) || /@labq\/engine-host/i.test(content)) {
      violations.push(
        `${filePath}: apps/web cannot import server internals (@labq/backend or @labq/engine-host)`,
      );
    }
    if (
      /from\s+["']node:[^"']+["']/i.test(content) ||
      /require\(["']node:[^"']+["']\)/i.test(content)
    ) {
      violations.push(`${filePath}: apps/web cannot import Node built-ins (node:*)`);
    }
  }

  // Rule 2: packages/contracts cannot import apps
  if (
    normalizedPath.startsWith("packages/contracts/") ||
    normalizedPath.includes("/packages/contracts/")
  ) {
    if (
      /@labq\/backend/i.test(content) ||
      /@labq\/engine-host/i.test(content) ||
      /@labq\/web/i.test(content)
    ) {
      violations.push(`${filePath}: packages/contracts cannot import applications`);
    }
  }

  // Rule 3: packages/client cannot import server internals or Node builtins
  if (
    normalizedPath.startsWith("packages/client/") ||
    normalizedPath.includes("/packages/client/")
  ) {
    if (
      /@labq\/backend/i.test(content) ||
      /@labq\/engine-host/i.test(content) ||
      /@labq\/web/i.test(content)
    ) {
      violations.push(`${filePath}: packages/client cannot import server internals`);
    }
    if (
      /from\s+["']node:[^"']+["']/i.test(content) ||
      /require\(["']node:[^"']+["']\)/i.test(content)
    ) {
      violations.push(`${filePath}: packages/client cannot import Node built-ins (node:*)`);
    }
  }

  return violations;
}

/**
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkArchitectureRules(repoRoot) {
  /** @type {string[]} */
  const violations = [];
  const targetDirs = [
    join(repoRoot, "apps/web/src"),
    join(repoRoot, "packages/contracts/src"),
    join(repoRoot, "packages/client/src"),
  ];

  /**
   * @param {string} dir
   */
  function walk(dir) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
          const content = readFileSync(fullPath, "utf-8");
          const relPath = relative(repoRoot, fullPath);
          const fileViolations = scanSnippet(relPath, content);
          violations.push(...fileViolations);
        }
      }
    } catch {}
  }

  for (const dir of targetDirs) {
    walk(dir);
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

checkArchitectureRules.scanSnippet = scanSnippet;

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const result = checkArchitectureRules(process.cwd());
  if (!result.ok) {
    console.error("Architecture boundary check failed:");
    for (const v of result.violations) {
      console.error("  -", v);
    }
    process.exit(1);
  }
  console.log(
    "Architecture boundary rules passed cleanly (apps/web, packages/contracts, packages/client).",
  );
}
