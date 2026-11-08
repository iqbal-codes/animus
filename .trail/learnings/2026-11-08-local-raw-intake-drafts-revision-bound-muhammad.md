---
title: "Local raw-intake drafts, publication-only authorization, and the #162 handoff"
author: Muhammad
date: 2026-11-08
branch: t3/repair-ticket-161-residuals
id: l-395e3d28
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/main.ts
  - apps/backend/src/registry/migrations.ts
  - apps/backend/src/registry/db.ts
  - apps/backend/src/draft/service.ts
  - apps/web/src/features/drafts/drafts-screen.tsx
  - packages/contracts/src/operator.ts
  - packages/client/src/index.ts
  - scripts/cli/commands/operations.ts
  - scripts/loop/draft.ts
---

## Decided
- Draft authoring lives in the existing console.db through the single ordered migration registry `SCHEMA_MIGRATIONS`: v1 work identity (#152), v2 prepared plan admission (#153), v3 draft authoring (#161). Per-module migration runners are deleted; duplicate version/name, non-ascending order, unknown applied version and applied version/name mismatch fail closed.
- `DraftService` runs an injected `DraftPlanner` (the default adapter dynamically loads `scripts/loop/draft.ts` to avoid a backend->scripts static import) and persists validated plans only after planning succeeds. Plans are explicit standalone/spec kinds; spec children must be topological and cover every parent AC. Questions/answers create new append-only revisions; decisions target an exact latest revision, so new scope invalidates approval.
- `DraftRecord.authorization` is publication permission only: `approved`, `approved_revision_id`, `can_publish`. There is no `can_dispatch` field. #162 must consume `can_publish`, publish and read back, and only then admit execution; publication must refuse clarification, rejected, changes_requested, stale or unapproved revisions.
- `scripts/loop/draft.ts` accepts only `draftPlanSchema`; the legacy triage-action adapter (index-based AC coverage, injected `prepared: true` and Verification) is deleted and such payloads fail closed as `draft_invalid_plan`.
- Prepared classification is evaluated before pass-through: `preparedSpecReason` runs first and refuses `Part of #n`, the `spec` label, `Source acceptance coverage:`, a `## Children` section, and a canonical body without `## Verification`. Only an unambiguous standalone is returned as `prepared: true` without a model call.
- The operator app has real web wiring: `apps/web/src/features/drafts/drafts-screen.tsx` reads `client.projects()/forProject().drafts()/draft()/reviseDraft()/decideDraft()`, used by the App shell and sidebar. The detail is remounted by React key `${record.id}:${record.latest_revision.id}` so a new revision cannot inherit stale local input. There is no fixture UI store.

## Watch out
- Do not read project paths or issue numbers as draft identity; use draft_/drev_/ddecision_ ids and work revision ids. `source_work_revision_id`/`source_content_hash` bind the draft to the imported snapshot.
- Do not reintroduce `can_dispatch` on drafts; #162 derives execution authority from published + read-back + admitted state, not from draft approval.
- `scripts/health/ui-draft-harness.ts` proves UI -> HTTP API -> SQLite -> render with a real temp backend and a deterministic injected planner. It is persistence/view proof, not proof that the AI planning prompt runs end-to-end; the planner seam is covered by `draft-refinement.test.ts` with an injected transport running the real `planDraft`.
- Existing GitHub triage publication remains legacy and unactivated for this lane until the #165 cutover.
