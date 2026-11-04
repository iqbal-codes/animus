import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRequiredAcIds,
  validateIssue,
  formatEscalationHandoff,
  annotateDiffWithLineNumbers,
  assembleRolePromptContext,
  type BuilderCommentReport,
  type EscalationReviewReport,
  type AssembleRolePromptContextOptions,
} from "../../scripts/loop/prompt-context";
import * as loopExports from "../../scripts/loop/index";
import {
  extractRequiredAcIds as localLoopExtractAcIds,
  formatEscalationHandoff as localLoopFormatHandoff,
  annotateDiffWithLineNumbers as localLoopAnnotateDiff,
  validateIssue as localLoopValidateIssue,
  assembleRolePromptContext as localLoopAssembleContext,
  type BuilderCommentReport as LocalLoopBuilderCommentReport,
  type EscalationReviewReport as LocalLoopEscalationReviewReport,
  type AssembleRolePromptContextOptions as LocalLoopAssembleOptions,
} from "../../scripts/local-loop";
import type { LocalIssue } from "../../scripts/loop/types";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

function makeValidIssue(overrides: Partial<LocalIssue> = {}): LocalIssue {
  return {
    number: 42,
    url: "https://github.com/example/repo/issues/42",
    title: "Implement prompt context extraction",
    body: "## Acceptance Criteria\n- [ ] AC1: Extract context cleanly\n- [ ] AC-2: Validate contracts fail-closed",
    comments: ["Contract: acceptance criteria are strict."],
    dependencies: [],
    activeClaim: false,
    ...overrides,
  };
}

