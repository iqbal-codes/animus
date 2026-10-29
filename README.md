<img src="assets/icon.svg" width="64" height="64" alt="">

# labq-software-factory

Autonomous software factory with unified launcher, local-first React web console,
durable persistence, and private engine-host coordination on Bun/Vite+.

- Start operations: `bun apps/launcher/src/main.ts --port 3000`; see [runtime contract](docs/runtime.md).
- Configure and enroll repositories: [onboarding guide](docs/onboarding.md). The backend automatically monitors eligible registered projects while running.
- New health journey: [exact toolchain, independent starts and verification](docs/monorepo-health.md).
  Use Bun **1.4.2**, Node **26.8.1**, `bun install --frozen-lockfile`, then
  `bun run toolchain`. Vite+ **1.4.0** is project-local and Node-backed.
- The web console provides the unified operator dashboard, multi-repo project registry,
  and spec coordination interface on `127.0.0.1:3000`.

## Run an issue through the local loop

```sh
bun run loop --issue 72 --dry-run # Read-only issue/dependency/claim/brake preflight
bun run loop --issue 72           # Execute local builder, ordinary checks, QA and review
```

Requires Git, authenticated `gh`, installed/configured `pi`, and the project's
ordinary check dependencies. No Archon installation, dashboard, or HTTP service is
required. Pi uses its configured default model; `FACTORY_LOOP_MODEL` optionally
overrides it with a Pi model identifier. No fallback model is invented.

Preflight fetches the complete issue body and paginated comments, checks readiness,
textual and native blocking dependencies, and conservatively refuses any loop claim.
Unverifiable dependencies and GitHub errors block execution. STOP/PAUSE brakes in
this checkout, the primary worktree, or Git common directory are honored between
stages. Existing delivery PRs are not automatically adopted by this local engine.

Each run starts from this checkout's committed HEAD in a new Git worktree/branch.
Uncommitted changes in the invoking checkout are not copied. An exclusive issue
lock, run state, Pi JSON events, subprocess check output, and findings live under
`<git-common-dir>/factory-local-loop/`. Builder, QA, and reviewer have fresh Pi
sessions with extensions and MCP disabled. Ordinary static/unit commands come from
`harness/harness.config.json` and run as real processes against the exact committed
candidate. QA/review verdicts must explicitly identify that candidate and provide
checks and findings. Failed checks or findings return to the builder, with at most
two repair rounds. Missing/malformed evidence fails closed.

Success means **waiting_approval**, never merged, pushed, or issue-closed. Failure
preserves the worktree and evidence. Both outcomes retain the issue lock; inspect
`locks/issue-<number>/owner.json` and its run's `state.json` before manually releasing
ownership. A crashed run is not silently stolen. Approval, publication and cleanup
are explicit human operations, not part of this command.

**Security boundary:** this is trusted-code execution, not a sandbox. Protected-path
changes are rejected before approval. Holdouts are omitted using sparse checkout
and are not included in prompts or feedback. However, Git history, other worktrees,
host filesystem and credentials remain reachable to subprocesses; prompts and
post-run checks cannot enforce secrecy or prevent a hostile tool from performing
remote writes. Use an appropriately isolated host for untrusted code. Ordinary
checks are not secret holdout verification, and model verdicts are not human approval.
Brakes are stage-boundary checks, not an immediate kill switch for in-flight processes.

Created in [T3 Code](https://t3.codes).
