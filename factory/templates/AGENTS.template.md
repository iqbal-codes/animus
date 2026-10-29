# $PROJECT_NAME — Autonomous Software Factory Agent Instructions

## Core Philosophy

- **Effective > cheap**: Ship production-grade solutions with complete edge-case coverage.
- **Fail closed**: Hold unverified or unlabeled work; fail closed on errors to preserve execution safety.
- **Progressive disclosure**: Keep base instructions lean (<= 150 lines); consult specialized context pointers below when triggered.

## Repository Knowledge, Skills & Memory

- **Canonical Configuration**: `AGENTS.md` and `.agents/skills/` are authoritative sources of truth (`CLAUDE.md -> AGENTS.md`, `.claude/skills -> ../.agents/skills`).
- **Repository Skills**: Consult playbooks in `.agents/skills/` when triggered:
  - Spec drafting & breakdown: `/factory-grill`, `/factory-spec`, `/factory-tickets`
  - Implementation & verification: `/factory-implement`, `.agents/skills/tdd/SKILL.md`
  - Code review & standards: `/factory-review`
  - Defect root-causing: `/diagnosing-bugs`
  - Post-lap memory & lesson synthesis: `/factory-harness`, `.agents/skills/writing-for-agents/SKILL.md`, `.agents/skills/skill-creator/SKILL.md`
- **Verified Tool Guidance**: Inspect `.factory/tool-guidance.json` for validated CLI recipes (`static`: `$STATIC_CHECK`, `unit`: `$UNIT_TEST`).
- **Evidence-Backed Lessons**: Inspect `.factory/lessons.jsonl` for repository-specific gotchas matching target files before editing.
- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when `.factory/NO_HARNESS_MEMORY` is present.

## Domain & Workflow Documentation

- **Engineering & SDLC Workflow**: Read `docs/agents/software-factory-workflow.md` for stage handoffs (`grill -> spec -> tickets -> implement -> review`).
- **Domain Models & ADRs**: Read `docs/agents/domain.md`, `GLOSSARY.md`, and `docs/adr/` before modifying domain models or architectural boundaries.

## Execution Rules

- **Red -> Green Loop**: Write failing tests first at agreed public seams using `.agents/skills/tdd/SKILL.md`, then implement minimal passing code.
- **Protected Governance Paths**: Keep `MISSION.md`, `FACTORY.md`, `FACTORY_RULES.md`, `harness/**`, `.factory/holdout/**`, and `.factory/hooks/**` untouched during delivery laps.
- **Clean Cutover**: Migrate all callers when modifying contracts; keep one canonical implementation without deprecated shims.
