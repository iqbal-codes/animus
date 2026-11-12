---
title: Compact issue detail reuses the expanded left pane
author: Muhammad
date: 2026-11-11
branch: t3/respond-to-greeting
id: l-bc19cd1b
scope: repo
status: active
src: agent
touches:
  - apps/web/src/features/jobs/issue-expanded-workspace.tsx
  - tests/integration/expanded-workspace.test.tsx
---

## Decided
- CompactSideSheet now renders the exact same IssueInspector as the expanded workspace's left pane: same identity line, stage/state badges, branch chip, Github/More actions, repository + runner row, and full body sections. isCompact only swaps the toolbar action (Expand vs Collapse) and close aria-label; there is no compact-only content branch. The expanded stage is a 50/50 grid whose two panes are separate ScrollAreas (`issue-inspector-scroll`, `factory-rail-scroll`) with min-h-0 and overflow-hidden sections; FactoryRail uses min-h-full so its pane can scroll as a whole while its harness-log list keeps its own inner scroll. Verified at 1440x620: left viewport stayed scrollTop 0 while the right scrolled to 200 and document.body did not move.
## Watch out
- Do not reintroduce a compact-only body/header: the earlier JLixj compact triage anatomy was intentionally removed per operator request. Keep both expanded panes in their own scroll containers with min-h-0; the workspace shell must stay height-constrained or the panes stop scrolling independently. The branch chip truncates in the 500px sheet (full branch remains in the Triage section) — that is expected parity, not a bug.
