import { describe, expect, test } from "bun:test";
import {
  AmbiguousEvidenceBoundaryError,
  EVIDENCE_SECTION_END,
  EVIDENCE_SECTION_START,
  escapeMarkdownTableCell,
  formatBuilderComment,
  formatCiCheckComment,
  formatReviewComment,
  generateEvidenceMigrationPreview,
  renderCanonicalPrBody,
  renderEvidenceContent,
  updatePrBodyEvidence,
} from "../../scripts/loop/pr-reporting";
import type {
  BuilderReport,
  HostBoundIdentities,
  QaReport,
  ReviewerReport,
} from "../../scripts/loop/report-schema";
import type { LocalIssue } from "../../scripts/loop/types";

describe("PR Body and Comment Reporting Lifecycle", () => {
  const dummyIdentities: HostBoundIdentities = {
    targetBaseTip: "base111111111111111111111111111111111111",
    mergeBase: "mbase22222222222222222222222222222222222",
    prHead: "head333333333333333333333333333333333333",
    testedHead: "test444444444444444444444444444444444444",
    environment: "macOS 15.0 Bun 1.4.2",
  };

  const dummyIssue: LocalIssue = {
    number: 42,
    url: "https://github.com/owner/repo/issues/42",
    title: "Truthful PR evidence reporting",
    body: "Implement PR evidence contract and lifecycle comments.",
    comments: [],
    dependencies: [],
    activeClaim: true,
  };

  test("escapeMarkdownTableCell handles newlines and pipes safely", () => {
    const raw = "Line 1\nLine 2 | with pipe | and\r\nLine 3";
    const escaped = escapeMarkdownTableCell(raw);
    expect(escaped).toBe("Line 1<br>Line 2 \\| with pipe \\| and<br>Line 3");
  });

  test("renderCanonicalPrBody produces all canonical headings and delimited evidence", () => {
    const builderReport: BuilderReport = {
      candidate: dummyIdentities.prHead,
      verdict: "pass",
      summary: "Delivered truthful reporting module.",
      outcome: "Autonomous loop renders verifiable PR bodies and review comments.",
      invariants: ["Fail-closed validation", "Preserve operator edits"],
      reviewGuidance: ["Start at scripts/loop/pr-reporting.ts"],
      changedSeams: [{ seam: "scripts/loop/artifacts.ts", impact: "Strict validation added" }],
      changes: ["scripts/loop/pr-reporting.ts: created module"],
      checks: [{ criterion: "lint", result: "pass", evidence: "exit 0" }],
      captures: [],
    };

    const prBody = renderCanonicalPrBody({
      issue: dummyIssue,
      identities: dummyIdentities,
      builderReport,
    });

    expect(prBody).toContain("Closes #42");
    expect(prBody).toContain("## Problem and Outcome");
    expect(prBody).toContain("## Invariants");
    expect(prBody).toContain("- Fail-closed validation");
    expect(prBody).toContain("## Review Guidance (Start here)");
    expect(prBody).toContain("- Start at scripts/loop/pr-reporting.ts");
    expect(prBody).toContain("## Changed Seams");
    expect(prBody).toContain("- `scripts/loop/artifacts.ts`: Strict validation added");
    expect(prBody).toContain("## Evidence");
    expect(prBody).toContain(EVIDENCE_SECTION_START);
    expect(prBody).toContain(EVIDENCE_SECTION_END);
    expect(prBody).toContain(dummyIdentities.prHead);
    expect(prBody).toContain(dummyIdentities.targetBaseTip);
    expect(prBody).toContain(dummyIdentities.testedHead);
  });

  test("updatePrBodyEvidence refreshes only the delimited region and preserves operator edits", () => {
    const initialEvidence = renderEvidenceContent({
      identities: dummyIdentities,
    });

    const humanNote = "### Operator Custom Note\nDo not merge until security approves.";
    const existingPr = [
      "## Problem and Outcome",
      "Delivered feature.",
      "",
      humanNote,
      "",
      "## Evidence",
      initialEvidence,
      "",
      "### Judge Alterations (Requires Approval)",
      "None.",
    ].join("\n");

    const updatedQa: QaReport = {
      head: dummyIdentities.testedHead,
      overall: "PASS",
      summary: "QA verification completed cleanly.",
      lines: [
        {
          id: "AC1",
          kind: "criterion",
          verdict: "PASS",
          text: "Endpoint returns 200",
          evidence: ["curl.log"],
        },
      ],
      noticed: [],
      captures: [
        {
          id: "ev-1",
          scenario: "Console UI dark theme",
          route: "/console",
          candidateIdentity: dummyIdentities.testedHead,
          applicability: "applicable",
          beforeStatus: "unavailable",
          beforeReason: "baseline uncaptured",
          afterStatus: "captured",
          afterHostedUrl: "https://github.com/user-attachments/assets/screenshot-123.png",
          hostedUrlStatus: "confirmed_access",
        },
      ],
    };

    const newEvidence = renderEvidenceContent({
      identities: dummyIdentities,
      qaReport: updatedQa,
    });

    const updatedPr = updatePrBodyEvidence(existingPr, newEvidence);

    // Operator custom note must be preserved intact!
    expect(updatedPr).toContain(humanNote);
    // Updated evidence must be present
    expect(updatedPr).toContain("AC1");
    expect(updatedPr).toContain("Endpoint returns 200");
    expect(updatedPr).toContain("https://github.com/user-attachments/assets/screenshot-123.png");
    // Only one pair of boundary markers should exist
    expect(updatedPr.indexOf(EVIDENCE_SECTION_START)).toBe(
      updatedPr.lastIndexOf(EVIDENCE_SECTION_START),
    );
    expect(updatedPr.indexOf(EVIDENCE_SECTION_END)).toBe(
      updatedPr.lastIndexOf(EVIDENCE_SECTION_END),
    );
  });

  test("sanitizer automatically redacts tokens and scripts from rendered output", () => {
    const leakQa: QaReport = {
      head: dummyIdentities.testedHead,
      overall: "PASS",
      summary: "Ran with token sk-or-v1-12345678901234567890123456789012",
      lines: [
        {
          id: "AC1",
          kind: "criterion",
          verdict: "PASS",
          text: "<script>alert('xss')</script> observed",
          evidence: ["run.log"],
        },
      ],
      noticed: [],
      captures: [],
    };

    const evidenceContent = renderEvidenceContent({
      identities: dummyIdentities,
      qaReport: leakQa,
    });

    expect(evidenceContent).not.toContain("sk-or-v1-12345678901234567890123456789012");
    expect(evidenceContent).toContain("[REDACTED_OPENROUTER_KEY]");
    expect(evidenceContent).not.toContain("<script>");
    expect(evidenceContent).toContain("[REMOVED_SCRIPT]");
  });

  test("formatReviewComment includes axes, findings, and dispositions", () => {
    const reviewerReport: ReviewerReport = {
      sha: dummyIdentities.prHead,
      outcome: "sent-back",
      reason: "Defect found in error boundary.",
      delivers: "part",
      axes: {
        standards: { status: "pass", summary: "Clean formatting and boundaries" },
        spec: { status: "fail", summary: "AC2 error recovery missing" },
      },
      findings: [
        {
          id: "fnd-1",
          axis: "spec",
          classification: "defect",
          blocking: true,
          title: "Unhandled rejection on timeout",
          description: "Throws unhandled exception when server is unreachable.",
          location: { file: "scripts/loop/client.ts", line: 42 },
          status: "open",
          lapIntroduced: 0,
        },
      ],
      dispositions: [
        { line: "fnd-1", action: "blocks", reason: "Blocks acceptance until resolved" },
      ],
      rechecks: [],
      judge_changes: [],
    };

    const comment = formatReviewComment({
      outcome: "sent back",
      route: "simple",
      candidate: dummyIdentities.prHead,
      blastRadiusCount: 3,
      reviewerReport,
    });

    expect(comment).toContain("### Loop review: sent back (route: simple)");
    expect(comment).toContain("**Candidate**: `head333333333333333333333333333333333333`");
    expect(comment).toContain("**Standards**: `pass`");
    expect(comment).toContain("**Specification**: `fail`");
    expect(comment).toContain(
      "**[fnd-1]** 🚫 BLOCKING [spec/defect]: Unhandled rejection on timeout",
    );
    expect(comment).toContain("(`scripts/loop/client.ts:42`)");
    expect(comment).toContain("- **fnd-1** (blocks): Blocks acceptance until resolved");
  });

  test("formatBuilderComment renders candidate, verdict, and checks", () => {
    const builderReport: BuilderReport = {
      candidate: "head3333",
      verdict: "pass",
      summary: "Addressed review findings.",
      changes: ["scripts/loop/types.ts: added types"],
      checks: [{ criterion: "test", result: "pass", evidence: "exit 0" }],
      captures: [],
    };
    const comment = formatBuilderComment(builderReport, 1, "continue", "head3333");
    expect(comment).toContain("### 🛠️ Builder Update (Lap 1 — route: continue)");
    expect(comment).toContain("**Candidate**: `head3333`");
    expect(comment).toContain("- [x] **test**: `pass`");
  });

  test("formatCiCheckComment formats remote failure details cleanly", () => {
    const comment = formatCiCheckComment({
      route: "continue",
      candidate: "head3333",
      failedChecks: [
        {
          name: "build-and-test",
          workflow: "CI",
          state: "failure",
          link: "https://github.com/owner/repo/actions/runs/12345",
        },
      ],
      isMaxLapsExceeded: false,
    });

    expect(comment).toContain("### Loop CI Check: Failed (route: continue)");
    expect(comment).toContain("**Candidate**: `head3333`");
    expect(comment).toContain("CI / build-and-test");
    expect(comment).toContain("https://github.com/owner/repo/actions/runs/12345");
    expect(comment).toContain("Work item sent back due to CI failure.");
  });

  test("updatePrBodyEvidence rejects missing boundaries and provides migration preview", () => {
    const unmanagedPr = [
      "## Problem and Outcome",
      "Feature description.",
      "",
      "## Evidence",
      "Manual evidence text here.",
      "",
      "### Judge Alterations (Requires Approval)",
      "None.",
    ].join("\n");

    const newEvidence = renderEvidenceContent({
      identities: dummyIdentities,
    });

    const directPreview = generateEvidenceMigrationPreview(unmanagedPr, newEvidence);
    expect(directPreview).toContain(EVIDENCE_SECTION_START);
    expect(directPreview).toContain(EVIDENCE_SECTION_END);

    try {
      updatePrBodyEvidence(unmanagedPr, newEvidence);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err instanceof AmbiguousEvidenceBoundaryError).toBe(true);
      const ambigErr = err as AmbiguousEvidenceBoundaryError;
      expect(ambigErr.migrationPreview).toContain(EVIDENCE_SECTION_START);
      expect(ambigErr.migrationPreview).toContain(EVIDENCE_SECTION_END);
      expect(ambigErr.migrationPreview).toContain("### Judge Alterations (Requires Approval)");
      expect(ambigErr.migrationPreview).toContain("Feature description.");
    }
  });

  test("updatePrBodyEvidence rejects duplicate boundary markers", () => {
    const duplicateStartPr = [
      "## Evidence",
      EVIDENCE_SECTION_START,
      "Middle 1",
      EVIDENCE_SECTION_START,
      "Middle 2",
      EVIDENCE_SECTION_END,
    ].join("\n");

    const newEvidence = renderEvidenceContent({ identities: dummyIdentities });

    expect(() => updatePrBodyEvidence(duplicateStartPr, newEvidence)).toThrow(
      /Duplicate evidence start boundary markers/,
    );

    const duplicateEndPr = [
      "## Evidence",
      EVIDENCE_SECTION_START,
      "Middle 1",
      EVIDENCE_SECTION_END,
      "Middle 2",
      EVIDENCE_SECTION_END,
    ].join("\n");

    expect(() => updatePrBodyEvidence(duplicateEndPr, newEvidence)).toThrow(
      /Duplicate evidence end boundary markers/,
    );
  });

  test("updatePrBodyEvidence preserves text outside boundaries bytewise without whitespace truncation", () => {
    const prefix =
      "## Custom Header\r\n\r\n   Indented text with trailing space   \n\n## Evidence\n\n";
    const suffix = "\n\n### Custom Footer\n   Preserve this exact indentation.\n";
    const initialEvidence = renderEvidenceContent({ identities: dummyIdentities });
    const fullBody = `${prefix}${initialEvidence}${suffix}`;

    const updatedEvidence = renderEvidenceContent({
      identities: dummyIdentities,
      outstanding: ["Custom outstanding blocker"],
    });

    const updated = updatePrBodyEvidence(fullBody, updatedEvidence);

    // Prefix and suffix must match exactly bytewise!
    expect(updated.startsWith(prefix)).toBe(true);
    expect(updated.endsWith(suffix)).toBe(true);
    expect(updated).toContain("Custom outstanding blocker");
  });

  test("renderCanonicalPrBody does not fabricate defaults when builder reports missing fields", () => {
    const sparseBuilder: BuilderReport = {
      candidate: dummyIdentities.prHead,
      verdict: "pass",
      summary: "",
      checks: [],
      captures: [],
    };

    const body = renderCanonicalPrBody({
      issue: dummyIssue,
      identities: dummyIdentities,
      builderReport: sparseBuilder,
    });

    expect(body).toContain("- Incomplete: no invariants recorded by builder.");
    expect(body).toContain("- Incomplete: no review guidance recorded.");
    expect(body).toContain("- Incomplete: no changed seams recorded.");
    expect(body).not.toContain("Preserved existing public API signatures");
    expect(body).not.toContain("Start by inspecting delivered changes");
  });

  test("renderEvidenceContent does not assert 'No visual UI changes' when captures are empty", () => {
    const evidence = renderEvidenceContent({
      identities: dummyIdentities,
      captures: [],
    });

    expect(evidence).toContain("No UI captures recorded for candidate.");
    expect(evidence).not.toContain("No visual UI changes requiring screenshot comparison.");
  });

  test("renderEvidenceContent does not fabricate verification passed on missing after artifact", () => {
    const missingArtifactQa: QaReport = {
      head: dummyIdentities.testedHead,
      overall: "PASS",
      summary: "QA run without after artifact",
      noticed: [],
      lines: [],
      captures: [
        {
          id: "cap-missing-after",
          scenario: "Account settings modal",
          route: "/settings",
          candidateIdentity: dummyIdentities.testedHead,
          applicability: "applicable",
          beforeStatus: "unavailable",
          afterStatus: "captured",
          hostedUrlStatus: "unbound",
          // afterArtifact and afterHostedUrl intentionally absent!
        },
      ],
    };

    const evidence = renderEvidenceContent({
      identities: dummyIdentities,
      qaReport: missingArtifactQa,
    });

    expect(evidence).toContain("**After capture missing**");
    expect(evidence).not.toContain("Candidate verification passed");
  });

  test("renderEvidenceContent distinguishes unestablished outstanding from established None", () => {
    // 1. Unestablished outstanding (undefined)
    const unestablished = renderEvidenceContent({
      identities: dummyIdentities,
      outstanding: undefined,
    });
    expect(unestablished).toContain("**Outstanding:** Incomplete: evaluation not established.");
    expect(unestablished).not.toContain("**Outstanding:** None.");

    // 2. Established zero outstanding (empty array)
    const establishedNone = renderEvidenceContent({
      identities: dummyIdentities,
      outstanding: [],
    });
    expect(establishedNone).toContain("**Outstanding:** None.");
  });

  test("renderEvidenceContent renders local artifact ID and access state, and inaccessible state is never success", () => {
    const qaWithCaptures: QaReport = {
      head: dummyIdentities.testedHead,
      overall: "PASS",
      summary: "QA run with captures",
      noticed: [],
      lines: [],
      captures: [
        {
          id: "cap-1",
          scenario: "Profile view",
          route: "/profile",
          candidateIdentity: dummyIdentities.testedHead,
          applicability: "applicable",
          beforeStatus: "unavailable",
          afterStatus: "captured",
          afterArtifact: "profile-after.png",
          afterHostedUrl: "https://github.com/user-attachments/assets/profile.png",
          hostedUrlStatus: "supplied_unverified",
        },
        {
          id: "cap-2",
          scenario: "Checkout dialog",
          route: "/checkout",
          candidateIdentity: dummyIdentities.testedHead,
          applicability: "applicable",
          beforeStatus: "unavailable",
          afterStatus: "captured",
          afterArtifact: "checkout-after.png",
          afterHostedUrl: "https://github.com/user-attachments/assets/broken.png",
          hostedUrlStatus: "inaccessible",
        },
      ],
    };

    const evidence = renderEvidenceContent({
      identities: dummyIdentities,
      qaReport: qaWithCaptures,
    });

    // cap-1: rendered with image, local artifact ID, and supplied_unverified access state
    expect(evidence).toContain(
      "![After: Profile view](https://github.com/user-attachments/assets/profile.png)",
    );
    expect(evidence).toContain("Local: `profile-after.png` *(access: supplied_unverified)*");

    // cap-2: inaccessible is NEVER rendered as a successful image
    expect(evidence).not.toContain("![After: Checkout dialog]");
    expect(evidence).toContain(
      "**Asset inaccessible** (`https://github.com/user-attachments/assets/broken.png`)",
    );
    expect(evidence).toContain("Local: `checkout-after.png` *(access: inaccessible)*");
  });
});
