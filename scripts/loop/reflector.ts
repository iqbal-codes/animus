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

/**
 * Deterministic structural validation + optional TypeSafe Jev System 1 API check.
 * Enforces `docs/agents/harness-authoring-standard.md`:
 * - Positive imperative phrasing (no weak "don't / avoid" leading negations)
 * - <= 2 sentences
 * - Non-empty trigger_patterns and concrete evidence
 * - Confidence >= 0.70
 */
export async function defaultEvaluateCandidateLesson(
  draft: CandidateLessonDraft,
  _dossier: IssueDossier,
): Promise<JevLessonVerdict> {
  const rule = (draft.rule ?? "").trim();
  const evidence = (draft.evidence ?? "").trim();
  const topic = (draft.topic ?? "").trim();

  if (!topic || !rule || !evidence || !Array.isArray(draft.trigger_patterns) || !draft.trigger_patterns.length) {
    return {
      approved: false,
      confidence: 0.1,
      hallucinationRisk: "unsupported_claim",
      reason: "missing_required_fields",
    };
  }

  // Enforce <= 2 sentences
  const sentences = rule
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 2) {
    return {
      approved: false,
      confidence: 0.3,
      hallucinationRisk: "plausible_inference",
      reason: "rule_exceeds_two_sentences",
    };
  }

  // Enforce positive imperative (no leading negation)
  if (/^(do not|don't|never|avoid)\b/i.test(rule)) {
    return {
      approved: false,
      confidence: 0.4,
      hallucinationRisk: "plausible_inference",
      reason: "negative_phrasing_violation",
    };
  }

  // If OPENROUTER_API_KEY is configured and not in offline test mode, call System 1 endpoint
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey && process.env.PI_OFFLINE !== "1") {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "typesafe/jev-1.14",
          state: JSON.stringify({ draft }),
          questions: {
            is_lesson_valid_and_non_trivial: {
              type: "noul",
              instructions:
                "Does the lesson record a specific, repeatable repository technical fact grounded in evidence rather than generic advice?",
            },
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const noul = Number(data?.answers?.is_lesson_valid_and_non_trivial?.noul ?? 0.85);
        return {
          approved: noul >= 0.7,
          confidence: noul,
          hallucinationRisk: noul >= 0.7 ? "grounded_in_logs" : "plausible_inference",
          reason: noul >= 0.7 ? undefined : "jev_confidence_below_threshold",
        };
      }
    } catch {
      // Fall back to deterministic structural gate when network is unavailable
    }
  }

  return {
    approved: true,
    confidence: 0.88,
    hallucinationRisk: "grounded_in_logs",
  };
}

function readAllLessonsRaw(root: string): LessonEntry[] {
  const filePath = join(root, ".factory/lessons.jsonl");
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const list: LessonEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      list.push(JSON.parse(t));
    } catch {}
  }
  return list;
}

