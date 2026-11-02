---
name: animus-harness
description: Bootstrap repository harness configuration in greenfield or brownfield projects and run live harness self-checks from your coding agent.
disable-model-invocation: true
---

# Repository Harness Setup & Self-Check

Bootstrap and verify repository harness configuration, toolchain commands, codebase boundaries, and agent instructions.

## When to Use

Use `/animus-harness` when:
- **Initial Harness Setup (Greenfield & Brownfield)**: Run immediately after `animus setup` to verify commands, audit codebase structure, and author `AGENTS.md`, `.factory/codebase-rules.json`, and `.factory/holdout/HOLDOUT.md`.
- **Harness Self-Check & Audit**: Run on demand to verify plumbing, re-run configured check commands, and audit `AGENTS.md` pointers and holdout fences.

## Steps

1. **Audit Harness Plumbing and Fence Integrity**
   Verify the presence and integrity of core governance files, fence hooks, and compatibility symlinks:
   - Configuration & Schedule: `.animus/config.yaml` and `.factory/schedule.json`.
   - Security Fences & Hooks: `.factory/hooks/loop-guard.ts`, `.factory/hooks/holdout_fence.py`, and `.ignore` (containing `.factory/holdout/`).
   - Agent Symlinks: `CLAUDE.md -> AGENTS.md` and `.claude/skills -> ../.agents/skills`.
   Recreate any missing symlinks or base hooks to ensure complete harness plumbing.
   *Completion Criterion*: All harness plumbing files, ignore patterns, and compatibility symlinks exist and resolve correctly.

2. **Discover and Execute Real Check Commands (`exit 0`)**
   Inspect the repository state and validate real execution checks:
   - For **Greenfield repositories** (no manifest or source code yet): verify base governance files and route directly to `/animus-architecture` to define the tech stack, folder topology, and Foundation Slice (`S0`).
   - For **Brownfield repositories**: discover real `static` (lint/typecheck) and `unit` test commands from the project toolchain. Execute each command directly in the terminal to prove it exits with code 0. Reject no-op placeholders (`true`, `:`, `echo`, `exit 0`) in favor of substantive commands. If baseline checks are missing or failing, stop and help the operator establish a passing baseline check first. Record verified commands in `harness/harness.config.json` and `.factory/tool-guidance.json`.
   *Completion Criterion*: Real static and unit commands execute in the terminal with exit code 0 and are recorded in `harness/harness.config.json` and `.factory/tool-guidance.json`.

3. **Audit Codebase Topology and Apply Canonicalize & Fence**
   Inspect directory structure, module boundaries, and existing conventions:
   - For **clean brownfields**: capture canonical module seams and conventions directly in harness memory.
   - For **messy brownfields** (competing patterns, mixed layers, or missing shared seams): present concrete file evidence to the operator, lock one canonical target pattern for new work, mark superseded paths as `[LEGACY - FREEZE]` or `[FROZEN - TARGET IN <canonical-module>]`, and record target-scoped `block` rules or legacy-path `warn` rules in `.factory/codebase-rules.json` (preserving editability for Foundation Slice `S0`). Recommend `/animus-architecture` to formalize target topology and `S0` refactoring prerequisites.
   *Completion Criterion*: Canonical module seams are mapped, legacy paths carry explicit freeze markers, and `.factory/codebase-rules.json` contains verified rules.

4. **Author or Refine `AGENTS.md` and Domain Holdouts**
   Finalize agent instructions and regression fences:
   - Write or refine `AGENTS.md` strictly within 150 lines following positive imperatives per `.agents/skills/writing-for-agents/SKILL.md`, preserving valid project rules and linking `.agents/skills/`, `.factory/tool-guidance.json`, and `.factory/lessons.jsonl`.
   - Populate `.factory/holdout/HOLDOUT.md` with real end-to-end holdout scenarios (`## H-01 ...`) grounded in the repository's product capabilities.
   *Completion Criterion*: `AGENTS.md` is at or under 150 lines with valid context pointers, and `.factory/holdout/HOLDOUT.md` contains real domain holdout specifications.
