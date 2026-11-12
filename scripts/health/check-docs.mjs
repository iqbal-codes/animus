import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const STATUSES = ["Active", "Draft", "Historical", "Superseded"];
const STATUS_RE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?Status(?:\*\*)?\s*:\s*(?:\*\*)?\s*(Active|Draft|Historical|Superseded)\b/im;
const SUPERSEDED_BY_RE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?Superseded by(?:\*\*)?\s*:\s*(?:\*\*)?\s*(\S.+)$/im;
const PATH_TOKEN_RE = /`([^`\n]+)`/g;
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const ROUTE_RE = /["'`](\/api\/[^"'`\s]+)["'`]/g;
const DOC_ROUTE_RE = /\/api\/[\w./:{}*-]+/g;

const ROOT_DOCS = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "CODING_STANDARDS.md",
  "CONTRIBUTING.md",
  "PRD.md",
  "README.md",
  "SECURITY.md",
  "engineering.md",
]);

// Paths that planning skills may legitimately reference before a repository has
// created them. They are optional project inputs, not broken documentation.
const OPTIONAL_PATHS = new Set([
  "GLOSSARY.md",
  "GLOSSARY-MAP.md",
  "docs/architecture.md",
  "docs/adr",
  "docs/adr/",
  ".animus/NO_HARNESS_MEMORY",
  ".animus/logs/",
  ".animus/backup/",
  ".animus/state/",
  ".animus/consumer.json",
  ".animus/schedule.json",
  ".animus/STOP",
  ".animus/PAUSE",
  ".animus/issues/",
  ".animus/specs/",
  ".animus/issues/001-export-csv.md",
  ".factory/NO_HARNESS_MEMORY",
  ".factory/logs/",
  ".factory/backup/",
  ".factory/state/",
  ".factory/consumer.json",
  ".factory/schedule.json",
  ".factory/STOP",
  ".factory/PAUSE",
  "harness/.results/",
  "apps/web/dist",
  "apps/web/dist/",
]);

/**
 * @param {string} directory
 * @param {(file: string) => boolean} predicate
 * @param {string[]} [found]
 * @returns {string[]}
 */
function walk(directory, predicate, found = []) {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, predicate, found);
    } else if (predicate(absolute)) {
      found.push(absolute);
    }
  }
  return found;
}

/**
 * @param {string} root
 * @param {string} absolute
 * @returns {string}
 */
function toRepoPath(root, absolute) {
  return relative(root, absolute).split(sep).join("/");
}

/**
 * @param {string} absolute
 * @returns {number}
 */
