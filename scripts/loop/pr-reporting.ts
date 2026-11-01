import { ReportSanitizer } from "@animus/contracts/sanitizer";
import type {
  BuilderReport,
  CaptureRecord,
  HostBoundIdentities,
  QaReport,
  ReviewFinding,
  ReviewerReport,
} from "./report-schema";
import type { LocalIssue } from "./types";

export const EVIDENCE_SECTION_START = "<!-- BEGIN_FACTORY_EVIDENCE_INDEX -->";
export const EVIDENCE_SECTION_END = "<!-- END_FACTORY_EVIDENCE_INDEX -->";

export class AmbiguousEvidenceBoundaryError extends Error {
  public readonly migrationPreview: string;

  constructor(message: string, migrationPreview: string) {
    super(`${message}\n\nMigration preview:\n${migrationPreview}`);
    this.name = "AmbiguousEvidenceBoundaryError";
    this.migrationPreview = migrationPreview;
  }
}

const sanitizer = new ReportSanitizer();

/**
 * Escapes characters that break Markdown table rendering (| and newlines).
 */
export function escapeMarkdownTableCell(text: string): string {
  if (!text) return "";
  return text
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Renders the candidate-bound Evidence section bounded by boundary markers.
 */
export function renderEvidenceContent(params: {
  identities: HostBoundIdentities;
  qaReport?: QaReport;
  builderReport?: BuilderReport;
  captures?: CaptureRecord[];
  outstanding?: string[];
  judgeAlterations?: string[];
}): string {
  const { identities, qaReport, builderReport, captures, outstanding, judgeAlterations } = params;

  const lines: string[] = [];

  // 1. Candidate & Environment Identities
  lines.push(`PR head: \`${identities.prHead}\`; selected base: \`${identities.targetBaseTip}\`.`);
  lines.push(`Tested identity: \`${identities.testedHead}\`.`);
  const envText =
    typeof identities.environment === "string"
      ? identities.environment
      : identities.environment?.os || identities.environment?.runtime
        ? `${identities.environment.os || ""} ${identities.environment.runtime || ""} ${identities.environment.browser || ""}`.trim()
        : "Standard loop verification environment";
  lines.push(`Environment: ${envText}.`);
  lines.push("");

  // 2. Acceptance Criteria & Verification Table
  lines.push("| Criterion / scenario | Result | Observed behavior | Check / artifact |");
  lines.push("| --- | --- | --- | --- |");

  if (qaReport && qaReport.lines && qaReport.lines.length > 0) {
    for (const l of qaReport.lines) {
      const crit = escapeMarkdownTableCell(l.id);
      const verdict = escapeMarkdownTableCell(l.verdict);
      const observed = escapeMarkdownTableCell(
        l.observed || l.text || (l.expected ? `Expected: ${l.expected}` : ""),
      );
      const art = escapeMarkdownTableCell(
        l.evidence && l.evidence.length > 0
          ? l.evidence.join(", ")
          : l.command || l.scenario || "n/a",
      );
      lines.push(`| ${crit} | ${verdict} | ${observed} | ${art} |`);
    }
  } else if (builderReport && builderReport.checks && builderReport.checks.length > 0) {
    for (const c of builderReport.checks) {
      const crit = escapeMarkdownTableCell(c.criterion);
      const verdict = escapeMarkdownTableCell(c.result.toUpperCase());
      const observed = escapeMarkdownTableCell(c.evidence || "Verified in ordinary checks");
      const art = escapeMarkdownTableCell(c.command || "builder-checks.log");
      lines.push(`| ${crit} | ${verdict} | ${observed} | ${art} |`);
    }
  } else {
    lines.push("| Initial verification | NOT RUN | Initial build awaiting QA | n/a |");
  }
  lines.push("");

  // 3. Before / After Comparison Table
  lines.push("### Before / After");
  lines.push("");

  const allCaptures = captures ?? qaReport?.captures ?? builderReport?.captures ?? [];
  if (allCaptures.length > 0) {
    lines.push("| Scenario | Before | After |");
    lines.push("| --- | --- | --- |");
    for (const cap of allCaptures) {
      const scenarioText = escapeMarkdownTableCell(
        `${cap.scenario} (${cap.route}${cap.viewport ? `, ${cap.viewport}` : ""}${cap.theme ? `, ${cap.theme}` : ""})`,
      );

      let beforeCell = "";
      if (cap.applicability === "na_new_feature") {
        beforeCell = `**N/A: new feature** (${escapeMarkdownTableCell(cap.beforeReason || "no baseline equivalent")})`;
      } else if (cap.applicability === "na_nonvisual") {
        beforeCell = `**N/A: nonvisual** (${escapeMarkdownTableCell(cap.beforeReason || "logic/contract change")})`;
      } else if (cap.beforeStatus === "unavailable") {
        beforeCell = `**Before unavailable: not captured** (${escapeMarkdownTableCell(cap.beforeReason || "baseline uncaptured")})`;
      } else if (cap.beforeHostedUrl) {
        const artId = escapeMarkdownTableCell(cap.beforeArtifact || cap.id);
        const statusLabel = escapeMarkdownTableCell(cap.hostedUrlStatus || "supplied_unverified");
        if (cap.hostedUrlStatus === "inaccessible") {
          beforeCell = `**Asset inaccessible** (\`${escapeMarkdownTableCell(cap.beforeHostedUrl)}\`)<br>Local: \`${artId}\` *(access: inaccessible)*`;
        } else {
          beforeCell = `![Before: ${escapeMarkdownTableCell(cap.scenario)}](${cap.beforeHostedUrl})<br>Local: \`${artId}\` *(access: ${statusLabel})*`;
        }
      } else if (cap.beforeArtifact) {
        beforeCell = `Local artifact: \`${escapeMarkdownTableCell(cap.beforeArtifact)}\` *(unbound - manual upload pending)*`;
      } else {
        beforeCell = "**Before capture missing**";
      }

      let afterCell = "";
      if (cap.afterHostedUrl) {
        const artId = escapeMarkdownTableCell(cap.afterArtifact || cap.id);
        const statusLabel = escapeMarkdownTableCell(cap.hostedUrlStatus || "supplied_unverified");
        if (cap.hostedUrlStatus === "inaccessible") {
          afterCell = `**Asset inaccessible** (\`${escapeMarkdownTableCell(cap.afterHostedUrl)}\`)<br>Local: \`${artId}\` *(access: inaccessible)*`;
        } else {
          afterCell = `![After: ${escapeMarkdownTableCell(cap.scenario)}](${cap.afterHostedUrl})<br>Local: \`${artId}\` *(access: ${statusLabel})*`;
        }
      } else if (cap.afterArtifact) {
        afterCell = `Local artifact: \`${escapeMarkdownTableCell(cap.afterArtifact)}\` *(unbound - manual upload pending)*`;
      } else {
        if (cap.afterStatus === "unavailable") {
          afterCell = `**After unavailable** (${escapeMarkdownTableCell(cap.afterReason || "uncaptured")})`;
        } else {
          afterCell = "**After capture missing**";
        }
      }

      lines.push(`| ${scenarioText} | ${beforeCell} | ${afterCell} |`);
    }
    lines.push("");
  } else {
    lines.push("No UI captures recorded for candidate.");
    lines.push("");
  }

  // 4. Detailed Reproduction Evidence in Collapsible Block
  lines.push("<details>");
  lines.push("<summary>Reproduction and detailed evidence</summary>");
  lines.push("");
  lines.push("```");
  if (qaReport) {
    lines.push(`QA Summary: ${qaReport.summary || "No narrative summary provided"}`);
    lines.push(`Overall QA verdict: ${qaReport.overall}`);
    if (qaReport.noticed && qaReport.noticed.length > 0) {
      lines.push("Noticed observations:");
      for (const n of qaReport.noticed) lines.push(`- ${n}`);
    }
  } else if (builderReport) {
    lines.push(`Builder summary: ${builderReport.summary}`);
    lines.push(`Verdict: ${builderReport.verdict}`);
  } else {
    lines.push("Detailed logs available in loop run artifacts directory.");
  }
  lines.push("```");
  lines.push("</details>");
  lines.push("");

  // 5. Outstanding Issues
  if (outstanding !== undefined) {
    if (outstanding.length === 0) {
      lines.push("**Outstanding:** None.");
    } else {
      lines.push(`**Outstanding:** ${outstanding.map(escapeMarkdownTableCell).join("; ")}`);
    }
  } else {
    lines.push("**Outstanding:** Incomplete: evaluation not established.");
  }
  lines.push("");

  // 6. Judge Alterations (Requires Approval)
  lines.push("### Judge Alterations (Requires Approval)");
  if (judgeAlterations && judgeAlterations.length > 0) {
    for (const alt of judgeAlterations) lines.push(`- ${alt}`);
  } else {
    lines.push("None.");
  }

  const rawSection = lines.join("\n");
  const sanitizedSection = sanitizer.sanitizeMarkdown(rawSection).report;

  return [EVIDENCE_SECTION_START, sanitizedSection, EVIDENCE_SECTION_END].join("\n");
}

/**
 * Renders the full PR body matching canonical repository template headings.
 */
export function renderCanonicalPrBody(params: {
  issue: LocalIssue;
  identities: HostBoundIdentities;
  builderReport?: BuilderReport;
  qaReport?: QaReport;
  captures?: CaptureRecord[];
  outstanding?: string[];
  judgeAlterations?: string[];
}): string {
  const { issue, identities, builderReport, qaReport, captures, outstanding, judgeAlterations } =
    params;

  const outcomeText =
    builderReport?.outcome ||
    builderReport?.summary ||
    "Incomplete: no builder outcome or summary recorded.";

  const invariants =
    builderReport?.invariants && builderReport.invariants.length > 0
      ? builderReport.invariants.map((i) => `- ${i}`).join("\n")
      : "- Incomplete: no invariants recorded by builder.";

  const guidance =
    builderReport?.reviewGuidance && builderReport.reviewGuidance.length > 0
      ? builderReport.reviewGuidance.map((g) => `- ${g}`).join("\n")
      : "- Incomplete: no review guidance recorded.";

  const seams =
    builderReport?.changedSeams && builderReport.changedSeams.length > 0
      ? builderReport.changedSeams
          .map((s) => (typeof s === "string" ? `- ${s}` : `- \`${s.seam}\`: ${s.impact}`))
          .join("\n")
      : builderReport?.changes && builderReport.changes.length > 0
        ? builderReport.changes.map((c) => `- ${c}`).join("\n")
        : "- Incomplete: no changed seams recorded.";

  const evidenceBlock = renderEvidenceContent({
    identities,
    qaReport,
    builderReport,
    captures,
    outstanding,
    judgeAlterations,
  });

  const bodyParts = [
    `Closes #${issue.number}`,
    "",
    "## Problem and Outcome",
    "",
    `Resolves issue #${issue.number}: ${issue.title}.`,
    outcomeText,
    "",
    "## Invariants",
    "",
    invariants,
    "",
    "## Review Guidance (Start here)",
    "",
    guidance,
    "",
    "## Changed Seams",
    "",
    seams,
    "",
    "## Evidence",
    "",
    evidenceBlock,
  ];

  return bodyParts.join("\n");
}

/**
 * Generates a migration preview showing where boundary markers belong without truncating subsequent sections.
 */
export function generateEvidenceMigrationPreview(
  existingBody: string,
  newEvidenceBlock: string,
): string {
  const evidenceHeaderRegex = /^## Evidence\b/m;
  const match = evidenceHeaderRegex.exec(existingBody);
  if (match && match.index !== undefined) {
    const headerStart = match.index;
    const headerEnd = headerStart + match[0].length;
    // Find next top-level heading (## ) after headerEnd
    const nextHeadingRegex = /\n## [^\n]+/g;
    nextHeadingRegex.lastIndex = headerEnd;
    const nextMatch = nextHeadingRegex.exec(existingBody);
    const beforeEvidence = existingBody.slice(0, headerEnd);
    const afterEvidence = nextMatch ? existingBody.slice(nextMatch.index) : "";
    return `${beforeEvidence}\n\n${newEvidenceBlock}${afterEvidence}`;
  }
  return `${existingBody.trimEnd()}\n\n## Evidence\n\n${newEvidenceBlock}\n`;
}

/**
 * Updates only the owned evidence section in an existing PR body, preserving human edits.
 * Rejects duplicate or missing/ambiguous boundaries to avoid destructive replacement.
 * Preserves all content outside the owned region bytewise.
 */
export function updatePrBodyEvidence(existingBody: string, newEvidenceBlock: string): string {
  // Reject duplicate boundaries
  const firstStart = existingBody.indexOf(EVIDENCE_SECTION_START);
  const lastStart = existingBody.lastIndexOf(EVIDENCE_SECTION_START);
  if (firstStart !== -1 && firstStart !== lastStart) {
    throw new Error(
      `Duplicate evidence start boundary markers (${EVIDENCE_SECTION_START}) detected in PR body; refusing ambiguous update.`,
    );
  }

  const firstEnd = existingBody.indexOf(EVIDENCE_SECTION_END);
  const lastEnd = existingBody.lastIndexOf(EVIDENCE_SECTION_END);
  if (firstEnd !== -1 && firstEnd !== lastEnd) {
    throw new Error(
      `Duplicate evidence end boundary markers (${EVIDENCE_SECTION_END}) detected in PR body; refusing ambiguous update.`,
    );
  }

  if (firstStart !== -1 && firstEnd !== -1 && firstEnd > firstStart) {
    const before = existingBody.slice(0, firstStart);
    const after = existingBody.slice(firstEnd + EVIDENCE_SECTION_END.length);
    return `${before}${newEvidenceBlock}${after}`;
  }

  // Missing or ambiguous boundaries: refuse destructive replacement and provide migration preview
  const migrationPreview = generateEvidenceMigrationPreview(existingBody, newEvidenceBlock);
  throw new AmbiguousEvidenceBoundaryError(
    "Missing or ambiguous evidence boundaries in PR body. Autonomous update refused to prevent destructive replacement.",
    migrationPreview,
  );
}

/**
 * Formats a builder progress comment for PR continue laps.
 */
export function formatBuilderComment(
  report:
    | {
        candidate?: string;
        verdict?: string;
        summary?: string;
        changes?: string[];
        checks?: Array<{ criterion?: string; result?: string; evidence?: string }>;
      }
    | null
    | undefined,
  lap: number,
  route: string,
  candidate: string,
): string {
  const lines = [
    `### 🛠️ Builder Update (Lap ${lap} — route: ${route})`,
    "",
    `**Candidate**: \`${candidate}\``,
    "",
    ...(report?.summary ? [`#### 📝 Summary of Changes:`, report.summary, ""] : []),
    ...(report?.changes && report.changes.length > 0
      ? [`#### 📁 Changes Made:`, ...report.changes.map((c) => `- ${c}`), ""]
      : []),
    ...(report?.checks && report.checks.length > 0
      ? [
          `#### 🧪 Verification Checks:`,
          ...report.checks.map(
            (c) =>
              `- [${c.result === "pass" || c.result === "ok" ? "x" : " "}] **${c.criterion || "check"}**: \`${c.result || "ok"}\`${c.evidence ? ` (${c.evidence})` : ""}`,
          ),
          "",
        ]
      : ["#### 🧪 Verification Checks:", "- [x] Initial build verification checks complete", ""]),
  ];

  return sanitizer.sanitizeMarkdown(lines.join("\n").trim()).report;
}

/**
 * Formats a review comment preserving "Loop review: <outcome> (route: <route>)" prefix.
 */
export function formatReviewComment(params: {
  outcome: string;
  route: string;
  candidate: string;
  blastRadiusCount: number;
  qaReport?: QaReport;
  reviewerReport: ReviewerReport;
  dossierFindings?: ReviewFinding[];
  isNeedsOwner?: boolean;
  handoffProse?: string;
}): string {
  const {
    outcome,
    route,
    candidate,
    blastRadiusCount,
    qaReport,
    reviewerReport,
    dossierFindings,
    isNeedsOwner,
    handoffProse,
  } = params;

  const lines = [
    `### Loop review: ${outcome} (route: ${route})`,
    "",
    `**Candidate**: \`${candidate}\``,
    `**Blast Radius**: ${blastRadiusCount} file(s) modified`,
    "",
  ];

  // Review Axes Summary
  if (reviewerReport.axes) {
    lines.push("#### ⚖️ Review Axes:");
    lines.push(
      `- **Standards**: \`${reviewerReport.axes.standards.status}\` ${reviewerReport.axes.standards.summary ? `(${reviewerReport.axes.standards.summary})` : ""}`,
    );
    lines.push(
      `- **Specification**: \`${reviewerReport.axes.spec.status}\` ${reviewerReport.axes.spec.summary ? `(${reviewerReport.axes.spec.summary})` : ""}`,
    );
    lines.push("");
  }

  // Black-box QA verification
  if (qaReport) {
    lines.push("#### 🧪 Black-box QA Verification:");
    if (qaReport.lines && qaReport.lines.length > 0) {
      for (const c of qaReport.lines) {
        const isPass = c.verdict === "PASS";
        const label = c.kind === "probe" ? "Runtime Probe" : "Criteria";
        const desc = c.text ? ` - ${c.text}` : "";
        lines.push(`- [${isPass ? "x" : " "}] **${c.id} (${label})**${desc}`);
      }
    } else {
      lines.push("- No QA checks reported.");
    }
    lines.push("");
  }

  // Code Review Findings
  lines.push("#### 🔍 Code Review Findings:");
  const activeFindings = dossierFindings ?? reviewerReport.findings;
  if (activeFindings && activeFindings.length > 0) {
    for (const f of activeFindings) {
      if (typeof f === "string") {
        lines.push(`- ${f}`);
      } else {
        const blockLabel = f.blocking ? "🚫 BLOCKING" : "ℹ️ SUGGESTION";
        const loc = f.location?.file ? ` (\`${f.location.file}${f.location.line ? `:${f.location.line}` : ""}\`)` : "";
        lines.push(`- **[${f.id}]** ${blockLabel} [${f.axis}/${f.classification}]: ${f.title}${loc}`);
        if (f.description && f.description !== f.title) {
          lines.push(`  *${f.description}*`);
        }
      }
    }
  } else {
    lines.push("- No blocking standards or specification findings.");
  }
  lines.push("");

  // Reviewer Decision & Rationale
  if (reviewerReport.reason) {
    lines.push("#### 🧐 Reviewer Decision & Rationale:");
    lines.push(reviewerReport.reason);
    lines.push("");
  }

  // Dispositions
  if (reviewerReport.dispositions && reviewerReport.dispositions.length > 0) {
    lines.push("#### 📋 Dispositions:");
    for (const d of reviewerReport.dispositions) {
      lines.push(`- **${d.line}** (${d.action}): ${d.reason || d.issue || d.file || ""}`);
    }
    lines.push("");
  }

  // Author Remediation & Rechecks
  if (reviewerReport.rechecks && reviewerReport.rechecks.length > 0) {
    lines.push("#### 🔄 Remediation & Independent Rechecks:");
    for (const r of reviewerReport.rechecks) {
      lines.push(
        `- **[${r.findingId}]**: Recheck status \`${r.recheck.recheckStatus}\` by ${r.recheck.recheckRole} on candidate \`${r.recheck.recheckCandidate}\`${r.recheck.notes ? ` (${r.recheck.notes})` : ""}`,
      );
    }
    lines.push("");
  }

  // Status conclusion
  if (isNeedsOwner) {
    if (handoffProse) lines.push(handoffProse);
    else lines.push("⛔ **Work item escalated to human owner (`ready-for-human`).**");
  } else if (outcome === "approved" || outcome === "merge") {
    lines.push("✅ **Candidate verified and approved.** Awaiting human merge approval (`merge=approve`).");
  } else {
    lines.push("⚠️ **Work item sent back.** Review feedback has been recorded for the next lap.");
  }

  return sanitizer.sanitizeMarkdown(lines.join("\n")).report;
}

/**
 * Formats a CI check failure comment.
 */
export function formatCiCheckComment(params: {
  route: string;
  candidate: string;
  failedChecks: Array<{ name: string; workflow?: string; state?: string; link?: string; description?: string }>;
  isMaxLapsExceeded: boolean;
}): string {
  const { route, candidate, failedChecks, isMaxLapsExceeded } = params;

  const lines = [
    `### Loop CI Check: Failed (route: ${route})`,
    "",
    `**Candidate**: \`${candidate}\``,
    "",
    "#### ❌ Remote CI Failures:",
    ...failedChecks.map(
      (c) =>
        `- [ ] **${c.workflow ? `${c.workflow} / ` : ""}${c.name}** (\`${c.state || "failure"}\`): ${c.link || c.description || "Failed"}`,
    ),
    "",
    isMaxLapsExceeded
      ? "⛔ **Maximum laps exceeded on CI failure.** Handing off to human owner (`ready-for-human`)."
      : "⚠️ **Work item sent back due to CI failure.** CI error feedback recorded for next lap auto-fix.",
  ];

  return sanitizer.sanitizeMarkdown(lines.join("\n")).report;
}
