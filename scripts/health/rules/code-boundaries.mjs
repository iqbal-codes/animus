import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Scans a source file snippet for architectural boundary violations.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {string[]}
 */
export function scanSnippet(filePath, content) {
  const violations = [];
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Rule 1: packages/contracts cannot import apps
  if (
    normalizedPath.startsWith("packages/contracts/") ||
    normalizedPath.includes("/packages/contracts/")
  ) {
    if (
      /@animus\/backend/i.test(content) ||
      /@animus\/engine-host/i.test(content) ||
      /@animus\/launcher/i.test(content) ||
      /@animus\/web/i.test(content)
    ) {
      violations.push(`${filePath}: packages/contracts cannot import applications`);
    }
  }

  // Rule 2: packages/client cannot import server internals or Node builtins
  if (
    normalizedPath.startsWith("packages/client/") ||
    normalizedPath.includes("/packages/client/")
  ) {
    if (
      /@animus\/backend/i.test(content) ||
      /@animus\/engine-host/i.test(content) ||
      /@animus\/web/i.test(content)
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

  // Rule 3: apps/backend cannot import engine-host internals
  if (normalizedPath.startsWith("apps/backend/") || normalizedPath.includes("/apps/backend/")) {
    if (/@animus\/engine-host/i.test(content)) {
      violations.push(`${filePath}: apps/backend cannot import engine-host internals`);
    }
  }

  // Rule 4: apps/engine-host cannot import backend internals
  if (
    normalizedPath.startsWith("apps/engine-host/") ||
    normalizedPath.includes("/apps/engine-host/")
  ) {
    if (/@animus\/backend/i.test(content)) {
      violations.push(`${filePath}: apps/engine-host cannot import backend internals`);
    }
  }

  // Rule 5: apps/web cannot import server internals or Node builtins
  if (normalizedPath.startsWith("apps/web/") || normalizedPath.includes("/apps/web/")) {
    if (
      /@animus\/backend/i.test(content) ||
      /@animus\/engine-host/i.test(content) ||
      /@animus\/launcher/i.test(content)
    ) {
      violations.push(`${filePath}: apps/web cannot import server internals`);
    }
    if (
      /from\s+["']node:[^"']+["']/i.test(content) ||
      /require\(["']node:[^"']+["']\)/i.test(content)
    ) {
      violations.push(`${filePath}: apps/web cannot import Node built-ins (node:*)`);
    }
  }

  return violations;
}

/**
 * Validates that all TypeScript/JavaScript sources in packages and apps
 * adhere to internal import boundary rules.
 *
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkArchitectureRules(repoRoot) {
  /** @type {string[]} */
  const violations = [];
  const targetDirs = [
    join(repoRoot, "packages/contracts/src"),
    join(repoRoot, "packages/client/src"),
    join(repoRoot, "apps/backend/src"),
    join(repoRoot, "apps/engine-host/src"),
    join(repoRoot, "apps/web/src"),
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
