# Harness Authoring Standard: Repository Memory & Skills

Authoritative guide for formatting rules, imperative style, and schema constraints for agent-authored repository memory, tool guidance, and procedural skills.

## 1. Core Principles

- **Imperative and Positive**: Frame instructions as direct actions to take, not vague negative proverbs or conversational essays. Say "Use X when Y" instead of "You should try to avoid doing Z unless...".
- **Maximum 2 Sentences Per Rule**: Every lesson rule must be concise and self-contained, limited to at most 2 sentences. Context window attention is scarce.
- **Evidence-Grounded**: Zero unverified assumptions. The `evidence` field of every lesson must cite exact lap runs, log lines, or commit transitions where the rule was confirmed.

## 2. Lessons Schema (`.factory/lessons.jsonl`)

Each line in `.factory/lessons.jsonl` must be a valid JSON object matching this schema:

```json
{
  "id": "lsn-<YYYYMMDD>-<seq>",
  "topic": "<kebab-case-topic>",
  "trigger_patterns": ["<glob-pattern-1>", "<glob-pattern-2>"],
  "rule": "<imperative instruction, maximum 2 sentences>",
  "evidence": "<concrete log line, lap id, or test result proving the gotcha>",
  "vetoed": false,
  "created_at": "<ISO-8601-UTC-timestamp>"
}
```

### Constraints
1. `id`: Unique identifier prefixed with `lsn-` followed by date and sequence.
2. `rule`: Strictly imperative, maximum 2 sentences.
3. `evidence`: Must cite verifiable execution evidence.
4. `vetoed`: Boolean flag indicating if an operator deprecated this lesson.

## 3. Tool Guidance Schema (`.factory/tool-guidance.json`)

Verified CLI recipes must exit with code 0 before recording:

```json
{
  "test": "python3 -m unittest discover -s tests",
  "lint": "ruff check .",
  "format": "ruff format --check .",
  "typecheck": "mypy .",
  "build": "python3 setup.py build"
}
```

If a command fails during an execution lap due to environment changes, its status must be invalidated or flagged as deprecated.

## 4. Repository Skills Schema (`.claude/skills/<name>/SKILL.md`)

Procedural playbooks must follow this layout:
1. Standard YAML frontmatter with `name`, `description`, and `disable-model-invocation: true` if human/orchestrator invoked.
2. `## When to Use`: Clear, unambiguous triggering conditions.
3. `## Steps`: Numbered steps where each step concludes with an explicit `*Completion Criterion*`.
