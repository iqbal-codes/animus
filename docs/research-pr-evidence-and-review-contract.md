# Research: readable, decision-useful PR evidence and review records

- **Date:** 2026-11-01
- **Topic:** PR bodies, Before/After evidence, review findings, resolutions, and status comments for Animus.
- **Status:** Research and proposed design, not an approved template, runtime contract, or merge policy.
- **Inspected checkout:** `d25e19f7909a6963a834bc7ea6bae0bb4e0992a7`. Local citations identify files and line ranges inspected at this revision. External sources were retrieved on the date above; branch-based OSS template URLs can change.
- **Scope:** Read-only investigation plus this note. No template, policy, runtime, tracker, or forge state changed. All sample bodies, evidence rows, and comments below are illustrative, not reports of verification performed.

## Recommendation

Keep the existing PR headings. Put the outcome and review starting point first, then a small AC-to-evidence table and a separate Before/After table. UI changes should show real screenshots, with textual observations and capture context; new UI may honestly say **“Before: N/A, new feature”** while still supplying After proof. Treat missing evidence differently from inapplicable evidence. Record the tested candidate, not just a branch name. Keep detailed logs behind links or collapsible sections, without hiding failures or missing approval.

Use PR prose as a readable evidence index, not an authorization channel. Resolve current GitHub checks/reviews and the configured native workflow's actual evidence and permission requirements separately. A comment saying “approved” is not itself a GitHub approval review or proof of permission to merge. This follows existing local authority boundaries, rather than creating a new approval policy. [L2][L3][L4][L6][S9]

The specific table layouts, screenshot matching rules, finding IDs, and comment layouts recommended here are **proposals for Animus**, not requirements imposed by GitHub, Google, or the cited OSS projects.

## 1. Current state and gaps

| Observed contract or implementation | Gap relevant to this task | Basis |
| --- | --- | --- |
| The PR template contains Problem and Outcome, Invariants, Review Guidance, Changed Seams, Evidence, and Judge Alterations (Requires Approval). Evidence asks for criterion-to-verification mapping. | The contract is already a useful starting point. It does not explain Before/After, UI captures, capture identity, new-feature N/A, unavailable baselines, or explicit result states. | `.github/pull_request_template.md:1–22` [L1] |
| CONTRIBUTING requires a work item/contract and all five main PR sections. | A replacement template with unrelated headings would introduce a second convention. Extend or clarify the existing structure instead. | `CONTRIBUTING.md:67–77` [L1] |
| Workflow documentation requires source/AC, observed result, command/scenario, artifact, and tested candidate; PASS, FAIL, BLOCKED, and NOT RUN are distinct. Code/base changes require affected evidence refresh. | The PR template's short Evidence hint does not expose this richer, already-documented evidence contract. | `docs/agents/software-factory-workflow.md:68–85` [L2] |
| The review skill separates Standards and Spec, confirmed defects and evidence gaps, and PASS/SKIPPED/INCOMPLETE. It pins base/head and requires independent review. | A compact published summary should preserve these distinctions, not collapse them into “looks good” or an undifferentiated findings list. | `.agents/skills/factory-review/SKILL.md:25–39,91–106` [L3] |
| The local-loop PR creator supplies its own `--body`: Summary, Evidence, candidate, route, and checkbox checks, rather than the repository template. | Updating only the template would leave this actual publication path divergent. Every builder check is rendered checked regardless of its result text; absent checks produce “Initial build & verification complete.” Those presentations can imply success without supporting proof. | `scripts/local-loop.ts:939–959` [L7] |
| Continue-route builder comments include candidate, summary, changes, and checks. All checks are rendered `[x]`; a missing result is rendered `ok`. | Explicit failures, not-run results, and missing results need honest textual states instead of success-shaped rendering. This is a source inspection finding, not a reproduced runtime failure. | `scripts/local-loop.ts:374–413` [L7] |
| Local-loop review comments include candidate, QA lines, findings, rationale, and dispositions. The host publishes them with `gh pr comment`. | The information is useful but is not a native GitHub approval-review resource. Missing findings render as “No blocking standards or specification findings”; absence of a list alone does not establish completed review coverage. | `scripts/local-loop.ts:1114–1179`; GitHub review resource semantics [L7][S9] |
| The local-loop source derives `waiting_approval` from QA/reviewer report booleans, and its comment says it awaits human merge approval. The reviewer prompt describes outcomes and a later deterministic gate. | Prompt intent and display labels must not be represented as proof of a completed merge or an executable authorization check. This note does not audit the complete merge machinery or certify these booleans as sufficient. | `scripts/local-loop.ts:1026–1042,1164–1169`; `scripts/prompts/loop-review.md:1–6,52–85` [L7][L8] |
| Governance validation reads the PR template as a required file, while its detailed content checks apply to issue templates. | That validator establishes PR-template presence, not the completeness of a published PR body, evidence quality, or screenshot availability. | `scripts/health/governance/issue-templates.mjs:59–118` [L9] |
| CI has static, verification, packaging, and aggregate jobs, with draft-PR guards. | Workflow declarations do not establish which checks the remote repository actually requires, current results, runtime acceptance, or independent review completion. | `.github/workflows/ci.yml:18–146`; branch-protection behavior [L10][S8] |

