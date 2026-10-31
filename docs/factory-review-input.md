# Software factory operator app: review input

Status: agreed direction for independent concept review, not implementation approval.

## Problem

The operator wants a single app to configure, schedule, observe, and control autonomous software delivery for `pabriq-app`. Their personal harness handles brainstorming, PRD/spec writing, and splitting requirements into actionable GitHub issues. The factory focuses on implementation, verification, and independent review, without an in-app planning conversation.

## Agreed boundaries

- One backend and execution machine initially, running on the operator's current Mac. The backend should also be installable on a VPS or another machine as an alternative deployment. Fleet management is deferred.
- Pi is the only harness in this release. Other harness adapters are deferred.
- Existing pinned shared Animus workflows remain the execution engine. Do not introduce a competing private workflow copy or unmanaged Pi executor.
- Skills and MCP connections have one shared factory-managed configuration, separate from personal harness settings. Model assignments are explicit per workflow role, such as dispatcher, implementer, runtime verifier, and reviewer. Do not silently inherit harness defaults or substitute models.
- The operator controls factory activation, schedule activation, work windows (including overnight, such as 20:00-05:00), check intervals (such as five minutes), and the maximum number of active main-agent sessions. Child agents do not consume that limit. Idle or paused sessions do not consume active slots. Define mappings between delivery laps, workflow roles, and Pi sessions rather than assuming they are identical.
- The factory only observes agents it launches. It should show active sessions, available live output, status, failures, issue/PR associations, and verification evidence. Complete raw logs are desired, but must not be falsely claimed if the integration drops or truncates output. Secret and private-evaluation content must not leak through logs.
- Disabling admission or reaching the end of work hours lets active work continue. A separate pause-all stops new admissions and cancels active work, preserves exact Pi sessions and workspaces, and allows later continuation. It is not an OS process freeze or rollback of external actions. Session resumption must not be misrepresented if a new session was created instead.

## Intake and execution

- GitHub issues/PRs in `pabriq-app` are the work authority.
- Personal planning harnesses may publish authorized tickets with canonical `ready-for-agent`. Unlabeled issues are held awaiting triage.
- Blocking labels (`needs-info`, `ready-for-human`, `needs-triage`) and exclusion labels (`wontfix`) override readiness. Existing owner-decision restrictions remain binding. Legacy `factory:` labels convey zero authority.
- The factory holds missing or contradictory requirements rather than inventing product decisions. It respects dependencies and existing claims and does not create duplicate implementation while a linked PR exists.
- Work starts from `develop` in separate worktrees. Required tests, runtime verification, and independent review precede automatic merges into `develop`.
- Dependent tickets may start after their prerequisites are verified and integrated into `develop`; they must not wait for human promotion to `main` or be falsely marked released to bypass a blocker.
- The factory creates or updates a `develop` to `main` promotion PR with individual ticket history and evidence. The operator reviews the accumulated work and approves promotion. Deployment is separate. Human-only governance/security/destructive-action decisions are not bypassed by the develop policy.
- Finishing 20-30 tickets overnight is an operator goal, not a throughput guarantee.

## Out of scope

Conversation UI, app-driven brainstorming/PRD authoring, Slack/Jira integrations, public plugin marketplace, fleet scheduling, additional harness implementations, automatic promotion to main, and implicit deployment authorization.

## Review task

Stress-test the concept before a formal design. Separate observed implementation facts from proposed behavior. Do not interpret this document as authority to change governance, schedules, GitHub, credentials, branches, or runtime state.

Look for failures and unresolved decisions, including implementation feasibility, operator usability, execution costs and quota effects, migration, diagnostics, and long-term maintenance. Do not invent scale targets, promise unsupported APIs, or write a full implementation design.

## Primary sources

Project: `/Users/efishery/.t3/projects/animus`.

- `docs/triage-intake-concept.md`: current intake and delivery boundary.
- `factory/consumer.py`, `factory/pack.json`, `.factory/schedule.json`, `.animus/config.yaml`: current engine integration, scheduling, and model bindings.
- `MISSION.md`, `FACTORY_RULES.md`, `factory/WORKFLOW_POLICY.md`: constraints. Read these explicitly because reviewers do not inherit project instruction files.
- `app.py`: actual HTTP application.
- `docs/current-factory-analysis.md`: prior factual inspection, a secondary source to verify rather than accept as authority. Its in-app triage proposal is superseded.

Installed pinned engine: `/Users/efishery/.cache/factory/animus/5c4f5e484262185926b37b070457fabb9bfedae0`.

- `.animus/workflows/sdlc/loop/animus-loop.yaml`
- `.animus/workflows/sdlc/loop/commands/loop-pick.md`
- `.animus/workflows/sdlc/.shared/workable.ts`
- `packages/providers/src/community/pi/resource-loader.ts`
- `packages/providers/src/community/pi/config.ts`
- `packages/providers/src/community/pi/provider.ts`
- `packages/providers/src/community/pi/event-bridge.ts`
- `packages/providers/src/community/pi/session-resolver.ts`

Do not access private evaluation scenario contents or include them in reports. Review source and public contracts only. No external requests or mutations are needed.
