import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LocalIssue } from "../../scripts/loop/types";
const issue: LocalIssue = {
  title: "scripts/queue.ts",
  body: "",
  number: 1,
  url: "",
  comments: [],
  dependencies: [],
  activeClaim: false,
};
import {
  buildCuratedAppendPrompts,
  loadActiveLessons,
  matchRelevantLessons,
  resolveAllowedSkills,
  resolveLoopExtensions,
} from "../../scripts/loop/harness-memory";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-memory-safety-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.invalid");
  return root;
}
function commit(root: string): string {
  git(root, "add", ".");
  git(root, "commit", "-m", "accepted baseline");
  return git(root, "rev-parse", "HEAD");
}
const lesson = {
  id: "queue",
  topic: "queue",
  trigger_patterns: ["scripts/queue.ts"],
  rule: "Preserve queue ordering",
  evidence: "accepted run",
  vetoed: false,
  created_at: "2026-01-01",
};

test("lessons are relevant-only, including empty hints and near-miss paths", () => {
  const root = repository();
  put(root, ".factory/lessons.jsonl", JSON.stringify(lesson));
  commit(root);
  expect(matchRelevantLessons(root, ["scripts/queue.ts"]).map((l) => l.id)).toEqual(["queue"]);
  expect(matchRelevantLessons(root, [])).toEqual([]);
  expect(matchRelevantLessons(root, ["other.ts"])).toEqual([]);
  expect(matchRelevantLessons(root, ["scripts/queue.ts.backup"])).toEqual([]);
  expect(loadActiveLessons(root)).toHaveLength(1);
});

test("dirty and staged lessons and AGENTS never replace accepted committed context", () => {
  const root = repository();
  put(root, ".factory/lessons.jsonl", JSON.stringify(lesson));
  put(root, "AGENTS.md", "Accepted instructions");
  const accepted = commit(root);
  put(root, ".factory/lessons.jsonl", JSON.stringify({ ...lesson, rule: "UNACCEPTED" }));
  put(root, "AGENTS.md", "UNACCEPTED instructions");
  git(root, "add", ".");
  expect(loadActiveLessons(root, accepted).map((l) => l.rule)).toEqual(["Preserve queue ordering"]);
  const prompts = buildCuratedAppendPrompts(root, issue, "", accepted);
  expect(prompts[0]).toBe("Accepted instructions");
  expect(prompts.join("\n")).not.toContain("UNACCEPTED");
});

test("triage role injects exactly 5 planning skills from accepted baseline and fails closed if modified", () => {
  const root = repository();
  const triageSkills = [
    "animus-brainstorm",
    "animus-grill",
    "animus-architecture",
    "animus-spec",
    "animus-tickets",
  ];
  for (const skill of triageSkills) {
    put(root, `.agents/skills/${skill}/SKILL.md`, `Accepted ${skill}`);
  }
  const accepted = commit(root);
  const resolved = resolveAllowedSkills(root, "triage", accepted);
  expect(resolved).toEqual(triageSkills.map((s) => join(root, ".agents/skills", s)));

  // Fails closed if safe mode is enabled
  put(root, ".factory/NO_HARNESS_MEMORY", "");
  expect(resolveAllowedSkills(root, "triage", accepted)).toEqual([]);
  rmSync(join(root, ".factory/NO_HARNESS_MEMORY"));

  // Fails closed if any skill is tampered
  put(root, ".agents/skills/animus-brainstorm/SKILL.md", "TAMPERED");
  expect(resolveAllowedSkills(root, "triage", accepted)).toEqual(
    triageSkills.slice(1).map((s) => join(root, ".agents/skills", s)),
  );
});

test("skills and executable hooks are returned only when disk matches the accepted baseline", () => {
  const root = repository();
  put(root, ".agents/skills/tdd/SKILL.md", "Accepted TDD");
  put(root, ".factory/hooks/loop-guard.ts", "export default () => 'accepted';");
  put(root, "helper.ts", "export const value = 'accepted';");
  const accepted = commit(root);
  expect(resolveAllowedSkills(root, "builder", accepted)).toEqual([
    join(root, ".agents/skills/tdd"),
  ]);
  expect(resolveLoopExtensions(root, accepted)).toEqual([
    join(root, ".factory/hooks/loop-guard.ts"),
  ]);
  git(root, "update-index", "--assume-unchanged", "helper.ts");
  put(root, "helper.ts", "UNACCEPTED hook dependency");
  expect(resolveLoopExtensions(root, accepted)).toEqual([]);
  put(root, ".agents/skills/tdd/SKILL.md", "UNACCEPTED");
  put(root, ".agents/skills/generated/SKILL.md", "UNACCEPTED");
  expect(resolveAllowedSkills(root, "builder", accepted)).toEqual([]);
  expect(resolveLoopExtensions(root, accepted)).toEqual([]);
  git(root, "update-index", "--no-assume-unchanged", "helper.ts");
  commit(root);
  expect(resolveAllowedSkills(root, "builder", accepted)).toEqual([]);
  expect(resolveLoopExtensions(root, accepted)).toEqual([]);
});

