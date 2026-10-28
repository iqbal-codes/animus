# Issue 55: synthetic cancellation safety gate

## Disposition: blocked before workflow execution

No Archon workflow or cancellation was executed. The requested isolation was not established, so there is no new behavioral evidence about cancellation, process termination or cleanup. This is not evidence that cancellation fails or succeeds.

The user authorized synthetic workflows only in a disposable local environment, with OS-level network and real `gh` denial, dummy commands, no external model, and no backlog or holdout access. The conclusion at `88d42e7:docs/research/issue-55-conclusion.md` and earlier notes at `f0ff8fee:docs/research/archon-live-controls.md` and `d239fa4:docs/research/archon-replay-deep-dive.md` were read from local Git objects. The actual issue was not independently read: network and real `gh` were prohibited. The earlier notes report that its body and comments were read previously; that is not a fresh issue read.

## Local safety check

- Host is macOS; `/usr/bin/sandbox-exec` is available. The locally cached Archon source reports the pinned revision `5c4f5e484262185926b37b070457fabb9bfedae0` via `git rev-parse HEAD`.
- A bounded, non-workflow `sandbox-exec` probe used `(allow default) (deny network*) (deny process-exec (literal "/opt/homebrew/bin/gh"))`. A Python TCP connection to `127.0.0.1:9` returned `PermissionError: Operation not permitted`, but executing `/opt/homebrew/bin/gh --version` returned exit 0. Thus this profile did **not** establish the required real-`gh` execution denial. The sole `gh` invocation was a local version check; no tracker or network operation was attempted.
- Under the same profile, binding a Unix-domain socket returned `PermissionError: Operation not permitted`. The pinned `packages/core/src/services/run-live-owner.ts:148-171,178-195,297` uses a Unix socket for the live-owner endpoint on POSIX. Therefore this broad network denial also prevents exercising the detached-owner IPC path. This check does not establish whether a narrower profile could safely allow only the intended local IPC while denying external networking.
- No Archon home, source copy, synthetic repository, synthetic process tree, workflow, or cleanup experiment was created. No production, backlog, holdout or tracker changes were made. The checks did not send termination signals.

## Source-only cancellation boundary

At the pinned source, `packages/core/src/services/run-owner-stop.ts:38-66` requests an exact-run owner lease and commits it before termination. Lines 99–141 send `SIGTERM` to the owner's process group, wait, then send `SIGKILL` and wait again if needed; they refuse an invalid PID, the caller's own PID, or a lost lease. This is source inspection, not observed propagation. The group-based mechanism does not by itself prove that descendants which leave the group, containers, or resource cleanup are stopped. The earlier conclusion records further refusal, race and partial-cleanup gaps; none were retested here.

## Prerequisite for a useful probe

Before executing, establish and independently verify an OS-enforced sandbox that denies external network and every real `gh` executable while allowing only the isolated Unix-domain owner IPC required by Archon. Verify isolated source, home, repository, environment, dummy command resolution, and a dedicated owned process group; impose an outer timeout and cleanup restricted to verified probe-owned processes. Then separately observe cancellation response, owner and child exit, database state and cleanup results, including refusal and failure paths. If those boundaries cannot be verified, retain the blocked disposition rather than infer results from a mocked or unsafe run.
