---
name: animus-grill
description: Stress-test a software factory idea and settle its product contract before writing a spec.
disable-model-invocation: true
---

# Grill a factory idea

Read `docs/agents/software-factory-workflow.md` first. This stage settles intent; it does not publish issues or launch work.

1. Read the conversation and relevant current code/configuration. Separate facts, proposed behavior, settled decisions, and unknowns. Find environmental facts yourself; ask the user only for decisions that cannot be resolved from evidence or sensible defaults.
2. Build a decision tree around the problem, value, why now, observable outcome, invariants, acceptance, scope boundary, prerequisites, and operator authority. Prioritize load-bearing ambiguity rather than asking a fixed questionnaire. For an automation change, distinguish planning, intake, selection, execution, review, merge, promotion, and deploy authority only where the change touches them.
3. Work in rounds. Ask the current independent decision frontier, numbered, with a grounded recommendation for each. Wait for answers before asking downstream questions. Challenge contradictions and unsupported premises using exact evidence; preserve the user's decisions once settled.
4. Finish when every load-bearing branch is either settled or explicitly blocked. Present a handoff with agreed contract elements, decisions and reasons, exclusions, real prerequisites, proposed behavior checks, and any exact unresolved questions. Ask the user to confirm shared understanding.

Suggest `/animus-spec` after confirmation. If intent remains unresolved, label the handoff incomplete rather than filling gaps. Do not invoke later stages merely because the interview ended.
