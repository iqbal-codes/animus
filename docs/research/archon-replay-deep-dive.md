# Archon replay and detached lifecycle: offline follow-up to #55

## Verdict and boundary

**Issue #55 cannot honestly close.** The tests below strengthen the replay and SQLite configuration evidence but do not establish the actual deployment's shared state, detached CLI-to-server delivery, authorization, control propagation, safe transcript projection, or proposed WebSocket semantics. The earlier note at `f0ff8fee:docs/research/archon-live-controls.md` covers the broader source survey and remains part of this evidence; its checks and caveats are not repeated as new results here. The issue body and its progress comment were read; no tracker mutation was made.

**Revision.** `factory/pack.json:2-3` pins Archon `5c4f5e484262185926b37b070457fabb9bfedae0`; the local cached checkout's `git rev-parse HEAD` matched. Upstream citations below refer to that revision. No holdout content, live workflow, user data, or network was used by the probes. The tracker read was a separate read-only `gh issue view 55 --json title,body,comments` operation. The engine checkout was not modified. Synthetic tests used isolated temporary HOME and ARCHON_HOME and unset DATABASE_URL.

## Results

1. **Observed — actual pinned SQLite connection across processes.** Three separate Bun processes imported the pinned `getDatabase`, wrote a synthetic row with home A, read one row with home A, and read zero rows with home B. The returned paths were respectively `A/archon.db`, `A/archon.db`, and `B/archon.db`. This exercises the real adapter/selection, not the actual Factory CLI or server. [Connection selection and singleton](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/core/src/db/connection.ts#L28-L70); Factory's child inherits its host environment (`apps/engine-host/src/native.ts:138-141,311-314`). **[INFERENCE]** Matching effective SQLite path and filesystem mount is necessary for those processes to share that database; matching `ARCHON_HOME` strings across different mounts is insufficient. PostgreSQL selection by nonempty `DATABASE_URL` is source-observed, not exercised here; do not compare or print real URLs. This probe does not establish actual deployment identity or schema compatibility.
2. **Observed — real SQLite reader contract, 3/3 passed.** Upstream [SQLite integration](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/core/src/db/workflow-events.provider-events.integration.test.ts#L1-L43) uses an in-memory database with a mocked connection seam. Its [shared reader contract](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/core/src/db/provider-events.reader-contract.ts#L55-L241) verifies legacy null-attempt conversion, out-of-order writes sorted by sequence within an attempt, first-appearance attempts and node grouping, later-attempt cursor results, unknown attempt returning empty, malformed envelope skipped, and provider rows not changing the DAG resume snapshot. It does not run HTTP, concurrent writers or Postgres.
3. **Observed — gap and attempt-rank counterexamples at the actual pure functions.** With stored A:0, A:2, B:0, replay after A:0 returns A:2 and B:0. After late A:1 arrives, replay after A:2 omits A:1; replay after A:0 returns A:1, A:2, B:0. Advancing to B:0 also omits the late A:1. An unknown attempt returns empty. Input order B:0 then A:0 ranks B before A, so a cursor after B returns A, irrespective of any independent chronological meaning of attempt IDs. [Ordering and cursor implementation](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/workflows/src/schemas/provider-event.ts#L55-L91). **[INFERENCE]** Keeping a per-attempt contiguous watermark is necessary but not sufficient: switching to a later attempt can also lose late older-attempt writes. Periodic full per-step reconciliation and deduplication by `(run, step, attempt, seq)` for nonlegacy envelopes is a conservative candidate, not a proven complete algorithm; missing or permanently failed writes, mutable attempt ordering and legacy records need explicit handling. Legacy null IDs cannot be supplied as the endpoint's nonempty attempt cursor ([schema](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/server/src/routes/schemas/workflow.schemas.ts#L213-L239)).
4. **Observed — lifecycle unit tests, 17/17 passed.** [Poller tests](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/server/src/adapters/web/dashboard-event-poller.test.ts) mock the database query and transport. They establish lifecycle mapping, same-boundary deduplication, drain coalescing and idle no-query behavior under their fixture, not cross-process SSE. The [poller](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/server/src/adapters/web/dashboard-event-poller.ts#L1-L153) starts at current time, only queries with an active dashboard, and limits a drain to 500. **[INFERENCE]** It is an invalidation hint, not a durable lossless lifecycle log; a saturated boundary and disconnects require reconciliation.
5. **Observed — bridge unit tests, 13/13 passed.** [Bridge tests](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/server/src/adapters/web/workflow-bridge.test.ts#L164-L233) emit synthetic in-process provider and cancellation events: provider event goes to the worker conversation only; lifecycle reaches worker, parent and dashboard. This does not demonstrate a detached process, an actual SSE socket, or recovery over HTTP. Source separately describes the detached-process DB poller and filtering ([poller](https://github.com/coleam00/Archon/blob/5c4f5e484262185926b37b070457fabb9bfedae0/packages/server/src/adapters/web/dashboard-event-poller.ts#L1-L19)).

## Reproduction

Requires the pinned checkout with its dependencies already installed and Bun; no installation or network. Run each upstream test in a separate process because the SQLite integration mocks modules. `mktemp` directories contain only synthetic state; preserve or remove them according to local policy.

```sh
ARCHON=/Users/efishery/.cache/factory/archon/5c4f5e484262185926b37b070457fabb9bfedae0
[ "$(git -C "$ARCHON" rev-parse HEAD)" = 5c4f5e484262185926b37b070457fabb9bfedae0 ] || exit 1
for test in \
  packages/core/src/db/workflow-events.provider-events.integration.test.ts \
  packages/server/src/adapters/web/dashboard-event-poller.test.ts \
  packages/server/src/adapters/web/workflow-bridge.test.ts; do
  d=$(mktemp -d)
  (cd "$d" && env -u DATABASE_URL HOME="$d" ARCHON_HOME="$d/archon" bun test "$ARCHON/$test") || exit 1
done
```

For the cross-process and replay function probe, save the following as `$d/probe.ts`; substitute the pinned checkout path in the imports if necessary. Run from a temporary directory, not the engine checkout:

```ts
import { getDatabase, getDatabaseType, getSqliteDbPath, closeDatabase } from '/Users/efishery/.cache/factory/archon/5c4f5e484262185926b37b070457fabb9bfedae0/packages/core/src/db/connection.ts';
import { orderProviderEventRecords, providerEventRecordsAfter } from '/Users/efishery/.cache/factory/archon/5c4f5e484262185926b37b070457fabb9bfedae0/packages/workflows/src/schemas/provider-event.ts';
import { strict as assert } from 'node:assert';
const db = getDatabase();
assert.equal(getDatabaseType(), 'sqlite');
await db.query('CREATE TABLE IF NOT EXISTS proof55 (value TEXT)');
if (process.argv[2] === 'write') await db.query("INSERT INTO proof55 VALUES ('synthetic')");
const result = await db.query<{value:string}>('SELECT value FROM proof55');
assert.equal(result.rows.length, Number(process.argv[3]));
const ord = (xs: {attemptId:string|null,seq:number}[]) => orderProviderEventRecords(xs);
const cursor = {attemptId:'a',seq:0};
const partial = ord([{attemptId:'a',seq:0},{attemptId:'a',seq:2},{attemptId:'b',seq:0}]);
assert.deepEqual(providerEventRecordsAfter(partial,cursor).map(x=>[x.attemptId,x.seq]),[['a',2],['b',0]]);
const late = ord([...partial,{attemptId:'a',seq:1}]);
assert.deepEqual(providerEventRecordsAfter(late,{attemptId:'a',seq:2}).map(x=>[x.attemptId,x.seq]),[['b',0]]);
assert.deepEqual(providerEventRecordsAfter(late,cursor).map(x=>[x.attemptId,x.seq]),[['a',1],['a',2],['b',0]]);
assert.deepEqual(providerEventRecordsAfter(late,{attemptId:'b',seq:0}),[]);
assert.deepEqual(providerEventRecordsAfter(late,{attemptId:'unknown',seq:0}),[]);
const reordered = ord([{attemptId:'b',seq:0},{attemptId:'a',seq:0}]);
assert.deepEqual(providerEventRecordsAfter(reordered,{attemptId:'b',seq:0}).map(x=>x.attemptId),['a']);
console.log(JSON.stringify({path:getSqliteDbPath(),rows:result.rows.length}));
await closeDatabase();
```

```sh
d=$(mktemp -d); mkdir "$d/a" "$d/b"
# Save the preceding code to "$d/probe.ts" before running:
for args in 'a write 1' 'a read 1' 'b read 0'; do
  set -- $args
  env -u DATABASE_URL HOME="$d" ARCHON_HOME="$d/$1" bun "$d/probe.ts" "$2" "$3" || exit 1
done
```

Observed with Bun 1.4.0: upstream suites 3/3, 17/17 and 13/13 pass; probe processes report row counts 1, 1, 0 and all assertions pass. These checks do not run the endpoint, server, CLI or workflow.

## Remaining proofs and supported seam

**[INFERENCE]** Use persisted provider replay per step with repeated reconciliation, and dashboard lifecycle messages only as refetch hints; keep native Archon as control authority. Treat raw events, failures and feedback as sensitive until an authorized safe projection is demonstrated. Never assert WebSocket semantics merely from SSE source.

Still needed: a synthetic separate writer plus actual server/poller and REST/SSE recovery; real deployment effective DB identity (including Postgres and mount boundaries); integration tests of gaps across attempts, reconnect, legacy, malformed/failed writes and duplicates; auth/proxy boundaries; cross-process cancellation and cleanup races; exact loop gate/stale response and resume; and synthetic secret/holdout-like filtering. The prior note details those constraints and the distinction between Factory's launch brake and in-flight pause. None is proved by these tests; no control or tracker change is authorized by this research.
