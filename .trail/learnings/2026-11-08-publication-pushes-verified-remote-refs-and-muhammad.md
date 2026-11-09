---
title: Publication pushes verified remote refs and reconciles unknown intents
author: Muhammad
date: 2026-11-08
branch: t3/repair-ticket-157-publication-audit
id: l-a2ff6e34
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/publication/service.ts
  - apps/backend/src/publication/schema.ts
  - apps/backend/src/publication/outbox.ts
  - apps/backend/src/registry/forge.ts
  - apps/backend/src/registry/db.ts
  - tests/integration/publication.test.ts
---

## Decided
- Ticket #157 remediation: PublicationService now pushes the exact committed source branch to the recorded remote with the bounded processRun transport and persists remote_source_ref/sha before any PR create. It validates repository/head/base/headRefOid from transport read-back and refuses missing, advanced, or wrong-repo heads. Superseded PRs are retired only after the replacement is verified; retirement failures are durable (remote_retired) and retried. Crash-stuck attempting create intents coerce to unknown and reconcile by remote read-back. All inline review comment bodies pass the outbound sanitizer. bindEvidence reuses validateHostedAssetUrl and renders link destinations as angle-bracket Markdown. Audit completeness now requires remote source proof and a valid supplied URL for every finalized artifact. SystemForgeAdapter PR methods use the injectable bounded runner; getPullRequest returns null only for genuine GitHub not-found and throws on auth/outage/malformed responses. Publication v7 moved to publication/schema.ts appended after v5 in the unified registry, leaving v6 reserved.
## Tried and ruled out
- Ruled out keeping the per-module applyWorkMigrations runner for v7, fabricating PRs against local-only branches, treating any gh failure as a closed PR, superseding an old PR before the replacement exists, and a second weaker evidence URL validator.
## Watch out
- A healthy remote read must clear only remote_pull_request_unreadable; durable retirement failures must stay visible until reconciliation closes the old PR. SyntheticForgeAdapter needs resolveHeadRefOid plus requireRemoteSourceRef to model a real remote in offline tests/harnesses. Push/ls-remote tests rewrite the recorded GitHub origin to a temporary bare repo with url.<bare>.insteadOf.
