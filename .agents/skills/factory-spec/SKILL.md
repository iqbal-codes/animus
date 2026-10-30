---
name: factory-spec
description: Synthesize agreed discussion into a software factory spec, with explicit acceptance and a gated tracker handoff.
disable-model-invocation: true
---

# Write the spec

Read `docs/agents/software-factory-workflow.md` and the tracker/label docs it points to. Synthesize settled discussion rather than starting another interview. Missing intent remains an open question; offer `/factory-grill` for decisions that prevent a complete contract.

## Process

1. Resolve the source conversation/issue/path and target repository. Read the source in full, including comments, relevant code, glossary and ADRs. Check whether the requested outcome already exists or overlaps another issue.
2. Separate observed current behavior from the proposal. Carry forward agreed decisions and exclusions exactly; cite source sections and relevant code evidence. Describe test seams using existing public behavior where possible. New design is a proposal unless already agreed.
3. Write the spec below. Give acceptance criteria stable identifiers for later ticket and evidence mapping. Include only relevant states, failures, and authority boundaries; do not pad with exhaustive invented user stories.
4. Present the draft, material gaps, target repository, and proposed labels. Publish or update the source issue only when those writes are authorized. A parent spec is planning-only: label with `spec` paired with `ready-for-human` (or `needs-info` if material intent is missing/incomplete; never `ready-for-agent` for parent specs). Read back any publication and return its exact URL.
5. Handoff: spec path/URL, complete vs incomplete contract, unresolved decisions, and suggested `/factory-tickets` input. Stop before decomposition or execution unless separately requested.

## Spec shape

```markdown
# <Outcome-oriented title>

## Source and problem
<Source discussion/issue references; current problem, why it matters, why now.>

## Outcome
<Observable complete outcome and relevant actors.>

## Invariants
<Properties preserved and authority/data boundaries.>

## Acceptance criteria
- [ ] AC1: <Observable behavior and verification method.>

## Boundary
<Included scope, explicit exclusions, and no implied follow-up deliverables.>

## Agreed decisions
<Only decisions already settled, their reasons, and evidence pointers.>

## Verification
<Behavior scenarios, relevant error/empty/transition cases, existing test seams,
required artifacts, candidate binding, and ordinary vs independent checks.>

## Prerequisites and open questions
<Real prerequisites and exact unresolved decisions, or explicitly none.>
```

Omit an inapplicable optional section rather than writing filler. A material open question prevents calling the spec implementation-ready. File/symbol references may support current-truth claims; they are evidence, not a substitute for an outcome contract. Preserve a decision-rich prototype excerpt only when it communicates an agreed contract more precisely than prose.
