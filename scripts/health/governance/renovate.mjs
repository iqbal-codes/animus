import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";

/**
 * Matches a target against Renovate regex or glob patterns using picomatch.
 * Supports extglobs, brace expansions, and negation per Renovate spec.
 *
 * @param {string} input
 * @param {unknown} patternOrList
 * @returns {boolean}
 */
export function matchRenovatePatternList(input, patternOrList) {
  if (patternOrList === undefined || patternOrList === null) return false;
  const list = Array.isArray(patternOrList) ? patternOrList : [patternOrList];
  if (list.length === 0) return false;

  /** @param {unknown} p */
  const isNeg = (p) => {
    const s = String(p);
    return s.startsWith("!") && !s.startsWith("!(");
  };

  const positive = list.filter((p) => !isNeg(p));
  const negative = list.filter((p) => isNeg(p));

  /** @param {string} patternStr */
  const matchSingle = (patternStr) => {
    const p = String(patternStr);
    if (p.startsWith("/") && p.endsWith("/") && p.length > 2) {
      try {
        return new RegExp(p.slice(1, -1)).test(input);
      } catch {
        return false;
      }
    }
    try {
      const isMatch = picomatch(p, { nobrace: false, bash: true });
      return isMatch(input);
    } catch {
      return false;
    }
  };

  if (positive.length > 0) {
    if (!positive.some((p) => matchSingle(p))) {
      return false;
    }
  }

  if (negative.length > 0) {
    if (!negative.every((p) => !matchSingle(String(p).slice(1)))) {
      return false;
    }
  }

  return true;
}

/**
 * Validates Renovate configuration for supply-chain security and lockfile maintenance.
 *
 * @param {string} repoRoot
 * @param {(relPath: string, label: string) => string | null} readRequiredFile
 * @param {string[]} violations
 */
