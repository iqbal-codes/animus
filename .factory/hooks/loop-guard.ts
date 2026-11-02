/**
 * Pi Extension Hook (-e .factory/hooks/loop-guard.ts)
 * Acts inside the tool execution loop (Harness² c8 component) across any stack
 * (Backend, Frontend, Full-Stack, Mobile, Database, CLI) to enforce:
 * 1. Protected path invariants
 * 2. Codebase convention rules (.factory/codebase-rules.json) — warn by default, block for strict invariants
 * 3. Shared pattern/module registry hints (.factory/codebase-rules.json)
 * 4. Active repository lessons (.factory/lessons.jsonl) matching the target file
 * 5. Verified CLI guidance hints on bash tool failures (.factory/tool-guidance.json)
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CodebaseRule {
  id: string;
  description: string;
  file_glob: string;
  forbid_regex?: string;
  require_regex?: string;
  replacement_hint: string;
  mode?: "block" | "warn";
}

export interface PatternRegistryEntry {
  guidance: string;
  file_glob?: string;
}

export interface CodebaseRulesConfig {
  schema_version?: number;
  description?: string;
  rules?: CodebaseRule[];
  pattern_registry?: Record<string, string | PatternRegistryEntry>;
  /** Alias for backwards compatibility */
  component_registry?: Record<string, string | PatternRegistryEntry>;
}

const DEFAULT_PROTECTED_PATTERNS = [
  /^\.factory\/holdout(\/|$)/,
  /^\.factory\/hooks(\/|$)/,
  /^\.claude\/settings\.json$/,
  /^harness(\/|$)/,
  /^MISSION\.md$/,
  /^FACTORY\.md$/,
  /^FACTORY_RULES\.md$/,
];

const SOURCE_FILE_REGEX =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|dart|rb|php|cs|c|cpp|h|sql|prisma|graphql|proto|sh)$/i;

export function isProtectedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return DEFAULT_PROTECTED_PATTERNS.some((rx) => rx.test(normalized));
}

function globMatchesPath(globPattern: string, targetPath: string): boolean {
  const normPath = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    if (new Bun.Glob(globPattern).match(normPath)) return true;
  } catch {}
  const cleanToken = globPattern.replace(/\*+/g, "").toLowerCase();
  return cleanToken.length >= 3 && normPath.toLowerCase().includes(cleanToken);
}

export function loadCodebaseRules(cwd: string): CodebaseRulesConfig {
  const p = join(cwd, ".factory/codebase-rules.json");
  if (!existsSync(p)) return { rules: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CodebaseRulesConfig;
  } catch {
    return { rules: [] };
  }
}

