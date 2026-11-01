import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateEvidenceCitations } from "./artifacts";
import type { RemediationRecheckRecord, ReviewDisposition, ReviewFinding } from "./report-schema";

export interface LapAttemptRecord {
  lapIndex: number;
  runId: string;
  timestamp: string;
  status: "waiting_approval" | "sent_back" | "failed" | "needs_owner";
  candidateHead?: string;
  changedFiles: string[];
  failedStage?: "builder" | "ordinary_checks" | "qa" | "reviewer" | "ci";
  errorExcerpt?: string;
  reviewFindings: string[];
  qaFailures: string[];
  structuredFindings?: ReviewFinding[];
  dispositions?: ReviewDisposition[];
  rechecks?: RemediationRecheckRecord[];
}

export interface IssueDossier {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  branch: string;
  prUrl?: string;
  attempts: LapAttemptRecord[];
  reflectedAt?: string;
  findings?: ReviewFinding[];
  nextFindingIndex?: number;
}

export function allocateFindingId(dossier: IssueDossier): string {
  const largestId = Math.max(
    0,
    ...(dossier.findings ?? []).map((f) => {
      const match = /^fnd-(\d+)$/.exec(f.id);
      return match ? Number(match[1]) : 0;
    }),
  );
  const nextIdx = Math.max(dossier.nextFindingIndex ?? 1, largestId + 1);
  dossier.nextFindingIndex = nextIdx + 1;
  return `fnd-${nextIdx}`;
}

export function syncDossierFindings(
  dossier: IssueDossier,
  lapFindings: Array<ReviewFinding | string>,
  lapDispositions: ReviewDisposition[] = [],
  lapRechecks: RemediationRecheckRecord[] = [],
  lapIndex = 0,
  recheckContext?: { candidate: string; artifactsDir: string },
): ReviewFinding[] {
  const currentFindings: ReviewFinding[] = [...(dossier.findings ?? [])];

  // 1. Process rechecks against existing findings
  for (const rc of lapRechecks) {
    const existing = currentFindings.find((f) => f.id === rc.findingId);
    const evidence = rc.recheck.recheckEvidence;
    const verified =
      recheckContext &&
      rc.recheck.recheckCandidate === recheckContext.candidate &&
      rc.recheck.recheckRole === "reviewer" &&
      typeof evidence === "string" &&
      evidence.trim().length > 0 &&
      validateEvidenceCitations(
        { lines: [{ id: rc.findingId, evidence: [evidence] }] },
        recheckContext.artifactsDir,
      ).ok;
    if (!existing || !verified) continue;
    if (rc.recheck.recheckStatus === "resolved") {
      existing.status = "rechecked_resolved";
      existing.lapResolved = lapIndex;
    } else {
      existing.status = "open";
      existing.lapResolved = undefined;
    }
  }

  // QA-line dispositions are not remediation rechecks and cannot close code findings.
  void lapDispositions;

  // 3. Add new findings
  for (const rawFinding of lapFindings) {
    if (typeof rawFinding === "string") {
      const trimmed = rawFinding.trim();
      if (!trimmed) continue;
      // Check if already recorded
      const alreadyPresent = currentFindings.some(
        (f) => f.title === trimmed || f.description === trimmed,
      );
      if (!alreadyPresent) {
        const id = allocateFindingId(dossier);
        currentFindings.push({
          id,
          axis: "standards",
          classification: "defect",
          blocking: true,
          title: trimmed,
          description: trimmed,
          status: "open",
          lapIntroduced: lapIndex,
        });
      }
    } else {
      const alreadyPresent = currentFindings.some(
        (f) => f.id === rawFinding.id || (rawFinding.title && f.title === rawFinding.title),
      );
      if (!alreadyPresent) {
        const id = allocateFindingId(dossier);
        currentFindings.push({
          ...rawFinding,
          id,
          status: "open",
          lapIntroduced: lapIndex,
          lapResolved: undefined,
        });
      }
    }
  }

  dossier.findings = currentFindings;
  return currentFindings;
}

export function getDossierPath(stateRoot: string, issueNumber: number): string {
  return join(stateRoot, "dossiers", `issue-${issueNumber}.json`);
}

export function loadIssueDossier(stateRoot: string, issueNumber: number): IssueDossier | null {
  const filePath = getDossierPath(stateRoot, issueNumber);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as IssueDossier;
  } catch {
    return null;
  }
}

export function saveIssueDossier(stateRoot: string, dossier: IssueDossier): void {
  const filePath = getDossierPath(stateRoot, dossier.issueNumber);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(dossier, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

export function recordLapAttempt(
  stateRoot: string,
  meta: {
    issueNumber: number;
    issueTitle: string;
    issueUrl: string;
    branch: string;
    prUrl?: string;
  },
  attempt: Omit<LapAttemptRecord, "lapIndex">,
): IssueDossier {
  const existing = loadIssueDossier(stateRoot, meta.issueNumber);
  const attempts = existing?.attempts ?? [];
  const nextRecord: LapAttemptRecord = {
    ...attempt,
    lapIndex: attempts.length,
  };

  const dossier: IssueDossier = {
    issueNumber: meta.issueNumber,
    issueTitle: meta.issueTitle,
    issueUrl: meta.issueUrl,
    branch: meta.branch,
    prUrl: meta.prUrl ?? existing?.prUrl,
    attempts: [...attempts, nextRecord],
    reflectedAt: existing?.reflectedAt,
    findings: attempt.structuredFindings ?? existing?.findings,
    nextFindingIndex: Math.max(
      existing?.nextFindingIndex ?? 1,
      ...(attempt.structuredFindings ?? existing?.findings ?? []).map((f) => {
        const match = /^fnd-(\d+)$/.exec(f.id);
        return match ? Number(match[1]) + 1 : 1;
      }),
    ),
  };

  saveIssueDossier(stateRoot, dossier);
  return dossier;
}

/**
 * Determines whether post-issue terminal reflection should run.
 * Reflection triggers ONLY at terminal state:
 * 1. Approved (`waiting_approval`) after experiencing friction (previous failed/sent_back laps,
 *    or recorded review findings / QA notices).
 * 2. Exhausted / Escalated (`needs_owner` or consecutive failures >= maxRejections).
 */
export function shouldTriggerReflection(
  dossier: IssueDossier,
  options: { maxRejections?: number } = {},
): boolean {
  if (dossier.reflectedAt) return false;
  if (dossier.attempts.length === 0) return false;

  const maxRejections = options.maxRejections ?? 2;
  const latest = dossier.attempts[dossier.attempts.length - 1]!;

  // Case A: Approved after friction (Lap 0 failed/sent_back -> Lap N approved)
  if (latest.status === "waiting_approval") {
    const hadPriorFailure = dossier.attempts
      .slice(0, -1)
      .some((a) => a.status === "sent_back" || a.status === "failed");
    return hadPriorFailure;
  }

  // Case B: Escalated to owner or exhausted rejection budget
  if (latest.status === "needs_owner") {
    return true;
  }

  const failureCount = dossier.attempts.filter(
    (a) => a.status === "sent_back" || a.status === "failed",
  ).length;
  if (failureCount >= maxRejections) {
    return true;
  }

  return false;
}
