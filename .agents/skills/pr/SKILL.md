---
name: pr
description: Write human-friendly, visual-first pull request descriptions with Summary diagrams, Before/After evidence, and Merge Danger assessment.
---

# Write a Human-Friendly Pull Request

Shape pull request bodies for human clarity first while preserving delimited verification records for automated gates. Use domain language from `GLOSSARY.md` and skip robotic preambles.

## When to Use

Use this playbook when:
- Authoring or updating a pull request body during `/animus-implement` or manual branch delivery.
- Summarizing code changes visually with diff-sketches, call trees, pseudocode, or component trees.

## Steps

1. **Draft the visual `## Summary`**
   Explain what the change accomplishes in 1–2 plain-English sentences using `GLOSSARY.md` terms, followed by the smallest visual that makes the core change obvious at a glance (pseudocode, a `diff` block of control flow/call-tree/file-layout, a shallow file tree, or a short Mermaid sequence diagram). Avoid prose walls and stale line-number lists.
   *Completion Criterion*: `## Summary` contains a concise domain-language overview paired with at least one compact visual block.

2. **Compile `## Evidence` (Before / After + Collapsible Verification Index)**
   Show concrete **Before** and **After** behavior at the top of `## Evidence` (screenshots for UI changes, or failing-then-passing command/test outputs for non-visual changes). Wrap the machine-validated SHA identities and QA criterion table inside `<!-- BEGIN_FACTORY_EVIDENCE_INDEX -->` and a collapsible `<details><summary>Verification matrix & candidate metadata</summary>` block so the PR stays clean for human readers.
   *Completion Criterion*: `## Evidence` presents clear Before/After proof above the delimited `<!-- BEGIN_FACTORY_EVIDENCE_INDEX -->` block.

3. **Assess `## Merge Danger` (Door & Blast Radius)**
   State whether the change is a **Two-way door** (cheap to revert cleanly) or **One-way door** (destructive migration, schema change, or external side effect), and summarize the **Blast Radius** across callers and consumers. Declare any check modifications under `### Judge Alterations (Requires Approval)`.
   *Completion Criterion*: `## Merge Danger` explicitly states the Door type, Blast Radius impact, and preserved invariants.
