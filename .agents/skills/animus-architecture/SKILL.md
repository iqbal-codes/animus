---
name: animus-architecture
description: Derive tech stack, codebase module topology, and reusable component contracts from agreed product specs, verified against official primary-source documentation.
disable-model-invocation: true
---

# Architect the codebase and tech stack from product specs

Read `docs/agents/domain.md` first. This stage translates settled product specifications (`/animus-spec`) into a grounded technology stack, folder/module topology, and shared reusable component catalog before ticket decomposition (`/animus-tickets`). Product requirements drive architecture, never the reverse.

## When to Use

Use this playbook when:
- Starting a greenfield application or service after product specs (`docs/spec-*.md` or spec issues) are settled.
- Introducing a new technology stack, defining codebase folder conventions (e.g., feature-based vs layer-based), or extracting cross-slice reusable UI/domain components before `/animus-tickets`.
- Skip directly from `/animus-spec` to `/animus-tickets` for incremental brownfield slices whose stack, folder topology, and shared primitives already exist in the repository.

## Steps

1. **Extract architectural drivers and repeating patterns from settled product specs.**
   Read all target product specs (`docs/spec-*.md` or spec issues), any `docs/brainstorm-<slug>.md` map, and existing repository conventions (`AGENTS.md`, `GLOSSARY.md`, `docs/adr/`, `.factory/codebase-rules.json`). Identify:
   - **Delivery & runtime drivers**: public SEO / SSR vs authenticated internal SPA, offline/local-first vs online-only, realtime vs request/response.
   - **Data & state drivers**: relational integrity, concurrency, auditability, and multi-tenancy requirements.
   - **Cross-spec repeating patterns**: scan across all settled product specs to find recurring UI and domain structures (e.g., filterable CRUD data tables, transactional forms, approval modals, status badges, shared validation modules) that should be built once as **Shared Reusable Components / Deep Modules**.
   *Completion Criterion*: Every architectural question and reusable-component candidate cites concrete requirements across the settled product specs.

2. **Settle Tech Stack, Module Topology, and Reusable Primitives with the user.**
   Work in 1–2 concise rounds of numbered questions (max 3–4 per round), pairing each with a product-grounded recommendation (`➡️`) worded so agreement accepts it:
   - **Runtime & Tech Stack**: frontend/backend frameworks, state/query layer, database, and UI primitives justified by Step 1's product drivers (e.g., SPA like Vite for internal tools without SSR needs vs SSR framework for public/SEO surfaces) while honoring user taste.
   - **Codebase & Folder Topology**: directory organization (e.g., feature-based `src/features/<slice>/` vs domain/layer-based) and deep module seams using `.agents/skills/blueprint/SKILL.md` and `docs/agents/domain.md` conventions.
   - **Shared Reusable Component & Module Catalog**: the exact shared primitives (tables, form fields, layout shells, API/data adapters) that foundation tickets must deliver so feature slices reuse them without duplication.
   **Default-and-Park Rule**: When the user accepts a recommendation or delegates to standard defaults, lock that sub-branch immediately without spawning micro-questions.
   *Completion Criterion*: The user confirms the tech stack, folder/module topology, and catalog of shared reusable components.

3. **Verify selected stack patterns against official primary sources.**
   Verify current versions, setup conventions, and idiomatic APIs for the chosen stack against primary sources (via Context7 docs tools or by dispatching `$research` to write `docs/research-<stack-topic>.md`) instead of relying on pretraining memory.
   *Completion Criterion*: Every chosen framework and library pattern is verified against official primary-source documentation and cited in `docs/research-*.md` or `docs/architecture.md`.

4. **Write `docs/architecture.md` and hand off to `/animus-tickets`.**
   Write `docs/architecture.md` (and any load-bearing ADRs in `docs/adr/`) using the shape below. If the user wants structural conventions enforced automatically during builder laps (e.g., requiring shared `<FormField />` or enforcing feature-folder boundaries), propose corresponding rules for `.factory/codebase-rules.json` or `AGENTS.md` for user approval. Present the completed architecture doc and suggest `/animus-tickets` next. Do not invoke `/animus-tickets` automatically.
   *Completion Criterion*: `docs/architecture.md` (and any approved ADRs or codebase rules) is written and confirmed with the user.

## Architecture document shape

```markdown
# Codebase Architecture: <Project or Initiative Title>

## 1. Product Drivers & Stack Decisions
- **Source Specs**: <Links to `docs/spec-*.md` / spec issues>
- **Runtime & Tech Stack**: <Chosen frameworks, libraries, and product-driven rationale>
- **Primary-Source References**: <Links to `docs/research-*.md` or official docs verified>

## 2. Directory & Module Topology
```text
<Canonical folder tree, e.g., src/features/<slice>/, src/shared/components/, etc.>
```
- **Module Seam Rules**: <Import boundaries and where interfaces live>

## 3. Shared Reusable Component & Module Catalog
| Shared Primitive | Location | Responsibility & Interface | Consumed by Specs |
| :--- | :--- | :--- | :--- |
| `<ComponentOrModule>` | `<path>` | `<what it hides behind its seam>` | `<S1, S2, S3>` |

## 4. Foundation Prerequisites for `/animus-tickets`
- **Foundation Slice (`S0`)**: <Project scaffold, shared UI/CRUD primitives, and core seams that must complete before parallel feature tickets>
- **Enforced Codebase Rules**: <Rules recorded in `.factory/codebase-rules.json` or `AGENTS.md`>
```
