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
fsynced. A rename alone is not a compare-and-swap: every write holds an
`O_EXCL` owner-token lock (`.execution-authority.lock`) across the whole
read -> compare -> write -> rename -> fsync sequence. A competitor may reclaim a
stale lock only when the recorded pid is proven dead (`ESRCH`); missing or
unreadable ownership is ambiguous and fails closed for operator recovery. There
is no time-based steal. `expected` therefore behaves as a true cross-process
compare-and-swap, so two processes cannot both observe the same predecessor.
A malformed marker reads as `legacy` with an `error` surfaced by
`animus authority status`; it never activates silently.

All consumers read this marker. External writers also require the authority to be
*settled*: `legacy` (before cutover) or a `local` marker backed by an `activated`
cutover row. A `migrating` fence, an unreadable marker, or a `local` marker with a
staged/activating operation stays fenced.

| Consumer | Legacy | Migrating | Local |
| --- | --- | --- | --- |
| `apps/backend/src/dispatch` | `authority_not_activated` | `authority_not_activated` | dispatch admitted plans |
| `apps/backend/src/monitor` | GitHub/filesystem schedule | local tick fails closed | local dispatch tick |
| `scripts/scheduler.ts` | local scheduler refused | refused | local scheduler |
| `scripts/cli/commands/loop.ts` | GitHub loop | `execution_authority_moved` | local scheduler |
| `apps/engine-host/src/native.ts` | native launch | `execution_authority_moved` | `execution_authority_moved` |
| `scripts/loop/session.ts` (mid-lap) | legacy lap may run | `execution_authority_moved` before save/role/CI/publisher | `execution_authority_moved` |
| `scripts/loop/merge-queue.ts` | legacy ref/DB/push/merge | `execution_authority_moved` (no DB row, no push) | `execution_authority_moved` |
| `apps/backend/src/publication` (PR + draft issues) | publish/reconcile | 409 `execution_authority_moving` | publish/reconcile |
| `apps/backend/src/integration` (child land) | land | 409 `execution_authority_moving` | land |
| `apps/backend/src/final` (advance/verify/correction) | advance | 409 `execution_authority_moving` | advance |
| `apps/backend/src/delivery` (verify merge) | verify | 409 `execution_authority_moving` | verify |
| GitHub webhook | issue/CI events wake legacy | no execution mutation | CI observation only |

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

1. Acquire the cross-process cutover operation lock (`.authority-cutover.lock`)
   and write the `migrating` fence (true CAS from `legacy`/`migrating`); create or
   resume the operation row.
2. Inventory every real table, finalized artifact file and the registered-project
   legacy filesystem state deterministically. The legacy scan derives canonical
   `<project stateRoot>/{runs,dossiers,locks,worktrees}` roots from the `projects`
   table only; it never walks arbitrary filesystem paths. A live run/issue
   lock/worktree owner (or a malformed/unreadable/ambiguous state file) blocks
   staging with `cutover_writers_active`, even when no `project_runs` row exists.
   Dead pids (`ESRCH`) are stale, not live; missing ownership identity is
   ambiguous and held. Active DB run/process ownership, active controls and a
   held installation also block staging.
3. Create a verified #164 backup. SQLite's own `BEGIN IMMEDIATE` drain boundary
   makes the snapshot consistent across connections and processes; the verified
   bundle becomes the old-state evidence.
4. Restore that bundle into an isolated state directory and require the restored
   installation to be held. A released restore is not proof.
5. Re-inventory the live database, the backup snapshot and the isolated restore.
   Live and snapshot state digests and the legacy-filesystem digest must match;
   identity digests must survive the restore; artifact digests must match.
6. Persist mappings and operation evidence. Staging is resumable: an existing
   verified bundle and held restore are reused instead of recreated.

Staging never rewrites project, work, plan, delivery, run, revision, candidate,
head/base/branch or GitHub audit identities.

## Activation and abort

`POST /api/v1/authority/activate` requires the exact cutover id, inventory digest
and backup manifest digest. Under the same operation lock it re-inventories the
live installation, refuses on any held writer or drift, re-verifies the exact
backup and the held restore, marks the operation `activating` under a real SQLite
`BEGIN EXCLUSIVE`, and then commits `activated` **before** writing the `local`
marker. A crash after the DB commit but before the marker write leaves the
`migrating` fence, so neither legacy nor local writers can start; the next
`activate`/`status` finalizes the verified row into the marker. `status()` reports
`authorityConsistent: false` and a blocking reason whenever a `local` marker is
not backed by an `activated` row, so a read never authorizes an incomplete
activation.

`POST /api/v1/authority/abort` is allowed only before `local`. Under the same
operation lock it writes `legacy` with CAS from `migrating` and marks the operation
aborted. A concurrent abort/activate/stage therefore produces one winner and one
conflict, never a local marker with an aborted row or a legacy marker with an
activated row. After activation there is no dual-read/write rollback: the
supported rollback is restoring a validated snapshot into an isolated held
installation and reconciling it, exactly as #164 defines. Old code is never
re-pointed at state written by the new authority.

## Operator surfaces

- Backend: `GET /api/v1/authority`, `GET /api/v1/authority/mappings`,
  `POST /api/v1/authority/{stage,activate,abort}`.
- CLI: `animus authority status|stage|activate|abort|mappings`; `status` opens the
database read-only through `openReadOnlyDatabase`, which configures the
connection-scoped busy timeout/foreign keys and reports the observed journal mode,
synchronous mode, foreign-key flag and busy timeout as `pragmas`. It is **not** an
`initializeDatabase` call and never claims to run migrations. `animus backup
create|restore` works offline with `--state-dir` through the same
`BackupRestoreService` used by the HTTP routes, so a packaged binary can prove a
real backup and isolated held restore on the build host.
- App: the existing Jobs screen renders the authority panel with persisted
  legacy/migrating/local phases, held reasons (including legacy filesystem runs,
  locks and worktrees), backup and isolated-restore proof, an inconsistent-local
  activation warning, and stage/activate/abort actions. No fake UI data.

## Invariants

- No second engine, workflow database, authority marker or per-module migration.
- No permanent dual-read/write compatibility path and no deprecated aliases.
- A rename is never treated as a compare-and-swap; marker and cutover transitions
  are serialized by owner-token locks with ESRCH-only stale recovery.
- Legacy writers re-check the fence at every outward mid-lap effect, not only at
  process startup.
- Live builder processes and uncommitted worktrees are not resurrected.
- Legacy user data is preserved until separately authorized for removal.
- Automated tests are offline with injected forge/model/process transports.
