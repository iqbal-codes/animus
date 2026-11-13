---
title: Trail wiring keeps only the five agents the team uses
author: Muhammad
date: 2026-11-13
branch: feat/add-repository-and-tier-settings
id: l-5aff674c
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
---

## Decided
`trail init` scaffolding is kept only for omp, pi, codex, claude and antigravity.
Every other host wiring it generates was removed so the repo does not carry MCP
registrations and rule mirrors for tools nobody here runs.

- omp, pi, codex and antigravity all read the single `AGENTS.md` fence, so one
  file serves four of the five.
- claude keeps its repo hook (`.claude/settings.json` + `.trail/hook.cjs`) and
  the git-ignored `statusline.cjs`.
- antigravity's MCP registration lives only outside the repo, in
  `~/.gemini/config/mcp_config.json`, with the skill in `~/.gemini/skills/trail/`.

In the code: repo-level survivors are `AGENTS.md`, `.claude/settings.json`,
`.trail/hook.cjs`; removed were `.adal/`, `.gemini/`, `.grok/`, `.kiro/`,
`.windsurf/`, `GEMINI.md`, `.github/copilot-instructions.md`, `opencode.json`.

## Tried and ruled out
Keeping the full `--all-agents` output. Ten extra tracked files (cursor, gemini,
grok, kiro, windsurf, adal, copilot, opencode) for agents not installed or not
used — pure noise in diffs and in every agent's context window.

## Watch out
Re-running `trail init` re-adds what was deleted. The `agents` host id always
writes `opencode.json` alongside `AGENTS.md`, and there is no flag to split them,
so drop that file again after any re-init. Use
`trail init --agents agents claude antigravity` rather than `--all-agents` or a
bare `trail init` (whose auto detection always picks OpenCode).
