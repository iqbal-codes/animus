# LabQ Software Factory Operator App

*   **Author:** iqbal-codes
*   **Status:** Proposed (Post-EGM Review)
*   **Date:** 2026-10-26

--------------------------------------------------------------------------------

## Overview

The LabQ Software Factory Operator App provides execution control, scheduling governance, and operational observability over an autonomous AI software delivery loop across managed repositories (such as `pabriq-app`). 

Feature planning, brainstorming, PRD generation, and issue ticket creation take place externally in the operator's personal coding harness. The software factory acts strictly as an execution engine: it discovers authorized backlog issues from GitHub, verifies dependencies, provisions isolated worktrees, runs multi-stage coding and runtime verification laps via Pi (orchestrated by pinned Archon SDLC workflows), and lands verified pull requests into a staging integration branch (`develop`). 

The operator retains final delivery authority: promotion from `develop` to `main` requires human review and sign-off on a consolidated promotion pull request. The factory runs locally on the operator's machine (with support for remote VPS hosting as an alternative deployment), operating continuously in the background even when the visual operator app is closed.

## The Problem

Operating autonomous coding agents at factory scale exposes serious operational failure modes:
1. **Uncontrolled or premature execution**: Running unvetted issues against a production codebase risks code churn, conflicting file edits, and wasted LLM token budgets. The engine needs a deterministic admission boundary so only fully specified, human-authorized tickets are admitted.
2. **Review fatigue from sequential PRs**: When an overnight run produces 20 to 30 dependent pull requests, requiring the human operator to manually inspect, approve, and merge each intermediate PR halts progress and causes review exhaustion.
3. **Premature promotion to production**: Allowing autonomous agents to merge code directly to `main` without separate staging or aggregate verification risks deploying broken builds or unreviewed schema migrations.
4. **Leaky configuration and invisible execution**: Running agents using local machine defaults leads to configuration drift (unpinned extensions, unmanaged MCP tools, unmonitored model choices). Furthermore, lack of real-time visibility into active agent operations, tool calls, and reason-for-skipping makes overnight runs a black box.

The Operator App solves these challenges by placing a deterministic control and telemetry layer over the execution loop: enforcing label-based admission, isolating autonomous integration into `develop`, batching morning review into an immutable `develop -> main` promotion PR, and providing clear visibility into active agent laps, logs, and slot utilization.

## Goals

*   **G-1 (Strict Intake & Label Admission)**: Ensure the factory picks up only open issues explicitly labeled `ready-for-agent`, while respecting blocking labels (`needs-info`, `ready-for-human`, `needs-triage`), exclusion labels (`wontfix`), and unresolved dependencies. Unlabeled issues remain held awaiting triage. Legacy `factory:` labels convey zero authority.
*   **G-2 (Autonomous Staging Integration)**: Implement and independently review each admitted ticket in an isolated worktree, automatically merging verified changes into `develop` so dependent tickets can unblock and proceed overnight without human intervention.
*   **G-3 (Immutable Morning Promotion Boundary)**: Once overnight laps complete or the promotion candidate is formed, freeze further merges into `develop` and open a consolidated promotion pull request targeting `main` for human approval.
*   **G-4 (Operational Control & Safety)**: Provide operator controls to enable/disable scheduling, enforce active working hours (e.g. 20:00 to 05:00), limit concurrent main-agent laps, pause active execution cleanly without losing workspace state, and monitor live tool/agent execution events.
*   **G-5 (Centralized Configuration & Model Visibility)**: Provide a shared, version-controlled configuration for skills and MCP connections, with explicit model tier mappings in `.archon/config.yaml` rather than relying on untracked personal harness defaults.

## Non-Goals

