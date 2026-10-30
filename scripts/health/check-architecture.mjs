import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_WORKSPACE_DEPENDENCIES = {
  "packages/contracts": ["@labq/client", "@labq/backend", "@labq/engine-host", "@labq/launcher"],
  "packages/client": ["@labq/backend", "@labq/engine-host", "@labq/launcher"],
  "apps/backend": ["@labq/engine-host"],
  "apps/engine-host": ["@labq/backend"],
  "apps/launcher": ["@labq/backend", "@labq/engine-host"],
};

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {string[]}
 */
export function scanSnippet(filePath, content) {
  const violations = [];
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Rule 1: packages/contracts cannot import apps or client
  if (
    normalizedPath.startsWith("packages/contracts/") ||
    normalizedPath.includes("/packages/contracts/")
  ) {
    if (
      /@labq\/client/i.test(content) ||
      /@labq\/backend/i.test(content) ||
      /@labq\/engine-host/i.test(content) ||
      /@labq\/launcher/i.test(content)
    ) {
      violations.push(`${filePath}: packages/contracts cannot import applications or client`);
    }
  }

  // Rule 2: packages/client cannot import server internals or Node builtins
  if (
    normalizedPath.startsWith("packages/client/") ||
    normalizedPath.includes("/packages/client/")
  ) {
    if (
      /@labq\/backend/i.test(content) ||
      /@labq\/engine-host/i.test(content) ||
      /@labq\/launcher/i.test(content)
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
    if (/@labq\/engine-host/i.test(content)) {
      violations.push(`${filePath}: apps/backend cannot import engine-host internals`);
    }
  }

  // Rule 4: apps/engine-host cannot import backend internals
  if (
    normalizedPath.startsWith("apps/engine-host/") ||
    normalizedPath.includes("/apps/engine-host/")
  ) {
    if (/@labq\/backend/i.test(content)) {
      violations.push(`${filePath}: apps/engine-host cannot import backend internals`);
    }
  }

  return violations;
}

/**
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkWorkspacePackageEdges(repoRoot) {
  /** @type {string[]} */
  const violations = [];
  const dependencyTypes = ["dependencies", "devDependencies", "peerDependencies"];

  for (const [pkgRelPath, forbiddenList] of Object.entries(FORBIDDEN_WORKSPACE_DEPENDENCIES)) {
    const pkgJsonPath = join(repoRoot, pkgRelPath, "package.json");
    let content;
    try {
      content = readFileSync(pkgJsonPath, "utf-8");
    } catch {
      violations.push(`${pkgRelPath}/package.json: file missing or unreadable`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      violations.push(`${pkgRelPath}/package.json: invalid JSON (${message})`);
      continue;
    }

    for (const depType of dependencyTypes) {
      const deps = parsed[depType];
      if (deps && typeof deps === "object") {
        for (const forbiddenDep of forbiddenList) {
          if (Object.prototype.hasOwnProperty.call(deps, forbiddenDep)) {
            violations.push(
              `${pkgRelPath}/package.json: forbidden dependency "${forbiddenDep}" in ${depType}`,
            );
          }
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkOpenSourceGovernanceFiles(repoRoot) {
  /** @type {string[]} */
  const violations = [];

  // 1. LICENSE (MIT)
  const licensePath = join(repoRoot, "LICENSE");
  try {
    const content = readFileSync(licensePath, "utf-8");
    if (!content.trim()) {
      violations.push("LICENSE: file is empty");
    } else if (!/MIT License|Permission is hereby granted/i.test(content)) {
      violations.push("LICENSE: must specify MIT license");
    }
  } catch {
    violations.push("LICENSE: file missing or unreadable");
  }

  // 2. CONTRIBUTING.md
  const contributingPath = join(repoRoot, "CONTRIBUTING.md");
  try {
    const content = readFileSync(contributingPath, "utf-8");
    if (!content.trim()) {
      violations.push("CONTRIBUTING.md: file is empty");
    } else {
      if (!content.includes("26.8.1")) {
        violations.push("CONTRIBUTING.md: must document pinned Node 26.8.1 toolchain");
      }
      if (!content.includes("1.4.2")) {
        violations.push("CONTRIBUTING.md: must document pinned Bun 1.4.2 toolchain");
      }
      if (!content.includes("labq-factory setup --local-only")) {
        violations.push('CONTRIBUTING.md: must document "labq-factory setup --local-only"');
      }
      if (
        !content.includes("bun run check") ||
        !content.includes("bun run test") ||
        !content.includes("bun run verify")
      ) {
        violations.push(
          'CONTRIBUTING.md: must document local check commands ("bun run check", "bun run test", "bun run verify")',
        );
      }
      if (!/architecture boundar/i.test(content)) {
        violations.push("CONTRIBUTING.md: must document architecture boundaries");
      }
    }
  } catch {
    violations.push("CONTRIBUTING.md: file missing or unreadable");
  }

  // 3. SECURITY.md
  const securityPath = join(repoRoot, "SECURITY.md");
  try {
    const content = readFileSync(securityPath, "utf-8");
    if (!content.trim()) {
      violations.push("SECURITY.md: file is empty");
    }
  } catch {
    violations.push("SECURITY.md: file missing or unreadable");
  }

  // 4. CHANGELOG.md
  const changelogPath = join(repoRoot, "CHANGELOG.md");
  try {
    const content = readFileSync(changelogPath, "utf-8");
    if (!content.trim()) {
      violations.push("CHANGELOG.md: file is empty");
    }
  } catch {
    violations.push("CHANGELOG.md: file missing or unreadable");
  }

  // 5. .gitattributes (enforcing eol=lf)
  const gitattributesPath = join(repoRoot, ".gitattributes");
  try {
    const content = readFileSync(gitattributesPath, "utf-8");
    if (!content.trim()) {
      violations.push(".gitattributes: file is empty");
    } else if (!content.includes("eol=lf")) {
      violations.push('.gitattributes: must enforce "eol=lf"');
    }
  } catch {
    violations.push(".gitattributes: file missing or unreadable");
  }

  // 6. renovate.json (lockFileMaintenance.enabled: true, osvVulnerabilityAlerts: true, and major updates disabled for overrides)
  const renovatePath = join(repoRoot, "renovate.json");
  try {
    const content = readFileSync(renovatePath, "utf-8");
    if (!content.trim()) {
      violations.push("renovate.json: file is empty");
    } else {
      try {
        const parsed = JSON.parse(content);
        if (parsed.lockFileMaintenance?.enabled !== true) {
          violations.push("renovate.json: lockFileMaintenance.enabled must be true");
        }
        if (parsed.osvVulnerabilityAlerts !== true) {
          violations.push("renovate.json: osvVulnerabilityAlerts must be true");
        }
        let hasOverridesMajorDisabled = false;
        if (Array.isArray(parsed.packageRules)) {
          for (const rule of parsed.packageRules) {
            if (rule && typeof rule === "object") {
              const matchesOverrides =
                (Array.isArray(rule.matchDepTypes) && rule.matchDepTypes.includes("overrides")) ||
                rule.matchDepTypes === "overrides";
              const majorDisabled = rule.major?.enabled === false;
              if (matchesOverrides && majorDisabled) {
                hasOverridesMajorDisabled = true;
                break;
              }
            }
          }
        }
        if (!hasOverridesMajorDisabled) {
          violations.push(
            "renovate.json: must disable major updates for overrides in packageRules",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        violations.push(`renovate.json: invalid JSON (${message})`);
      }
    }
  } catch {
    violations.push("renovate.json: file missing or unreadable");
  }

  // 7. .github/pull_request_template.md
  const prTemplatePath = join(repoRoot, ".github/pull_request_template.md");
  try {
    const content = readFileSync(prTemplatePath, "utf-8");
    if (!content.trim()) {
      violations.push(".github/pull_request_template.md: file is empty");
    }
  } catch {
    violations.push(".github/pull_request_template.md: file missing or unreadable");
  }

  // 8 & 9. .github/ISSUE_TEMPLATE/bug_report.md & feature_request.md
  const issueTemplates = [
    { name: "bug_report.md", relPath: ".github/ISSUE_TEMPLATE/bug_report.md" },
    { name: "feature_request.md", relPath: ".github/ISSUE_TEMPLATE/feature_request.md" },
  ];

  const requiredSections = [
    "Source and problem",
    "Outcome",
    "Invariants",
    "Acceptance criteria",
    "Boundary",
    "Depends on:",
  ];

  for (const template of issueTemplates) {
    const templatePath = join(repoRoot, template.relPath);
    try {
      const content = readFileSync(templatePath, "utf-8");
      if (!content.trim()) {
        violations.push(`${template.relPath}: file is empty`);
        continue;
      }

      // Check labels: must include needs-triage and NEVER include ready-for-agent
      const hasNeedsTriage =
        /labels:.*\bneeds-triage\b/s.test(content) || /-\s+needs-triage/.test(content);
      const hasReadyForAgent = /ready-for-agent/.test(content);

      if (!hasNeedsTriage) {
        violations.push(`${template.relPath}: must default to "labels: needs-triage"`);
      }
      if (hasReadyForAgent) {
        violations.push(`${template.relPath}: must never default to "ready-for-agent"`);
      }

      // Check canonical factory contract sections
      for (const section of requiredSections) {
        if (!content.includes(section)) {
          violations.push(`${template.relPath}: missing canonical section "${section}"`);
        }
      }
    } catch {
      violations.push(`${template.relPath}: file missing or unreadable`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
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

  // Check workspace package.json dependency edges
  const edgeResult = checkWorkspacePackageEdges(repoRoot);
  violations.push(...edgeResult.violations);

  // Check open-source community, security, and supply-chain governance files
  const govResult = checkOpenSourceGovernanceFiles(repoRoot);
  violations.push(...govResult.violations);

  return {
    ok: violations.length === 0,
    violations,
  };
}

checkArchitectureRules.scanSnippet = scanSnippet;
checkArchitectureRules.checkWorkspacePackageEdges = checkWorkspacePackageEdges;
checkArchitectureRules.checkOpenSourceGovernanceFiles = checkOpenSourceGovernanceFiles;

const isMain =
  process.argv[1] &&
  process.argv[1].endsWith("check-architecture.mjs") &&
  fileURLToPath(import.meta.url) === process.argv[1];
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
    "Architecture boundary rules passed cleanly (packages/contracts, packages/client, apps/backend, apps/engine-host).",
  );
}
