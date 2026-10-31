# Changelog

All notable changes to `animus` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
