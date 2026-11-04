import { existsSync, lstatSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { LocalIssue, LoopRole } from "./types";

const NON_BUILDER_SKILLS = new Set([
  "animus-triage",
  "animus-brainstorm",
  "animus-grill",
  "animus-spec",
  "animus-architecture",
  "animus-tickets",
  "animus-review",
  "animus-harness",
  "animus-learn",
  "retro",
  "writing-for-agents",
  "skill-creator",
]);

export interface LessonProvenance {
  runId: string;
  candidate: string;
  evidenceHash: string;
}

export interface LessonEntry {
  id: string;
  topic: string;
  trigger_patterns: string[];
  rule: string;
  evidence: string;
  vetoed: boolean;
  occurrence_count?: number;
  revision_id?: string;
  provenance?: LessonProvenance[];
  superseded_by?: string;
  created_at: string;
}

function gitRead(root: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
    });
  } catch { return undefined; }
}

/** Pin this once per lap; a delivery worktree's HEAD is not accepted memory. */
export function resolveAcceptedMemoryRef(root: string, acceptedRef?: string): string | undefined {
  if (acceptedRef !== undefined) {
    return gitRead(root, "rev-parse", "--verify", "--end-of-options", `${acceptedRef}^{commit}`)?.trim();
  }
  const primary = gitRead(root, "worktree", "list", "--porcelain", "-z")?.split("\0")[0]?.replace(/^worktree /, "");
  return primary ? gitRead(primary, "rev-parse", "--verify", "HEAD^{commit}")?.trim() : undefined;
}

function baselineText(root: string, ref: string, path: string): string | undefined {
  const entry = gitRead(root, "ls-tree", ref, "--", path);
  if (!entry?.startsWith("100644 ") && !entry?.startsWith("100755 ")) return undefined;
  return gitRead(root, "show", `${ref}:${path}`);
}

export function isHarnessSafeMode(root: string): boolean {
  return existsSync(join(root, ".factory/NO_HARNESS_MEMORY"));
}

export function resolveAllowedSkills(root: string, role: LoopRole, acceptedRef?: string): string[] {
  if (isHarnessSafeMode(root)) return [];
  const ref = resolveAcceptedMemoryRef(root, acceptedRef);
  if (!ref) return [];

  const repoSkillsDir = join(root, ".agents/skills");
  const candidateNames = new Set<string>();

  switch (role) {
    case "builder": {
      for (const base of [
        "tdd",
        "diagnosing-bugs",
        "animus-implement",
        "animus-implement-spec",
        "unstick",
        "blueprint",
        "ui-quality",
        "security-hardening",
      ]) {
        candidateNames.add(base);
      }
      const entries = gitRead(root, "ls-tree", "--name-only", `${ref}:.agents/skills`);
      for (const name of entries?.trim().split("\n") ?? []) {
        if (!name || NON_BUILDER_SKILLS.has(name)) continue;
        const head = baselineText(root, ref, `.agents/skills/${name}/SKILL.md`);
        if (head !== undefined && !/disable-model-invocation:\s*true/i.test(head.slice(0, 400))) {
          candidateNames.add(name);
        }
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
      candidateNames.add("animus-learn");
      candidateNames.add("retro");
      candidateNames.add("writing-for-agents");
      candidateNames.add("skill-creator");
      break;
    case "triage":
      candidateNames.add("animus-triage");
      candidateNames.add("animus-brainstorm");
      candidateNames.add("animus-grill");
      candidateNames.add("animus-architecture");
      candidateNames.add("animus-spec");
      candidateNames.add("animus-tickets");
      break;
    default:
      break;
  }

  return Array.from(candidateNames)
    .map((name) => join(repoSkillsDir, name))
    .filter((p) => baselineText(root, ref, `.agents/skills/${p.slice(repoSkillsDir.length + 1)}/SKILL.md`) !== undefined
      && baselineDirectoryMatches(root, ref, `.agents/skills/${p.slice(repoSkillsDir.length + 1)}`));
}

function regularRepositoryFile(root: string, file: string): boolean {
  const parts = file.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
  }
  return true;
}

function baselineTrackedFilesMatch(root: string, ref: string): boolean {
  const entries = gitRead(root, "ls-tree", "-r", "-z", ref);
  if (entries === undefined) return false;
  try {
    return entries.split("\0").filter(Boolean).every(entry => {
      const [meta, file] = entry.split("\t");
      return !!file && !!meta?.startsWith("100") && regularRepositoryFile(root, file)
        && gitRead(root, "hash-object", "--no-filters", "--", join(root, file))?.trim() === meta.split(" ")[2];
    });
  } catch { return false; }
}

function baselineDirectoryMatches(root: string, ref: string, path: string): boolean {
  const entries = gitRead(root, "ls-tree", "-r", "-z", ref, "--", path);
  if (!entries) return false;
  const expected = new Set<string>();
  try {
    for (const entry of entries.split("\0").filter(Boolean)) {
      const [meta, file] = entry.split("\t");
      if (!file || !meta?.startsWith("100")) return false;
      expected.add(file);
      if (!regularRepositoryFile(root, file)) return false;
      const blob = gitRead(root, "hash-object", "--no-filters", "--", join(root, file))?.trim();
      if (blob !== meta.split(" ")[2]) return false;
    }
    const visit = (directory: string): boolean => {
      if (!lstatSync(join(root, directory)).isDirectory()) return false;
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        const file = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!visit(file)) return false;
        } else if (!entry.isFile() || !expected.delete(file)) return false;
      }
      return true;
    };
    return visit(path) && expected.size === 0;
  } catch { return false; }
}

