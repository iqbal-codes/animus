# Harness Authoring Standard: Repository Memory & Skills

Authoritative schema and formatting constraints for agent-authored repository memory (`.factory/*`) and procedural skills (`.agents/skills/<name>/SKILL.md`). For context-pointer design, information hierarchy, and completion-criteria mechanics, follow `.agents/skills/writing-for-agents/SKILL.md`.

## 1. Core Principles & 5-Level Enforcement Hierarchy

- **Imperative and Positive**: Frame every rule as a direct action to take ("Assign an explicit non-zero port..."), never a leading negation ("Do not pass port 0...").
- **Maximum 2 Sentences Per Rule**: Keep each lesson rule self-contained and at most 2 sentences.
- **Evidence-Grounded**: Cite exact lap runs, log lines, file paths, or error-to-pass commit transitions in `evidence`.
- **Structure Over Prose (5-Level Hierarchy)**: Encode durable fixes at the highest applicable structural level rather than defaulting to prose lessons:
  1. **Structure (`pattern_registry`)**: Consolidate to one canonical module/component owner and delete superseded patterns.
  2. **Types & Signatures**: Make illegal states unrepresentable with discriminated unions, boundary `unknown` parsing, and exhaustive `never` checks.
  3. **Automated Guard Rule (`rules` in `codebase-rules.json`)**: Block or warn on repeatable syntax/API pitfalls via regex/glob guards with a `replacement_hint`.
  4. **Verified Tool Recipe (`tool-guidance.json`)**: Record zero-exit CLI verification commands.
  5. **Prose Lesson (`lessons.jsonl`)**: Reserve for judgment calls that levels 1–4 cannot enforce mechanically.

## 2. Codebase Rules & Pattern Registry Schema (`.factory/codebase-rules.json`)

`.factory/codebase-rules.json` stores automated static guard rules and the repository's canonical pattern registry:

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

## 3. Lessons Schema (`.factory/lessons.jsonl`)

Each line in `.factory/lessons.jsonl` must be a valid JSON object matching this schema:

```json
{
  "id": "lsn-<YYYYMMDD>-<seq>",
  "topic": "<kebab-case-topic>",
  "trigger_patterns": ["<glob-pattern-1>", "<glob-pattern-2>"],
  "rule": "<positive imperative instruction, maximum 2 sentences>",
  "evidence": "<concrete log line, lap id, or test transition proving the gotcha>",
  "vetoed": false,
  "created_at": "<ISO-8601-UTC-timestamp>"
}
```

### Constraints
1. `id`: Unique identifier prefixed with `lsn-` followed by UTC date and sequence.
2. `rule`: Strictly positive imperative (no leading `do not`, `don't`, `never`, or `avoid`), maximum 2 sentences.
3. `trigger_patterns`: Non-empty array of file globs selecting when the lesson is injected.
4. `evidence`: Verifiable execution evidence grounded in lap logs or commits (calibrated Jev confidence $ge 0.70$).
5. `vetoed`: Boolean flag indicating whether an operator deprecated the lesson.

## 4. Tool Guidance Schema (`.factory/tool-guidance.json`)

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

Procedural playbooks in `.agents/skills/<name>/SKILL.md` must stay $le 150$ lines and follow this layout:
1. **YAML Frontmatter**: `name`, front-loaded trigger `description`, and `disable-model-invocation: true` when human/orchestrator invoked.
2. **`## When to Use`**: Clear, unambiguous triggering branches.
3. **`## Steps`**: Numbered procedural steps where every step concludes with an explicit `*Completion Criterion*`.