*   **NG-1 (No In-App Conversational Planning/Chatbot)**: The app will not provide a chat interface for brainstorming, product ideation, or PRD authoring. Planning happens in the operator's personal harness.
*   **NG-2 (No Automatic Main Promotion or Auto-Deploy)**: The factory will never autonomously merge code into `main` or trigger production deployments without explicit operator action.
*   **NG-3 (No Multi-Machine / Fleet Coordination)**: The first release supports a single backend instance (local Mac or standalone VPS); it will not synchronize or balance workloads across a fleet of execution nodes.
*   **NG-4 (No Non-Pi Harness Adapters in MVP)**: Support for Claude Code, Codex CLI, or OpenCode as execution runtimes is deferred. Pi is the sole execution harness for this release.
*   **NG-5 (No Public Marketplace or Untrusted Extensions)**: The app will not run a public plugin store or dynamically download unvetted executable extensions at runtime.
*   **NG-6 (No Issue Tracker Duplication)**: The factory will not duplicate tracking in Jira, Linear, or an internal task database. GitHub Issues and PRs on `pabriq-app` serve as the sole source of truth for work items.
*   **NG-7 (No In-App Config Mutation CRUD)**: The app will not provide web editors for raw YAML/JSON files. Configurations are maintained in version-controlled repository files.

## Open Questions

*   **Question 1**: What exact issue state transition should mark a ticket as "integrated into develop" (e.g., adding an intermediate label like `factory:integrated` vs. closing the issue with a link to the commit) without prematurely signaling release before `main` promotion?
*   **Question 2**: What authentication and access control boundary should be required when deploying the operator app backend on a remote VPS instead of local loopback?

## Critical User Journeys (CUJs)

### CUJ 1: Overnight Backlog Delivery & Morning Sign-Off

*   **Given**: The operator has published 5 dependent issues to `pabriq-app`, each labeled `ready-for-agent`, with explicit `Depends on: #...` relationships defined. The factory scheduler is enabled with work hours set to 20:00–05:00 and a concurrency limit of 2 laps.
*   **When**: The scheduler ticks at 20:05. The engine verifies workability, claims issue #1, builds it in an isolated worktree rooted at `origin/develop`, verifies tests and runtime health, passes independent review, and automatically merges the PR into `develop`. Issue #2 (which depends on #1) is unblocked and processed next.
*   **Then**: By 05:00, all 5 issues are merged into `develop`. Further merges into `develop` are halted. The operator opens the app, reviews unpromoted commits and verification evidence in the Promotion Panel, and clicks "Prepare Promotion PR". A consolidated promotion PR from `develop` to `main` is opened on GitHub. At 08:30, the operator reviews the single promotion PR and merges it into `main`.

### CUJ 2: Halting Admissions and Cancelling Active Execution

*   **Given**: An active overnight run is executing a multi-round test fix in an isolated worktree. The operator observes abnormal token consumption or decides to perform manual maintenance on `pabriq-app`.
*   **When**: The operator toggles "Drain New Work" (`POST /api/control/pause`) or triggers "Cancel Lap" (`POST /api/control/cancel`).
*   **Then**: In drain mode, the scheduler immediately stops admitting new tickets while allowing the current lap to finish cleanly. In cancel mode, the running Archon workflow is cancelled via `archon workflow cancel <id>`, its GitHub claim is released, the worktree is preserved for inspection, and the UI reports the lap as cancelled.

### CUJ 3: Observability of Quarantined or Blocked Issues

*   **Given**: Three issues are marked `ready-for-agent`, but one contains a conflicting `needs-info` label, one depends on an unmerged prerequisite, and one has incomplete acceptance criteria.
*   **When**: The operator opens the factory dashboard.
*   **Then**: Rather than showing an empty screen with "0 agents running", the intake ledger lists each issue and explicitly displays why it was not admitted (`Held by label: needs-info`, `Waiting on prerequisite: #12`, `Unresolved requirements contract`).

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. High-Level Architecture Overview

The system consists of three architectural layers running on a single host (local macOS or remote Linux VPS):
1. **Operator Web App & Backend API**: A lightweight Python service extending `app.py` providing REST endpoints and static UI assets for scheduling control, intake observability, candidate promotion, and lap telemetry.
2. **Factory Consumer & Native Engine Bridge**: An orchestration controller (`factory/consumer.py`, `laps.py`) communicating with the pinned Archon SDLC runtime via JSON commands over subprocess pipes.
3. **Execution Runtime (Archon & Pi)**: Isolated Git worktrees executing multi-stage autonomous development laps (`archon-loop`) with the embedded Pi coding agent SDK.