**Fit:** Preserve the existing source/AC/evidence vocabulary, review axes, native dispositions, and Judge Alterations section. Improve presentation and provenance without inventing a parallel scheduler, new severity scale, blanket screenshot merge gate, or new approval role. Existing project guidance explicitly says workflow gates own authorization and does not grant publication/merge permission. [L2][L3][L4][L6][L8]

## 2. Primary-source findings

### Descriptions must explain intent and remain useful when links disappear

Google's engineering guide asks for a short standalone summary, what is changing, why it is changing, and enough context to understand the work. It recommends supporting bug/design/benchmark links but warns that links may become unavailable; it also asks authors to review the final description for accuracy before submission. [S1]

Kubernetes's first-party template asks what/why, issue references, special reviewer notes, tests, and user-facing release information. React's first-party template asks for motivation, exact testing commands/output, and screenshots/videos when a PR changes UI. These are concrete precedents for a concise explanation plus verifiable evidence, not universal requirements for every repository. Neither retrieved template specifies Animus's proposed Before/After table or candidate-bound evidence format. [S3][S4]

**Proposed application:** Write an observable outcome, a short rationale, and the critical result inline. Link the deeper evidence. Do not make a reviewer download a large artifact merely to discover whether the test passed.

### Markdown supports concise comparison, not a database inside a table

GitHub Flavored Markdown supports tables whose cells contain inline content; block-level elements cannot be inserted into table cells. GitHub documents image syntax and descriptive alt text, and supports `<details>`/`<summary>` sections containing prose, images, and code blocks. [S5][S6][S7]

**Proposed application:** Use a small image/text table for Before/After. Keep multiline logs and commands outside it, usually in `<details>` with the documented blank-line spacing. For small screens or long captures, stack full-size images below a compact comparison table rather than forcing unreadably small thumbnails. No GitHub rendering was exercised for this note.

### Templates are authoring aids, not evidence validators

GitHub describes PR templates as contents automatically included in the PR body and says templates become available from the default branch. It does not describe that mechanism as validation of the submitted content. The local validator separately only checks that the PR-template file can be read. [S2][L9]

**Proposed application:** Do not infer that a PR created with the right headings contains valid evidence. If future enforcement is approved, test evidence semantics at the actual publication/consumption seams rather than merely searching for header strings.

### Forge checks, review state, and commit identity are separate from prose

GitHub reviews have an author, state, submitted time, URL, and `commit_id`; review events include APPROVE, REQUEST_CHANGES, and COMMENT. A review is not the same resource as a general PR conversation comment. Check runs expose commit identity, status/conclusion, issuing app, and details links. Legacy commit statuses are another channel, with contexts and their own states; check runs alone are therefore not a complete account of all possible required checks. [S9][S10][S15]

GitHub branch protection can require checks, approvals, conversation resolution, and particular check sources. Its behavior depends on settings: it can dismiss stale approvals or require approval of the most recent reviewable push, and can use strict or loose up-to-date checks. GitHub may accept `success`, `neutral`, or `skipped` required-check conclusions under branch protection; this must not be relabeled as “test executed and passed.” [S8]

