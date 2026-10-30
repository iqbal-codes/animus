---
name: factory-tickets
description: Split an agreed spec into factory-compatible vertical tickets, with parser-readable dependencies and approved publication.
disable-model-invocation: true
---

# Make executable tickets

Read `docs/agents/software-factory-workflow.md`, `docs/agents/issue-tracker.md`, and `docs/agents/triage-labels.md`. The workflow doc owns the ticket body template and admission rules; use them rather than a second format.

## 1. Establish the source

Read the supplied spec/conversation/issue and all comments. Resolve the intended target repository, current base behavior, relevant glossary/ADRs, and existing issues/PRs. If material product intent is missing, identify the question and stop that branch for `/factory-grill` or `/factory-spec`; do not manufacture an agent-ready ticket.

## 2. Draft the task graph

Create narrow, complete vertical slices that are independently verifiable and fit one delivery lap. A slice includes every layer necessary for its behavior, not every layer in the system. Keep issue-owned enabling refactors inside their slice. A separate prerequisite needs its own independently meaningful outcome.

Use the shared ticket template: Source and problem (including value and timing), Outcome, Invariants, Acceptance criteria, Boundary, and standalone `Depends on:`. Include the source spec section and stable parent-AC references; give child criteria local identifiers. Keep each issue self-contained enough for a fresh builder and reviewer.

For each edge explain why the blocker must finish first. Use only genuine prerequisite edges; shared file edits or a preferred implementation order alone do not make a product dependency. Check for self-edges, cycles, missing prerequisite records, and already-delivered outcomes. For broad mechanical changes, prefer one atomic clean cutover when independently green slices cannot preserve the contract. Obtain explicit approval before proposing temporary compatibility paths or an integration-only verification strategy.

Show a numbered draft with title, complete body, delivery outcome, source-AC coverage, blocker reasons, and proposed labels. Account for every parent requirement exactly once or explicitly explain shared coverage. Ask approval of granularity, dependency graph, and publication/admission operations. A draft ID is not a real issue number.

## 3. Publish the approved graph

Publish only the approved operations, in topological order:

1. Resolve each dependency to an actual issue number. Write `Depends on: #12, #14` (or `Depends on: None`) as a standalone body line; keep reasons elsewhere. Native dependencies supplement this line, never replace it.
2. Create one issue per ticket in the explicit repository. Link it to the source spec as a native sub-issue when supported and retain `Part of #<parent>` plus the spec-section reference in its body. Linking children is the only parent mutation included in approved publication; otherwise leave parent content/status unchanged.
3. Apply the approved canonical triage labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`) using the shared readiness table. Parent specs stay excluded (`spec` paired with `ready-for-human` or `wontfix`). Clear but blocked tickets stay held (`needs-info` or dependency blocked). Add `ready-for-agent` only to complete, verified-unblocked tickets explicitly approved for intake. Subtickets that are ambiguous, incomplete, or require human architectural/security oversight must never receive `ready-for-agent`—use `ready-for-human` or `needs-info` instead. Missing label definitions require approval before creation.
4. Add native blocker links where supported. Read back each created issue, its labels, parent relationship, dependency body line, and native edges. If a write fails partway, report created URLs and pending operations; inspect/reuse those issues before retrying rather than duplicating them.

If the user asked only for local drafts, save one file per ticket under `.scratch/<feature>/issues/` and a graph/coverage index. Mark symbolic dependencies as draft-only and not launchable. Publication converts them to real issue numbers; local files do not replace this repo's configured GitHub tracker.

## 4. Handoff

Return issue URLs, source coverage, blockers, and separate contract/admission status. Name the current frontier and any unknown prerequisite state. Suggest `/factory-implement <spec-reference>`; publishing tickets does not launch a lap, close the parent, or authorize merge/deploy.
