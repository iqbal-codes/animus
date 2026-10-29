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
