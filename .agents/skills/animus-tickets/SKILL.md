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

2. **Draft the vertical task graph.**
   Create narrow, complete vertical slices that are independently verifiable and fit one delivery lap. A slice includes every layer necessary for its behavior, not every layer in the system. Keep issue-owned enabling refactors inside their slice. When `docs/architecture.md` defines foundation prerequisites (`S0`: repo scaffold, folder topology, or shared reusable UI/CRUD primitives consumed across multiple specs), draft explicit foundation prerequisite ticket(s) first and wire downstream feature slices to depend on them (`Depends on: #<foundation>`) so parallel builders reuse shared components rather than duplicating them.
   Use the canonical ticket body template below. Include the source spec section (`Part of #<parent>` near the top when a parent spec issue exists) and stable parent-AC references; give child criteria local identifiers. For each dependency edge, explain why the blocker must finish first; use only genuine prerequisite edges and check for self-edges, cycles, and already-delivered outcomes. Show a numbered draft with title, complete body, delivery outcome, source-AC coverage, blocker reasons, and proposed labels. Ask approval of granularity, dependency graph, and publication/admission operations.
   *Completion Criterion*: Every parent requirement is accounted for in the numbered draft graph with acyclic dependencies, and the user approves the draft before publication.

3. **Publish the approved graph in topological order.**
   Publish only the approved operations:
   - Resolve each dependency to an actual issue number. Write `Depends on: #12, #14` (or `Depends on: None`) as a standalone body line outside code fences; keep reasons elsewhere. Native dependencies supplement this line, never replace it.
   - Create one issue per ticket in the explicit repository. Link it to the source spec as a native sub-issue when supported and retain `Part of #<parent>` plus the spec-section reference in its body.
   - Apply the approved canonical triage labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`) per `docs/agents/issue-tracker.md`. Parent specs stay excluded (`spec` paired with `ready-for-human` or `wontfix`). Add `ready-for-agent` only to complete, verified-unblocked tickets explicitly approved for intake.
   - Add native blocker links where supported. Read back each created issue, its labels, parent relationship, dependency body line, and native edges. If the user asked only for local drafts, save one file per ticket under `.scratch/<feature>/issues/` and a graph/coverage index marked draft-only.
   *Completion Criterion*: All approved tickets and dependency edges are published and read back (or written to `.scratch/` when draft-only) with verified labels and issue numbers.

4. **Hand off to `/animus-implement`.**
   Return issue URLs, source coverage, blockers, and separate contract/admission status. Name the current frontier and any unknown prerequisite state. Suggest `/animus-implement <spec-reference>`; publishing tickets does not launch a lap, close the parent, or authorize merge/deploy.
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

<Explicit exclusions and any issue-owned enabling work.>

Depends on: None
```
