# Issue 55: synthetic offline cancellation probe

## Result

A detached, synthetic CLI workflow was actually cancelled: its owner, bash node and `/bin/sleep 300` child were absent from `ps` immediately after the cancel command returned, and the isolated database recorded `cancelled`. The CLI returned `ok: true` and `processStopped: true`. This is one observation of a same-process-group child, not proof of detached descendants, containers, concurrent races, server cancellation, production cleanup, or issue 55 resolution. A preceding foreground attempt was correctly refused and required supervisor cleanup. No real model, backlog, production workflow, tracker, or holdout contents were used.

This extends `cc0fd5c:docs/research/issue-55-synthetic-isolation-and-events.md`; see that note for the profile's limitations. No network or tracker was consulted. The local cached checkout reports revision `5c4f5e484262185926b37b070457fabb9bfedae0`; its working-tree integrity was not independently established.

## Isolation and controls

A new canonical disposable root, `/private/tmp/issue55cancel.9mKmFy`, contained an independent source copy and local dependencies, isolated home, Archon home, temporary directory and two newly initialized unrelated synthetic Git repositories. The source copy excluded `.git` and `.archon`. The CLI ran with an empty environment except `HOME`, `ARCHON_HOME`, `TMPDIR`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and `ARCHON_TELEMETRY_DISABLED=1`. Bun was invoked by its absolute local path. The only workflow commands were shell bookkeeping and `/bin/sleep`.

The effective macOS `sandbox-exec` profile used `allow default`, denied `file-write*`, then allowed writes only to the canonical disposable root and `/dev/null`; denied reads of this checkout's `.factory/holdout`; denied `network*`, then allowed loopback bind/inbound/outbound and Unix sockets; and denied `process-exec` of the freshly resolved real gh path `/opt/homebrew/Cellar/gh/2.99.0/bin/gh`. Before any workflow, tests under that same profile produced:

```text
external ('1.1.1.1', 443) 1 Operation not permitted
external ('2606:4700:4700::1111', 443) 1 Operation not permitted
loopback b'x'
unix b'y'
gh /opt/homebrew/bin/gh 1 Operation not permitted
gh /opt/homebrew/Cellar/gh/2.99.0/bin/gh 1 Operation not permitted
home write 1 Operation not permitted
holdout list 1 Operation not permitted
child external exit 1 EPERM True
```

The Apple Python launcher additionally printed `python3: error: couldn't create cache file ... (errno=Operation not permitted)`; the tests still ran. Controls are sampled, not a general security proof: reads outside the root are mostly allowed, loopback and Unix sockets are not namespace-isolated, and a copied or alternate gh executable is not covered by the path rule. No existing local service was intentionally contacted. This profile is appropriate only for the known synthetic code, not arbitrary or hostile workloads.

**Test-only source change:** in the disposable copy of `packages/core/src/services/run-live-owner.ts`, `ownerDirectory()` changed the POSIX branch from `` `/tmp/archon-${uid === undefined ? 'user' : String(uid)}` `` to ``join(tmpdir(), `archon-${uid === undefined ? 'user' : String(uid)}`)``. This relocated the owner socket and lock inside the root; the cached checkout and production source were not changed. Consequently this is not evidence for an unmodified CLI under this profile.

## Procedure and exact observations

Both workflows used this synthetic node:

```yaml
name: synthetic
description: offline cancellation probe
nodes:
  - id: work
    bash: |
      echo $$ > node.pid
      /bin/sleep 300 &
      echo $! > child.pid
      wait
```

A Python supervisor launched the CLI in a fresh session under the profile, waited at most 30 seconds for both PID files and the isolated SQLite run ID, checked `ps` PID/PPID/process-group/command fields, and launched a separate sandboxed cancel CLI with a 20-second bound. It tracked only the processes created by this probe. The supervisor's fallback killed the launcher group or uniquely root-identified detached owner group, and separately checked captured process identities before signalling any remaining tracked PID; it reaped its direct children. A PID/command check is not a kernel process handle, and the cleanup cannot prove absence of an escaped or renamed descendant. No detached descendant was deliberately created.

**Foreground refusal.** Run `535d4469-9482-496f-93e5-23ab7d80d649` had owner 16158, node 16201 and child 16202 in process group 16158. `workflow cancel <id> --json` exited 0 but returned `ok: false`, `action: "cancel"` and:

```text
Run 535d4469-9482-496f-93e5-23ab7d80d649 is executing in another live Archon process that cannot be stopped from here, because it is not a detached run (a foreground CLI run, or an Archon server). The run was not changed. Stop it from that process: interrupt the foreground command, or cancel the run on the server that executes it.
```

Ten seconds later all three remained visible and SQLite reported `running`. The supervisor then sent SIGKILL to its verified owned group 16158; both tracked node and child were absent in the subsequent `ps` checks. This forced cleanup is not successful Archon cancellation and its stale database row was not subsequently reconciled.

**Detached cancellation.** The second launch added `--detach --json`; it acknowledged run `99b22e238614970ffbf08430c0d06ad6` and exited 0. Before cancellation, `ps` showed:

```text
16293     1 16293 /Users/efishery/.bun/bin/bun /private/tmp/issue55cancel.9mKmFy/src/packages/cli/src/cli.ts workflow run synthetic --cwd /private/tmp/issue55cancel.9mKmFy/repo2 --no-worktree --cwd /private/tmp/issue55cancel.9mKmFy/repo2 --internal-detached-run-id 99b22e238614970ffbf08430c0d06ad6
16332 16293 16293 bash -c echo $$ > node.pid\012/bin/sleep 300 &\012echo $! > child.pid\012wait
16333 16332 16293 /bin/sleep 300
```

The separate cancellation command exited 0 with empty stderr and this stdout:

```json
{
  "ok": true,
  "runId": "99b22e238614970ffbf08430c0d06ad6",
  "action": "cancel",
  "status": "cancelled",
  "processStopped": true,
  "workflowName": "synthetic"
}
```

Immediately afterward `ps` returned no entry for PIDs 16293, 16332 or 16333; the supervisor's final checks also found none and sent no fallback signals for this run. A read-only SQLite query returned `('99b22e238614970ffbf08430c0d06ad6', 'cancelled')`. The JSONL transcript contained only `workflow_start` at `2026-10-28T04:58:20.436Z` and `node_start` at `04:58:21.028Z` when inspected afterward; no terminal transcript event was observed. This does not establish replay or stream behavior.

The root remains disposable on disk for inspection; no blanket filesystem or process cleanup was attempted. No push or tracker mutation was performed. The observations do not establish the behavior of independently session-detached children, all resource cleanup, identity/authorization, or production deployment.
