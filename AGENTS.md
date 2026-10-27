# Autonomous Software Factory Agent Instructions

## Core Philosophy

- **Effective > cheap**: Never default to low-effort workarounds. Production-grade or it didn't ship.
- **Fail closed**: Unverified or unlabeled work is held; errors fail closed to preserve execution safety.
- **Progressive disclosure**: Keep base instructions lean; consult specialized context pointers as needed.

## Repository Knowledge & Memory

- **Verified Tool Guidance**: Inspect `.factory/tool-guidance.json` for validated CLI recipes (test, lint, format, typecheck, build) that exited code 0.
- **Evidence-Backed Lessons**: Inspect `.factory/lessons.jsonl` for repo-specific gotchas matching your target files before making changes.
- **Harness Authoring Standard**: When persisting lessons or tool updates, strictly adhere to `docs/agents/harness-authoring-standard.md`.
- **Harness Safe Mode**: If `.factory/NO_HARNESS_MEMORY` is present, bypass dynamic harness memory and use base tooling.

## Domain & Workflow Documentation

- **Engineering & SDLC Workflow**: Read `docs/agents/software-factory-workflow.md` for the spec → tickets → implementation → review lifecycle.
- **Issue Tracker & Dependencies**: Read `docs/agents/issue-tracker.md` for `gh` conventions and native/textual dependency requirements.
- **Canonical Triage Labels**: Read `docs/agents/triage-labels.md` for label definitions (`ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`, `wontfix`).
- **Domain Models & ADRs**: Read `docs/agents/domain.md` for glossary terms and architectural decisions.

## Execution Rules

- **Red → Green Loop**: Test-first at agreed public seams using `.claude/skills/tdd`. Never mock internals or write tautological assertions.
- **Offline Invariant**: Test suites run offline with zero live network calls. Use injectable mock transports for external APIs (e.g., OpenRouter / Jev).
- **Clean Cutover**: Migrate all callers when modifying contracts; never leave deprecated shims or duplicate conventions.
