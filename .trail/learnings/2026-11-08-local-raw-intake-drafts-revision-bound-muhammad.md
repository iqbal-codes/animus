---
title: "Local raw-intake drafts, revision-bound operator decisions, and #162 handoff"
author: Muhammad
date: 2026-11-08
branch: t3/implement-spec-draft-authoring
id: l-395e3d28
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/main.ts
  - apps/backend/src/registry/db.ts
  - packages/contracts/src/operator.ts
  - packages/client/src/index.ts
  - scripts/cli/commands/operations.ts
---

## Decided
- Implemented local raw-intake drafting in the existing console.db (migration v2): work_drafts, immutable work_draft_revisions, immutable work_draft_decisions. DraftService runs an injected DraftPlanner (default adapter dynamically loads scripts/loop/draft.ts to avoid backend->scripts static imports) and persists validated plans only after planning succeeds. Plans are explicit standalone/spec kinds; spec children must be topological and cover every parent AC. Questions/answers create new append-only revisions; decisions target an exact latest revision, so new scope invalidates approval. DraftRecord.authorization is the only publication/dispatch handoff: can_publish/can_dispatch are true only for the approved latest plan revision. #162 must consume that authorization and must not publish clarification, rejected, changes_requested, or stale approved revisions. Existing GitHub triage publication remains legacy and unactivated for this lane until #165.
## Watch out
- Do not read project paths or issue numbers as draft identity; use draft_/drev_/ddecision_ ids and work revision ids. source_work_revision_id/source_content_hash bind the draft to the imported snapshot. The planner prompt accepts both the new draft plan schema and legacy triage action JSON for compatibility. UI surfaces are HTTP/client/CLI only in this slice; no web canvas wiring.