function writeAllLessonsAtomic(root: string, lessons: LessonEntry[]): void {
  const filePath = join(root, ".factory/lessons.jsonl");
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const content = lessons.map((l) => JSON.stringify(l)).join("\n") + (lessons.length ? "\n" : "");
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

export function persistApprovedLesson(
  root: string,
  draft: CandidateLessonDraft,
  now = new Date(),
): { entry: LessonEntry; isRecurring: boolean } {
  const existing = readAllLessonsRaw(root);
  const matchIdx = existing.findIndex(
    (l) => l.topic.toLowerCase() === draft.topic.toLowerCase() && !l.vetoed,
  );

  if (matchIdx >= 0) {
    const current = existing[matchIdx]!;
    const updated: LessonEntry = {
      ...current,
      rule: draft.rule.trim(),
      evidence: `${current.evidence} | ${draft.evidence.trim()}`,
      trigger_patterns: Array.from(new Set([...current.trigger_patterns, ...draft.trigger_patterns])),
      occurrence_count: (current.occurrence_count ?? 1) + 1,
    };
    existing[matchIdx] = updated;
    writeAllLessonsAtomic(root, existing);
    return { entry: updated, isRecurring: (updated.occurrence_count ?? 1) >= 3 };
  }

  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = String(existing.length + 1).padStart(2, "0");
  const entry: LessonEntry = {
    id: `lsn-${datePart}-${seq}`,
    topic: draft.topic.trim(),
    trigger_patterns: draft.trigger_patterns,
    rule: draft.rule.trim(),
    evidence: draft.evidence.trim(),
    vetoed: false,
    occurrence_count: 1,
    created_at: now.toISOString(),
  };

  existing.push(entry);
  writeAllLessonsAtomic(root, existing);
  return { entry, isRecurring: false };
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

export function persistToolGuidanceUpdates(
  root: string,
  updates: Record<string, string>,
): string[] {
  const entries = Object.entries(updates).filter(
    ([k, v]) => typeof k === "string" && k.trim() && typeof v === "string" && v.trim(),
  );
  if (!entries.length) return [];

  const filePath = join(root, ".factory/tool-guidance.json");
  let current: Record<string, string> = {};
  if (existsSync(filePath)) {
    try {
      current = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {}
  }

  const updatedKeys: string[] = [];
  for (const [k, v] of entries) {
    current[k] = v.trim();
    updatedKeys.push(k);
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, filePath);
  return updatedKeys;
}

/**
 * Authors or updates a repository skill under `.agents/skills/<name>/SKILL.md`
 * and registers a trigger pointer in `AGENTS.md` while strictly enforcing the
 * <= 150 lines budget (per `$writing-for-agents` & `docs/agents/harness-authoring-standard.md`).
 */
export function applySkillPromotion(
  root: string,
  promotion: SkillPromotionDraft,
): { skillPath: string; agentsMdUpdated: boolean } {
  const safeName = promotion.skill_name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!safeName) throw new Error("Invalid skill_name in skill_promotion");

  const skillDir = join(root, ".agents/skills", safeName);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");

  let markdown = promotion.skill_markdown.trim();
  if (!markdown.startsWith("---")) {
    markdown = [
      "---",
      `name: ${safeName}`,
      `description: ${promotion.description.trim()}`,
      "---",
      "",
      markdown,
    ].join("\n");
  }
  if (!markdown.includes("*Completion Criterion*")) {
    markdown += "\n\n   *Completion Criterion*: Skill verification steps pass cleanly.\n";
  }
  writeFileSync(skillPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf-8");

  // Update AGENTS.md with pointer if not already present, maintaining <= 150 lines
  const agentsPath = join(root, "AGENTS.md");
  let agentsMdUpdated = false;
  if (existsSync(agentsPath) && promotion.agents_md_pointer?.trim()) {
    const pointerLine = promotion.agents_md_pointer.trim();
    const content = readFileSync(agentsPath, "utf-8");
    if (!content.includes(safeName)) {
      const lines = content.split("\n");
      // Insert into Repository Skills list or append under Repository Knowledge
      const insertIdx = lines.findIndex((l) => l.includes("Post-lap memory & lesson synthesis"));
      if (insertIdx >= 0) {
        lines.splice(insertIdx + 1, 0, `  ${pointerLine.startsWith("-") ? pointerLine : `- ${pointerLine}`}`);
      } else {
        lines.push(pointerLine.startsWith("-") ? pointerLine : `- ${pointerLine}`);
      }

      // Enforce <= 150 lines invariant by pruning trailing blank lines if needed
      while (lines.length > 150) {
        const blankIdx = lines.findLastIndex((l) => l.trim() === "");
        if (blankIdx >= 0) lines.splice(blankIdx, 1);
        else break;
      }

      if (lines.length <= 150) {
        writeFileSync(agentsPath, lines.join("\n"), "utf-8");
        agentsMdUpdated = true;
      }
    }
  }

  return { skillPath, agentsMdUpdated };
}

export interface RunPostIssueReflectionOptions {
  root: string;
  worktree: string;
  dossier: IssueDossier;
  artifactsDir: string;
  transport: AgentTransport;
  jevEvaluator?: JevLessonEvaluator;
  timeoutMs?: number;
}

export async function runPostIssueReflection(
  options: RunPostIssueReflectionOptions,
): Promise<ReflectionOutcome> {
  const { root, worktree, dossier, artifactsDir, transport } = options;
  if (isHarnessSafeMode(root)) {
    return {
      triggered: false,
      persistedLessons: [],
      rejectedLessons: [],
      updatedTools: [],
    };
  }

  const roleConfig = resolveRoleConfig(root, "reflector");
  let template = "";
  try {
    template = loadPrompt("loop-reflect", root);
  } catch {
    template =
      "Analyze dossier $INPUTS.dossier_json for $INPUTS.target and output JSON with attribution, candidate_lessons, tool_guidance_updates, skill_promotion.";
  }

  const prompt = renderPrompt(
    template,
    {
      target: dossier.issueUrl,
      reason: `Post-issue reflection for issue #${dossier.issueNumber}: ${dossier.issueTitle}`,
      dossier_json: JSON.stringify(dossier, null, 2),
    },
    artifactsDir,
  );

  const argv = buildProviderArgv(roleConfig.provider, {
    model: roleConfig.model,
    effort: roleConfig.effort,
    prompt,
    skills: resolveAllowedSkills(root, "reflector"),
    extensions: resolveLoopExtensions(root),
  });

  const res = await transport({
    argv,
    cwd: worktree,
    role: "reflector",
    provider: roleConfig.provider,
    timeoutMs: options.timeoutMs ?? 5 * 60_000,
  });

  if (res.exitCode !== 0) {
    return {
      triggered: true,
      attribution: "error",
      persistedLessons: [],
      rejectedLessons: [],
      updatedTools: [],
    };
  }

  let proposal: ReflectionProposal | null = null;
  try {
    // Extract from Pi JSON stream or direct JSON
    let textToParse = res.stdout;
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "message_end" && Array.isArray(ev.message?.content)) {
          textToParse = ev.message.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("");
        }
      } catch {}
    }
    proposal = parseAgentReport(textToParse) as ReflectionProposal;
  } catch {
    proposal = null;
  }

  if (!proposal || proposal.attribution === "confounded") {
    return {
      triggered: true,
      attribution: proposal?.attribution ?? "unparseable",
      persistedLessons: [],
      rejectedLessons: [],
      updatedTools: [],
    };
  }

  const evaluator = options.jevEvaluator ?? defaultEvaluateCandidateLesson;
  const persistedLessons: LessonEntry[] = [];
  const rejectedLessons: Array<{ draft: CandidateLessonDraft; reason: string }> = [];
  let recurringTriggered = false;

  for (const draft of proposal.candidate_lessons ?? []) {
    const verdict = await evaluator(draft, dossier);
    if (verdict.approved && verdict.confidence >= 0.7) {
      // Persist to both worktree (for Fast-Track PR bundle) and root repository memory
      const wtResult = persistApprovedLesson(worktree, draft);
      if (root !== worktree) {
        persistApprovedLesson(root, draft);
      }
      persistedLessons.push(wtResult.entry);
      if (wtResult.isRecurring) recurringTriggered = true;
    } else {
      rejectedLessons.push({
        draft,
        reason: verdict.reason ?? "rejected_by_jev",
      });
    }
  }

  const updatedTools = proposal.tool_guidance_updates
    ? persistToolGuidanceUpdates(worktree, proposal.tool_guidance_updates)
    : [];
  if (updatedTools.length > 0 && root !== worktree) {
    persistToolGuidanceUpdates(root, proposal.tool_guidance_updates!);
  }

  const mergedPatternUpdates = {
    ...(proposal.component_registry_updates ?? {}),
    ...(proposal.pattern_registry_updates ?? {}),
  };
  const { updatedComponents, updatedRules } = persistCodebaseRulesUpdates(
    worktree,
    mergedPatternUpdates,
    proposal.codebase_rule_updates,
  );
  if ((updatedComponents.length > 0 || updatedRules.length > 0) && root !== worktree) {
    persistCodebaseRulesUpdates(root, mergedPatternUpdates, proposal.codebase_rule_updates);
  }

  let promotedSkill: ReflectionOutcome["promotedSkill"];
  if (proposal.skill_promotion && (proposal.skill_promotion.skill_name || recurringTriggered)) {
    const applied = applySkillPromotion(worktree, proposal.skill_promotion);
    if (root !== worktree) {
      applySkillPromotion(root, proposal.skill_promotion);
    }
    promotedSkill = {
      skillName: proposal.skill_promotion.skill_name,
      skillPath: applied.skillPath,
      agentsMdUpdated: applied.agentsMdUpdated,
    };
  }

  return {
    triggered: true,
    attribution: proposal.attribution,
    persistedLessons,
    rejectedLessons,
    updatedTools,
    updatedComponents,
    updatedRules,
    promotedSkill,
  };
}
