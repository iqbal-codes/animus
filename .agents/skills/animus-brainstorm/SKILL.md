---
name: animus-brainstorm
description: Shape a broad product or initiative idea into an ordered slice map before slice-level grilling.
disable-model-invocation: true
---

# Brainstorm and slice a product idea

Map a broad product or multi-module initiative (`1-to-N`) into user-meaningful product slices so `/animus-grill` can deep-dive one slice at a time. Stay strictly at the product capability level; leave slice-internal edge cases to `/animus-grill` and technology stack or folder structure decisions to `/animus-architecture`.

## When to Use

Use this playbook when:
- Starting from a greenfield product prompt, broad initiative, or multi-module idea too large for a single specification.
- Decomposing a system into independent vertical product slices (`S1`, `S2`, `S3`...) that can be grilled sequentially or in parallel waves.
- Skip directly to `/animus-grill` when the request already targets a single focused feature or slice.

## Steps

1. **Ground context and lock the Product Thesis and Global Boundary (Round 1).**
   Read the conversation and any existing product docs in the repository. Ask at most 3–4 numbered questions at high altitude, each paired with a grounded recommendation (`➡️`) worded so agreement accepts it:
   - Core problem, value, and why now.
   - Target actors and product surface characteristics (e.g., internal back-office vs public SEO-facing, online vs offline, workflow/CRUD density).
   - **Global Out-of-Scope (Non-Goals)**: capabilities explicitly excluded from this initiative so downstream sessions never drift into them.
   Wait for the user's answers before proposing slices. When the user accepts a recommendation or asks for a standard default, lock that branch under **Sensible Defaults** without generating follow-up detail questions.
   *Completion Criterion*: The user confirms the product thesis, actor boundaries, product surface characteristics, and explicit global exclusions.

2. **Settle the Shared Product Spine and Wave-Ordered Slice Map (Round 2).**
   Based on Round 1, propose and confirm two artifacts with the user:
   - **Shared Product Spine**: cross-slice domain vocabulary, global business rules (e.g., single-entry vs double-entry, currency/tenant rules), and parked sensible defaults that every slice must obey so parallel `/animus-grill` sessions remain consistent.
   - **Vertical Slice Map (`S1`, `S2`, `S3`...)**: partition the product into user-meaningful capability slices (1 slice = 1 `/animus-grill` session -> 1 `/animus-spec`), grouped into dependency waves (`Wave 1 — Foundation`, `Wave 2 — Parallelizable`, etc.). State each slice's observable outcome, in-scope boundary, sibling exclusions, and `Depends on` edges.
   If a product-level decision depends on external primary-source facts, propose an explicit research topic and dispatch `$research` to write `docs/research-<topic>.md` only after user approval.
   *Completion Criterion*: The user approves the Shared Product Spine, the exact list and wave order of Product Slices, and any authorized research spikes.

3. **Write `docs/brainstorm-<slug>.md` and hand off to `/animus-grill`.**
   Write the agreed map to `docs/brainstorm-<slug>.md` using the shape below. Present the file path and suggest which Wave 1 slice(s) to pass into `/animus-grill` next (including which unblocked slices can be grilled in parallel sessions). Do not invoke `/animus-grill` or later stages automatically.
   *Completion Criterion*: `docs/brainstorm-<slug>.md` is written and confirmed with the user.

## Brainstorm map shape

```markdown
# Brainstorm Map: <Product or Initiative Title>

## 1. Thesis & Global Boundary
- **Problem & Value**: <Core problem, target value, and timing>
- **Actors & Product Surface**: <Primary actors and product characteristics: internal vs public, online vs offline, workflow density>
- **Global Out-of-Scope (Non-Goals)**: <Capabilities ruled out of the entire initiative>

## 2. Shared Product Spine
- **Canonical Domain Terms**: <Shared terms every slice must use consistently>
- **Global Business Rules**: <Cross-slice product rules that bind all parallel grill sessions>
- **Sensible Defaults (Parked)**: <Agreed baseline assumptions that `/animus-grill` must not re-litigate>
- **Research References**: <Links to `docs/research-*.md` with one-line takeaways, or `None`>

## 3. Slice Map (1 Slice = 1 `/animus-grill` -> 1 `/animus-spec`)

### Wave 1 — Unblocked Foundation Slices
#### [S1] <Slice Title>
- **Depends on**: None
- **Outcome**: <Observable capability delivered to the actor>
- **In-Scope**: <Capabilities owned by this slice>
- **Excluded (Owned by Sibling Slices)**: <Capabilities deferred to S2, S3, etc.>
- **Spec Pointer**: _Ungrilled_

### Wave 2 — Parallelizable Slices
#### [S2] <Slice Title>
- **Depends on**: S1
- **Outcome**: <Observable capability delivered to the actor>
- **In-Scope**: <Capabilities owned by this slice>
- **Excluded (Owned by Sibling Slices)**: <Capabilities deferred to other slices>
- **Spec Pointer**: _Ungrilled_
```
