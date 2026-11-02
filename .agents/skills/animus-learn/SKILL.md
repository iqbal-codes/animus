---
name: animus-learn
description: Synthesize post-lap memory, extract verified tool guidance and evidence-backed lessons, and author repository skills with observable completion criteria.
disable-model-invocation: true
---

# Animus Learn: Post-Lap Reflection & Memory Synthesis

Authoritative procedure for extracting, curating, and persisting repository lessons, tool guidance, and procedural skills after delivery laps.

## When to Use

Use `/animus-learn` when:
- A delivery lap has completed, and you need to capture discovered quirks, CLI recipes, or gotchas.
- The repository requires updating `.factory/tool-guidance.json` with verified zero-exit commands.
- You need to evaluate candidate lessons through TypeSafe Jev System 1 curation before persisting them to `.factory/lessons.jsonl`.
- You are authoring or updating multi-step procedural skills in `.agents/skills/` or `.claude/skills/`.

## Steps

1. **Inspect Lap Execution Logs and Artifacts**
   Review terminal command histories, test runner outputs, and reviewer verdicts from the completed lap to identify error-to-success transitions and recurring friction points. Compile raw candidate observations citing specific log lines or lap identifiers.
   *Completion Criterion*: A structured list of raw candidate observations citing specific log lines or lap identifiers is compiled.

2. **Extract and Verify Working Tool Commands**
   Verify that discovered test, lint, format, typecheck, or build commands exit with code 0 before updating `.factory/tool-guidance.json`. Run each candidate command in the local terminal to confirm successful completion.
   *Completion Criterion*: Each tool guidance command is executed in the local environment and exits with code 0 before recording.

3. **Formulate and Gate Candidate Lessons with TypeSafe Jev**
   Format candidate lessons into structured JSON Lines adhering to `docs/agents/harness-authoring-standard.md` (positive imperative phrasing, at most 2 sentences, trigger patterns, and grounded evidence). Evaluate candidates via TypeSafe Jev System 1; persist candidates with calibrated confidence at or above 0.70 and clear of hallucination flags.
   *Completion Criterion*: Only Jev-approved lessons (confidence >= 0.70) are appended to `.factory/lessons.jsonl`.

4. **Author or Update Reusable Repository Skills**
   When procedural knowledge spans multiple steps, author or update a skill in `.agents/skills/<name>/SKILL.md`. Ensure every step contains an observable completion criterion and valid YAML frontmatter per `.agents/skills/writing-for-agents/SKILL.md`.
   *Completion Criterion*: New or updated skills pass YAML parsing and every step concludes with an explicit `*Completion Criterion*`.

5. **Verify Integrity and Commit to Repository Memory**
   Run the repository check suite (`bun harness/ci.ts`) and inspect `.factory/` files to ensure all JSON and JSONL entries parse without error and `AGENTS.md` remains under 150 lines. Stage and commit verified updates to repository memory.
   *Completion Criterion*: Check suite passes cleanly and verified memory updates are committed to the branch.
