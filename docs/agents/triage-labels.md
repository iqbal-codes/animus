# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Factory admission is a separate gate

Canonical triage roles describe intent/readiness, not runtime admission. Current intake still requires `factory:ready`; `factory:hold` blocks and `factory:exclude` excludes. In particular, `ready-for-agent` alone is not admitted, and `needs-info` / `ready-for-human` alone do not block intake.

When creating specs, splitting tickets, changing readiness, or implementing the frontier, read `software-factory-workflow.md` for the label combinations and approval rules. Keep this table as the canonical-role mapping; update the workflow contract when executable admission policy changes.