```text
+-----------------------------------------------------------------------------------+
|                            OPERATOR CLIENT BROWSER                                |
|   - Schedule / Work Window Controls      - Active Lap Telemetry & Log Viewer      |
|   - Intake Ledger (Ready/Held Issues)     - Develop -> Main Promotion Gate Panel   |
|   - Shared Skills & MCP Status           - Model Tier Configuration Inspector     |
+-----------------------------------------------------------------------------------+
                                        |  HTTP (Polling GET /api/laps/:id)
                                        v
+-----------------------------------------------------------------------------------+
|                        FACTORY OPERATOR APP (app.py)                              |
|   Endpoints:                                                                      |
|     /health, /build-id                  -> Liveness & candidate attestation       |
|     /api/workflows, /api/doctor         -> Pinned engine diagnostics & discovery  |
|     /api/laps, /api/laps/:id            -> Authoritative native lap telemetry     |
|     /api/intake                         -> Evaluated GitHub backlog & hold causes |
|     /api/config/schedule                -> Active toggles, work windows, limits   |
|     /api/promotion/status, /prepare     -> Unpromoted commit diff & PR creation   |
|     /api/control/pause, /resume         -> Admission drain toggles                |
|     /api/control/cancel                 -> Active workflow cancellation           |
+-----------------------------------------------------------------------------------+
                                        |  Python Subprocess & Local File State
                                        v
+-----------------------------------------------------------------------------------+
|                      FACTORY CONSUMER & SCHEDULER CONTROLLER                      |
|                                                                                   |
|  .factory/schedule.json      .factory/PAUSE           .factory/gate.json          |
|  [Capacity, Work Hours,      [Admission Drain         [Last Board Signature,      |
|   Workflows, Target Base]     Flag]                    Idle Timestamps]           |
|                                                                                   |
|  factory/consumer.py:                                                             |
|   - launch_decision(): Custom admission gate checking labels, base, & promotion   |
|   - schedule fire: Evaluates work hours, capacity slots, and launches laps        |
|   - Explicit target binding: passes --input target=#<id> to workflow run          |
+-----------------------------------------------------------------------------------+
                                        |  Bun CLI invocation (`archon workflow run`)
                                        v
+-----------------------------------------------------------------------------------+
|                      PINNED ARCHON SDLC ENGINE & PI RUNTIME                       |
|                                                                                   |
|   Target Repo: pabriq-app                                                         |
|   Integration Base: develop                   Promotion Target: main (Human only) |
|                                                                                   |
|   Workflow: archon-loop (Pi Agent Provider)                                       |
|   +---------------+     +---------------+     +---------------+     +-----------+ |
|   | 1. Pick       | --> | 2. Build      | --> | 3. Check App  | --> | 4. Review | |
|   | (loop-pick)   |     | (loop-work)   |     | (Black-box    |     | (Diff &   | |
|   | Bound: target |     | Worktree:     |     | Runtime Test) |     | Evidence) | |
|   +---------------+     | origin/develop|     +---------------+     +-----------+ |
|                         +---------------+                                 |       |
|                                                                           v       |
|                                                                     +-----------+ |
|                                                                     | 5. Land   | |
|                                                                     | Auto-merge| |
|                                                                     | to develop| |
|                                                                     +-----------+ |
+-----------------------------------------------------------------------------------+
```

### 2. Core Subsystems and Technical Mechanisms

#### A. Intake Ledger & Workability Contract (`/api/intake`)
To prevent the autonomous loop from grabbing unready issues, the engine enforces strict intake admission before any lap is launched:
*   **Label Invariants**: An issue is admitted **only** if:
    1. `ready-for-agent` is present.
    2. No blocking labels (`needs-info`, `ready-for-human`, `needs-triage`) or exclusion labels (`wontfix`) are present. Legacy `factory:` labels convey zero authority.
    3. The issue is in `OPEN` state on `pabriq-app`.
    4. All referenced `Depends on: #...` items are satisfied (the referenced issue is closed on GitHub with its associated PR merged into `develop`).
    5. No existing factory PR or active lap claim (`Loop claim: run <id>`) already targets this issue.
