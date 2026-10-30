import { basename } from "node:path";
/**
 * Pure POSIX, gitattributes pattern, glob, extglob, and brace expansion utilities.
 */

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
 * Expand braces in glob pattern (e.g. {vite,vitest} -> ['vite', 'vitest'] or v{a..z}te)
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
        let parts = null;

        const rangeMatch = body.match(/^([a-zA-Z0-9]+)\.\.([a-zA-Z0-9]+)(?:\.\.(-?\d+))?$/);
        if (rangeMatch) {
          const from = rangeMatch[1];
          const to = rangeMatch[2];
          const stepVal = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : null;

          if (/^[0-9]+$/.test(from) && /^[0-9]+$/.test(to)) {
            const startNum = parseInt(from, 10);
            const endNum = parseInt(to, 10);
            const step = stepVal !== null ? Math.abs(stepVal) : 1;
            if (step > 0) {
              parts = [];
              if (startNum <= endNum) {
                for (let n = startNum; n <= endNum; n += step) parts.push(String(n));
              } else {
                for (let n = startNum; n >= endNum; n -= step) parts.push(String(n));
              }
            }
          } else if (from.length === 1 && to.length === 1) {
            const startCode = from.charCodeAt(0);
            const endCode = to.charCodeAt(0);
            const step = stepVal !== null ? Math.abs(stepVal) : 1;
            if (step > 0) {
              parts = [];
              if (startCode <= endCode) {
                for (let c = startCode; c <= endCode; c += step) parts.push(String.fromCharCode(c));
              } else {
                for (let c = startCode; c >= endCode; c -= step) parts.push(String.fromCharCode(c));
              }
            }
          }
        }

        if (!parts) {
          let commaFound = false;
          let subDepth = 0;
          const commaParts = [];
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
              commaParts.push(current);
              current = "";
              continue;
            }
            current += body[j];
          }
          commaParts.push(current);
          if (commaFound) {
            parts = commaParts;
          }
        }

        if (parts) {
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

  /** @param {boolean} [until] */
  function parseTokens(until) {
    let res = "";
    while (i < glob.length) {
      if (until && (glob[i] === ")" || glob[i] === "|")) {
        break;
      }

      // Extglobs: @(, ?(, *(, +(, !(
      if (i + 1 < glob.length && "@?*+!".includes(glob[i]) && glob[i + 1] === "(") {
        const type = glob[i];
        i += 2;
        const alts = [];
        let malformed = false;
        while (true) {
          const alt = parseTokens(true);
          alts.push(alt);
          if (i >= glob.length) {
            malformed = true;
            break;
          }
          if (glob[i] === "|") {
            i++;
            continue;
          }
          if (glob[i] === ")") {
            i++;
            break;
          }
        }
        if (malformed) {
          return "(?!)";
        }

        const altRegex = alts.join("|");
        if (type === "@") {
          res += "(?:" + altRegex + ")";
        } else if (type === "?") {
          res += "(?:" + altRegex + ")?";
        } else if (type === "*") {
          res += "(?:" + altRegex + ")*";
        } else if (type === "+") {
          res += "(?:" + altRegex + ")+";
        } else if (type === "!") {
          res += "(?:(?!(?:" + altRegex + ")$)[^/]*)";
        }
        continue;
      }

      if (glob.slice(i, i + 3) === "**/") {
        res += "(?:.*\\/)?";
        i += 3;
        continue;
      }
      if (glob.slice(i, i + 2) === "**") {
        res += ".*";
        i += 2;
        continue;
      }

      const ch = glob[i];
      if (ch === "*") {
        res += "[^/]*";
        i++;
      } else if (ch === "?") {
        res += "[^/]";
        i++;
      } else if (ch === "[") {
        let j = i + 1;
        if (j < glob.length && (glob[j] === "!" || glob[j] === "^")) j++;
        if (j < glob.length && glob[j] === "]") j++;
        while (j < glob.length && glob[j] !== "]") j++;
        if (j >= glob.length) {
          res += "\\[";
          i++;
        } else {
          const classBody = glob.slice(i + 1, j);
          if (classBody.startsWith("!")) {
            res += "[^" + classBody.slice(1) + "]";
          } else {
            res += "[" + classBody + "]";
          }
          i = j + 1;
        }
      } else if (ch === "\\") {
        i++;
        if (i < glob.length) {
          res += "\\" + glob[i];
          i++;
        }
      } else if ("()+{}^$|.".includes(ch)) {
        res += "\\" + ch;
        i++;
      } else {
        res += ch;
        i++;
      }
    }
    return res;
  }

  return parseTokens(false);
}

/**
 * Convert glob pattern to regular expression (compatible with minimatch / picomatch)
 * Supports braces ({a,b}, {a..z}) and extglobs (@(a|b), ?(a|b), *(a|b), +(a|b), !(a|b)).
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  const expanded = expandBraces(glob);
  if (expanded.length === 1) {
    return new RegExp("^" + parseGlobTokens(expanded[0]) + "$", "i");
  }
  const regexes = expanded.map((p) => parseGlobTokens(p));
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

  const isNeg = pattern.startsWith("!") && !pattern.startsWith("!(");
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

  /** @param {unknown} p */
  const isNegativePattern = (p) => {
    const s = String(p);
    return s.startsWith("!") && !s.startsWith("!(");
  };
  const positive = list.filter((p) => !isNegativePattern(p));
  const negative = list.filter((p) => isNegativePattern(p));

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

export {
  POSIX_CLASSES,
  parseGitAttrLine,
  gitPatternToRegex,
  matchGitAttrPattern,
  expandBraces,
  parseGlobTokens,
  globToRegExp,
  matchRenovatePattern,
  matchRenovatePatternList,
};