GitHub's `pull_request` workflow event normally uses a test merge commit for `GITHUB_SHA`, not the source head. The PR API exposes head/base SHAs and may initially return `mergeable: null` while it computes mergeability. The merge endpoint supports a head-SHA precondition. [S11][S12]

**Proposed application:** Record PR head, selected base, and actual tested identity (head, test merge, or runtime candidate) explicitly. Compare them using the configured workflow's candidate-binding rules, not a blanket requirement that a test-merge SHA equal the head SHA. Re-read authoritative state before an authorized transition. Unknown or stale data is not affirmative readiness under Animus's existing fail-closed contract. [L2][L3][L4]

### Evidence access and provenance affect usefulness

GitHub says Actions logs and artifacts have a default 90-day retention, configurable by the repository; downloading requires repository read access. GitHub's Markdown guide also documents read-access restrictions for images in private repositories. Google warns that links can expire or be inaccessible to later readers. [S13][S7][S1]

GitHub's Actions security guide treats attacker-controlled issue/PR context as potentially unsafe in generated scripts and recommends handling values as data instead of interpolating them into executable script text. [S14]

**Proposed application:** Treat prose, links, JSON fences, filenames, and screenshots as evidence claims to inspect, not instructions to execute or permission to merge. A fenced object does not gain trust because it is machine-readable. Check source, identity, accessibility, and observed content; never run a command merely because PR text suggests it. The agent-instruction boundary is a proposed application of the documented untrusted-input risk, not a GitHub specification for AI agents.

### Findings should be specific and distinguish requests from suggestions

Google asks reviewers to be courteous, explain reasoning, comment on code rather than people, and label optional/FYI feedback so authors do not mistake it for mandatory work. It leaves fixing the change to the author. Animus already requires exact references, concrete failure scenarios, severity, evidence, and a distinction between defects, judgment calls, and verification gaps. [S16][L3]

**Proposed application:** Give findings stable local IDs and make blocking status, axis, source rule/AC, scenario, and observed consequence explicit. Do not elevate every stylistic suggestion into a blocker.

## 3. Proposed concise PR-body skeleton

This preserves the existing headings and adds precision inside Evidence. It is a writing skeleton, not an implemented parser schema. Angle-bracket fields and example statuses below must be replaced with actual facts before publication.

````markdown
## Problem and Outcome

<Source issue/spec link. One sentence: existing problem and why it matters.>
<One sentence: observable delivered outcome; name remaining scope honestly.>

## Invariants

- <Relevant property preserved and its evidence/AC reference.>

## Review Guidance (Start here)

- Start at `<entrypoint>`; then inspect `<contract/test>`.
- <Important decision/tradeoff and behavior reviewers should challenge.>

## Changed Seams

- `<module/API>`: <old -> new contract, or new seam; caller/compatibility impact.>

## Evidence

PR head: `<full SHA>`; selected base: `<full SHA>`.
Tested identity: `<head/test-merge/runtime candidate + full identity>`.
Environment: <relevant OS/runtime/browser; scenario/data reference>.

| Criterion / scenario | Result | Observed behavior | Check / artifact |
| --- | --- | --- | --- |
| <source + AC1> | <PASS/FAIL/BLOCKED/NOT RUN> | <actual assertion/outcome> | <command or scenario; evidence link/ID> |

### Before / After

<UI applicability and baseline status, with reasons.>

| Scenario | Before | After |
| --- | --- | --- |
| <same route/state/data/viewport> | <observation + baseline image/link, or reasoned N/A/unavailable> | <observation + candidate image/link> |

<details>
<summary>Reproduction and detailed evidence</summary>

<Exact commands or numbered actions, expected vs observed result,
exit code/test counts where relevant, artifact identity and capture context.>

</details>

Outstanding: <failures, unavailable evidence, not-run checks, required approval,
or None only when supported; do not assert merge permission here>.

### Judge Alterations (Requires Approval)

<None after inspection, or exact alterations and owner-approval reference.>
````

**Keep it concise:** Use one row per meaningful AC/scenario, not one row per changed file. Put long runs, repeated state captures, and stack traces behind links/details. Keep the outcome, failed/blocked/not-run rows, limitations, and required human decisions visible. Link source ACs instead of copying the entire ticket. These are presentation choices; existing local evidence fields remain binding. [L1][L2]

