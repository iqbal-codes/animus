---
name: unstick
description: Break out of repeating test, typecheck, or build failures after two failed attempts. Isolate the shared unverified assumption, run a one-line probe, revert broken scratch edits, and record disproved approaches in the run checkpoint.
---

# Unstick: Failure Recovery & Premise Probing

When two fixes fail the same way, the defect is an unverified belief rather than a syntax detail. Stop iterating on variations of the same edit, test the underlying premise directly, and restart from a clean baseline.

## When to Use

Use this playbook when:
- The same test, typecheck, or build error recurs after **2 consecutive fix attempts**.
- A verification loop reaches **5 iterations** without a passing command output.
- Resuming a `continue` lap or post-deadline continuation where a previous attempt stalled or timed out.
- The context window accumulates repeated stack traces or circular edits.

## Steps

1. **Halt edits and log the failed attempts.**
   Stop modifying production files immediately after the second failure. Write one line per failed attempt recording the exact file edited, the change made, and the verbatim first error line from the command output. On a continuation or `continue` route, treat prior handoff notes as unverified hints and run the narrowest baseline check yourself first.
   *Completion Criterion*: Each failed attempt and its verbatim first error line are documented before any further file modification occurs.

2. **Isolate and probe the shared assumption.**
   State in one sentence the single assumption shared by all failed attempts (e.g., "this code path is executed by the test", "the input payload is already parsed", "the mock transport intercepts this URL", "the environment variable is populated"). Execute the smallest one-line probe that answers yes or no: a single diagnostic log, a CLI inspection command, or a minimal standalone command.
   *Completion Criterion*: The shared assumption is stated in one sentence and the executed probe's stdout/stderr proves whether the assumption is true or false.

3. **Revert failed-experiment hunks against captured baseline and select an orthogonal mechanism.**
   Target only the specific failed-experiment hunks for reversal against the captured baseline; do not default to whole-file checkouts (`git checkout -- <file>`) which wipe out concurrent or previously verified working changes. Inspect `git diff` to identify and revert failed scratch hunks while preserving verified edits and unrelated files. If rollback is ambiguous or potentially destructive to uncommitted progress, ask the user before discarding modifications. If the probe disproved the assumption, design the fix directly from the newly established fact. If the assumption held, evaluate 3 structurally distinct approaches (different layer, data path, or standard library primitive) with one line each on cost and risk, then select the smallest viable approach.
   *Completion Criterion*: `git diff` confirms that only failed scratch hunks are reverted, verified progress remains intact without blanket whole-file resets, and the chosen orthogonal approach specifies target files and a runnable verification command.

4. **Record disproved premises in the checkpoint ledger.**
   Append a `Failed Approaches` entry to the active run checkpoint (`$ARTIFACTS_DIR/handoff/checkpoint.md` or `PROGRESS.md`) with columns `timestamp | attempt | disproved_assumption | probe_evidence | next_action` so subsequent iterations or continuations never repeat the dead end.
   *Completion Criterion*: The checkpoint file contains the updated failure ledger with concrete probe evidence, and the next verification action is documented with an explicit runnable command.
