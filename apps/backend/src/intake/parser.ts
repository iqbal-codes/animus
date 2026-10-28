export const DEPENDS_ON_PATTERN = /(?:depends\s+on)\s*:\s*([^\n\r]+)/gi;
export const ISSUE_NUM_PATTERN = /#?(\d+)/g;
export const PART_OF_PATTERN = /part\s+of\s*#?(\d+)/i;
export const CLAIM_PATTERN = /Loop claim:\s*run\s*([a-zA-Z0-9_-]+)/i;

export interface StructuredTicketSections {
  partOf: number | null;
  sourceProblem: string;
  outcome: string;
  invariants: string[];
  acceptanceCriteria: string[];
  boundary: string;
  dependsOn: number[];
}

export function parseDependencies(text: string): number[] {
  if (!text) return [];
  const deps: number[] = [];
  const clauseMatches = text.matchAll(/(?:depends\s+on)\s*:\s*([^\n\r]+)/gi);
  for (const match of clauseMatches) {
    const clause = match[1] || "";
    if (/none/i.test(clause.trim())) {
      continue;
    }
    const numMatches = clause.matchAll(/#?(\d+)/g);
    for (const numMatch of numMatches) {
      const n = parseInt(numMatch[1], 10);
      if (!Number.isNaN(n) && !deps.includes(n)) {
        deps.push(n);
      }
    }
  }
  return deps;
}

export function parsePartOf(text: string): number | null {
  if (!text) return null;
  const match = text.match(PART_OF_PATTERN);
  if (match && match[1]) {
    const num = parseInt(match[1], 10);
    return Number.isNaN(num) ? null : num;
  }
  return null;
}

export function isActiveClaim(
  comments?: Array<{ body?: string | null }>,
  body?: string | null,
): boolean {
  if (body && CLAIM_PATTERN.test(body)) {
    return true;
  }
  if (!comments || !Array.isArray(comments)) return false;
  for (const comment of comments) {
    const cBody = comment?.body || "";
    if (CLAIM_PATTERN.test(cBody)) {
      return true;
    }
  }
  return false;
}

export function parseTicketSections(markdown: string): StructuredTicketSections {
  const partOf = parsePartOf(markdown);
  const dependsOn = parseDependencies(markdown);

  const extractSection = (heading: string): string => {
    const regex = new RegExp(`##\\s+${heading}[\\r\\n]+([\\s\\S]*?)(?=(?:\\r?\\n##\\s+|$))`, "i");
    const match = markdown.match(regex);
    if (!match || !match[1]) return "";
    return match[1].trim();
  };

  const extractListItems = (sectionText: string): string[] => {
    if (!sectionText) return [];
    const lines = sectionText.split(/\r?\n/);
    const items: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const listMatch = trimmed.match(/^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/);
      if (listMatch && listMatch[1]) {
        items.push(listMatch[1].trim());
      }
    }
    return items;
  };

  const sourceProblem = extractSection("Source and problem");
  const outcome = extractSection("Outcome");
  const invariantsText = extractSection("Invariants");
  const acText = extractSection("Acceptance criteria");
  const boundaryRaw = extractSection("Boundary");
  // Clean up boundary by stripping Depends on clause if captured inside it
  const boundary = boundaryRaw.replace(/(?:depends\s+on)\s*:\s*[^\n\r]+/gi, "").trim();

  return {
    partOf,
    sourceProblem,
    outcome,
    invariants: extractListItems(invariantsText),
    acceptanceCriteria: extractListItems(acText),
    boundary,
    dependsOn,
  };
}

export function formatTicketMarkdown(
  sections: Partial<StructuredTicketSections> & { body?: string },
): string {
  if (sections.body && sections.body.trim().length > 0) {
    return sections.body;
  }

  const parts: string[] = [];

  if (sections.partOf) {
    parts.push(`Part of #${sections.partOf}\n`);
  }

  if (sections.sourceProblem) {
    parts.push(`## Source and problem\n\n${sections.sourceProblem}\n`);
  }

  if (sections.outcome) {
    parts.push(`## Outcome\n\n${sections.outcome}\n`);
  }

  if (sections.invariants && sections.invariants.length > 0) {
    const items = sections.invariants.map((inv) => `- ${inv}`).join("\n");
    parts.push(`## Invariants\n\n${items}\n`);
  }

  if (sections.acceptanceCriteria && sections.acceptanceCriteria.length > 0) {
    const items = sections.acceptanceCriteria
      .map((ac, idx) => (ac.startsWith("AC") ? `- [ ] ${ac}` : `- [ ] AC${idx + 1}: ${ac}`))
      .join("\n");
    parts.push(`## Acceptance criteria\n\n${items}\n`);
  }

  if (sections.boundary) {
    parts.push(`## Boundary\n\n${sections.boundary}\n`);
  }

  if (sections.dependsOn && sections.dependsOn.length > 0) {
    const depRefs = sections.dependsOn.map((d) => `#${d}`).join(", ");
    parts.push(`Depends on: ${depRefs}`);
  } else {
    parts.push("Depends on: None");
  }

  return parts.join("\n").trim();
}

export function computeDiff(oldText?: string | null, newText?: string | null): string | null {
  const oldVal = (oldText ?? "").trim();
  const newVal = (newText ?? "").trim();
  if (oldVal === newVal) {
    return null;
  }

  const oldLines = oldVal === "" ? [] : oldVal.split("\n");
  const newLines = newVal === "" ? [] : newVal.split("\n");

  const diffLines: string[] = ["--- original", "+++ proposed"];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      diffLines.push(`  ${oldLines[i]}`);
      i++;
      j++;
    } else {
      if (i < oldLines.length) {
        diffLines.push(`- ${oldLines[i]}`);
        i++;
      }
      if (j < newLines.length) {
        diffLines.push(`+ ${newLines[j]}`);
        j++;
      }
    }
  }

  return diffLines.join("\n");
}

export function computeLabelEffects(
  currentLabels: string[] = [],
  proposedLabels: string[] = [],
): {
  current_labels: string[];
  proposed_labels: string[];
  added_labels: string[];
  removed_labels: string[];
} {
  const currentSet = new Set(currentLabels.map((l) => l.trim()));
  const proposedSet = new Set(proposedLabels.map((l) => l.trim()));

  const added: string[] = [];
  const removed: string[] = [];

  for (const label of proposedSet) {
    if (!currentSet.has(label)) {
      added.push(label);
    }
  }

  for (const label of currentSet) {
    if (!proposedSet.has(label)) {
      removed.push(label);
    }
  }

  return {
    current_labels: Array.from(currentSet),
    proposed_labels: Array.from(proposedSet),
    added_labels: added,
    removed_labels: removed,
  };
}
