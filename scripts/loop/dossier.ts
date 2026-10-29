import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LapAttemptRecord {
  lapIndex: number;
  runId: string;
  timestamp: string;
  status: "waiting_approval" | "sent_back" | "failed" | "needs_owner";
  candidateHead?: string;
  changedFiles: string[];
  failedStage?: "builder" | "ordinary_checks" | "qa" | "reviewer";
  errorExcerpt?: string;
  reviewFindings: string[];
  qaFailures: string[];
}

export interface IssueDossier {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  branch: string;
  prUrl?: string;
  attempts: LapAttemptRecord[];
  reflectedAt?: string;
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
