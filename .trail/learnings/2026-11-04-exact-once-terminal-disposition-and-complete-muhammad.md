---
title: Exact-once terminal disposition and complete test runner discovery
author: Muhammad
date: 2026-11-04
branch: factory/spec-140-integration
id: l-04a61f05
scope: repo
status: active
src: agent
touches:
  - scripts/loop/session.ts
  - vite.config.ts
  - tests/integration/animus-loop-orchestrator.bun.test.ts
---

## Decided
- Enforce exact-once terminal disposition via internal terminalDisposed guard in LapSession and ensure all 35 Bun integration suites remain discovered and executed in vite.config.ts bun-suite without test runner omission.
## Tried and ruled out
- Hardcoded partial bun test lists in vite.config.ts that omit newly created bun test suites; passing glob patterns to bun test without shell expansion.
## Watch out
- Always verify that bun-suite in vite.config.ts matches all *.bun.test.ts files so newly added suites are not silently dropped by the configured test runner.
