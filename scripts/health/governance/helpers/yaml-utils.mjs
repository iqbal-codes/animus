/**
 * Pure YAML front-matter parsing utilities with comment stripping and scalar decoding.
 */

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
 * Decode double-quoted scalar escapes according to YAML 1.2
 * @param {string} str
 * @returns {string}
 */
function unescapeYamlDoubleQuoted(str) {
  let res = "";
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\\" && i + 1 < str.length) {
      i++;
      const next = str[i];
      if (next === "x" && i + 2 < str.length && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 1, i + 3))) {
        res += String.fromCharCode(parseInt(str.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (
        next === "u" &&
        i + 4 < str.length &&
        /^[0-9a-fA-F]{4}$/.test(str.slice(i + 1, i + 5))
      ) {
        res += String.fromCharCode(parseInt(str.slice(i + 1, i + 5), 16));
        i += 4;
      } else if (
        next === "U" &&
        i + 8 < str.length &&
        /^[0-9a-fA-F]{8}$/.test(str.slice(i + 1, i + 9))
      ) {
        res += String.fromCodePoint(parseInt(str.slice(i + 1, i + 9), 16));
        i += 8;
      } else if (next === "n") {
        res += "\n";
      } else if (next === "r") {
        res += "\r";
      } else if (next === "t") {
        res += "\t";
      } else if (next === "b") {
        res += "\b";
      } else if (next === "f") {
        res += "\f";
      } else if (next === "v") {
        res += "\v";
      } else if (next === "0") {
        res += "\0";
      } else if (next === "e") {
        res += "\x1b";
      } else if (next === '"') {
        res += '"';
      } else if (next === "\\") {
        res += "\\";
      } else if (next === "/") {
        res += "/";
      } else if (next === " ") {
        res += " ";
      } else {
        res += next;
      }
    } else {
      res += str[i];
    }
  }
  return res;
}

/**
 * @param {string} str
 * @returns {string}
 */
function cleanYamlScalar(str) {
  let s = str.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeYamlDoubleQuoted(s.slice(1, -1));
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s.replace(/\\ /g, " ");
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

export { stripYamlComment, unescapeYamlDoubleQuoted, cleanYamlScalar, parseFrontMatterLabels };
