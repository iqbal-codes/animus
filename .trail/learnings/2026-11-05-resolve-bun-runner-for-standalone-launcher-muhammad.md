---
title: resolve-bun-runner-for-standalone-launcher-and-cli-serve
author: Muhammad
date: 2026-11-05
branch: main
id: l-61719e08
scope: repo
status: active
src: agent
touches:
  - apps/launcher/src/launcher.ts
  - scripts/cli/commands/serve.ts
  - scripts/cli/commands/engine.ts
---

## Decided
- Resolved Bun runner via resolveBunRunner() instead of process.execPath in FactoryLauncher, serve, and engine commands, and added backend health probing and child termination watchers so standalone binary animus serve coordinates live processes cleanly.
## Tried and ruled out
- Relying on process.execPath when running standalone binary animus resulted in spawning the animus CLI instead of Bun runtime interpreter to run TypeScript scripts, causing children to crash immediately.
## Watch out
- Always check that child processes are running Bun interpreter when spawning internal TypeScript scripts from a compiled Bun CLI binary.