function lineCount(absolute) {
  return readFileSync(absolute, "utf8").split("\n").length;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripAnchor(value) {
  const hash = value.indexOf("#");
  return hash === -1 ? value : value.slice(0, hash);
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function isRelativeLink(target) {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target);
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isFileToken(token) {
  const cleaned = token.trim().replace(/^\.\//, "");
  if (!cleaned || cleaned.includes("://")) return false;
  if (/[<>{}\s*]/.test(cleaned)) return false;
  if (cleaned.startsWith("#")) return false;
  const pathPart = cleaned.split(":")[0];
  if (OPTIONAL_PATHS.has(pathPart)) return true;
  if (pathPart.startsWith("src/") || pathPart.includes("/src/")) return false;
  if (ROOT_DOCS.has(pathPart)) return true;
  if (
    !/^(?:apps|packages|scripts|tests|docs|factory|harness|\.agents|\.animus|\.factory)\//.test(
      pathPart,
    )
  ) {
    return false;
  }
  return /\.[A-Za-z0-9]+$/.test(pathPart) || pathPart.includes("/");
}

/**
 * @param {string} root
 * @returns {Set<string>}
 */
function collectRouteFamilies(root) {
  /** @type {Set<string>} */
  const families = new Set();
  /** @param {string} route */
  const addRoute = (route) => {
    const cleaned = route.split("?")[0].replace(/\/+$/, "");
    const segments = cleaned.split("/").filter(Boolean);
    if (segments.length < 2) return;
    const third = segments[2];
    const family =
      third && !third.startsWith(":") && !third.startsWith("{")
        ? segments.slice(0, 3)
        : segments.slice(0, 2);
    families.add(`/${family.join("/")}`);
  };

  const sourceRoot = join(root, "apps", "backend", "src");
  for (const absolute of walk(sourceRoot, (file) => /\.(?:ts|tsx|mjs)$/.test(file))) {
    const text = readFileSync(absolute, "utf8");
    for (const match of text.matchAll(ROUTE_RE)) addRoute(match[1]);
    for (const match of text.matchAll(/(?:scopedAction|parts\[1\]) === "([\w-]+)"/g)) {
      addRoute(`/api/v1/projects/:id/${match[1]}`);
    }
  }
  return families;
}

/**
 * @param {string} docPath
 * @param {string} text
 * @param {string} root
 * @param {string[]} violations
 */
function checkFileReferences(docPath, text, root, violations) {
  for (const match of text.matchAll(PATH_TOKEN_RE)) {
    const token = match[1].trim();
    if (!isFileToken(token)) continue;
    const [pathPart, anchorPart] = token.split(":");
    if (OPTIONAL_PATHS.has(pathPart)) continue;
    const absolute = resolve(root, pathPart.replace(/^\.\//, ""));
    if (!existsSync(absolute)) {
      violations.push(`${docPath}: references missing path ${pathPart}`);
      continue;
    }
    if (!anchorPart || !statSync(absolute).isFile()) continue;
    const anchorMatch = /^(\d+)(?:-(\d+))?$/.exec(anchorPart);
    if (!anchorMatch) continue;
    const start = Number(anchorMatch[1]);
    const end = anchorMatch[2] ? Number(anchorMatch[2]) : start;
    const lines = lineCount(absolute);
    if (start > lines || end > lines || start > end) {
      violations.push(`${docPath}: line anchor ${pathPart}:${anchorPart} exceeds ${lines} line(s)`);
    }
  }
}

/**
 * @param {string} docPath
 * @param {string} text
 * @param {string} root
 * @param {string[]} violations
 */
function checkRelativeLinks(docPath, text, root, violations) {
  for (const match of text.matchAll(LINK_RE)) {
    const rawTarget = match[1].replace(/^<|>$/g, "");
    if (!isRelativeLink(rawTarget)) continue;
    const target = decodeURIComponent(stripAnchor(rawTarget));
    if (!target || target.includes("*")) continue;
    const base = target.startsWith("/") ? root : dirname(join(root, docPath));
    const absolute = target.startsWith("/") ? join(root, target.slice(1)) : resolve(base, target);
    if (!existsSync(absolute)) {
      const shown = toRepoPath(root, absolute);
      violations.push(`${docPath}: broken link ${target} -> ${shown}`);
    }
  }
}

/**
 * @param {string} docPath
 * @param {string} text
 * @param {Set<string>} families
 * @param {string[]} violations
 */
function checkRouteFamilies(docPath, text, families, violations) {
  for (const match of text.matchAll(DOC_ROUTE_RE)) {
    const documented = match[0].replace(/[.,;:]+$/, "");
    if (/[{}$<>*]/.test(documented)) continue;
    const segments = documented.split("/").filter(Boolean);
    if (segments.length < 2) continue;
    const third = segments[2];
    const family =
      third && !third.startsWith(":") && !third.startsWith("{")
        ? segments.slice(0, 3)
        : segments.slice(0, 2);
    const key = `/${family.join("/")}`;
    if (!families.has(key)) {
      violations.push(`${docPath}: unknown API route family ${key}`);
    }
  }
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function parseStatus(text) {
  const match = STATUS_RE.exec(text);
  if (!match) return null;
  return STATUSES.find((status) => status.toLowerCase() === match[1].toLowerCase()) ?? null;
}

/**
 * @param {string} root
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkDocumentLifecycle(root) {
  /** @type {string[]} */
  const violations = [];
  const docsRoot = join(root, "docs");
  const governedDocs = walk(docsRoot, (file) => file.endsWith(".md")).sort((a, b) =>
    a.localeCompare(b),
  );
  const contentDocs = [
    ...governedDocs,
    ...walk(join(root, "factory"), (file) => file.endsWith(".md")),
    ...walk(join(root, "harness"), (file) => file.endsWith(".md")),
    ...ROOT_DOCS.values(),
  ]
    .map((absolute) => (absolute.startsWith("/") ? absolute : join(root, absolute)))
    .filter((absolute) => existsSync(absolute))
    .sort((a, b) => a.localeCompare(b));

  const indexAbsolute = join(docsRoot, "README.md");
  const indexText = existsSync(indexAbsolute) ? readFileSync(indexAbsolute, "utf8") : "";
  if (!existsSync(indexAbsolute)) {
    violations.push("docs/README.md: missing documentation index");
  }

  /** @type {Set<string>} */
  const indexEntries = new Set();
  for (const match of indexText.matchAll(/\]\(([^)\s]+)\)/g)) {
    const cleaned = decodeURIComponent(stripAnchor(match[1])).replace(/^\.\//, "");
    if (!cleaned) continue;
    indexEntries.add(
      cleaned.startsWith("/")
        ? cleaned.replace(/^\/+/, "")
        : toRepoPath(root, resolve(docsRoot, cleaned)),
    );
  }

  const routeFamilies = collectRouteFamilies(root);

  for (const absolute of contentDocs) {
    const docPath = toRepoPath(root, absolute);
    const text = readFileSync(absolute, "utf8");
    const isGoverned = docPath.startsWith("docs/");

    let status = "Active";
    if (isGoverned && docPath !== "docs/README.md") {
      const parsed = parseStatus(text);
      if (!parsed) {
        violations.push(`${docPath}: missing Status header`);
        continue;
      }
      status = parsed;
    }

    if (isGoverned && docPath !== "docs/README.md") {
      if (!indexEntries.has(docPath)) {
        violations.push(`docs/README.md: index is missing ${docPath}`);
      }
      if (status === "Superseded" && !SUPERSEDED_BY_RE.test(text)) {
        violations.push(`${docPath}: Superseded docs require a Superseded by reference`);
      }
    }

    if (status === "Historical" || status === "Superseded") continue;

    checkFileReferences(docPath, text, root, violations);
    checkRelativeLinks(docPath, text, root, violations);
    if (status === "Active") checkRouteFamilies(docPath, text, routeFamilies, violations);
  }

  const unique = [...new Set(violations)].sort();
  return { ok: unique.length === 0, violations: unique };
}

const isMain =
  process.argv[1] && process.argv[1].endsWith("check-docs.mjs")
    ? resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
    : false;

if (isMain) {
  const result = checkDocumentLifecycle(process.cwd());
  if (!result.ok) {
    console.error("Documentation lifecycle check failed:");
    for (const violation of result.violations) console.error("  -", violation);
    process.exit(1);
  }
  console.log("Documentation lifecycle check passed cleanly.");
}
