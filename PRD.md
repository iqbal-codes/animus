# Product Requirements Document (PRD): Animus

## 1. Overview & Vision
Animus is an autonomous, self-improving software delivery and execution engine platform designed to orchestrate and observe iterative AI engineering cycles across local and remote repositories.
Using pinned Animus SDLC workflows (triage, planning, delivery rounds, runtime verification, holdout evaluation, peer review, and deterministic merge gating), Animus safely takes issues or PRDs from conception to verified code landing on main.

## 2. Target Users
- **Autonomous Engineering Teams:** Engineers deploying AI development loops without manual code generation prompts.
- **Factory Operators:** Tech leads who define the scope, curate out-of-scope boundaries, and inspect staging verification evidence.

## 3. Core Capabilities
- **Backlog & Intake Slicing:** Ingest product specs and PRDs to produce an ordered backlog of discrete, testable tickets where each ticket establishes clear acceptance contracts.
- **Governed Autonomous Loops (animus-loop):** Execute sequential or parallel delivery laps with work item claims, isolated git worktrees, and automated route selection (continue, simple, complex, none).
- **Dual Independent Verification:** Run black-box candidate verification (running the delivered code against real behavioral journeys) combined with independent peer diff reviews before merge decisions.
- **Fenced Holdout Scenarios:** Maintain private test scenarios written by dedicated holdout agents that builder agents can never view or game.
- **Deterministic Merge Gate:** Validate CI checks and enforce human-only protected paths (MISSION.md, harness configuration) so agents cannot tamper with their own rules or evaluation harness.
- **Factory Dashboard & Health Observability:** Monitor active runs, review lap histories, inspect verification evidence logs, and halt or pause timers deterministically.

## 4. Technical Architecture
- **Runtime Environment:** Bun (v1.4+) and TypeScript monorepo with Vite+, with pure TypeScript/Bun monorepo execution.
- **AI Engine:** Pinned Animus SDLC Pack workflows with Pi coding agent provider backed by custom router models:
  - Fast / Small / Medium: `ag/gemini-3.8-flash`
  - Frontier / Large / Planner: `cx/gpt-6.1-sol`
- **Application Structure:**
  - HTTP Service / API with `/health` and `/build-id` endpoints returning current Git SHA or candidate ID.
  - State persistence isolated to runtime snapshot directories without leaking across laps.

## 5. Non-Functional Requirements & Invariants
- Fast boot time (< 5s) and lightweight footprint.
- Zero credential leakage in build artifacts, git logs, or test reports.
- Clean isolation between concurrent worktree runs.
