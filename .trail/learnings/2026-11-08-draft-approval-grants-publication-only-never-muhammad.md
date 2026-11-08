---
title: "Draft approval grants publication only, never dispatch"
author: Muhammad
date: 2026-11-08
branch: t3/remediate-ticket-161
id: l-f93c75e7
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/draft/service.ts
  - packages/contracts/src/operator.ts
  - scripts/loop/draft.ts
  - apps/backend/src/draft/validate.ts
---

## Decided
- DraftRecord.authorization dropped can_dispatch entirely. Approval is publication permission only; execution authority is admitted later by publication/read-back (#162) and the execution-authority cutover (#165). Also fixed revise instructions so they inherit only when the revise decision still targets the current revision (revision-bound), and replaced the fabricated index-based legacy triage adapter with strict draftPlanSchema validation that fails closed. Prepared specs/children are redirected to plan admission (#153) with a draft_prepared_work error instead of being re-decomposed.
## Watch out
- Do not reintroduce can_dispatch on drafts; #162 must derive dispatch from published+read-back+admitted plans. AC id checks use word boundaries so AC1 is not satisfied by AC10.