export function evaluateCodebaseRulesOnEdit(
  cwd: string,
  relPath: string,
  newContent: string,
): { blocked: boolean; reasons: string[]; warnings: string[]; registryHints: string[] } {
  const cfg = loadCodebaseRules(cwd);
  const rules = cfg.rules ?? [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const registryHints: string[] = [];

  for (const rule of rules) {
    if (!globMatchesPath(rule.file_glob, relPath)) continue;

    let violated = false;
    if (rule.forbid_regex) {
      try {
        const rx = new RegExp(rule.forbid_regex, "m");
        if (rx.test(newContent)) violated = true;
      } catch {}
    }
    if (!violated && rule.require_regex) {
      try {
        const rx = new RegExp(rule.require_regex, "m");
        if (!rx.test(newContent)) violated = true;
      } catch {}
    }

    if (violated) {
      const msg = `[${rule.id}] ${rule.description} — ${rule.replacement_hint}`;
      if (rule.mode === "block") {
        reasons.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  const combinedRegistry = {
    ...(cfg.component_registry ?? {}),
    ...(cfg.pattern_registry ?? {}),
  };

  if (Object.keys(combinedRegistry).length > 0 && SOURCE_FILE_REGEX.test(relPath)) {
    for (const [domain, entry] of Object.entries(combinedRegistry)) {
      if (typeof entry === "string") {
        registryHints.push(`[${domain}] ${entry}`);
      } else if (entry && typeof entry === "object" && typeof entry.guidance === "string") {
        if (!entry.file_glob || globMatchesPath(entry.file_glob, relPath)) {
          registryHints.push(`[${domain}] ${entry.guidance}`);
        }
      }
    }
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    warnings,
    registryHints,
  };
}

function loadMatchingLessonsForFile(cwd: string, relPath: string): string[] {
  const p = join(cwd, ".factory/lessons.jsonl");
  if (!existsSync(p)) return [];
  const matches: string[] = [];
  try {
    const lines = readFileSync(p, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry && !entry.vetoed && Array.isArray(entry.trigger_patterns)) {
        if (entry.trigger_patterns.some((pat: string) => globMatchesPath(pat, relPath))) {
          matches.push(`[${entry.topic}] ${entry.rule}`);
        }
      }
    }
  } catch {}
  return matches.slice(0, 3);
}

function loadToolGuidance(cwd: string): Record<string, string> {
  const p = join(cwd, ".factory/tool-guidance.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

export const ALLOWED_TRIAGE_TOOLS = new Set([
  "read",
  "read_file",
  "list_dir",
  "readdir",
  "ls",
  "search",
  "grep",
  "find",
  "glob",
]);

interface TokenizeResult {
  ok: boolean;
  error?: string;
  words?: string[];
}

export function tokenizeShellCommand(command: string): TokenizeResult {
  const str = command.trim();
  if (!str) return { ok: false, error: "Empty command." };

  const words: string[] = [];
  let current = "";
  let i = 0;
  let inWord = false;

  while (i < str.length) {
    const ch = str[i]!;

    if (ch === " " || ch === "\t") {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      i++;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      return { ok: false, error: "Multiline shell commands are forbidden." };
    }

    if (ch === ";" || ch === "&" || ch === "|") {
      return { ok: false, error: `Compound/pipeline operator '${ch}' is forbidden.` };
    }

    if (ch === ">" || ch === "<") {
      return { ok: false, error: `Redirection/substitution operator '${ch}' is forbidden.` };
    }

    if (ch === "`") {
      return { ok: false, error: "Command substitution '`' is forbidden." };
    }

    if (ch === "$") {
      if (i + 1 < str.length) {
        const next = str[i + 1]!;
        if (next === "(") return { ok: false, error: "Command substitution '$(' is forbidden." };
        if (next === "{") return { ok: false, error: "Variable expansion '${' is forbidden." };
        if (/[A-Za-z_]/.test(next)) return { ok: false, error: "Variable expansion is forbidden." };
      }
    }

    if (ch === "\\") {
      inWord = true;
      i++;
      if (i < str.length) {
        current += str[i];
        i++;
      }
      continue;
    }

    if (ch === "'") {
      inWord = true;
      i++;
      let closed = false;
      while (i < str.length) {
        if (str[i] === "'") {
          closed = true;
          i++;
          break;
        }
        current += str[i];
        i++;
      }
      if (!closed) return { ok: false, error: "Unclosed single quote." };
      continue;
    }

    if (ch === '"') {
      inWord = true;
      i++;
      let closed = false;
      while (i < str.length) {
        const dch = str[i]!;
        if (dch === "\\") {
          if (i + 1 < str.length) {
            const nextCh = str[i + 1]!;
            if (nextCh === '"' || nextCh === "\\" || nextCh === "$" || nextCh === "`") {
              current += nextCh;
              i += 2;
              continue;
            }
          }
          current += "\\";
          i++;
          continue;
        }
        if (dch === '"') {
          closed = true;
          i++;
          break;
        }
        if (dch === "`") {
          return { ok: false, error: "Command substitution '`' inside double quotes is forbidden." };
        }
        if (dch === "$" && i + 1 < str.length) {
          const next = str[i + 1]!;
          if (next === "(" || next === "{" || /[A-Za-z_]/.test(next)) {
            return { ok: false, error: "Substitution inside double quotes is forbidden." };
          }
        }
        current += dch;
        i++;
      }
      if (!closed) return { ok: false, error: "Unclosed double quote." };
      continue;
    }

    inWord = true;
    current += ch;
    i++;
  }

  if (inWord) words.push(current);
  return { ok: true, words };
}

const ALLOWED_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "file",
  "grep",
  "rg",
  "diff",
  "find",
  "git",
  "gh",
]);

const ALLOWED_SYSTEM_PREFIXES = ["/bin/", "/usr/bin/", "/usr/local/bin/"];

function resolveBinaryName(token: string): string | null {
  if (ALLOWED_COMMANDS.has(token)) return token;

  for (const prefix of ALLOWED_SYSTEM_PREFIXES) {
    if (token.startsWith(prefix)) {
      const name = token.slice(prefix.length);
      if (ALLOWED_COMMANDS.has(name) && !name.includes("/")) {
        return name;
      }
    }
  }
  return null;
}

const ALLOWED_LS_CHARS = new Set([
  "a", "A", "l", "h", "1", "F", "R", "r", "t", "S", "d", "C",
]);

function validateLs(args: string[]): { allowed: boolean; reason?: string } {
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (arg.startsWith("--color")) {
        if (arg === "--color" || arg === "--color=auto" || arg === "--color=never" || arg === "--color=always") {
          continue;
        }
        return { allowed: false, reason: `TRIAGE GUARD: Unsupported ls option '${arg}'.` };
      }
      if (!arg.startsWith("--") && arg.length > 1) {
        let allValid = true;
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_LS_CHARS.has(ch)) {
            allValid = false;
            break;
          }
        }
        if (allValid) continue;
      }
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported ls option '${arg}'.` };
    }
  }
  return { allowed: true };
}

const ALLOWED_CAT_FLAGS = new Set(["-n", "-b", "-s", "-v", "-E", "-T", "-e", "-t", "--number"]);
const ALLOWED_WC_FLAGS = new Set(["-l", "-w", "-c", "-m", "-L", "--lines", "--words", "--bytes", "--chars"]);
const ALLOWED_PWD_FLAGS = new Set(["-L", "-P"]);
const ALLOWED_FILE_FLAGS = new Set(["-b", "-I", "-i", "-L", "-h", "--mime", "--mime-type", "--mime-encoding"]);

function validateCat(args: string[]): { allowed: boolean; reason?: string } {
  for (const arg of args) {
    if (arg.startsWith("-") && !ALLOWED_CAT_FLAGS.has(arg)) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported cat option '${arg}'.` };
    }
  }
  return { allowed: true };
}

function validateHeadTail(cmd: "head" | "tail", args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const arg = args[i]!;
    if (arg === "-n" || arg === "-c" || arg === "--lines" || arg === "--bytes") {
      skipNext = true;
      continue;
    }
    if (/^-(n|c)\d+$/.test(arg) || /^--(lines|bytes)=\d+$/.test(arg)) {
      continue;
    }
    if (arg === "-q" || arg === "-v" || (cmd === "tail" && arg === "-r")) {
      continue;
    }
    if (arg.startsWith("-")) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported ${cmd} option '${arg}'.` };
    }
  }
  return { allowed: true };
}

function validateWc(args: string[]): { allowed: boolean; reason?: string } {
  for (const arg of args) {
    if (arg.startsWith("-") && !ALLOWED_WC_FLAGS.has(arg)) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported wc option '${arg}'.` };
    }
  }
  return { allowed: true };
}

