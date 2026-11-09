---
title: "Combined #158+#162 integration: single ordered registry union and disjoint publication fences"
author: Muhammad
date: 2026-11-08
branch: factory/spec-151-integration
id: l-02e8b5f5
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/registry/db.ts
  - apps/backend/src/main.ts
  - packages/client/src/index.ts
  - tests/integration/schema-migrations.test.ts
  - tests/integration/work-persistence.test.ts
  - apps/backend/src/publication/issues.ts
---

## Decided
- Merged verified #162 (d28d0ab) into the #158 child-integration candidate (d7d3831) as a real merge commit 71ad99c (no cherry-pick/rewrite), then guarded fast-forwarded factory/spec-151-integration d28d0ab..71ad99c and pushed hooks-enabled (origin exact, 0/0). Conflicts were mechanical only: registry/db.ts became one SCHEMA_MIGRATIONS union v1..v8 then v10 (v9 reserved for #159), keeping a single ordered registry and no second runner; main.ts kept both /integration and /draft-publications routes plus ChildIntegrationService and DraftPublicationService; client index unioned both contract import sets; the two migration tests unioned expected versions and the applied count moved 7->9 (v1..v8+v10). No semantic conflict because #158 (integration/schema, dispatch, observations, forge) and #162 (publication/issues, issue-schema) touch disjoint regions; operator.ts/operations.ts/publication service/draft UI auto-merged with both features intact.
## Tried and ruled out
- Ruled out cherry-picking the #162 tip (would rewrite lineage and break the verified ancestry proof), renumbering the #162 migration into the v9 gap (would fabricate a version reserved for #159 and diverge from the shipped v10 evidence), and leaving the migration test count at 7 (wrong once both lanes land). Also ruled out touching root untracked .commandcode/.trail/statusline.cjs and any production activation.
## Watch out
- The v10 migration rebuilds publication_intents in place (DROP+RENAME) with FK ON, so an upgrade probe must seed a real FK chain (project + target) or the copy fails on orphan target_id; a genuine v7 DB with a legacy create_pr intent upgrades to [1..8,10] preserving resource_kind='pull_request', draft_publication_id NULL and remote_object_id. #162 fences must stay: wasAmbiguous captured before markIntentUnknown and assertBoundRevision on every non-admitted publication regardless of member resolution. Child-gate v2 (technical_checks AND independent_review) plus required remote CI is the merge gate; synthetic forge merge_sha is never accepted as lineage.
