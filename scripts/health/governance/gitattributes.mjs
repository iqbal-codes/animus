import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import picomatch from "picomatch";

/**
 * @param {string} line
 * @returns {{ pattern: string, attrTokens: string[], rawLine: string } | null}
 */
function parseGitAttrLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  let pattern = "";
  let i = 0;
  if (trimmed.startsWith('"')) {
    let escaped = false;
    i = 1;
    while (i < trimmed.length) {
      const ch = trimmed[i];
      if (escaped) {
        pattern += ch;
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
    while (i < trimmed.length) {
      if (trimmed[i] === "\\" && i + 1 < trimmed.length && /\s/.test(trimmed[i + 1])) {
        pattern += trimmed[i + 1];
        i += 2;
      } else if (/\s/.test(trimmed[i])) {
        break;
      } else {
        pattern += trimmed[i];
        i++;
      }
    }
  }

  const rest = trimmed.slice(i).trim();
  if (!rest) return null;
  const attrTokens = rest.split(/\s+/);
  return { pattern, attrTokens, rawLine: trimmed };
}

/**
 * @param {string} pattern
 * @param {string} subPath
 * @returns {boolean}
 */
function matchGitAttrPattern(pattern, subPath) {
  if (pattern === "*") return true;
  const norm = subPath.replace(/\\/g, "/").replace(/^[/]+/, "");
  try {
    const hasSlash = pattern.includes("/");
    const match = picomatch(pattern, {
      basename: !hasSlash,
      posix: true,
      dot: true,
    });
    return match(norm);
  } catch {
    return false;
  }
}

/**
 * Validates .gitattributes configuration for line-ending normalization (eol=lf).
 *
 * @param {string} repoRoot
 * @param {(relPath: string, label: string) => string | null} readRequiredFile
 * @param {string[]} violations
 */
export function validateGitAttributes(repoRoot, readRequiredFile, violations) {
  const gitattrContent = readRequiredFile(".gitattributes", "Git attributes");
  if (gitattrContent === null) return;

  const gitattrFiles = [{ relFile: ".gitattributes", dirPrefix: "", content: gitattrContent }];

  /** @param {string} dir
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
            const content = readFileSync(full, "utf-8");
            const dirPrefix = rel ? rel.replace(/\\/g, "/") : "";
            gitattrFiles.push({ relFile: relPath, dirPrefix, content });
          } catch {}
        }
      }
    } catch {}
  }
  scanGitattrFiles(repoRoot);

  /** @type {Array<{ pattern: string, dirPrefix: string, relFile: string, line: string, attrs: Map<string, string | boolean> }>} */
  const parsedRules = [];
  const conflictingRules = [];

  for (const file of gitattrFiles) {
    const lines = file.content.split(/\r?\n/);
    for (const rawLine of lines) {
      const parsed = parseGitAttrLine(rawLine);
      if (!parsed) continue;

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
        if (pattern.includes("[") && !pattern.includes("]")) {
          violations.push(`${file.relFile} contains unsupported or invalid pattern: '${pattern}'`);
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

  /** @param {string} filePath */
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
      const subPath = rule.dirPrefix === "" ? normPath : normPath.slice(rule.dirPrefix.length + 1);
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

  for (const file of gitattrFiles) {
    if (file.dirPrefix) {
      for (const cls of requiredFileClasses) {
        filesToCheck.add(`${file.dirPrefix}/${cls}`);
      }
    }
  }

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

  /** @param {string} dir
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
    } catch {}
  }
  scanTextFiles(repoRoot);

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
