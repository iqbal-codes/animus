# Learning reliability hardening

- **Status:** Active
- **Last verified:** 2026-11-10

## Source and boundary

Agreed in the Animus reliability discussion: delegate execution without routine babysitting, retain owner authority over product and architectural decisions, and prevent unverified reflections from becoming active harness instructions. This specification supersedes unsafe activation and evaluator fallback behavior in [`docs/archive/specs/post-loop-self-improving-harness.md`](archive/specs/post-loop-self-improving-harness.md).

Review baseline: `706710299cd6e8febbfb34023fc3235134158f48`. Existing uncommitted auto-merge changes are outside this task and must be preserved. Review the task delta independently of those changes.

## Acceptance criteria

- AC1: Reflection produces a runtime-validated proposal artifact, never directly activates lessons, commands, rules, registries, skills, or AGENTS changes in the invoking checkout or verified delivery candidate.
- AC2: Missing, unavailable, malformed, or invalid evaluator output holds the candidate. Confidence must be finite in [0,1]; explicit unsupported grounding cannot pass. No invented fallback confidence.
- AC3: Structured evidence references resolve contained artifacts and bind to recorded run and candidate identities, with real line ranges and resolved excerpts supplied to the evaluator. Free-form claims alone are insufficient.
- AC4: Every mutation category has its own admission checks. Tool guidance needs host-recorded successful command execution; guard proposals need positive and negative fixture evidence; structural changes require reviewed isolated delivery, not direct activation.
- AC5: Lightweight memory changes are proposed through delivery review without silently invalidating candidate approval. Use an isolated follow-up branch/PR based on the pinned verified candidate rather than modifying the already-reviewed delivery branch; link the source delivery PR in the learning proposal. Structural changes use an isolated branch/worktree and separate PR. No automatic merge or silent root mutation from learning.
- AC6: Active memory comes from the accepted repository baseline. Unmatched lessons produce no injection; dirty or unaccepted skills, context, and hooks are not consumed as trusted baseline memory.
- AC7: Recurrence counts distinct provenance, preserves rule revision identity, and does not inherit evidence across changed meaning. Operator veto cannot be bypassed by recreating the topic with a new ID.
- AC8: Reflection runs at actual terminal outcome; explicit recorded within-lap recovery can provide friction. Skipped, malformed, failed, or held outcomes do not falsely mark successful reflection. Learning failure does not invalidate otherwise valid feature delivery.
- AC9: Builders independently decide local implementation details but escalate contradictions, changed product invariants, ownership boundaries, or architectural authority. Black-box checks remain contract-driven and candidate-bound.
- AC10: Offline behavioral tests cover adversarial admission, no root writes or premature activation, proposal delivery isolation, recurrence/veto, terminal lifecycle, mandate boundaries, and candidate binding. Existing tests migrate rather than preserve unsafe behavior.

## Verification seams

Use `runPostIssueReflection`, proposal delivery, accepted-memory resolution, dossier terminal decisions, and local-loop execution as public seams. Use temporary Git repositories and injected external agent/Jev/forge transports; do not call live model or GitHub APIs in tests. Assertions must demonstrate state transitions, rejection reasons, actual file/commit isolation, and invariants, not merely default values.

## Non-goals

No guarantee that a correct implementation resolves every product need. No new agent tiers, telemetry platform, model routing redesign, automatic policy alignment, or broad unrelated merge workflow changes. Project usage later measures defect escape, rework, intervention, and learning utility; offline checks establish admission and execution safety now.
