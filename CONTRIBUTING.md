# Contributing to animus

Thank you for contributing to `animus`! This repository operates an autonomous, self-improving, contract-driven software factory. We welcome issues, bug reports, and pull requests that adhere to the standards outlined below.

## Qualified Toolchain

This repository enforces pinned runtime and toolchain versions:

- **Node.js**: `26.8.1` (used for repository tooling and static qualification)
- **Bun**: `1.4.2` (used for package execution, application runtimes, and fast tests)
- **Vite+**: `1.4.0` (used for workspace task orchestration)

Verify your local environment with:

```sh
bun install --frozen-lockfile
bun run toolchain
```

Do not upgrade pinned toolchain versions without prior maintainer approval.

## Repository Onboarding & Setup

To configure a repository for the factory without network enrollment:

```sh
animus setup --local-only
```

For interactive setup and enrollment into a running factory instance:

```sh
animus setup
```

Consult `docs/onboarding.md` for full details on multi-harness selection, tier configuration, and repository monitoring registration.

## Local Validation Commands

Before pushing a branch or opening a pull request, run the local check suite:

- `bun run check` — runs architecture boundary validation, code formatting, linting, and typechecking.
- `bun run test` — executes the integration and unit test suites across all packages and apps.
- `bun run verify` — executes repository-wide verification through `vp run verify-all`.
- `bun harness/ci.ts` — runs the repository's ordinary CI harness checks locally.

All checks must pass cleanly with zero errors and zero warnings.

## Architecture Boundaries & Layering

The repository is structured as a Bun workspace with strict unidirectional layering rules:

| Package / App | Purpose | Layering Invariants |
| --- | --- | --- |
| `packages/contracts` (`@animus/contracts`) | Pure schemas and domain types | Declares zero dependencies on `@animus/client`, `@animus/backend`, `@animus/engine-host`, or `@animus/launcher`. |
| `packages/client` (`@animus/client`) | Operator Fetch client and API helpers | Depends only on `@animus/contracts`. Declares zero dependencies on `@animus/backend`, `@animus/engine-host`, or `@animus/launcher`. Imports zero Node/Bun built-ins (`node:*`). |
| `apps/backend` (`@animus/backend`) | Control plane, project monitor, and API server | May depend on `@animus/contracts` and `@animus/client`. Never depends on or imports from `apps/engine-host`. |
| `apps/engine-host` (`@animus/engine-host`) | Authenticated private execution worker | May depend on `@animus/contracts`. Never depends on or imports from `apps/backend`. |
| `apps/launcher` (`@animus/launcher`) | Multi-process supervisor | Spawns backend and engine-host as isolated child processes; declares zero library dependencies on their internals. |

These boundaries are checked statically across source imports and declared in `package.json` dependencies via `scripts/health/check-architecture.mjs`.

## Offline Invariant for Tests

All unit and integration tests must run fully offline. Tests must never make live external network calls to GitHub, external package registries, or AI APIs. Use in-memory mocks, offline forge transports, or temporary filesystem fixtures.

## Pull Request Hygiene

1. **Contract-Driven**: Every pull request must address a specific work item or contract.
2. **Template Compliance**: Use `.github/pull_request_template.md`. Complete all sections:
   - Problem and Outcome
   - Invariants
   - Review Guidance (`Start here`)
   - Changed Seams
   - Evidence (concrete verification logs, command output, or test assertions)
3. **Conventional Commits**: Format commit messages using conventional commits (e.g. `feat(...)`, `fix(...)`, `docs(...)`).
4. **No Protected File Edits**: Never modify protected factory paths (`MISSION.md`, `FACTORY.md`, `FACTORY_RULES.md`, `harness/**`, `.claude/settings.json`, `.ignore`, `.factory/holdout/**`, `.factory/hooks/**`) without human owner authorization.
