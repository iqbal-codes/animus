# Issue Tracker, Dependencies & Triage Labels

- **Status:** Active
- **Last verified:** 2026-11-10

Issues and specifications for this repository live in GitHub Issues. Use the `gh` CLI for all tracker operations.

For ticket decomposition and publication workflow, see `.agents/skills/animus-tickets/SKILL.md`. Both factory intake and `animus-loop` parse the standalone textual `Depends on:` line (`Depends on: #12, #14` or `Depends on: None`) in the issue body; native GitHub blocking edges supplement that line, never replace it.

## Canonical Triage & Admission Labels

Runtime intake and planning skills use five canonical triage labels to control work admission:

| Canonical Label | Admission State | Meaning |
| --- | --- | --- |
| `ready-for-agent` | **Admitted** | Fully specified, unambiguous ticket eligible for local plan import and execution once its prerequisites are verified on the required lineage |
| `needs-triage` | **Held** | Newly opened or unreviewed item awaiting maintainer evaluation |
| `needs-info` | **Held** | Waiting on reporter or product owner to resolve missing intent or open questions |
| `ready-for-human` | **Held** | Requires human implementation, architectural sign-off, or parent-spec tracking |
| `wontfix` | **Excluded** | Will not be actioned; overrides all other labels with absolute precedence |

### Admission Gate Rules

Labels are GitHub-visible triage hints, not a continuously evaluated execution control plane.
Local execution authority is the backend-owned command/query surface: an admitted plan freezes the
exact ticket/parent revisions, dependency graph, target branches and gate profile at import. Later
label edits, title/body edits or issue closure do not change an accepted contract or launch work.

- `ready-for-agent`: Marks an open ticket as importable when it is self-contained, complete and has
  no blocking/exclusion labels or active loop claim. Apply only to executable child or standalone
  tickets. Import records the admission decision.
- `needs-info`, `ready-for-human`, `needs-triage`: Hold work from autonomous pickup even if
  `ready-for-agent` is also present.
- `wontfix`: Excludes work with absolute precedence.
- **Unlabeled issues**: Held awaiting triage (`unlabeled_awaiting_triage`). Creating labels in a repository does not make unlabeled issues executable.
- **Legacy `factory:*` labels**: `factory:ready`, `factory:hold`, and `factory:exclude` carry zero triage or admission authority.

### Dependency Release (execution authority)

A dependent ticket becomes dispatchable only when every `Depends on:` prerequisite is **proven
included in the required integration lineage** (for children) or **verified merged into the final
delivery target** (for standalone/final). The proof is the recorded merge commit and ancestry check
on the fetched remote target, not a GitHub state.

- GitHub issue closure is a reporting fact, never a dependency release. A closed-unmerged ticket,
  an arbitrary closure, or a comment claiming completion unlocks nothing.
- A dependency recorded on a different branch or repository never satisfies the frozen target.
- A missing or unreadable dependency fails closed; it does not silently admit the dependent.

### GitHub Inertness After Import

Manual issue edits, label changes, closure, PR comments, reviews and request-changes do not mutate
accepted scope, create factory findings or allocate laps. Required remote CI, PR head/base changes
and the verified merge still govern candidate readiness and completion.

### Taxonomy, Spec & Loop Execution Labels

- `spec`: Identifies a parent specification planning record delivered via child tickets. Pair every parent spec with `ready-for-human` (or `needs-info` when incomplete) to prevent direct autonomous loop intake. Never label a parent spec or ambiguous subticket `ready-for-agent`.
- `needs-owner`: Applied by the loop dispatcher, builder, or reviewer when a ticket hits the attempt/send-back limit, touches protected governance paths, alters judge checks without approval, or requires human product direction. Holds the item for human intervention.
- `priority`: Prioritizes eligible unblocked `ready-for-agent` tickets ahead of standard backlog order during dispatch.
- `route:ship`: Routes an eligible ticket directly through the `complex` multi-stage shipping pipeline.

## `gh` CLI Conventions

Infer the repository from `git remote -v` (or pass `-R <owner>/<repo>` when targeting an external repo):

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc (`--body-file -`) for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Link a child ticket to a parent spec**:
  - Put `Part of #<parent>` near the top of the child issue body.
  - Link as a native GitHub sub-issue when supported: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` (`gh` 2.94+), or `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`.
- **Record dependencies**:
  - **Canonical textual line (required)**: Write `Depends on: #12, #14` or `Depends on: None` as a standalone line in the ticket body.
  - **Native GitHub dependency edge (supplementary)**: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the numeric database ID from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..." --remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

## Pull Requests as a Triage Surface

**PRs as a request surface: no.** _(Set to `yes` if this repository treats external PRs as feature requests.)_

When set to `yes`, external PRs use the same canonical triage labels via `gh pr` equivalents (`gh pr view <number> --comments`, `gh pr diff <number>`, `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`). Because GitHub shares one number space across issues and PRs, resolve an unknown `#42` with `gh pr view 42` and fall back to `gh issue view 42`.
