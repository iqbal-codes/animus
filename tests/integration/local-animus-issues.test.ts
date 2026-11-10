import { describe, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanLocalAnimusIssues } from "../../apps/backend/src/intake/local-issues";

describe("Local Animus Issues & Specs Scanner", () => {
  test("scans .animus/issues and .animus/specs with frontmatter and markdown headings", () => {
    const tempDir = join(
      tmpdir(),
      `animus-local-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const animusDir = join(tempDir, ".animus");
    const issuesDir = join(animusDir, "issues");
    const specsDir = join(animusDir, "specs");
    const nestedSpecDir = join(specsDir, "auth-system");

    mkdirSync(issuesDir, { recursive: true });
    mkdirSync(nestedSpecDir, { recursive: true });

    // 1. Issue with full frontmatter
    writeFileSync(
      join(issuesDir, "001-setup-wizard.md"),
      `---
number: 101
title: Setup Wizard Implementation
state: OPEN
labels: [enhancement, ready-for-agent]
---
## Source and problem
The wizard needs to prompt for repository configuration.

## Outcome
The wizard successfully writes config.
`,
    );

    // 2. Issue without frontmatter, heading-based
    writeFileSync(
      join(issuesDir, "002-fix-sidebar-toggle.md"),
      `# Fix Sidebar Toggle
This issue fixes the mobile sidebar toggle.

## Acceptance criteria
- [x] Toggle works on iOS
`,
    );

    // 3. Spec in nested directory
    writeFileSync(
      join(nestedSpecDir, "spec.md"),
      `---
number: 200
title: Authentication Architecture Spec
state: OPEN
labels: [spec]
---
# Authentication Spec
Details about the auth pipeline.
`,
    );

    try {
      const results = scanLocalAnimusIssues(tempDir);
      expect(results.length).toBe(3);

      const issue101 = results.find((r) => r.number === 101);
      expect(issue101).toBeDefined();
      expect(issue101?.title).toBe("Setup Wizard Implementation");
      expect(issue101?.state).toBe("OPEN");
      expect(issue101?.labels).toContain("ready-for-agent");
      expect(issue101?.body).toContain("## Outcome");

      const issue2 = results.find((r) => r.number === 2);
      expect(issue2).toBeDefined();
      expect(issue2?.title).toBe("Fix Sidebar Toggle");
      expect(issue2?.state).toBe("OPEN");
      expect(issue2?.labels).toContain("ready-for-agent");

      const spec200 = results.find((r) => r.number === 200);
      expect(spec200).toBeDefined();
      expect(spec200?.title).toBe("Authentication Architecture Spec");
      expect(spec200?.labels).toContain("spec");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("handles empty or missing .animus folder gracefully", () => {
    const tempDir = join(tmpdir(), `animus-empty-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      expect(scanLocalAnimusIssues(tempDir)).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
