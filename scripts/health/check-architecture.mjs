import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

/** @type {((pattern: string, options?: Record<string, unknown>) => (input: string) => boolean) | null} */
let picomatchFn = null;
try {
  const req = createRequire(import.meta.url);
  picomatchFn = req("picomatch");
} catch {
  // picomatch unavailable; fallback to built-in globToRegExp
}

const POSIX_CLASSES = {
  "[:alnum:]": "a-zA-Z0-9",
  "[:alpha:]": "a-zA-Z",
  "[:blank:]": " \\t",
  "[:cntrl:]": "\\x00-\\x1F\\x7F",
  "[:digit:]": "0-9",
  "[:graph:]": "\\x21-\\x7E",
  "[:lower:]": "a-z",
  "[:print:]": "\\x20-\\x7E",
  "[:punct:]": "!\"#$%&'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~",
  "[:space:]": " \\t\\r\\n\\v\\f",
  "[:upper:]": "A-Z",
  "[:xdigit:]": "0-9a-fA-F",
};

/**
 * @param {string} line
 * @returns {{ pattern: string, attrTokens: string[], rawLine: string } | null}
 */
function parseGitAttrLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  let pattern = "";
  let i = 0;

  while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
  if (i >= trimmed.length) return null;

  if (trimmed[i] === '"') {
    i++;
    let escaped = false;
    while (i < trimmed.length) {
      const ch = trimmed[i];
      if (escaped) {
        if (ch === "n") pattern += "\n";
        else if (ch === "t") pattern += "\t";
        else if (ch === "r") pattern += "\r";
        else if (ch === "\\") pattern += "\\";
        else if (ch === '"') pattern += '"';
        else pattern += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        i++;
        break;
      } else {
        pattern += ch;
      }
      i++;
    }
  } else {
    let escaped = false;
    while (i < trimmed.length) {
      const ch = trimmed[i];
      if (escaped) {
        pattern += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
        pattern += ch;
      } else if (ch === " " || ch === "\t") {
        break;
      } else {
        pattern += ch;
      }
      i++;
    }
  }

  const rest = trimmed.slice(i).trim();
  if (!rest) return null;
  const attrTokens = rest.split(/\s+/);

  return { pattern, attrTokens, rawLine: trimmed };
}

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
    /** @type {Array<{ relFile: string, dirPrefix: string, content: string }>} */
    const gitattrFiles = [{ relFile: ".gitattributes", dirPrefix: "", content: gitattrContent }];

    // Discover nested .gitattributes files across repoRoot
    /**
     * @param {string} dir
     * @param {string} [rel]
     */
    function scanGitattrFiles(dir, rel = "") {
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
            scanGitattrFiles(full, relPath);
          } else if (
            entry.isFile() &&
            entry.name === ".gitattributes" &&
            relPath !== ".gitattributes"
          ) {
            try {
              gitattrFiles.push({
                relFile: relPath,
                dirPrefix: rel,
                content: readFileSync(full, "utf8"),
              });
            } catch {
              // Ignore unreadable nested file
            }
          }
        }
      } catch {
        // Fall back gracefully
      }
    }
    scanGitattrFiles(repoRoot);

    gitattrFiles.sort((a, b) => {
      const depthA = a.dirPrefix ? a.dirPrefix.split("/").length : 0;
      const depthB = b.dirPrefix ? b.dirPrefix.split("/").length : 0;
      return depthA - depthB;
    });

    /** @type {Array<{ pattern: string, dirPrefix: string, relFile: string, line: string, attrs: Map<string, string | boolean> }>} */
    const parsedRules = [];
    /** @type {Array<{ relFile: string, line: string }>} */
    const conflictingRules = [];

    for (const file of gitattrFiles) {
      const lines = file.content.split(/\r?\n/);
      for (const rawLine of lines) {
        const parsed = parseGitAttrLine(rawLine);
        if (!parsed) {
          continue;
        }

        const { pattern, attrTokens, rawLine: trimmed } = parsed;
        const attrs = new Map();

        for (const token of attrTokens) {
          if (token === "eol=crlf" || token === "eol=native" || token === "crlf") {
            conflictingRules.push({ relFile: file.relFile, line: trimmed });
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
            violations.push(
              `${file.relFile} contains unsupported or invalid pattern: '${pattern}'`,
            );
          }
        }

        parsedRules.push({
          pattern,
          dirPrefix: file.dirPrefix,
          relFile: file.relFile,
          line: trimmed,
          attrs,
        });
      }
    }

    const rootRules = parsedRules.filter((r) => r.dirPrefix === "");
    const hasActiveEolLf = rootRules.some((r) => r.attrs.get("eol") === "lf");
    if (!hasActiveEolLf) {
      violations.push(".gitattributes must enforce LF line endings (eol=lf)");
    }

    if (conflictingRules.length > 0) {
      for (const { relFile, line } of conflictingRules) {
        if (relFile === ".gitattributes") {
          violations.push(`.gitattributes contains conflicting non-LF line ending rule: '${line}'`);
        } else {
          violations.push(`${relFile} contains conflicting non-LF line ending rule: '${line}'`);
        }
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
          let j = i + 1;
          let negated = false;
          if (p[j] === "!" || p[j] === "^") {
            negated = true;
            j++;
          }
          if (p[j] === "]") {
            j++;
          }
          let foundEnd = false;
          while (j < p.length) {
            if (p[j] === "[" && p[j + 1] === ":") {
              const classEnd = p.indexOf(":]", j + 2);
              if (classEnd !== -1) {
                j = classEnd + 2;
                continue;
              }
            }
            if (p[j] === "]") {
              foundEnd = true;
              break;
            }
            j++;
          }

          if (!foundEnd) {
            throw new Error(`Unclosed bracket expression in pattern: '${pattern}'`);
          }

          let inside = p.slice(i + 1, j);
          for (const [posixClass, replacement] of Object.entries(POSIX_CLASSES)) {
            inside = inside.replaceAll(posixClass, replacement);
          }

          if (negated) {
            inside =
              "^/" + (inside.startsWith("!") || inside.startsWith("^") ? inside.slice(1) : inside);
          }
          regexStr += "[" + inside + "]";
          i = j + 1;
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
     * @param {string} subPath
     */
    function matchGitAttrPattern(pattern, subPath) {
      if (pattern === "*") return true;
      const normalizedPath = subPath.replace(/\\/g, "/").replace(/^[/]+/, "");
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
      const normPath = filePath.replace(/\\/g, "/").replace(/^[/]+/, "");
      let effText = undefined;
      let effEol = undefined;
      for (const rule of parsedRules) {
        if (rule.dirPrefix !== "") {
          if (!normPath.startsWith(rule.dirPrefix + "/")) {
            continue;
          }
        }
        const subPath =
          rule.dirPrefix === "" ? normPath : normPath.slice(rule.dirPrefix.length + 1);
        if (matchGitAttrPattern(rule.pattern, subPath)) {
          if (rule.attrs.has("text")) {
            effText = rule.attrs.get("text");
          }
          if (rule.attrs.has("eol")) {
            effEol = rule.attrs.get("eol");
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

    // Add required file classes scoped to each nested .gitattributes directory
    for (const file of gitattrFiles) {
      if (file.dirPrefix) {
        for (const cls of requiredFileClasses) {
          filesToCheck.add(`${file.dirPrefix}/${cls}`);
        }
      }
    }

    // Include explicit non-binary file paths targeted in .gitattributes rules
    for (const { pattern, dirPrefix } of parsedRules) {
      if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
        const clean = pattern.replace(/\\/g, "/").replace(/^[/]+/, "");
        const full = dirPrefix ? `${dirPrefix}/${clean}` : clean;
        const ext = extname(full).toLowerCase();
        if (!BINARY_EXTENSIONS.has(ext)) {
          filesToCheck.add(full);
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

    // Authoritative check with git check-attr if .git directory is present
    let gitAttrMap = null;
    if (existsSync(join(repoRoot, ".git"))) {
      try {
        const checkList = Array.from(filesToCheck);
        gitAttrMap = new Map();
        for (let idx = 0; idx < checkList.length; idx += 100) {
          const chunk = checkList.slice(idx, idx + 100);
          const out = execFileSync("git", ["check-attr", "text", "eol", "--", ...chunk], {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
          for (const line of out.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const match = trimmed.match(/^([^:]+):\s*([^:]+):\s*(.*)$/);
            if (match) {
              const [, f, attr, val] = match;
              if (!gitAttrMap.has(f)) gitAttrMap.set(f, {});
              gitAttrMap.get(f)[attr] = val;
            }
          }
        }
      } catch {
        gitAttrMap = null;
      }
    }

    const failedFiles = Array.from(filesToCheck).filter((f) => {
      const { text, eol } = getEffectiveAttrs(f);
      // In Git, LF line ending normalization requires:
      // 1) text attribute enabled ('true' or 'auto')
      // 2) eol attribute explicitly set to 'lf'
      // If text is unset (false), binary, or unspecified, Git does not perform eol conversion.
      const isTextEnabled = text === true || text === "auto";
      const isEolLf = eol === "lf";

      let gitOk = true;
      if (gitAttrMap && gitAttrMap.has(f)) {
        const g = gitAttrMap.get(f);
        const gitTextOk = g.text === "set" || g.text === "auto";
        const gitEolOk = g.eol === "lf";
        gitOk = gitTextOk && gitEolOk;
      }

      return !isTextEnabled || !isEolLf || !gitOk;
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

      /**
       * Expand braces in glob pattern (e.g. {vite,vitest} -> ['vite', 'vitest'])
       * @param {string} pattern
       * @returns {string[]}
       */
      function expandBraces(pattern) {
        let start = -1;
        let depth = 0;
        for (let i = 0; i < pattern.length; i++) {
          if (pattern[i] === "\\") {
            i++;
            continue;
          }
          if (pattern[i] === "{") {
            if (depth === 0) start = i;
            depth++;
          } else if (pattern[i] === "}") {
            depth--;
            if (depth === 0 && start !== -1) {
              const body = pattern.slice(start + 1, i);
              let commaFound = false;
              let subDepth = 0;
              const parts = [];
              let current = "";
              for (let j = 0; j < body.length; j++) {
                if (body[j] === "\\") {
                  current += body[j] + (body[j + 1] || "");
                  j++;
                  continue;
                }
                if (body[j] === "{") subDepth++;
                else if (body[j] === "}") subDepth--;
                else if (body[j] === "," && subDepth === 0) {
                  commaFound = true;
                  parts.push(current);
                  current = "";
                  continue;
                }
                current += body[j];
              }
              parts.push(current);
              if (commaFound) {
                const prefix = pattern.slice(0, start);
                const suffix = pattern.slice(i + 1);
                const results = [];
                for (const part of parts) {
                  for (const expanded of expandBraces(prefix + part + suffix)) {
                    results.push(expanded);
                  }
                }
                return results;
              }
              start = -1;
            }
          }
        }
        return [pattern];
      }

      /**
       * Compile a single glob (with braces already expanded) into regex pattern body
       * @param {string} glob
       * @returns {string}
       */
      function parseGlobTokens(glob) {
        let i = 0;

        function parseSub() {
          let sub = "";
          while (i < glob.length) {
            if (glob.slice(i, i + 3) === "**/") {
              sub += "(?:.*\\/)?";
              i += 3;
              continue;
            }
            if (glob.slice(i, i + 2) === "**") {
              sub += ".*";
              i += 2;
              continue;
            }

            // Extglobs: @(, ?(, *(, +(, !(
            if (i + 1 < glob.length && "@?*+!".includes(glob[i]) && glob[i + 1] === "(") {
              const type = glob[i];
              i += 2;
              const alts = [];
              let currentAlt = "";
              let closed = false;
              while (i < glob.length) {
                if (glob[i] === ")") {
                  closed = true;
                  break;
                }
                if (glob[i] === "|") {
                  alts.push(currentAlt);
                  currentAlt = "";
                  i++;
                  continue;
                }
                if (i + 1 < glob.length && "@?*+!".includes(glob[i]) && glob[i + 1] === "(") {
                  currentAlt += parseSub();
                  continue;
                }
                if (glob[i] === "*") {
                  currentAlt += "[^/]*";
                  i++;
                } else if (glob[i] === "?") {
                  currentAlt += "[^/]";
                  i++;
                } else if (glob[i] === "\\") {
                  i++;
                  if (i < glob.length) {
                    currentAlt += "\\" + glob[i];
                    i++;
                  }
                } else if ("()+{}^$|.[].".includes(glob[i])) {
                  currentAlt += "\\" + glob[i];
                  i++;
                } else {
                  currentAlt += glob[i];
                  i++;
                }
              }
              alts.push(currentAlt);
              if (closed) {
                i++; // skip ')'
              } else {
                // Malformed / unclosed extglob fails closed
                return "(?!)";
              }

              const altRegex = alts.join("|");
              if (type === "@") {
                sub += "(?:" + altRegex + ")";
              } else if (type === "?") {
                sub += "(?:" + altRegex + ")?";
              } else if (type === "*") {
                sub += "(?:" + altRegex + ")*";
              } else if (type === "+") {
                sub += "(?:" + altRegex + ")+";
              } else if (type === "!") {
                sub += "(?:(?!(?:" + altRegex + ")$)[^/]*)";
              }
              continue;
            }

            const ch = glob[i];
            if (ch === "*") {
              sub += ".*";
              i++;
            } else if (ch === "?") {
              sub += ".";
              i++;
            } else if (ch === "[") {
              let j = i + 1;
              if (j < glob.length && (glob[j] === "!" || glob[j] === "^")) j++;
              if (j < glob.length && glob[j] === "]") j++;
              while (j < glob.length && glob[j] !== "]") j++;
              if (j >= glob.length) {
                sub += "\\[";
                i++;
              } else {
                const classBody = glob.slice(i + 1, j);
                if (classBody.startsWith("!")) {
                  sub += "[^" + classBody.slice(1) + "]";
                } else {
                  sub += "[" + classBody + "]";
                }
                i = j + 1;
              }
            } else if (ch === "\\") {
              i++;
              if (i < glob.length) {
                sub += "\\" + glob[i];
                i++;
              }
            } else if ("()+{}^$|.".includes(ch)) {
              sub += "\\" + ch;
              i++;
            } else {
              sub += ch;
              i++;
            }
          }
          return sub;
        }

        return "^" + parseSub() + "$";
      }

      /**
       * Convert glob pattern to regular expression (compatible with minimatch / picomatch)
       * Supports braces ({a,b}) and extglobs (@(a|b), ?(a|b), *(a|b), +(a|b), !(a|b)).
       * @param {string} glob
       * @returns {RegExp}
       */
      function globToRegExp(glob) {
        const expanded = expandBraces(glob);
        if (expanded.length === 1) {
          return new RegExp(parseGlobTokens(expanded[0]), "i");
        }
        const regexes = expanded.map((p) => parseGlobTokens(p).slice(1, -1));
        return new RegExp("^(?:" + regexes.join("|") + ")$", "i");
      }

      /**
       * Match single string against Renovate pattern (regex /.../ or glob)
       * @param {string} input
       * @param {string} pattern
       * @returns {boolean}
       */
      function matchRenovatePattern(input, pattern) {
        if (pattern === "*" || pattern === "**" || pattern === "**/*") return true;

        const isNeg = pattern.startsWith("!");
        const pat = isNeg ? pattern.slice(1) : pattern;

        if (pat.startsWith("/") && /\/i?$/.test(pat)) {
          const ignoreCase = pat.endsWith("i");
          const regexBody = pat.slice(1, ignoreCase ? -2 : -1);
          try {
            const reg = new RegExp(regexBody, ignoreCase ? "i" : "");
            const res = reg.test(input);
            return isNeg ? !res : res;
          } catch {
            return false;
          }
        }

        if (picomatchFn) {
          try {
            const isMatch = picomatchFn(pat, { dot: true, nocase: true });
            const res = isMatch(input);
            return isNeg ? !res : res;
          } catch {}
        }

        try {
          const res = globToRegExp(pat).test(input);
          return isNeg ? !res : res;
        } catch {
          return false;
        }
      }

      /**
       * Match single string against Renovate pattern list
       * @param {string} input
       * @param {any} patterns
       * @returns {boolean}
       */
      function matchRenovatePatternList(input, patterns) {
        if (patterns === undefined || patterns === null) return true;
        const list = Array.isArray(patterns) ? patterns : [patterns];
        if (list.length === 0) return false;

        const positive = list.filter((p) => !String(p).startsWith("!"));
        const negative = list.filter((p) => String(p).startsWith("!"));

        if (positive.length > 0) {
          if (!positive.some((p) => matchRenovatePattern(input, String(p)))) {
            return false;
          }
        }

        if (negative.length > 0) {
          if (!negative.every((p) => matchRenovatePattern(input, String(p)))) {
            return false;
          }
        }

        return true;
      }

      /**
       * @param {any} rule
       * @returns {boolean}
       */
      function ruleMatchesOverridesDepType(rule) {
        if (rule.matchDepTypes === undefined || rule.matchDepTypes === null) {
          return true;
        }
        return matchRenovatePatternList("overrides", rule.matchDepTypes);
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

        // Check package prefixes
        if (rule.matchPackagePrefixes !== undefined && rule.matchPackagePrefixes !== null) {
          const items = Array.isArray(rule.matchPackagePrefixes)
            ? rule.matchPackagePrefixes
            : [rule.matchPackagePrefixes];
          if (items.length === 0) return false;
          if (!testPackages.every((pkg) => matchRenovatePatternList(pkg, items))) {
            return false;
          }
        }

        // Check file / path matchers
        for (const key of ["matchFileNames", "matchPaths"]) {
          if (rule[key] !== undefined && rule[key] !== null) {
            const items = Array.isArray(rule[key]) ? rule[key] : [rule[key]];
            if (items.length === 0) return false;
            if (!matchRenovatePatternList("package.json", items)) {
              return false;
            }
          }
        }

        // Check manager matchers
        if (rule.matchManagers !== undefined && rule.matchManagers !== null) {
          const items = Array.isArray(rule.matchManagers)
            ? rule.matchManagers
            : [rule.matchManagers];
          if (items.length === 0) return false;
          if (!matchRenovatePatternList("npm", items)) return false;
        }

        // Check update type matchers
        if (rule.matchUpdateTypes !== undefined && rule.matchUpdateTypes !== null) {
          const items = Array.isArray(rule.matchUpdateTypes)
            ? rule.matchUpdateTypes
            : [rule.matchUpdateTypes];
          if (items.length === 0) return false;
          if (!matchRenovatePatternList("major", items)) return false;
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
   * @returns {{ found: boolean, labels: string[], duplicateKeys: string[], invalid: boolean }}
   */
  function parseFrontMatterLabels(fmText) {
    const rawLines = fmText.split(/\r?\n/);
    const seenKeys = new Map();
    /** @type {string[]} */
    const duplicateKeys = [];
    /** @type {{ key: string, lineIndex: number, initialValue: string, lines: string[] }[]} */
    const sections = [];

    let currentSection = null;
    let insideFlowSeq = false;

    for (let i = 0; i < rawLines.length; i++) {
      const rawLine = rawLines[i];
      const stripped = stripYamlComment(rawLine);
      if (stripped.trim().length === 0) {
        if (currentSection) {
          currentSection.lines.push(rawLine);
        }
        continue;
      }

      if (!insideFlowSeq && /^\S/.test(stripped)) {
        const match = stripped.match(/^([a-zA-Z0-9_-]+)\s*:(.*)$/);
        if (!match) {
          return { found: false, labels: [], duplicateKeys, invalid: true };
        }
        const key = match[1];
        const initialValue = match[2].trim();
        const count = seenKeys.get(key) || 0;
        if (count > 0 && !duplicateKeys.includes(key)) {
          duplicateKeys.push(key);
        }
        seenKeys.set(key, count + 1);

        currentSection = {
          key,
          lineIndex: i,
          initialValue,
          lines: [rawLine],
        };
        sections.push(currentSection);

        if (initialValue.startsWith("[")) {
          let inSingle = false;
          let inDouble = false;
          let escaped = false;
          let closed = false;
          for (let j = 0; j < initialValue.length; j++) {
            const ch = initialValue[j];
            if (escaped) {
              escaped = false;
              continue;
            }
            if (ch === "\\" && inDouble) {
              escaped = true;
              continue;
            }
            if (ch === "'" && !inDouble) inSingle = !inSingle;
            else if (ch === '"' && !inSingle) inDouble = !inDouble;
            else if (ch === "]" && !inSingle && !inDouble) {
              closed = true;
              break;
            }
          }
          insideFlowSeq = !closed;
        }
      } else {
        if (!currentSection) {
          return { found: false, labels: [], duplicateKeys, invalid: true };
        }
        currentSection.lines.push(rawLine);

        if (insideFlowSeq) {
          let inSingle = false;
          let inDouble = false;
          let escaped = false;
          for (let j = 0; j < stripped.length; j++) {
            const ch = stripped[j];
            if (escaped) {
              escaped = false;
              continue;
            }
            if (ch === "\\" && inDouble) {
              escaped = true;
              continue;
            }
            if (ch === "'" && !inDouble) inSingle = !inSingle;
            else if (ch === '"' && !inSingle) inDouble = !inDouble;
            else if (ch === "]" && !inSingle && !inDouble) {
              insideFlowSeq = false;
              break;
            }
          }
        }
      }
    }

    const labelSections = sections.filter((s) => s.key === "labels");
    if (labelSections.length === 0) {
      return { found: false, labels: [], duplicateKeys, invalid: false };
    }

    // Last key wins in YAML mapping; duplicateKeys records if duplicates exist
    const targetSection = labelSections[labelSections.length - 1];
    const { initialValue, lines: sectionLines } = targetSection;

    /** @type {string[]} */
    const labels = [];

    // Check for mapping/dict syntax e.g. `{ foo: bar }` which is invalid for labels
    if (initialValue.startsWith("{")) {
      return { found: true, labels: [], duplicateKeys, invalid: false };
    }

    // Case 1: Flow sequence (bracketed list) e.g. `[needs-triage, bug]`
    if (initialValue.startsWith("[")) {
      let content = "";
      let insideSingle = false;
      let insideDouble = false;
      let escaped = false;
      let closed = false;
      let trailing = "";

      for (let lineIdx = 0; lineIdx < sectionLines.length; lineIdx++) {
        const rawLine = sectionLines[lineIdx];
        const stripped = stripYamlComment(rawLine);
        const lineText = lineIdx === 0 ? initialValue : stripped;

        if (lineIdx > 0 && /^\S/.test(stripped) && !stripped.trim().startsWith("]") && !closed) {
          // Unindented line before closing bracket means malformed flow sequence
          return { found: true, labels: [], duplicateKeys, invalid: false };
        }

        for (let j = 0; j < lineText.length; j++) {
          const ch = lineText[j];
          if (closed) {
            if (ch !== " " && ch !== "\t") {
              trailing += ch;
            }
            continue;
          }
          if (escaped) {
            content += ch;
            escaped = false;
            continue;
          }
          if (ch === "\\" && insideDouble) {
            escaped = true;
            content += ch;
            continue;
          }
          if (ch === "'" && !insideDouble) {
            insideSingle = !insideSingle;
            content += ch;
            continue;
          }
          if (ch === '"' && !insideSingle) {
            insideDouble = !insideDouble;
            content += ch;
            continue;
          }
          if (ch === "]" && !insideSingle && !insideDouble) {
            closed = true;
            continue;
          }
          content += ch;
        }

        if (closed) {
          if (trailing.length > 0) {
            return { found: true, labels: [], duplicateKeys, invalid: false };
          }
          break;
        }
        content += "\n";
      }

      if (!closed || insideSingle || insideDouble) {
        return { found: true, labels: [], duplicateKeys, invalid: false };
      }

      const openIdx = content.indexOf("[");
      if (openIdx === -1) return { found: true, labels: [], duplicateKeys, invalid: false };
      const inside = content.slice(openIdx + 1).trim();
      if (inside.length === 0) {
        return { found: true, labels: [], duplicateKeys, invalid: false };
      }

      let curItem = "";
      insideSingle = false;
      insideDouble = false;
      escaped = false;

      for (let j = 0; j < inside.length; j++) {
        const ch = inside[j];
        if (escaped) {
          curItem += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\" && insideDouble) {
          escaped = true;
          curItem += ch;
          continue;
        }
        if (ch === "'" && !insideDouble) {
          insideSingle = !insideSingle;
          curItem += ch;
          continue;
        }
        if (ch === '"' && !insideSingle) {
          insideDouble = !insideDouble;
          curItem += ch;
          continue;
        }
        if (ch === "," && !insideSingle && !insideDouble) {
          const cleaned = cleanYamlScalar(curItem);
          if (cleaned.length === 0) {
            return { found: true, labels: [], duplicateKeys, invalid: false };
          }
          labels.push(cleaned);
          curItem = "";
          continue;
        }
        curItem += ch;
      }

      if (insideSingle || insideDouble) {
        return { found: true, labels: [], duplicateKeys, invalid: false };
      }

      const lastCleaned = cleanYamlScalar(curItem);
      if (lastCleaned.length === 0 && labels.length > 0 && curItem.trim().length > 0) {
        return { found: true, labels: [], duplicateKeys, invalid: false };
      }
      if (lastCleaned.length > 0) {
        labels.push(lastCleaned);
      }

      return { found: true, labels, duplicateKeys, invalid: false };
    }

    // Case 2: Inline scalar e.g. `labels: needs-triage`
    if (initialValue.length > 0) {
      let scalarValue = initialValue;
      for (let lineIdx = 1; lineIdx < sectionLines.length; lineIdx++) {
        const rawLine = sectionLines[lineIdx];
        const nextStripped = stripYamlComment(rawLine);
        if (nextStripped.trim().length === 0) {
          continue;
        }
        scalarValue += " " + nextStripped.trim();
      }

      const items = scalarValue.split(",");
      for (const item of items) {
        const cleaned = cleanYamlScalar(item);
        if (cleaned.length > 0) {
          labels.push(cleaned);
        }
      }
      return { found: true, labels, duplicateKeys, invalid: false };
    }

    // Case 3: Block sequence or multiline block under `labels:`
    let currentItem = null;

    for (let lineIdx = 1; lineIdx < sectionLines.length; lineIdx++) {
      const rawLine = sectionLines[lineIdx];
      const stripped = stripYamlComment(rawLine);
      if (stripped.trim().length === 0) {
        continue;
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
        // Multiline scalar under `labels:`
        let multilineScalar = stripped.trim();
        lineIdx++;
        while (lineIdx < sectionLines.length) {
          const nextStripped = stripYamlComment(sectionLines[lineIdx]);
          if (nextStripped.trim().length > 0) {
            multilineScalar += " " + nextStripped.trim();
          }
          lineIdx++;
        }
        const cleaned = cleanYamlScalar(multilineScalar);
        if (cleaned.length > 0) {
          labels.push(cleaned);
        }
        return { found: true, labels, duplicateKeys, invalid: false };
      }
    }

    if (currentItem !== null) {
      const cleaned = cleanYamlScalar(currentItem);
      if (cleaned.length > 0) labels.push(cleaned);
    }

    return { found: true, labels, duplicateKeys, invalid: false };
  }

  for (const { rel, label } of issueTemplates) {
    const tmplContent = readRequiredFile(rel, label);
    if (tmplContent !== null) {
      const frontMatterMatch = tmplContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontMatterMatch) {
        violations.push(`${rel} must contain YAML front matter enclosed by '---'`);
        continue;
      }

      if (existsSync("/usr/bin/ruby")) {
        try {
          const rubyOut = execFileSync(
            "/usr/bin/ruby",
            ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load(STDIN.read))"],
            {
              input: frontMatterMatch[1],
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "ignore"],
            },
          );
          const rubyData = JSON.parse(rubyOut);
          if (rubyData && typeof rubyData === "object") {
            const rubyLabels = rubyData.labels;
            const rubyLabelList = Array.isArray(rubyLabels)
              ? rubyLabels.map(String)
              : typeof rubyLabels === "string"
                ? rubyLabels.split(",").map((s) => s.trim())
                : [];
            if (!rubyLabelList.includes("needs-triage")) {
              violations.push(`${rel} must default labels to 'needs-triage'`);
            }
          }
        } catch {
          violations.push(`${rel} contains invalid YAML front matter`);
        }
      }

      const parsed = parseFrontMatterLabels(frontMatterMatch[1]);
      if (parsed.duplicateKeys && parsed.duplicateKeys.length > 0) {
        for (const k of parsed.duplicateKeys) {
          violations.push(`${rel} front matter contains duplicate key: '${k}'`);
        }
      }
      if (parsed.invalid) {
        violations.push(`${rel} contains invalid YAML front matter`);
      }
      if (!parsed.found || !parsed.labels.includes("needs-triage")) {
        const msg = `${rel} must default labels to 'needs-triage'`;
        if (!violations.includes(msg)) {
          violations.push(msg);
        }
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
