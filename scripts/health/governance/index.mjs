import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateBasicGovernance } from "./basic-governance.mjs";
import { validateGitAttributes } from "./gitattributes.mjs";
import { validateRenovate } from "./renovate.mjs";
import { validateIssueTemplates } from "./issue-templates.mjs";

/**
 * Verifies the presence and non-empty validity of open-source community,
 * security, supply-chain, and contributor governance files.
 *
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkOpenSourceGovernanceFiles(repoRoot) {
  /** @type {string[]} */
  const violations = [];

  /**
   * @param {string} relPath
   * @param {string} label
   * @returns {string | null}
   */
  function readRequiredFile(relPath, label) {
    const fullPath = join(repoRoot, relPath);
    if (!existsSync(fullPath)) {
      violations.push(`${label || relPath} is missing: ${relPath}`);
      return null;
    }
    try {
      const content = readFileSync(fullPath, "utf-8");
      if (!content.trim()) {
        violations.push(`${label || relPath} is empty: ${relPath}`);
        return null;
      }
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      violations.push(`Failed to read ${label || relPath} (${relPath}): ${message}`);
      return null;
    }
  }

  validateBasicGovernance(repoRoot, readRequiredFile, violations);
  validateGitAttributes(repoRoot, readRequiredFile, violations);
  validateRenovate(repoRoot, readRequiredFile, violations);
  validateIssueTemplates(repoRoot, readRequiredFile, violations);

  return {
    ok: violations.length === 0,
    violations,
  };
}
