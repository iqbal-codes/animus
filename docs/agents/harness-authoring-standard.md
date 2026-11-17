# Harness Authoring Standard: Repository Memory & Skills

- **Status:** Active
- **Last verified:** 2026-11-10

Authoritative schema and formatting constraints for agent-authored repository memory (`.animus/*`) and procedural skills (`.agents/skills/<name>/SKILL.md`). For context-pointer design, information hierarchy, and completion-criteria mechanics, follow `.agents/skills/writing-for-agents/SKILL.md`.

## 1. Core Principles & 7-Level Enforcement Hierarchy

- **Imperative and Positive**: Frame every rule as a direct action to take ("Assign an explicit non-zero port..."), never a leading negation ("Do not pass port 0...").
- **Maximum 2 Sentences Per Rule**: Keep each lesson rule self-contained and at most 2 sentences.
- **Evidence-Grounded**: Cite exact lap runs, log lines, file paths, or error-to-pass commit transitions in `evidence`.
- **Single Enforcement Hierarchy**: Route every improvement by this one table — the routing authority shared by `/retro`, `/animus-learn`, and the loop reflector, which point here instead of restating it. Levels are ordered by what they cost the Builder's context; take the lowest level that can actually enforce the fix, and never downgrade a fix to prose because a higher level is inconvenient:
  1. **Structure (`pattern_registry`)**: Consolidate to one canonical module/component owner and delete superseded patterns.
  2. **Types & Signatures**: Make illegal states unrepresentable with discriminated unions, boundary `unknown` parsing, and exhaustive `never` checks.
  3. **Automated Guard Rule (`rules` in `codebase-rules.json`)**: Block or warn on repeatable syntax/API pitfalls via regex/glob guards with a `replacement_hint`. A guard is admitted only when it replays against the issue's own lap commits: it must block a file a failing lap committed and spare a file the delivered lap committed.
  4. **Verified Tool Recipe (`tool-guidance.json`)**: Record zero-exit CLI verification commands.
  5. **Reviewer Coding Standards (`CODING_STANDARDS.md`)**: Place architectural judgment calls, module-depth expectations, and code-smell rules in `CODING_STANDARDS.md` for the Reviewer, keeping the Builder's context window free of instruction bloat.
  6. **File-Scoped Prose Lesson (`lessons.jsonl`)**: Reserve strictly for file-scoped runtime bug traps that levels 1–5 cannot enforce mechanically.
  7. **Navigation Pointer (`AGENTS.md`)**: Genuine repo-wide navigation pointers only, inside the ≤150-line budget — never a rule that belongs to a lower level.

  Levels 1–5 cost the Builder zero context tokens, level 6 is paid only on matching files, and level 7 is paid on every turn. A finding whose level has no mutation category — types, reviewer standards, navigation pointers — is escalated to the operator with the exact file and line, never downgraded into a lesson.

## 2. Codebase Rules & Pattern Registry Schema (`.animus/codebase-rules.json`)

`.animus/codebase-rules.json` stores automated static guard rules and the repository's canonical pattern registry:

```json
{
  "schema_version": 1,
  "description": "Domain-agnostic codebase conventions & shared pattern registry enforced by loop-guard.ts",
  "rules": [
    {
      "id": "rule-explicit-port",
      "description": "Require explicit port assignment in server startup tests",
      "file_glob": "tests/**/*.test.ts",
      "forbid_regex": "listen\\(0\\)",
      "replacement_hint": "Pass an explicit assigned port via getFreePort() instead of listen(0).",
      "mode": "block"
    }
  ],
  "pattern_registry": {
    "contracts": "Define shared schemas and domain types in packages/contracts with discriminated unions and boundary unknown parsing.",
    "forge_discovery": {
      "file_glob": "apps/backend/src/**/*.ts",
      "guidance": "Use SystemForgeAdapter paginated listIssues and getIssueStates batches."
    }
  }
}
```

## 3. Lessons Schema (`.animus/lessons.jsonl`)

Each line in `.animus/lessons.jsonl` must be a valid JSON object matching this schema:

```json
{
  "id": "lsn-<YYYYMMDD>-<seq>",
  "topic": "<kebab-case-topic>",
  "trigger_patterns": ["<glob-pattern-1>", "<glob-pattern-2>"],
  "rule": "<positive imperative instruction, maximum 2 sentences>",
  "evidence": "<concrete log line, lap id, or test transition proving the gotcha>",
  "vetoed": false,
  "retired": false,
  "created_at": "<ISO-8601-UTC-timestamp>"
}
```

### Constraints
1. `id`: Unique identifier prefixed with `lsn-` followed by UTC date and sequence.
2. `rule`: Strictly positive imperative (no leading `do not`, `don't`, `never`, or `avoid`), maximum 2 sentences.
3. `trigger_patterns`: Non-empty array of file globs selecting when the lesson is injected.
4. `evidence`: Verifiable execution evidence grounded in lap logs or commits (harness-evaluated grounding and quality confidence each at least 0.70).
5. `vetoed`: Boolean flag indicating whether an operator deprecated the lesson.
6. `retired`: Optional boolean set by an admitted `prune` mutation. A retired lesson keeps its line for audit but is never injected into harness memory; `vetoed` remains the operator's stronger action and additionally blocks that topic from being proposed again.

## 4. Tool Guidance Schema (`.animus/tool-guidance.json`)

Every CLI recipe must be executed and verified to exit with code 0 before recording:

```json
{
  "test": "bun harness/ci.ts",
  "lint": "bun run lint",
  "format": "bun run format",
  "typecheck": "bun run typecheck",
  "build": "bun run build:web",
  "verify": "vp run verify-all"
}
```

If a command fails during an execution lap due to environment or toolchain changes, update or invalidate the entry rather than leaving a broken recipe.

## 5. Repository Skills Schema (`.agents/skills/<name>/SKILL.md`)

Procedural playbooks in `.agents/skills/<name>/SKILL.md` must stay $le 150$ lines and follow this layout. That number is this repository's enforceable proxy for the sprawl and progressive-disclosure criterion in `.agents/skills/writing-for-agents/SKILL.md`, which sets no numeric budget of its own: inline what every branch needs, move what only some branches reach behind a context pointer, and split by branch or sequence before adding lines. A file well past 150 lines is sprawl unless every branch genuinely reads all of it; a shorter file that buries its steps behind in-file reference still fails the criterion. Guidance inside vendored method skills (for example `skill-creator`'s "under 500 lines ideal") describes that skill's own ecosystem and does not raise this repository's budget.
1. **YAML Frontmatter**: `name`, front-loaded trigger `description`, and `disable-model-invocation: true` when human/orchestrator invoked.
2. **`## When to Use`**: Clear, unambiguous triggering branches.
3. **`## Steps`**: Numbered procedural steps where every step concludes with an explicit `*Completion Criterion*`.