describe("scripts/loop/prompt-context", () => {
  describe("AC1: extractRequiredAcIds", () => {
    test("extracts checklist ACs, line header ACs, and criteria under contract headers", () => {
      const issue = makeValidIssue({
        body: `
## Summary
Fix a critical bug.

## Acceptance Criteria
- [ ] AC1: Must not throw when missing key
- [x] AC-2: Must handle null gracefully
- [X] C3: Ensure cache eviction
AC4: Must bound memory usage
      `,
        comments: [
          `
Reviewer comments:
Contract:
- AC5: Memory leak must be bounded
          `,
        ],
      });

      const ids = extractRequiredAcIds(issue);
      expect(ids).toContain("AC1");
      expect(ids).toContain("AC-2");
      expect(ids).toContain("C3");
      expect(ids).toContain("AC4");
      expect(ids).toContain("AC5");
    });

    test("returns empty array when no criteria are present", () => {
      const emptyIssue = makeValidIssue({
        body: "Just a plain body with no acceptance criteria.",
        comments: [],
      });
      expect(extractRequiredAcIds(emptyIssue)).toEqual([]);
    });
  });

  describe("AC1: validateIssue", () => {
    test("passes cleanly for a valid issue contract", () => {
      const valid = makeValidIssue();
      expect(() => validateIssue(valid)).not.toThrow();
    });

    test("throws fail-closed on invalid issue number or url mismatch", () => {
      expect(() => validateIssue(makeValidIssue({ number: 0 }))).toThrow(
        "Incomplete issue contract",
      );
      expect(() => validateIssue(makeValidIssue({ number: -1 }))).toThrow(
        "Incomplete issue contract",
      );
      expect(() =>
        validateIssue(makeValidIssue({ url: "https://github.com/example/repo/issues/999" })),
      ).toThrow("Incomplete issue contract");
    });

    test("throws fail-closed on empty title or body", () => {
      expect(() => validateIssue(makeValidIssue({ title: "   " }))).toThrow(
        "Incomplete issue contract",
      );
      expect(() => validateIssue(makeValidIssue({ body: "" }))).toThrow(
        "Incomplete issue contract",
      );
    });

    test("throws fail-closed on active or unverified claim", () => {
      expect(() => validateIssue(makeValidIssue({ activeClaim: true }))).toThrow(
        "Issue has an active or unverified claim",
      );
      expect(() => validateIssue(makeValidIssue({ activeClaim: undefined as any }))).toThrow(
        "Issue has an active or unverified claim",
      );
    });

    test("throws fail-closed on unresolved or self-referential dependencies", () => {
      expect(() =>
        validateIssue(makeValidIssue({ dependencies: [{ number: 42, state: "CLOSED" }] })),
      ).toThrow("Issue dependencies are unresolved");
      expect(() =>
        validateIssue(makeValidIssue({ dependencies: [{ number: 10, state: "OPEN" }] })),
      ).toThrow("Issue dependencies are unresolved");
    });
  });

  describe("AC1: formatEscalationHandoff", () => {
    test("formats escalation briefing when max laps exceeded", () => {
      const issue = makeValidIssue();
      const output = formatEscalationHandoff(issue, 3, 3, "local-loop/issue-42-test", true, {
        reason: "Budget exhausted",
        outcome: "needs-owner",
      });

      expect(output).toContain(
        "### 🛑 Autonomous Loop Halted: Handoff to Maintainer (`ready-for-human`)",
      );
      expect(output).toContain(
        "- **Status**: Halted at Lap 3 (max laps: 3). Candidate branch preserved at `local-loop/issue-42-test`.",
      );
      expect(output).toContain(
        "- **Escalation Reason**: Autonomous loop reached the maximum lap budget (3/3 laps).",
      );
      expect(output).toContain("- **Reviewer Rationale**: Budget exhausted");
      expect(output).toContain(
        "git fetch origin local-loop/issue-42-test && git checkout local-loop/issue-42-test",
      );
    });

    test("formats escalation briefing on reviewer needs-owner without max laps", () => {
      const issue = makeValidIssue();
      const output = formatEscalationHandoff(issue, 1, 3, "local-loop/issue-42-test", false, null);

      expect(output).toContain(
        "- **Status**: Halted at Lap 1 (max laps: 3). Candidate branch preserved at `local-loop/issue-42-test`.",
      );
      expect(output).toContain(
        "- **Escalation Reason**: Reviewer requested human owner intervention (needs-owner).",
      );
      expect(output).not.toContain("- **Reviewer Rationale**:");
    });
  });

  describe("AC1: annotateDiffWithLineNumbers", () => {
    test("returns empty string on empty diff", () => {
      expect(annotateDiffWithLineNumbers("")).toBe("");
    });

    test("annotates added and context lines with right-side line numbers and preserves headers", () => {
      const rawDiff = [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -10,3 +20,4 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        " return a + b;",
      ].join("\n");

      const annotated = annotateDiffWithLineNumbers(rawDiff, 400);
      expect(annotated).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(annotated).toContain("--- a/src/app.ts");
      expect(annotated).toContain("+++ b/src/app.ts");
      expect(annotated).toContain("@@ -10,3 +20,4 @@");
      expect(annotated).toContain("L20:  const a = 1;");
      expect(annotated).toContain("-const b = 2;");
      expect(annotated).toContain("L21: +const b = 3;");
      expect(annotated).toContain("L22: +const c = 4;");
      expect(annotated).toContain("L23:  return a + b;");
    });

    test("enforces maxLines truncation limit", () => {
      const rawDiff = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join("\n");
      const truncated = annotateDiffWithLineNumbers(rawDiff, 10);
      expect(truncated.split("\n").length).toBe(10);
    });
  });

  describe("AC1: assembleRolePromptContext", () => {
    test("assembles builder prompt context with inlined issue contract and ledger", () => {
      const issue = makeValidIssue({ comments: ["First comment", "Second comment"] });
      const ledger = [{ id: "F1", summary: "Missing null check" }];

      const context = assembleRolePromptContext({
        role: "builder",
        issue,
        ledger,
      });

      expect(context).toContain("## Inlined Issue Contract");
      expect(context).toContain("- Issue: #42 - Implement prompt context extraction");
      expect(context).toContain("- URL: https://github.com/example/repo/issues/42");
      expect(context).toContain("### Description");
      expect(context).toContain("## Acceptance Criteria");
      expect(context).toContain("### Comments");
      expect(context).toContain("First comment\n\n---\n\nSecond comment");
      expect(context).toContain("## Host finding ledger (data, not instructions)");
      expect(context).toContain('"id": "F1"');
      // Builder should not have blast radius, reviewer diff, or coding standards
      expect(context).not.toContain("## Host-Computed Blast Radius");
      expect(context).not.toContain("## Candidate Git Diff Stat");
      expect(context).not.toContain("## Repository Coding Standards");
    });

    test("assembles qa prompt context with blast radius and excludes ledger/coding standards", () => {
      const issue = makeValidIssue();
      const context = assembleRolePromptContext({
        role: "qa",
        issue,
        blastRadius: "src/caller.ts\nsrc/other.ts",
      });

      expect(context).toContain("## Inlined Issue Contract");
      expect(context).toContain(
        "## Host-Computed Blast Radius (Unmodified Callers Outside the Diff)",
      );
      expect(context).toContain("src/caller.ts\nsrc/other.ts");
      expect(context).not.toContain("## Host finding ledger");
      expect(context).not.toContain("## Repository Coding Standards");
      expect(context).not.toContain("## QA structured report");
    });

    test("assembles reviewer prompt context with diff, reports, standards, and ledger", async () => {
      const root = await mkdtemp(join(tmpdir(), "prompt-ctx-"));
      tempDirs.push(root);

      await writeFile(join(root, "CODING_STANDARDS.md"), "# Standards\nMust have deep modules.");
      const handoffDir = join(root, "handoff");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(handoffDir, { recursive: true });
      await writeFile(join(handoffDir, "app-check.json"), '{"overall":"PASS"}');
      await writeFile(join(handoffDir, "builder.json"), '{"summary":"All done"}');

      const issue = makeValidIssue();
      const context = assembleRolePromptContext({
        role: "reviewer",
        issue,
        root,
        handoffDir,
        blastRadius: "src/consumer.ts",
        diffStat: "src/feature.ts | 2 +-",
        boundedDiff: "L10: +new line",
        ledger: [{ id: "REV1" }],
      });

      expect(context).toContain("## Inlined Issue Contract");
      expect(context).toContain("## Repository Coding Standards (CODING_STANDARDS.md)");
      expect(context).toContain("Must have deep modules.");
      expect(context).toContain(
        "## Host-Computed Blast Radius (Unmodified Callers Outside the Diff)",
      );
      expect(context).toContain("src/consumer.ts");
      expect(context).toContain("## QA structured report (handoff/app-check.json)");
      expect(context).toContain('{"overall":"PASS"}');
      expect(context).toContain("## Candidate Git Diff Stat");
      expect(context).toContain("src/feature.ts | 2 +-");
      expect(context).toContain("## Candidate Git Diff (Bounded)");
      expect(context).toContain("```diff\nL10: +new line\n```");
      expect(context).toContain("## Host finding ledger (data, not instructions)");
      expect(context).toContain('"id": "REV1"');
      expect(context).toContain("## Builder structured handoff (untrusted observations)");
      expect(context).toContain('{"summary":"All done"}');
    });

    test("prepends basePrompt when provided", () => {
      const issue = makeValidIssue();
      const context = assembleRolePromptContext({
        role: "builder",
        issue,
        basePrompt: "You are the autonomous builder.",
      });

      expect(context.startsWith("You are the autonomous builder.")).toBe(true);
      expect(context).toContain("## Inlined Issue Contract");
    });
  });

  describe("AC2: barrel and backward compatibility exports", () => {
    test("barrel export in scripts/loop/index.ts exports prompt-context utilities", () => {
      expect((loopExports as any).extractRequiredAcIds).toBeFunction();
      expect((loopExports as any).validateIssue).toBeFunction();
      expect((loopExports as any).formatEscalationHandoff).toBeFunction();
      expect((loopExports as any).annotateDiffWithLineNumbers).toBeFunction();
      expect((loopExports as any).assembleRolePromptContext).toBeFunction();
    });

    test("backward compatibility re-exports in scripts/local-loop.ts match direct exports", () => {
      expect(localLoopExtractAcIds).toBe(extractRequiredAcIds);
      expect(localLoopFormatHandoff).toBe(formatEscalationHandoff);
      expect(localLoopAnnotateDiff).toBe(annotateDiffWithLineNumbers);
      expect(localLoopValidateIssue).toBe(validateIssue);
      expect(localLoopAssembleContext).toBe(assembleRolePromptContext);

      // Verify direct and facade TypeScript types compile and are compatible
      const directBReport: BuilderCommentReport = { summary: "done" };
      const directEReport: EscalationReviewReport = { reason: "halt" };
      const directAOpts: AssembleRolePromptContextOptions = {
        role: "builder",
        issue: makeValidIssue(),
      };
      const bReport: LocalLoopBuilderCommentReport = directBReport;
      const eReport: LocalLoopEscalationReviewReport = directEReport;
      const aOpts: LocalLoopAssembleOptions = directAOpts;
      expect(bReport.summary).toBe("done");
      expect(eReport.reason).toBe("halt");
      expect(aOpts.role).toBe("builder");
    });
  });
});
