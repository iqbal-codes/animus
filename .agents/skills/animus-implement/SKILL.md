---
name: animus-implement
description: Implement an approved spec through its ticket frontier while preserving native factory ownership and evidence gates.
disable-model-invocation: true
---

# Implement the approved frontier

Read `docs/agents/software-factory-workflow.md` and the configured tracker instructions. This skill coordinates delivery against the spec; the pinned factory workflow owns native scheduling, claims, evidence, and landing. Do not create a competing integration-branch/merger-agent system.

## 1. Resolve work and authority

Read the full spec, child tickets, comments, latest agreed Contract, dependencies, and existing PRs. Establish the explicit target repository, actual checkout/base, configured engine revision, merge mode, and user-authorized operations. Preserve unrelated dirty files. If the spec has no executable tickets, propose `/animus-tickets` rather than improvising a task graph.

Build a requirement-to-ticket checklist. A frontier ticket has complete intent, no unresolved owner decision, no competing active claim, no open/unverifiable prerequisites, and its prerequisite outcomes present on the selected base. Inspect existing PRs before starting another implementation. Labels alone do not establish any of these facts.

## 2. Choose the delivery path

- **Native factory delivery requested:** inspect the pinned workflow's actual inputs, workability policy, and consumer controls. Use the existing consumer boundary and approved/supervised mode. Establish how the named ticket is selected before launch; if target binding is unsupported or unverifiable, report that exact blocker instead of claiming the run implements that ticket. Show the intended repository, base, ticket, and merge mode before any separately unauthorized launch.
- **Direct code implementation requested:** implement one approved frontier ticket in the current authorized checkout/branch, using repo conventions and behavior-driven tests. This is manual assistance, not a native lap: report its evidence honestly and leave native admission/review/land state unchanged. Delegate only independent slices when authorized and supported by the environment; give each a complete contract and disjoint ownership. Never reset another checkout to obtain a clean starting point.

Do not install schedules, toggle brakes, force admission, push, merge, promote, or deploy as an incidental consequence of implementing code.

## 3. Build and verify

Read existing patterns before editing. Use `/tdd` when available; prove each criterion with targeted behavior checks, including relevant error/transition cases. Run ordinary repo checks separately from integration/runtime scenarios. Preserve protected holdout paths and never expose hidden holdout content in builder prompts or reports.

Maintain a criterion evidence matrix: source issue/AC, scenario or command, observed result, artifact path, and tested head/candidate. Record BLOCKED or NOT RUN when a prerequisite is unavailable; do not substitute mocks for required live proof. New code/base changes invalidate affected evidence.

For a native lap, let independent check-app/evidence/review/land/release nodes run under their actual policy. A builder's own test result is not peer approval. For direct implementation, request `/animus-review` with explicit base, head, worktree scope, and source spec/tickets. That user-invoked review is a separate handoff; do not pretend it automatically advanced native state. Never perform this review in the same session as the implementer—the implementer cannot review their own work; review requires a separate session that dispatches two independent axis subagents.

## 4. Advance and hand back

After verified authorized integration, refresh the base and dependency outcomes before taking the next ticket. Continue only within the requested scope. If blocked, return the exact missing prerequisite/decision and all completed work rather than closing work optimistically.

Report delivered vs remaining tickets, branch/head, criterion evidence, independent review status, and outstanding approval. Close issues/parent or mark PRs ready only when the authorized delivery policy and actual verified outcomes justify it. Code written, PR open, review passed, merged, promoted, and deployed are distinct states. Leave cleanup of pre-existing code/worktrees to an explicit request.
