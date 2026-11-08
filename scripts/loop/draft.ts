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
  triageOutputSchema,
  validateCanonicalIssueBody,
  REQUIRED_TRIAGE_SKILL,
  type TriageAction,
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

function preparedStandalonePlan(source: PlanDraftInput["source"]): DraftPlan | null {
  if (parsePartOf(source.body) !== null) return null;
  if (source.labels.some((label) => label.toLowerCase() === "spec")) return null;
  if (!validateCanonicalIssueBody(source.body).valid) return null;

  const sections = parseTicketSections(source.body);
  const acceptance = acceptanceCriteriaOf(source.body);
  if (acceptance.length === 0) return null;
  const boundary = boundaryOf(source.body);
  const verification = verificationOf(source.body, boundary);
  const invariants = sections.invariants.length > 0 ? sections.invariants : [
    "The prepared ticket contract remains binding without a second decomposition.",
  ];

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

function withVerificationSection(body: string, boundary: DraftBoundary): string {
  if (extractSection(body, "Verification").length > 0) return body;
  return `${body.trimEnd()}\n\n## Verification\n- ${boundary.test_seam}\n`;
}

function legacyAcceptanceCriteria(body: string, label: string): DraftAcceptanceCriterion[] {
  const acceptance = acceptanceCriteriaOf(body);
  if (acceptance.length === 0) {
    throw new Error(`Legacy triage output for ${label} has no acceptance criteria`);
  }
  return acceptance;
}

function adaptLegacyTriageAction(action: TriageAction): DraftPlan {
  if (action.action === "ask_clarification") {
    return {
      kind: "clarification",
      reason: action.reason,
      questions: [{ id: "q1", question: action.question, reason: action.reason }],
    };
  }
  if (action.action === "promote_single_ticket") {
    const sections = parseTicketSections(action.body);
    const boundary = boundaryOf(action.body);
    return {
      kind: "standalone",
      title: action.title,
      scope: sections.sourceProblem,
      outcome: sections.outcome,
      invariants:
        sections.invariants.length > 0
          ? sections.invariants
          : ["The requested contract remains binding."],
      acceptance_criteria: legacyAcceptanceCriteria(action.body, "standalone ticket"),
      verification_requirements: verificationOf(action.body, boundary),
      boundary,
      depends_on: sections.dependsOn,
      body: withVerificationSection(action.body, boundary),
      prepared: true,
    };
  }
  if (action.action === "promote_epic_spec_and_tickets") {
    if (action.childTickets.length < 2) {
      throw new Error("Legacy epic promotion needs at least two child tickets to form a spec draft");
    }
    const parentSections = parseTicketSections(action.parentBody);
    const parentBoundary = boundaryOf(action.parentBody);
    const parentAcceptance = legacyAcceptanceCriteria(action.parentBody, "parent spec");
    const parentAcIds = parentAcceptance.map((criterion) => criterion.id);
    return {
      kind: "spec",
      title: action.parentTitle,
      scope: parentSections.sourceProblem,
      outcome: parentSections.outcome,
      invariants:
        parentSections.invariants.length > 0
          ? parentSections.invariants
          : ["The requested contract remains binding."],
      acceptance_criteria: parentAcceptance,
      verification_requirements: verificationOf(action.parentBody, parentBoundary),
      boundary: parentBoundary,
      depends_on: parentSections.dependsOn,
      body: withVerificationSection(action.parentBody, parentBoundary),
      children: action.childTickets.map((child, index) => {
        const sections = parseTicketSections(child.body);
        const boundary = boundaryOf(child.body);
        return {
          id: `C${index + 1}`,
          title: child.title,
          scope: sections.sourceProblem,
          outcome: sections.outcome,
          invariants:
            sections.invariants.length > 0
              ? sections.invariants
              : ["The requested contract remains binding."],
          acceptance_criteria: legacyAcceptanceCriteria(child.body, `child ticket #${index + 1}`),
          verification_requirements: verificationOf(child.body, boundary),
          boundary,
          depends_on: sections.dependsOn,
          body: withVerificationSection(child.body, boundary),
          depends_on_indices: child.dependsOnIndices,
          covers_parent_ac_ids: [parentAcIds[index % parentAcIds.length]!],
        };
      }),
    };
  }
  throw new Error("Legacy hold_for_human triage output cannot become an approvable draft plan");
}

export async function planDraft(
  input: PlanDraftInput,
  options: PlanDraftOptions = {},
): Promise<PlanDraftResult> {
  if (!existsSync(input.root)) {
    throw new Error(`Draft planning root does not exist: ${input.root}`);
  }

  const prepared = preparedStandalonePlan(input.source);
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
  let plan: DraftPlan;
  if (validated.success) {
    plan = validated.data;
  } else {
    const legacy = triageOutputSchema.safeParse(parsed);
    if (!legacy.success) {
      throw new Error(`Invalid draft planning output schema: ${validated.error.message}`);
    }
    plan = adaptLegacyTriageAction(legacy.data);
  }
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
