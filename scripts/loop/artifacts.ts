import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  builderReportSchema,
  qaReportSchema,
  reviewerReportSchema,
  type BuilderReport,
  type QaReport,
  type ReviewerReport,
  type ReviewFinding,
} from "./report-schema";
import type { LoopRole } from "./types";

export async function setupArtifactDirectories(runDirectory: string) {
  const artifactsDir = join(runDirectory, "artifacts");
  const handoffDir = join(artifactsDir, "handoff");
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(handoffDir, { recursive: true });
  return { artifactsDir, handoffDir };
}

export function parseAgentReport(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const blocks = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
    if (blocks.length !== 1) {
      throw new Error(
        "Agent report must contain one JSON object, either plain or in one code fence",
      );
    }
    try {
      return JSON.parse(blocks[0]![1]!);
    } catch {
      throw new Error("Agent report contains invalid JSON in its code fence");
    }
  }
}

export function extractReportObject(stdout: string): any {
  let message:
    | { role?: string; stopReason?: string; content?: { type: string; text?: string }[] }
    | undefined;
  let settled = false;
  let textDirect: string | null = null;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        message = event.message;
        if (Array.isArray(event.message?.content)) {
          textDirect = event.message.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("");
        }
      }
      if (event.type === "agent_start") settled = false;
      if (event.type === "agent_settled") settled = event.aborted === false;
      if (event.result && typeof event.result === "string") textDirect = event.result;
      if (event.content && typeof event.content === "string") textDirect = event.content;
    } catch {}
  }

  if (settled && message && message.stopReason === "stop" && Array.isArray(message.content)) {
    const textContent = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return parseAgentReport(textContent);
  }

  // If output was from Claude Code, Codex, OpenCode, or plain JSON/fenced markdown:
  try {
    const directValue = parseAgentReport(textDirect ?? stdout);
    if (directValue && typeof directValue === "object") {
      return directValue;
    }
  } catch {}

  if (!settled || !message || message.stopReason !== "stop" || !Array.isArray(message.content)) {
    throw new Error("Pi did not settle with a final assistant response");
  }

  return parseAgentReport(stdout);
}

