---
title: PR publication uses migration v7 outbox and existing forge transport
author: Muhammad
date: 2026-11-08
branch: t3/ticket-157-publication-audit
id: l-43aabae2
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/work/db.ts
  - apps/backend/src/evidence/observations.ts
  - apps/backend/src/registry/forge.ts
  - apps/backend/src/webhooks/github.ts
---

## Decided
- Ticket #157 adds publication_targets / publication_pull_requests / publication_events / publication_intents / publication_evidence_bindings / publication_summaries in work migration v7. Execution and evidence writers enqueue append-only audit events plus durable publish intents in their existing transactions; PublicationService only reconciles those intents through ForgeAdapter. PR creation is draft, keyed by source branch + candidate SHA, read back and bound exactly. Old active PRs are closed/superseded only when a new candidate needs a replacement. Ambiguous creates/comments/summary updates reconcile by remote head/base or hidden operation markers before retry. Human PR reviews/comments webhooks are ignored as manual feedback.
## Tried and ruled out
- Ruled out a second publication engine/store, publishing from the script loop only, one shared PR per spec delivery for sibling tickets, caller-supplied producer identity for audit, and treating manual PR reviews as factory commands.
## Watch out
- Migration v3 stays reserved for #161 and v6 for #156. Summary body must not include mutable target state in its hash or the accepted-summary key will drift after publish. Forge PR comments share the issue comment surface, so the synthetic adapter mirrors PRs into its issue map.
