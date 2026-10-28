# Issue 55: offline synthetic workflow and isolation probe

## Result

A one-node synthetic Archon workflow completed offline and produced a local JSONL transcript containing start, execution output and completion records. This is **not** a cancellation, server, SSE, provider-event, REST replay or reconnect test. It does not resolve issue 55 or establish behavior in a deployed topology. The run used the pinned source with one explicitly described test-only change to its owner socket directory, so it is not an unmodified-binary result.

Read the prior blocked notes at `5724df5:docs/research/issue-55-synthetic-runtime-blocked.md` and `41b0c1a:docs/research/issue-55-cancellation-safety.md`, and the conclusion at `88d42e7:docs/research/issue-55-conclusion.md`. No issue tracker or network was consulted. The local cached upstream checkout reports revision `5c4f5e484262185926b37b070457fabb9bfedae0`, matching the recorded pin; its working-tree integrity was not independently verified.

## Isolation constructed and checked

On macOS, create a unique `mktemp` root and use its **canonical** `/private/tmp/...` path in the profile. This experiment used `/private/tmp/issue55.4BIDdV`. Copy the source and existing local dependencies into `src` (including each workspace's `node_modules` symlinks), excluding the source `.git` and `.archon`; initialize an unrelated empty synthetic Git repository. Set an empty-environment allowlist: `HOME=$root/home`, `ARCHON_HOME=$root/archon`, `TMPDIR=$root/tmp`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `ARCHON_TELEMETRY_DISABLED=1`. No production config or credentials are supplied. The generated Archon configuration and database stayed under the disposable Archon home.

The effective `sandbox-exec` profile was:

```scheme
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/private/tmp/issue55.4BIDdV"))
(allow file-write* (literal "/dev/null"))
(deny file-read* (subpath "<factory-checkout>/.factory/holdout"))
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network* (local unix-socket))
(allow network-outbound (remote unix-socket))
(deny process-exec (literal "/opt/homebrew/Cellar/gh/2.99.0/bin/gh"))
```

Replace the literal root and checkout with their canonical paths, and resolve the actual `gh` executable before every run. This profile is for known synthetic code, not a hostile-code security boundary: reads outside the root are generally allowed except the named holdout, Unix sockets and loopback services are not namespace-isolated, and path-specific `gh` denial does not stop a copied executable. Do not point the workflow at real material or run arbitrary code. Existing local services must not be contacted; the synthetic workflow used only `echo`, not networking. For a stronger general-purpose sandbox, use an isolated VM/network namespace and a read allowlist.

The distinction between `network-bind`/`network-inbound` and `network*` matters: an earlier candidate `(allow network* (local ip "localhost:*"))` allowed an external connection to `1.1.1.1:443`; it was rejected and not used for the workflow. The corrected profile gave the following direct tests:

- IPv4 loopback bind, listen, connect and byte exchange succeeded; IPv6 `::1` and a Unix socket also exchanged bytes. TCP connections to `1.1.1.1:443` and `2606:4700:4700::1111:443` failed with `EPERM`. A child Python process attempting the IPv4 external connection also exited nonzero. These are sampled controls, not a proof of all protocols or routes.
- Both `/opt/homebrew/bin/gh` and its resolved `/opt/homebrew/Cellar/gh/2.99.0/bin/gh` failed to execute with `EPERM`; neither ran a command. This is not a claim about copies or other installations.
- Creating a file in the real home failed with `EPERM`, and listing the checkout's named holdout directory failed with `EPERM`; no holdout contents were read. Writes elsewhere outside the root are denied by the same broad rule, apart from `/dev/null` and OS semantics not individually tested.
- A first profile using the `/tmp` spelling failed to permit writes to the same physical directory; using the canonical `/private/tmp` spelling fixed it. `/dev/null` needed the explicit exception for Apple's Git. The initial source copy omitted package-local dependency links; copying those links from the local dependency installation fixed module resolution without network access.

The profile defaults to allowing process execution, while relying on the scoped write and network rules and the explicit real-`gh` deny. It is not an executable allowlist. No evaluator, real model, actual backlog, or live external service was invoked.

## Owner-path obstacle and test-only adjustment

Pinned `packages/core/src/services/run-live-owner.ts`, `ownerDirectory()`, hardcodes `/tmp/archon-<uid>` on POSIX, ignoring `TMPDIR`. An initial synthetic run stopped with `EPERM` opening its lock in that existing shared directory. Allowing write access there would weaken the production-write restriction. Instead, **only the disposable copy** was changed from the hardcoded `/tmp/archon-${...}` to `join(tmpdir(), \`archon-${...}\`)`. This confines its socket and lock to the disposable root, while retaining the owner protocol code. The original checkout was not modified. This means the observed result is evidence for the workflow engine with a relocated owner directory, not proof that the unmodified CLI works with this exact filesystem profile.

## Workflow and observations

The synthetic repository contained `.archon/workflows/synthetic.yaml`:

```yaml
name: synthetic
description: synthetic offline run
nodes:
  - id: work
    bash: "echo synthetic-ok"
```

Launched the copied CLI with `workflow run synthetic --cwd $root/repo --no-worktree --json` under the profile and a fresh process session. A Python supervisor used `communicate(timeout=30)` and would send `SIGKILL` to that owned process group on timeout, then reap the leader. The successful run returned exit 0 without timeout; CLI output showed `synthetic-ok` and `Workflow completed successfully`; stderr reported `Started` and `Completed (394ms)`. This is a single bash node, so no provider or dummy model was needed and no provider event was generated.

The isolated JSONL transcript for run `de8cf2f0-bcb0-4d24-bc93-38e84166a15e` contained, in file order, `workflow_start` at `04:54:38.807Z`, two step execution records surrounding `exec_output` (`stdout_tail: synthetic-ok`, `exit_code: 0`) at `04:54:39.206Z`, and `workflow_complete` at `04:54:39.208Z` on 2026-10-28. This demonstrates local transcript recording for one successful synchronous run only; it says nothing about streaming, replay completeness, concurrent ordering or provider transcripts.

Afterward, a `ps` search for the unique root showed no remaining matching worker process; this is a targeted observation, not a proof that an escaped or renamed descendant cannot exist. The group timeout was not exercised, and group-kill alone would not catch a child that creates a new session. For cancellation research, add an independently tracked child PID, explicit liveness checks, bounded cleanup of only probe-owned PIDs/groups, and a way to handle detached descendants before starting that experiment.

## Remaining evidence

Run a separately supervised synthetic owner and cancellation requester and measure acknowledgement, child/owner termination and durable state; test refusal and cleanup paths. Independently exercise a real local server, CLI writer, lifecycle stream, provider replay and reconnect using the same isolated database and a deliberately synthetic provider. A local-only profile must be reverified on the actual host and must not be treated as isolation from other local Unix or TCP services. Production identity, authorization, transcript projection and deployment cleanup remain unproved. No tracker changes or pushes were made.
