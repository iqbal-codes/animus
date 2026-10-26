# Mission

**Derived from:** PRD.md
**Last reconciled with it:** 2026-10-26

## What LabQ Software Factory is

LabQ Software Factory is an autonomous software delivery platform and factory coordinator that transforms specs, PRDs, and issues into verified, production-ready code. It automates triage, planning, multi-round implementation, black-box runtime verification, and peer code review using shared, pinned Archon SDLC workflows. Human engineers set the destination and inspect staging verification evidence, while the autonomous factory manages the delivery cycle.

The factory operates single-tenant and deployment-focused, isolating all execution in clean, independent git worktrees with strict build-candidate attestation and immutable evaluation fences.

## Who it is for

- **Software Engineers & Tech Leads:** Autonomous execution of defined backlog tickets with verified PRs and zero manual prompt babysitting.
- **Factory Operators:** Managing parallel lap quotas, inspecting live verification runs, and governing merge gates.

LabQ Software Factory is not an interactive chat assistant or an unverified code generation copilot.

## Core capabilities (in scope)

The factory may accept issues in these areas.

**Intake & Backlog Management**
- Slicing PRDs and specs into dependency-ordered tickets with clear acceptance contracts.
- Automated triage and routing into plan, investigate, simple, or complex delivery pipelines.

**Autonomous Execution & Delivery**
- Multi-lap unattended loops with work-item claiming and isolated worktree management.
- Implementation and delivery rounds with unit tests, linting, and formatting checks.

**Verification & Quality Assurance**
- Black-box runtime verification testing live HTTP applications against real end-to-end user journeys.
- Fenced acceptance test scenario authoring and evaluation isolated from builder agents.
- Deliberate mutation checks and baseline calibration.

**Governance & Merge Gates**
- Deterministic merge queue validating CI checks and enforcing protected path rules.
- Operational status, lap history tracking, and manual intervention controls (`halt`, `pause`, `unhalt`, `unpause`).

## Out of scope -- the factory must never build this

**Non-goals & Forbidden Surfaces**
- **General CI/CD platform:** Never build or become a general-purpose runner or workflow replacement for GitHub Actions or GitLab CI.
- **Unverified auto-merges:** Never allow direct merges or skip verification gates without passing automated black-box runtime tests and peer review.
- **Chatbot conversational UI:** Never add conversational chatbot widgets, natural-language chit-chat personas, or non-deterministic chat streams.
- **Third-party plugin market:** Never build public unvetted plugin stores or download untrusted executable extensions at runtime.
- **Interactive runtime shell access:** Never expose raw interactive bash terminals or reverse shells over web interfaces.
- **Proprietary workflow bifurcations:** Never fork or maintain duplicate private copies of the Archon SDLC pack workflows inside this repository.
- **Multi-tenant public hosting:** Never implement multi-tenant billing, organization tenancy, or public SaaS authentication.

## Hard invariants -- not tunable by any issue

These are not features. They are properties that define what LabQ Software Factory is. Changing one requires a human commit.

1. **Every AI step uses pinned shared Archon SDLC workflows.** Direct unmanaged subagent scripting or parallel workflow forks are prohibited.
2. **The factory cannot modify governance files.** `MISSION.md`, `FACTORY_RULES.md`, `FACTORY.md`, `.claude/settings.json`, and `.ignore` are protected. A pull request modifying any of them must be rejected.
3. **The factory cannot modify its own judge.** `harness/` and acceptance criteria define what "working" means. Loosening or removing an assertion is strictly a human decision.
4. **Clean candidate identity.** HTTP applications must report their exact candidate hash or commit via `/build-id` and 200 via `/health`.
5. **No credential leakage.** Secrets and API keys must never appear in generated source files, commits, PR comments, or test logs.

## Allowed evolutions

- Adding new specialized verification scenarios or test harnesses within `harness/`.
- Enhancing runtime host performance, health check latency, and process cleanup.
- Expanding internal dashboard metrics and run reporting formats.

## Definition of done

Every change the factory ships clears all three gates.

**Gate 1 -- static checks and tests pass.** Unit tests, typechecks, and linters pass cleanly (`python3 -m unittest discover` or `bun test`).

**Gate 2 -- product-level quality bar.** The code follows idiomatic repository patterns, introduces no stubs or placeholder mocks, and passes peer diff review with 0 blocking findings.

**Gate 3 -- the end-to-end path passes as a real user.** The service launches, passes `/health` and `/build-id`, and fulfills the observable user journeys defined in `harness/END-TO-END.md`.

## Open questions -- decisions nobody has made yet

- **Q1:** Should factory run logs be persisted to a local SQLite database or structured JSONL files in `.factory/logs/`?
- **Q2:** Should dashboard notifications integrate via Slack/Discord webhooks or remain local CLI/HTTP only?

## Decisions

- 2026-10-26 **Assistant provider & models:** Configured with Pi coding agent using `router/ag/gemini-3.8-flash` for fast/small/medium tasks and `router/cx/gpt-6.1-sol` for large/reasoning tasks.
- 2026-10-26 **Scheduling policy:** Scheduling remains disabled until one complete issue lap has been observed and validated by the operator.

## What the factory does NOT own -- permanently human

- Product vision, market fit, and overarching roadmap decisions.
- Taste, UI aesthetics, typography choices, and branding tone.
- Deciding which out-of-scope non-goals to retire or retain.
