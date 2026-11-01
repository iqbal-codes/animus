---
name: policy-verifier-regressions
description: Use when implementing or repairing governance policy verifiers for Git attributes, GitHub template labels, or Renovate rules, especially after a false-positive review finding. Build isolated semantic mutation regressions and distinguish repaired examples from remaining policy gaps.
origin: learned
---

# Policy Verifier Regressions

## When to Use

Follow this playbook at the governance verifier's public filesystem seam. Use `.agents/skills/tdd/SKILL.md` for the underlying test-first loop.

## Steps

1. **Pin the reproduction.** Record the candidate SHA, acceptance criterion, reviewer fixture, and expected consumer behavior; create a temporary valid governance root and establish that the public verifier accepts it.
   *Completion Criterion*: The recorded SHA identifies the tested code, the baseline returns `ok:true`, and each finding has an explicit expected result.

2. **Isolate semantic mutations.** Copy the valid root separately for each mutation and change one policy condition: conflicting later Git attributes, an empty label value with a triage token in a comment, or a broad later Renovate enabling rule. Compare Git fixtures with `git check-attr`, and state the label-value or rule-order interpretation supporting each other expectation; retain supported valid counterexamples.
   *Completion Criterion*: Each fixture has one attributable mutation, an independently justified expectation, and captured actual verifier output; temporary roots have guaranteed cleanup.

3. **Turn findings into regressions.** Add assertions through `checkOpenSourceGovernanceFiles(repoRoot)` that reject the reproduced invalid fixtures and accept the valid controls, then implement the correction. Expand review to adjacent semantics, including attribute resets, YAML nesting, and restricted rule coverage, and record any unresolved case explicitly.
   *Completion Criterion*: Each claimed repair has an assertion that fails on the earlier implementation and passes on the candidate, valid controls pass, and every newly reproduced gap is tracked as unresolved or repaired.

4. **Replay and report.** Replay the saved reviewer fixtures against the candidate, run the focused distribution suite and required repository gates, and bind each result to the tested SHA. Separate repaired examples, remaining counterexamples, and the actual reviewer disposition.
   *Completion Criterion*: Evidence records commands, assertion outcomes, and exit codes for the candidate, and the handoff accounts for every blocking finding.

## Evidence Boundary

Issue #85 exhibited this workflow across three review rounds: initial D1-D4 at `252ec4fb`, D5-D7 at `d140b394`, and D8-D10 at `8b6e8097`. Identical isolated R5-R7 fixtures changed from false acceptance to rejection after targeted corrections, while R8/R10/R11 remained false positives despite 24 passing distribution tests. The terminal reviewer disposition was `needs-owner`, delivering only part of the issue; no successful final resolution was observed.

The reflection attribution `helped` applies to the individually verified R5-R7 repairs, not issue completion or demonstrated skill effectiveness. Treat this skill as an unbenchmarked proposal for curation before installation. Place its conditional context pointer near the front of AGENTS.md and retain the under-150-line bound.