function validatePwd(args: string[]): { allowed: boolean; reason?: string } {
  for (const arg of args) {
    if (arg.startsWith("-") && !ALLOWED_PWD_FLAGS.has(arg)) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported pwd option '${arg}'.` };
    }
  }
  return { allowed: true };
}

function validateFile(args: string[]): { allowed: boolean; reason?: string } {
  for (const arg of args) {
    if (arg.startsWith("-") && !ALLOWED_FILE_FLAGS.has(arg)) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported file option '${arg}'.` };
    }
  }
  return { allowed: true };
}

const ALLOWED_GREP_CHARS = new Set([
  "r", "R", "n", "i", "v", "l", "L", "c", "w", "x", "E", "F", "s", "q",
]);

const ALLOWED_GREP_LONG_FLAGS = new Set([
  "--line-number", "--ignore-case", "--invert-match", "--files-with-matches", "--count",
  "--word-regexp", "--line-regexp", "--extended-regexp", "--fixed-strings",
]);

function validateGrep(args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const arg = args[i]!;
    if (
      arg === "-e" || arg === "-m" || arg === "-A" || arg === "-B" || arg === "-C" ||
      arg === "--include" || arg === "--exclude" || arg === "--exclude-dir"
    ) {
      skipNext = true;
      continue;
    }
    if (
      arg.startsWith("--color") ||
      /^-(m|A|B|C)\d+$/.test(arg) ||
      arg.startsWith("--include=") ||
      arg.startsWith("--exclude=") ||
      arg.startsWith("--exclude-dir=")
    ) {
      continue;
    }
    if (arg.startsWith("-")) {
      if (!arg.startsWith("--") && arg.length > 1) {
        let allValid = true;
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_GREP_CHARS.has(ch)) {
            allValid = false;
            break;
          }
        }
        if (allValid) continue;
      }
      if (ALLOWED_GREP_LONG_FLAGS.has(arg)) {
        continue;
      }
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported grep option '${arg}'.` };
    }
  }
  return { allowed: true };
}

const ALLOWED_RG_FLAGS = new Set([
  "-n", "-i", "-v", "-l", "-c", "-w", "-x", "-F", "-s", "-q", "-S", "-uu",
  "--line-number", "--ignore-case", "--smart-case", "--invert-match", "--files-with-matches",
  "--count", "--word-regexp", "--line-regexp", "--fixed-strings", "--hidden", "--no-ignore",
]);

function validateRg(args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const arg = args[i]!;
    if (
      arg === "-e" || arg === "-m" || arg === "-A" || arg === "-B" || arg === "-C" ||
      arg === "-g" || arg === "--glob" || arg === "-t" || arg === "--type" || arg === "--max-count"
    ) {
      skipNext = true;
      continue;
    }
    if (
      arg.startsWith("--color") ||
      /^-(m|A|B|C)\d+$/.test(arg) ||
      arg.startsWith("--glob=") ||
      arg.startsWith("--type=") ||
      arg.startsWith("--max-count=")
    ) {
      continue;
    }
    if (arg.startsWith("-") && !ALLOWED_RG_FLAGS.has(arg)) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported rg option '${arg}'.` };
    }
  }
  return { allowed: true };
}

const ALLOWED_DIFF_CHARS = new Set([
  "u", "r", "N", "w", "b", "B", "i", "q", "s",
]);

const ALLOWED_DIFF_LONG_FLAGS = new Set([
  "--unified", "--brief", "--ignore-all-space", "--ignore-space-change",
  "--ignore-blank-lines", "--ignore-case",
]);

function validateDiff(args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const arg = args[i]!;
    if (arg === "-U") {
      skipNext = true;
      continue;
    }
    if (/^-U\d+$/.test(arg) || /^--unified=\d+$/.test(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      if (!arg.startsWith("--") && arg.length > 1) {
        let allValid = true;
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_DIFF_CHARS.has(ch)) {
            allValid = false;
            break;
          }
        }
        if (allValid) continue;
      }
      if (ALLOWED_DIFF_LONG_FLAGS.has(arg)) {
        continue;
      }
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported diff option '${arg}'.` };
    }
  }
  return { allowed: true };
}

const ALLOWED_FIND_TOKENS = new Set([
  "-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth",
  "-empty", "-size", "-mtime", "-atime", "-ctime", "-newer", "-prune",
  "-o", "-or", "-a", "-and", "-not", "!", "(", ")",
  "-print", "-print0",
]);

function validateFind(args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const arg = args[i]!;
    if (
      arg === "-name" || arg === "-iname" || arg === "-path" || arg === "-ipath" ||
      arg === "-type" || arg === "-maxdepth" || arg === "-mindepth" || arg === "-size" ||
      arg === "-mtime" || arg === "-atime" || arg === "-ctime" || arg === "-newer"
    ) {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-") && !ALLOWED_FIND_TOKENS.has(arg)) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported find option '${arg}'.` };
    }
  }
  return { allowed: true };
}

const ALLOWED_GIT_TOP_FLAGS = new Set([
  "--no-pager",
  "--literal-pathspecs",
  "--no-optional-locks",
]);

const ALLOWED_GIT_STATUS_FLAGS = new Set([
  "-s", "--short", "-b", "--branch", "-u", "-unormal", "-uall", "-uno",
  "--untracked-files", "--untracked-files=normal", "--untracked-files=all", "--untracked-files=no",
  "--ignored", "--porcelain", "-z", "--show-stash",
]);