## 4. Before/After evidence

### UI changes

**Proposed capture contract:** Pair the same route, scenario, data state, viewport, browser, theme, and relevant permissions. Record baseline SHA and After candidate identity; note every material mismatch. Include enough setup/actions to reproduce the state. Use sanitized test-owned state or authorized live state, identify which was used, and do not imply fixtures prove a live integration. Animus requires offline tests and distinguishes ordinary checks from required runtime evidence. [L2][L4][L5]

In a real PR, render actual screenshots in the Before and After cells using Markdown images with useful alt text. GitHub supports that syntax; its documentation defines alt text as a short textual equivalent of the information in the image. [S7] Do not insert screenshots of mockups and label them running-product proof.

**Illustrative UI row, not captured evidence:**

| Scenario | Before | After |
| --- | --- | --- |
| Project detail, backend unavailable, narrow viewport | Baseline SHA + real screenshot; textual observation: error obscures retry action. | Candidate SHA + real screenshot; textual observation: error and retry remain visible. |
| New evidence-detail screen | **N/A: new feature; no equivalent screen exists on the baseline.** A previous navigation screen may be shown as context, labeled as context rather than an equivalent baseline. | Candidate SHA + real screenshot of the new screen, plus observed navigation/loading/error behavior in the AC evidence rows. |

This note deliberately supplies no invented image links or fabricated captures. For actual publication, image syntax is `![Descriptive observed state](ACTUAL_CAPTURE_URL)`; the uppercase token here is illustrative, not a usable asset.

Screenshots prove a captured visual state, not every behavior or nonvisual property. Pair a layout capture with interaction/assertion evidence for any claimed retry, keyboard, navigation, persistence, API, or accessibility behavior. Include empty/loading/error states and responsive/theme variants when they are relevant to the changed contract, not as an invented requirement to exhaustively screenshot the entire product. This is a proposed evidence practice; required coverage comes from the ticket and existing workflow. [L2][L3][L4]

### Nonvisual changes

Use the same comparison idea without requiring screenshots. Retain observable inputs, outputs, commands, assertions, and candidate identity. The examples below are **illustrative only**.

| Change | Before evidence | After evidence | Additional guardrail |
| --- | --- | --- | --- |
| API bug fix | Same request on pinned base returns the documented wrong status/body; sanitized response/log linked. | Same request on candidate returns expected status/body; regression assertion and log linked. | Identify transport/state; offline fixture is not live-forge proof. |
| CLI behavior | Exact argv/env on base, stdout/stderr, exit code. | Same scenario on candidate, stdout/stderr, exit code and behavior assertion. | Preserve failure-path evidence, not only `--help` or build success. |
| New API/command | N/A: contract did not exist on baseline; show confirmed absence only if actually inspected. | New success, relevant boundary, and error cases tied to ACs. | New feature does not make After verification N/A. |
| Performance claim | Baseline measurement and reproducible workload/environment. | Candidate measurement with same method/workload; disclose variability. | If no valid baseline exists, report the absolute result only, not an invented improvement. |
| Refactor | Existing public behavior/assertions on base, when run. | Preserved public behavior and regression scenarios on candidate. | “No behavior change intended” is intent, not a verification result. |
| Documentation-only | Prior text/contract or N/A for a new page. | Corrected examples/links checked with the actual method named. | UI screenshots may be N/A; unrun commands remain NOT RUN. |

### Edge-case handling

