# Issue 57: target binding and evidence provenance deep dive

## Scope and conclusion

Research only, continuing `cee4f9e0b5b0142373587b8fd989b1f3499535a3:docs/research/eligibility-evidence.md`. Factory source HEAD inspected: `5fa30a37748d0acde86a6fc6c0fc3ba49d5e8105`. `factory/pack.json:2-5` pins Archon `5c4f5e484262185926b37b070457fabb9bfedae0`; its local cache checkout was clean at that revision. `A:` below means that checkout. `.factory/consumer.json` mentioned by `docs/agents/software-factory-workflow.md:13` is absent at this revision; the pack and existing host code identify the pin instead. Issue 57 was read with `gh issue view 57 --json title,body,comments,state,url`: open; the owner comment explicitly says the earlier research is not a resolution. No issue or workflow was changed, no live workflow was run, and no holdout content was inspected.

**Decision:** no supported, deterministic target-binding interface for the existing pinned loop is established. The supported input and event interfaces narrow the implementation search, but are not themselves admission or independent-approval guarantees. Existing deterministic merge checks provide a useful separate control, not a safe launch gate. Research cannot honestly close issue 57 while the execution seam, authority and provenance questions below remain unresolved. Corrective code and any engine/workflow change require separate authorization.

## Supported interfaces versus the actual launch [observed]

- Top-level `--input name=value`, invocation `inputs`, and include/child `with` share declared-input validation; undeclared keys are rejected (`A:packages/workflows/src/workflow-inputs.ts:1-22, 64-96`). The loop declares runtime, holdout, protected paths, merge, retry/deploy and claim configuration, **not target**; `pick` independently emits `route`, `target`, and `pr`, which `claim` consumes (`A:.archon/workflows/sdlc/loop/archon-loop.yaml:18-103`). An offline probe below confirmed rejection of `target` against the actual pinned YAML. An issue URL in a message or a declared unrelated input is not a binding contract.
- Factory invokes `workflow run ... --workflow-source <pinned cache> archon-loop --detach --branch ... --input merge=approve ... -- <specification>` (`apps/engine-host/src/native.ts:246-310`). `--workflow-source` is an upstream supported source-selection interface, not a target selector (`A:CHANGELOG.md:266`; `A:packages/cli/src/help.ts:141-151`). Supplying a different source could implement a different graph, but does not establish that doing so is authorized, protected from bypass, or compatible with the independent evaluator. No modified workflow was tested.
- `factory/pack.json:31-33` names `loop/scripts/workable.ts` as a launch gate. That script expressly says it is **not a node**, reads at most 200 open issues and 100 open PRs, and may PATCH ended claims (`A:.archon/workflows/sdlc/loop/scripts/workable.ts:1-13, 53-87`). It returns a board-level set, not a selected target. The host launch path above does not invoke it. Even a scheduler that invokes it cannot infer that the model picker will select an admitted member; the picker may perform bookkeeping before claim (`A:.archon/workflows/sdlc/loop/commands/loop-pick.md:7-13, 43-45, 69-75`). A post-pick veto cannot undo those effects. Direct manual runs and native scheduler invocations must be included in any enforcement design.
- `claim.held` gates build/ship, but the claim is for the picker output, not a previously admitted identity; its existence is not a canonical readiness or dependency check (`A:.archon/workflows/sdlc/loop/archon-loop.yaml:90-141`). A race between authoritative admission, claim and execution remains. Linked-PR continuation, repository identity, native and textual dependency disagreement, planning-only records and unavailable prerequisite state all need policy and coverage. The earlier note documents the synthetic held-issue counterexample and Factory's bounded cached intake.

## Upstream evidence, current head and reviewer records [observed]

