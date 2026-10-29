import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BacklogTicket } from "./types";
import { loadPrompt, renderPrompt } from "./prompts";

export function parsePrdSections(prdContent: string): { title: string; sections: { heading: string; text: string }[] } {
  const lines = prdContent.split("\n");
  let prdTitle = "Product Specification";
  const sections: { heading: string; text: string }[] = [];
  let currentHeading = "";
  let currentBuffer: string[] = [];

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);

    if (h1 && sections.length === 0 && !currentHeading) {
      prdTitle = h1[1]!.trim();
      continue;
    }

    if (h2) {
      if (currentHeading) {
        sections.push({ heading: currentHeading, text: currentBuffer.join("\n").trim() });
      }
      currentHeading = h2[1]!.trim();
      currentBuffer = [];
      continue;
    }

    if (currentHeading) {
      currentBuffer.push(line);
    }
  }

  if (currentHeading) {
    sections.push({ heading: currentHeading, text: currentBuffer.join("\n").trim() });
  }

  return { title: prdTitle, sections };
}

export function slicePrdDeterministic(prdContent: string, maxIssues = 20): BacklogTicket[] {
  const { title, sections } = parsePrdSections(prdContent);
  const tickets: BacklogTicket[] = [];

  let prevKey: string | null = null;
  let count = 0;

  for (const section of sections) {
    if (count >= maxIssues) break;
    // Skip non-functional sections
    if (/^(non-goals|out of scope|background|overview|authors|decisions)/i.test(section.heading)) {
      continue;
    }

    const key = section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!key) continue;

    const ticket: BacklogTicket = {
      key,
      title: `Implement ${section.heading}`,
      phase: section.heading,
      body: [
        `## Goal`,
        `Deliver ${section.heading} as specified in ${title}.`,
        "",
        `## Specification & Context`,
        section.text || `Implement functionality conforming to ${section.heading}.`,
        "",
        `## Invariants`,
        `- Maintain backward compatibility and zero test regressions.`,
        `- Follow repository conventions and boundary rules.`,
        "",
        `## Acceptance Criteria`,
        `- [ ] Core ${section.heading} capabilities verified with passing tests.`,
        `- [ ] Runtime checks pass without errors.`,
        ...(prevKey ? [`\nDepends on: ${prevKey}`] : []),
      ].join("\n"),
      depends_on: prevKey ? [prevKey] : [],
      depends_why: prevKey ? `Builds upon ${prevKey} foundational baseline.` : "",
      size: "small_bounded",
    };

    tickets.push(ticket);
    prevKey = key;
    count++;
  }

  return tickets;
}

export async function sliceBacklog(
  root: string,
  prdPath: string,
  maxIssues = 20,
): Promise<{ count: number; tickets: BacklogTicket[]; prompt: string }> {
  const fullPrdPath = resolve(root, prdPath);
  if (!existsSync(fullPrdPath)) {
    throw new Error(`PRD document not found at ${fullPrdPath}`);
  }

  const content = readFileSync(fullPrdPath, "utf-8");
  const promptTemplate = loadPrompt("slice-backlog", root);
  const prompt = renderPrompt(
    promptTemplate,
    {
      "read-prd.output.path": fullPrdPath,
      "read-prd.output.max_issues": String(maxIssues),
    },
    join(root, ".factory-local-loop/backlog"),
  );

  const tickets = slicePrdDeterministic(content, maxIssues);
  return {
    count: tickets.length,
    tickets,
    prompt,
  };
}
