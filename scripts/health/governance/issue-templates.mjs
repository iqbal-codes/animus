import YAML from "yaml";

/**
 * Parses front matter text using spec-compliant YAML AST parser.
 * Detects duplicate keys, unescapes strings, and extracts labels list.
 *
 * @param {string} fmText
 * @returns {{ found: boolean, labels: string[], duplicateKeys: string[], invalid: boolean }}
 */
function parseFrontMatter(fmText) {
  try {
    const doc = YAML.parseDocument(fmText, { uniqueKeys: true });
    const duplicateKeys = [];
    for (const err of doc.errors) {
      if (err.code === "DUPLICATE_KEY" && Array.isArray(err.pos)) {
        const m = fmText.slice(err.pos[0]).match(/^([a-zA-Z0-9_-]+)/);
        duplicateKeys.push(m ? m[1] : "labels");
      }
    }
    const hasNonDupErrors = doc.errors.some((e) => e.code !== "DUPLICATE_KEY");
    if (hasNonDupErrors) {
      return { found: false, labels: [], duplicateKeys, invalid: true };
    }

    const data = doc.toJS();
    if (!data || typeof data !== "object") {
      return { found: false, labels: [], duplicateKeys, invalid: false };
    }

    if (!("labels" in data)) {
      return { found: false, labels: [], duplicateKeys, invalid: false };
    }

    const raw = data.labels;
    /** @type {string[]} */
    let labels = [];
    if (Array.isArray(raw)) {
      labels = raw.map((l) => String(l).trim()).filter(Boolean);
    } else if (typeof raw === "string") {
      labels = raw
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
    }

    return { found: true, labels, duplicateKeys, invalid: false };
  } catch {
    return { found: false, labels: [], duplicateKeys: [], invalid: true };
  }
}

/**
 * Validates pull request and issue templates against open-source contract requirements.
 *
 * @param {string} repoRoot
 * @param {(relPath: string, label: string) => string | null} readRequiredFile
 * @param {string[]} violations
 */
export function validateIssueTemplates(repoRoot, readRequiredFile, violations) {
  readRequiredFile(".github/pull_request_template.md", "Pull request template");

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
    if (tmplContent === null) continue;

    const frontMatterMatch = tmplContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontMatterMatch) {
      violations.push(`${rel} must contain YAML front matter enclosed by '---'`);
      continue;
    }

    const parsed = parseFrontMatter(frontMatterMatch[1]);
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

    const hasForbiddenLabel =
      parsed.labels.some((l) => l.trim().toLowerCase() === "ready-for-agent") ||
      /ready-for-agent/i.test(tmplContent);

    if (hasForbiddenLabel) {
      const msg = `${rel} must NEVER default labels to 'ready-for-agent'`;
      if (!violations.includes(msg)) {
        violations.push(msg);
      }
    }

    for (const section of canonicalSections) {
      if (!tmplContent.includes(section)) {
        violations.push(`${rel} missing canonical contract section: '${section}'`);
      }
    }
  }
}