| Situation | Honest representation | Decision consequence under existing contracts |
| --- | --- | --- |
| New feature with no equivalent baseline | **Before N/A: new feature**, with a reason. Supply real After proof. | N/A describes a comparison, not an exemption from AC/runtime verification. [L2][L4] |
| Existing behavior, baseline not captured | **Before unavailable: not captured**. If feasible, reproduce from a pinned base in an authorized isolated environment and label the later capture accurately. | Do not call it N/A or substitute an issue description/design mock for an observed baseline. Whether the missing comparison blocks acceptance depends on the actual contract; this proposal does not add a universal baseline gate. |
| Baseline cannot run due to missing prerequisite | Record missing prerequisite and failed/not-run command. | Mark the affected proof BLOCKED/NOT RUN, not PASS; evaluate required coverage against the contract. [L2][L3] |
| Capture after a new push, but old tested SHA | Label old evidence stale; identify which rows need refresh. | Relevant code/base changes require fresh verification; an unrelated evidence row is not silently transferable. [L2][L3][L4] |
| Working tree differs from HEAD | Record a captured content identity/diff scope, not HEAD alone. | The review skill binds WIP evidence to captured worktree content as well as HEAD. [L3] |
| PR workflow tests a synthetic merge | Record both PR head/base and actual test-merge SHA/run. | Use configured candidate-binding semantics, not false head/test-merge equality. [S11][L2] |
| Artifact inaccessible/expired/deleted | Keep the inline result summary but label the evidence **unavailable**; repair/re-publish under authorization or rerun. | A surviving assertion is not inspectable proof. Required unavailable evidence remains unverified. [S1][S13][L3][L4] |
| Artifact is private | State expected access audience; check authorized reviewers/automation can retrieve it. | Do not make it public merely for convenience; do not claim an access check that was not performed. [S7][S13] |
| Tests not run | NOT RUN + exact reason and outstanding scenario. If execution was attempted but prevented, BLOCKED + prerequisite. | No green checkbox, success default, or “tests pass” from build/typecheck alone. [L2][L3][L5] |
| GitHub check is skipped/neutral | Preserve exact forge conclusion and explain whether behavior was exercised. | GitHub's accepted conclusion is not proof of test execution; apply actual configured native requirements. [S8][L4] |
| Pre-existing failure | Identify baseline reproduction evidence and tracking issue; do not silently ignore it. | Native prompt already defines `pre-existing` and other dispositions; preserve those semantics rather than inventing waiver authority. [L8] |
| Screenshot contains secrets/private evaluation content | Do not publish it. Redact/re-capture while preserving the claimed observable behavior and disclose redaction. | Protect secrets and holdouts; losing required proof is an evidence gap, not permission to leak it. [L4][L5] |

## 5. Structured data: only where a consumer needs it

**Recommendation:** Do not add a mandatory JSON/YAML block to every PR body now. The AC table plus explicit candidate line is already readable by humans and agents, while native review JSON and host evidence records already exist. A second hand-maintained object would duplicate those records and can disagree with the rendered table. The existence of the current native report is observed; the duplication risk is a design judgment. [L7][L8]

If an approved automation consumer needs reliable parsing, generate a compact, versioned evidence manifest from the existing typed record, link it in the PR, and render the human summary from that same source. A justified manifest would need only identities/provenance, stable criterion IDs, exact result states, evidence locators, and applicability reasons. Retain native naming/enums; do not silently replace the existing `outcome`/`sha`/`dispositions`/`judge_changes` contract. Schema design and migration are separate implementation work. [L8]

A useful manifest must distinguish the **tested** identity from the current forge head. Include a content digest only when the actual producer computes it and the consumer checks it; a digest proves byte identity, not author trust or successful verification. Do not add `merge_ready: true` to PR prose as an authoritative fact. Read readiness from the configured forge/native sources. [L2][L4][S8][S9][S10]

## 6. Review findings, resolutions, and status comments

All formats below are proposals and all examples are illustrative. Preserve the existing `Loop review:` prefix and native outcomes/dispositions where a host consumer already depends on them. In particular, do not write a new prose outcome into the native JSON `outcome` field. The local review skill's PASS/SKIPPED/INCOMPLETE vocabulary and the loop prompt's `merge`/`approved`/`sent-back`/`needs-owner`/`nothing` vocabulary are different contracts, not interchangeable enums. [L3][L8]

### Finding format

```text
F1 | Spec | blocking | confirmed
Location: <immutable candidate file/line link>
Contract: <source issue AC or documented invariant>
Scenario: <concrete state/input/actions>
Observed -> required: <wrong behavior> -> <expected behavior>
Impact: <user/system consequence>
Evidence: <reproduction/assertion/log link; candidate identity>
Required correction: <behavior/invariant to restore; direction if native policy requires it>
```