export function resolveLoopExtensions(root: string, acceptedRef?: string): string[] {
  if (isHarnessSafeMode(root)) return [];
  const ref = resolveAcceptedMemoryRef(root, acceptedRef);
  if (!ref || baselineText(root, ref, ".factory/hooks/loop-guard.ts") === undefined) return [];
  // Hooks can import repository code: refuse a mismatching checkout rather than copy executable files.
  // Check untracked and modified files, but do not consider standard ignored files (e.g. node_modules, build caches).
  const status = gitRead(root, "status", "--porcelain", "--untracked-files=all") ?? "";
  if (!baselineTrackedFilesMatch(root, ref)
    || gitRead(root, "diff", "--no-ext-diff", "--no-textconv", ref, "--") !== ""
    || status !== ""
    || !baselineDirectoryMatches(root, ref, ".factory/hooks")) return [];
  return [join(root, ".factory/hooks/loop-guard.ts")];
}

export function loadActiveLessons(root: string, acceptedRef?: string): LessonEntry[] {
  if (isHarnessSafeMode(root)) return [];
  const ref = resolveAcceptedMemoryRef(root, acceptedRef);
  if (!ref) return [];
  const raw = baselineText(root, ref, ".factory/lessons.jsonl");
  if (raw === undefined) return [];

  const lessons: LessonEntry[] = [];
  const vetoedTopics = new Set<string>();
  const vetoedIds = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LessonEntry;
      if (parsed?.vetoed === true) {
        if (typeof parsed.topic === "string") vetoedTopics.add(parsed.topic.trim().toLowerCase());
        if (typeof parsed.id === "string") vetoedIds.add(parsed.id);
      }
      if (parsed?.vetoed === false && !parsed.superseded_by
        && typeof parsed.id === "string" && typeof parsed.topic === "string"
        && typeof parsed.evidence === "string" && typeof parsed.rule === "string"
        && Array.isArray(parsed.trigger_patterns)
        && parsed.trigger_patterns.every(pattern => typeof pattern === "string")) {
        lessons.push({ ...parsed, occurrence_count: parsed.occurrence_count ?? 1 });
      }
    } catch {}
  }
  return lessons.filter(lesson => !vetoedIds.has(lesson.id)
    && !vetoedTopics.has(lesson.topic.trim().toLowerCase()));
}

function patternMatchesTarget(pattern: string, target: string): boolean {
  const normPattern = pattern.trim();
  const normTarget = target.trim();
  if (!normPattern || !normTarget) return false;

  try {
    if (new Bun.Glob(normPattern).match(normTarget)) return true;
  } catch {}

  return false;
}

export function matchRelevantLessons(
  root: string,
  targetHints: string[],
  limit = 5,
  acceptedRef?: string,
): LessonEntry[] {
  const active = loadActiveLessons(root, acceptedRef);
  if (!active.length) return [];

  const cleanHints = targetHints.map((h) => h.trim()).filter(Boolean);
  if (!cleanHints.length) return [];

  const matched = active.filter((lesson) =>
    lesson.trigger_patterns.some((pat) =>
      cleanHints.some((hint) => patternMatchesTarget(pat, hint)),
    ),
  );

  return matched.slice(0, Math.max(0, limit));
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
  acceptedRef?: string,
): string[] {
  if (isHarnessSafeMode(root)) return [];
  const ref = resolveAcceptedMemoryRef(root, acceptedRef);
  if (!ref) return [];

  const prompts: string[] = [];
  const agentsMdContent = baselineText(root, ref, "AGENTS.md");
  if (agentsMdContent !== undefined) prompts.push(agentsMdContent);

  const changedHints = changedFilesList
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const textHints = [issue.title, issue.body, ...changedHints];
  const matched = matchRelevantLessons(root, textHints, 5, ref);
  const formatted = formatLessonsPrompt(matched);
  if (formatted) {
    prompts.push(formatted);
  }

  return prompts;
}
