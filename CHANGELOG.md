# Changelog

All notable changes to `animus` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Machine-wide onboarding: `animus onboard` runs blocking prerequisite checks (Bun version, Git, `gh auth status`, writable `~/.animus`, resolvable runtime source tree, installed harness, free backend port), detects the local harness fleet, and writes `~/.animus/config.yaml` with an `onboardedAt` marker, owner-only permissions, and no fabricated provider rows.
- `animus onboard` also sets the machine automation policy (`--max-laps`, `--parallel`, `--interval`, `--work-window`, or interactive prompts) inside `~/.animus/config.yaml`; the schedule cascade and `animus setup` both inherit it.
- `animus start` and `animus stop` operate the backend, engine-host, and web console from an explicitly resolved runtime (`ANIMUS_SOURCE_ROOT`, invoking checkout, then `~/.animus/source`) instead of assuming the current directory is an Animus checkout.
- `packages/contracts/src/machine-config.ts` owns the machine configuration schema, read/write helpers, and the fail-closed `assertMachineOnboarded` gate shared by the CLI and backend.
- `--accept-unverified-auth` and `--reconfigure` for machine onboarding.
- `bun run build:cli:release` compiles one CLI binary per release target into `dist/release/<platform>-<arch>/`; `bun run package:release` reads the binary for each tarball from its own target directory.

### Changed
- One YAML configuration file per layer: the repository schedule moved from `.animus/schedule.json` into the `schedule:` block of `.animus/config.yaml`, the per-project override into `~/.animus/projects/<slug>/config.yaml`, and the machine file from `~/.animus/config.json` to `~/.animus/config.yaml`. Legacy files are migrated on first read and removed; comments and unknown keys survive a rewrite.
- Project settings in the web console write through the same repository file: model bindings map onto `assistant`/`assistants`/`tiers`/`aliases`, and the derived UI fields (`defaultModel`, `plannerModel`, `builderModel`, `reviewerModel`, `worktreeStrategy`) are computed on read instead of being persisted as duplicated state.
- `animus setup` now refuses to configure a repository before machine onboarding and exits with an instruction to run `animus onboard`.
- Backend platform settings no longer seed fabricated provider rows with hardcoded paths and versions; an absent machine config returns schema defaults with an empty provider list.

### Fixed
- Release tarballs no longer ship the CI host binary to every platform. The standalone build ran without `--target` and all four tarballs received the same bytes, so `animus-v0.2.0-darwin-arm64.tar.gz` contained an ELF linux-x64 executable and failed with `exec format error`. Each target is now cross-compiled, and packaged archives are verified after creation by parsing magic bytes and CPU architecture back out of the tarball member.
- Packaging fails instead of fabricating a stub: a missing binary used to become a two-line `console.log("animus v…")` script that made an empty release look successful.
- Saving project settings no longer overwrites the runtime schedule with UI-only fields: the previous camelCase `{cron, enabled, workWindow}` block replaced `parallel`, `max_laps`, `interval_seconds`, `inputs`, and `work_window`, silently resetting loop capacity to defaults.
- `animus setup` and `animus config laps` no longer discard `releases`, `concurrencyLimit`, and operator comments from `.animus/config.yaml`; writes merge into the existing document.
- Interactive prompts redraw in place on narrow terminals. Cursor arithmetic counted newlines instead of wrapped rows, so a long question stacked a new copy on every arrow key.
- Interactive prompts stop fabricating machine-wide values: `setup` inherits `parallel`, `max_laps`, `interval_seconds`, and the work window from machine onboarding.

## [0.2.0] - 2026-10-30

### Added
- Open-source governance baseline: MIT license, contributing guide, security policy, changelog, `.gitattributes` (LF normalization), and Renovate supply-chain configuration.
- Declarative workspace package-edge enforcement in `scripts/health/check-architecture.mjs` covering `packages/contracts`, `packages/client`, `apps/backend`, `apps/engine-host`, and `apps/launcher`.
- Open-source governance file verifier `checkOpenSourceGovernanceFiles` in architecture checks.
- Issue and pull request templates defaulting to `needs-triage` and requiring contract-driven sections.

### Changed
- Layering boundary rules updated to enforce zero application dependencies from contracts/client and mutual isolation between backend and engine-host in both source and `package.json`.

## [0.1.0] - 2026-10-15

### Added
- Initial Bun/Vite+ architecture migration with `@animus/contracts`, `@animus/client`, `apps/backend`, `apps/engine-host`, and `apps/launcher`.
- Native interactive setup wizard (`animus setup`) and forge repository monitoring.
- Unified launcher and coordinated multi-process architecture.
