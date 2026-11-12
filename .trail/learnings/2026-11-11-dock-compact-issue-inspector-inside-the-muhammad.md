---
title: Dock compact issue inspector inside the kanban row
author: Muhammad
date: 2026-11-11
branch: t3/respond-to-greeting
id: l-d549876e
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/board/service.ts
  - apps/backend/src/main.ts
  - apps/web/src/App.tsx
  - apps/web/src/features/jobs/issue-expanded-workspace.tsx
  - apps/web/src/features/jobs/jobs-board.tsx
  - apps/web/src/features/jobs/jobs-model.ts
  - apps/web/src/features/jobs/jobs-screen.tsx
  - apps/web/src/features/jobs/kpi-card.tsx
  - packages/contracts/src/operator.ts
  - tests/integration/expanded-workspace.test.tsx
---

## Decided
- The compact issue inspector renders as a 500px sibling inside the board row (`data-testid="kanban-wrapper"`), never as a sibling of the whole JobsBoard or the screen. KPI row, toolbar boundaries and footer stay outside that row, so the inspector can open without squeezing the KPI tiles. The workspace shell is fixed-height (`SidebarProvider` h-svh + overflow-hidden, `SidebarInset` min-h-0/overflow-hidden) so the board row fills the remaining 741px at 1440x1080 and only the inspector body scrolls; its header is sticky. Geometry verified against animus.pen `JLixj`: content x=92/y=104 KPI 1320x131, board row y=261 1320x741, inspector 500x741 at x=912, header 151px.
## Watch out
- Do not put overflow-y-auto on the JobsScreen content wrapper: it unconstrains the board row height, the drawer grows to its content (1736px) and the whole page scrolls. The inspector body needs a bounded parent for its ScrollArea and sticky header. KPI uses 17px padding plus the 1px CSS border to reach the design's 131px box (18px visual inset). Keep the structural regression tests in web-board.test.tsx and expanded-workspace.test.tsx.