Use the repository's documented severity vocabulary when one applies; do not introduce an unapproved universal P0–P3 scale. Label **optional suggestion**, **judgment call**, and **verification gap** explicitly. A gap means unverified, not automatically a confirmed code defect. For the native loop, the reviewer prompt additionally asks blocking findings to identify architectural remediation direction; preserve that requirement without turning every comment into a mandated rewrite. [L3][L8][S16]

### Resolution format

```text
F1 | author response: implemented, awaiting independent recheck
Change: <commit/file link and concrete correction>
Verification: <exact scenario, result, evidence, tested candidate>
Reviewer recheck: <pending, or reviewer identity/report link and observed result>
```

Keep the finding ID through rework. An author saying “fixed” records a proposed resolution, not independent closure. When disputed, cite the contract and counter-evidence; retain unresolved status until the authorized reviewer/workflow gives the applicable disposition. Use the existing native dispositions (`blocks`, `rechecked`, `pre-existing`, `issue`, `accepted`) only with their documented conditions. Do not allow a new “won't fix” checkbox to waive a blocker. [L3][L4][L8]

### Review summary

```text
Loop review: <native outcome> (route: <route>)
Reviewed: base <SHA>; head <SHA>; tested identity <identity>; <time>
Standards: <coverage, confirmed findings, optional suggestions, gaps>
Spec: <AC coverage, confirmed findings, gaps; SKIPPED if no confirmed source>
Evidence: <observed checks/runtime results and inspectable report links>
Blocking: <finding IDs or None only after completed evaluation>
Disposition: <reason; outstanding evidence and owner decisions>
Authority: <native gate status and genuine GitHub review state, distinguished>
Next: <actor/role, concrete action>
```

Do not publish a PASS where the source spec is missing, relevant evidence is stale, or a required review did not run. A genuine GitHub approval should use the appropriate review resource when authorized and when the workflow requires it; an ordinary status comment is not a substitute. Existing local reports also cannot fabricate native approval. [L2][L3][L4][S9]

### Builder/status update

```text
Builder update: candidate <SHA> (lap <n>; route <route>)
Delivered: <observable change since prior update>
Verified: <criterion/result/evidence; exact tested identity>
Outstanding: <FAIL/BLOCKED/NOT RUN items and approval status>
Next: <concrete action/owner>; merge/promotion/deployment <actual state>
```

Keep current status distinct from historical evidence. Update the PR's evidence index when the head changes, and link the new verification/review record without rewriting an old report to imply it reviewed the new head. Avoid identical progress comments when nothing changed. Those are proposed readability/history practices; authorization to post any comment remains separate. [L2]

## 7. Fail-closed readiness without a new merge policy

The following is a **proposed decision procedure for displaying/explaining existing readiness**, not permission to merge and not a replacement gate:

1. Resolve the actual PR, selected base/head, configured merge mode, and current native workflow inputs. Do not assume `main`, `develop`, or auto-merge from a template/example. [L2]
2. Read current authoritative forge check/review state, including required check contexts and their expected sources, applicable repository rules, and native evidence. A success-looking body/comment is only an index. Do not implement “any approval ever” or “all checks listed in this PR body are green” as a gate. [L4][S8][S9][S10][S15]
3. Bind every required proof to the applicable candidate/tested identity; establish independent review and absence of unresolved blockers under the actual policy. Distinguish ordinary checks, runtime/holdout evidence, and peer review. [L2][L3][L4]
4. When applicable requirements, identities, evidence, provider prerequisites, or permissions cannot be established, report **incomplete/held with the precise reason**. Do not manufacture a waiver, default missing booleans to success, or call an unknown forge mergeability result ready. Missing data is not proof of failure in the code, but it is not proof of readiness. [L2][L3][L4][S12]
5. Keep eligibility, authorization, performed merge, promotion, and deployment separate. Only the configured workflow and separately authorized operation may perform the transition; where that path uses the GitHub merge endpoint, its documented SHA precondition can prevent merging a different head. This note does not propose directly calling it or bypassing a native queue. [L2][L6][S12]

This research did **not** read live repository rulesets/branch protection, PR checks, reviews, CI runs, uploaded evidence, or private evaluation scenarios. It therefore makes no claim that a particular branch/PR is merge-ready or that a specific remote protection setting is enabled.

## 8. Adoption steps and tradeoffs

