---
name: animus-grill
description: Stress-test a single product slice or feature top-down across altitude gates to settle its behavioral contract before writing a spec.
disable-model-invocation: true
---

# Grill a product slice or factory idea

Settle the behavioral contract for **one focused slice or change**; this stage does not publish issues or launch work.

## When to Use

Use this playbook when:
- Stress-testing a single product slice (e.g., `[S1]` from `docs/brainstorm-<slug>.md`) or a focused feature/change before writing `/animus-spec`.
- If the prompt is still an un-sliced whole product or multi-module initiative, route to `/animus-brainstorm` first (or use Round 1 to carve out one target slice and rule the rest out of scope).

## Steps

1. **Ground context and lock a single-slice boundary.**
   Read the conversation, any referenced `docs/brainstorm-<slug>.md` map, `docs/research-*.md` notes, and relevant repository code/configuration. Separate verified facts, inherited `Shared Product Spine` rules, parked `Sensible Defaults`, sibling-slice `Excluded` boundaries, and open decisions. Find environmental or primary-source facts yourself (via repo inspection, Context7 docs, or `$research`); ask the user only for decisions that cannot be resolved from evidence or sensible defaults.
   *Completion Criterion*: Environmental facts and inherited brainstorm constraints are separated from open decisions, and the session is scoped to a single slice.

2. **Gate 1 (High-Level Altitude) — Settle Outcome, Actors, and Scope Boundary breadth-first.**
   Ask at most 3–4 numbered questions covering the full breadth of the slice at high altitude:
   - Core problem, value, and why now.
   - Primary actors and observable user outcome.
   - Explicit **In-Scope vs Out-of-Scope** boundary (preventing drift into sibling slices).
   Pair each question with a grounded recommendation (`➡️`) worded so agreement accepts it. Wait for the user's answers before asking workflow, edge-case, or invariant questions.
   *Completion Criterion*: The user confirms the slice's high-level outcome, actors, and explicit In-Scope/Out-of-Scope boundary.

3. **Gate 2 (Contract Altitude) — Settle Behavioral Flows, Business Invariants, and Acceptance Criteria.**
   Only for capabilities confirmed In-Scope in Gate 1, work breadth-first in rounds (max 3–4 numbered questions per round with grounded recommendations) across:
   - Core behavioral flows, state transitions, and empty/error states.
   - Load-bearing business invariants, prerequisites, and verifiable acceptance criteria.
   - Operator authority (planning, intake, selection, execution, review, merge, promotion, deploy) **only** when the change modifies factory automation.
   Keep product grilling **implementation-agnostic** (leave tech stack, folder layout, and shared UI component architecture to `/animus-architecture`).
   **Default-and-Park Rule (Anti-Snowball)**: When the user accepts a recommended default (`"Agree"`, `"Yes"`, or `"use standard defaults"`), lock that entire sub-branch under **Sensible Defaults** and stop generating child questions from it. Drill deeper only when the user rejects the default or introduces custom constraints. Challenge contradictions using exact evidence; preserve settled decisions.
   *Completion Criterion*: Every load-bearing behavioral branch, business invariant, and acceptance condition is settled, parked on an agreed sensible default, or explicitly marked blocked.

4. **Present the contract handoff and confirm shared understanding.**
   Present a structured summary covering:
   - Agreed problem, value, and observable outcome.
   - Business invariants and authority boundaries.
   - Candidate acceptance criteria (`AC1`, `AC2`...) and behavior checks.
   - Explicit exclusions and locked sensible defaults.
   - Real prerequisites and any unresolved blockers.
   Ask the user to confirm shared understanding. Suggest `/animus-spec` after confirmation. If intent remains unresolved, label the handoff incomplete rather than filling gaps. Do not invoke later stages automatically.
   *Completion Criterion*: The user confirms shared understanding of the complete slice contract.
