---
name: blueprint
description: Architect non-trivial modules, cross-file refactors, or high-risk changes before coding bodies. Critique a step-checked plan, compile type-safe signatures and stubs first, and prove external blast-radius safety at Proof Level 4.
---

# Blueprint: Type-First Architecture & Blast-Radius Proof

Lock in the data shapes, module boundaries, and verification checks before writing implementation bodies so the compiler validates structure upfront and external callers remain safe.

## When to Use

Use this playbook when:
- Designing a new module, service, CLI command, or public API contract.
- Executing a change across multiple files or on a `complex` delivery route.
- Modifying shared functions, database schemas, async lifecycles, or serialized formats with callers outside the diff.
- Exploring a wide design space where a single first attempt risks locking in the wrong abstraction.

## Steps

1. **Ground callers and critique a step-checked plan.**
   Read every target file and locate all existing callers before planning. Draft a numbered plan of 3–10 atomic steps where each step pairs one code change with one runnable acceptance check. Critique the plan once from a fresh reviewer perspective across three questions: (a) which prerequisite or migration step is missing, (b) which assumption is still unverified against code, and (c) what simpler shape achieves the same outcome with fewer abstractions. When the design space is wide, sketch 2–3 distinct structures (or run parallel candidates) and graft the strongest elements into the simplest base.
   *Completion Criterion*: The written plan maps every step to concrete file/symbol anchors and an executable verification command, with at least one rejected alternative and its rejection reason recorded.

2. **Compile domain types and stub signatures before bodies.**
   Model domain state so illegal states are unrepresentable: use discriminated unions instead of optional-field bags, brand distinct primitive IDs, parse untrusted external inputs (`unknown`) once at the boundary, and enforce exhaustive `never` checks in switch/default branches. Write exported function signatures and module interfaces with stub bodies (`throw new Error("not implemented")`) and run the repository typechecker before implementing logic.
   *Completion Criterion*: The repository typechecker (`bun run typecheck` or configured static check) validates all new types and function signatures with zero type mismatches across callers.

3. **Implement one stub per verification cycle and prune.**
   Replace one stub body at a time, running its narrowest discriminating check immediately after each edit. Inline single-caller wrappers, delete dead code or superseded paths in the same change, and verify that diff size (`git diff --shortstat`) stays minimal.
   *Completion Criterion*: Zero `"not implemented"` stubs remain in the worktree, narrow unit/integration checks exit 0 with captured output, and no deprecated shims or unused types remain.

4. **Prove external blast-radius safety at Proof Level 4.**
   Identify the 1–2 load-bearing safety invariants that protect code outside the diff (caller contracts, async teardown/ordering, pinned dependency behavior, or persisted data compatibility). Grade each invariant on the 5-level proof ladder:
   - Level 1: Verbal claim (insufficient)
   - Level 2: Cited file and line number
   - Level 3: Traced static call path showing failure is unreachable
   - Level 4: Executed test or isolated probe script against real code that fails loudly if the invariant breaks
   - Level 5: Reproduced and verified in the live running application
   Push every load-bearing invariant to **Level 4 or Level 5**.
   *Completion Criterion*: Every cross-boundary safety claim cites the exact Level 4/5 command executed and its passing output log.
