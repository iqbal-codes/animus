export const CANONICAL_SECTIONS = [
  "## Source and problem",
  "## Outcome",
  "## Invariants",
  "## Acceptance criteria",
  "## Boundary",
] as const;

export function validateCanonicalIssueBody(body: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const lines = body.split("\n");
  const filteredLines: { text: string; lineNo: number }[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock) {
      filteredLines.push({ text: line, lineNo: i + 1 });
    }
  }

  const sectionIndices: { name: string; lineIdx: number }[] = [];
  for (let i = 0; i < filteredLines.length; i++) {
    const text = filteredLines[i]!.text.trim();
    if (text.startsWith("## ")) {
      const heading = text;
      const matched = CANONICAL_SECTIONS.find((section) => section === heading);
      if (matched) {
        sectionIndices.push({ name: matched, lineIdx: i });
      }
    }
  }

  for (const expectedSection of CANONICAL_SECTIONS) {
    const matches = sectionIndices.filter((section) => section.name === expectedSection);
    if (matches.length === 0) {
      errors.push(`Missing mandatory canonical section: '${expectedSection}'`);
    } else if (matches.length > 1) {
      errors.push(`Duplicate canonical section heading: '${expectedSection}'`);
    }
  }

  if (errors.length === 0) {
    for (let s = 0; s < CANONICAL_SECTIONS.length; s++) {
      const current = sectionIndices[s]!;
      if (current.name !== CANONICAL_SECTIONS[s]) {
        errors.push(
          `Canonical sections out of order: expected '${CANONICAL_SECTIONS[s]}', got '${current.name}'`,
        );
        break;
      }
      const nextLineIdx =
        s + 1 < sectionIndices.length ? sectionIndices[s + 1]!.lineIdx : filteredLines.length;

      let hasContent = false;
      for (let l = current.lineIdx + 1; l < nextLineIdx; l++) {
        const lineText = filteredLines[l]!.text.trim();
        if (lineText && !lineText.startsWith("Depends on:") && !lineText.startsWith("## ")) {
          hasContent = true;
          break;
        }
      }
      if (!hasContent) {
        errors.push(`Mandatory section '${current.name}' has empty content`);
      }
    }
  }

  const dependsOnLines = filteredLines.filter((line) =>
    /^Depends on:\s*.+$/m.test(line.text.trim()),
  );

  if (dependsOnLines.length === 0) {
    errors.push("Missing mandatory standalone 'Depends on: #<n>' or 'Depends on: None' line");
  } else if (dependsOnLines.length > 1) {
    errors.push("Multiple 'Depends on:' lines found; exactly one standalone line is permitted");
  } else {
    const lineText = dependsOnLines[0]!.text.trim();
    const validPattern = /^Depends on:\s*(?:(?:#[0-9]+(?:\s*,\s*#[0-9]+)*)|None)\s*$/;
    if (!validPattern.test(lineText)) {
      errors.push(
        `Malformed 'Depends on:' line ('${lineText}'); must match 'Depends on: #<number>, #<number>' or 'Depends on: None'`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
