# $PROJECT_NAME — Autonomous Software Factory Agent Instructions

## Core Philosophy

- **Effective > cheap**: Ship production-grade solutions with complete edge-case coverage.
- **Fail closed**: Hold unverified or unlabeled work; fail closed on errors to preserve execution safety.
- **Progressive disclosure**: Keep base instructions lean (<= 150 lines); consult specialized context pointers below when triggered.

## Repository Knowledge, Skills & Memory

- **Canonical Configuration**: `AGENTS.md` and `.agents/skills/` are authoritative sources of truth (`CLAUDE.md -> AGENTS.md`, `.claude/skills -> ../.agents/skills`).
- **Repository Skills**: Consult playbooks in `.agents/skills/` when triggered:
  - Spec drafting, product shaping & architecture: `/animus-brainstorm`, `/animus-grill`, `/animus-spec`, `/animus-architecture`, `/animus-tickets`
  - Implementation & verification: `/animus-implement`, `.agents/skills/tdd/SKILL.md`, `.agents/skills/blueprint/SKILL.md`
  - Failure recovery & root-causing: `/diagnosing-bugs`, `.agents/skills/unstick/SKILL.md`
  - Frontend & UI verification: `.agents/skills/ui-quality/SKILL.md`
  - Code review & standards: `/animus-review`
  - Post-lap memory & lesson synthesis: `/animus-harness`, `.agents/skills/writing-for-agents/SKILL.md`, `.agents/skills/skill-creator/SKILL.md`
- **Verified Tool Guidance**: Inspect `.factory/tool-guidance.json` for validated CLI recipes (`static`: `$STATIC_CHECK`, `unit`: `$UNIT_TEST`).
- **Evidence-Backed Lessons**: Inspect `.factory/lessons.jsonl` for repository-specific gotchas matching target files before editing.
- **Harness Authoring Standard**: Adhere to `docs/agents/harness-authoring-standard.md` when curating lessons, rules, or skills.
- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when `.factory/NO_HARNESS_MEMORY` is present.

## Domain & Workflow Documentation

- **PR & Evidence Contract**: Read `docs/agents/pr-evidence-contract.md` for canonical PR bodies, evidence matrices, Before/After captures, and finding rechecks.
- **Issue Tracker, Dependencies & Triage Labels**: Read `docs/agents/issue-tracker.md` for `gh` conventions, `Depends on:` rules, and canonical triage labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`, `wontfix`, `spec`, `needs-owner`).
- **Domain Models & ADRs**: Read `docs/agents/domain.md`, `GLOSSARY.md`, and `docs/adr/` before modifying domain models or architectural boundaries.

## Execution Rules

- **Red -> Green Loop**: Write failing tests first at agreed public seams using `.agents/skills/tdd/SKILL.md`, then implement minimal passing code.
- **Blueprint & Two-Strike Unstick**: Compile domain types and stub signatures before bodies (`.agents/skills/blueprint/SKILL.md`). After 2 consecutive check failures, stop editing, probe the shared assumption, and revert scratch debris (`.agents/skills/unstick/SKILL.md`).
- **Protected Governance Paths**: Keep `MISSION.md`, `FACTORY.md`, `FACTORY_RULES.md`, `harness/**`, `.factory/holdout/**`, and `.factory/hooks/**` untouched during delivery laps.
- **Clean Cutover**: Migrate all callers when modifying contracts; keep one canonical implementation without deprecated shims.
