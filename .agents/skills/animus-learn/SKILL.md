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
- You need to evaluate candidate lessons through the configured coding harness before proposing repository memory changes.
- You are authoring or updating multi-step procedural skills in `.agents/skills/` or `.claude/skills/`.

## Steps

1. **Inspect Lap Execution Logs and Artifacts**
   Review terminal command histories, test runner outputs, and reviewer verdicts from the completed lap to identify error-to-success transitions and recurring friction points. Compile raw candidate observations citing specific log lines or lap identifiers.
   *Completion Criterion*: A structured list of raw candidate observations citing specific log lines or lap identifiers is compiled.

2. **Extract and Verify Working Tool Commands**
   Verify that discovered test, lint, format, typecheck, or build commands exit with code 0 before updating `.factory/tool-guidance.json`. Run each candidate command in the local terminal to confirm successful completion.
   *Completion Criterion*: Each tool guidance command is executed in the local environment and exits with code 0 before recording.

3. **Formulate and Gate Candidate Lessons with the Configured Harness**
   Follow `docs/spec-learning-reliability-hardening.md`: resolve candidate-bound artifact evidence, validate each mutation, and evaluate grounding and quality through `evaluateLearningWithHarness`. Propose only verdicts with both approvals, confidence at least 0.70, and `hallucinationRisk: "grounded_in_logs"`; offline, missing, timed-out, or malformed evaluation holds the candidate.
   *Completion Criterion*: Each proposed lesson has resolved evidence and a schema-valid harness verdict; held lessons remain inactive.

4. **Propose Reusable Repository Skills**
   When procedural knowledge spans multiple steps, include a skill mutation for `.agents/skills/<name>/SKILL.md` in the proposal artifact. Follow `.agents/skills/writing-for-agents/SKILL.md` for valid YAML and observable completion criteria.
   *Completion Criterion*: Proposed skills pass YAML parsing and every step concludes with an explicit `*Completion Criterion*`; the invoking checkout remains unchanged.

5. **Verify Isolated Learning Delivery**
   Deliver admitted mutations through `deliverLearningProposal` on an isolated follow-up branch. Verify JSON/JSONL, skill structure, and repository checks there, then request independent review using `docs/agents/pr-evidence-contract.md`; activation requires the host's normal merge authority.
   *Completion Criterion*: The delivery candidate has passing checks and a review request, while the verified source candidate and invoking checkout retain their original memory.
