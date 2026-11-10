# Autonomous Software Factory Agent Instructions

## Core Philosophy

- **Effective > cheap**: Ship production-grade solutions. Never default to low-effort workarounds.
- **Fail closed**: Unverified or unlabeled work is held; errors fail closed to preserve execution safety.
- **Progressive disclosure**: Keep base instructions lean; consult specialized context pointers as needed.

## Repository Knowledge, Skills & Memory

- **Canonical Configuration**: `AGENTS.md` and `.agents/skills/` are authoritative sources of truth. Compatibility symlinks (`CLAUDE.md -> AGENTS.md`, `.claude/skills -> ../.agents/skills`) mirror them for tool support.
- **Stage & Workflow Boundary**: Stage playbooks in `.agents/skills/` (`animus-*`, `retro`, `pr`, `skill-creator`, `writing-for-agents`) are **strictly user- or engine-invoked (`disable-model-invocation: true`)**. Never self-invoke, read, chain, or combine stage playbooks unless explicitly requested for the current turn; when an interactive skill is invoked, follow only that skill without layering extra review or coordinator stages.
- **Learned Repo Playbooks** (synthesized via `/animus-learn` from past issue laps):
  - When implementing or repairing governance policy verifiers, read `.agents/skills/policy-verifier-regressions/SKILL.md` and follow it.
- **Verified Tool Guidance**: Inspect `.factory/tool-guidance.json` for validated CLI recipes (test, lint, format, typecheck, build) that exited code 0.
- **Execution Authority Cutover**: Read `docs/authority-cutover.md` before changing the authority marker, migration 15, legacy launchers, webhook classification or cutover CLI/app surfaces. There is one durable `execution-authority.json` (`legacy|migrating|local`); never add a second marker, engine or workflow database.
- **Evidence-Backed Lessons**: Inspect `.factory/lessons.jsonl` for repo-specific gotchas matching target files before editing.
- **Harness Authoring Standard**: Adhere to `docs/agents/harness-authoring-standard.md` when curating lessons or skills.
- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when `.factory/NO_HARNESS_MEMORY` is present.

## Domain & Workflow Documentation

- **PR & Evidence Contract**: Read `docs/agents/pr-evidence-contract.md` for canonical PR bodies, evidence matrices, Before/After captures, and finding rechecks.
- **Issue Tracker, Dependencies & Triage Labels**: Read `docs/agents/issue-tracker.md` for `gh` conventions, native/textual `Depends on:` rules, and canonical triage labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`, `wontfix`, `spec`, `needs-owner`).
- **Domain Models & ADRs**: Read `docs/agents/domain.md` for glossary terms, architecture docs, and ADR conventions.
- **Document Lifecycle**: `docs/README.md` indexes every document with `Status: Active|Draft|Historical|Superseded`. Implement only from `Active`; treat `Historical` and `Superseded` as provenance, follow the named replacement for superseded work, and never add an unindexed file under `docs/`.

## Execution Rules

- **Pre-Commit CI Invariant**: Deterministic static checks (architecture, format, lint, typecheck) run on commit, while full test suites run during targeted verification or when `ANIMUS_PRECOMMIT_FULL_TEST=1` is set. Bypassing git hooks with `--no-verify` or `-n` is forbidden and blocked.
- **Red → Green Loop**: Test-first at agreed public seams using `.agents/skills/tdd`. Never mock internals or write tautological assertions.
- **Blueprint & Two-Strike Unstick**: Compile domain types and stub signatures before bodies (`.agents/skills/blueprint`). After 2 consecutive check failures, stop editing, probe the shared assumption, and revert scratch debris (`.agents/skills/unstick`).
- **Offline Invariant**: Test suites run offline with zero live network calls. Use injectable mock transports for external APIs (e.g., OpenRouter / Jev).
- **Clean Cutover**: Migrate all callers when modifying contracts; never leave deprecated shims, narration comments, or duplicate conventions.