test("symlinked skill ancestors and dirty hooks fail closed without executable copies", () => {
  const root = repository();
  put(root, ".agents/skills/tdd/SKILL.md", "Accepted TDD");
  put(root, ".factory/hooks/loop-guard.ts", "export default () => 'accepted';");
  const accepted = commit(root);
  put(root, ".factory/hooks/loop-guard.ts", "throw new Error('unaccepted');");
  expect(resolveLoopExtensions(root, accepted)).toEqual([]);
  const outside = mkdtempSync(join(tmpdir(), "harness-memory-symlink-"));
  roots.push(outside);
  put(outside, "skills/tdd/SKILL.md", "Accepted TDD");
  rmSync(join(root, ".agents"), { recursive: true });
  symlinkSync(outside, join(root, ".agents"));
  expect(resolveAllowedSkills(root, "builder", accepted)).toEqual([]);
});

test("accepted veto tombstones block renamed re-admission and superseded revisions stay inactive", () => {
  const root = repository();
  put(
    root,
    ".factory/lessons.jsonl",
    [
      { ...lesson, id: "old", superseded_by: "new" },
      { ...lesson, id: "new", rule: "Use the new queue invariant" },
      { ...lesson, id: "veto", topic: "unsafe", vetoed: true },
      { ...lesson, id: "renamed", topic: "UNSAFE", rule: "Re-admitted veto" },
      { ...lesson, id: "bad", trigger_patterns: [42] },
    ]
      .map((v) => JSON.stringify(v))
      .join("\n"),
  );
  commit(root);
  expect(matchRelevantLessons(root, ["scripts/queue.ts"]).map((l) => l.id)).toEqual(["new"]);
});

test("linked delivery commits do not become the default accepted memory", () => {
  const root = repository();
  put(root, ".factory/lessons.jsonl", JSON.stringify(lesson));
  put(root, "AGENTS.md", "Accepted instructions");
  commit(root);
  const delivery = join(root, "delivery");
  git(root, "worktree", "add", "-b", "delivery", delivery);
  put(delivery, ".factory/lessons.jsonl", JSON.stringify({ ...lesson, rule: "candidate-only" }));
  put(delivery, "AGENTS.md", "candidate-only");
  commit(delivery);
  expect(loadActiveLessons(delivery).map((l) => l.rule)).toEqual(["Preserve queue ordering"]);
  expect(buildCuratedAppendPrompts(delivery, issue).join("\n")).not.toContain("candidate-only");
});

test("non-Git and invalid baselines fail closed; local safe mode disables accepted context", () => {
  const root = repository();
  put(root, ".factory/lessons.jsonl", JSON.stringify(lesson));
  put(root, "AGENTS.md", "Accepted instructions");
  put(root, ".agents/skills/tdd/SKILL.md", "TDD");
  put(root, ".factory/hooks/loop-guard.ts", "export default () => {};");
  const accepted = commit(root);
  expect(loadActiveLessons(root, "missing-ref")).toEqual([]);
  put(root, ".factory/NO_HARNESS_MEMORY", "");
  expect(loadActiveLessons(root, accepted)).toEqual([]);
  expect(buildCuratedAppendPrompts(root, issue, "", accepted)).toEqual([]);
  expect(resolveAllowedSkills(root, "builder", accepted)).toEqual([]);
  expect(resolveLoopExtensions(root, accepted)).toEqual([]);
  const plain = mkdtempSync(join(tmpdir(), "harness-memory-no-git-"));
  roots.push(plain);
  put(plain, ".factory/lessons.jsonl", JSON.stringify(lesson));
  put(plain, "AGENTS.md", "Unaccepted");
  put(plain, ".agents/skills/tdd/SKILL.md", "Unaccepted");
  put(plain, ".factory/hooks/loop-guard.ts", "Unaccepted");
  expect(loadActiveLessons(plain)).toEqual([]);
  expect(buildCuratedAppendPrompts(plain, issue)).toEqual([]);
  expect(resolveAllowedSkills(plain, "builder")).toEqual([]);
  expect(resolveLoopExtensions(plain)).toEqual([]);
});
