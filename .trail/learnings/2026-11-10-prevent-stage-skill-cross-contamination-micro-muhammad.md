---
title: "Prevent stage skill cross-contamination, micro-ticket fragmentation, and stale exploration notes"
author: Muhammad
date: 2026-11-10
branch: main
id: l-c03a572a
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - factory/templates/AGENTS.template.md
  - scripts/cli/commands/harness-scaffold.ts
  - ".agents/skills/animus-spec/SKILL.md"
  - ".agents/skills/animus-tickets/SKILL.md"
  - ".agents/skills/animus-implement/SKILL.md"
  - ".agents/skills/animus-implement-spec/SKILL.md"
  - ".agents/skills/pr/SKILL.md"
  - ".agents/skills/skill-creator/SKILL.md"
  - ".agents/skills/writing-for-agents/SKILL.md"
  - ".githooks/pre-commit"
---

## Decided
- 1. Replaced the explicit catalog of stage playbooks in AGENTS.md, factory/templates/AGENTS.template.md, and scripts/cli/commands/harness-scaffold.ts with a strict Stage & Workflow Boundary forbidding agents from self-invoking, reading, or chaining stage playbooks unless explicitly requested.
2. Locked .agents/skills/{skill-creator,writing-for-agents,pr}/SKILL.md with disable-model-invocation: true.
3. Updated animus-tickets to size work into 2-4 coarse-grained cohesive milestones with stable module/domain seam pointers rather than brittle line numbers.
4. Enforced Living Exploration Notes & Codebase Truth in animus-implement-spec and animus-implement: exploration notes are an orientation index updated with append-on-merge deltas as upstream tickets integrate, while child builders must verify live integration-branch signatures via code-graph tools (trail_ask, trail_skeleton, trail_callers).
5. Made Gate 4 full-suite test execution in .githooks/pre-commit opt-in via ANIMUS_PRECOMMIT_FULL_TEST=1 while keeping architecture, format, lint, and typecheck mandatory on every commit.
## Tried and ruled out
- Static one-shot exploration artifacts without live codebase verification (goes stale after upstream tickets land and causes builders to miss newly added seams); running the full 1,384-test suite inside every pre-commit hook invocation during intermediate TDD commits.
## Watch out
- Keep required auditAgentsMd pointers (.agents/skills/, .factory/tool-guidance.json, .factory/lessons.jsonl, tdd) in AGENTS.md and keep animus-triage and security-hardening with disable-model-invocation: false as verified by loop-modules.bun.test.ts.
