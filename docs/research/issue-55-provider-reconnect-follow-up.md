# Issue 55: provider replay and reconnect follow-up — incomplete

## Result

**The requested positive HTTP provider replay and actual disconnect/reconnect experiment remains unperformed.** No provider was invoked, no event was injected into a running server, and no SSE connection was opened. The prior server experiment at `1756e38:docs/research/issue-55-local-server-synthetic-events.md` observed a second concurrent connection, not a reconnect; it cannot fill this gap. Issue 55 remains unresolved.

A narrower offline control was repeated: the pinned upstream SQLite provider-event reader integration suite passed **3/3 tests, 9 assertions**, in 309 ms with Bun 1.4.0. This is controlled test-data injection into an in-memory SQLite database, **not an actual provider** and not HTTP replay. The suite exercises the reader's legacy/envelope ordering, cursor cases and resume-snapshot isolation using the upstream fixture (`packages/core/src/db/provider-events.reader-contract.ts`); it does not exercise the requested cross-process topology. Earlier results and limitations are recorded at `d239fa4:docs/research/archon-replay-deep-dive.md` and `cc0fd5c:docs/research/issue-55-synthetic-isolation-and-events.md`.

## Isolation and method

The cached source reported Git HEAD `5c4f5e484262185926b37b070457fabb9bfedae0`. The checkout and installed dependencies were not independently integrity-audited. The single test process ran under macOS `sandbox-exec`, with a fresh canonical `/private/tmp/issue55-reader.KYGzSgPQ` root for `HOME`, `ARCHON_HOME` and `TMPDIR`, an otherwise empty environment, system-only PATH, and telemetry disabled. The profile denied all network operations, writes outside that root except `/dev/null`, reads of this checkout's `.factory/holdout`, and execution of the resolved real `gh` binary. No issue tracker was consulted. No workflow, production state, backlog, or holdout content was used. The process exited normally; the owned disposable root was removed afterwards.

The policy is not a hostile-code boundary: other file reads are allowed, and the `gh` denial is path-specific. Unlike the earlier experiments, no independent negative preflight was run for this profile, so the isolation claim is the configured policy, not a measured comprehensive containment proof. The test used an in-memory DB rather than the server's disposable SQLite database. Its source checkout was not copied or modified.

## Required next experiment

Using the user-authorized synthetic-only scope and the controls in `1756e38` and `cc0fd5c`, start a supervised local server with an isolated shared database and a single permitted loopback endpoint. Verify network and real-`gh` denial before running. Seed a synthetic run and inject valid provider-event envelopes using the actual persistence seam from a separate process; label the input as injection, not provider output. Query the real HTTP endpoint with and without step and attempt/sequence cursors, including multiple attempts and a deliberately late sequence. Record exact response identities and ordering. Separately open the dashboard SSE stream, close it and confirm disconnection, write synthetic lifecycle events during the gap, reconnect, and compare stream observations against durable run detail and provider replay. Bound timeouts and clean up only owned processes and the disposable root. Do not infer replay from an empty heartbeat or from a second simultaneous connection.

Even a successful controlled injection would not prove real provider emission, production authorization, deployment identity, safe transcript projection or WebSocket behavior.
