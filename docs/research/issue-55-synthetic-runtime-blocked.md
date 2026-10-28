# Issue 55: synthetic runtime research blocked at isolation gate

## Disposition

**Blocked; no Archon workflow or server was started.** The requested actual runtime, live-event, replay and CLI/server-continuity evidence was not obtained. The user's authorization is limited to synthetic workflows in a disposable local environment; it does not authorize the pinned backlog loop or holdout access. This note does not resolve issue 55.

## Evidence and scope

- Read the conclusion at `88d42e7:docs/research/issue-55-conclusion.md` and the pin in `88d42e7:factory/pack.json`. The conclusion records the earlier ticket and comments; the issue itself was not independently retrieved because this task prohibits network access and real `gh` use. Its exact current state is unverified.
- The locally cached Archon checkout reports `5c4f5e484262185926b37b070457fabb9bfedae0` via `git rev-parse HEAD`, matching that pin. No claim is made about the checkout's working-tree integrity.
- On this macOS host, a `sandbox-exec` profile with `deny network*` and explicit localhost network allowances permitted a Python IPv4 loopback bind and denied a direct TCP connection to `1.1.1.1:443` with `PermissionError: [Errno 1]`. This is one bind and one external IPv4 connection probe, not proof for all protocols, address families, or descendants. No loopback client/server exchange was tested.
- An initial executable deny using `/opt/homebrew/bin/gh` failed: `gh --version` ran successfully. That path resolves to `/opt/homebrew/Cellar/gh/2.99.0/bin/gh`. A second profile denying the resolved executable path rejected launching `/opt/homebrew/bin/gh` with `Operation not permitted` (sandbox exit 71). These are two local `--version` launch probes, not tracker operations. The path-specific rule is not proof against copied binaries or other access paths.

## Why execution stopped

The tests above are preliminary controls, not a verified isolation boundary. In particular, no disposable source, home and repository were constructed; filesystem access to production state was not denied and tested; the combined profile was not exercised against descendants, alternate executable paths, all network families or a working local client/server pair. A verified dummy provider and bounded process-tree cleanup were also not established. Starting Archon with these prerequisites unproved would risk violating the authorized scope. A PATH-only fake `gh` would not address direct executable invocation.

Counts: **0 workflows, 0 Archon servers, 0 CLI runs, 0 provider events, 0 replay requests, 0 continuity checks, 0 cancellation tests, 0 holdout reads, 0 tracker operations, 0 pushes**. No test processes were left running. No production code or configuration was changed.

## Remaining work

Create and verify a disposable environment with isolated Archon home, copied pinned source and synthetic Git repository; enforce filesystem confinement, external-network denial with verified local communication, and executable controls that block real `gh` even via alternate paths. Establish a local dummy provider, process-group timeouts and cleanup. Only then run an explicitly synthetic workflow and a separately launched server/CLI against the same isolated state, measuring lifecycle delivery, REST replay and reconnect behavior. Separately test mismatched homes and identify gaps, duplicates and uncertainty. These probes still would not establish production deployment identity, security, cancellation cleanup, or WebSocket semantics.