*   **Explicit Target Binding**: In `factory/consumer.py:launch_decision()`, once an issue is verified as admitted, its number is bound directly to the launch command via `--input target=#<number>`. This prevents `loop-pick` from falling back to arbitrary unlabeled issues.
*   **Intake Ledger Projection**: A dedicated service polls GitHub issue status (cached for 60 seconds) and evaluates each issue against these rules, returning a structured list:
    `{ number, title, status: "admitted" | "held" | "excluded", reason: string, dependencies: list[int] }`.

#### B. Branch Routing & Safe Staging Integration
To balance overnight autonomous throughput with release safety, the factory enforces an explicit two-tier branching model:
*   **Autonomous Staging Base (`develop`)**:
    *   Worktrees are created from `origin/develop` via `consumer.py`'s existing `baseOverride: "develop"` passing configured in `.factory/schedule.json`.
    *   Pull requests created during `loop-work` explicitly target `baseRefName: "develop"`.
    *   Archon's `land` node merges accepted PRs strictly into `develop`.
*   **Human Promotion Boundary (`main`)**:
    *   The engine is strictly forbidden from executing automated merges into `main`. Promotion to `main` is manual.
    *   **Promotion Preparation (`POST /api/promotion/prepare`)**:
        1. Verifies that `develop` contains unpromoted commits relative to `main` (`git rev-list origin/main..origin/develop`).
        2. Gathers delivery evidence and pull request titles for all delivered tickets.
        3. Creates an aggregate promotion PR targeting `main` titled `chore(release): promote develop to main [batch YYYY-MM-DD]`.
        4. Writes `.factory/PAUSE` to enact a **Candidate Freeze**, halting any new integrations into `develop` while the promotion PR is awaiting operator review.

#### C. Lifecycle, Capacity, and Pause Semantics
*   **Capacity Slot Accounting**: Concurrency is metered by active delivery laps (configured via `parallel: N` in `.factory/schedule.json`), where active laps correspond to `{ pending, running }` states in Archon's native run store.
*   **Schedule & Work Window Enforcement**:
    *   `schedule.json` defines `work_window: { enabled: boolean, start_time: "20:00", end_time: "05:00", timezone: "Asia/Jakarta" }`.
    *   The `launch_decision` function in `factory/consumer.py` checks local time against this window before launching new work. Ticks outside the window wake existing in-flight laps to allow them to finish cleanly, but admit no new laps.
*   **Three-Tier Control Primitives**:
    1.  **Drain (`POST /api/control/pause`)**: Writes `.factory/PAUSE`. The scheduler stops launching new laps while allowing active laps to proceed through verification, review, and staging integration.
    2.  **Resume (`POST /api/control/resume`)**: Removes `.factory/PAUSE`, re-enabling scheduler admissions.
    3.  **Cancel Active Work (`POST /api/control/cancel`)**: Calls `archon workflow cancel <run-id>`, clears the in-flight GitHub issue claim, and leaves the worktree branch intact for subsequent manual inspection.

#### D. Configuration & Model Routing
*   **Static Version-Controlled Configuration**:
    *   Global model tiers (`small`, `medium`, `large`) are maintained directly in `.archon/config.yaml`.
    *   Shared skills reside in `.factory/resources/skills/`.
    *   MCP definitions reside in `.factory/resources/mcp.json`.
*   **Read-Only Diagnostic Reporting**:
    *   The app exposes `GET /api/config/models` and `GET /api/config/resources` to display the active configuration in the UI without exposing write CRUD endpoints.

#### E. Observability & Telemetry
*   **Authoritative Run Telemetry**: The UI reads lap transitions and structured evidence via `GET /api/laps` and `GET /api/laps/:id` directly from Archon's native run store via `laps.py`.
*   **Lightweight Telemetry Polling**: The operator dashboard polls `GET /api/laps/:id` every 2–3 seconds while a lap is active, displaying current node status, duration, and execution output without the operational fragility of SSE connection state.

--------------------------------------------------------------------------------