export function validateBuilderReport(
  raw: unknown,
  expectedCandidate: string,
): { report: BuilderReport; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") {
    throw new Error("Builder report is missing or not a JSON object");
  }

  const rawCandidate = (raw as Record<string, unknown>).candidate;
  if (!rawCandidate || typeof rawCandidate !== "string") {
    throw new Error(
      `Missing required builder candidate identity; expected candidate '${expectedCandidate}'`,
    );
  }
  if (rawCandidate !== expectedCandidate) {
    throw new Error(
      `Builder reported candidate '${rawCandidate}' does not match expected candidate '${expectedCandidate}'`,
    );
  }

  const parsed = builderReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid builder report schema: ${parsed.error.message}`);
  }

  const report = parsed.data;
  const checks = report.checks ?? [];
  if (report.verdict === "pass") {
    if (checks.length === 0) {
      problems.push("Builder reported verdict 'pass' with empty verification checks");
    }
    const failedChecks = checks.filter((c) => c.result !== "pass");
    if (failedChecks.length > 0) {
      problems.push(
        `Builder reported verdict 'pass' but has failed checks: ${failedChecks.map((c) => c.criterion).join(", ")}`,
      );
    }
  }

  return { report, problems };
}

export function validateQaReport(
  raw: unknown,
  expectedTestedHead: string,
  artifactsDir: string,
  options?: { requiredAcIds?: string[] },
): { report: QaReport; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") {
    throw new Error("QA report is missing or not a JSON object");
  }

  const rawHead = (raw as Record<string, unknown>).head ?? (raw as Record<string, unknown>).candidate;
  if (!rawHead || typeof rawHead !== "string") {
    throw new Error(
      `Missing required QA tested head identity; expected head '${expectedTestedHead}'`,
    );
  }
  if (rawHead !== expectedTestedHead) {
    throw new Error(
      `QA reported tested head '${rawHead}' does not match expected tested identity '${expectedTestedHead}'`,
    );
  }

  const rawOverall =
    (raw as Record<string, unknown>).overall ??
    ((raw as Record<string, unknown>).verdict
      ? String((raw as Record<string, unknown>).verdict).toUpperCase()
      : undefined);

  let rawLines = (raw as Record<string, unknown>).lines;
  if (!Array.isArray(rawLines) && Array.isArray((raw as Record<string, unknown>).checks)) {
    rawLines = ((raw as Record<string, unknown>).checks as any[]).map((c: any) => ({
      id: c.criterion || "AC1",
      verdict: String(c.result || "PASS").toUpperCase(),
      text: c.criterion || "",
      evidence: c.evidence ? [c.evidence] : [],
    }));
  }

  const normalizedRaw = {
    ...raw,
    head: rawHead,
    overall: rawOverall,
    lines: rawLines ?? [],
  };

  const parsed = qaReportSchema.safeParse(normalizedRaw);
  if (!parsed.success) {
    throw new Error(`Invalid QA report schema: ${parsed.error.message}`);
  }

  const report = parsed.data;

  // Check duplicate lines
  const seenIds = new Set<string>();
  for (const line of report.lines) {
    if (seenIds.has(line.id)) {
      problems.push(`QA report contains duplicate line/criterion ID: '${line.id}'`);
    }
    seenIds.add(line.id);
  }

  // Reject empty PASS
  if (
    report.overall === "PASS" &&
    report.lines.length === 0 &&
    ((raw as Record<string, unknown>).overall !== undefined ||
      (raw as Record<string, unknown>).lines !== undefined)
  ) {
    problems.push("QA reported overall PASS but provided zero verification criteria or probe lines");
  }

  // Reject missing required AC coverage
  if (options?.requiredAcIds && options.requiredAcIds.length > 0) {
    const presentIds = new Set(report.lines.map((l) => l.id));
    for (const requiredId of options.requiredAcIds) {
      if (!presentIds.has(requiredId)) {
        problems.push(`QA report missing required acceptance criterion: '${requiredId}'`);
      }
    }
  }

  // Reject PASS with incomplete criteria
  if (report.overall === "PASS") {
    const nonPassLines = report.lines.filter((l) => l.verdict !== "PASS");
    if (nonPassLines.length > 0) {
      problems.push(
        `QA reported overall PASS but has non-passing lines: ${nonPassLines
          .map((l) => `${l.id} (${l.verdict})`)
          .join(", ")}`,
      );
    }
  }

  // Validate evidence citations if artifactsDir is provided
  if (artifactsDir) {
    const citationCheck = validateEvidenceCitations(report, artifactsDir);
    if (!citationCheck.ok) {
      problems.push(...citationCheck.problems);
    }
  }

  return { report, problems };
}

export function validateReviewerReport(
  raw: unknown,
  expectedCandidate: string,
): { report: ReviewerReport; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") {
    throw new Error("Reviewer report is missing or not a JSON object");
  }

  const rawSha = (raw as Record<string, unknown>).sha ?? (raw as Record<string, unknown>).candidate;
  if (!rawSha || typeof rawSha !== "string") {
    throw new Error(
      `Missing required reviewer candidate identity; expected sha '${expectedCandidate}'`,
    );
  }
  if (rawSha !== expectedCandidate) {
    throw new Error(
      `Reviewer reported candidate sha '${rawSha}' does not match expected candidate '${expectedCandidate}'`,
    );
  }

  const rawOutcome =
    (raw as Record<string, unknown>).outcome ??
    ((raw as Record<string, unknown>).verdict === "pass"
      ? "approved"
      : (raw as Record<string, unknown>).verdict === "fail"
      ? "sent-back"
      : undefined);

  const normalizedRaw = {
    ...raw,
    sha: rawSha,
    outcome: rawOutcome,
  };

  const parsed = reviewerReportSchema.safeParse(normalizedRaw);
  if (!parsed.success) {
    throw new Error(`Invalid reviewer report schema: ${parsed.error.message}`);
  }

  const report = parsed.data;

  // Check for approved + blocks contradiction
  const isApprovedOutcome = report.outcome === "approved" || report.outcome === "merge";
  const blockingFindings = report.findings.filter((f) => {
    if (typeof f === "object" && f !== null) {
      return f.blocking === true;
    }
    return typeof f === "string" && f.trim().length > 0;
  });

  const blockingDispositions = report.dispositions.filter((d) => d.action === "blocks");

  if (isApprovedOutcome) {
    if (blockingFindings.length > 0 || blockingDispositions.length > 0) {
      problems.push(
        `Reviewer outcome '${report.outcome}' is contradictory with ${blockingFindings.length} blocking finding(s) and ${blockingDispositions.length} blocking disposition(s)`,
      );
    }

    if (report.axes) {
      if (report.axes.standards?.status && report.axes.standards.status !== "pass") {
        problems.push(
          `Reviewer outcome '${report.outcome}' is contradictory with standards axis status '${report.axes.standards.status}'`,
        );
      }
      if (report.axes.spec?.status && report.axes.spec.status !== "pass") {
        problems.push(
          `Reviewer outcome '${report.outcome}' is contradictory with spec axis status '${report.axes.spec.status}'`,
        );
      }
    }
  }

  // Validate rechecks
  for (const rc of report.rechecks) {
    if (rc.recheck.recheckCandidate !== expectedCandidate) {
      problems.push(
        `Recheck for finding '${rc.findingId}' cited stale candidate '${rc.recheck.recheckCandidate}' does not match expected candidate '${expectedCandidate}'`,
      );
    }
    if (
      rc.recheck.recheckStatus === "resolved" &&
      (!rc.recheck.recheckEvidence || !rc.recheck.recheckEvidence.trim())
    ) {
      problems.push(`Recheck for finding '${rc.findingId}' is missing verification evidence`);
    }
  }

  return { report, problems };
}

export function validateEvidenceCitations(
  qaReport: any,
  artifactsDir: string,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!artifactsDir) {
    return { ok: true, problems: [] };
  }
  if (!existsSync(artifactsDir)) {
    return { ok: false, problems: [`Artifacts directory does not exist: ${artifactsDir}`] };
  }

  let realArtifactsDir: string;
  try {
    realArtifactsDir = realpathSync(artifactsDir);
  } catch {
    realArtifactsDir = resolve(artifactsDir);
  }

  if (Array.isArray(qaReport?.lines)) {
    for (const line of qaReport.lines) {
      if (Array.isArray(line.evidence)) {
        for (const evPath of line.evidence) {
          if (typeof evPath !== "string" || !evPath.trim()) {
            problems.push(`Line ${line.id} cited empty evidence locator`);
            continue;
          }

          const trimmed = evPath.trim();
          // Reject path traversal tokens
          if (trimmed.includes("..")) {
            problems.push(`Line ${line.id} cited escaping evidence path: ${trimmed}`);
            continue;
          }

          const fullPath = isAbsolute(trimmed)
            ? resolve(trimmed)
            : resolve(artifactsDir, trimmed);

          if (!existsSync(fullPath)) {
            problems.push(`Line ${line.id} cited missing evidence: ${trimmed}`);
            continue;
          }

          // Check containment within artifactsDir
          let realTarget: string;
          try {
            realTarget = realpathSync(fullPath);
          } catch {
            problems.push(`Line ${line.id} cited unresolvable evidence path: ${trimmed}`);
            continue;
          }

          const rel = relative(realArtifactsDir, realTarget);
          if (rel.startsWith("..") || isAbsolute(rel)) {
            problems.push(
              `Line ${line.id} cited evidence escaping artifacts root: ${trimmed}`,
            );
            continue;
          }

          // Check that target is a regular file, not a directory
          try {
            const stat = statSync(realTarget);
            if (!stat.isFile()) {
              problems.push(
                `Line ${line.id} cited non-file (directory or special) evidence: ${trimmed}`,
              );
            }
          } catch {
            problems.push(`Line ${line.id} cited unreadable evidence: ${trimmed}`);
          }
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

export function extractReport(
  stdout: string,
  candidate: string,
  role?: LoopRole,
  artifactsDir?: string,
  options?: { requiredAcIds?: string[] },
): any {
  const raw = extractReportObject(stdout);
  if (!raw || typeof raw !== "object") {
    throw new Error("Missing, malformed or stale candidate-bound checks/review verdict");
  }

  // Canonical Animus check-app report normalization
  if (role === "qa" || (role === undefined && (raw.overall !== undefined || Array.isArray(raw.lines)))) {
    const { report, problems } = validateQaReport(raw, candidate, artifactsDir || "", options);
    const isPass = report.overall === "PASS" && problems.length === 0;
    return {
      ...report,
      candidate: report.head,
      verdict: isPass ? "pass" : "fail",
      checks: report.lines.map((l) => ({
        criterion: l.id,
        text: l.text || "",
        kind: l.kind || "criterion",
        result: l.verdict.toLowerCase(),
        evidence: Array.isArray(l.evidence) ? l.evidence.join(", ") : String(l.text || ""),
      })),
      findings: report.lines
        .filter((l) => l.verdict !== "PASS")
        .map((l) => `${l.id}: ${l.text}`),
      passed: isPass,
      problems,
    };
  }

  // Canonical Animus review report normalization
  if (
    role === "reviewer" ||
    (role === undefined &&
      (raw.axes !== undefined ||
        raw.sha !== undefined ||
        (raw.outcome !== undefined &&
          ["merge", "sent-back", "needs-owner", "approved", "nothing"].includes(
            String(raw.outcome).toLowerCase(),
          ))))
  ) {
    const { report, problems } = validateReviewerReport(raw, candidate);
    const isPass =
      ["merge", "approved"].includes(String(report.outcome).toLowerCase()) &&
      problems.length === 0;
    return {
      ...report,
      candidate: report.sha,
      verdict: isPass ? "pass" : "fail",
      checks: [
        {
          criterion: "review-outcome",
          result: isPass ? "pass" : "fail",
          evidence: report.reason || report.outcome,
        },
      ],
      findings: report.findings,
      dispositions: report.dispositions,
      rechecks: report.rechecks,
      passed: isPass,
      problems,
    };
  }

  // Canonical Animus builder report normalization
  if (
    role === "builder" ||
    (role === undefined &&
      (Array.isArray(raw.invariants) ||
        Array.isArray(raw.changedSeams) ||
        (raw.candidate !== undefined && Array.isArray(raw.checks))))
  ) {
    const { report, problems } = validateBuilderReport(raw, candidate);
    const isPass = report.verdict === "pass" && problems.length === 0;
    return {
      ...report,
      verdict: report.verdict,
      candidate: report.candidate,
      passed: isPass,
      problems,
    };
  }

  // Generic / Mock report format
  if (
    raw.candidate !== candidate ||
    !["pass", "fail", "blocked"].includes(raw.verdict) ||
    !Array.isArray(raw.findings) ||
    !Array.isArray(raw.checks)
  ) {
    throw new Error("Missing, malformed or stale candidate-bound checks/review verdict");
  }

  // Reject check without result (never default missing result to pass)
  const hasInvalidCheck = raw.checks.some((c: any) => !c || typeof c !== "object" || !c.result);
  if (hasInvalidCheck) {
    throw new Error("Missing result on check in report");
  }

  return {
    ...raw,
    passed:
      raw.verdict === "pass" &&
      raw.checks.every((c: { result: string }) => c.result === "pass"),
  };
}

export interface HostReadinessEvaluation {
  ready: boolean;
  verdict: "waiting_approval" | "sent_back" | "needs_owner" | "failed";
  reasons: string[];
  blockingFindings: string[];
}

export function evaluateHostReadiness(params: {
  candidateStable: boolean;
  ordinaryChecksPassed: boolean;
  qaReport?: {
    passed: boolean;
    overall: string;
    problems?: string[];
    lines?: Array<{ id: string; verdict: string; evidence?: string[] }>;
  };
  reviewerReport?: {
    passed: boolean;
    outcome: string;
    sha?: string;
    axes?: {
      standards?: { status: string; summary?: string };
      spec?: { status: string; summary?: string };
    };
    findings?: Array<{ id?: string; blocking?: boolean; title?: string; status?: string } | string>;
    dispositions?: Array<{ action: string; line: string; reason?: string }>;
    rechecks?: Array<{
      findingId: string;
      recheck: {
        recheckStatus: string;
        recheckEvidence?: string;
        recheckCandidate: string;
        recheckRole?: string;
      };
    }>;
    problems?: string[];
  };
  ciPassed: boolean;
  lap: number;
  maxLaps: number;
  expectedCandidate?: string;
  outstandingFindings?: Array<ReviewFinding | string>;
  requireAxes?: boolean;
}): HostReadinessEvaluation {
  const reasons: string[] = [];
  const blockingFindings: string[] = [];

  if (!params.candidateStable) {
    reasons.push("Candidate HEAD mutated or diverged during verification");
  }

  if (!params.ordinaryChecksPassed) {
    reasons.push("Ordinary project checks failed or did not run cleanly");
  }

  if (!params.qaReport) {
    reasons.push("Missing QA verification report");
  } else {
    const qaPassed = Boolean(
      params.qaReport.passed &&
        (params.qaReport.overall === undefined || params.qaReport.overall === "PASS"),
    );
    if (!qaPassed) {
      reasons.push(`QA verification failed (overall: ${params.qaReport.overall})`);
    }
    if (params.qaReport.problems && params.qaReport.problems.length > 0) {
      reasons.push(...params.qaReport.problems);
    }
    if (Array.isArray(params.qaReport.lines)) {
      for (const line of params.qaReport.lines) {
        if (line.verdict === "PASS" && (!line.evidence || line.evidence.length === 0)) {
          reasons.push(`QA line '${line.id}' has verdict PASS but missing supporting evidence`);
        }
      }
    }
  }

  if (!params.ciPassed) {
    reasons.push("Remote CI check assessment failed");
  }

  if (!params.reviewerReport) {
    reasons.push("Missing code reviewer report");
  } else {
    if (params.reviewerReport.problems && params.reviewerReport.problems.length > 0) {
      reasons.push(...params.reviewerReport.problems);
    }
    const isApproved = Boolean(
      params.reviewerReport.outcome === "approved" ||
        params.reviewerReport.outcome === "merge" ||
        (params.reviewerReport.outcome === undefined && params.reviewerReport.passed),
    );
    if (!isApproved) {
      reasons.push(`Reviewer outcome was not approved: '${params.reviewerReport.outcome}'`);
    }

    if (
      params.expectedCandidate &&
      params.reviewerReport.sha &&
      params.reviewerReport.sha !== params.expectedCandidate
    ) {
      reasons.push(
        `Reviewer candidate sha '${params.reviewerReport.sha}' does not match expected candidate '${params.expectedCandidate}'`,
      );
    }

    // Validated axes evaluation
    if (params.reviewerReport.axes) {
      if (
        params.reviewerReport.axes.standards?.status &&
        params.reviewerReport.axes.standards.status !== "pass"
      ) {
        reasons.push(
          `Reviewer standards axis did not pass: status '${params.reviewerReport.axes.standards.status}'`,
        );
      }
      if (
        params.reviewerReport.axes.spec?.status &&
        params.reviewerReport.axes.spec.status !== "pass"
      ) {
        reasons.push(
          `Reviewer spec axis did not pass: status '${params.reviewerReport.axes.spec.status}'`,
        );
      }
    } else if (params.requireAxes) {
      reasons.push("Reviewer report missing required evaluation axes (standards, spec)");
    }

    // Tally blocking findings from reviewer report
    if (Array.isArray(params.reviewerReport.findings)) {
      for (const f of params.reviewerReport.findings) {
        if (typeof f === "object" && f !== null && f.blocking) {
          blockingFindings.push(f.title || "blocking finding");
        }
      }
    }
    if (Array.isArray(params.reviewerReport.dispositions)) {
      for (const d of params.reviewerReport.dispositions) {
        if (d.action === "blocks") {
          blockingFindings.push(`${d.line}: ${d.reason || "blocking disposition"}`);
        }
      }
    }

    // Recheck fresh candidate validity
    if (Array.isArray(params.reviewerReport.rechecks)) {
      for (const rc of params.reviewerReport.rechecks) {
        if (params.expectedCandidate && rc.recheck.recheckCandidate !== params.expectedCandidate) {
          reasons.push(
            `Recheck for finding '${rc.findingId}' cited stale candidate '${rc.recheck.recheckCandidate}'; expected '${params.expectedCandidate}'`,
          );
        }
        if (
          rc.recheck.recheckStatus === "resolved" &&
          (!rc.recheck.recheckEvidence || !rc.recheck.recheckEvidence.trim())
        ) {
          reasons.push(`Recheck for finding '${rc.findingId}' is missing verification evidence`);
        }
      }
    }
  }

  // Unresolved persisted findings from dossier
  if (Array.isArray(params.outstandingFindings)) {
    for (const f of params.outstandingFindings) {
      if (typeof f === "string") {
        blockingFindings.push(f);
        reasons.push(`Unresolved persisted finding: ${f}`);
      } else if (typeof f === "object" && f !== null) {
        if (f.status === "open") {
          blockingFindings.push(`[${f.id}] ${f.title}`);
          reasons.push(`Unresolved persisted finding: [${f.id}] ${f.title}`);
        } else if (
          f.blocking &&
          f.status !== "rechecked_resolved" &&
          f.status !== "accepted_risk"
        ) {
          blockingFindings.push(`[${f.id}] ${f.title}`);
          reasons.push(`Unresolved blocking finding: [${f.id}] ${f.title}`);
        }
      }
    }
  }

  // Approved + blocks contradiction check
  const isApproved = Boolean(
    params.reviewerReport?.outcome === "approved" ||
      params.reviewerReport?.outcome === "merge" ||
      (params.reviewerReport?.outcome === undefined && params.reviewerReport?.passed),
  );
  if (isApproved && blockingFindings.length > 0) {
    reasons.push(
      `Contradictory state: approved reviewer outcome with ${blockingFindings.length} blocking finding(s)`,
    );
  }

  const isExplicitNeedsOwner = params.reviewerReport?.outcome === "needs-owner";
  const isMaxLapsExceeded = params.lap >= params.maxLaps;
  const ready = reasons.length === 0 && blockingFindings.length === 0;

  if (ready) {
    return {
      ready: true,
      verdict: "waiting_approval",
      reasons: [],
      blockingFindings: [],
    };
  }

  const verdict = isExplicitNeedsOwner || isMaxLapsExceeded ? "needs_owner" : "sent_back";
  return {
    ready: false,
    verdict,
    reasons,
    blockingFindings,
  };
}
