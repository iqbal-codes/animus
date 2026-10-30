import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
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

  // Rule 1: packages/contracts cannot import apps or client
  if (
    normalizedPath.startsWith("packages/contracts/") ||
    normalizedPath.includes("/packages/contracts/")
  ) {
    if (
      /@labq\/backend/i.test(content) ||
      /@labq\/engine-host/i.test(content) ||
      /@labq\/launcher/i.test(content) ||
      /@labq\/client/i.test(content)
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
 * Validates dependencies, devDependencies, and peerDependencies across workspace packages.
 *
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkWorkspacePackageEdges(repoRoot) {
  /** @type {string[]} */
  const violations = [];

  const workspaceRules = [
    {
      pkgRel: "packages/contracts/package.json",
      forbidden: ["@labq/client", "@labq/backend", "@labq/engine-host", "@labq/launcher"],
    },
    {
      pkgRel: "packages/client/package.json",
      forbidden: ["@labq/backend", "@labq/engine-host", "@labq/launcher"],
    },
    {
      pkgRel: "apps/backend/package.json",
      forbidden: ["@labq/engine-host"],
    },
    {
      pkgRel: "apps/engine-host/package.json",
      forbidden: ["@labq/backend"],
    },
    {
      pkgRel: "apps/launcher/package.json",
      forbidden: [],
    },
  ];

  for (const { pkgRel, forbidden } of workspaceRules) {
    const fullPath = join(repoRoot, pkgRel);
    if (!existsSync(fullPath)) {
      violations.push(`${pkgRel}: package.json missing`);
      continue;
    }

    let pkgJson;
    try {
      const raw = readFileSync(fullPath, "utf-8");
      pkgJson = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      violations.push(`${pkgRel}: failed to parse package.json: ${message}`);
      continue;
    }

    const depSections = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];

    for (const section of depSections) {
      const deps = pkgJson[section];
      if (deps && typeof deps === "object") {
        for (const dep of Object.keys(deps)) {
          if (forbidden.includes(dep)) {
            violations.push(
              `${pkgRel}: forbidden workspace dependency "${dep}" declared in ${section}`,
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

  // 1. LICENSE (MIT)
  const licenseContent = readRequiredFile("LICENSE", "License file");
  if (licenseContent !== null) {
    if (
      !/MIT License/i.test(licenseContent) &&
      !/Permission is hereby granted/i.test(licenseContent)
    ) {
      violations.push("LICENSE does not specify a valid MIT license");
    }
  }

  // 2. CONTRIBUTING.md
  const contributingContent = readRequiredFile("CONTRIBUTING.md", "Contributing guide");
  if (contributingContent !== null) {
    if (!contributingContent.includes("26.8.1")) {
      violations.push("CONTRIBUTING.md must document pinned Node version 26.8.1");
    }
    if (!contributingContent.includes("1.4.2")) {
      violations.push("CONTRIBUTING.md must document pinned Bun version 1.4.2");
    }
    if (!contributingContent.includes("labq-factory setup --local-only")) {
      violations.push("CONTRIBUTING.md must document 'labq-factory setup --local-only'");
    }
    if (!contributingContent.includes("bun run check")) {
      violations.push("CONTRIBUTING.md must document 'bun run check'");
    }
    if (!contributingContent.includes("bun run test")) {
      violations.push("CONTRIBUTING.md must document 'bun run test'");
    }
    if (!contributingContent.includes("bun run verify")) {
      violations.push("CONTRIBUTING.md must document 'bun run verify'");
    }
    if (
      !contributingContent.includes("@labq/contracts") ||
      !contributingContent.includes("@labq/client") ||
      !contributingContent.includes("apps/backend") ||
      !contributingContent.includes("apps/engine-host")
    ) {
      violations.push(
        "CONTRIBUTING.md must document architecture boundaries (@labq/contracts, @labq/client, apps/backend, apps/engine-host)",
      );
    }
  }

  // 3. SECURITY.md
  readRequiredFile("SECURITY.md", "Security policy");

  // 4. CHANGELOG.md
  const changelogContent = readRequiredFile("CHANGELOG.md", "Changelog");
  if (changelogContent !== null) {
    if (!changelogContent.includes("# Changelog")) {
      violations.push("CHANGELOG.md must contain '# Changelog' header");
    }
  }

  // 5. .gitattributes
  const gitattrContent = readRequiredFile(".gitattributes", "Git attributes");
  if (gitattrContent !== null) {
    if (!gitattrContent.includes("eol=lf")) {
      violations.push(".gitattributes must enforce LF line endings (eol=lf)");
    }
  }

  // 6. renovate.json
  const renovateContent = readRequiredFile("renovate.json", "Renovate configuration");
  if (renovateContent !== null) {
    try {
      const parsed = JSON.parse(renovateContent);
      if (parsed.lockFileMaintenance?.enabled !== true) {
        violations.push("renovate.json must have lockFileMaintenance.enabled: true");
      }
      if (parsed.osvVulnerabilityAlerts !== true) {
        violations.push("renovate.json must have osvVulnerabilityAlerts: true");
      }
      const packageRules =
        /** @type {Array<{ matchDepTypes?: string | string[]; major?: { enabled?: boolean } }>} */ (
          parsed.packageRules
        );
      const hasOverridesRule =
        Array.isArray(packageRules) &&
        packageRules.some((rule) => {
          const matchTypes = Array.isArray(rule.matchDepTypes)
            ? rule.matchDepTypes
            : [rule.matchDepTypes];
          const isOverrides = matchTypes.includes("overrides");
          return isOverrides && rule.major?.enabled === false;
        });
      if (!hasOverridesRule) {
        violations.push("renovate.json must disable major updates for overrides in packageRules");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      violations.push(`renovate.json is not valid JSON: ${message}`);
    }
  }

  // 7. .github/pull_request_template.md
  readRequiredFile(".github/pull_request_template.md", "Pull request template");

  // 8. .github/ISSUE_TEMPLATE/bug_report.md & feature_request.md
  const issueTemplates = [
    { rel: ".github/ISSUE_TEMPLATE/bug_report.md", label: "Bug report template" },
    { rel: ".github/ISSUE_TEMPLATE/feature_request.md", label: "Feature request template" },
  ];

  const canonicalSections = [
    "Source and problem",
    "Outcome",
    "Invariants",
    "Acceptance criteria",
    "Boundary",
    "Depends on:",
  ];

  for (const { rel, label } of issueTemplates) {
    const tmplContent = readRequiredFile(rel, label);
    if (tmplContent !== null) {
      if (!/labels:\s*needs-triage/i.test(tmplContent)) {
        violations.push(`${rel} must default labels to 'needs-triage'`);
      }
      if (/ready-for-agent/i.test(tmplContent)) {
        violations.push(`${rel} must NEVER default labels to 'ready-for-agent'`);
      }
      for (const section of canonicalSections) {
        if (!tmplContent.includes(section)) {
          violations.push(`${rel} missing canonical contract section: '${section}'`);
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

  // Validate declared workspace package edges
  const edgeResult = checkWorkspacePackageEdges(repoRoot);
  violations.push(...edgeResult.violations);

  // Validate open-source governance, security, and contributor files
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
    console.error("Architecture boundary and governance checks failed:");
    for (const v of result.violations) {
      console.error("  -", v);
    }
    process.exit(1);
  }
  console.log(
    "Architecture boundary rules, workspace package edges, and open-source governance passed cleanly.",
  );
}
