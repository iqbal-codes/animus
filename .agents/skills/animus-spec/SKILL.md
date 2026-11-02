---
name: animus-spec
description: Synthesize agreed discussion into a software factory spec, with explicit acceptance and a gated tracker handoff.
disable-model-invocation: true
---

# Write the spec

Read `docs/agents/issue-tracker.md` when publishing or updating tracker issues. Synthesize settled discussion rather than starting another interview. Missing intent remains an open question; offer `/animus-grill` for decisions that prevent a complete contract.

## When to Use

Use this playbook when:
- Synthesizing a completed `/animus-grill` slice contract or settled discussion into a formal specification (`docs/spec-<slice>.md` or a parent `spec` issue).
- Updating an existing specification with newly settled product decisions or acceptance criteria.

## Steps

1. **Resolve the source and target repository.**
   Resolve the source conversation/issue/path (including any `docs/brainstorm-<slug>.md` slice entry and `docs/research-*.md` notes) and target repository. Read the source in full, including comments, relevant code, glossary, and ADRs. Check whether the requested outcome already exists or overlaps another issue.
   *Completion Criterion*: Source inputs, target repository, and overlap checks are verified with zero unexamined source comments or references.

2. **Separate current behavior from the agreed proposal.**
   Separate observed current behavior from the proposal. Carry forward agreed decisions, parked sensible defaults, and exclusions exactly; cite source sections and relevant code evidence. Keep greenfield product specs focused on observable product behavior and business invariants without prematurely prescribing tech stack or folder layout (which `/animus-architecture` settles before `/animus-tickets`). Describe test seams using existing public behavior where possible. New design is a proposal unless already agreed.
   *Completion Criterion*: Every requirement in the draft traces to a settled decision, parked default, or observed repository fact.

3. **Draft the specification.**
   Write the spec using the shape below. Give acceptance criteria stable identifiers (`AC1`, `AC2`...) for later ticket and evidence mapping. Include only relevant states, failures, and authority boundaries; omit inapplicable optional sections rather than writing filler.
   *Completion Criterion*: The specification draft contains all required sections with stable `AC<n>` identifiers and zero invented user-story padding.

4. **Present the draft and publish only when authorized.**
   Present the draft, material gaps, target repository, and proposed labels. Publish or update the source issue only when those writes are authorized. A parent spec is planning-only: label with `spec` paired with `ready-for-human` (or `needs-info` if material intent is missing/incomplete; never `ready-for-agent` for parent specs). Read back any publication and return its exact URL.
   *Completion Criterion*: Draft is reviewed by the user, and any authorized tracker publication is read back with verified canonical labels and exact URL.

5. **Hand off to architecture or ticket decomposition.**
   Return the spec path/URL (updating the slice's `Spec Pointer` in `docs/brainstorm-<slug>.md` when applicable), complete vs incomplete contract status, unresolved decisions, and suggested next stage: `/animus-architecture` (when tech stack, folder topology, or cross-spec reusable components are not yet settled) or `/animus-tickets` (when codebase architecture is already established). Stop before architecture or decomposition unless separately requested.
   *Completion Criterion*: Spec pointer and handoff summary are delivered without auto-invoking downstream stages.

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

A material open question prevents calling the spec implementation-ready. File/symbol references may support current-truth claims; they are evidence, not a substitute for an outcome contract. Preserve a decision-rich prototype excerpt only when it communicates an agreed contract more precisely than prose.
