# Autonomous Software Factory Agent Instructions

## Core Philosophy

- **Effective > cheap**: Ship production-grade solutions. Never default to low-effort workarounds.
- **Fail closed**: Unverified or unlabeled work is held; errors fail closed to preserve execution safety.
- **Progressive disclosure**: Keep base instructions lean; consult specialized context pointers as needed.

## Repository Knowledge, Skills & Memory

- **Canonical Configuration**: `AGENTS.md` and `.agents/skills/` are authoritative sources of truth. Compatibility symlinks (`CLAUDE.md -> AGENTS.md`, `.claude/skills -> ../.agents/skills`) mirror them for tool support.
- **Stage & Workflow Boundary**: Stage playbooks in `.agents/skills/` (`animus-*`, `retro`, `pr`, `skill-creator`, `writing-for-agents`) are **strictly user- or engine-invoked (`disable-model-invocation: true`)**. Never self-invoke, read, chain, or combine stage playbooks unless explicitly requested for the current turn; when an interactive skill is invoked, follow only that skill without layering extra review or coordinator stages.
- **Repository Skills**: Canonical playbooks live in `.agents/skills/`. Consult when triggered:
  - Skill router: `/animus-ask` (aliases: `/ask-animus`, `/ask-matt`)
  - Repository setup & onboarding: `/animus-setup` (aliases: `/setup-animus-skills`, `/setup-matt-pocock-skills`)
  - Issue triage: `/animus-triage`
  - Spec drafting, product shaping & architecture: `/animus-brainstorm`, `/animus-grill`, `/animus-spec`, `/animus-architecture`, `/animus-tickets`
  - Implementation, PR authoring & verification: `/animus-implement`, `/animus-implement-spec`, `.agents/skills/pr`, `.agents/skills/tdd`, `.agents/skills/blueprint`, `.agents/skills/security-hardening`
  - Failure recovery & root-causing: `/diagnosing-bugs`, `.agents/skills/unstick`
  - Frontend & UI verification: `.agents/skills/ui-quality`
  - Code review & standards: `/animus-review` (enforces `CODING_STANDARDS.md`)
  - Repository harness setup & self-check: `/animus-harness`
  - Retrospective & post-lap memory synthesis: `/retro`, `/animus-learn`, `.agents/skills/writing-for-agents`, `.agents/skills/skill-creator`
- **Learned Repo Playbooks** (synthesized via `/animus-learn` from past issue laps):
  - When implementing or repairing governance policy verifiers, read `.agents/skills/policy-verifier-regressions/SKILL.md` and follow it.
- **Verified Tool Guidance**: Inspect `.animus/tool-guidance.json` for validated CLI recipes (test, lint, format, typecheck, build) that exited code 0.
- **Execution Authority Cutover**: Read `docs/authority-cutover.md` before changing the authority marker, migration 15, legacy launchers, webhook classification or cutover CLI/app surfaces. There is one durable `execution-authority.json` (`legacy|migrating|local`); never add a second marker, engine or workflow database.
- **Evidence-Backed Lessons**: Inspect `.animus/lessons.jsonl` for repo-specific gotchas matching target files before editing.
- **Harness Authoring Standard**: Adhere to `docs/agents/harness-authoring-standard.md` when curating lessons or skills.
- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when `.animus/NO_HARNESS_MEMORY` is present.

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

<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->
