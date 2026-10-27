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

- `ready-for-agent`: Admits otherwise eligible open work when prerequisites are closed and no active claims exist.
- `needs-info`, `ready-for-human`, `needs-triage`: Hold work from execution.
- `wontfix`: Excludes work with absolute precedence.
- Unlabeled issues or issues with unknown labels only are held awaiting triage.
- Legacy `factory:` prefixed labels (`factory:ready`, `factory:hold`, `factory:exclude`) have no triage or admission authority.