## Risks & Mitigations

1.  **Branch History Divergence (`develop` vs `main`)**:
    *   *Risk*: If PRs are squash-merged into `develop`, and the consolidated promotion PR is subsequently squash-merged into `main`, commit ancestry diverges, causing stale diffs and future merge conflicts.
    *   *Mitigation*: The promotion PR is merged into `main` using standard merge commits (`--merge`), or alternatively, after merging the promotion PR, `develop` is fast-forwarded to match `main` (`git checkout develop && git reset --hard main && git push --force-with-lease`).
2.  **GitHub API Rate Limiting**:
    *   *Risk*: Frequent dashboard polling triggering `gh issue list` or `gh pr list` can exhaust GitHub rate limits.
    *   *Mitigation*: Cache GitHub backlog and issue status in-memory within `intake.py` with a 60-second TTL.
3.  **Candidate Mutation during Morning Review**:
    *   *Risk*: New tickets merging into `develop` while the operator is reviewing the promotion PR invalidates review evidence.
    *   *Mitigation*: When `prepare_promotion()` opens the promotion PR, it immediately writes `.factory/PAUSE`. The intake service and `launch_decision()` treat an open promotion PR as a hard freeze on new admissions.
4.  **Remote Deployment Surface**:
    *   *Risk*: Exposing management endpoints over a public VPS port without authentication risks unauthorized workflow execution.
    *   *Mitigation*: For MVP, `app.py` binds strictly to `127.0.0.1`. Remote VPS deployments require SSH port forwarding (`ssh -L 8080:127.0.0.1:8080`).

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Direct Auto-Merge into `main` with Human Exception Handling
*   **Description**: Allow verified implementation PRs to merge directly into `main` autonomously.
*   **Reason for Rejection**: Violates delivery safety. Verifying individual tickets against test fixtures does not guarantee that 20–30 accumulated tickets won't break production invariants together. Staging in `develop` provides a safe aggregate review point.

### Alternative B: In-App Conversational Chatbot for Planning and Triage
*   **Description**: Build an integrated interactive chat interface within the Operator App to brainstorm features.
*   **Reason for Rejection**: Overengineered and violates `MISSION.md:45`. The operator already has customized personal harnesses (Claude Code, T3 Code) optimized for conversational planning.

### Alternative C: Direct RPC Subprocess Management Instead of Pinned Archon Workflows
*   **Description**: Bypass Archon SDLC workflows and implement a custom task runner spawning Pi subprocesses directly.
*   **Reason for Rejection**: Directly violates Hard Invariant 1 (`MISSION.md:55`). Reinvents worktree isolation, claim locks, and verification gates.

### Alternative D: Dynamic Web CRUD Configuration & Per-Role Model Routing
*   **Description**: Build web forms and REST endpoints to dynamically rewrite `.archon/config.yaml` and `.factory/resources/mcp.json`.
*   **Reason for Rejection**: Archon SDLC workflows declare global tiers (`large`), not arbitrary per-node role overrides. Building file-editing web CRUD in Python introduces high complexity for a single-operator local developer tool.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

The implementation follows 4 sequential phases. Each phase leaves the codebase testable and verified.

### Phase 1: Intake Ledger & Admission Gating (`intake.py`)
*   **File**: `intake.py` (Create)
    *   Implement `IntakeService` querying GitHub issues for `pabriq-app` via `gh issue list --json number,title,labels,body,comments,state`.
    *   Evaluate admission rules: requires `ready-for-agent`, forbids blocking/exclusion labels (`needs-info`, `ready-for-human`, `needs-triage`, `wontfix`). Legacy `factory:` labels convey zero authority.
    *   Check dependency status: for each `Depends on: #<num>`, verify referenced issue is closed and PR merged.
    *   Implement 60-second in-memory caching for query results.
    *   Expose `evaluate_backlog() -> list[dict]`.
*   **Tests**: `tests/test_intake.py` (Create)
    *   Test admission matrix: unlabeled (`held`), `ready-for-agent` (`admitted`), `needs-info` (`held`), `wontfix` (`excluded`), unsatisfied dependency (`held`).
    *   Mock `subprocess.run` calls to `gh`.

