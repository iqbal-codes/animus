# Changelog

All notable changes to `labq-software-factory` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Workspace package-edge validation (`checkWorkspacePackageEdges`) in `scripts/health/check-architecture.mjs`.
- Open-source governance compliance checking (`checkOpenSourceGovernanceFiles`) in `scripts/health/check-architecture.mjs`.
- Open-source governance files: `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `.gitattributes`, and `renovate.json`.
- Standard GitHub issue templates (`bug_report.md`, `feature_request.md`) defaulting to `needs-triage`.
- Evidence-driven pull request template (`.github/pull_request_template.md`).

## [0.2.0] - 2026-03-01

### Added
- Autonomous multi-harness development loop with interactive setup (`labq-factory setup`).
- Project registration and monitoring subsystem (`RegisteredProjectMonitor`).
- Unified multi-process launcher (`apps/launcher`) for backend and engine-host.
- Monorepo architecture boundary validation and toolchain pinning.
- Strict private access mode, session secret `0600` permissions, and CSRF protection.
- Database migration snapshotting and rollback primitives.
