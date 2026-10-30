import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseFrontMatterLabels } from "./helpers/yaml-utils.mjs";

/**
 * @param {string} repoRoot
 * @param {(relPath: string, label: string) => string | null} readRequiredFile
 * @param {string[]} violations
 */
function validateIssueTemplates(repoRoot, readRequiredFile, violations) {
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

  for (const { rel, label } of issueTemplates) {
    const tmplContent = readRequiredFile(rel, label);
    if (tmplContent !== null) {
      const frontMatterMatch = tmplContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontMatterMatch) {
        violations.push(`${rel} must contain YAML front matter enclosed by '---'`);
        continue;
      }

      /** @type {string[] | null} */
      let rubyLabelList = null;
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
            rubyLabelList = Array.isArray(rubyLabels)
              ? rubyLabels.map(String)
              : typeof rubyLabels === "string"
                ? rubyLabels.split(",").map((s) => s.trim())
                : [];
            if (!rubyLabelList.includes("needs-triage")) {
              const msg = `${rel} must default labels to 'needs-triage'`;
              if (!violations.includes(msg)) {
                violations.push(msg);
              }
            }
            if (rubyLabelList.some((l) => l.trim().toLowerCase() === "ready-for-agent")) {
              const msg = `${rel} must NEVER default labels to 'ready-for-agent'`;
              if (!violations.includes(msg)) {
                violations.push(msg);
              }
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

      const hasForbiddenLabel =
        parsed.labels.some((l) => l.trim().toLowerCase() === "ready-for-agent") ||
        (rubyLabelList &&
          rubyLabelList.some((l) => l.trim().toLowerCase() === "ready-for-agent")) ||
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
}

/**
 * Verifies the presence and non-empty validity of open-source community,
 * security, supply-chain, and contributor governance files.
 *
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: string[] }}
 */

export { validateIssueTemplates };