### Phase 2: Consumer Scheduler Integration & Target Binding
*   **File**: `factory/consumer.py` (Modify)
    *   Update `launch_decision()` to call `IntakeService.get_next_admitted()`.
    *   If admitted issue exists, bind it directly to workflow run arguments (`--input target=#<number>`).
    *   Check for Candidate Freeze: if an open promotion PR exists or `.factory/PAUSE` is present, refuse launch.
    *   Enforce work window: evaluate `work_window` from `.factory/schedule.json` against current time in configured timezone. Outside work hours, allow existing runs to finish, but admit no new laps.
*   **Tests**: `tests/test_consumer_gating.py` (Create)
    *   Verify `launch_decision()` returns `None` outside work hours, when paused, or when no `ready-for-agent` issue is admitted.
    *   Verify target issue is bound to launch parameters.

### Phase 3: Telemetry, Control, & Promotion Endpoints (`app.py`, `promotion.py`)
*   **File**: `promotion.py` (Create)
    *   Implement `PromotionService`:
        *   `get_status()`: runs `git log origin/main..origin/develop` to count unpromoted commits and list delivered ticket numbers.
        *   `prepare_promotion()`: creates PR from `develop` to `main`, formats body with lap evidence, and writes `.factory/PAUSE`.
*   **File**: `app.py` (Modify)
    *   Expose REST endpoints:
        *   `GET /api/intake`: Returns backlog evaluated by `IntakeService`.
        *   `GET /api/promotion/status`: Returns unpromoted commit count and candidate status.
        *   `POST /api/promotion/prepare`: Triggers promotion PR creation.
        *   `POST /api/control/pause`: Writes `.factory/PAUSE`.
        *   `POST /api/control/resume`: Unlinks `.factory/PAUSE`.
        *   `POST /api/control/cancel`: Cancels run via `archon workflow cancel <id>`.
        *   `GET /api/config/schedule`: Reads current schedule.json.
        *   `GET /api/config/models`: Reads model tiers from `.archon/config.yaml`.
    *   Add static asset handler for `/` and `/static/*` pointing to `web/` with directory traversal protection.
*   **Tests**: `tests/test_app_control.py` (Create)
    *   Verify HTTP status codes, JSON response bodies, and control actions for pause/resume/cancel.
    *   Verify static asset routing blocks directory traversal attempts (`/../../etc/passwd` returns 404).

### Phase 4: Operator Dashboard UI & Visual Specification (`web/`)
*   **Design Source of Truth**:
    *   Interactive Canvas: `/Users/efishery/.pencil/documents/240767a8-5df0-413b-a5c3-3c5cb274b820/pabriq-software-factory.pen`
    *   Design Brief: `docs/designs/ui_design_brief.md`
    *   Visual Specimens:
        *   Operator Console Running: `docs/designs/ui-spec-images/f7lTSU.png`
        *   Promotion Review Modal: `docs/designs/ui-spec-images/O0C3m6.png`
        *   Promotion Creating State: `docs/designs/ui-spec-images/P2n0yb.png`
        *   Promotion PR Created: `docs/designs/ui-spec-images/YDlR9.png`
        *   Promotion Checks Blocked: `docs/designs/ui-spec-images/LuTmg.png`
        *   Settings Views (Providers, Agents, Skills, MCP, Schedule): `docs/designs/ui-spec-images/{hSbc7,t4h5V,G7qZG8,pZdJ0,PgIvB}.png`