- Supported `workflow get <run-id> --json --verbose --events` reads a specific run and raw event rows: `workflowGetCommand` returns `not_found` if the run is absent and `workflow_events_unavailable` if event retrieval fails; its verbose/raw JSON branch includes `events` (`A:packages/cli/src/commands/workflow.ts:4892-4988`; CLI dispatch `A:packages/cli/src/cli.ts:879-907`). Raw output can contain sensitive data; it is not an appropriate public projection without an allowlist. Retrieval success does not by itself establish complete or trustworthy provenance.
- Durable node serialization can carry structured output and a full provider `session_id` (`A:packages/workflows/src/node-record-serialization.ts:62-87, 142-159, 325`); the upstream synthetic round-trip test verifies full session ID for finished attempts, distinct from the short preview (`A:packages/workflows/src/node-record-serialization.test.ts:265-294`). Execution records also contain run/path, invocation and attempt identifiers in that test's fixture (`:12-38`). These are candidate attribution inputs, not proof that every provider reports a session, that sessions establish human or organizational independence, or that two identifiers refer to independent reviewers. Retries, resumed nodes, child runs, truncation and ambiguous records need explicit handling.
- The graph passes subject PR/head/base to a fresh-context `check-app`, then its structured report and subject start to deterministic `evidence`, then review receives the app-check/evidence handoff (`A:.archon/workflows/sdlc/loop/archon-loop.yaml:149-249, 267-309`). Review records `outcome`, `pr`, `sha`, dispositions and judge changes, but its schema has no independent-reviewer identity field. `context: fresh` is an execution configuration, not alone a verified independent principal. `evidence.ok` validates evidence/report conditions; it is not identical to a current-head approval.
- On auto-merge, `land` reads live PR state and `headRefOid`, refuses a changed head, checks tested trees/current base, and ultimately invokes `gh pr merge --match-head-commit`; it can create a clean base merge in a specific non-overlap case (`A:.archon/workflows/sdlc/loop/scripts/land.ts:49-58, 92-149, 166-174`). This is a deterministic, head-pinned **merge** gate, not launch admission. Importantly, an already-merged PR follows a separate branch emitting `merged` even when its own checks have refusals (`:155-165`); that outcome alone is not proof that this gate approved the merge. Factory sets `merge=approve`, so this auto-land path is not reached for that launch configuration (`A:.archon/workflows/sdlc/loop/archon-loop.yaml:313-328`; `apps/engine-host/src/native.ts:304`). Live PR head comparison remains necessary for an approval projection, including the interval after a read.
- Factory currently lists only 100 runs and maps `checkout_baseline.commit` to `candidate_head`, rather than reading the subject/check/review candidate (`apps/engine-host/src/native.ts:133-159`). It then fabricates PASS, approved, independent and a fixed session regardless of events (`:195-229`). An inaccessible store is converted to `lap_not_found` in detail (`:171-187`). The pinned `get` interface offers a possible direct lookup and distinguishes unavailable events, but Factory does not use it here. The Markdown report proxy still unconditionally parses JSON (`apps/backend/src/main.ts:29-61, 173-178`); report lookup itself is speculative paths (`apps/engine-host/src/native.ts:232-243`), not established as upstream artifact provenance.

## Safe offline checks [observed]

The following commands were run in the clean pinned cache checkout; Bun `1.4.0`, local installed dependencies. They use only synthetic test data or parse the workflow definition, not holdout scenario contents; no network or live workflow invocation. `E` is the checkout resolved from `factory/pack.json` and the host's cache convention.

```sh
E="$HOME/.cache/factory/archon/$(node -p 'require("./factory/pack.json").integration_revision_required')"
git -C "$E" rev-parse HEAD
git -C "$E" status --short
(cd "$E" && env -u OPENROUTER_API_KEY bun test \
  packages/workflows/src/node-record-serialization.test.ts \
  packages/workflows/src/workflow-inputs.test.ts)
(cd "$E" && bun -e '
import {resolveDeclaredInputs} from "./packages/workflows/src/workflow-inputs.ts";
const w=Bun.YAML.parse(await Bun.file(".archon/workflows/sdlc/loop/archon-loop.yaml").text());
try {
  resolveDeclaredInputs({target:"https://example.invalid/issues/57"},w.inputs,"probe","archon-loop");
  throw Error("unexpected acceptance");
} catch(e) {
  if(!e.undeclared?.includes("target")) throw e;
  console.log("target rejected:",e.undeclared.join(","));
}')
```

Results: exact pinned SHA, clean status; 28 tests passed, zero failed; probe printed `target rejected: target`. These tests prove input validation and serialization behavior at the exercised seams, not a real CLI invocation, real event store, independent reviewer, forge state, scheduling, report proxy, or end-to-end enforcement. The test suite did not connect to a live service; no network transport was configured for these unit tests. Earlier workability probe results are in the prior committed note and were not rerun here.

## Unverified and decisions required

1. [INFERENCE] A production design needs an authorized, deterministic binding before **any** selection-side write, fresh repository-scoped admission and claim/revalidation at the actual work boundary, plus control of direct/scheduled bypasses. The existing graph does not expose that seam. Whether an upstream change or a separately authorized workflow revision is acceptable remains an owner decision; do not weaken or alter the evaluator to solve it.
2. Define an authoritative mapping from run, invocation/attempt, `subject`, `check-app`, `evidence`, and `review` to one PR/head and fresh forge identity. Establish exact raw-event completeness, ordering, retry/cache semantics, output spill behavior, and reviewer principal/session guarantees with synthetic store fixtures. If absent, ambiguous, stale, inaccessible or contradictory, hold rather than emit PASS. Session inequality alone is not independence.
3. Resolve configured product repository, native/text dependency conflict, linked PR policy, claim races, and private evidence/report disclosure. Exercise host→backend→client with injected transports and synthetic Markdown/errors; this investigation did not perform that integration test.
4. The graph's evidence and land gates should be preserved as independent controls, not reimplemented from partial summaries. A current reviewed SHA and a successful gate do not establish an enduring approval after the PR changes.