const ALLOWED_GIT_DIFF_FLAGS = new Set([
  "--stat", "--shortstat", "--name-only", "--name-status", "--summary",
  "--patch", "-p", "-u", "-w", "--ignore-all-space", "-b", "--ignore-space-change",
  "--ignore-blank-lines", "-M", "--find-renames", "-C", "--find-copies",
  "--no-color", "--color", "--color=always", "--color=never", "--color=auto",
  "-z", "--cached", "--staged", "--no-ext-diff", "--no-textconv", "--relative", "--word-diff",
]);

const ALLOWED_GIT_LOG_FLAGS = new Set([
  "--oneline", "--stat", "--shortstat", "--name-only", "--name-status",
  "-p", "-u", "--patch", "--graph", "--decorate", "--no-decorate",
  "--no-color", "--color", "--color=always", "--color=never", "--color=auto",
  "-z", "--all", "--reverse", "--relative-date", "--no-merges", "--merges",
]);

const ALLOWED_GIT_SHOW_FLAGS = new Set([
  "--stat", "--shortstat", "--name-only", "--name-status", "--oneline",
  "-s", "--no-patch", "-p", "-u", "--patch", "--no-color", "--color",
  "--no-ext-diff", "--no-textconv",
]);

const ALLOWED_GIT_REV_PARSE_FLAGS = new Set([
  "--verify", "--symbolic-full-name", "--abbrev-ref",
  "--is-inside-work-tree", "--show-toplevel", "--show-prefix",
  "--git-dir", "--git-common-dir", "--end-of-options", "-q", "--quiet",
]);

const ALLOWED_GIT_LS_FILES_FLAGS = new Set([
  "-s", "--stage", "-u", "--unmerged", "-c", "--cached", "-d", "--deleted",
  "-m", "--modified", "-o", "--others", "-i", "--ignored", "-t", "-z",
  "--error-unmatch", "--exclude-standard", "--full-name",
]);

const ALLOWED_GIT_LS_TREE_FLAGS = new Set([
  "-r", "-d", "-t", "-l", "-z", "--name-only", "--name-status",
  "--full-name", "--full-tree",
]);

const ALLOWED_GIT_CHECK_IGNORE_FLAGS = new Set([
  "-v", "--verbose", "-q", "--quiet", "-z", "-n", "--non-matching", "--no-index",
]);

const ALLOWED_GIT_DESCRIBE_FLAGS = new Set([
  "--tags", "--all", "--always", "--dirty", "--long", "--exact-match",
]);

const ALLOWED_GIT_BRANCH_FLAGS = new Set([
  "-a", "--all", "-r", "--remotes", "-l", "--list", "--show-current",
  "-v", "-vv", "--verbose", "--color", "--no-color", "--merged", "--no-merged",
]);

function validateGitBranch(args: string[]): { allowed: boolean; reason?: string } {
  let hasListFlag = false;
  let positionalCount = 0;

  for (const a of args) {
    if (a.startsWith("-")) {
      if (!ALLOWED_GIT_BRANCH_FLAGS.has(a)) {
        return { allowed: false, reason: `TRIAGE GUARD: Unsupported git branch option '${a}'.` };
      }
      if (a === "-l" || a === "--list") hasListFlag = true;
    } else {
      positionalCount++;
    }
  }

  if (positionalCount > 0 && !hasListFlag) {
    return {
      allowed: false,
      reason: "TRIAGE GUARD: 'git branch <name>' creates or mutates branches and is forbidden during triage.",
    };
  }

  return { allowed: true };
}

