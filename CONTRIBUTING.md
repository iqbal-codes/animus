# Contributing to LabQ Software Factory

Thank you for contributing to `labq-software-factory`. We welcome issues, pull requests, and discussions from the community.

## Pinned Toolchain

The repository enforces pinned toolchain versions across all developer workstations and CI runners:

- **Node.js**: `26.8.1`
- **Bun**: `1.4.2`
- **Vite+**: `1.4.0` (frozen local dependency)

Before running checks or starting services, ensure that Bun `1.4.2` and Node `26.8.1` are available on your `PATH`. Verify your environment with:

```sh
node scripts/health/check-toolchain.mjs
```

Install dependencies with frozen lockfile validation:

```sh
bun install --frozen-lockfile
```

## Repository Onboarding & Setup

To configure the repository locally without enrolling in a remote factory server, use:

```sh
labq-factory setup --local-only
```

This interactive setup command inspects available local harnesses, sets model tiers, and writes configuration files (`AGENTS.md`, harness configs) to the working tree.

For enrollment into an active factory control plane:

```sh
labq-factory setup
```

## Local Check Commands

Validate all changes locally before submitting a pull request. Every check runs completely offline:

- **Architecture, Formatting, Linting, & Typechecking**:
  ```sh
  bun run check
  ```
  Runs `node scripts/health/check-architecture.mjs`, `bun run format`, `bun run lint`, and `bun run typecheck`.

- **Unit & Integration Test Suites**:
  ```sh
  bun run test
  ```
  Executes the Vitest test suites across the monorepo and Bun native integration suites (`vp run test-all`).

- **Full Verification**:
  ```sh
  bun run verify
  ```
  Runs the end-to-end verification gate (`vp run verify-all`).

## Architecture Boundaries

The repository enforces strict layering boundaries across packages and applications:

```
@labq/contracts  (pure schemas, DTOs, zero internal/external runtime deps)
       │
       ▼
  @labq/client    (operator Fetch client, imports @labq/contracts only)
       │
       ▼
    apps/*        (@labq/backend, @labq/engine-host, @labq/launcher)
```

### Boundary Invariants

1. **`packages/contracts`**: Pure schemas and types. Declares zero dependencies on `@labq/client`, `@labq/backend`, `@labq/engine-host`, or `@labq/launcher`.
2. **`packages/client`**: Client SDK for operator and external consumers. Declares zero dependencies on `@labq/backend`, `@labq/engine-host`, or `@labq/launcher`, and imports no Node/Bun built-in modules (`node:*`, `bun:*`).
3. **`apps/backend` and `apps/engine-host`**: Two-process isolation. They never import each other's source files or declare each other in `package.json` dependencies.
4. **`apps/launcher`**: Coordinated process launcher. Orchestrates backend and engine-host via subprocess supervision, declaring no workspace dependency on either server app.

Validate package edges and source imports at any time:

```sh
node scripts/health/check-architecture.mjs
```

## Pull Request Guidelines

1. **Contract-Driven**: Every pull request must address a single scoped work item.
2. **Evidence**: Include verifiable command output or log paths in the `## Evidence` section of `.github/pull_request_template.md`.
3. **Offline Invariant**: Tests must not require external network connections.
4. **Protected Paths**: Protected factory paths (`MISSION.md`, `FACTORY.md`, `FACTORY_RULES.md`, `harness/**`, `.claude/settings.json`, `.ignore`) cannot be modified without maintainer authorization.