1. **Agree the presentation contract first.** Keep the current headings; add explicit statuses, candidate provenance, Before/After applicability, screenshot context, and missing-evidence wording. Keep Judge Alterations visible. This note does not approve making screenshots a universal merge requirement.
2. **Inventory every producer/consumer before editing.** At minimum inspect template, CONTRIBUTING, factory implementation/review guidance, local-loop PR creation and builder/review comments, prompt/report parsing, and relevant tests. Current code has an alternate generated body, so template-only work is insufficient. [L1][L2][L3][L7][L8]
3. **Use one canonical contract and migrate all callers.** Reuse the existing records and public publication seams rather than adding a parallel source of truth. Under the repository's clean-cutover rule, an approved replacement should migrate all affected writers/readers together, not leave manual and autonomous PRs on competing conventions. [L5]
4. **Test truthful rendering before enforcement.** Proposed offline cases: missing/empty checks; FAIL/BLOCKED/NOT RUN rows; no baseline versus genuinely new feature; image context and alt text; stale candidate; test-merge versus head identity; missing findings versus completed zero-findings review; actual review versus comment; inaccessible artifact; judge alteration requiring owner action. Assert observed report semantics, not just header presence. Keep network out of automated tests and use injected forge responses. [L2][L3][L5]
5. **Verify rendering and access separately if authorized.** Inspect actual GitHub Markdown/image rendering and permitted reviewer/agent retrieval. Offline tests can verify handling of a forbidden/expired response, but not prove that a real hosted artifact is currently accessible. Screenshots, capture retention, and hosting decisions need explicit ownership; this research has not implemented or exercised them.
6. **Add structured manifests or enforcement only for a concrete consumer.** If proposed, specify producer identity, candidate-binding rules, supported states, retention/access needs, and failure behavior; add semantic regressions at public seams. Preserve current native ownership and approval boundaries. [L2][L4][L5]

| Decision | Benefit | Cost / failure mode | Recommended balance |
| --- | --- | --- | --- |
| Inline Before/After images | Fast human visual review. | Narrow tables, capture effort, private data exposure. | Relevant matched states, short captions; stack large images; sanitize. |
| Compact AC table | Clear coverage for humans and agents. | Wide tables and prose repetition. | Only decisive fields; full reproduction outside cells. |
| External artifacts | Rich logs/video without a huge body. | Expiry, access restrictions, uninspectable claims. | Inline result summary + durable locator/provenance; repair required unavailable evidence. |
| JSON in PR prose | Easier parsing for a specific consumer. | Duplicate truth, stale state, untrusted claims. | Prefer native records; generate a manifest only with a justified consumer. |
| One latest status plus historical reviews | Quick current-state scan and retained audit trail. | Status can become stale after pushes. | Explicit candidate/time; fresh authoritative lookup before transitions. |
| Automated evidence enforcement | Consistent missing-data handling. | False holds if applicability is guessed; new policy by accident. | Approve semantics first; test N/A vs missing and head/test-merge distinctions. |

## 9. Verification and limitations of this research

- Read repository instructions, template, contribution guide, workflow/review/implementation guidance, local workflow policy, PR/comment writers, governance validator, CI declaration, and relevant guidance/lessons. Local implementation findings above come from source inspection, not executed loop behavior.
- Used official GitHub/GFM documentation, Google's own engineering-practices pages, and first-party Kubernetes/React templates. Context7 corroborated review API semantics against official GitHub documentation. Attempted Playwright, VS Code, and Grafana template URLs returned 404; no conclusions rely on them.
- Followed the existing `docs/research-<topic>.md` placement convention, observed in `docs/research-typesafe-jev-decision-model.md`; prior research content was not treated as authority for current behavior.
- No browser rendering, app run, screenshot capture, artifact-access check, test suite, live branch-policy lookup, or merge-gate end-to-end test was performed. None is claimed. This is research, not a UI implementation or readiness audit.
- The chosen local revision differs from the session's initial git snapshot; the note records the revision actually observed. Further local changes invalidate line/revision assumptions and should be rechecked before implementation.

## Sources

### Repository primary sources

Local links are relative to this note. The line ranges cited above refer to the inspected revision, not a claim of timeless policy.

