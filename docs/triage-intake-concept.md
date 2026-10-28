# External planning, factory execution

Status: working concept updated after operator scope decision. Not implemented or independently reviewed.

## Scope decision

Discuss features, brainstorm, draft PRDs/specifications, and split work into issues using the operator's personal coding harness. Publish the resulting specifications and issues to `pabriq-app` through that harness.

The factory does not provide a conversation UI or an interactive product-triage agent for this release. Slack and Jira integrations are not in scope. GitHub remains the authoritative tracker for dispatchable work.

This supersedes the earlier proposal for an in-app triage conversation and its scope-approval UI. The current mission's restriction on conversational chatbot UI does not need changing for this intake design.

## Handoff contract

Publishing an issue alone does not authorize execution. The operator or their authorized planning workflow applies `ready-for-agent` when the issue is approved for implementation.

An executable issue needs:

- The requested behavior and its scope boundaries.
- Observable acceptance criteria and verification requirements.
- Explicit prerequisite issue references, or an explicit statement that none exist.
- Relevant specification and repository context sufficient for a fresh agent to begin.
- Any actions requiring a human decision or separate authorization.

A substantial feature may link a repository PRD or specification. A small change does not need a separate document merely to satisfy a template.

The factory checks whether the handoff is actionable. It holds unclear or contradictory work and records the missing information rather than inventing requirements or broadening approved scope. This readiness check is distinct from interactive product discovery and from execution routing inside Archon.

## Authorization labels

- `ready-for-agent`: authorized for automatic implementation once other conditions allow it.
- `needs-info`, `ready-for-human`, `needs-triage`: hold work from execution.
- `wontfix`: exclude work with absolute precedence.

Blocking labels override `ready-for-agent`. A missing readiness label means no automatic pickup. Legacy `factory:` prefixed labels (`factory:ready`, `factory:hold`, `factory:exclude`) have zero authority. Existing owner-decision restrictions also remain binding.

These labels are proposed policy, not currently enforced by the pinned selector. Both deterministic workability and dispatcher selection, including continuation of linked PRs, must honor the same authorization contract.

Label changes are admission controls, not proof that already-running tools have stopped. Active-work cancellation remains an explicit operator control.

## Dispatch and delivery

The first release manages `pabriq-app` using one factory backend, initially on the operator's machine. Remote installation is a deployment option; multi-machine coordination and non-Pi harness adapters are deferred.

The dispatcher checks factory and schedule state, configured work hours, available main-agent slots, issue authorization, dependencies, and claims. Child agents do not consume the requested main-agent slots.

Execution stays within pinned shared Archon workflows using Pi. Skills and MCP configuration are shared across factory agents. Models are selected explicitly by workflow role rather than inherited from harness defaults.

Implementation happens in isolated worktrees. Required tests, candidate-bound runtime verification, and independent review precede automatic integration into `develop`. Blocking findings return to implementation for correction and renewed verification.

Dependencies become satisfiable through verified integration commits in `develop`; an issue must not be falsely closed to bypass a dependency. The engine must preserve issue-to-PR-to-commit relationships.

The factory creates or updates a promotion PR from `develop` to `main`, with linked tickets and verification evidence. The operator approves promotion to `main`. Deployment requires separate authorization. Human-only changes remain held regardless of the integration branch policy.

## Operator app

The app controls execution rather than duplicating the operator's planning harness:

- Factory and schedule activation, work hours, and main-agent capacity.
- Shared skill and MCP configuration and explicit role-to-model assignments.
- Actual run/session status, issue and PR relationships, and available live logs.
- Stop-new-work controls that let existing work finish.
- Stop-and-resume controls that preserve the exact sessions and workspaces.
- Verification evidence, blocked work, and the promotion PR.

The app must not describe transformed or truncated native events as complete raw Pi logs. Exact event capture, resource configuration, and session preservation need verification against the pinned engine.

## Existing implementation boundary

The inspected factory app serves only health and build identity (`app.py:27-37`). Current scheduling capacity counts workflow laps, including paused laps, rather than the requested active main-agent sessions (`factory/consumer.py:585-586,718-755`).

The current selector accepts unlabeled issues and waits on textual `Depends on` dependencies. It does not implement readiness-label admission or develop-scoped dependency completion. These changes require supported shared-engine integration, not a private workflow fork.

See `docs/current-factory-analysis.md` for the factual inspection. That earlier report describes the then-proposed in-app triage conversation; the scope decision in this document supersedes that proposal.
