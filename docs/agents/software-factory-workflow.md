# Software factory skill workflow

Read this contract for brainstorming, specs, tickets, implementation, or review in this repo. Stage order:

`/animus-grill → /animus-spec → /animus-tickets → /animus-implement → /animus-review`

Each stage hands off an artifact, not permission to run the next stage. Read `issue-tracker.md` for tracker operations and `triage-labels.md` for label roles. Resolve the target repository explicitly: this factory's own backlog and a configured product backlog can differ. Use an explicit repository on tracker writes.

## Authority and current truth

Repository-local stage skills under `.agents/skills/` (also symlinked to `.claude/skills/`) use the `animus-` prefix to distinguish this workflow from global skills. Keep factory-specific rules here; global skills remain unchanged. Use the `animus-`-prefixed commands for this lifecycle.

Before acting, read current code, configuration, the source issue and comments, applicable glossary/ADRs, and any existing PR. Design documents describe intent until executable behavior establishes it. Read `.factory/consumer.json` to locate the pinned engine; inspect that source's loop/triage commands when their contract matters. Do not use an ambient engine or hard-code a cache path/revision.

Publication, readiness labels, launching a lap, pushing a branch, merging, promotion, and deployment are separate permissions. Present proposed tracker writes and obtain approval unless the user already authorized those exact operations. Approval to split tickets authorizes that approved publication, not execution or promotion. Keep unrelated working-tree changes intact.

## Work-item contract

Existing factory tickets (for example, issues #1–#7) use this shape. It carries Animus's six semantic contract elements without prescribing implementation design:

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

For blocked work replace the last line with, for example, `Depends on: #12, #14`. Keep that line at the start of its own line, outside code fences in the published body. Use only issue references there: intake extracts all digits in the clause. Put dependency reasons in separate prose. Include `Part of #<parent>` near the top when a source spec issue exists, and create native parent/sub-issue links when supported.

Native GitHub blocking edges are useful UI metadata but insufficient for execution: both current intake and the pinned loop read textual `Depends on:` clauses. Maintain both representations when native edges are available; verify they agree. An open, missing, or unverifiable prerequisite is not complete. Historical dependency declarations in comments also affect intake; surface contradictions for an approved correction rather than declaring readiness from the body alone.

Use stable AC identifiers for evidence mapping. Include check commands or artifact names when known and relevant; design, root cause, file paths, and test commands are not universal admission requirements. Keep implementation steering limited to agreed decisions. Parent specs describe the complete outcome; executable tickets are self-contained, independently verifiable slices.

## Canonical admission and readiness

| State                                                        | Canonical label action                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Parent spec / planning-only record                           | Use `spec` alongside `ready-for-human` (or `needs-info` if incomplete). Never `ready-for-agent`. |
| Missing or contradictory intent                              | Record the exact open question; use `needs-info` (or `needs-triage` pending assessment). |
| Human implementation required                                | Use `ready-for-human`.                                                                   |
| Complete executable contract with prerequisites still open   | Use `ready-for-agent`; retain dependency edges.                                          |
| Complete, unblocked executable contract, approved for intake | Use `ready-for-agent`. Subtickets that are ambiguous or require human oversight must stay `ready-for-human` or `needs-info`. |
| Rejected work                                                | Use `wontfix` only with an approved disposition.                                         |

Admission policy evaluates OPEN issues labeled `ready-for-agent` when all referenced prerequisites are CLOSED in the fetched backlog, with no blocking labels (`needs-info`, `ready-for-human`, `needs-triage`), no exclusion labels (`wontfix`), and no active loop claim. Unlabeled issues fail-closed to `held` (`unlabeled_awaiting_triage`). Legacy `factory:` prefixed labels have no authority.

A passing intake result is not proof of engine selection or delivery. The scheduler writes a target, but target binding must be established against the installed engine. Manual runs bypass scheduled intake. Do not promise that holding/excluding a record makes every direct native invocation safe: inspect its workability/selection policy before launch.

## Implementation and evidence

`/animus-implement` prepares or implements approved frontier tickets; it does not replace the native workflow with a parallel scheduler. Discover the configured base, current merge mode, ownership, and existing PR before starting. Do not assume `main`, `develop`, or automatic merge. A prerequisite is complete only when its required outcome is present on the chosen base, not merely because a sibling branch exists or an issue is closed.

For native delivery retain the pinned loop's ownership:

`pick → claim → build/ship → subject → check-app → evidence → review → land → release`

The installed graph may include an optional deployment node. The builder supplies per-criterion checks and a PR Evidence section, then independent runtime/peer review evaluates the exact candidate. The builder does not approve or land their own work, nor review it in the same session: `/animus-review` is conducted in a clean session that always dispatches two independent axis subagents (Standards and Spec). Preserve holdout secrecy and protected paths; ordinary harness checks and independent runtime evidence are distinct results. A local `/animus-review` report cannot fabricate native evidence records or mark native approval complete.

Record source ticket/spec, AC identifier, observed result, command/scenario, artifact path, and tested candidate/head. Distinguish PASS, FAIL, BLOCKED, and NOT RUN. After code or base changes, rerun affected checks and refresh head-bound evidence. Publish or close work only under the authorized tracker/merge policy; close a parent only after every required outcome is verified.

## Operational caveats

- PAUSE stops scheduled launches, not manual runs, native wakes, or work already in flight. It is not a verified integration freeze.
- Promotion preparation creates a develop-to-main PR and writes PAUSE; this alone is not proof of frozen-head review, release verification, or deployment.
- A `waiting_approval` projection records native history, not fresh forge approval or a merge.
- Runtime and peer-review evidence must refer to the candidate being reviewed. An absent spec, unavailable dependency, stale evidence, or missing provider prerequisite is an honest blocked/incomplete state.

Consult `apps/backend/src/intake.ts`, `apps/engine-host/src/native.ts`, `apps/engine-host/src/promotion.ts`, their behavior tests, and the configured pinned engine when verifying these boundaries. If they change, update this contract and its skill evaluations together.
