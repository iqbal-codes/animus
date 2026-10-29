# Simplify — The Smallest Coherent Shape

Writing code is cheap; maintaining it and preserving option value are not. Your task is to detect
structural over-engineering: **the change delivers its required outcome through more structure than
that outcome actually requires.**

Preserve meaningful invariants, supported behavior, and solid foundations—eliminate accidental
machinery, redundant wrappers, and duplicated state. You evaluate and report; you make zero direct
commits to the candidate branch.

Accepted work order:
$INPUTS.work_order

## 1. Ground the Structure

1. **Inspect diff over base:** Fetch `$BASE_BRANCH` from the remote and inspect `git diff origin/$BASE_BRANCH...HEAD`.
2. **Review claims:** Read `$ARTIFACTS_DIR/implementation.md` and `$ARTIFACTS_DIR/review/report.md` to identify what the implementation claims versus what was accepted.
3. **If already analyzed:** If `$ARTIFACTS_DIR/shape.md` already exists from an earlier round, declare `findings: false` and finish immediately without redundant execution.

## 2. Evaluate Structural Decisions

Evaluate the candidate diff against three core questions:
1. **Does an existing primitive already do this?** Check if the change introduces custom types, parsers, wrappers, or helpers that the repository or its declared dependencies already provide. Cite existing helpers that eliminate the redundant code.
2. **Does anything exceed the brief?** Verify that every added abstraction directly serves an acceptance criterion in the work order. Flag speculative extensibility, unused parameters, or undocumented configuration surfaces as candidate deletions.
3. **Does any guard cost more than what it protects?** Weigh the maintenance overhead of added checks and abstractions against the actual failure modes reachable in production.

Apply the laziness test:
- Favor deletion of dead code and direct control flow over introducing intermediate helpers.
- Keep call paths flat so data ownership and lifecycle transitions remain obvious.
- Consolidate decisions behind one authoritative source of truth.

## 3. Verify Before Recommending

Recommend a simplification only when you have established:
- The required outcome and invariant remain completely preserved.
- The avoidable machinery introduces concrete maintenance or correctness overhead.
- A smaller primitive or direct code path provides the identical supported behavior.
- Existing tests and validation pass cleanly with the smaller shape.

Do not replace readable explicit code with opaque cleverness, or invent speculative abstractions for hypothetical future reuse.

## 4. Output Report

Write your findings to `$ARTIFACTS_DIR/shape.md` formatted as follows:
```markdown
# Simplify Report

Findings: true|false
Summary: <one sentence summary>

## Recommendations
- **<file:line>**: <cost of current structure> → Recommended smaller shape: <direct alternative>
```

If no meaningful structure can be eliminated without compromising invariants, declare `findings: false` with a brief explanation of what was verified.
