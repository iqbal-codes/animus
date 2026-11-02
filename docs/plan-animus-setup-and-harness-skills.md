# Implementation Plan: Deterministic `animus setup` & Agentic Harness Skills (`/animus-harness`, `/animus-learn`, `/animus-architecture`)

## 1. Problem & Goal

Currently, `animus setup` (`scripts/cli/commands/setup.ts` and `scripts/cli/commands/harness-scaffold.ts`) mixes deterministic CLI scaffolding with brittle, non-LLM heuristics that attempt codebase analysis:
1. **Late / Missing Git & GitHub Preflight**: `applyRepositorySetup()` does not check for a `.git` checkout/worktree or a GitHub `origin` remote upfront. Running `animus setup` in a non-git directory or a non-GitHub repo runs the entire wizard and writes files to disk before failing at enrollment—and with `--local-only` or mutating `animus config` subcommands, it succeeds completely without `.git` or a GitHub remote.
2. **Hardcoded Machine-Specific Models**: `DEFAULT_PROVIDER_MODELS` in `scripts/cli/commands/setup.ts:83-110` hardcodes local proxy models (`router/ag/gemini-3.8-flash`, `router/cx/gpt-6.1-sol`, `9router/...`) and static vendor model strings instead of defaulting to the selected harness's own CLI default (`"default"`).
3. **Rigid Pseudo-LLM Scaffolding in CLI**:
   - `auditAgentsMd()` scores `AGENTS.md` (0–100) using crude character/line-count and regex heuristics, and `"upgrade"` mode concatenates templates and hard-truncates existing `AGENTS.md` at 60/148 lines (`scripts/cli/commands/harness-scaffold.ts:75-138, 230-252`).
   - `setup.ts:760-767` populates `.factory/tool-guidance.json` with unverified hardcoded commands (`test: "bun harness/ci.ts"`, `format: "bun run format"`, `build: "bun run build:web"`) even on non-Bun/non-TS repositories.
   - `harness-scaffold.ts:364-379, 711-744` writes fake holdout scenario `H-01` into `.factory/holdout/HOLDOUT.md` and opinionated prose into `.factory/codebase-rules.json`.
4. **Skill Overload & Missing Brownfield Remediation**:
   - `.agents/skills/animus-harness/SKILL.md` only handles post-lap reflection (used by the `reflector` role), leaving no dedicated skill for interactive initial harness setup / self-check in the user's coding agent.
   - `.agents/skills/animus-architecture/SKILL.md` assumes brownfield repositories can skip architecture, lacking a workflow for remediating messy brownfield codebases via target-state topology, legacy fencing, and Foundation Slice (`S0`) prerequisites.

---

## 2. Acceptance Criteria & Invariants

- **AC1 (Fail-Closed Git + GitHub Preflight)**:
  - `verifyGitHubRepositoryPreflight(repoRoot)` runs in `applyRepositorySetup()` (right after numeric/provider flag validation, before any interactive prompts or file writes, including when `--local-only` is set) AND before any mutating subcommand in `runConfigCliCommand()` (`tier`, `laps`, `schedule`, `harness`, `pattern`, `component`, `rule`).
  - Reuses a single canonical GitHub remote parser (`parseGitHubRemoteUrl` exported from `scripts/cli/commands/onboarding-registration.ts`) requiring the `github.com` host and supporting HTTPS (with optional credentials/tokens), SCP-style SSH (`git@github.com:owner/repo.git`), and `ssh://git@github.com(:port)/owner/repo.git`, as well as Git worktrees (`git -C <repoRoot> rev-parse --is-inside-work-tree` and `--show-toplevel`).
  - Fails closed with a clear error and writes zero files if `.git` is missing, `origin` is missing, or `origin` is a non-GitHub remote (e.g., GitLab/Bitbucket).
- **AC2 (Harness Default Model by Default)**:
  - `DEFAULT_PROVIDER_MODELS` in `scripts/cli/commands/setup.ts` sets `small: "default"`, `medium: "default"`, `large: "default"` for all supported providers (`pi`, `claude`, `omp`, `codex`, `opencode`). Remove all `router/ag/gemini-3.8-flash`, `9router/...`, and `gpt-6.1-sol` defaults from `setup.ts`, `scripts/cli/help.ts`, and `.animus/config.yaml`.
  - In interactive tier model selection: when `catalog.models.length > 0`, prepend `{ value: "default", label: "Harness default (use CLI default model)" }` to `prompts.select`; when `catalog.models.length === 0`, keep `await ask("Model ID", initialModel)` where `initialModel` defaults to `"default"`. When `"default"` is selected in the wizard, skip `"Model capabilities unknown."` and default the reasoning effort selector to `"default"`.
  - `buildProviderArgv()` in `scripts/loop/providers.ts` omits `--model` when `options.model` is `undefined`, `""`, or `"default"`, while `resolveModelForRole()` (`scripts/loop/config.ts`) still returns `"default"` so backend monitor readiness (`apps/backend/src/monitor/runtime.ts:116-119`) recognizes the tier as configured.
