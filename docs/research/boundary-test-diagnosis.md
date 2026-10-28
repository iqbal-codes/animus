# Issue 56: pinned workflow boundary test diagnosis

## Result

The reported **15 pass / 19 fail** reproduces offline in a disposable copy of Archon `5c4f5e484262185926b37b070457fabb9bfedae0`. High confidence: the common immediate cause is that Bun's compiled fake `gh` is killed on this macOS host before it can respond. The full suite passes when only the fake's launch mechanism is changed in the disposable copy. A separate minimal compiled executable has an invalid code signature, is killed, and runs after ad-hoc re-signing. This validates the signature explanation for that minimal executable, not yet for the exact suite-generated fake: the suite deletes it during cleanup. The reason Bun produced an invalid signature is not established, nor is this a finding about other environments or live GitHub behavior.

## Scope and safety

Prior context: `git show 41f7551:docs/research/spec-workflow-entrypoints.md`. Source: pinned cache `/Users/efishery/.cache/factory/archon/5c4f5e484262185926b37b070457fabb9bfedae0`, revision verified with `git rev-parse HEAD`. No tracker reads or writes, network access, real `gh` calls, workflow runs, or holdout content. The initial broad home-directory search ran longer than intended and completed; subsequent operations used targeted paths.

Inspected `packages/workflows/src/defaults/factory-workflow-scripts.test.ts:21-95`: it compiles a fake `gh` that answers local fixtures, logs arguments, and fails unmatched fixture calls. Scripts invoke `gh` by name; some tests append the inherited PATH. To fail closed even if fake resolution fails, the test's inherited PATH contained a separate blocking `gh` script and system directories without the actual gh; macOS `sandbox-exec` denied network, and `UV_OFFLINE=1` prevented uv downloads. The test's runtime handoff cases execute local scripts, not workflows. The entire pinned checkout including dependencies was copied using `cp -cR` to a disposable non-worktree directory; no shared pinned checkout writes were made.

Environment: `bun --version`: `1.4.0`; `bun --revision`: `1.4.0+34cbb9a40`; `uv --version`: `uv 0.11.7 (9d177269e 2026-04-15 aarch64-apple-darwin)`; `uname -sm`: `Darwin arm64`.

## Reproduction

In the copied checkout, with `D` the disposable directory, `D/bin` containing symlinks to Bun and uv and a blocking gh, and `D/offline.sb` containing `(version 1)`, `(allow default)`, `(deny network*)`:

```sh
PATH="$D/bin:/usr/bin:/bin:/usr/sbin:/sbin" UV_OFFLINE=1 \
  /usr/bin/sandbox-exec -f "$D/offline.sb" "$D/bin/bun" test \
  packages/workflows/src/defaults/factory-workflow-scripts.test.ts
```

Exit 1, **15 pass, 19 fail, 121 expect calls, 34 tests**, 4.00 seconds. Failure distribution: 4 merge-action, 9 required-check policy, 6 protected-path policy. Representative sanitized output:

```text
summary: "gh pr merge failed"
reason: "could not read pull request https://github.test/owner/repo/pull/17"
```

The synthetic domain is fixture data, not a live request. This matches the prior note's aggregate and representative symptoms; the prior note does not enumerate all failure names, so exact per-case identity with that earlier run cannot be verified. One unmodified full run was made, so repeated-run determinism is not established.

## Competing hypotheses and probes

1. **Fake executable cannot start:** a minimal Bun-compiled local fake should die before printing; replacing only fake launch with the same source interpreted by Bun should turn the suite green.
2. **Fixture matching or fixture contents are wrong:** the fake should start but fail or return an unexpected response for specific calls; changing only executable launch should not make all cases pass.
3. **Policy scripts mishandle valid responses:** fixture responses should reach the scripts and failures should remain after changing only fake launch.
4. **Wrong executable resolved from PATH:** a successful fake launch should not restore the suite if resolution continues to select the blocker or another executable.

Probe 1: compiled a minimal fake with the same `bun build ... --compile --outfile` mechanism. Direct execution outside the network sandbox returned `Killed: 9`, exit 137. Bun `spawnSync` reported `exit: null`, `signal: SIGKILL`, empty stdout and stderr. `codesign --verify --verbose=2` reported `invalid signature (code or signature have been modified)`. After changing only the minimal executable's signature with `codesign --force --sign -`, verification reported `valid on disk`, and it printed its arguments and exited 0 under the network-denying sandbox. This isolates the code signature as causal for that executable; it does not establish why the signature was invalid.

Probe 2: in the disposable copy only, after the test compiled its fake, replaced the resulting executable with a shell wrapper invoking the same generated fake TypeScript source using the same Bun. No fixture, script, test assertion, or policy logic changed. Same sandbox, PATH and suite: **34 pass, 0 fail, 227 expect calls**, 7.70 seconds. This strongly supports hypothesis 1 as the shared immediate failure and argues against hypotheses 2–4 as explanations for these failures in this run. It does not prove the scripts correct against real GitHub, nor does it prove the exact fake's signature directly. No product fix is implied by this diagnostic wrapper.

## Remaining validation

Capture and inspect the exact suite-generated binary before cleanup, then compare its signature and repeat the original suite with only that binary re-signed; use an isolated copy and the same no-network / blocked-gh controls. Investigate whether the invalid signature is specific to this Bun build, host policy, or compilation environment. The separate 5 loader/discovery failures in the prior note were not investigated. This diagnosis does not establish the parent-scoped orchestration or merge guarantees sought by issue 56.
