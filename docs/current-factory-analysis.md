# Current software factory: execution, labels, and missing controls

Date: 2026-10-26

## Conclusion

The repository already consumes an Archon delivery engine configured to use Pi. It is not yet the in-app factory control system discussed in this conversation. The application on `main` exposes health and build identity only.

Keep the pinned Archon workflows as the execution authority. An explicit issue-readiness rule would make unattended intake easier to govern, but installing Matt's labels alone would not enforce that rule. The existing selector accepts unlabeled issues and does not recognize Matt's triage states as exclusions.

This is a factual inspection, not the final brainstorm brief or an independent Goldfish design review. No schedules, labels, issues, PRs, or existing project files were changed.

## What was inspected

- Tracked application, consumer, product requirements, mission, workflow policy, and schedule configuration.
- Installed immutable Archon source at revision `5c4f5e484262185926b37b070457fabb9bfedae0`.
- Live repository labels, issue summaries, PR summaries, two issue bodies, and native workflow run status.
- Installed Matt setup, triage, ticket-generation, and implementation skill instructions.
- macOS timer names through `launchctl list`; no matching Archon/factory timer names appeared in that output.

No application tests or model calls were run. Native run status is a recorded engine status, not proof that its worker is healthy or making progress.

## Current architecture

```text
Operator or host timer
    -> factory/consumer.py
    -> pinned Archon CLI and shared SDLC workflow
    -> Pi provider using the SDK
    -> issue/PR work in an isolated worktree
    -> runtime verification and independent diff review
    -> supervised merge outcome
```

The web application is not currently in this control path.

Evidence:

- `app.py:27-37`: only `/health` and `/build-id`; other GET paths return 404.
- `factory/pack.json:2-5`: pinned Archon source and thin-consumer ownership.
- `factory/MIGRATION.md:16-24`: Archon owns agents, workflows, and scheduling; the factory owns project inputs and the consumer.
- `.archon/config.yaml:1-28`: Pi is the assistant, with small/medium and large model bindings and `main` as the worktree base.
- `MISSION.md:51-59`: AI steps must use pinned shared Archon SDLC workflows. A separate direct-Pi runner would conflict with this invariant unless a human changes it.

## How a delivery lap works

A lap is one delivery attempt, not necessarily one persistent Pi session. The loop uses fresh agent contexts for different stages.

1. **Pick:** inspect open PRs, open issues, dependencies, live claims, and project direction.
2. **Claim:** claim the chosen work item. If competing laps claim the same item, the oldest live claim wins.
3. **Build:** continue an existing PR or implement a simple issue. Complex work enters `archon-ship-block`.
4. **Check:** inspect the delivered candidate through a black-box application check.
5. **Review:** independently review the diff and verification evidence.
6. **Disposition:** approve, send back, require an owner decision, or merge when authorized by the merge policy and gates.

Pinned source references, relative to the installed Archon root:

- `.archon/workflows/sdlc/loop/archon-loop.yaml:68-140`: pick, claim, build, and complex route.
- `.archon/workflows/sdlc/loop/archon-loop.yaml:177-244`: application check and evidence validation.
- `.archon/workflows/sdlc/loop/archon-loop.yaml:264-285`: independent review and outcome.
- `.archon/workflows/sdlc/loop/commands/loop-pick.md:17-35`: claims and overlapping change areas.

The repository schedule config supplies `merge: "approve"`. In the pinned workflow, anything other than `auto` leaves merging to a human after approval. The observed running lap also carried `merge: "approve"`. Do not mistake that for a guarantee about every manually launched workflow: the workflow's own default is `auto`.

Evidence: `.factory/schedule.json:1-7`; pinned `loop/archon-loop.yaml:39-43`.

## Current issue-selection rules

The selector does not require a readiness label.

| Signal | Current meaning |
|---|---|
| Existing factory-owned PR | Finish it before starting a new issue. |
| `priority` | Prefer this issue when dependencies are closed. |
| `needs-owner` | Do not work it; an owner decision is needed. |
| `route:ship` | Use the complex delivery route. |
| `Depends on: #n` in issue body | Wait while the dependency remains open. |
| `Loop claim: run ...` comment | Another lap holds the work item until release or expiry. |
| No labels | Still eligible if no other rule blocks it. |

If no priority issue exists, pick favors work that unblocks the most other work, then the lowest issue number, subject to product build order. Existing linked PRs prevent starting duplicate implementation.

Evidence in the pinned source:

- `loop/commands/loop-pick.md:37-57`: ordering, labels, retry caps, and routing.
- `.shared/workable.ts:64-72`: parsing `Depends on` lines.
- `.shared/workable.ts:145-165`: deterministic eligibility gate. It excludes owner-held, claimed, dependent, or already-delivered work, but does not require `ready-for-agent`.

### Live tracker snapshot

At inspection:

- Issues #2 through #7 were open and unlabeled.
- Issue #1 was closed and unlabeled.
- PR #8 was merged; PR #9 was open. Neither had labels.
- The label catalog contained general labels such as `bug`, `enhancement`, and `wontfix`. It did not contain the Matt readiness states or Archon's `needs-owner`, `priority`, and `route:ship` labels.
- Issue #2 and issue #4 both declare `Depends on: #1`, consistent with the pinned parser.

These are point-in-time tracker observations. Missing optional labels do not stop unlabeled work from being selected.

## Scheduling and parallel capacity

What the consumer already implements:

- A default interval of 300 seconds, configurable at schedule installation.
- A configured capacity of 1 to 8 concurrent workflow laps per trigger resource.
- Skip overlapping triggers when capacity is occupied.
- A launch gate that checks native runs and GitHub workability.
- Separate launch and wake handling in `schedule fire` so active workflows can continue through durable waits.

