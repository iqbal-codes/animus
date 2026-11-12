# Documentation Index

Every document under `docs/` carries a lifecycle status. `scripts/health/check-docs.mjs`
enforces this index, header presence, path/line references, relative links, and API
route families on every commit.

## Lifecycle Contract

- **Active**: current behavior or current operating contract. Agents may implement from it.
- **Draft**: proposed but not yet authoritative. Agents may design from it, not assume it shipped.
- **Historical**: a past design or investigation record. Agents must not implement from it.
- **Superseded**: replaced by a named document. Agents must follow the replacement.

When a document stops being the current truth, move it under `docs/archive/`, add
`Status: Historical` or `Status: Superseded` plus `Superseded by`, and update this index.
Planning skills read only current `docs/` notes; `docs/archive/**` is evidence about the
past, never a specification for new work.

## Current Contracts

- [Runtime contract](runtime.md) — **Active**. Start argv, state, HTTP routes, execution authority, and operator boundaries.
- [Onboarding guide](onboarding.md) — **Active**. Installation channels, enrollment, and project configuration.
- [Health and toolchain journey](monorepo-health.md) — **Active**. Exact Bun/Node/Vite+ versions and verification commands.
- [Execution authority cutover](authority-cutover.md) — **Active**. Durable authority marker, migration-15 staging, activation, and legacy fences.
- [Learning reliability hardening](spec-learning-reliability-hardening.md) — **Active**. Implemented lesson admission, evaluation, and delivery contract.
- [Domain models, architecture & ADRs](agents/domain.md) — **Active**. Glossary, architecture, and shared-primitive conventions.
- [Harness authoring standard](agents/harness-authoring-standard.md) — **Active**. How to curate lessons, rules, and skills.
- [Issue tracker contract](agents/issue-tracker.md) — **Active**. `gh` conventions, dependencies, and triage labels.
- [PR and evidence contract](agents/pr-evidence-contract.md) — **Active**. PR bodies, evidence matrices, and finding rechecks.
- [Workflow policy](workflow-policy.md) — **Active**. Shared SDLC workflow requirements, bootstrap guidelines, and workflow inputs.
- [Design system](design/animus-design-system.md) — **Active**. Semantic tokens, primitives, and applied UI surfaces.

## Historical Archive

These documents describe earlier revisions or completed designs. Keep them for
provenance; never implement from them.

### Research

- [Enterprise agent governance](archive/research/enterprise-agent-governance.md) — **Historical**. Baseline `8db3c52`; proposed architecture, not current policy.
- [Local application state architecture](archive/research/local-app-state-architecture.md) — **Historical**. Early `~/.animus/` design note.
- [PR evidence and review contract](archive/research/pr-evidence-and-review-contract.md) — **Historical**. Baseline `d25e19f`; superseded by the active PR contract.
- [Token optimization and triage budget](archive/research/token-optimization-and-triage-budget.md) — **Historical**. Pre-cutover `local-loop.ts` analysis; cited anchors no longer exist.
- [TypeSafe Jev decision model](archive/research/typesafe-jev-decision-model.md) — **Historical**. Jev was replaced by harness evaluation.

### Specifications

- [Agent governance](archive/specs/agent-governance.md) — **Historical**. Implemented governance foundation; baseline `8db3c52`.
- [Web console](archive/specs/web-console.md) — **Historical**. Design record for the implemented React console.
- [Self-improving harness with Jev](archive/specs/self-improving-harness-jev.md) — **Historical**. Superseded by harness evaluation.
- [Post-loop self-improving harness](archive/specs/post-loop-self-improving-harness.md) — **Superseded** by learning reliability hardening.
- [Multi-ticket orchestration](archive/specs/multi-ticket-spec-orchestration.md) — **Superseded** by the runtime contract and implement-spec skill.
- [Sub-ticket auto-merge judgement](archive/specs/subticket-auto-merge-judgement.md) — **Superseded** by child-gate v2 and the authority cutover.

### Analysis

- [Current factory analysis](archive/analysis/current-factory-analysis.md) — **Historical**. Inspection of the pre-TypeScript factory.
- [Factory review input](archive/analysis/factory-review-input.md) — **Historical**. Early operator-app concept review.
- [Setup and harness skills plan](archive/analysis/plan-animus-setup-and-harness-skills.md) — **Historical**. Implementation plan for `animus setup` and harness skills.
- [Triage intake concept](archive/analysis/triage-intake-concept.md) — **Historical**. Superseded intake boundary.

### Factory Consumer

- [Factory installation and migration](archive/factory/MIGRATION.md) — **Historical**. Describes the removed Python consumer.
- [Runtime host](archive/factory/RUNTIME_HOST.md) — **Historical**. Describes the removed Python runtime host.
