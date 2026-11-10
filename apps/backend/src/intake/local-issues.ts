import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ForgeComment, ForgeIssue } from "../registry/forge";

export interface ParsedMarkdownIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  body: string;
  labels: string[];
  comments: ForgeComment[];
  isSpec?: boolean;
}

/**
 * Parses frontmatter if present:
 * ---
 * number: 1
 * title: Example
 * state: OPEN
 * labels: [bug, ready-for-agent]
 * ---
 */
function parseFrontmatterAndBody(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const rawYaml = match[1];
  const body = (match[2] ?? "").trim();
  const frontmatter: Record<string, unknown> = {};

  for (const line of rawYaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let valStr = trimmed.slice(colonIdx + 1).trim();

    // Parse simple strings, numbers, booleans, and bracketed arrays
    if (valStr.startsWith("[") && valStr.endsWith("]")) {
      const arrayItems = valStr
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      frontmatter[key] = arrayItems;
    } else {
      valStr = valStr.replace(/^['"]|['"]$/g, "");
      if (/^\d+$/.test(valStr)) {
        frontmatter[key] = parseInt(valStr, 10);
      } else if (valStr.toLowerCase() === "true") {
        frontmatter[key] = true;
      } else if (valStr.toLowerCase() === "false") {
        frontmatter[key] = false;
      } else {
        frontmatter[key] = valStr;
      }
    }
  }

  return { frontmatter, body };
}

/**
 * Extracts the first markdown heading (# Title) if available.
 */
function extractTitleFromMarkdown(body: string): { title: string | null; cleanBody: string } {
  const headingMatch = body.match(/^#\s+([^\r\n]+)\r?\n([\s\S]*)$/);
  if (headingMatch && headingMatch[1]) {
    return {
      title: headingMatch[1].trim(),
      cleanBody: (headingMatch[2] ?? "").trim(),
    };
  }
  return { title: null, cleanBody: body };
}

/**
 * Extracts a numeric ID from filename, e.g. "001-setup.md" -> 1, "issue-42.md" -> 42.
 */
function extractNumberFromFilename(fileName: string, fallbackIndex: number): number {
  const numMatch = fileName.match(/(?:issue-)?(\d+)/i);
  if (numMatch && numMatch[1]) {
    const parsed = parseInt(numMatch[1], 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return fallbackIndex;
}

/**
 * Scans a checkout directory for `.animus/issues/*.md` and `.animus/specs/*.md`.
 * Allows local offline development and test suites to operate on markdown issue contracts.
 */
export function scanLocalAnimusIssues(checkoutPath: string): ForgeIssue[] {
  if (!checkoutPath || !existsSync(checkoutPath)) return [];

  const animusDir = join(checkoutPath, ".animus");
  if (!existsSync(animusDir) || !statSync(animusDir).isDirectory()) return [];

  const issuesDir = join(animusDir, "issues");
  const specsDir = join(animusDir, "specs");

  const results: ForgeIssue[] = [];
  const seenNumbers = new Set<number>();
  let nextAutoNumber = 9001;

  // Helper to read directory of markdown files
  const readMarkdownDir = (dir: string, isSpec = false) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      let filePath = fullPath;
      if (stat.isDirectory()) {
        // Look for nested spec.md, e.g., .animus/specs/feature-a/spec.md
        const nestedSpec = join(fullPath, "spec.md");
        if (existsSync(nestedSpec) && statSync(nestedSpec).isFile()) {
          filePath = nestedSpec;
        } else {
          continue;
        }
      } else if (!entry.endsWith(".md")) {
        continue;
      }

      try {
        const rawContent = readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatterAndBody(rawContent);

        let title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
        let finalBody = body;
        if (!title) {
          const extracted = extractTitleFromMarkdown(body);
          if (extracted.title) {
            title = extracted.title;
            finalBody = extracted.cleanBody;
          } else {
            title = basename(filePath, ".md")
              .replace(/^[-_0-9]+/, "")
              .replace(/[-_]/g, " ");
          }
        }

        let num = typeof frontmatter.number === "number" ? frontmatter.number : 0;
        if (!num || num <= 0) {
          num = extractNumberFromFilename(entry, nextAutoNumber++);
        }
        while (seenNumbers.has(num)) {
          num = nextAutoNumber++;
        }
        seenNumbers.add(num);

        const rawState =
          typeof frontmatter.state === "string" ? frontmatter.state.toUpperCase() : "OPEN";
        const state: "OPEN" | "CLOSED" = rawState === "CLOSED" ? "CLOSED" : "OPEN";

        const labels: string[] = [];
        if (Array.isArray(frontmatter.labels)) {
          for (const l of frontmatter.labels) {
            if (typeof l === "string" && l.trim()) labels.push(l.trim());
          }
        }
        if (isSpec && !labels.includes("spec") && !labels.includes("type:spec")) {
          labels.push("ready-for-agent");
        } else if (!labels.some((l) => l.startsWith("ready-") || l.startsWith("triage:"))) {
          labels.push("ready-for-agent");
        }

        results.push({
          number: num,
          title,
          state,
          body: finalBody,
          labels,
          comments: [],
        });
      } catch {
        // Skip malformed individual markdown file
      }
    }
  };

  readMarkdownDir(issuesDir, false);
  readMarkdownDir(specsDir, true);

  return results;
}