Evidence: `factory/consumer.py:440-489`, `688-772`, `775-858`.

Current declared config: `archon-loop`, `parallel: 1`, `merge: "approve"` in `.factory/schedule.json`.

Important distinctions:

- This capacity counts workflow laps, not Pi parent-session activity. `pending`, `running`, and `paused` are all counted as active by the consumer (`factory/consumer.py:585-586`, `718-755`). That differs from the requested rule that idle/paused main agents release their slots.
- The inspected schedule code has no work-window or timezone fields. An overnight 20:00-05:00 policy is not implemented here.
- The local trigger binding file `.factory/trigger.json` was absent, and no matching timer names appeared in the inspected macOS list. `MISSION.md:84-85` also records scheduling as disabled pending operator validation. This does not prove that no external scheduler exists.
- One native lap was recorded as running: `5c467bcf-810a-44af-9703-d6676afccc9c`. Scheduling being disabled does not imply that manually launched work is stopped.
- On macOS, installation delegates timer setup to native Archon commands (`factory/consumer.py:799-801`). Before exposing app switches, verify which actual timer entry point runs and that it observes the intended launch policy.

## Stop, pause, and resume

Existing names do not match the requested pause-all behavior:

| Existing command | Implemented meaning |
|---|---|
| `pause` | Stop scheduled launches through the consumer path; allow wakes and explicit launches. |
| `halt` | Set a local STOP brake that blocks new launches and selected continuation operations. Does not cancel active workers. |
| `cancel <run-id>` | Forward cancellation to Archon for a named workflow run. |
| `resume <run-id>` | Forward workflow resume to Archon. This alone does not prove stop-and-resume of every Pi session and child process. |

Evidence: `factory/consumer.py:331-402`, `819-858`.

The requested pause-all needs proof that it preserves workflow state, the correct Pi session, and the workspace, and that it stops relevant processes before reporting a paused state.

The pinned Pi adapter supports opening a session by exact ID within its original working directory. If lookup fails, it emits `pi.resume_failed` and starts a fresh session. For the requested product, this must not be presented as successful resumption of the original conversation.

Pinned source: `packages/providers/src/community/pi/session-resolver.ts:19-33,44-69`; `packages/providers/src/community/pi/provider.ts:992-1003`.

A further preservation concern: the consumer can abandon a running lap after its log has been silent for an hour. Its own documentation states that abandonment removes the worktree and loses uncommitted changes (`factory/consumer.py:621-648`). That recovery path must be reconciled with guaranteed resumable progress, not reused blindly as pause behavior.

## Real-time Pi logs

The current Archon adapter embeds Pi through its SDK, not the standalone RPC subprocess proposed earlier in the conversation.

It already subscribes to Pi events, but its exposed stream is transformed:

- Text and thinking deltas are coalesced into whole blocks.
- Tool starts and final results are mapped to Archon events.
- Tool output is passed through truncation.
- Some lifecycle events are deliberately skipped.
- `tool_execution_update` has no mapping in the inspected mapper and falls through to an empty result.

Therefore, a UI over current Archon events must not claim to show every raw Pi event or all command output in real time. That requires checking the capture and delivery path end to end, and possibly improving the shared engine integration.

Pinned source: `packages/providers/src/community/pi/provider.ts:1183`; `packages/providers/src/community/pi/event-bridge.ts:282-367,461`.

## What Matt's setup adds

`/ask-matt` is a skill router, not a scheduler or label installer. The actual setup skill is `/setup-matt-pocock-skills`.

Its setup writes tracker, triage-label, and domain-document configuration, updates a repository instruction file, and creates missing tracker labels after confirmation.

Default state labels:

- `needs-triage`
- `needs-info`
- `ready-for-agent`
- `ready-for-human`
- `wontfix`

Triage also uses a category, `bug` or `enhancement`. External PR triage is optional and defaults off. When enabled, it reuses the same states; for a PR, `ready-for-human` means ready for human merge.

Sources:

- `/Users/efishery/.agents/skills/setup-matt-pocock-skills/SKILL.md:38-61,63-118`
- `/Users/efishery/.agents/skills/triage/SKILL.md:24-45`
- `/Users/efishery/.agents/skills/to-tickets/SKILL.md:60-66`

Matt-generated tickets declare blockers through native tracker links or `Blocked by` references. The current Archon gate parses `Depends on` text instead. A shared dependency contract is necessary before feeding those tickets into the current scheduler unchanged.

## Recommendation

Use explicit issue readiness, but keep one enforced lifecycle rather than layering two conflicting systems.

1. Keep Archon responsible for claims, delivery, verification, and merge gates.
2. Define a readiness contract before creating new labels. A label should authorize intake, not merely decorate a ticket.
3. If adopting `ready-for-agent`, enforce it in both the deterministic workability gate and the pick instructions. The inspected workflow inputs do not expose a readiness-label setting; this needs a supported shared-engine change and pin upgrade, not a local workflow fork.
4. Treat blockers and active claims as additional requirements. A ready label alone never means immediately runnable.
5. Preserve native CI, review, candidate identity, and merge evidence as PR truth. A `ready-for-human` label is not sufficient authorization or proof of safe merge.
6. Choose one dependency representation that both ticket creation and scheduling consume.
7. Build app controls over the native engine, and verify the actual timer entry points, event completeness, and resume semantics before presenting them as supported controls.

Installing the Matt setup alone would leave `needs-triage`, `needs-info`, and `ready-for-human` issues selectable by the current engine. That is the central integration hazard.

## Decision still needed

Should explicit readiness mean human approval of every ticket, or may an automated triage workflow promote sufficiently specified tickets into the runnable queue?
