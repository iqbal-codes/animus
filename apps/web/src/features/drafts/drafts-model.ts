import type {
  DraftAcceptanceCriterion,
  DraftPlan,
  DraftRecord,
  DraftStatus,
  Project,
} from "@animus/contracts/operator";

export type DraftTone = "neutral" | "info" | "warning" | "success" | "error";

/**
 * Operator-facing labels for the raw draft status the backend reports. The API
 * status is authoritative; this is presentation only and never invents a state
 * the backend cannot store.
 */
export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  needs_clarification: "Awaiting answers",
  needs_review: "Needs review",
  approved: "Approved for publication",
  rejected: "Rejected",
  changes_requested: "Changes requested",
};

export const DRAFT_STATUS_TONE: Record<DraftStatus, DraftTone> = {
  needs_clarification: "warning",
  needs_review: "info",
  approved: "success",
  rejected: "error",
  changes_requested: "warning",
};

export const TONE_CLASS: Record<DraftTone, string> = {
  neutral: "text-text-secondary",
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
  error: "text-error",
};

export const TONE_BADGE_CLASS: Record<DraftTone, string> = {
  neutral: "bg-[var(--surface)] text-text-secondary",
  info: "bg-[var(--info-bg)] text-info",
  warning: "bg-[var(--warning-bg)] text-warning",
  success: "bg-[var(--success-bg)] text-success",
  error: "bg-[var(--error-bg)] text-error",
};

/**
 * What the operator may do next, derived strictly from the latest revision and
 * decision. A clarification draft can only be answered; an approved revision
 * can be published (later lane) or superseded by a new revision.
 */
export interface DraftActions {
  canAnswer: boolean;
  canApprove: boolean;
  canReject: boolean;
  canRequestChanges: boolean;
  canRegenerate: boolean;
  reason: string;
}

/**
 * Instructions from a revise decision that still targets the current revision.
 * They are the operator's pending change request: if revision generation failed,
 * retrying must reuse them rather than silently dropping the request.
 */
export function pendingChangeInstructions(record: DraftRecord): string {
  const decision = record.latest_decision;
  if (decision?.decision !== "revise") return "";
  if (decision.revision_id !== record.latest_revision.id) return "";
  return decision.instructions ?? "";
}

export function hasPendingChangeRequest(record: DraftRecord): boolean {
  return record.status === "changes_requested" && pendingChangeInstructions(record).length > 0;
}

export function draftActionsOf(record: DraftRecord): DraftActions {
  const plan = record.latest_revision.plan;
  if (plan.kind === "clarification") {
    return {
      canAnswer: true,
      canApprove: false,
      canReject: false,
      canRequestChanges: false,
      canRegenerate: false,
      reason: "Answer every question to produce a reviewable revision.",
    };
  }
  if (record.status === "approved") {
    return {
      canAnswer: false,
      canApprove: false,
      canReject: false,
      canRequestChanges: false,
      canRegenerate: false,
      reason:
        "This revision is approved. Revise it to change scope; approval binds to this revision.",
    };
  }
  const canRegenerate = hasPendingChangeRequest(record);
  return {
    canAnswer: false,
    canApprove: true,
    canReject: true,
    canRequestChanges: !canRegenerate,
    canRegenerate,
    reason: canRegenerate
      ? "The change request is recorded but no revised scope exists yet. Generate the next revision from the preserved instructions."
      : "Decisions bind to the revision shown. A new revision invalidates this decision.",
  };
}

export interface DraftSummaryLine {
  issueNumber: number;
  repoName: string;
  title: string;
  statusLabel: string;
  kind: string;
  revisionNumber: number;
  tone: DraftTone;
}

export function summarizeDraft(record: DraftRecord): DraftSummaryLine {
  return {
    issueNumber: record.source_provenance.issue_number,
    repoName: record.source_provenance.repo_name,
    title: record.source.title,
    statusLabel: DRAFT_STATUS_LABEL[record.status],
    kind: record.latest_revision.kind,
    revisionNumber: record.latest_revision.revision_number,
    tone: DRAFT_STATUS_TONE[record.status],
  };
}

export interface DraftPlanContent {
  kind: DraftPlan["kind"];
  title: string | null;
  scope: string | null;
  outcome: string | null;
  invariants: string[];
  acceptanceCriteria: DraftAcceptanceCriterion[];
  verificationRequirements: string[];
  boundary: Array<{ label: string; value: string }>;
  children: Array<{
    id: string;
    title: string;
    dependsOn: string[];
    covers: string[];
  }>;
}

/**
 * Projects the persisted plan into the read-only content the operator reviews.
 * Clarification plans carry no scope yet, so those fields are null rather than
 * fabricated.
 */
export function planContentOf(record: DraftRecord): DraftPlanContent {
  const plan = record.latest_revision.plan;
  if (plan.kind === "clarification") {
    return {
      kind: "clarification",
      title: null,
      scope: null,
      outcome: null,
      invariants: [],
      acceptanceCriteria: [],
      verificationRequirements: [],
      boundary: [],
      children: [],
    };
  }
  const childIds = plan.kind === "spec" ? plan.children.map((child) => child.id) : [];
  return {
    kind: plan.kind,
    title: plan.title,
    scope: plan.scope,
    outcome: plan.outcome,
    invariants: plan.invariants,
    acceptanceCriteria: plan.acceptance_criteria,
    verificationRequirements: plan.verification_requirements,
    boundary: [
      { label: "Touchpoints", value: plan.boundary.touchpoints },
      { label: "Known callers", value: plan.boundary.known_callers },
      { label: "Test seam", value: plan.boundary.test_seam },
      { label: "Exclusions", value: plan.boundary.exclusions },
    ],
    children:
      plan.kind === "spec"
        ? plan.children.map((child) => ({
            id: child.id,
            title: child.title,
            dependsOn: child.depends_on_indices.map((index) => childIds[index] ?? `#${index + 1}`),
            covers: child.covers_parent_ac_ids,
          }))
        : [],
  };
}

export interface DraftAnswerDraft {
  question_id: string;
  answer: string;
}

export function emptyAnswers(record: DraftRecord): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const question of record.latest_revision.questions) entries[question.id] = "";
  return entries;
}

/**
 * Builds the answer payload only when every question has non-empty text. Returns
 * null so callers can keep the submit control disabled with an honest reason
 * instead of posting an invalid submission.
 */
export function buildAnswerSubmission(
  record: DraftRecord,
  answers: Record<string, string>,
): DraftAnswerDraft[] | null {
  const questions = record.latest_revision.questions;
  if (questions.length === 0) return null;
  const submission: DraftAnswerDraft[] = [];
  for (const question of questions) {
    const value = (answers[question.id] ?? "").trim();
    if (value.length === 0) return null;
    submission.push({ question_id: question.id, answer: value });
  }
  return submission;
}

export function selectActiveProjects(projects: Project[]): Project[] {
  return projects.filter((project) => project.status === "active");
}