function validateGitRemote(args: string[]): { allowed: boolean; reason?: string } {
  if (args.length === 0) return { allowed: true };
  if (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")) return { allowed: true };
  const first = args[0]!;
  if (first === "show") return { allowed: true };
  if (first === "get-url") {
    for (const a of args.slice(1)) {
      if (a.startsWith("-") && a !== "--push" && a !== "--all") {
        return { allowed: false, reason: `TRIAGE GUARD: Unsupported git remote option '${a}'.` };
      }
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `TRIAGE GUARD: 'git remote ${first}' is not permitted during triage (only list/show/get-url).`,
  };
}

function validateGit(args: string[]): { allowed: boolean; reason?: string } {
  let j = 0;
  while (j < args.length) {
    const w = args[j]!;
    if (w === "-C") {
      j += 2;
      continue;
    }
    if (w.startsWith("-C")) {
      j += 1;
      continue;
    }
    if (ALLOWED_GIT_TOP_FLAGS.has(w)) {
      j += 1;
      continue;
    }
    if (w === "--version" || w === "--help") {
      return { allowed: true };
    }
    if (w.startsWith("-")) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported git option '${w}'.` };
    }
    break;
  }

  if (j >= args.length) {
    return { allowed: false, reason: "TRIAGE GUARD: Git requires a read-only subcommand." };
  }

  const subCmd = args[j]!;
  const subArgs = args.slice(j + 1);

  switch (subCmd) {
    case "status": {
      for (const a of subArgs) {
        if (a.startsWith("-") && !ALLOWED_GIT_STATUS_FLAGS.has(a)) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported git status option '${a}'.` };
        }
      }
      return { allowed: true };
    }
    case "diff": {
      let skipNext = false;
      for (let i = 0; i < subArgs.length; i++) {
        if (skipNext) { skipNext = false; continue; }
        const a = subArgs[i]!;
        if (a === "-U") { skipNext = true; continue; }
        if (/^-U\d+$/.test(a) || /^--unified=\d+$/.test(a)) continue;
        if (a.startsWith("-") && a !== "--") {
          if (!ALLOWED_GIT_DIFF_FLAGS.has(a)) {
            return { allowed: false, reason: `TRIAGE GUARD: Unsupported git diff option '${a}'.` };
          }
        }
      }
      return { allowed: true };
    }
    case "log": {
      let skipNext = false;
      for (let i = 0; i < subArgs.length; i++) {
        if (skipNext) { skipNext = false; continue; }
        const a = subArgs[i]!;
        if (
          a === "-n" || a === "--max-count" || a === "--pretty" || a === "--format" ||
          a === "--author" || a === "--since" || a === "--after" || a === "--until" ||
          a === "--before" || a === "--grep"
        ) {
          skipNext = true;
          continue;
        }
        if (
          /^-n\d+$/.test(a) || /^--max-count=\d+$/.test(a) ||
          a.startsWith("--pretty=") || a.startsWith("--format=") ||
          a.startsWith("--decorate=")
        ) {
          continue;
        }
        if (a.startsWith("-") && a !== "--") {
          if (!ALLOWED_GIT_LOG_FLAGS.has(a)) {
            return { allowed: false, reason: `TRIAGE GUARD: Unsupported git log option '${a}'.` };
          }
        }
      }
      return { allowed: true };
    }
    case "show": {
      let skipNext = false;
      for (let i = 0; i < subArgs.length; i++) {
        if (skipNext) { skipNext = false; continue; }
        const a = subArgs[i]!;
        if (a === "--pretty" || a === "--format") { skipNext = true; continue; }
        if (a.startsWith("--pretty=") || a.startsWith("--format=")) continue;
        if (a.startsWith("-") && a !== "--") {
          if (!ALLOWED_GIT_SHOW_FLAGS.has(a)) {
            return { allowed: false, reason: `TRIAGE GUARD: Unsupported git show option '${a}'.` };
          }
        }
      }
      return { allowed: true };
    }
    case "rev-parse": {
      for (const a of subArgs) {
        if (a.startsWith("--short")) continue;
        if (a.startsWith("-") && !ALLOWED_GIT_REV_PARSE_FLAGS.has(a)) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported git rev-parse option '${a}'.` };
        }
      }
      return { allowed: true };
    }
    case "ls-files": {
      for (const a of subArgs) {
        if (a.startsWith("-") && !ALLOWED_GIT_LS_FILES_FLAGS.has(a)) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported git ls-files option '${a}'.` };
        }
      }
      return { allowed: true };
    }
    case "ls-tree": {
      for (const a of subArgs) {
        if (a.startsWith("--abbrev")) continue;
        if (a.startsWith("-") && !ALLOWED_GIT_LS_TREE_FLAGS.has(a)) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported git ls-tree option '${a}'.` };
        }
      }
      return { allowed: true };
    }
    case "check-ignore": {
      for (const a of subArgs) {
        if (a.startsWith("-") && !ALLOWED_GIT_CHECK_IGNORE_FLAGS.has(a)) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported git check-ignore option '${a}'.` };
        }
      }
      return { allowed: true };
    }
    case "describe": {
      let skipNext = false;
      for (let i = 0; i < subArgs.length; i++) {
        if (skipNext) { skipNext = false; continue; }
        const a = subArgs[i]!;
        if (a === "--match") { skipNext = true; continue; }
        if (a.startsWith("--abbrev") || a.startsWith("--match=")) continue;
        if (a.startsWith("-") && !ALLOWED_GIT_DESCRIBE_FLAGS.has(a)) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported git describe option '${a}'.` };
        }
      }
      return { allowed: true };
    }
    case "branch":
      return validateGitBranch(subArgs);
    case "remote":
      return validateGitRemote(subArgs);
    default:
      return {
        allowed: false,
        reason: `TRIAGE GUARD: Git command 'git ${subCmd}' is forbidden during triage.`,
      };
  }
}

function validateGhIssue(args: string[]): { allowed: boolean; reason?: string } {
  if (args.length === 0) {
    return { allowed: false, reason: "TRIAGE GUARD: 'gh issue' requires an action." };
  }

  const action = args[0]!;
  const actionArgs = args.slice(1);

  for (const a of actionArgs) {
    if (a === "-w" || a === "--web" || a === "-e" || a === "--editor") {
      return {
        allowed: false,
        reason: `TRIAGE GUARD: Option '${a}' in 'gh issue' is forbidden during triage.`,
      };
    }
  }

  switch (action) {
    case "view": {
      const ALLOWED_VIEW = new Set(["-c", "--comments", "-q", "--jq", "--json", "-t", "--template"]);
      let skip = false;
      for (const a of actionArgs) {
        if (skip) { skip = false; continue; }
        if (a === "-q" || a === "--jq" || a === "--json" || a === "-t" || a === "--template") {
          skip = true;
          continue;
        }
        if (a.startsWith("--json=") || a.startsWith("--template=") || a.startsWith("--jq=")) continue;
        if (a.startsWith("-") && !ALLOWED_VIEW.has(a)) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported gh issue view option '${a}'.` };
        }
      }
      return { allowed: true };
    }

    case "list": {
      const ALLOWED_LIST = new Set([
        "-a", "--assignee", "-A", "--author", "-q", "--jq", "--json",
        "-l", "--label", "-L", "--limit", "-s", "--state", "--search", "-t", "--template",
      ]);
      let skip = false;
      for (const a of actionArgs) {
        if (skip) { skip = false; continue; }
        if (
          a === "-a" || a === "--assignee" || a === "-A" || a === "--author" ||
          a === "-q" || a === "--jq" || a === "--json" || a === "-l" || a === "--label" ||
          a === "-L" || a === "--limit" || a === "-s" || a === "--state" || a === "--search" ||
          a === "-t" || a === "--template"
        ) {
          skip = true;
          continue;
        }
        if (a.startsWith("-") && !ALLOWED_LIST.has(a)) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported gh issue list option '${a}'.` };
        }
      }
      return { allowed: true };
    }

    case "comment": {
      let skip = false;
      for (const a of actionArgs) {
        if (skip) { skip = false; continue; }
        if (a === "-b" || a === "--body" || a === "-F" || a === "--body-file") {
          skip = true;
          continue;
        }
        if (a.startsWith("--body=") || a.startsWith("--body-file=")) continue;
        if (a.startsWith("-")) {
          return { allowed: false, reason: `TRIAGE GUARD: Unsupported gh issue comment option '${a}'.` };
        }
      }
      return { allowed: true };
    }

    case "edit": {
      const VALUE_FLAGS = new Set([
        "--add-assignee", "--remove-assignee",
        "--add-label", "--remove-label",
        "--add-project", "--remove-project",
        "-b", "--body", "-F", "--body-file",
        "-t", "--title",
        "--add-sub-issue", "--remove-sub-issue",
        "-m", "--milestone",
      ]);
      let skip = false;
      for (const a of actionArgs) {
        if (skip) { skip = false; continue; }
        if (VALUE_FLAGS.has(a)) {
          skip = true;
          continue;
        }
        if (a.startsWith("-")) {
          const match = Array.from(VALUE_FLAGS).some((f) => a.startsWith(`${f}=`));
          if (!match) {
            return { allowed: false, reason: `TRIAGE GUARD: Unsupported gh issue edit option '${a}'.` };
          }
        }
      }
      return { allowed: true };
    }

    case "create": {
      const VALUE_FLAGS = new Set([
        "-a", "--assignee",
        "-b", "--body", "-F", "--body-file",
        "-l", "--label",
        "-m", "--milestone",
        "-p", "--project",
        "-t", "--title",
        "--parent",
      ]);
      let skip = false;
      for (const a of actionArgs) {
        if (skip) { skip = false; continue; }
        if (VALUE_FLAGS.has(a)) {
          skip = true;
          continue;
        }
        if (a.startsWith("-")) {
          const match = Array.from(VALUE_FLAGS).some((f) => a.startsWith(`${f}=`));
          if (!match) {
            return { allowed: false, reason: `TRIAGE GUARD: Unsupported gh issue create option '${a}'.` };
          }
        }
      }
      return { allowed: true };
    }

    default:
      return {
        allowed: false,
        reason: `TRIAGE GUARD: 'gh issue ${action}' is not authorized during triage (only view, list, comment, edit, create).`,
      };
  }
}

function validateGhApi(args: string[]): { allowed: boolean; reason?: string } {
  let endpoint: string | null = null;
  let skipNext = false;

  for (let i = 0; i < args.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const a = args[i]!;

    if (a === "-X" || a === "--method") {
      skipNext = true;
      const method = (args[i + 1] ?? "").toUpperCase();
      if (method !== "GET" && method !== "POST") {
        return { allowed: false, reason: `TRIAGE GUARD: 'gh api' method '${method}' is not permitted.` };
      }
      continue;
    }
    if (a.startsWith("-X") || a.startsWith("--method=")) {
      const method = (a.split("=")[1] || a.slice(2)).toUpperCase();
      if (method !== "GET" && method !== "POST") {
        return { allowed: false, reason: `TRIAGE GUARD: 'gh api' method '${method}' is not permitted.` };
      }
      continue;
    }

    if (a === "-F" || a === "-f") {
      skipNext = true;
      const field = args[i + 1] ?? "";
      const fieldName = field.split("=")[0]?.trim();
      const ALLOWED_FIELDS = new Set(["sub_issue_id", "issue_id", "target_issue_id", "before_id", "after_id"]);
      if (!ALLOWED_FIELDS.has(fieldName)) {
        return { allowed: false, reason: `TRIAGE GUARD: 'gh api' parameter '${fieldName}' is not authorized for issue linking.` };
      }
      continue;
    }
    if (a.startsWith("-F") || a.startsWith("-f")) {
      const field = a.slice(2);
      const fieldName = field.split("=")[0]?.trim();
      const ALLOWED_FIELDS = new Set(["sub_issue_id", "issue_id", "target_issue_id", "before_id", "after_id"]);
      if (!ALLOWED_FIELDS.has(fieldName)) {
        return { allowed: false, reason: `TRIAGE GUARD: 'gh api' parameter '${fieldName}' is not authorized for issue linking.` };
      }
      continue;
    }

    if (a === "-H" || a === "--header" || a === "-q" || a === "--jq") {
      skipNext = true;
      continue;
    }
    if (a.startsWith("--header=") || a.startsWith("--jq=") || a === "--silent") {
      continue;
    }

    if (a.startsWith("-")) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported gh api option '${a}'.` };
    }

    if (endpoint === null) {
      endpoint = a;
    } else {
      return { allowed: false, reason: `TRIAGE GUARD: Unexpected extra argument '${a}' in gh api.` };
    }
  }

  if (!endpoint) {
    return { allowed: false, reason: "TRIAGE GUARD: 'gh api' requires an endpoint." };
  }

  const cleanEndpoint = endpoint.replace(/^\/+/, "");
  const isSubIssue = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+\/sub_issues$/.test(cleanEndpoint);
  const isDependency = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+\/dependencies\/(blocked_by|blocking)$/.test(cleanEndpoint);

  if (!isSubIssue && !isDependency) {
    return {
      allowed: false,
      reason: `TRIAGE GUARD: 'gh api' endpoint '${endpoint}' is not authorized (only sub_issues and dependencies linking endpoints).`,
    };
  }

  return { allowed: true };
}

