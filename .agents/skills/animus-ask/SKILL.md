---
name: animus-ask
description: Ask which skill or flow fits your situation. A router over all Animus software factory skills and engineering playbooks.
disable-model-invocation: true
---

# Animus Ask: Factory Skill Router

When you or the agent are unsure which playbook or workflow step fits the current situation, ask `/animus-ask`.

Before stating what a skill does or recommending a step be skipped, read that skill's `SKILL.md`. The summaries here are for orientation across the autonomous software factory lifecycle.

---

## The Factory Lifecycle (Idea → Production)

The canonical path for designing, specifying, executing, and reviewing features in Animus:

```text
[Raw Idea / Need]
       │
       ▼
1. /animus-brainstorm & /animus-grill ──► Sharpen intent, record GLOSSARY.md & ADRs
       │
       ▼
2. /animus-spec                       ──► Author parent specification & acceptance criteria
       │
       ▼
3. /animus-architecture               ──► Map deep module seams, interfaces & rules
       │
       ▼
4. /animus-tickets                    ──► Decompose into dependency-ordered tracer tickets
       │
       ├──► (Single Ticket)     ──► /animus-implement (driven via /tdd, /blueprint)
       │
       └──► (Whole Spec)        ──► /animus-implement-spec (parallel frontier orchestration)
       │
       ▼
5. /animus-review                     ──► Audit diff against CODING_STANDARDS.md & spec
       │
       ▼
6. .agents/skills/pr                  ──► Visual-first PR description with evidence matrix
       │
       ▼
7. /retro & /animus-learn             ──► Capture verified lessons into .animus/lessons.jsonl
```

### Detailed Lifecycle Steps

1. **Ideation & Frontier Grilling**:
   - **`/animus-brainstorm`**: Divergent idea exploration. Explores product opportunities, user archetypes, and tradeoffs when requirements are open-ended.
   - **`/animus-grill`**: Relentless convergent interview. Tests assumptions, pins down scope boundaries, eliminates ambiguity, and commits domain vocabulary to `GLOSSARY.md` and decision records to `docs/adr/`.

2. **Parent Specification**:
   - **`/animus-spec`**: Authors a cohesive, structured specification document. In GitHub mode, publishes a parent tracking issue labeled `spec` and `ready-for-human`. In local mode, writes `.animus/specs/<slug>/spec.md` with companion issue metadata.

3. **Architecture & Boundary Design**:
   - **`/animus-architecture`**: Formalizes deep modules with small interfaces. Establishes module seams, adapters, and patterns, writing to `docs/architecture.md` and updating `.animus/codebase-rules.json`.

4. **Tracer Bullet Ticket Decomposition**:
   - **`/animus-tickets`**: Splits the specification into thin, independently verifiable tickets. Defines explicit `Depends on:` lines to construct the dependency DAG. Flags admitted work as `ready-for-agent`.

5. **Autonomous Implementation**:
   - **`/animus-implement`**: Drives implementation of a single ticket in an isolated session. Executes test-first via `.agents/skills/tdd`, stubs public types via `.agents/skills/blueprint`, hardens boundaries via `.agents/skills/security-hardening`, and verifies UI via `.agents/skills/ui-quality`.
   - **`/animus-implement-spec`**: Orchestrates an entire multi-ticket specification. Reads the ticket graph, dispatches implementers across the unblocked frontier, and lands completed slices on an integration branch.

6. **Code Standards & Compliance Review**:
   - **`/animus-review`**: Independent two-axis evaluation (Engineering Standards + Specification Criteria). Audits changed files against `CODING_STANDARDS.md`, checks for regression seams, and catches AI slop.

7. **PR Authoring & Visual Evidence**:
   - **`.agents/skills/pr`**: Shapes human-friendly, visual-first pull requests. Includes Summary diagrams, Before/After captures, test commands, and Merge Danger assessments.

8. **Post-Lap Memory Synthesis**:
   - **`/retro`**: Retrospective analysis of the session. Focuses on environment improvements and toolchain rules.
   - **`/animus-learn`**: Synthesizes verified operational lessons from past runs into `.animus/lessons.jsonl` or specialized regression playbooks (such as `policy-verifier-regressions`).

---

## On-Ramp Flows (Incoming Work & Triage)

- **Incoming Bug Reports & Feature Requests** → **`/animus-triage`**:
  - The front door for new issues. Assesses whether an issue is technically complete, clarifies ambiguous intent, inspects the codebase first to avoid unnecessary questions, and assigns canonical labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`).
  - Supports both **GitHub Mode** (`gh issue ...`) and **Local Mode** (`.animus/issues/*.md`).

- **Bugs, Regressions, and Test Failures** → **`/diagnosing-bugs`**:
  - Use when something is broken or throwing. Enforces a tight feedback loop (a single command that reproduces the failure red) before proposing any fix. Never theorizes without reproducible evidence.

- **Stuck After Repeated Failures** → **`.agents/skills/unstick`**:
  - Use after two consecutive check or test failures. Breaks the loop by identifying the unverified hidden assumption, running a one-line probe, and reverting broken scratch edits.

---

## Repository Setup & Governance

- **Onboard or Reconfigure Repository** → **`/animus-setup`**:
  - Configures the repository for Animus: selects Issue Tracker Mode (GitHub vs Local `.animus/`), configures triage labels, establishes domain documentation, and scaffolds `AGENTS.md`.

- **Harness Verification & Fences** → **`/animus-harness`**:
  - Audits harness plumbing, discovers and verifies real `exit 0` baseline checks, installs security hooks, and establishes domain holdouts in `.animus/holdout/`.

---

## Quick Reference Index

| Situation / Question | Recommended Skill |
| :--- | :--- |
| "I have an incoming bug or user request to assess" | `/animus-triage` |
| "I have an idea but need to explore angles and tradeoffs" | `/animus-brainstorm` |
| "I need to interview the operator and settle domain terms/ADRs" | `/animus-grill` |
| "I need to draft a comprehensive specification" | `/animus-spec` |
| "I need to design module topology, seams, and patterns" | `/animus-architecture` |
| "I need to break a spec down into actionable, dependency-linked tickets" | `/animus-tickets` |
| "I want to implement a single ticket test-first" | `/animus-implement` |
| "I want to implement an entire multi-ticket spec autonomously" | `/animus-implement-spec` |
| "I need to review code against coding standards" | `/animus-review` |
| "I need to write a pull request description with evidence" | `.agents/skills/pr` |
| "A hard bug or flakiness is occurring" | `/diagnosing-bugs` |
| "I failed checks twice and am spinning in circles" | `.agents/skills/unstick` |
| "I want to capture lessons learned from this run" | `/retro` & `/animus-learn` |
| "I am setting up Animus in a new repository" | `/animus-setup` then `/animus-harness` |
