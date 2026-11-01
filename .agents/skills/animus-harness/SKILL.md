---
name: animus-harness
description: Synthesize post-lap memory, extract verified tool guidance and evidence-backed lessons, and author repository skills with observable completion criteria.
disable-model-invocation: true
---

# Animus Harness: Post-Lap Reflection & Memory Synthesis

Authoritative procedure for extracting, curating, and persisting repository lessons, tool guidance, and procedural skills after delivery laps.

## When to Use

Use `/animus-harness` when:
- A delivery lap has completed, and you need to capture discovered quirks, CLI recipes, or gotchas.
- The repository requires updating `.factory/tool-guidance.json` with verified zero-exit commands.
- You need to evaluate candidate lessons through TypeSafe Jev System 1 curation before persisting them to `.factory/lessons.jsonl`.
- You are authoring or updating multi-step procedural skills in `.agents/skills/` or `.claude/skills/`.

## Steps

1. **Inspect Lap Execution Logs and Artifacts**
   Review terminal command histories, test runner outputs, and reviewer verdicts from the completed lap to identify error-to-success transitions and recurring friction points.
   *Completion Criterion*: A structured list of raw candidate observations citing specific log lines or lap identifiers is compiled.

2. **Extract and Verify Working Tool Commands**
   Verify that any discovered test, lint, format, typecheck, or build command exited with code 0 before updating `.factory/tool-guidance.json`.
   *Completion Criterion*: Each tool guidance command is executed in the local environment and exits with code 0 before recording.

3. **Formulate and Gate Candidate Lessons with TypeSafe Jev**
   Format candidate lessons into structured JSON Lines adhering to `docs/agents/harness-authoring-standard.md` (positive imperative phrasing, <= 2 sentences, trigger patterns, and grounded evidence). Evaluate candidates via TypeSafe Jev System 1; reject any candidate with calibrated confidence < 0.70 or hallucination risk flags.
   *Completion Criterion*: Only Jev-approved lessons (confidence >= 0.70) are appended to `.factory/lessons.jsonl`.

4. **Author or Update Reusable Repository Skills**
   When procedural knowledge spans multiple steps, author or update a skill in `.agents/skills/<name>/SKILL.md`. Ensure every step contains an observable completion criterion and valid YAML frontmatter.
   *Completion Criterion*: New or updated skills pass YAML parsing and every step concludes with an explicit `*Completion Criterion*`.

5. **Verify Integrity and Commit to Repository Memory**
   Run `tests/test_skills_integrity.py` and inspect `.factory/` files to ensure all JSON/JSONL entries parse without error and AGENTS.md remains under 150 lines.
   *Completion Criterion*: Test suite passes cleanly and changes are staged in git.
