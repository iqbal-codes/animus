---
number: 501
title: Offline agent loop and local file watcher
state: OPEN
labels:
  - ready-for-agent
  - triage:ready
---
## Source and problem
When developing autonomous agents locally without GitHub connectivity, developers need the ability to author issues directly in their workspace.

## Outcome
Animus admits local markdown issues in `.animus/issues/*.md` directly into the Kanban board.

## Acceptance criteria
- [x] Scan local issues from `.animus/issues/`
- [x] Retain frontmatter titles, numbers, and labels
- [x] Render on board lanes and expanded workspace
