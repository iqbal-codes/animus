---
name: animus-tickets
description: Split an agreed spec into factory-compatible vertical tickets, with parser-readable dependencies and approved publication.
disable-model-invocation: true
---

# Make executable tickets

Read `docs/agents/issue-tracker.md`.

## When to Use

Use this playbook when:
- Decomposing an agreed specification (`/animus-spec`) and settled codebase architecture (`/animus-architecture` or existing repo conventions) into vertical, dependency-ordered implementation tickets.
- Publishing approved executable tickets to the configured GitHub issue tracker or saving local ticket drafts.

## Steps

1. **Establish the source and architectural prerequisites.**
   Read the supplied spec/conversation/issue, `docs/architecture.md` (when present), `docs/research-*.md` notes, and all comments. Resolve the intended target repository, current base behavior, relevant glossary/ADRs, and existing issues/PRs. If material product intent is missing, identify the question and stop that branch for `/animus-grill` or `/animus-spec`; if a greenfield product spec lacks a settled tech stack, folder topology, or shared component strategy, route to `/animus-architecture` first rather than inventing architecture inside tickets.
   *Completion Criterion*: Source spec, architecture constraints, and target repository are verified with zero missing product or architectural prerequisites.

2. **Draft the vertical task graph (Coarse-Grained Cohesive Milestones).**
   Size tickets for AI agent context economics, not human micro-tasking. Target **2–4 cohesive milestones per specification** (or **1 single ticket** when the spec fits comfortably in one builder session of ~50–80 tool calls). Avoid splitting a single cohesive feature into 10+ micro-tickets, which multiplies context re-hydration, causes sequential database migration thrashing, and produces fragmented UI/architectural drift across isolated subagents:
   - **Consolidate shared schema & domain foundations**: Group tightly coupled data models, persistence migrations, and domain contracts that evolve together into one foundational milestone rather than scattering incremental schema alterations across many tickets.
   - **Consolidate cohesive UI & operator surfaces**: Group changes to the same screen, view hierarchy, or design-system surface into a single milestone anchored to the project's canonical UI/design contract so parallel builders do not bolt competing panels or unrequested navigation routes onto the same surface.
   - **Genuine dependency edges only**: Create complete vertical milestones that are independently verifiable and fit one delivery lap. Keep issue-owned enabling refactors inside their slice. When `docs/architecture.md` defines foundation prerequisites (`S0`: repo scaffold, folder topology, or shared reusable UI/CRUD primitives consumed across multiple specs), draft explicit foundation prerequisite ticket(s) first and wire downstream feature slices to depend on them (`Depends on: #<foundation>`) so parallel builders reuse shared components rather than duplicating them.
   Use the canonical ticket body template below. Include the source spec section (`Part of #<parent>` near the top when a parent spec issue exists) and stable parent-AC references; give child criteria local identifiers. Standardize `## Boundary` with concise `Touchpoints`, `Known callers (blast radius)`, `Test seam`, and `Exclusions` pointers anchored to stable module/domain seams rather than brittle line numbers—giving downstream builders an immediate starting navigation map while keeping the live codebase as the authoritative source of truth as upstream tickets land. For each dependency edge, explain why the blocker must finish first; use only genuine prerequisite edges and check for self-edges, cycles, and already-delivered outcomes. Show a numbered draft with title, complete body, delivery outcome, source-AC coverage, blocker reasons, and proposed labels. Ask approval of granularity, dependency graph, and publication/admission operations.
   *Completion Criterion*: Every parent requirement is accounted for in a coarse-grained, acyclic milestone graph (typically 2–4 tickets) with zero micro-ticket fragmentation, and the user approves the draft before publication.

3. **Publish the approved graph in topological order.**
   Publish only the approved operations:
   - Resolve each dependency to an actual issue number. Write `Depends on: #12, #14` (or `Depends on: None`) as a standalone body line outside code fences; keep reasons elsewhere. Native dependencies supplement this line, never replace it.
   - Create one issue per ticket in the explicit repository. Link it to the source spec as a native sub-issue when supported and retain `Part of #<parent>` plus the spec-section reference in its body.
   - Apply the approved canonical triage labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`) per `docs/agents/issue-tracker.md`. Parent specs stay excluded (`spec` paired with `ready-for-human` or `wontfix`). Add `ready-for-agent` only to complete, verified-unblocked tickets explicitly approved for intake.
   - Add native blocker links where supported. Read back each created issue, its labels, parent relationship, dependency body line, and native edges. If the user asked only for local drafts, save one file per ticket under `.scratch/<feature>/issues/` and a graph/coverage index marked draft-only.
   *Completion Criterion*: All approved tickets and dependency edges are published and read back (or written to `.scratch/` when draft-only) with verified labels and issue numbers.

4. **Hand off to `/animus-implement` or `/animus-implement-spec`.**
   Return issue URLs, source coverage, blockers, and separate contract/admission status. Name the current frontier and any unknown prerequisite state. Suggest `/animus-implement-spec <spec-reference>` for multi-ticket DAG coordination on an integration branch, or `/animus-implement <ticket-reference>` for an isolated single-ticket frontier item; publishing tickets does not launch a lap, close the parent, or authorize merge/deploy.
   *Completion Criterion*: Handoff summary lists all created ticket URLs, coverage mapping, and current unblocked frontier without auto-launching execution.

## Canonical ticket body template

```markdown
## Source and problem

<Source spec reference and section; what is wrong/missing today, why it matters,
and why now. Use settled intent, not invented urgency.>

## Outcome

<The observable behavior this ticket delivers.>

## Invariants

<Properties that must remain true, including authority and data boundaries.>

## Acceptance criteria

- [ ] AC1: <Observable condition and how it is verified.>
- [ ] AC2: <Relevant failure, boundary, or state-transition behavior.>

## Boundary

- **Touchpoints**: <files and functions/classes/components that will be touched>
- **Known callers (blast radius)**: <unmodified files/modules that import or call touched components>
- **Test seam**: <test file(s) and test command(s) that verify this slice>
- **Exclusions**: <explicit exclusions and out-of-scope work>

Depends on: None
```
