import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IssueDossier } from "./dossier";
import type { LessonEntry } from "./harness-memory";
import { isHarnessSafeMode, resolveAllowedSkills, resolveLoopExtensions } from "./harness-memory";
import { parseAgentReport } from "./artifacts";
import { loadPrompt, renderPrompt } from "./prompts";
import { resolveRoleConfig } from "./config";
import { buildProviderArgv } from "./providers";
import type { AgentTransport } from "./types";
import { learningProposalSchema, learningVerdictSchema, lessonDraftSchema, type LearningEvaluator, type LearningCommandRecord, type LearningProposalArtifact } from "./learning-schema";
import { evaluateLearningWithJev, resolveLearningEvidence, validateLearningMutation } from "./learning-gates";

export interface CandidateLessonDraft {
  topic: string;
  trigger_patterns: string[];
  rule: string;
  evidence: string;
}

export interface SkillPromotionDraft {
  skill_name: string;
  description: string;
  agents_md_pointer: string;
  skill_markdown: string;
}

export interface CodebaseRuleDraft {
  id: string;
  description: string;
  file_glob: string;
  forbid_regex?: string;
  require_regex?: string;
  replacement_hint: string;
  mode?: "warn" | "block";
}

export interface ReflectionProposal {
  attribution: "helped" | "hurt" | "no_observed_effect" | "confounded";
  tool_guidance_updates?: Record<string, string>;
  pattern_registry_updates?: Record<string, string>;
  component_registry_updates?: Record<string, string>;
  codebase_rule_updates?: CodebaseRuleDraft[];
  candidate_lessons?: CandidateLessonDraft[];
  skill_promotion?: SkillPromotionDraft | null;
}

export interface JevLessonVerdict {
  approved: boolean;
  confidence: number;
  hallucinationRisk: "grounded_in_logs" | "plausible_inference" | "unsupported_claim";
  reason?: string;
}

export type JevLessonEvaluator = (
  draft: CandidateLessonDraft,
  dossier: IssueDossier,
) => Promise<JevLessonVerdict>;

export interface ReflectionOutcome {
  triggered: boolean;
  status: "held" | "proposed" | "no_entry" | "skipped" | "error";
  proposalPath?: string;
  reasons?: string[];
  attribution?: string;
  persistedLessons: LessonEntry[];
  rejectedLessons: Array<{ draft: CandidateLessonDraft; reason: string }>;
  updatedTools: string[];
  updatedComponents?: string[];
  updatedRules?: string[];
  promotedSkill?: {
    skillName: string;
    skillPath: string;
    agentsMdUpdated: boolean;
    prUrl?: string;
  };
}

/** Fail closed when either grounding or quality cannot be evaluated. */
export async function defaultEvaluateCandidateLesson(draft: CandidateLessonDraft, _dossier: IssueDossier): Promise<JevLessonVerdict> {
  try {
    lessonDraftSchema.parse(draft);
    // Legacy draft strings contain no resolvable provenance and cannot authorize activation.
    return { approved: false, confidence: 0, hallucinationRisk: "unsupported_claim", reason: "structured_evidence_required" };
  } catch {
    return { approved: false, confidence: 0, hallucinationRisk: "unsupported_claim", reason: "invalid_lesson" };
  }
}

export function persistCodebaseRulesUpdates(
  root: string,
  patternUpdates?: Record<string, string>,
  ruleUpdates?: CodebaseRuleDraft[],
): { updatedComponents: string[]; updatedRules: string[] } {
  const filePath = join(root, ".factory/codebase-rules.json");
  let current: {
    schema_version?: number;
    description?: string;
    rules?: CodebaseRuleDraft[];
    pattern_registry?: Record<string, string>;
    component_registry?: Record<string, string>;
  } = {
    schema_version: 1,
    description:
      "Domain-agnostic codebase conventions & shared pattern registry enforced by loop-guard.ts",
    rules: [],
    pattern_registry: {},
  };

  if (existsSync(filePath)) {
    try {
      current = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {}
  }

  current.pattern_registry = current.pattern_registry ?? current.component_registry ?? {};
  current.rules = Array.isArray(current.rules) ? current.rules : [];

  const updatedComponents: string[] = [];
  for (const [k, v] of Object.entries(patternUpdates ?? {})) {
    if (typeof k === "string" && k.trim() && typeof v === "string" && v.trim()) {
      current.pattern_registry[k.trim()] = v.trim();
      updatedComponents.push(k.trim());
    }
  }

  const updatedRules: string[] = [];
  for (const rule of ruleUpdates ?? []) {
    if (!rule?.id || !rule?.file_glob || !rule?.replacement_hint) continue;
    const normalized: CodebaseRuleDraft = {
      ...rule,
      mode: rule.mode ?? "warn",
    };
    const existingIdx = current.rules.findIndex((r) => r.id === normalized.id);
    if (existingIdx >= 0) {
      current.rules[existingIdx] = normalized;
    } else {
      current.rules.push(normalized);
    }
    updatedRules.push(normalized.id);
  }

  if (updatedComponents.length > 0 || updatedRules.length > 0) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, filePath);
  }

  return { updatedComponents, updatedRules };
}

