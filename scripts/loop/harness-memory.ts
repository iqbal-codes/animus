import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalIssue, LoopRole } from "./types";

const NON_BUILDER_SKILLS = new Set([
  "animus-grill",
  "animus-spec",
  "animus-tickets",
  "animus-review",
  "animus-harness",
  "writing-for-agents",
  "skill-creator",
]);

export interface LessonEntry {
  id: string;
  topic: string;
  trigger_patterns: string[];
  rule: string;
  evidence: string;
  vetoed: boolean;
  occurrence_count?: number;
  created_at: string;
}

export function isHarnessSafeMode(root: string): boolean {
  return existsSync(join(root, ".factory/NO_HARNESS_MEMORY"));
}

export function resolveAllowedSkills(root: string, role: LoopRole): string[] {
  if (isHarnessSafeMode(root)) return [];

  const repoSkillsDir = join(root, ".agents/skills");
  const candidateNames = new Set<string>();

  switch (role) {
    case "builder": {
      for (const base of [
        "tdd",
        "diagnosing-bugs",
        "animus-implement",
        "unstick",
        "blueprint",
        "ui-quality",
      ]) {
        candidateNames.add(base);
      }
      if (existsSync(repoSkillsDir)) {
        try {
          for (const entry of readdirSync(repoSkillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || NON_BUILDER_SKILLS.has(entry.name)) continue;
            const skillMdPath = join(repoSkillsDir, entry.name, "SKILL.md");
            if (!existsSync(skillMdPath)) continue;
            const head = readFileSync(skillMdPath, "utf-8").slice(0, 400);
            if (!/disable-model-invocation:\s*true/i.test(head)) {
              candidateNames.add(entry.name);
            }
          }
        } catch {}
      }
      break;
    }
    case "qa":
      candidateNames.add("ui-quality");
      break;
    case "planner":
      candidateNames.add("blueprint");
      break;
    case "investigator":
      candidateNames.add("diagnosing-bugs");
      candidateNames.add("unstick");
      break;
    case "reviewer":
      // Unattended loop reviewer is governed directly by loop-review.md with unified Standards & Spec axes
      break;
    case "reflector":
      candidateNames.add("animus-harness");
      candidateNames.add("writing-for-agents");
      candidateNames.add("skill-creator");
      break;
    default:
      break;
  }

  return Array.from(candidateNames)
    .map((name) => join(repoSkillsDir, name))
    .filter((p) => existsSync(join(p, "SKILL.md")) || existsSync(p));
}

export function resolveLoopExtensions(root: string): string[] {
  if (isHarnessSafeMode(root)) return [];
  const guardPath = join(root, ".factory/hooks/loop-guard.ts");
  return existsSync(guardPath) ? [guardPath] : [];
}

export function loadActiveLessons(root: string): LessonEntry[] {
  if (isHarnessSafeMode(root)) return [];
  const lessonsPath = join(root, ".factory/lessons.jsonl");
  if (!existsSync(lessonsPath)) return [];

  const lessons: LessonEntry[] = [];
  const raw = readFileSync(lessonsPath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LessonEntry;
      if (parsed && !parsed.vetoed && typeof parsed.rule === "string") {
        lessons.push({
          ...parsed,
          trigger_patterns: Array.isArray(parsed.trigger_patterns) ? parsed.trigger_patterns : [],
          occurrence_count: parsed.occurrence_count ?? 1,
        });
      }
    } catch {}
  }
  return lessons;
}

function patternMatchesTarget(pattern: string, target: string): boolean {
  const normPattern = pattern.trim();
  const normTarget = target.trim();
  if (!normPattern || !normTarget) return false;

  try {
    if (new Bun.Glob(normPattern).match(normTarget)) return true;
  } catch {}

  const cleanToken = normPattern.replace(/\*+/g, "").toLowerCase();
  if (cleanToken.length >= 3 && normTarget.toLowerCase().includes(cleanToken)) {
    return true;
  }
  return false;
}

export function matchRelevantLessons(
  root: string,
  targetHints: string[],
  limit = 5,
): LessonEntry[] {
  const active = loadActiveLessons(root);
  if (!active.length) return [];

  const cleanHints = targetHints.map((h) => h.trim()).filter(Boolean);
  if (!cleanHints.length) return active.slice(0, limit);

  const matched = active.filter((lesson) =>
    lesson.trigger_patterns.some((pat) =>
      cleanHints.some((hint) => patternMatchesTarget(pat, hint)),
    ),
  );

  return (matched.length > 0 ? matched : active).slice(0, limit);
}

export function formatLessonsPrompt(lessons: LessonEntry[]): string {
  if (!lessons.length) return "";
  const lines = [
    "## Active Repository Gotchas (Learned from Previous Laps)",
    ...lessons.map((l) => `- **[${l.topic}]**: ${l.rule} *(Evidence: ${l.evidence})*`),
  ];
  return lines.join("\n");
}

export function buildCuratedAppendPrompts(
  root: string,
  issue: LocalIssue,
  changedFilesList = "",
): string[] {
  if (isHarnessSafeMode(root)) return [];

  const prompts: string[] = [];
  const agentsMdPath = join(root, "AGENTS.md");
  if (existsSync(agentsMdPath)) {
    prompts.push(agentsMdPath);
  }

  const changedHints = changedFilesList
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const textHints = [issue.title, issue.body, ...changedHints];
  const matched = matchRelevantLessons(root, textHints);
  const formatted = formatLessonsPrompt(matched);
  if (formatted) {
    prompts.push(formatted);
  }

  return prompts;
}
