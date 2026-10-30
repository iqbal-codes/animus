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

## Canonical admission gate

Runtime intake uses canonical labels exclusively:

- `ready-for-agent`: Admits otherwise eligible open work when prerequisites are closed and no active claims exist. Must only be applied to fully specified, unambiguous tickets.
- `needs-info`, `ready-for-human`, `needs-triage`: Hold work from execution.
- `wontfix`: Excludes work with absolute precedence.
- Unlabeled issues or issues with unknown labels only are held awaiting triage.
- Legacy `factory:` prefixed labels (`factory:ready`, `factory:hold`, `factory:exclude`) have no triage or admission authority.

## Taxonomy & Spec Labels

- `spec`: Identifies a parent specification planning record delivered via child tickets. Parent specs are planning-only records and must be paired with `ready-for-human` (or `needs-info` when incomplete) to prevent direct autonomous loop intake. Parent specs and ambiguous subtickets must **never** be labeled `ready-for-agent`.
