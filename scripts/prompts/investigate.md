# Investigate

Establish the proven causal chain for the target—from observed symptom to the root cause that
explains it—and produce an actionable report a builder or planner can execute without repeating your
analysis. You alter zero product code and fix nothing; the repository must remain exactly as you found it.

Target: $INPUTS.target
Operator request: $ARGUMENTS

Trust source code over any past claim about it: issue bodies, discussions, and prior reports represent past beliefs. Read them for intent and history, then verify every load-bearing assumption against the current code before building on it.

## 1. Ground the Symptom

Define the symptom as an observable failure: the exact command, input, and erroneous output. If a symptom cannot be stated observably, record that as your first unknown rather than speculating.

## 2. Smallest Discriminating Evidence

1. **Cheapest observations first:** Use focused unit tests, specific code execution paths, and narrow log windows over broad repository searches.
2. **Iterative hypothesis elimination:** Formulate plausible competing hypotheses for the cause. Design the smallest observation that separates them, and eliminate alternatives with concrete evidence.
3. **Reproduce before explaining:** Trigger the symptom yourself using project test commands or a minimal script saved under `$ARTIFACTS_DIR/repro/`. If external dependencies or timing make reproduction impossible, state that explicitly and prove the chain through exact code reading and git history.
4. **Distinguish root cause from proximate cause:** Follow the chain past proximate triggers. The chain is complete when resolving the root cause eliminates the symptom without masking it, stopping where repository control ends.

## 3. Implementation-Ready Fix Direction

Once the causal chain is proven, decide the remediation strategy:
- Weigh viable options against project architecture (`engineering.md`, `architecture.md`).
- Detail the chosen fix: ordered steps anchored to concrete files and functions, the validation command that will prove the fix, and what the fix must leave untouched.
- If the fix turns on an engineering choice, decide it. If it turns on a fundamental product direction choice between two valid designs, mark `verdict: inconclusive` with the exact owner question.

## 4. Investigation Report

Write `$ARTIFACTS_DIR/investigation.md`:
- **Symptom:** Precise observable failure.
- **Causal chain:** Step-by-step links from symptom back to root cause, each citing concrete evidence (file, line, or command output).
- **Reproduction:** Exact repro command and observed output (or why reproduction was infeasible).
- **Implementation plan:** Ordered steps with code anchors, alternatives considered, and boundaries to protect.
- **Verification:** Concrete tests or checks that will prove the fix.
- **Ruled out:** Hypotheses eliminated and the evidence that refuted them.
- **Unknowns:** Remaining gaps, if any.

## 5. Output Format

Return your verdict in JSON (plain or within a single ```json code fence):
```json
{
  "verdict": "rooted | inconclusive",
  "cause": "<concise summary of proven root cause>",
  "fix_summary": "<ordered summary of recommended implementation>",
  "report_path": "$ARTIFACTS_DIR/investigation.md"
}
```
Declare `verdict: "rooted"` only when the causal chain is completely proven with reproducible evidence.
