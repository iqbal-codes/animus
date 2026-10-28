# Verify Archon live events, replay, and run controls — research conclusion

## Disposition

**Do not resolve the research ticket yet.** There is enough evidence to rule out several proposed capabilities and to sketch a conservative integration seam, but the question explicitly asks for the actual loop, CLI/server state sharing and proof of proposed WebSocket semantics. Those remain unproved, not merely implementation tasks. The map calls for planning, not construction; lack of permission to execute a real workflow is not evidence that its behavior works. This note is research only and does not authorize tracker changes or implementation.

Sources: [ticket and comments](https://github.com/iqbal-codes/labq-software-factory/issues/55), [map](https://github.com/iqbal-codes/labq-software-factory/issues/46), [initial research at f0ff8fee](https://github.com/iqbal-codes/labq-software-factory/blob/f0ff8fee192d641acc13c7f9b4ead71818b291ed/docs/research/archon-live-controls.md), and [offline follow-up at d239fa4](https://github.com/iqbal-codes/labq-software-factory/blob/d239fa4/docs/research/archon-replay-deep-dive.md). The two notes contain pinned upstream source links, line references, probe details and limitations; their reported test results are prior evidence, not tests rerun for this conclusion. The ticket remains open and assigned; its two comments themselves say it is not resolved.

Factory baseline is `5fa30a37748d0acde86a6fc6c0fc3ba49d5e8105`; `factory/pack.json` pins Archon `5c4f5e484262185926b37b070457fabb9bfedae0`. The cached upstream checkout was independently checked with `git rev-parse HEAD` and matched that pin. The map's agreed destination keeps Archon authoritative and excludes a parallel engine or state machine.

## Answers, bounded by evidence

| Question | Answer and boundary |
| --- | --- |
| Lifecycle and transcripts | Native run detail, dashboard SSE and step-scoped provider-event REST are separate surfaces. The Factory baseline exposes lap list/detail through a limited CLI projection, not live events or transcript routes. In-process conversation SSE is not evidence that detached CLI provider events reach a server. Dashboard lifecycle SSE is a hint, not a durable event log. See the [initial note](https://github.com/iqbal-codes/labq-software-factory/blob/f0ff8fee192d641acc13c7f9b4ead71818b291ed/docs/research/archon-live-controls.md#ordering-replay-and-streaming). |
| Replay/order | Provider cursor requires step, attempt and sequence; it is not a global run cursor. Unknown attempts can yield empty responses; legacy null-attempt records are not expressible in that cursor. Late writes and advancing to a later attempt can hide older events. The follow-up's synthetic probes demonstrate that a contiguous watermark alone is insufficient. Full per-step reconciliation and deduplication are a **candidate**, not a proven lossless protocol, particularly for legacy, malformed or permanently missing rows. |
| Shared state | Earlier isolated processes using the actual SQLite adapter shared synthetic data with the same home and did not with a different home. This does not establish actual Factory CLI/server identity, same filesystem mount, PostgreSQL identity or schema compatibility. No real deployment configuration was examined. |
| Cancel/cleanup | Native owner-checked cancellation exists for running runs; cross-process stop can refuse, race, or have partial descendant and cleanup results. Paused/failed abandon is distinct. Factory has no per-run cancellation route. Source evidence and mocked/unit checks are not proof that actual process trees and containers are stopped in the deployed topology. |
| Pause/resume/steering | Factory PAUSE is a new-launch brake, not an in-flight pause. Native resume applies to paused/failed runs; response and signal target authored gates/waits, not arbitrary running-agent steering. The top-level pinned `archon-loop.yaml` was read without opening holdout scenarios: it contains command, script and included-workflow nodes, not a top-level authored `gate` or `wait` node. This does **not** inventory the included workflows or prove a live lap cannot enter a nested gate. No arbitrary pause or steering is established. |
| Authorization and secrets | Native action authorization and conditional web authentication are separate from the Factory host bearer token; the baseline backend has no demonstrated incoming per-user authorization. Raw provider envelopes may include tool output; they cannot be presumed safe for operators. [INFERENCE] Transcripts, errors, feedback and replay need fail-closed authorization and a proven safe projection against synthetic secret and holdout-like material. No holdout content was read. |
| WebSocket | The inspected native live surface is SSE; no native WebSocket control contract or proposed Factory gateway semantics has been demonstrated. Do not call a WebSocket feature supported merely because frontend planning names WebSocket. |

The original note also identifies a fixed-positive Factory evidence/reviewer projection in `apps/engine-host/src/native.ts`; it must not be treated as proof of approval or verification.

## Recommended seam — conditional, not a supported feature claim

[INFERENCE] Keep Archon as the run/control authority. If identity and security can be proved, an engine-host adapter can expose an authorized, restricted projection from native run detail and provider replay, using lifecycle notifications only to trigger refetch. Reconcile the complete relevant step history, deduplicate, signal uncertainty/gaps and preserve native refusal, stale-state and partial-cleanup outcomes. Expose only actual authored interaction points, never arbitrary steering. A Factory WebSocket, if chosen, is a new contract, not an Archon protocol; its reconnect, ordering, authorization and error semantics need their own proof. If safe transcript projection cannot be established, do not expose raw transcript data.

## Research still required before the question is resolved

All the following can be designed around synthetic inputs and isolated temporary state; no real workflow execution is authorized by this ticket.

1. Exercise an actual pinned server/poller and separate synthetic writer against the same isolated database: establish lifecycle SSE behavior, provider REST recovery, disconnects, duplicates, saturation and no unsupported detached provider-SSE promise. Verify differing database configurations fail closed. Establish actual CLI/server database identity separately when an actual deployment exists, without disclosing credentials.
2. Exercise HTTP replay and reconciliation under late writes across attempts, unknown cursors, legacy and malformed records, failed persistence and reconnect. Define when a gap is reported and when completeness is unknowable; prove any proposed WebSocket gateway semantics rather than assuming SSE properties transfer.
3. Test authenticated and unauthorized read/action cases, disabled-auth configuration and proxy identity trust, including endpoint and gateway boundaries. Test synthetic secret and holdout-like payloads through all output paths; fail closed for unknown content.
4. Exercise real native cancellation operations with synthetic owners/children, stop failure, races and cleanup outcomes; distinguish acknowledgement from verified termination. Verify authored gate response, stale pause identity and headless resume, and inventory relevant nested loop interaction points without reading holdout scenarios.

Some deployment-specific identity, resource cleanup and end-to-end security claims may remain implementation/deployment acceptance evidence even after an isolated research design is settled. They must be named as such rather than being treated as already passed. If the research scope is later narrowed by the owner, a decision based on the current conservative evidence may be possible; that is not the current ticket's stated contract.

## Checks in this session

- **PASS:** Read the ticket and both comments, map, Wayfinder skill, research skill, both existing research-branch notes, Factory pin and the top-level pinned loop graph; verified cached upstream revision against the pin.
- **NOT RUN:** Workflow execution, real deployment inspection, holdout inspection, server/integration probes or test suites. Previously reported passing offline tests remain attributed to the earlier note; they were not independently rerun here.
- **No tracker or product changes.** This file is the research-only artifact.
