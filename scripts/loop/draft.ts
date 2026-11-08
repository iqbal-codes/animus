import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  draftPlanSchema,
  type DraftAcceptanceCriterion,
  type DraftBoundary,
  type DraftPlan,
  type DraftPlannerMetadata,
  type DraftQuestion,
} from "@animus/contracts/operator";
import { parsePartOf, parseTicketSections } from "../../apps/backend/src/intake/parser";
import { extractReportObject } from "./artifacts";
import { resolveRoleConfig } from "./config";
import { resolveRoleBudgets } from "./deadlines";
import {
  buildCuratedAppendPrompts,
  resolveAllowedSkills,
  resolveLoopExtensions,
} from "./harness-memory";
import { processRun } from "./process";
import { loadPrompt, renderPrompt } from "./prompts";
import { buildProviderArgv } from "./providers";
import {
  getWorkspaceSnapshot,
  validateCanonicalIssueBody,
  REQUIRED_TRIAGE_SKILL,
} from "./triage";
import type { AgentTransport, LoopRole, RoleBudget } from "./types";

export interface PlanDraftOptions {
  transport?: AgentTransport;
  env?: Record<string, string>;
  acceptedRef?: string;
  timeoutMs?: number;
  roleBudgets?: Partial<Record<LoopRole, RoleBudget>>;
}

export interface PlanDraftInput {
  root: string;
  repo: string;
  stateRoot: string;
  workId: string;
  source: {
    title: string;
    body: string;
    state: "OPEN" | "CLOSED";
    labels: string[];
    comments: Array<{ id: string | null; author: string | null; body: string }>;
  };
  sourceRevisionId: string;
  sourceContentHash: string;
  provenance: { issue_number: number; source_url: string };
  prior: {
    questions: DraftQuestion[];
    answers: Array<{ question_id: string; question: string; answer: string }>;
    instructions?: string;
    kind: "clarification" | "standalone" | "spec";
  } | null;
}

export interface PlanDraftResult {
  plan: DraftPlan;
  metadata: DraftPlannerMetadata;
}

function extractSection(markdown: string, heading: string): string {
  const pattern = new RegExp(`##\\s+${heading}[\\r\\n]+([\\s\\S]*?)(?=(?:\\r?\\n##\\s+|$))`, "i");
  const match = markdown.match(pattern);
  return match?.[1]?.trim() ?? "";
}

