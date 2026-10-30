import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
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
    const hasMitMention = /MIT License|MIT/i.test(licenseContent);
    const hasGrant = /Permission is hereby granted/i.test(licenseContent);
    const hasRights = /without restriction/i.test(licenseContent);
    const hasDisclaimer = /without warranty of any kind/i.test(licenseContent);
    if (!hasMitMention || !hasGrant || !hasRights || !hasDisclaimer) {
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
    const lines = gitattrContent.split(/\r?\n/);
    /** @type {Array<{ pattern: string, line: string, attrs: Map<string, string | boolean> }>} */
    const parsedRules = [];
    /** @type {string[]} */
    const conflictingRules = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }

      const tokens = trimmed.split(/\s+/);
      if (tokens.length < 2) {
        continue;
      }

      const pattern = tokens[0];
      const attrTokens = tokens.slice(1);
      const attrs = new Map();

      for (const token of attrTokens) {
        if (token === "eol=crlf" || token === "eol=native" || token === "crlf") {
          conflictingRules.push(trimmed);
        }
        if (token.includes("=")) {
          const [k, v] = token.split("=");
          attrs.set(k, v);
        } else if (token.startsWith("-")) {
          const k = token.slice(1);
          attrs.set(k, false);
        } else if (token.startsWith("!")) {
          const k = token.slice(1);
          attrs.set(k, "unspecified");
        } else {
          if (token === "binary") {
            attrs.set("binary", true);
            attrs.set("text", false);
            attrs.set("diff", false);
            attrs.set("merge", false);
            attrs.set("eol", "unspecified");
          } else if (token === "crlf") {
            attrs.set("text", true);
            attrs.set("eol", "crlf");
          } else {
            attrs.set(token, true);
          }
        }
      }

      if (pattern !== "*") {
        try {
          gitPatternToRegex(pattern);
        } catch {
          violations.push(`.gitattributes contains unsupported or invalid pattern: '${pattern}'`);
        }
      }

      parsedRules.push({ pattern, line: trimmed, attrs });
    }

    const hasActiveEolLf = parsedRules.some((r) => r.attrs.get("eol") === "lf");
    if (!hasActiveEolLf) {
      violations.push(".gitattributes must enforce LF line endings (eol=lf)");
    }

    if (conflictingRules.length > 0) {
      for (const conflict of conflictingRules) {
        violations.push(
          `.gitattributes contains conflicting non-LF line ending rule: '${conflict}'`,
        );
      }
    }

    /**
     * @param {string} pattern
     * @returns {{ hasSlash: boolean, regex: RegExp }}
     */
    function gitPatternToRegex(pattern) {
      let hasSlash = pattern.includes("/");
      let p = pattern;
      if (p.startsWith("/")) {
        p = p.slice(1);
        hasSlash = true;
      }

      let regexStr = "";
      let i = 0;
      while (i < p.length) {
        const c = p[i];
        if (c === "\\") {
          if (i + 1 < p.length) {
            const next = p[i + 1];
            if (".+*?^$()[]{}|\\".includes(next)) {
              regexStr += "\\" + next;
            } else {
              regexStr += next;
            }
            i += 2;
          } else {
            regexStr += "\\\\";
            i++;
          }
        } else if (c === "*") {
          if (p[i + 1] === "*") {
            if (p.startsWith("/**/", i)) {
              regexStr += "(?:/|/.+/)?";
              i += 4;
            } else if (p.startsWith("**/", i)) {
              regexStr += "(?:.*/)?";
              i += 3;
            } else if (p.slice(i) === "/**") {
              regexStr += "(?:/.*)?";
              i += 3;
            } else {
              regexStr += ".*";
              i += 2;
            }
          } else {
            regexStr += "[^/]*";
            i++;
          }
        } else if (c === "?") {
          regexStr += "[^/]";
          i++;
        } else if (c === "[") {
          const closeIdx = p.indexOf("]", i + 1);
          if (closeIdx === -1) {
            throw new Error(`Unclosed bracket expression in pattern: '${pattern}'`);
          }
          let inside = p.slice(i + 1, closeIdx);
          if (inside.startsWith("!") || inside.startsWith("^")) {
            inside = "^/" + inside.slice(1);
          }
          regexStr += "[" + inside + "]";
          i = closeIdx + 1;
        } else if (".+^${}()|".includes(c)) {
          regexStr += "\\" + c;
          i++;
        } else {
          regexStr += c;
          i++;
        }
      }

      return { hasSlash, regex: new RegExp(`^${regexStr}$`) };
    }

    /**
     * @param {string} pattern
     * @param {string} filePath
     */
    function matchGitAttrPattern(pattern, filePath) {
      if (pattern === "*") return true;
      const normalizedPath = filePath.replace(/\\/g, "/").replace(/^[/]+/, "");
      try {
        const { hasSlash, regex } = gitPatternToRegex(pattern);
        if (!hasSlash) {
          const name = basename(normalizedPath);
          return regex.test(name);
        }
        return regex.test(normalizedPath);
      } catch {
        return false;
      }
    }

    /**
     * @param {string} filePath
     */
    function getEffectiveAttrs(filePath) {
      let effText = undefined;
      let effEol = undefined;
      for (const { pattern, attrs } of parsedRules) {
        if (matchGitAttrPattern(pattern, filePath)) {
          if (attrs.has("text")) {
            effText = attrs.get("text");
          }
          if (attrs.has("eol")) {
            effEol = attrs.get("eol");
          }
        }
      }
      return { text: effText, eol: effEol };
    }

    const BINARY_EXTENSIONS = new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
      ".webp",
      ".bmp",
      ".tiff",
      ".pdf",
      ".zip",
      ".tar",
      ".gz",
      ".tgz",
      ".woff",
      ".woff2",
      ".ttf",
      ".eot",
      ".mp3",
      ".mp4",
      ".wav",
      ".db",
      ".sqlite",
      ".bin",
      ".exe",
      ".so",
      ".dylib",
      ".dll",
    ]);

    const requiredFileClasses = [
      "script.sh",
      "config.json",
      "source.ts",
      "index.js",
      "doc.md",
      "workflow.yml",
    ];

    const filesToCheck = new Set(requiredFileClasses);

    // Include explicit non-binary file paths targeted in .gitattributes rules
    for (const { pattern } of parsedRules) {
      if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
        const clean = pattern.replace(/\\/g, "/").replace(/^[/]+/, "");
        const ext = extname(clean).toLowerCase();
        if (!BINARY_EXTENSIONS.has(ext)) {
          filesToCheck.add(clean);
        }
      }
    }

    // Include existing repository text files discovered on disk
    /**
     * @param {string} dir
     * @param {string} [rel]
     */
    function scanTextFiles(dir, rel = "") {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === "dist" ||
            entry.name === ".factory" ||
            entry.name === "coverage" ||
            entry.name === ".cache" ||
            entry.name.startsWith(".vitest")
          ) {
            continue;
          }
          const full = join(dir, entry.name);
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            scanTextFiles(full, relPath);
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            if (!BINARY_EXTENSIONS.has(ext)) {
              filesToCheck.add(relPath);
            }
          }
        }
      } catch {
        // Fall back gracefully to files already added
      }
    }
    scanTextFiles(repoRoot);

    const failedFiles = Array.from(filesToCheck).filter((f) => {
      const { text, eol } = getEffectiveAttrs(f);
      // In Git, LF line ending normalization requires:
      // 1) text attribute enabled ('true' or 'auto')
      // 2) eol attribute explicitly set to 'lf'
      // If text is unset (false), binary, or unspecified, Git does not perform eol conversion.
      const isTextEnabled = text === true || text === "auto";
      const isEolLf = eol === "lf";
      return !isTextEnabled || !isEolLf;
    });
    if (failedFiles.length > 0) {
      violations.push(
        `.gitattributes does not effectively enforce eol=lf for required file classes (${failedFiles.join(", ")})`,
      );
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
      const packageRules = parsed.packageRules;

      /**
       * @param {any} rule
       * @returns {boolean}
       */
      function ruleMatchesOverridesDepType(rule) {
        if (rule.matchDepTypes === undefined || rule.matchDepTypes === null) {
          return true;
        }
        const types = Array.isArray(rule.matchDepTypes) ? rule.matchDepTypes : [rule.matchDepTypes];
        return types.includes("overrides") || types.includes("*");
      }

      /**
       * @param {any} rule
       * @returns {boolean}
       */
      function isUnrestrictedOverridesRule(rule) {
        if (!rule || typeof rule !== "object") return false;

        // Any non-empty exclude* property restricts the rule
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

        // Check package name / dep name matchers
        for (const key of ["matchPackageNames", "matchDepNames"]) {
          if (rule[key] !== undefined && rule[key] !== null) {
            const items = Array.isArray(rule[key]) ? rule[key] : [rule[key]];
            if (items.length === 0) return false;
            for (const item of items) {
              if (item !== "*" && item !== ".*") return false;
            }
          }
        }

        // Check package pattern / dep pattern matchers
        for (const key of ["matchPackagePatterns", "matchDepPatterns"]) {
          if (rule[key] !== undefined && rule[key] !== null) {
            const items = Array.isArray(rule[key]) ? rule[key] : [rule[key]];
            if (items.length === 0) return false;
            for (const item of items) {
              if (item !== "*" && item !== ".*") return false;
            }
          }
        }

        // Check package prefixes
        if (rule.matchPackagePrefixes !== undefined && rule.matchPackagePrefixes !== null) {
          const items = Array.isArray(rule.matchPackagePrefixes)
            ? rule.matchPackagePrefixes
            : [rule.matchPackagePrefixes];
          if (items.length === 0) return false;
          for (const item of items) {
            if (item !== "*") return false;
          }
        }

        // Check file / path matchers
        for (const key of ["matchFileNames", "matchPaths"]) {
          if (rule[key] !== undefined && rule[key] !== null) {
            const items = Array.isArray(rule[key]) ? rule[key] : [rule[key]];
            if (items.length === 0) return false;
            for (const item of items) {
              if (item !== "*" && item !== "**/*") return false;
            }
          }
        }

        // Check manager matchers
        if (rule.matchManagers !== undefined && rule.matchManagers !== null) {
          const items = Array.isArray(rule.matchManagers)
            ? rule.matchManagers
            : [rule.matchManagers];
          if (items.length === 0) return false;
          if (!items.includes("npm") && !items.includes("*")) return false;
        }

        // Check update type matchers
        if (rule.matchUpdateTypes !== undefined && rule.matchUpdateTypes !== null) {
          const items = Array.isArray(rule.matchUpdateTypes)
            ? rule.matchUpdateTypes
            : [rule.matchUpdateTypes];
          if (items.length === 0) return false;
          if (!items.includes("major") && !items.includes("*")) return false;
        }

        // Fail closed on any other match* key (e.g. matchDatasources, matchCurrentVersion, etc.)
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

          const matchTypes = Array.isArray(rule.matchDepTypes)
            ? rule.matchDepTypes
            : rule.matchDepTypes
              ? [rule.matchDepTypes]
              : [];
          const explicitlyMatchesOverrides =
            matchTypes.includes("overrides") || matchTypes.includes("*");

          if (
            explicitlyMatchesOverrides &&
            isUnrestrictedOverridesRule(rule) &&
            rule.major?.enabled === false
          ) {
            effectiveOverridesMajorDisabled = true;
            hasContradictoryOverridesRule = false;
          } else if (rule.major?.enabled === true) {
            effectiveOverridesMajorDisabled = false;
            hasContradictoryOverridesRule = true;
          }
        }
      }

      if (!effectiveOverridesMajorDisabled || hasContradictoryOverridesRule) {
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

  /**
   * @param {string} line
   * @returns {string}
   */
  function stripYamlComment(line) {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\" && inDoubleQuote) {
        escaped = !escaped;
        continue;
      }
      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      } else if (ch === '"' && !inSingleQuote && !escaped) {
        inDoubleQuote = !inDoubleQuote;
      } else if (
        ch === "#" &&
        !inSingleQuote &&
        !inDoubleQuote &&
        (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")
      ) {
        return line.slice(0, i);
      }
      escaped = false;
    }
    return line;
  }

  /**
   * @param {string} str
   * @returns {string}
   */
  function cleanYamlScalar(str) {
    let s = str.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    }
    return s;
  }

  /**
   * @param {string} fmText
   * @returns {{ found: boolean, labels: string[] }}
   */
  function parseFrontMatterLabels(fmText) {
    const rawLines = fmText.split(/\r?\n/);
    let labelLineIndex = -1;
    let initialValue = null;

    for (let i = 0; i < rawLines.length; i++) {
      const stripped = stripYamlComment(rawLines[i]);
      // Top-level YAML mapping key must start at column 0 (no leading whitespace),
      // and mapping keys are strictly case-sensitive in YAML (must be lowercase 'labels').
      const match = stripped.match(/^labels\s*:\s*(.*)$/);
      if (match) {
        labelLineIndex = i;
        initialValue = match[1].trim();
        break;
      }
    }

    if (labelLineIndex === -1 || initialValue === null) {
      return { found: false, labels: [] };
    }

    /** @type {string[]} */
    const labels = [];

    // Check for mapping/dict syntax e.g. `{ foo: bar }` which is invalid for labels
    if (initialValue.startsWith("{")) {
      return { found: true, labels: [] };
    }

    // Case 1: Flow sequence (bracketed list) e.g. `[needs-triage, bug]`
    if (initialValue.startsWith("[")) {
      let bracketContent = initialValue;
      let currentIndex = labelLineIndex + 1;
      while (!bracketContent.includes("]") && currentIndex < rawLines.length) {
        const nextStripped = stripYamlComment(rawLines[currentIndex]);
        if (/^\S/.test(nextStripped) && !nextStripped.startsWith("]")) {
          // Unindented line before closing bracket means malformed flow sequence
          return { found: true, labels: [] };
        }
        bracketContent += " " + nextStripped.trim();
        currentIndex++;
      }
      const closeBracket = bracketContent.indexOf("]");
      if (closeBracket === -1) {
        return { found: true, labels: [] };
      }
      const inside = bracketContent.slice(1, closeBracket);
      const items = inside.split(",");
      for (const item of items) {
        const cleaned = cleanYamlScalar(item);
        if (cleaned.length > 0) {
          labels.push(cleaned);
        }
      }
      return { found: true, labels };
    }

    // Case 2: Inline scalar e.g. `labels: needs-triage`
    if (initialValue.length > 0) {
      let scalarValue = initialValue;
      // In YAML, any indented lines directly following a scalar key are continuation lines
      let currentIndex = labelLineIndex + 1;
      while (currentIndex < rawLines.length) {
        const rawLine = rawLines[currentIndex];
        const nextStripped = stripYamlComment(rawLine);
        if (nextStripped.trim().length === 0) {
          currentIndex++;
          continue;
        }
        // If line starts at column 0 (non-whitespace), scalar has ended
        if (/^\S/.test(nextStripped)) {
          break;
        }
        // Indented continuation line modifies the scalar value
        scalarValue += " " + nextStripped.trim();
        currentIndex++;
      }

      const items = scalarValue.split(",");
      for (const item of items) {
        const cleaned = cleanYamlScalar(item);
        if (cleaned.length > 0) {
          labels.push(cleaned);
        }
      }
      return { found: true, labels };
    }

    // Case 3: Block sequence or multiline block under `labels:`
    let currentIndex = labelLineIndex + 1;
    let currentItem = null;

    while (currentIndex < rawLines.length) {
      const rawLine = rawLines[currentIndex];
      const stripped = stripYamlComment(rawLine);
      if (stripped.trim().length === 0) {
        currentIndex++;
        continue;
      }
      // Top-level unindented line marks end of block
      if (/^\S/.test(stripped)) {
        break;
      }

      // Check if this is a sequence item `- ...`
      const itemMatch = stripped.match(/^\s*-\s*(.*)$/);
      if (itemMatch) {
        if (currentItem !== null) {
          const cleaned = cleanYamlScalar(currentItem);
          if (cleaned.length > 0) labels.push(cleaned);
        }
        currentItem = itemMatch[1].trim();
      } else if (currentItem !== null) {
        // Indented continuation line for current sequence item
        currentItem += " " + stripped.trim();
      } else {
        // Indented line that is not a sequence item and has no item started:
        // Multiline scalar or unsupported structure under `labels:`
        let multilineScalar = stripped.trim();
        currentIndex++;
        while (currentIndex < rawLines.length) {
          const nextStripped = stripYamlComment(rawLines[currentIndex]);
          if (nextStripped.trim().length === 0) {
            currentIndex++;
            continue;
          }
          if (/^\S/.test(nextStripped)) break;
          multilineScalar += " " + nextStripped.trim();
          currentIndex++;
        }
        const cleaned = cleanYamlScalar(multilineScalar);
        if (cleaned.length > 0) {
          labels.push(cleaned);
        }
        return { found: true, labels };
      }
      currentIndex++;
    }

    if (currentItem !== null) {
      const cleaned = cleanYamlScalar(currentItem);
      if (cleaned.length > 0) labels.push(cleaned);
    }

    return { found: true, labels };
  }

  for (const { rel, label } of issueTemplates) {
    const tmplContent = readRequiredFile(rel, label);
    if (tmplContent !== null) {
      const frontMatterMatch = tmplContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontMatterMatch) {
        violations.push(`${rel} must contain YAML front matter enclosed by '---'`);
        continue;
      }

      const parsed = parseFrontMatterLabels(frontMatterMatch[1]);
      if (!parsed.found || !parsed.labels.includes("needs-triage")) {
        violations.push(`${rel} must default labels to 'needs-triage'`);
      }

      if (parsed.labels.includes("ready-for-agent") || /ready-for-agent/i.test(tmplContent)) {
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
