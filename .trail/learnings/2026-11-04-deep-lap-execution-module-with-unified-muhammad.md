---
title: Deep lap execution module with unified terminal disposition and bounded role runner
author: Muhammad
date: 2026-11-04
branch: t3/implement-ticket-145
id: l-0dc91e26
scope: repo
status: active
src: agent
touches:
  - scripts/loop/role-runner.ts
  - scripts/animus-loop.ts
  - scripts/loop/index.ts
  - scripts/loop/ci.ts
  - scripts/loop/qa-runner.ts
  - scripts/loop/pr-publication.ts
  - tests/integration/animus-loop-orchestrator.bun.test.ts
  - tests/integration/loop-lifecycle.bun.test.ts
  - tests/integration/loop-role-runner.bun.test.ts
  - tests/integration/loop-verification.bun.test.ts
---

## Decided
- Encapsulated lap lifecycle state inside an internal stateful LapSession behind runAnimusLoop and runLocalLoop. Unified all four terminal exit paths (QA fast-fail, PR CI fast-fail, review completion, and unhandled catch) into a single Terminal Disposition transition on LapSession that handles maxLaps escalation to needs_owner, human label escalation, Issue Dossier recording, conditional terminal reflection, PR evidence updates, and atomic state.json persistence. Unified bounded role execution into a single runner in role-runner.ts used identically across builder, QA, reviewer, and reflector with soft/hard deadlines, checkpoint.md appending, continuation loops, and JSONL message_end report extraction without positional argv array mutation. Removed 32+ internal stage-bag helpers from public orchestrator and barrels, deleting lifecycle.ts and review-gate.ts and migrating integration tests to assert on public runAnimusLoop behaviors.
## Tried and ruled out
- Shallow stage-split modules passing 16-to-29-field option bags across stage transitions; in-place mutation of caller argv arrays (e.g. argv[argv.length - 1] += ... in reflector transport) which corrupted non-prompt trailing arguments; direct unit testing of private stage helpers instead of asserting observable behavioral outcomes through the public runAnimusLoop seam.
## Watch out
- Ensure atomic persistence uses temporary file rename onto state.json. Ensure post-acquisition initialization errors in LapSession.init always release the issue lock in catch before re-throwing so the issue lock is never stranded. In LapSession.evaluateReview, ensure reviewReport and qaReport passed fields and outcome/delivers values conform to report-schema.
