# Autonomous Software Factory Agent Instructions

## Core Philosophy

- **Effective > cheap**: Ship production-grade solutions. Never default to low-effort workarounds.
- **Fail closed**: Unverified or unlabeled work is held; errors fail closed to preserve execution safety.
- **Progressive disclosure**: Keep base instructions lean; consult specialized context pointers as needed.

## Repository Knowledge, Skills & Memory

- **Canonical Configuration**: `AGENTS.md` and `.agents/skills/` are authoritative sources of truth. Compatibility symlinks (`CLAUDE.md -> AGENTS.md`, `.claude/skills -> ../.agents/skills`) mirror them for tool support.
- **Repository Skills**: Canonical playbooks live in `.agents/skills/`. Consult when triggered:
  - Spec drafting, product shaping & architecture: `/animus-brainstorm`, `/animus-grill`, `/animus-spec`, `/animus-architecture`, `/animus-tickets`
  - Implementation & verification: `/animus-implement`, `.agents/skills/tdd`, `.agents/skills/blueprint`, `.agents/skills/security-hardening`
  - Failure recovery & root-causing: `/diagnosing-bugs`, `.agents/skills/unstick`
  - Frontend & UI verification: `.agents/skills/ui-quality`
  - Code review & standards: `/animus-review`
  - Post-lap memory & lesson synthesis: `/animus-harness`, `.agents/skills/writing-for-agents`, `.agents/skills/skill-creator`
- **Learned Repo Playbooks** (synthesized via `/animus-harness` from past issue laps):
  - When implementing or repairing governance policy verifiers, read `.agents/skills/policy-verifier-regressions/SKILL.md` and follow it.
- **Verified Tool Guidance**: Inspect `.factory/tool-guidance.json` for validated CLI recipes (test, lint, format, typecheck, build) that exited code 0.
- **Evidence-Backed Lessons**: Inspect `.factory/lessons.jsonl` for repo-specific gotchas matching target files before editing.
- **Harness Authoring Standard**: Adhere to `docs/agents/harness-authoring-standard.md` when curating lessons or skills.
- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when `.factory/NO_HARNESS_MEMORY` is present.

## Domain & Workflow Documentation

- **PR & Evidence Contract**: Read `docs/agents/pr-evidence-contract.md` for canonical PR bodies, evidence matrices, Before/After captures, and finding rechecks.
- **Issue Tracker, Dependencies & Triage Labels**: Read `docs/agents/issue-tracker.md` for `gh` conventions, native/textual `Depends on:` rules, and canonical triage labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`, `wontfix`, `spec`, `needs-owner`).
- **Domain Models & ADRs**: Read `docs/agents/domain.md` for glossary terms, architecture docs, and ADR conventions.

## Execution Rules

- **Red → Green Loop**: Test-first at agreed public seams using `.agents/skills/tdd`. Never mock internals or write tautological assertions.
- **Blueprint & Two-Strike Unstick**: Compile domain types and stub signatures before bodies (`.agents/skills/blueprint`). After 2 consecutive check failures, stop editing, probe the shared assumption, and revert scratch debris (`.agents/skills/unstick`).
- **Offline Invariant**: Test suites run offline with zero live network calls. Use injectable mock transports for external APIs (e.g., OpenRouter / Jev).
- **Clean Cutover**: Migrate all callers when modifying contracts; never leave deprecated shims, narration comments, or duplicate conventions.