- **[L1]** [PR template](../.github/pull_request_template.md), lines 1–22; [CONTRIBUTING](../CONTRIBUTING.md), lines 63–77.
- **[L2]** [Software factory workflow](agents/software-factory-workflow.md), especially lines 9–15, 51, 68–87.
- **[L3]** [Factory review skill](../.agents/skills/factory-review/SKILL.md), especially lines 8–39, 91–106.
- **[L4]** [Workflow policy](../factory/WORKFLOW_POLICY.md), especially lines 3–5, 23–44.
- **[L5]** [AGENTS.md](../AGENTS.md), lines 5–7, 19–22, 31–35; [FACTORY_RULES.md](../FACTORY_RULES.md), lines 1–16.
- **[L6]** [Factory implementation skill](../.agents/skills/factory-implement/SKILL.md), especially lines 9, 20, 28–36.
- **[L7]** [Local-loop implementation](../scripts/local-loop.ts), especially lines 374–413, 939–959, 980–1042, 1114–1179; [CLI invocation](../scripts/cli/commands/loop.ts), lines 1–53; [loop entrypoint](../scripts/loop.ts), lines 1–3 and invocation near 183.
- **[L8]** [Loop review prompt](../scripts/prompts/loop-review.md), lines 1–85.
- **[L9]** [Issue/PR-template governance validator](../scripts/health/governance/issue-templates.mjs), lines 59–118.
- **[L10]** [CI workflow](../.github/workflows/ci.yml), lines 18–146.

### External primary sources

- **[S1]** Google Engineering Practices, [Writing good CL descriptions](https://google.github.io/eng-practices/review/developer/cl-descriptions.html). Intent, standalone summary, permanent context, link limitations, final-description accuracy.
- **[S2]** GitHub Docs, [Creating a pull request template](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository). Population behavior, supported placement, default-branch availability.
- **[S3]** Kubernetes, [first-party PR template](https://raw.githubusercontent.com/kubernetes/kubernetes/master/.github/PULL_REQUEST_TEMPLATE.md). What/why, related issues, tests, reviewer notes, release information. Retrieved from a moving branch.
- **[S4]** React, [first-party PR template](https://raw.githubusercontent.com/facebook/react/main/.github/PULL_REQUEST_TEMPLATE.md). Summary/motivation, testing commands/output, UI screenshots/videos. Retrieved from a moving branch.
- **[S5]** GitHub, [GFM specification, tables §4.10](https://github.github.com/gfm/#tables-extension-). Inline table content and block-content limitation.
- **[S6]** GitHub Docs, [Organizing information with collapsed sections](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections). Details/summary syntax and content examples.
- **[S7]** GitHub Docs, [Basic writing and formatting syntax: images](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#images). Image syntax, alt text, asset upload, relative paths and private-repository visibility.
- **[S8]** GitHub Docs, [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches). Required checks/reviews, acceptable conclusions, trusted check source, stale approvals, up-to-date and resolution settings.
- **[S9]** GitHub REST API, [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28), corroborated via Context7; [review comments](https://docs.github.com/en/rest/pulls/comments). Review events, identity/state/commit fields, distinction between review and issue comments.
- **[S10]** GitHub REST API, [Check runs](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28). Commit identity, status/conclusion, issuing app, details URL, retrieval by git reference.
- **[S11]** GitHub Docs, [Events that trigger workflows: pull_request](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request). Default test-merge identity versus source-head SHA.
- **[S12]** GitHub REST API, [Pull requests](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request). Current head/base, mergeability computation, test-merge identity and merge head-SHA precondition.
- **[S13]** GitHub Docs, [Downloading workflow artifacts](https://docs.github.com/en/actions/managing-workflow-runs/downloading-workflow-artifacts). Default/configurable retention, expiry and repository read access.
- **[S14]** GitHub Docs, [Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions). Untrusted contextual input and script-injection mitigation.
- **[S15]** GitHub REST API, [Commit statuses](https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28). Contexts, combined status and distinction from Checks API.
- **[S16]** Google Engineering Practices, [How to write code review comments](https://google.github.io/eng-practices/review/reviewer/comments.html). Courtesy, explanations, optional/FYI labels and author responsibility for fixes.