function validateGh(args: string[]): { allowed: boolean; reason?: string } {
  let j = 0;
  while (j < args.length) {
    const w = args[j]!;
    if (w === "-R" || w === "--repo") {
      j += 2;
      continue;
    }
    if (w.startsWith("-R") || w.startsWith("--repo=")) {
      j += 1;
      continue;
    }
    break;
  }

  if (j >= args.length) {
    return { allowed: false, reason: "TRIAGE GUARD: GitHub CLI requires an authorized command." };
  }

  const sub = args[j]!;
  const subArgs = args.slice(j + 1);

  if (sub === "issue") return validateGhIssue(subArgs);
  if (sub === "api") return validateGhApi(subArgs);

  return {
    allowed: false,
    reason: `TRIAGE GUARD: 'gh ${sub}' is not authorized during triage (only gh issue view/list/comment/edit/create and gh api linking).`,
  };
}

export function isTriageCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const tokenRes = tokenizeShellCommand(command);
  if (!tokenRes.ok || !tokenRes.words) {
    return {
      allowed: false,
      reason: `TRIAGE GUARD: Shell construct forbidden during triage: ${tokenRes.error}`,
    };
  }

  const words = tokenRes.words;
  if (words.length === 0) {
    return { allowed: false, reason: "TRIAGE GUARD: Empty command is not permitted." };
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
    return {
      allowed: false,
      reason: "TRIAGE GUARD: Inline environment variable assignment is forbidden during triage.",
    };
  }

  const baseCmd = resolveBinaryName(words[0]!);
  if (!baseCmd) {
    return {
      allowed: false,
      reason: `TRIAGE GUARD: Command '${words[0]}' is not allowlisted during triage passes.`,
    };
  }

  const cmdArgs = words.slice(1);
  switch (baseCmd) {
    case "ls":
      return validateLs(cmdArgs);
    case "cat":
      return validateCat(cmdArgs);
    case "head":
    case "tail":
      return validateHeadTail(baseCmd, cmdArgs);
    case "wc":
      return validateWc(cmdArgs);
    case "pwd":
      return validatePwd(cmdArgs);
    case "file":
      return validateFile(cmdArgs);
    case "grep":
      return validateGrep(cmdArgs);
    case "rg":
      return validateRg(cmdArgs);
    case "diff":
      return validateDiff(cmdArgs);
    case "find":
      return validateFind(cmdArgs);
    case "git":
      return validateGit(cmdArgs);
    case "gh":
      return validateGh(cmdArgs);
    default:
      return {
        allowed: false,
        reason: `TRIAGE GUARD: Command '${baseCmd}' is not allowlisted during triage passes.`,
      };
  }
}

