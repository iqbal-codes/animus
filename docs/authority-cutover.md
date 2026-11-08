# Execution authority cutover

Status: implemented in ticket #165. One durable authority marker, one SQLite
database, one workflow engine. This document is the architecture and schema
contract for upgrading an existing mixed GitHub/filesystem installation.

## Authority marker

`<state>/execution-authority.json` is the only execution-authority marker. It is
written with `writeExecutionAuthority` (`packages/contracts/src/execution-authority.ts`):

- `legacy` — the safe default; existing GitHub/filesystem writers may run.
- `migrating` — durable fence written before staging. Every legacy writer and
  every local dispatcher fails closed; an interrupted cutover can never leave two
  writers active.
- `local` — written only after the staged backup, isolated held restore and live
  inventory were re-verified.

Writes are fsynced to a temporary file, atomically renamed, and the directory is
fsynced. `expected` provides compare-and-swap so a concurrent activation or abort
cannot overwrite a newer marker. A malformed marker reads as `legacy` with an
`error` surfaced by `animus authority status`; it never activates silently.

All consumers read this marker per tick:

| Consumer | Legacy | Migrating | Local |
| --- | --- | --- | --- |
| `apps/backend/src/dispatch` | `authority_not_activated` | `authority_not_activated` | dispatch admitted plans |
| `apps/backend/src/monitor` | GitHub/filesystem schedule | local tick fails closed | local dispatch tick |
| `scripts/scheduler.ts` | local scheduler refused | refused | local scheduler |
| `scripts/cli/commands/loop.ts` | GitHub loop | `execution_authority_moved` | local scheduler |
| `apps/engine-host/src/native.ts` | native launch | `execution_authority_moved` | `execution_authority_moved` |
| GitHub webhook | issue/CI events wake legacy | observation only | CI observation only |

Manual issue edits, labels, closure, PR comments and request-changes never
mutate accepted contracts or create laps. After cutover, GitHub is publication,
remote CI and merge fact only; new work is explicitly imported through intake.

## Durable schema (migration 15)

`authority_cutover_operations` records one restartable operation per attempt:
phase (`staging`, `staged`, `activating`, `activated`, `aborted`, `failed`),
inventory digest, backup snapshot/path/manifest digest, isolated restore
operation/target, held/total counts, and the validated report. Partial unique
indexes allow at most one in-flight and one activated operation.

`authority_cutover_mappings` records deterministic `entity + legacy_id -> new_id`
identity with legacy/new row hashes and a disposition (`preserved`,
`preserved_history`, `adopted`, `held`). Legacy audit rows are preserved as
history, never as executable authorization. Nothing is deleted or re-imported.

Version 14 stays unused because #163 is a read-only projection. #165 reserves 15.

## Stage

`POST /api/v1/authority/stage` (or `animus authority stage`):

1. Write the `migrating` fence (CAS from `legacy`/`migrating`) and create/resume
   the operation row.
2. Inventory every real table and finalized artifact file deterministically.
   Active run/process ownership, active controls, live legacy runs and a held
   installation block staging with `cutover_writers_active`.
3. Create a verified #164 backup. SQLite's own `BEGIN IMMEDIATE` drain boundary
   makes the snapshot consistent across connections and processes; the verified
   bundle becomes the old-state evidence.
4. Restore that bundle into an isolated state directory and require the restored
   installation to be held. A released restore is not proof.
5. Re-inventory the live database, the backup snapshot and the isolated restore.
   Live and snapshot state digests must match; identity digests must survive the
   restore; artifact digests must match.
6. Persist mappings and operation evidence. Staging is resumable: an existing
   verified bundle and held restore are reused instead of recreated.

Staging never rewrites project, work, plan, delivery, run, revision, candidate,
head/base/branch or GitHub audit identities.

## Activation and abort

`POST /api/v1/authority/activate` requires the exact cutover id, inventory digest
and backup manifest digest. It re-inventories the live installation, refuses on
any held writer or drift, re-verifies the exact backup and the held restore, marks
the operation `activating`, then writes the `local` marker with CAS from
`migrating`. A crash after the marker but before the DB update is reconciled on
the next `activate`/`status`; a crash before the marker resumes from `activating`.

`POST /api/v1/authority/abort` is allowed only before `local`. It writes `legacy`
with CAS from `migrating` and marks the operation aborted. After activation there
is no dual-read/write rollback: the supported rollback is restoring a validated
snapshot into an isolated held installation and reconciling it, exactly as #164
defines. Old code is never re-pointed at state written by the new authority.

## Operator surfaces

- Backend: `GET /api/v1/authority`, `GET /api/v1/authority/mappings`,
  `POST /api/v1/authority/{stage,activate,abort}`.
- CLI: `animus authority status|stage|activate|abort|mappings`; `status` reads the
  durable local marker and database without a server, so a packaged binary proves
  SQLite/PRAGMA support.
- App: the existing Jobs screen renders the authority panel with persisted
  legacy/migrating/local phases, held reasons, backup and isolated-restore proof,
  and stage/activate/abort actions. No fake UI data.

## Invariants

- No second engine, workflow database, authority marker or per-module migration.
- No permanent dual-read/write compatibility path and no deprecated aliases.
- Live builder processes and uncommitted worktrees are not resurrected.
- Legacy user data is preserved until separately authorized for removal.
- Automated tests are offline with injected forge/model/process transports.
