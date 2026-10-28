# Autonomous Software Factory Agent Instructions

## Core Philosophy

- **Effective > cheap**: Ship production-grade solutions. Never default to low-effort workarounds.
- **Fail closed**: Unverified or unlabeled work is held; errors fail closed to preserve execution safety.
- **Progressive disclosure**: Keep base instructions lean; consult specialized context pointers as needed.

## Repository Knowledge, Skills & Memory

- **Canonical Configuration**: `AGENTS.md` and `.agents/skills/` are authoritative sources of truth. Compatibility symlinks (`CLAUDE.md -> AGENTS.md`, `.claude/skills -> ../.agents/skills`) mirror them for tool support.
- **Repository Skills**: Canonical playbooks live in `.agents/skills/`. Consult when triggered:
  - Spec drafting & breakdown: `/factory-grill`, `/factory-spec`, `/factory-tickets`
  - Implementation & verification: `/factory-implement`, `.agents/skills/tdd`
  - Code review & standards: `/factory-review`
  - Defect root-causing: `/diagnosing-bugs`
  - Post-lap memory & lesson synthesis: `/factory-harness`
- **Verified Tool Guidance**: Inspect `.factory/tool-guidance.json` for validated CLI recipes (test, lint, format, typecheck, build) that exited code 0.
- **Evidence-Backed Lessons**: Inspect `.factory/lessons.jsonl` for repo-specific gotchas matching target files before editing.
- **Harness Authoring Standard**: Adhere to `docs/agents/harness-authoring-standard.md` when curating lessons or skills.
- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when `.factory/NO_HARNESS_MEMORY` is present.

## Domain & Workflow Documentation

- **Engineering & SDLC Workflow**: Read `docs/agents/software-factory-workflow.md` for stage handoffs (`grill → spec → tickets → implement → review`).
- **Issue Tracker & Dependencies**: Read `docs/agents/issue-tracker.md` for `gh` conventions and native/textual dependency requirements.
- **Canonical Triage Labels**: Read `docs/agents/triage-labels.md` for label definitions (`ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`, `wontfix`).
- **Domain Models & ADRs**: Read `docs/agents/domain.md` for glossary terms and architectural decisions.

## Execution Rules

- **Red → Green Loop**: Test-first at agreed public seams using `.agents/skills/tdd`. Never mock internals or write tautological assertions.
- **Offline Invariant**: Test suites run offline with zero live network calls. Use injectable mock transports for external APIs (e.g., OpenRouter / Jev).
- **Clean Cutover**: Migrate all callers when modifying contracts; never leave deprecated shims or duplicate conventions.