*   **Files**: `web/index.html`, `web/app.js`, `web/style.css` (Create)
    *   High-fidelity operational dashboard adhering 100% to the x.ai design system established in Pen.app:
        *   **Tree Hierarchy Navigation Sidebar**:
            *   Brand mark (`uM96z`) + Version tag (`v1.0.0`).
            *   `+ Add repository` primary white pill button (`9999px` radius).
            *   Search filter input with embedded leading icon.
            *   Repository tree list (`pabriq-app` expanded, others collapsed).
            *   Issue submenu:
                *   Active issue (`#42`): active highlight, lap runtime badge, and spinning arc indicator (`$xai-accent`).
                *   Ready issue (`#43`): green dot (`$xai-success`) + `Ready` tag.
                *   Held issue (`#44`): amber dot (`$xai-warning`) + `Hold #42` tag.
            *   Footer pinned at bottom: `Factory Settings` button (`Agents · Skills · MCP · Schedule`).
        *   **Top Utility Bar**:
            *   Engine status (`● Factory Engine Active`), operating window (`20:00–05:00 WIB`), slots meter (`1/2 Active`), base branch (`develop`).
            *   Action button: White pill `Promote 4 commits to main` opening the Promotion Review modal.
            *   Engine master switch: `x.ai / Switch / On` toggle.
            *   Emergency control: `Drain admissions` pill button (`$xai-error`).
        *   **Active Issue Workspace & Telemetry Pane**:
            *   Breadcrumbs (`pabriq-app / Issues / #42`) + tags (`ready-for-agent`, `gpt-6.1-sol`, `tree-42`).
            *   Navigation pill tabs: `● Realtime Telemetry & Logs` (active), `Issue Specification`, `PR & File Diffs`, `Token Economics & Stats`.
            *   Linear SDLC pipeline breadcrumbs: `✓ pick` → `✓ claim` → `● build (loop-work)` → `check-app` → `review` → `land`.
            *   Live Log Stream panel (`r8KMCd`): Mac window dots (red, yellow, green), copy action, monospace log streaming with PID/worktree info.
            *   Staging PR Card: target branch (`develop`), file additions/deletions diffs (`auth/webhook.py +38/-2`, `tests/test_webhook.py +45/-0`).
            *   Token Economics Card: input tokens (cached), output tokens (speed), thinking tokens, estimated run cost.
        *   **Promotion Review & Feedback Modals**:
            *   Full modal overlay for commit inspection, merged PRs list, checks status, and `Create promotion PR` trigger matching `O0C3m6.png`.

### Verification & Review Plan (Mandatory Visual Evidence Gate)

*   **Builder Agent Instructions Invariant**:
    *   Whenever delegating UI or frontend tasks to a builder subagent, the prompt **MUST** explicitly link and reference the visual screenshot specs from `docs/designs/ui-spec-images/` and the `.pen` file canvas.
*   **Static Analysis & Syntax**:
    ```bash
    python3 -m py_compile $(git ls-files '*.py')
    ```
*   **Unit Tests**:
    ```bash
    python3 -m unittest discover -s tests -p 'test_*.py'
    ```
*   **Visual Regression & End-to-End (E2E) Browser Verification Gate**:
    *   Unit tests, typecheck, and backend test passes are **necessary but insufficient** to approve UI and integration work.
    *   Every review and verification pass of the operator console **MUST**:
        1. Run the local test server hosting the web frontend and API.
        2. Execute real browser navigation / headless scenario checks (using available browser preview tools, e.g. `html_preview` or browser CDP inspection).
        3. Capture actual rendered screenshots of the live interface across both standard desktop (1440px) and mobile/narrow (320px) viewports.
        4. Compare the captured browser screenshot against the baseline design spec in `docs/designs/ui-spec-images/` (e.g. `f7lTSU.png`, `O0C3m6.png`).
        5. Verify that spinning indicators, tab switches, log scrolling, modal disclosures, and button interactions function without clipping, console errors, or layout degradation.
*   **Integration Checks**:
    *   Start `app.py` on an ephemeral port.
    *   Verify `/health` returns 200 in under 5 seconds.
    *   Verify `/api/intake` correctly parses sample GitHub issue fixtures.
    *   Verify `/api/control/pause` and `/resume` create and remove `.factory/PAUSE`.
    *   Verify `/api/promotion/status` calculates commit delta between branches.
    *   Verify `POST /api/promotion/prepare` generates the promotion payload and writes `.factory/PAUSE`.
*   **Black-Box Factory CI**:
    *   Run `python3 harness/ci.py` to ensure candidate identity and holdout protection fences remain intact.

--------------------------------------------------------------------------------

*Drafted and Reviewed with EGM*