export interface RunPostIssueReflectionOptions {
  root: string;
  worktree: string;
  dossier: IssueDossier;
  artifactsDir: string;
  transport: AgentTransport;
  jevEvaluator?: JevLessonEvaluator;
  proposalEvaluator?: LearningEvaluator;
  evidenceRoots?: Record<string, string>;
  commandRecords?: LearningCommandRecord[];
  timeoutMs?: number;
  acceptedRef?: string;
}

export async function runPostIssueReflection(options: RunPostIssueReflectionOptions): Promise<ReflectionOutcome> {
  const { root, worktree, dossier, artifactsDir, transport } = options;
  const empty = { persistedLessons: [], rejectedLessons: [], updatedTools: [], updatedComponents: [], updatedRules: [] };
  if (isHarnessSafeMode(root)) return { ...empty, triggered: false, status: "skipped", reasons: ["harness_safe_mode"] };
  try {
    const config = resolveRoleConfig(root, "reflector");
    let template: string;
    try { template = loadPrompt("loop-reflect", root); }
    catch { template = "Return a schema_version:1 learning proposal with attribution and mutations. Never write files. Dossier: $INPUTS.dossier_json"; }
    const prompt = renderPrompt(template, { target: dossier.issueUrl, reason: dossier.issueTitle, dossier_json: JSON.stringify(dossier) }, artifactsDir);
    const response = await transport({ argv: buildProviderArgv(config.provider, { model: config.model, effort: config.effort, prompt, skills: resolveAllowedSkills(root, "reflector", options.acceptedRef), extensions: resolveLoopExtensions(root, options.acceptedRef) }), cwd: worktree, role: "reflector", provider: config.provider, timeoutMs: options.timeoutMs ?? 300000 });
    if (response.exitCode !== 0) return { ...empty, triggered: true, status: "error", reasons: ["reflector_transport_failed"] };
    let raw = response.stdout;
    for (const line of response.stdout.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && Array.isArray(event.message?.content)) raw = event.message.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
      } catch { /* Direct JSON is parsed below. */ }
    }
    const parsed = learningProposalSchema.safeParse(parseAgentReport(raw));
    if (!parsed.success) return { ...empty, triggered: true, status: "held", reasons: ["invalid_proposal_schema"] };
    const proposal = parsed.data;
    const artifact: LearningProposalArtifact = { schema_version: 1, status: "held", issueNumber: dossier.issueNumber, accepted: [], held: [] };
    for (const mutation of proposal.mutations) {
      try {
        if (proposal.attribution === "confounded") throw new Error("confounded_attribution");
        const evidence = mutation.evidence.map(ref => resolveLearningEvidence(ref, dossier, options.evidenceRoots ?? {}));
        validateLearningMutation(mutation, options.commandRecords ?? [], dossier, options.evidenceRoots ?? {});
        const verdict = learningVerdictSchema.parse(await (options.proposalEvaluator ?? evaluateLearningWithJev)(mutation, evidence));
        if (!verdict.grounding.approved || verdict.grounding.confidence < .7 || !verdict.quality.approved || verdict.quality.confidence < .7 || verdict.hallucinationRisk !== "grounded_in_logs") throw new Error("jev_rejected");
        artifact.accepted.push({ mutation, evidence, verdict });
      } catch (error) { artifact.held.push({ key: mutation.key, reason: error instanceof Error ? error.message : "evaluation_failed" }); }
    }
    artifact.status = artifact.accepted.length ? "proposed" : artifact.held.length ? "held" : "no_entry";
    // Exclusive creation prevents following a pre-existing proposal-file symlink.
    const proposalPath = join(artifactsDir, `learning-proposal-${crypto.randomUUID()}.json`);
    writeFileSync(proposalPath, JSON.stringify(artifact, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return { ...empty, triggered: true, status: artifact.status, attribution: proposal.attribution, proposalPath, reasons: artifact.held.map(item => item.key + ":" + item.reason) };
  } catch (error) {
    return { ...empty, triggered: true, status: "error", reasons: [error instanceof Error ? error.message : "reflection_failed"] };
  }
}
