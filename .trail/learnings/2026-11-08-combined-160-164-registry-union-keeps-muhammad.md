---
title: "Combined #160+#164 registry union keeps v12 between v11 and v13"
author: Muhammad
date: 2026-11-08
branch: factory/spec-151-integration
id: l-e5c49b07
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/registry/db.ts
  - apps/backend/src/final/service.ts
  - apps/backend/src/final/errors.ts
  - apps/backend/src/final/routes.ts
  - tests/integration/final-delivery.test.ts
---

## Decided
- Merged verified integration cf52ccd (#160 final-spec delivery, version 12) into the #164 settlement repair without touching either lane's schema. SCHEMA_MIGRATIONS composes RESTORE_MIGRATIONS < 12, then FINAL_DELIVERY_MIGRATIONS, then RESTORE_MIGRATIONS > 12 so the one ordered registry stays strictly ascending 1..13 with no fabricated version or rename. FinalDeliveryService.advance, verifyMerge and dispatchCorrection now assert the canonical installation hold at entry (mapped to final_installation_held/409) because advance pushes the integration branch before the delivery runtime's own hold check and dispatchCorrection can push after a repair.
## Tried and ruled out
- Concatenating RESTORE_MIGRATIONS then FINAL_DELIVERY_MIGRATIONS (would be 11,13,12 and fail the strictly-ascending registry assert). Guarding only DeliveryRuntime.process and assuming advance's pre-runtime push was covered.
## Watch out
- Registering future migrations requires appending after v13; filtering restore migrations by 12 would silently drop a restore version between 11 and 13. The v11-only lineage test now rebuilds publication_intents with the genuine pre-v13 CHECK plus rows and updates the manifest row count, so deleting only schema_migrations would be a regression.