export function validateRenovate(repoRoot, readRequiredFile, violations) {
  const renovateContent = readRequiredFile("renovate.json", "Renovate configuration");
  if (renovateContent === null) return;

  try {
    const parsed = JSON.parse(renovateContent);
    if (parsed.lockFileMaintenance?.enabled !== true) {
      violations.push("renovate.json must have lockFileMaintenance.enabled: true");
    }
    if (parsed.osvVulnerabilityAlerts !== true) {
      violations.push("renovate.json must have osvVulnerabilityAlerts: true");
    }
    const packageRules = parsed.packageRules;

    const canonicalPackages = [
      "lodash",
      "vite",
      "vitest",
      "express",
      "@types/node",
      "@voidzero-dev/vite-plus-core",
      "react",
    ];
    let rootOverrides = ["vite", "vitest"];
    try {
      const pkgJsonPath = join(repoRoot, "package.json");
      if (existsSync(pkgJsonPath)) {
        const rootPkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        if (rootPkg.overrides && typeof rootPkg.overrides === "object") {
          rootOverrides = Object.keys(rootPkg.overrides);
        }
      }
    } catch {}
    const testPackages = Array.from(new Set([...rootOverrides, ...canonicalPackages]));

    /** @param {any} rule */
    function ruleMatchesOverridesDepType(rule) {
      if (rule.matchDepTypes === undefined || rule.matchDepTypes === null) {
        return true;
      }
      return matchRenovatePatternList("overrides", rule.matchDepTypes);
    }

    /** @param {any} rule */
    function isUnrestrictedOverridesRule(rule) {
      if (!rule || typeof rule !== "object") return false;

      for (const key of Object.keys(rule)) {
        if (key.startsWith("exclude")) {
          const val = rule[key];
          if (val !== undefined && val !== null) {
            if (Array.isArray(val) && val.length > 0) return false;
            if (typeof val === "string" && val.length > 0) return false;
            if (typeof val === "boolean" && val === true) return false;
          }
        }
      }

      for (const key of [
        "matchPackageNames",
        "matchDepNames",
        "matchPackagePatterns",
        "matchDepPatterns",
      ]) {
        if (rule[key] !== undefined && rule[key] !== null) {
          const items = Array.isArray(rule[key]) ? rule[key] : [rule[key]];
          if (items.length === 0) return false;
          if (!testPackages.every((pkg) => matchRenovatePatternList(pkg, items))) {
            return false;
          }
        }
      }

      if (rule.matchPackagePrefixes !== undefined && rule.matchPackagePrefixes !== null) {
        const items = Array.isArray(rule.matchPackagePrefixes)
          ? rule.matchPackagePrefixes
          : [rule.matchPackagePrefixes];
        if (items.length === 0) return false;
        if (!testPackages.every((pkg) => matchRenovatePatternList(pkg, items))) {
          return false;
        }
      }

      for (const key of ["matchFileNames", "matchPaths"]) {
        if (rule[key] !== undefined && rule[key] !== null) {
          const items = Array.isArray(rule[key]) ? rule[key] : [rule[key]];
          if (items.length === 0) return false;
          if (!matchRenovatePatternList("package.json", items)) {
            return false;
          }
        }
      }

      if (rule.matchManagers !== undefined && rule.matchManagers !== null) {
        const items = Array.isArray(rule.matchManagers) ? rule.matchManagers : [rule.matchManagers];
        if (items.length === 0) return false;
        if (!matchRenovatePatternList("npm", items)) return false;
      }

      if (rule.matchUpdateTypes !== undefined && rule.matchUpdateTypes !== null) {
        const items = Array.isArray(rule.matchUpdateTypes)
          ? rule.matchUpdateTypes
          : [rule.matchUpdateTypes];
        if (items.length === 0) return false;
        if (!matchRenovatePatternList("major", items)) return false;
      }

      const knownAllowedMatchKeys = new Set([
        "matchDepTypes",
        "matchPackageNames",
        "matchDepNames",
        "matchPackagePatterns",
        "matchDepPatterns",
        "matchPackagePrefixes",
        "matchFileNames",
        "matchPaths",
        "matchManagers",
        "matchUpdateTypes",
      ]);
      for (const key of Object.keys(rule)) {
        if (key.startsWith("match") && !knownAllowedMatchKeys.has(key)) {
          return false;
        }
      }

      return true;
    }

    let effectiveOverridesMajorDisabled = false;
    let hasContradictoryOverridesRule = false;

    if (Array.isArray(packageRules)) {
      for (const rule of packageRules) {
        if (!rule || typeof rule !== "object") continue;

        const appliesToOverrides = ruleMatchesOverridesDepType(rule);
        if (!appliesToOverrides) {
          continue;
        }

        if (isUnrestrictedOverridesRule(rule) && rule.major?.enabled === false) {
          effectiveOverridesMajorDisabled = true;
          hasContradictoryOverridesRule = false;
        } else if (rule.major?.enabled === true) {
          const matchesFile =
            rule.matchFileNames === undefined && rule.matchPaths === undefined
              ? true
              : matchRenovatePatternList("package.json", rule.matchFileNames || rule.matchPaths);
          const matchesManager =
            rule.matchManagers === undefined
              ? true
              : matchRenovatePatternList("npm", rule.matchManagers);
          const matchesUpdateType =
            rule.matchUpdateTypes === undefined
              ? true
              : matchRenovatePatternList("major", rule.matchUpdateTypes);

          const hasPackageMatcher =
            rule.matchPackageNames !== undefined ||
            rule.matchDepNames !== undefined ||
            rule.matchPackagePatterns !== undefined ||
            rule.matchDepPatterns !== undefined ||
            rule.matchPackagePrefixes !== undefined;

          const matchesAnyOverridePkg = !hasPackageMatcher
            ? true
            : testPackages.some((pkg) => {
                const items =
                  rule.matchPackageNames ||
                  rule.matchDepNames ||
                  rule.matchPackagePatterns ||
                  rule.matchDepPatterns ||
                  rule.matchPackagePrefixes;
                return matchRenovatePatternList(pkg, items);
              });

          if (matchesFile && matchesManager && matchesUpdateType && matchesAnyOverridePkg) {
            effectiveOverridesMajorDisabled = false;
            hasContradictoryOverridesRule = true;
          }
        }
      }
    }

    if (!effectiveOverridesMajorDisabled || hasContradictoryOverridesRule) {
      violations.push(
        "renovate.json must disable major updates for overrides in packageRules (enabled: false)",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    violations.push(`Failed to parse renovate.json: ${message}`);
  }
}
