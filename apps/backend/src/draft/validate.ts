import { createHash } from "node:crypto";
import {
  draftAnswerSchema,
  type DraftAnswerInput,
  type DraftPlan,
  type DraftQuestion,
} from "@animus/contracts/operator";
import { validateCanonicalIssueBody } from "@animus/contracts/ticket";
import { DraftError, invalidPlan } from "./errors";

function sectionText(markdown: string, heading: string): string {
  const pattern = new RegExp(`##\\s+${heading}[\\r\\n]+([\\s\\S]*?)(?=(?:\\r?\\n##\\s+|$))`, "i");
  const match = markdown.match(pattern);
  if (!match || !match[1]) return "";
  return match[1].trim();
}

function validateDraftBody(body: string, options: { requireVerification: boolean }): void {
  const canonical = validateCanonicalIssueBody(body);
  if (!canonical.valid) {
    invalidPlan(`Draft body is not canonical: ${canonical.errors.join("; ")}`);
  }
  if (!options.requireVerification) return;
  const verification = sectionText(body, "Verification");
  if (verification.length === 0) {
    invalidPlan("Draft body is missing a non-empty '## Verification' section");
  }
}

function assertCriterionIdsPresent(
  body: string,
  criteria: Array<{ id: string }>,
  label: string,
): void {
  for (const criterion of criteria) {
    const escaped = criterion.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![0-9])`);
    if (!pattern.test(body)) {
      invalidPlan(`${label} body does not expose acceptance criterion '${criterion.id}'`);
    }
  }
}

export function validateDraftPlan(plan: DraftPlan): void {
  switch (plan.kind) {
    case "clarification":
      if (plan.questions.length === 0) invalidPlan("Clarification draft must contain questions");
      return;
    case "standalone":
      validateDraftBody(plan.body, { requireVerification: !plan.prepared });
      assertCriterionIdsPresent(plan.body, plan.acceptance_criteria, "Standalone draft");
      return;
    case "spec": {
      validateDraftBody(plan.body, { requireVerification: true });
      assertCriterionIdsPresent(plan.body, plan.acceptance_criteria, "Parent spec draft");
      for (const child of plan.children) {
        validateDraftBody(child.body, { requireVerification: true });
        assertCriterionIdsPresent(child.body, child.acceptance_criteria, `Child '${child.id}'`);
      }
      return;
    }
  }
}

export function assertApprovablePlan(plan: DraftPlan): void {
  if (plan.kind === "clarification") {
    throw new DraftError(
      "draft_not_approvable",
      "A clarification draft cannot be approved until its questions are answered",
    );
  }
}

export function computePlanHash(plan: DraftPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function resolveAnswers(
  questions: DraftQuestion[],
  answers: DraftAnswerInput[],
): ReturnType<typeof draftAnswerSchema.parse>[] {
  if (questions.length === 0) {
    if (answers.length > 0) {
      throw new DraftError(
        "draft_answer_mismatch",
        "Answers were supplied but the latest draft revision has no questions",
      );
    }
    return [];
  }

  if (answers.length === 0) {
    throw new DraftError(
      "draft_answers_required",
      "Answer every question on the latest draft revision before refining it",
    );
  }

  const byQuestion = new Map<string, DraftAnswerInput>();
  for (const answer of answers) {
    if (byQuestion.has(answer.question_id)) {
      throw new DraftError(
        "draft_answer_mismatch",
        `Question '${answer.question_id}' was answered more than once`,
      );
    }
    byQuestion.set(answer.question_id, answer);
  }

  const resolved: ReturnType<typeof draftAnswerSchema.parse>[] = [];
  for (const question of questions) {
    const answer = byQuestion.get(question.id);
    if (!answer) {
      throw new DraftError("draft_answer_mismatch", `Question '${question.id}' has no answer`);
    }
    byQuestion.delete(question.id);
    resolved.push(
      draftAnswerSchema.parse({
        question_id: question.id,
        question: question.question,
        answer: answer.answer,
      }),
    );
  }

  if (byQuestion.size > 0) {
    const unknown = Array.from(byQuestion.keys()).join(", ");
    throw new DraftError(
      "draft_answer_mismatch",
      `Answers reference unknown questions: ${unknown}`,
    );
  }

  return resolved;
}