- **AC3 (Pure Deterministic Scaffolding in `animus setup`)**:
  - `harness-scaffold.ts` removes heuristic scoring (`auditAgentsMd` 0–100 score and regex penalties) and removes the line-slicing `"upgrade"` mode (`--agents-md` supports `"keep" | "overwrite"`, defaulting to `"keep"` when `AGENTS.md` exists and creating from template only when `AGENTS.md` is missing; passing `upgrade` is rejected at CLI validation).
  - `AgentsMdAudit`, `HarnessAuditReport`, `ScaffoldHarnessResult.agentsMdActionTaken` (`"created" | "overwritten" | "kept"`), and all 4 CLI display sites in `scripts/cli/commands/setup.ts` (`lines 538, 822, 898, 949`) are updated to report factual state (`status: "present" | "missing"`, `lineCount`, `hasCanonicalPointers`, `missingSections`) with zero references to `.score` or `"upgraded"`, and `setup.ts:905, 933` uses `CANONICAL_SKILL_NAMES.length` instead of hardcoded `/10`.
  - `.factory/codebase-rules.json` is scaffolded as an empty structural skeleton (`{ schema_version: 1, rules: [], pattern_registry: {} }`).
  - `.factory/holdout/HOLDOUT.md` is scaffolded with the fenced header only (zero fake `H-01` scenarios).
  - `.factory/tool-guidance.json` only records real, non-noop `staticCheck` / `unitTest` values configured during setup (`existingTools.test ?? unitTest`, never forcing `"bun harness/ci.ts"` on non-Bun stacks and never injecting fake `"bun run format"` or `"bun run build:web"`).
  - CLI completion output prints a clear next-step instruction to run `/animus-harness` in the user's coding agent.
- **AC4 (Split `/animus-learn` and `/animus-harness` Skills with Proper Authoring Standards)**:
  - Both skills adhere to `.agents/skills/writing-for-agents/SKILL.md` and `docs/agents/harness-authoring-standard.md`: strictly `<= 150` lines, positive imperatives, numbered steps where every step ends with an explicit `*Completion Criterion*`, and `disable-model-invocation: true` in YAML frontmatter.
  - **`.agents/skills/animus-learn/SKILL.md`**: Owns post-lap reflection, contrastive trajectory analysis, Jev System 1 lesson gating (`.factory/lessons.jsonl`), and learned skill promotion. Wired to the `reflector` role in `scripts/loop/harness-memory.ts:80` (replacing `animus-harness` in `reflector`, while both `animus-harness` and `animus-learn` remain in `NON_BUILDER_SKILLS`).
  - **`.agents/skills/animus-harness/SKILL.md`**: Owns interactive repository harness setup (greenfield & brownfield) and harness self-check/audit inside the operator's personal harness (`pi`, `claude`, `omp`, `codex`):
    1. Plumbing & fence self-check (`.animus/config.yaml`, `.factory/schedule.json`, hooks, symlinks, `.ignore`).
    2. Toolchain discovery & live `exit 0` verification before writing `harness/harness.config.json` and `.factory/tool-guidance.json` (stopping fail-closed if baseline checks are missing or red in brownfield, forbidding no-op stubs `true`, `:`, `echo`, `exit 0`, or routing greenfield repos with no manifest/code yet to `/animus-architecture`).
    3. Codebase structure & convention audit: maps clean brownfields directly into `AGENTS.md` (<= 150 lines); for messy brownfields with conflicting patterns or missing module seams, applies **"Canonicalize & Fence"** using positive target-state markers (`[LEGACY - FREEZE]` / `[FROZEN - TARGET IN <canonical-module>]`), records `mode: "warn"` or target-scoped rules in `.factory/codebase-rules.json` so `S0` refactoring is never deadlocked, and hands off to `/animus-architecture`.
    4. Domain holdout authoring in `.factory/holdout/HOLDOUT.md`.
- **AC5 (Brownfield Restructure Mode in `/animus-architecture`)**:
  - Update `.agents/skills/animus-architecture/SKILL.md` (`disable-model-invocation: true`, `<= 150` lines) to support both **Greenfield Architecture** and **Messy Brownfield Remediation**:
    - Reads `[LEGACY - FREEZE]` markers in `AGENTS.md` and `.factory/codebase-rules.json` alongside product specs.
    - Maps *As-Is vs Target-Be* topology (`Retained Core Seams (Keep)`, `Frozen / Legacy Paths ([LEGACY - FREEZE])`, `Target Seams & Strangler Path`) in `docs/architecture.md`.
    - Consolidates duplicated ad-hoc patterns into the **Shared Reusable Component & Module Catalog**.
    - Defines **Foundation / Strangler Slice (`S0`)** prerequisites in `docs/architecture.md` and enforces module boundary rules in `.factory/codebase-rules.json` and `AGENTS.md` before `/animus-tickets` decomposition.
    - Updates `AGENTS.md`, `factory/templates/AGENTS.template.md`, `docs/onboarding.md`, and `docs/spec-post-loop-self-improving-harness.md` for `/animus-harness` and `/animus-learn`.