function sectionListItems(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function boundaryOf(markdown: string): DraftBoundary {
  const boundary = extractSection(markdown, "Boundary");
  const find = (label: RegExp): string => {
    const match = boundary.match(label);
    return match?.[1]?.trim() ?? "";
  };
  const touchpoints = find(/\*\*Touchpoints\*\*:\s*(.+)/i);
  const knownCallers = find(/\*\*Known callers[^*]*\*\*:\s*(.+)/i);
  const testSeam = find(/\*\*Test seam\*\*:\s*(.+)/i);
  const exclusions = find(/\*\*Exclusions\*\*:\s*(.+)/i);
  const fallback = boundary.trim() || "Prepared ticket boundary remains binding.";
  return {
    touchpoints: touchpoints || fallback,
    known_callers: knownCallers || fallback,
    test_seam: testSeam || fallback,
    exclusions: exclusions || fallback,
  };
}

function acceptanceCriteriaOf(markdown: string): DraftAcceptanceCriterion[] {
  const items = sectionListItems(extractSection(markdown, "Acceptance criteria"));
  if (items.length === 0) return [];
  return items.map((item, index) => {
    const match = item.match(/^(AC[1-9][0-9]*):\s*(.*)$/);
    return {
      id: match?.[1] ?? `AC${index + 1}`,
      description: (match?.[2] ?? item).trim(),
      verification: "Verify through the prepared ticket's stated test seam.",
    };
  });
}

function verificationOf(markdown: string, boundary: DraftBoundary): string[] {
  const items = sectionListItems(extractSection(markdown, "Verification"));
  if (items.length > 0) return items;
  return [boundary.test_seam];
}

/**
 * A prepared work contract is admitted as-is only when it is unambiguously a
 * single standalone ticket.
 *
 * Two signals disqualify pass-through, both of which mean the item is a spec or
 * a child of one: the `spec` label, or a `Part of #<n>` reference. A canonical
 * parent-spec body that loses its label must never be silently converted into
 * standalone execution, so the check is on explicit structural markers rather
 * than on title wording. Prepared specs are admitted by the plan-admission lane
 * (#153); draft refinement never performs that decomposition itself.
 */
function preparedWorkPlan(source: PlanDraftInput["source"]): DraftPlan | null {
  if (parsePartOf(source.body) !== null) return null;
  if (source.labels.some((label) => label.toLowerCase() === "spec")) return null;
  if (!validateCanonicalIssueBody(source.body).valid) return null;

  const sections = parseTicketSections(source.body);
  const acceptance = acceptanceCriteriaOf(source.body);
  if (acceptance.length === 0) return null;
  const boundary = boundaryOf(source.body);
  const verification = verificationOf(source.body, boundary);
  // A complete standalone ticket proves its own verification. A parent-spec body
  // does not carry a `## Verification` section, so requiring one here prevents a
  // canonical spec from being silently accepted as standalone execution.
  if (extractSection(source.body, "Verification").length === 0) return null;
  const invariants =
    sections.invariants.length > 0
      ? sections.invariants
      : ["The prepared ticket contract remains binding without a second decomposition."];

  return {
    kind: "standalone",
    title: source.title,
    scope: sections.sourceProblem,
    outcome: sections.outcome,
    invariants,
    acceptance_criteria: acceptance,
    verification_requirements: verification,
    boundary,
    depends_on: sections.dependsOn,
    body: source.body,
    prepared: true,
  };
}

/**
 * Detects a work item that is already a prepared specification or a child of
 * one. Draft refinement never re-decomposes these: admission of prepared specs
 * and children belongs to the plan-admission lane (#153), so this refuses
 * closed rather than silently treating a spec as fresh raw intake.
 */
function preparedSpecReason(source: PlanDraftInput["source"]): string | null {
  const partOf = parsePartOf(source.body);
  if (partOf !== null) {
    return `the imported work already declares 'Part of #${partOf}' and must be admitted as a prepared child of that spec`;
  }
  if (source.labels.some((label) => label.toLowerCase() === "spec")) {
    return "the imported work is a prepared parent specification and must be admitted through plan admission instead of being re-decomposed";
  }
  if (/source\s+acceptance\s+coverage\s*:/i.test(source.body)) {
    return "the imported work declares acceptance coverage for a prepared parent and must be admitted as part of that plan";
  }
  if (/(^|\r?\n)##\s+Children\b/i.test(source.body)) {
    return "the imported work declares a '## Children' decomposition and must be admitted as a prepared parent specification instead of being re-decomposed";
  }
  // A canonical body that is missing its `## Verification` section is not a
  // complete executable ticket. The common cause is a parent-spec body whose
  // label was lost, so refuse instead of re-planning it as fresh raw intake.
  if (validateCanonicalIssueBody(source.body).valid) {
    const hasVerification = extractSection(source.body, "Verification").length > 0;
    if (!hasVerification) {
      return "the imported canonical work has no '## Verification' section, so it is an incomplete or parent-spec record that must be admitted deliberately rather than re-planned";
    }
  }
  return null;
}

function renderDraftPrompt(input: PlanDraftInput, artifactsDir: string): string {
  const template = loadPrompt("draft", input.root);
  const comments =
    input.source.comments
      .map(
        (comment, index) =>
          `Comment #${index + 1} (id: ${comment.id ?? `idx-${index + 1}`}) by @${comment.author ?? "unknown"}:\n${comment.body}`,
      )
      .join("\n\n---\n\n") || "(No comments on this issue yet)";
  const priorQuestions = input.prior?.questions.length
    ? JSON.stringify(input.prior.questions, null, 2)
    : "[]";
  const priorAnswers = input.prior?.answers.length
    ? JSON.stringify(input.prior.answers, null, 2)
    : "[]";

  return renderPrompt(
    template,
    {
      issue_number: String(input.provenance.issue_number),
      issue_title: input.source.title,
      issue_body: input.source.body || "(No description provided)",
      issue_comments: comments,
      repo: input.repo,
      source_revision_id: input.sourceRevisionId,
      source_content_hash: input.sourceContentHash,
      prior_questions: priorQuestions,
      prior_answers: priorAnswers,
      operator_instructions: input.prior?.instructions ?? "(none)",
    },
    artifactsDir,
    { allowUnresolved: true },
  );
}

function ensureSkillAvailable(root: string, acceptedRef?: string): void {
  const skills = resolveAllowedSkills(root, "triage", acceptedRef);
  if (!skills.some((skill) => basename(skill) === REQUIRED_TRIAGE_SKILL)) {
    throw new Error(
      "Draft planning requires the accepted triage playbook (animus-triage), but it is unavailable.",
    );
  }
}

function assertProviderGuard(provider: string, extensions: string[]): void {
  if (provider === "pi" || provider === "omp") {
    if (extensions.length === 0) {
      throw new Error(
        `Safety guard extension hook (.factory/hooks/loop-guard.ts) could not be verified for provider '${provider}'.`,
      );
    }
    return;
  }
  if (provider === "claude" || provider === "commandcode") return;
  throw new Error(
    `Unsupported safety configuration for provider '${provider}': read-only tool guard cannot be verified.`,
  );
}

export async function planDraft(
  input: PlanDraftInput,
  options: PlanDraftOptions = {},
): Promise<PlanDraftResult> {
  if (!existsSync(input.root)) {
    throw new Error(`Draft planning root does not exist: ${input.root}`);
  }

  // Refuse prepared specs/children before any pass-through decision: a
  // canonical parent body can carry a `## Verification` section, so checking
  // preparedWorkPlan first would silently accept it as standalone.
  const specReason = preparedSpecReason(input.source);
  if (specReason) {
    throw new Error(`DRAFT PREPARED WORK: Prepared work is not draft material: ${specReason}.`);
  }

  const prepared = preparedWorkPlan(input.source);
  if (prepared) {
    return {
      plan: prepared,
      metadata: {
        transport: "prepared",
        prompt: "prepared",
        provider: null,
        model: null,
        effort: null,
        accepted_ref: options.acceptedRef ?? null,
      },
    };
  }

  const env: Record<string, string> = {
    ...process.env,
    ...(options.env ?? {}),
    FACTORY_LOOP_ROLE: "triage",
  } as Record<string, string>;

  if (env.PI_OFFLINE === "1") {
    throw new Error("PI_OFFLINE is active: draft planning holds without transport invocation.");
  }

  ensureSkillAvailable(input.root, options.acceptedRef);
  const roleConfig = resolveRoleConfig(input.root, "triage", env);
  const provider = roleConfig.provider;
  const model = roleConfig.model;
  const effort = roleConfig.effort;
  const extensions = resolveLoopExtensions(input.root, options.acceptedRef);
  assertProviderGuard(provider, extensions);

  const artifactsDir = join(input.stateRoot, "draft-artifacts", input.workId);
  mkdirSync(artifactsDir, { recursive: true });

  const prompt = renderDraftPrompt(input, artifactsDir);
  const appendSystemPrompts = buildCuratedAppendPrompts(
    input.root,
    {
      number: input.provenance.issue_number,
      title: input.source.title,
      body: input.source.body,
      url: input.provenance.source_url,
      comments: input.source.comments.map((comment) => comment.body),
      dependencies: [],
      activeClaim: false,
    },
    "",
    options.acceptedRef,
  );
  const skills = resolveAllowedSkills(input.root, "triage", options.acceptedRef);
  const argv = buildProviderArgv(provider, {
    model,
    effort,
    prompt,
    skills,
    appendSystemPrompts,
    extensions: provider === "pi" || provider === "omp" ? extensions : undefined,
    tools: provider === "claude" ? "Read,Glob,Grep" : "read,grep,find,ls",
    allowedTools: provider === "claude" ? ["Read", "Glob", "Grep"] : undefined,
    disallowedTools: provider === "claude" ? ["Write", "Edit"] : undefined,
    strictMcp: provider === "claude" ? true : undefined,
    settingSources: provider === "claude" ? "" : undefined,
    readOnly: provider === "commandcode" ? true : undefined,
  });

  const budgets = resolveRoleBudgets(
    {
      timeoutMs: options.timeoutMs,
      roleBudgets: options.roleBudgets,
    },
    env,
  );
  const timeoutMs = budgets.triage.hardMs;
  const beforeSnapshot = getWorkspaceSnapshot(input.root);
  const transport: AgentTransport =
    options.transport ?? ((request) => processRun(request.argv, request.cwd, request.timeoutMs, request.env));

  const response = await transport({
    argv,
    cwd: input.root,
    role: "triage",
    provider,
    model,
    effort,
    timeoutMs,
    env,
  });

  const afterSnapshot = getWorkspaceSnapshot(input.root);
  if (beforeSnapshot !== afterSnapshot) {
    throw new Error(
      `DRAFT SAFETY VIOLATION: Working tree in '${input.root}' was mutated during draft planning.\nBefore: ${beforeSnapshot}\nAfter: ${afterSnapshot}`,
    );
  }

  if (response.timedOut || response.exitCode === 124) {
    throw new Error(`Draft planning agent timed out after ${timeoutMs}ms`);
  }
  if (response.exitCode !== 0) {
    throw new Error(
      `Draft planning agent transport exited with code ${response.exitCode}: ${response.stderr}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = extractReportObject(response.stdout);
  } catch (error) {
    throw new Error(
      `Malformed draft planning output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validated = draftPlanSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid draft planning output schema: ${validated.error.message}`);
  }
  const plan = validated.data;
  if (plan.kind !== "clarification") {
    const bodies = plan.kind === "standalone" ? [plan.body] : [plan.body, ...plan.children.map((child) => child.body)];
    for (const body of bodies) {
      const canonical = validateCanonicalIssueBody(body);
      if (!canonical.valid) {
        throw new Error(`Draft body is not canonical: ${canonical.errors.join("; ")}`);
      }
      if (extractSection(body, "Verification").length === 0) {
        throw new Error("Draft body is missing a non-empty '## Verification' section");
      }
    }
  }

  return {
    plan,
    metadata: {
      transport: "agent",
      prompt: "draft",
      provider,
      model: model ?? null,
      effort: effort ?? null,
      accepted_ref: options.acceptedRef ?? null,
    },
  };
}
