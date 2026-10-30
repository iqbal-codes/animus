# Local loop execution budgets

The local loop keeps a bounded wall-clock budget per agent attempt. It does not
remove timeouts or treat a timed-out candidate as verified.

| Role | Soft deadline | Hard deadline |
| --- | --- | --- |
| Builder | 20 minutes | 25 minutes |
| QA and reviewer | 15 minutes | 20 minutes |
| Other agent roles | 15 minutes | 20 minutes |

At the soft deadline, stop starting new work and write the checkpoint path supplied
in the attempt prompt. Include completed changes, checks and their results,
blockers, and the exact next action. Return `{"verdict":"interrupted"}` instead
of claiming success. The Pi tool guard permits only checkpoint writes and simple
read-only Git inspection commands after this deadline. Other providers receive
the same deadline instructions; the host enforces the hard deadline for all
providers.

The hard deadline terminates the owned POSIX process group, records the attempt
output and a host checkpoint, and permits one continuation by default. Continuations
reuse the same worktree, so committed and uncommitted candidate changes remain.
Each continuation has its own attempt budget. Exhausting the continuation limit
leaves the run `interrupted`; it cannot advance to QA, approval, or publication
from an incomplete attempt. The scheduler holds interrupted issues rather than
starting fresh worktrees for them automatically. Inspect their checkpoint and
worktree before deciding the next action.

## Configuration

CLI launches inherit these environment variables (milliseconds):

```sh
FACTORY_LOOP_BUILDER_SOFT_MS=1800000 \
FACTORY_LOOP_BUILDER_HARD_MS=2100000 \
bun run loop --issue 85
```

Use the same `FACTORY_LOOP_<ROLE>_SOFT_MS` and `_HARD_MS` names for `QA`,
`REVIEWER`, or other roles. Values must be positive integers in the platform timer
range, with soft strictly earlier than hard.

Programmatic `runLocalLoop` callers can pass `roleBudgets` and
`maxContinuations` (0–2). The explicit `timeoutMs` option remains a whole-attempt
override, with its soft deadline at 80% of that value.

Bash calls default to 90 seconds when no valid timeout is supplied. Explicit
longer command timeouts are allowed, but clipped to the attempt's remaining hard
budget. Silent output alone is not classified as a stall: a build or test may
legitimately be quiet. Hard deadlines still bound provider waits and commands.

## Discovery and verification

Backlog discovery reads paginated open issues and resolves only referenced
dependency states, in deduplicated GraphQL batches. Exact-target checks remain
fresh before dispatch; discovery cache is not execution authority. Jev advisory
is excluded from discovery and remains available in intake preview.

Offline tests inject forge transports or test-owned CLI fixtures rather than
adding production fixture-data overrides. Run both ordinary verification and
loop-specific Bun tests:

```sh
bun run verify
bun test --timeout 30000 tests/integration/local-loop*.bun.test.ts \
  tests/integration/loop-script.bun.test.ts \
  tests/integration/loop-modules.bun.test.ts \
  tests/integration/scheduler-discovery.bun.test.ts \
  tests/integration/onboarding-monitor.bun.test.ts
```
