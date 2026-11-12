# Coding Standards (Reviewer Reference)

These standards are enforced during **Code Review** (`loop-review` and `/animus-review`), not injected into the Builder's base prompt. This keeps Builder context pressure low while ensuring strict architectural and code quality gates on every pull request.

## 1. Module Depth & Seam Discipline (`blueprint` / `codebase-design`)

- **Deep Modules**: Modules must hide meaningful complexity behind a small, simple public interface. Callers should know *what* the module does without knowing *how* it works internally.
- **The Deletion Test**: Reject shallow pass-through wrappers, single-caller helper functions, and middle-man abstractions where the interface is nearly as complex as the implementation. If deleting a wrapper and calling the target directly concentrates logic without leaking complexity, flag it as a blocking defect.
- **Canonical Shared Primitives**: Reuse registered building blocks from `.animus/codebase-rules.json` (`pattern_registry`) instead of creating duplicate parsers, transport wrappers, or UI tables/forms.

## 2. Test Quality & Behavioral Seams (`tdd`)

- **Pre-Commit Deterministic CI Invariant**: Bypassing git hooks with `--no-verify`, `-n`, or overriding `core.hooksPath` is strictly prohibited. All commits must pass deterministic pre-commit CI gates (architecture, format, lint, typecheck, tests).
- **Public Seams Only**: Tests must exercise behavior through public interfaces and seams, never by reaching into private methods or internal state.
- **Zero Tautological Assertions**: Reject tests that recompute the expected value using the same logic under test, or tests that merely assert a mock returns what the test configured it to return.
- **Negative & Boundary Coverage**: Happy-path-only tests are incomplete. Every behavioral change or boundary validator must include at least one negative, malformed-input, or failure-mode assertion.

## 3. External Blast-Radius & Caller Safety

- **Unmodified Caller Safety**: Inspect every caller listed in `## Host-Computed Blast Radius (Unmodified Callers Outside the Diff)`.
- **Proof Level 4**: When a change alters shared contracts, async lifecycle/teardown, or persisted state schemas with external callers, verbal claims are insufficient—require an executed test or probe proving external callers remain unbroken.

## 4. Security & Trust Boundaries (`security-hardening`)

- **Strict Boundary Parsing**: Parse all untrusted external inputs (`unknown`) at the boundary using strict schemas (e.g., Zod or typed DTOs) before passing data into domain logic.
- **Parameterized Execution**: Use parameterized queries and argument arrays (`execFile` / `spawn`, never raw shell string interpolation) for all database and subprocess operations.
- **Secret & Error Hygiene**: Redact credentials, tokens, and raw stack traces from outbound responses, PR comments, and logs.

## 5. Simplicity, Anti-Reinvention & Code Smell Baseline

- **Anti-Reinvention Gate**: Block hand-rolled implementations of standard specifications, protocols, or file formats (YAML, JSON, URLs, SHA-256, globs). Require platform primitives or established repository dependencies.
- **Clean Cutover**: Delete dead code, unused exports, deprecated compatibility shims, and narration comments that merely restate the next line of code.
- **Fowler Code Smell Heuristics**: Evaluate diffs against *Mysterious Name*, *Duplicated Code*, *Feature Envy*, *Data Clumps*, *Primitive Obsession*, *Shotgun Surgery*, *Divergent Change*, *Speculative Generality*, and *Middle Man*. Treat smells as judgment calls unless they breach an explicit rule above.
