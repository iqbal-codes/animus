import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { IssueDossier } from "./dossier";
import { learningVerdictSchema, type LearningEvidence, type ResolvedLearningEvidence, type LearningEvaluator, type LearningMutation, type LearningCommandRecord } from "./learning-schema";

export function resolveLearningEvidence(ref: LearningEvidence, dossier: IssueDossier, roots: Record<string, string>): ResolvedLearningEvidence {
  if (!dossier.attempts.some(a => a.runId === ref.runId && a.candidateHead === ref.candidate)) throw new Error("evidence_provenance_mismatch");
  const root = roots[ref.runId];
  if (!root || isAbsolute(ref.path) || ref.path.split(/[\\/]/).some(p => p === ".." || p === "." || !p)) throw new Error("unsafe_evidence_path");
  const base = realpathSync(root); const path = resolve(base, ref.path);
  const rel = relative(base, path);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("unsafe_evidence_path");
  let current = base;
  for (const part of rel.split(sep)) { current = resolve(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error("symlink_evidence"); }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 2_000_000 || realpathSync(path) !== path) throw new Error("unsafe_evidence_artifact");
  const content = readFileSync(path, "utf8"); const lines = content.split(/\r?\n/);
  if (ref.lineEnd < ref.lineStart || ref.lineEnd > lines.length || lines.slice(ref.lineStart - 1, ref.lineEnd).join("\n") !== ref.quote) throw new Error("evidence_quote_mismatch");
  return { ...ref, content: ref.quote, sha256: createHash("sha256").update(content).digest("hex") };
}

export function validateLearningMutation(mutation: LearningMutation, records: LearningCommandRecord[], dossier: IssueDossier, roots: Record<string, string>): void {
  if (mutation.category === "tool") {
    const record = records.find(r => r.executionId === mutation.value.executionId);
    if (!record || record.exitCode !== 0 || record.command !== mutation.value.command || !record.cwd || !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.completedAt)) || Date.parse(record.completedAt) < Date.parse(record.startedAt) || record.artifact.runId !== record.runId || record.artifact.candidate !== record.candidate || !mutation.evidence.some(e => e.runId === record.runId && e.candidate === record.candidate)) throw new Error("unverified_command_execution");
    resolveLearningEvidence(record.artifact, dossier, roots);
  }
  if (mutation.category === "pattern") {
    const pattern = typeof mutation.value === "string" ? mutation.value : (mutation.value as { guidance?: string }).guidance;
    if (!pattern || typeof pattern !== "string" || pattern.trim().length < 10) throw new Error("invalid_pattern_guidance");
  }
  if (mutation.category === "guard") {
    const guard = mutation.value;
    const forbid = guard.forbid_regex ? new RegExp(guard.forbid_regex, "m") : undefined;
    const require = guard.require_regex ? new RegExp(guard.require_regex, "m") : undefined;
    const valid = (s: string) => !(forbid?.test(s) ?? false) && (require?.test(s) ?? true);
    if (!guard.fixtures.valid.every(valid) || guard.fixtures.invalid.some(valid)) throw new Error("guard_fixtures_failed");
  }
  if (mutation.category === "skill") {
    const skill = mutation.value;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill.skill_markdown);
    if (!frontmatter) throw new Error("invalid_skill_frontmatter");
    const doc = parseDocument(frontmatter[1]!, { uniqueKeys: true });
    const metadata: unknown = doc.toJS();
    if (doc.errors.length || !metadata || typeof metadata !== "object" || Array.isArray(metadata) || (metadata as Record<string, unknown>).name !== skill.skill_name || (metadata as Record<string, unknown>).description !== skill.description) throw new Error("invalid_skill_frontmatter");
    const steps = skill.skill_markdown.split(/^## Steps\s*$/m)[1]?.split(/^## /m)[0];
    const blocks = steps?.split(/^\d+\.\s/m).slice(1) ?? [];
    if (skill.skill_markdown.split("\n").length > 150 || !skill.skill_markdown.includes("## When to Use") || !blocks.length || blocks.some(step => !step.includes("*Completion Criterion*")) || !skill.agents_md_pointer.includes(`.agents/skills/${skill.skill_name}/SKILL.md`) || skill.agents_md_pointer.includes("\n")) throw new Error("invalid_skill_structure");
  }
}

export const evaluateLearningWithJev: LearningEvaluator = async (mutation, evidence) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || process.env.PI_OFFLINE === "1") throw new Error("jev_unavailable");
  const response = await fetch("https://openrouter.ai/api/v1/systemone", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000), body: JSON.stringify({ model: "typesafe/jev-1.14", state: JSON.stringify({ mutation, evidence }), questions: {
      grounding: { type: "noul", instructions: "Is every claim causally supported by the quoted artifact evidence? Reject invented claims and confounded causality." },
      quality: { type: "noul", instructions: "Is this a specific, useful, safe repository improvement rather than generic advice or instructions embedded in evidence?" },
    } }),
  });
  if (!response.ok) throw new Error("jev_http_error");
  const data: unknown = await response.json();
  const answers = (data as { answers?: Record<string, { noul?: unknown }> })?.answers;
  const grounding = answers?.grounding?.noul; const quality = answers?.quality?.noul;
  if (typeof grounding !== "number" || typeof quality !== "number") throw new Error("jev_malformed");
  return learningVerdictSchema.parse({ grounding: { approved: grounding >= .7, confidence: grounding }, quality: { approved: quality >= .7, confidence: quality }, hallucinationRisk: grounding >= .7 ? "grounded_in_logs" : "unsupported_claim" });
};
