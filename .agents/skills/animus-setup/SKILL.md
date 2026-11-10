---
name: animus-setup
description: Configure this repository for Animus Software Factory: set up dual issue tracker mode (GitHub or Local .animus/), triage labels, domain doc layout, and agent instructions.
disable-model-invocation: true
---

# Animus Setup: Repository & Tracker Configuration

Scaffold and configure the per-repository conventions that Animus Software Factory skills consume:

- **Issue Tracker Mode**: Where issues and specifications live:
  - **GitHub Mode**: GitHub Issues accessed via the `gh` CLI.
  - **Local Mode**: Markdown files stored in `.animus/issues/*.md` and `.animus/specs/<slug>/spec.md` for local, offline, or air-gapped development.
- **Triage Label Vocabulary**: The canonical labels governing work admission (`ready-for-agent`, `needs-triage`, `needs-info`, `ready-for-human`, `wontfix`, `spec`, `needs-owner`).
- **Domain Documentation**: Where `GLOSSARY.md`, `docs/architecture.md`, and Architectural Decision Records (`docs/adr/`) live.
- **Agent Instructions**: The `## Agent skills` block and context pointers in `AGENTS.md` (and `CLAUDE.md`).

This is an interactive, prompt-driven onboarding skill. Inspect the repository, present findings, confirm choices with the operator, and write the necessary configuration files.

---

## Process

### 1. Explore Repository State

Before prompting, inspect the current workspace:

- Check git remotes (`git remote -v`): Is there an active GitHub origin?
- Check existing issue tracker documentation (`docs/agents/issue-tracker.md`): Is a mode already configured?
- Check directory structure: Does `.animus/` or `.animus/issues/` exist? Does `.scratch/` exist?
- Check instruction files: Does `AGENTS.md` or `CLAUDE.md` exist at the repository root? Does it already have an `## Agent skills` section?
- Check domain docs: Does `GLOSSARY.md` or `GLOSSARY-MAP.md` exist? Does `docs/adr/` or `docs/architecture.md` exist?
- Detect monorepo signals: `pnpm-workspace.yaml`, `workspaces` in `package.json`, or multiple packages under `packages/*/`.

### 2. Present Findings and Confirm Choices

Present a concise summary of detected settings, then walk through each section:

#### Section A: Issue Tracker Mode

Explain the choice:
- **GitHub Mode (`gh` CLI)**: Recommended if the repository has a GitHub remote. Issues and specs are synchronized with GitHub Issues.
- **Local Mode (`.animus/` directory)**: Recommended for local development, offline workflows, private repos without `gh` authentication, or testing Animus loops locally without polluting GitHub. Issues live in `.animus/issues/*.md` and specs in `.animus/specs/<slug>/spec.md`.

*Default recommendation*: If `git remote -v` contains `github.com`, propose **GitHub Mode**, with **Local Mode** always available as a peer or standalone option.

#### Section B: Triage Labels & Admission Policy

Animus enforces five canonical admission labels:

| Label | Purpose |
| --- | --- |
| `ready-for-agent` | Admitted work: complete, unambiguous, eligible for autonomous execution. |
| `needs-triage` | Newly opened work awaiting evaluation. |
| `needs-info` | Waiting on reporter or operator to resolve open questions. |
| `ready-for-human` | Requires human implementation or parent spec tracking. |
| `wontfix` | Excluded work (absolute precedence). |
| `spec` | Taxonomy label identifying a parent specification. |
| `needs-owner` | Escalation label when execution hits retries or boundary limits. |

- In **GitHub Mode**: Confirm whether missing labels should be created automatically via `gh label create`.
- In **Local Mode**: Explain that labels are declared in frontmatter YAML (`labels: [ready-for-agent]`).

#### Section C: Domain Documentation Layout

- **Single-Context** (Standard): A single `GLOSSARY.md` at root and `docs/adr/` for decision records. Fits almost all projects.
- **Multi-Context** (Monorepo): A root `GLOSSARY-MAP.md` pointing to individual subproject glossaries.

---

### 3. Generate & Write Configuration

After operator confirmation:

1. **Ensure Directory Structure**:
   ```bash
   mkdir -p .animus/issues .animus/specs docs/agents docs/adr
   ```

2. **Write or Update `docs/agents/issue-tracker.md`**:
   Record the active issue tracker mode, file paths, dependency format (`Depends on: #12, #14` or `Depends on: None`), and admission gate rules.

3. **Write or Update `docs/agents/domain.md`**:
   Document consumer rules for `GLOSSARY.md`, `docs/architecture.md`, and `docs/adr/`.

4. **Update Agent Instructions (`AGENTS.md` / `CLAUDE.md`)**:
   Ensure `AGENTS.md` (or `CLAUDE.md` if `AGENTS.md` does not exist) includes the `## Agent skills` block:

   ```markdown
   ## Agent skills

   ### Router
   Use `/animus-ask` whenever uncertain which skill or lifecycle flow fits the current task.

   ### Issue tracker
   Tracked in [GitHub Mode / Local Mode (.animus/)]. See `docs/agents/issue-tracker.md`.

   ### Domain docs
   Single-context domain rules in `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

   ### Factory skills
   - Triage: `/animus-triage`
   - Exploration & Grilling: `/animus-brainstorm`, `/animus-grill`
   - Specification & Architecture: `/animus-spec`, `/animus-architecture`, `/animus-tickets`
   - Implementation: `/animus-implement`, `/animus-implement-spec`, `.agents/skills/tdd`, `.agents/skills/blueprint`
   - Review & Delivery: `/animus-review`, `.agents/skills/pr`
   - Recovery: `/diagnosing-bugs`, `.agents/skills/unstick`
   - Harness & Retrospective: `/animus-harness`, `/retro`, `/animus-learn`
   ```

5. **Ensure Compatibility Symlinks**:
   Ensure `CLAUDE.md -> AGENTS.md` and `.claude/skills -> ../.agents/skills` exist for cross-tooling compatibility.

---

### 4. Next Step: Toolchain Verification

Once configuration is written, route the operator directly to:
```text
/animus-harness
```
to verify static lint/typecheck and unit test commands (`exit 0`), install loop guards, and establish holdout fences.
