# Issue 56: pinned discovery-test diagnosis

## Result

**High confidence, experimentally validated for the five observed failures:** the tests search for the stale default workflow name `archon-review`. At pinned Archon revision `5c4f5e484262185926b37b070457fabb9bfedae0`, the relevant source declares `archon-review-block` in `.archon/workflows/sdlc/review/archon-review-block.yaml:1`. In a disposable copy, changing only the five failing name comparisons to `archon-review-block` changed the two-file run from 442 pass / 5 fail to 447 pass / 0 fail; restoring the test returned it to 442 / 5. This validates the immediate assertion mismatch, not the historical reason for the mismatch or the correctness of a product fix.

These tests do **not** prove issue 56's parent orchestration, supported CLI dispatch, independent evidence, or merge safety. This result narrows the test failure; it does not resolve the design questions in `git show 41f7551:docs/research/spec-workflow-entrypoints.md`.

## Reproduction and safety

- Factory checkout: `5fa30a37748d0acde86a6fc6c0fc3ba49d5e8105`; Archon pinned checkout: `5c4f5e484262185926b37b070457fabb9bfedae0`. Bun **1.4.0**, macOS `sandbox-exec`.
- Made a standalone `cp -cR` copy of the pinned checkout including installed dependencies, not a git worktree. Ran only in that copy with fresh `HOME`, `ARCHON_HOME`, and `TMPDIR`, and a restricted PATH. The original pinned checkout was not modified.
- Inspected the two test files: their direct filesystem fixtures use temporary directories; no direct `gh` execution, subprocess spawning, or `fetch` was found. A `gh` name in the loader tests is fixture YAML, not a forge command. Inspected `packages/workflows/src/defaults/factory-workflow-scripts.test.ts:29-64`: that separate suite compiles a fake gh and passes it via PATH, but some cases append the original PATH; it was **not run** here. As defense in depth, the selected tests ran under a sandbox denying network and execution of paths ending `/gh`; PATH also began with a fail-closed gh stub. No real gh calls, workflow runs, network access, or holdout content were used.
- From the copied source root, with `D` the disposable parent and `B` the absolute Bun executable:

```sh
env -i HOME="$D/home" TMPDIR="$D/tmp" PATH="$D/bin:/usr/bin:/bin" \
  ARCHON_HOME="$D/home/.archon" \
  /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*) (deny process-exec (regex #"/gh$"))' \
  "$B" test ./packages/workflows/src/loader.test.ts \
  ./packages/workflows/src/workflow-discovery-command-scan.test.ts
```

Sanitized original output, reproduced twice:

```text
error: expect(received).toBeDefined()
Received: undefined
(fail) Workflow Loader > multi-source loading > should load real app defaults when enabled
(fail) Workflow Loader > multi-source loading > should combine app defaults with repo workflows
(fail) Workflow Loader > discoverWorkflowsWithConfig > should default to loadDefaults: true when config load fails
(fail) Workflow Loader > binary build bundled workflows > should load bundled workflows when running as binary
(fail) Workflow Loader > binary build bundled workflows > should combine bundled workflows with repo workflows
442 pass
5 fail
Ran 447 tests across 2 files.
exit 1
```

The failures occur at `packages/workflows/src/loader.test.ts:1455,1511,1837,1907,1970`. Each searches for `archon-review`, then asserts the result is defined. The command-scan file passed. The binary tests simulate binary detection with a spy; they do not test a compiled CLI binary.

## Competing hypotheses and probes

1. **Stale name (supported).** If the expected name is absent but a current default is discovered, changing only those comparisons to the current name should turn the five tests green. The source declares `archon-review-block`; a temporary five-line comparison-only substitution yielded **447 pass, 0 fail, exit 0**. Reverting it yielded **442 pass, 5 fail, exit 1**. Both filesystem and simulated bundled branches discover that name in the respective tests.
2. **Rejected workflow (not supported for this failure).** If `archon-review` exists but is rejected during loading, its declared YAML should exist and a parse/discovery error should explain its omission. A scoped source search found no `name: archon-review` in `.archon/workflows` or `packages/workflows/src/defaults`; the relevant review YAML declares `archon-review-block`. The successful name-only probe does not rule out unrelated discovery errors, which were not exhaustively audited.
3. **Bad defaults roots or binary-mode configuration (not supported as the immediate cause).** If defaults were completely unavailable in either mode, changing only the requested name could not pass the affected assertions. The substitute passes in both branches; `workflow-discovery.ts:1058-1089` shows binary/live uses embedded content and the other branch uses the configured bundled filesystem root. This does not establish that all defaults are error-free or that actual compiled binary dispatch works.

The existing override tests also use `archon-review.yaml` as a supposed bundled collision (`loader.test.ts:1458-1481`, `1922-1947`). Since the pinned review source is named `archon-review-block.yaml`, those passing tests may not exercise the stated collision; this is a source-based observation, not an independently validated regression. Do not treat their pass as proof of override behavior for a real bundled review file.

## Limits and next step

No product or test fix was applied. The temporary name substitution is a diagnostic counterfactual, not a recommendation that changing assertions alone is sufficient: the intended default identity and the override tests' real collision need review. The separately reported 19 failing fake-gh script tests were not investigated; their root cause remains unknown. No fresh issue or tracker data was fetched because this investigation was explicitly offline.