export function evaluateTriageToolCall(
  toolName: string,
  input: Record<string, any> = {},
): { allowed: boolean; reason?: string } {
  if (toolName === "write" || toolName === "edit") {
    return {
      allowed: false,
      reason:
        "TRIAGE GUARD: File mutations via 'write' / 'edit' are forbidden during triage passes. Triage is strictly read-only.",
    };
  }

  if (toolName === "bash") {
    const cmd = typeof input?.command === "string" ? input.command : "";
    return isTriageCommandAllowed(cmd);
  }

  if (ALLOWED_TRIAGE_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `TRIAGE GUARD: Tool '${toolName}' is forbidden during triage passes. Only read-only inspection tools are permitted.`,
  };
}

export default function registerLoopGuard(api: any) {
  if (!api || typeof api.on !== "function") return;

  let consecutiveBashFailures = 0;

  api.on("tool_call", async (event: any) => {
    const toolName = String(event?.toolName ?? "");
    const args = (event?.input ?? event?.args ?? {}) as Record<string, any>;

    if (process.env.FACTORY_LOOP_ROLE === "triage") {
      const triageCheck = evaluateTriageToolCall(toolName, args);
      if (!triageCheck.allowed) {
        return {
          block: true,
          reason: triageCheck.reason ?? "TRIAGE GUARD: Operation forbidden during triage passes.",
        };
      }
    }

    const now = Date.now();
    const hardDeadline = Number(process.env.FACTORY_LOOP_HARD_DEADLINE_MS);
    const softDeadline = Number(process.env.FACTORY_LOOP_SOFT_DEADLINE_MS);
    if (Number.isFinite(hardDeadline) && hardDeadline > 0 && now >= hardDeadline) {
      return {
        block: true,
        reason:
          "HARD DEADLINE: stop tools and report interrupted; the host preserves this attempt.",
      };
    }
    if (Number.isFinite(softDeadline) && softDeadline > 0 && now >= softDeadline) {
      const checkpoint = process.env.FACTORY_LOOP_CHECKPOINT_PATH;
      const checkpointWrite =
        (toolName === "write" || toolName === "edit") &&
        checkpoint &&
        typeof args.path === "string" &&
        resolve(args.path) === resolve(checkpoint);
      // Deliberately allow only simple read-only git commands, not arbitrary shell syntax.
      const gitInspection =
        toolName === "bash" &&
        typeof args.command === "string" &&
        /^git (?:status(?: --short)?|diff(?: --stat| --name-only)?|rev-parse HEAD)$/.test(
          args.command.trim(),
        );
      if (!checkpointWrite && !gitInspection) {
        return {
          block: true,
          reason: `SOFT DEADLINE: stop new work, write progress, checks, blockers and next steps to ${checkpoint ?? "the checkpoint path in your prompt"}, then report {"verdict":"interrupted"}. Do not claim pass.`,
        };
      }
    }
    if (toolName === "bash") {
      const requested =
        typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
          ? args.timeout
          : 90;
      args.timeout =
        Number.isFinite(hardDeadline) && hardDeadline > 0
          ? Math.min(requested, Math.max(0.001, (hardDeadline - now) / 1000))
          : requested;
    }

    if ((toolName === "write" || toolName === "edit") && typeof args.path === "string") {
      if (isProtectedPath(args.path)) {
        return {
          block: true,
          reason: `HARNESS GUARD: Modifying protected path '${args.path}' inside a delivery lap is forbidden.`,
        };
      }

      const candidateText =
        typeof args.content === "string"
          ? args.content
          : Array.isArray(args.edits)
            ? args.edits.map((e: any) => e?.newText ?? "").join("\n")
            : "";

      if (candidateText) {
        const evalRes = evaluateCodebaseRulesOnEdit(process.cwd(), args.path, candidateText);
        if (evalRes.blocked) {
          return {
            block: true,
            reason: `CODEBASE STANDARD VIOLATION in '${args.path}':\n${evalRes.reasons.map((r) => `  - ${r}`).join("\n")}`,
          };
        }
      }
    }
    return undefined;
  });

  api.on("tool_result", async (event: any) => {
    const toolName = String(event?.toolName ?? "");
    const args = event?.input ?? event?.args ?? {};

    if (toolName === "bash" && !event?.isError) {
      consecutiveBashFailures = 0;
    }

    if (toolName === "bash" && event?.isError) {
      consecutiveBashFailures += 1;
      const guidance = loadToolGuidance(process.cwd());
      const entries = Object.entries(guidance);
      const hints: string[] = [];
      if (entries.length > 0) {
        const hint = entries.map(([k, v]) => `${k}: \`${v}\``).join(", ");
        hints.push(`[HARNESS TOOL GUIDANCE HINT] Verified repository commands -> ${hint}`);
      }
      if (consecutiveBashFailures >= 2) {
        hints.push(
          "[HARNESS UNSTICK TRIGGER — 2+ CONSECUTIVE FAILURES]: Stop editing production code immediately. Follow .agents/skills/unstick/SKILL.md: (1) state the single shared assumption behind the failed attempts in one sentence, (2) run a 1-line probe to test that assumption directly, (3) revert broken scratch edits (`git checkout -- <files>`) before trying an orthogonal approach, and (4) log the disproved assumption in your checkpoint.",
        );
      }
      const rawText = Array.isArray(event?.content)
        ? event.content.map((c: any) => c?.text ?? "").join("\n")
        : String(event?.content ?? "");
      if (
        rawText.toLowerCase().includes("timed out") ||
        rawText.toLowerCase().includes("timeout")
      ) {
        hints.push(
          "[HARNESS TIMEOUT HINT] Command exceeded timeout budget. Avoid long-running background tasks without explicit timeouts, and avoid reading daemon process streams before process termination.",
        );
      }
      if (hints.length > 0) {
        return {
          content: [...(event.content ?? []), { type: "text", text: `\n${hints.join("\n")}` }],
        };
      }
    }

    if (
      (toolName === "read" || toolName === "write" || toolName === "edit") &&
      typeof args.path === "string"
    ) {
      const lessons = loadMatchingLessonsForFile(process.cwd(), args.path);
      const candidateText =
        typeof args.content === "string"
          ? args.content
          : Array.isArray(args.edits)
            ? args.edits.map((e: any) => e?.newText ?? "").join("\n")
            : "";
      const ruleEval = evaluateCodebaseRulesOnEdit(process.cwd(), args.path, candidateText);

      const sections: string[] = [];
      if (ruleEval.warnings.length > 0) {
        sections.push(
          `[CODEBASE PATTERN REMINDER for ${args.path}]:\n${ruleEval.warnings.map((w) => `  - ${w}`).join("\n")}`,
        );
      }
      if (toolName === "read" && ruleEval.registryHints.length > 0) {
        sections.push(
          `[SHARED PATTERN & MODULE REGISTRY]:\n${ruleEval.registryHints.map((h) => `  - ${h}`).join("\n")}`,
        );
      }
      if (lessons.length > 0) {
        sections.push(
          `[HARNESS ACTIVE LESSONS for ${args.path}]:\n${lessons.map((l) => `  - ${l}`).join("\n")}`,
        );
      }
      if ((toolName === "write" || toolName === "edit") && consecutiveBashFailures >= 2) {
        sections.push(
          "[HARNESS UNSTICK WARNING]: You modified code after 2+ consecutive command failures without a passing probe. Follow .agents/skills/unstick/SKILL.md: verify your shared assumption with a 1-line probe and revert broken scratch edits if the next check fails.",
        );
      }
      if (sections.length > 0) {
        return {
          content: [...(event.content ?? []), { type: "text", text: `\n${sections.join("\n")}` }],
        };
      }
    }

    return undefined;
  });
}

// CLI / git hook execution support
if (import.meta.main) {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  // If invoked with --pre-commit or list of files
  let filesToCheck: string[] = [];
  if (args.includes("--pre-commit")) {
    try {
      const proc = Bun.spawnSync(["git", "diff", "--cached", "--name-only"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = proc.stdout.toString();
      filesToCheck = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      filesToCheck = [];
    }
  } else {
    filesToCheck = args.filter((a) => !a.startsWith("-"));
  }

  let hasFatalError = false;
  for (const file of filesToCheck) {
    if (isProtectedPath(file)) {
      console.error(
        `\x1b[31m[HARNESS GUARD ERROR]\x1b[0m Modifying protected path '${file}' is forbidden during delivery laps.`,
      );
      hasFatalError = true;
    }
  }

  if (hasFatalError) {
    process.exit(1);
  }
}
