function validOptionValue(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && !value.startsWith("-");
}

function missingOptionValue(): { allowed: false; reason: string } {
  return { allowed: false, reason: "TRIAGE GUARD: Option requires a non-option value." };
}

const ALLOWED_TRIAGE_TOOLS = new Set([
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

    if ("${}*?[]".includes(ch) || (ch === "~" && !inWord)) {
      return { ok: false, error: "Unquoted shell expansion is forbidden." };
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
          return {
            ok: false,
            error: "Command substitution '`' inside double quotes is forbidden.",
          };
        }
        if (dch === "$") {
          return { ok: false, error: "Double-quoted shell expansion is forbidden." };
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

const ALLOWED_LS_CHARS = new Set(["a", "A", "l", "h", "1", "F", "R", "r", "t", "S", "d", "C"]);

function validateLs(args: string[]): { allowed: boolean; reason?: string } {
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (arg.startsWith("--color")) {
        if (
          arg === "--color" ||
          arg === "--color=auto" ||
          arg === "--color=never" ||
          arg === "--color=always"
        ) {
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
const ALLOWED_WC_FLAGS = new Set([
  "-l",
  "-w",
  "-c",
  "-m",
  "-L",
  "--lines",
  "--words",
  "--bytes",
  "--chars",
]);
const ALLOWED_PWD_FLAGS = new Set(["-L", "-P"]);
const ALLOWED_FILE_FLAGS = new Set([
  "-b",
  "-I",
  "-i",
  "-L",
  "-h",
  "--mime",
  "--mime-type",
  "--mime-encoding",
]);

function validateCat(args: string[]): { allowed: boolean; reason?: string } {
  for (const arg of args) {
    if (arg.startsWith("-") && !ALLOWED_CAT_FLAGS.has(arg)) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported cat option '${arg}'.` };
    }
  }
  return { allowed: true };
}

function validateHeadTail(
  cmd: "head" | "tail",
  args: string[],
): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const arg = args[i]!;
    if (arg === "-n" || arg === "-c" || arg === "--lines" || arg === "--bytes") {
      if (!validOptionValue(args[i + 1])) return missingOptionValue();
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
  "r",
  "R",
  "n",
  "i",
  "v",
  "l",
  "L",
  "c",
  "w",
  "x",
  "E",
  "F",
  "s",
  "q",
]);

const ALLOWED_GREP_LONG_FLAGS = new Set([
  "--line-number",
  "--ignore-case",
  "--invert-match",
  "--files-with-matches",
  "--count",
  "--word-regexp",
  "--line-regexp",
  "--extended-regexp",
  "--fixed-strings",
]);

function validateGrep(args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const arg = args[i]!;
    if (
      arg === "-e" ||
      arg === "-m" ||
      arg === "-A" ||
      arg === "-B" ||
      arg === "-C" ||
      arg === "--include" ||
      arg === "--exclude" ||
      arg === "--exclude-dir"
    ) {
      if (!validOptionValue(args[i + 1])) return missingOptionValue();
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
  "-n",
  "-i",
  "-v",
  "-l",
  "-c",
  "-w",
  "-x",
  "-F",
  "-s",
  "-q",
  "-S",
  "-uu",
  "--line-number",
  "--ignore-case",
  "--smart-case",
  "--invert-match",
  "--files-with-matches",
  "--count",
  "--word-regexp",
  "--line-regexp",
  "--fixed-strings",
  "--hidden",
  "--no-ignore",
]);

function validateRg(args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const arg = args[i]!;
    if (
      arg === "-e" ||
      arg === "-m" ||
      arg === "-A" ||
      arg === "-B" ||
      arg === "-C" ||
      arg === "-g" ||
      arg === "--glob" ||
      arg === "-t" ||
      arg === "--type" ||
      arg === "--max-count"
    ) {
      if (!validOptionValue(args[i + 1])) return missingOptionValue();
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

const ALLOWED_DIFF_CHARS = new Set(["u", "r", "N", "w", "b", "B", "i", "q", "s"]);

const ALLOWED_DIFF_LONG_FLAGS = new Set([
  "--unified",
  "--brief",
  "--ignore-all-space",
  "--ignore-space-change",
  "--ignore-blank-lines",
  "--ignore-case",
]);

function validateDiff(args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const arg = args[i]!;
    if (arg === "-U") {
      if (!validOptionValue(args[i + 1])) return missingOptionValue();
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
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-empty",
  "-size",
  "-mtime",
  "-atime",
  "-ctime",
  "-newer",
  "-prune",
  "-o",
  "-or",
  "-a",
  "-and",
  "-not",
  "!",
  "(",
  ")",
  "-print",
  "-print0",
]);

function validateFind(args: string[]): { allowed: boolean; reason?: string } {
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const arg = args[i]!;
    if (
      arg === "-name" ||
      arg === "-iname" ||
      arg === "-path" ||
      arg === "-ipath" ||
      arg === "-type" ||
      arg === "-maxdepth" ||
      arg === "-mindepth" ||
      arg === "-size" ||
      arg === "-mtime" ||
      arg === "-atime" ||
      arg === "-ctime" ||
      arg === "-newer"
    ) {
      if (!validOptionValue(args[i + 1])) return missingOptionValue();
      skipNext = true;
      continue;
    }
    if (arg.startsWith("-") && !ALLOWED_FIND_TOKENS.has(arg)) {
      return { allowed: false, reason: `TRIAGE GUARD: Unsupported find option '${arg}'.` };
    }
  }
  return { allowed: true };
}

const ALLOWED_GIT_TOP_FLAGS = new Set(["--no-pager", "--literal-pathspecs", "--no-optional-locks"]);

const ALLOWED_GIT_STATUS_FLAGS = new Set([
  "-s",
  "--short",
  "-b",
  "--branch",
  "-u",
  "-unormal",
  "-uall",
  "-uno",
  "--untracked-files",
  "--untracked-files=normal",
  "--untracked-files=all",
  "--untracked-files=no",
  "--ignored",
  "--porcelain",
  "-z",
  "--show-stash",
]);

const ALLOWED_GIT_DIFF_FLAGS = new Set([
  "--stat",
  "--shortstat",
  "--name-only",
  "--name-status",
  "--summary",
  "--patch",
  "-p",
  "-u",
  "-w",
  "--ignore-all-space",
  "-b",
  "--ignore-space-change",
  "--ignore-blank-lines",
  "-M",
  "--find-renames",
  "-C",
  "--find-copies",
  "--no-color",
  "--color",
  "--color=always",
  "--color=never",
  "--color=auto",
  "-z",
  "--cached",
  "--staged",
  "--no-ext-diff",
  "--no-textconv",
  "--relative",
  "--word-diff",
]);

const ALLOWED_GIT_LOG_FLAGS = new Set([
  "--oneline",
  "--stat",
  "--shortstat",
  "--name-only",
  "--name-status",
  "-p",
  "-u",
  "--patch",
  "--graph",
  "--decorate",
  "--no-decorate",
  "--no-color",
  "--color",
  "--color=always",
  "--color=never",
  "--color=auto",
  "-z",
  "--all",
  "--reverse",
  "--relative-date",
  "--no-merges",
  "--merges",
]);

const ALLOWED_GIT_SHOW_FLAGS = new Set([
  "--stat",
  "--shortstat",
  "--name-only",
  "--name-status",
  "--oneline",
  "-s",
  "--no-patch",
  "-p",
  "-u",
  "--patch",
  "--no-color",
  "--color",
  "--no-ext-diff",
  "--no-textconv",
]);

const ALLOWED_GIT_REV_PARSE_FLAGS = new Set([
  "--verify",
  "--symbolic-full-name",
  "--abbrev-ref",
  "--is-inside-work-tree",
  "--show-toplevel",
  "--show-prefix",
  "--git-dir",
  "--git-common-dir",
  "--end-of-options",
  "-q",
  "--quiet",
]);

const ALLOWED_GIT_LS_FILES_FLAGS = new Set([
  "-s",
  "--stage",
  "-u",
  "--unmerged",
  "-c",
  "--cached",
  "-d",
  "--deleted",
  "-m",
  "--modified",
  "-o",
  "--others",
  "-i",
  "--ignored",
  "-t",
  "-z",
  "--error-unmatch",
  "--exclude-standard",
  "--full-name",
]);

const ALLOWED_GIT_LS_TREE_FLAGS = new Set([
  "-r",
  "-d",
  "-t",
  "-l",
  "-z",
  "--name-only",
  "--name-status",
  "--full-name",
  "--full-tree",
]);

const ALLOWED_GIT_CHECK_IGNORE_FLAGS = new Set([
  "-v",
  "--verbose",
  "-q",
  "--quiet",
  "-z",
  "-n",
  "--non-matching",
  "--no-index",
]);

const ALLOWED_GIT_DESCRIBE_FLAGS = new Set([
  "--tags",
  "--all",
  "--always",
  "--dirty",
  "--long",
  "--exact-match",
]);

const ALLOWED_GIT_BRANCH_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-l",
  "--list",
  "--show-current",
  "-v",
  "-vv",
  "--verbose",
  "--color",
  "--no-color",
  "--merged",
  "--no-merged",
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
      reason:
        "TRIAGE GUARD: 'git branch <name>' creates or mutates branches and is forbidden during triage.",
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
        if (skipNext) {
          skipNext = false;
          continue;
        }
        const a = subArgs[i]!;
        if (a === "-U") {
          if (!validOptionValue(subArgs[i + 1])) return missingOptionValue();
          skipNext = true;
          continue;
        }
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
        if (skipNext) {
          skipNext = false;
          continue;
        }
        const a = subArgs[i]!;
        if (
          a === "-n" ||
          a === "--max-count" ||
          a === "--author" ||
          a === "--since" ||
          a === "--after" ||
          a === "--until" ||
          a === "--before" ||
          a === "--grep"
        ) {
          if (!validOptionValue(subArgs[i + 1])) return missingOptionValue();
          skipNext = true;
          continue;
        }
        if (
          /^-n\d+$/.test(a) ||
          /^--max-count=\d+$/.test(a) ||
          a.startsWith("--pretty=") ||
          a.startsWith("--format=") ||
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
        if (skipNext) {
          skipNext = false;
          continue;
        }
        const a = subArgs[i]!;
        if (a === "--pretty" || a === "--format") return missingOptionValue();
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
          return {
            allowed: false,
            reason: `TRIAGE GUARD: Unsupported git rev-parse option '${a}'.`,
          };
        }
      }
      return { allowed: true };
    }
    case "ls-files": {
      for (const a of subArgs) {
        if (a.startsWith("-") && !ALLOWED_GIT_LS_FILES_FLAGS.has(a)) {
          return {
            allowed: false,
            reason: `TRIAGE GUARD: Unsupported git ls-files option '${a}'.`,
          };
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
          return {
            allowed: false,
            reason: `TRIAGE GUARD: Unsupported git check-ignore option '${a}'.`,
          };
        }
      }
      return { allowed: true };
    }
    case "describe": {
      let skipNext = false;
      for (let i = 0; i < subArgs.length; i++) {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        const a = subArgs[i]!;
        if (a === "--match") {
          if (!validOptionValue(subArgs[i + 1])) return missingOptionValue();
          skipNext = true;
          continue;
        }
        if (a.startsWith("--abbrev") || a.startsWith("--match=")) continue;
        if (a.startsWith("-") && !ALLOWED_GIT_DESCRIBE_FLAGS.has(a)) {
          return {
            allowed: false,
            reason: `TRIAGE GUARD: Unsupported git describe option '${a}'.`,
          };
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
      const ALLOWED_VIEW = new Set([
        "-c",
        "--comments",
        "-q",
        "--jq",
        "--json",
        "-t",
        "--template",
      ]);
      let skip = false;
      for (const [index, a] of actionArgs.entries()) {
        if (skip) {
          skip = false;
          continue;
        }
        if (a === "-q" || a === "--jq" || a === "--json" || a === "-t" || a === "--template") {
          if (!validOptionValue(actionArgs[index + 1])) return missingOptionValue();
          skip = true;
          continue;
        }
        if (a.startsWith("--json=") || a.startsWith("--template=") || a.startsWith("--jq="))
          continue;
        if (a.startsWith("-") && !ALLOWED_VIEW.has(a)) {
          return {
            allowed: false,
            reason: `TRIAGE GUARD: Unsupported gh issue view option '${a}'.`,
          };
        }
      }
      return { allowed: true };
    }

    case "list": {
      const ALLOWED_LIST = new Set([
        "-a",
        "--assignee",
        "-A",
        "--author",
        "-q",
        "--jq",
        "--json",
        "-l",
        "--label",
        "-L",
        "--limit",
        "-s",
        "--state",
        "--search",
        "-t",
        "--template",
      ]);
      let skip = false;
      for (const [index, a] of actionArgs.entries()) {
        if (skip) {
          skip = false;
          continue;
        }
        if (
          a === "-a" ||
          a === "--assignee" ||
          a === "-A" ||
          a === "--author" ||
          a === "-q" ||
          a === "--jq" ||
          a === "--json" ||
          a === "-l" ||
          a === "--label" ||
          a === "-L" ||
          a === "--limit" ||
          a === "-s" ||
          a === "--state" ||
          a === "--search" ||
          a === "-t" ||
          a === "--template"
        ) {
          if (!validOptionValue(actionArgs[index + 1])) return missingOptionValue();
          skip = true;
          continue;
        }
        if (a.startsWith("-") && !ALLOWED_LIST.has(a)) {
          return {
            allowed: false,
            reason: `TRIAGE GUARD: Unsupported gh issue list option '${a}'.`,
          };
        }
      }
      return { allowed: true };
    }

    case "comment": {
      let skip = false;
      for (const [index, a] of actionArgs.entries()) {
        if (skip) {
          skip = false;
          continue;
        }
        if (a === "-b" || a === "--body" || a === "-F" || a === "--body-file") {
          if (!validOptionValue(actionArgs[index + 1])) return missingOptionValue();
          skip = true;
          continue;
        }
        if (a.startsWith("--body=") || a.startsWith("--body-file=")) continue;
        if (a.startsWith("-")) {
          return {
            allowed: false,
            reason: `TRIAGE GUARD: Unsupported gh issue comment option '${a}'.`,
          };
        }
      }
      return { allowed: true };
    }

    case "edit": {
      const VALUE_FLAGS = new Set([
        "--add-assignee",
        "--remove-assignee",
        "--add-label",
        "--remove-label",
        "--add-project",
        "--remove-project",
        "-b",
        "--body",
        "-F",
        "--body-file",
        "-t",
        "--title",
        "--add-sub-issue",
        "--remove-sub-issue",
        "-m",
        "--milestone",
      ]);
      let skip = false;
      for (const [index, a] of actionArgs.entries()) {
        if (skip) {
          skip = false;
          continue;
        }
        if (VALUE_FLAGS.has(a)) {
          if (!validOptionValue(actionArgs[index + 1])) return missingOptionValue();
          skip = true;
          continue;
        }
        if (a.startsWith("-")) {
          const match = Array.from(VALUE_FLAGS).some((f) => a.startsWith(`${f}=`));
          if (!match) {
            return {
              allowed: false,
              reason: `TRIAGE GUARD: Unsupported gh issue edit option '${a}'.`,
            };
          }
        }
      }
      return { allowed: true };
    }

    case "create": {
      const VALUE_FLAGS = new Set([
        "-a",
        "--assignee",
        "-b",
        "--body",
        "-F",
        "--body-file",
        "-l",
        "--label",
        "-m",
        "--milestone",
        "-p",
        "--project",
        "-t",
        "--title",
        "--parent",
      ]);
      let skip = false;
      for (const [index, a] of actionArgs.entries()) {
        if (skip) {
          skip = false;
          continue;
        }
        if (VALUE_FLAGS.has(a)) {
          if (!validOptionValue(actionArgs[index + 1])) return missingOptionValue();
          skip = true;
          continue;
        }
        if (a.startsWith("-")) {
          const match = Array.from(VALUE_FLAGS).some((f) => a.startsWith(`${f}=`));
          if (!match) {
            return {
              allowed: false,
              reason: `TRIAGE GUARD: Unsupported gh issue create option '${a}'.`,
            };
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
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const a = args[i]!;

    if (a === "-X" || a === "--method") {
      if (!validOptionValue(args[i + 1])) return missingOptionValue();
      skipNext = true;
      const method = (args[i + 1] ?? "").toUpperCase();
      if (method !== "GET" && method !== "POST") {
        return {
          allowed: false,
          reason: `TRIAGE GUARD: 'gh api' method '${method}' is not permitted.`,
        };
      }
      continue;
    }
    if (a.startsWith("-X") || a.startsWith("--method=")) {
      const method = (a.split("=")[1] || a.slice(2)).toUpperCase();
      if (method !== "GET" && method !== "POST") {
        return {
          allowed: false,
          reason: `TRIAGE GUARD: 'gh api' method '${method}' is not permitted.`,
        };
      }
      continue;
    }

    if (a === "-F" || a === "-f") {
      if (!validOptionValue(args[i + 1])) return missingOptionValue();
      skipNext = true;
      const field = args[i + 1] ?? "";
      const fieldName = field.split("=")[0]?.trim();
      const ALLOWED_FIELDS = new Set([
        "sub_issue_id",
        "issue_id",
        "target_issue_id",
        "before_id",
        "after_id",
      ]);
      if (!ALLOWED_FIELDS.has(fieldName)) {
        return {
          allowed: false,
          reason: `TRIAGE GUARD: 'gh api' parameter '${fieldName}' is not authorized for issue linking.`,
        };
      }
      continue;
    }
    if (a.startsWith("-F") || a.startsWith("-f")) {
      const field = a.slice(2);
      const fieldName = field.split("=")[0]?.trim();
      const ALLOWED_FIELDS = new Set([
        "sub_issue_id",
        "issue_id",
        "target_issue_id",
        "before_id",
        "after_id",
      ]);
      if (!ALLOWED_FIELDS.has(fieldName)) {
        return {
          allowed: false,
          reason: `TRIAGE GUARD: 'gh api' parameter '${fieldName}' is not authorized for issue linking.`,
        };
      }
      continue;
    }

    if (a === "-H" || a === "--header" || a === "-q" || a === "--jq") {
      if (!validOptionValue(args[i + 1])) return missingOptionValue();
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
      return {
        allowed: false,
        reason: `TRIAGE GUARD: Unexpected extra argument '${a}' in gh api.`,
      };
    }
  }

  if (!endpoint) {
    return { allowed: false, reason: "TRIAGE GUARD: 'gh api' requires an endpoint." };
  }

  const cleanEndpoint = endpoint.replace(/^\/+/, "");
  const isSubIssue = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+\/sub_issues$/.test(
    cleanEndpoint,
  );
  const isDependency =
    /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+\/dependencies\/(blocked_by|blocking)$/.test(
      cleanEndpoint,
    );

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
