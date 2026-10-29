import { join } from "node:path";
import { loadPrompt, renderPrompt } from "./prompts";

export interface SimplifyFinding {
  source: string;
  cost: string;
  location: string;
  smallerShape: string;
}

export interface SimplifyReport {
  findings: boolean;
  items: SimplifyFinding[];
  summary: string;
  prompt: string;
}

export function analyzeDiffComplexity(diffText: string): SimplifyFinding[] {
  const findings: SimplifyFinding[] = [];

  // Check for duplicated helper functions
  const helperMatches = diffText.matchAll(/function\s+([a-zA-Z0-9_]+)\s*\(/g);
  const seen = new Set<string>();
  for (const m of helperMatches) {
    const name = m[1]!;
    if (seen.has(name)) {
      findings.push({
        source: "simplify",
        cost: "Duplicated helper introduces redundant maintenance overhead.",
        location: `diff (${name})`,
        smallerShape: `Consolidate ${name} into shared module.`,
      });
    }
    seen.add(name);
  }

  // Check for unnecessary try/catch empty blocks
  if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(diffText)) {
    findings.push({
      source: "simplify",
      cost: "Silent catch block masks potential runtime errors and complicates debugging.",
      location: "diff (catch block)",
      smallerShape: "Remove silent catch or handle failure explicitly.",
    });
  }

  // Check for repeated raw SQL / ad-hoc fetch / raw markup duplication across diffs
  const rawSqlCount = (diffText.match(/^\+.*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/gim) ?? []).length;
  if (rawSqlCount >= 3) {
    findings.push({
      source: "simplify",
      cost: "Scattered inline SQL queries across multiple locations increase maintenance and schema drift risk.",
      location: "diff (persistence queries)",
      smallerShape:
        "Consolidate database queries into a shared repository/store module and register in .factory/codebase-rules.json (pattern_registry).",
    });
  }

  const rawTableCount = (diffText.match(/^\+.*<table\b/gm) ?? []).length;
  if (rawTableCount >= 2) {
    findings.push({
      source: "simplify",
      cost: "Multiple raw <table> elements added across views instead of a shared table primitive.",
      location: "diff (UI tables)",
      smallerShape:
        "Extract or reuse shared table primitives and register in .factory/codebase-rules.json (pattern_registry).",
    });
  }

  if (/^\+.*useEffect\s*\(/m.test(diffText) && /^\+.*<(form|input|select)\b/m.test(diffText)) {
    findings.push({
      source: "simplify",
      cost: "Manual form state synchronization via useEffect alongside raw form inputs.",
      location: "diff (form state)",
      smallerShape:
        "Use canonical form state abstraction and reusable field primitives.",
    });
  }

  return findings;
}

export async function runSimplifyCheck(
  root: string,
  workOrder: string,
  diffText: string,
  artifactsDir: string,
): Promise<SimplifyReport> {
  const items = analyzeDiffComplexity(diffText);
  const findings = items.length > 0;
  const summary = findings
    ? `Found ${items.length} structural simplification opportunity(ies).`
    : "No structural complexity defects identified. Design remains concise.";

  const template = loadPrompt("simplify", root);
  const prompt = renderPrompt(
    template,
    {
      work_order: workOrder,
    },
    artifactsDir,
  );

  const reportPath = join(artifactsDir, "shape.md");
  const markdown = [
    "# Simplify Report",
    "",
    `Findings: ${findings}`,
    "",
    `Summary: ${summary}`,
    "",
    ...(items.map((i) => `- **${i.location}**: ${i.cost} (Recommendation: ${i.smallerShape})`)),
  ].join("\n");

  await Bun.write(reportPath, markdown);

  return {
    findings,
    items,
    summary,
    prompt,
  };
}
