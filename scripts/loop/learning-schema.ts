import { z } from "zod";

const text = z.string().trim().min(1).max(32000);
export const learningEvidenceSchema = z.strictObject({
  runId: text, candidate: text, path: text,
  lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(), quote: text,
});
const base = { key: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), evidence: z.array(learningEvidenceSchema).min(1).max(30) };
export const lessonDraftSchema = z.strictObject({
  topic: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), trigger_patterns: z.array(text).min(1).max(30),
  rule: text.refine(v => !/^(do not|don't|never|avoid)\b/i.test(v) && v.split(/(?<=[.!?])\s+/).length <= 2, "positive imperative, at most two sentences"), evidence: text,
});
export const guardDraftSchema = z.strictObject({
  id: text, description: text, file_glob: text, forbid_regex: text.optional(), require_regex: text.optional(),
  replacement_hint: text, mode: z.enum(["warn", "block"]).default("warn"),
  fixtures: z.strictObject({ valid: z.array(text).min(1), invalid: z.array(text).min(1) }),
}).refine(v => Boolean(v.forbid_regex || v.require_regex), "guard requires a regex");
export const skillDraftSchema = z.strictObject({ skill_name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: text, agents_md_pointer: text, skill_markdown: text });
export const learningMutationSchema = z.discriminatedUnion("category", [
  z.strictObject({ ...base, category: z.literal("lesson"), value: lessonDraftSchema }),
  z.strictObject({ ...base, category: z.literal("tool"), value: z.strictObject({ command: text, executionId: text }) }),
  z.strictObject({ ...base, category: z.literal("pattern"), value: text }),
  z.strictObject({ ...base, category: z.literal("guard"), value: guardDraftSchema }),
  z.strictObject({ ...base, category: z.literal("skill"), value: skillDraftSchema }),
]);
export const learningProposalSchema = z.strictObject({ schema_version: z.literal(1), attribution: z.enum(["helped", "hurt", "no_observed_effect", "confounded"]), mutations: z.array(learningMutationSchema).max(50) });
const score = z.strictObject({ approved: z.boolean(), confidence: z.number().finite().min(0).max(1) });
export const learningVerdictSchema = z.strictObject({ grounding: score, quality: score, hallucinationRisk: z.enum(["grounded_in_logs", "plausible_inference", "unsupported_claim"]), reason: text.optional() });
export type LearningMutation = z.infer<typeof learningMutationSchema>;
export type LearningProposal = z.infer<typeof learningProposalSchema>;
export type LearningEvidence = z.infer<typeof learningEvidenceSchema>;
export type LearningVerdict = z.infer<typeof learningVerdictSchema>;
export type LearningEvaluator = (mutation: LearningMutation, evidence: ResolvedLearningEvidence[]) => Promise<unknown>;
export interface ResolvedLearningEvidence extends LearningEvidence { sha256: string; content: string }
/** Supplied by host execution, never accepted from reflector JSON. */
export interface LearningCommandRecord {
  executionId: string; runId: string; candidate: string; command: string; cwd: string;
  exitCode: number; startedAt: string; completedAt: string; artifact: LearningEvidence;
}
export interface GatedLearningMutation { mutation: LearningMutation; evidence: ResolvedLearningEvidence[]; verdict: LearningVerdict }
export interface LearningProposalArtifact {
  schema_version: 1; status: "held" | "proposed" | "no_entry"; issueNumber: number;
  accepted: GatedLearningMutation[]; held: Array<{ key: string; reason: string }>;
}
