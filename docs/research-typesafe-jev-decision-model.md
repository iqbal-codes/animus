# Research: TypeSafe Jev Decision Model & Its Application to the Software Factory

* **Date:** 2026-10-27
* **Topic:** Evaluation of the TypeSafe Jev architecture (System 1 Typed Decision Engine) for automation and *self-improvement* in the Software Factory.
* **Status:** Final Research Report

---

## 1. Executive Summary: What Is TypeSafe Jev?

**TypeSafe Jev** is a *non-autoregressive typed decision engine* (often categorized as a **System 1** engine for AI agents). Unlike generative language models (*autoregressive* LLMs such as Claude, GPT, or Pi) that predict tokens word by word to produce free-form text, Jev is designed solely to evaluate *state* and produce structured, typed decisions with *calibrated confidence* in **a single forward pass** in under a second (~200–300 ms).

Open Jev research and reproductions (such as [open-jev-typed-decision-engine](https://github.com/intikhab49/open-jev-typed-decision-engine), [Verdict-open-jev](https://github.com/Heman10x-NGU/Verdict-open-jev), and [jev-pilot](https://github.com/h0j5bz0adh0-stack/jev-pilot)) show a *bidirectional encoder*-based architecture (~150M parameters, such as ModernBERT) that receives *context state* together with question markers `<<q>>` and label markers `<<l>>`, then projects them through a linear classification head with *softmax* normalization and a *Brier penalty*.

### Three Decision Primitives
1. **`noul` (Boolean / Binary Gate)**:
   A binary yes/no decision (`true`/`false`) based on evaluating strict criteria against the context. Includes a confidence score (0.00 – 1.00).
2. **`choice` (Categorical / Discrete Enum)**:
   Selection of one option from a dictionary of discrete labels (`label -> criteria description`). Produces a full probability distribution across all options (e.g. determining a workflow route or winning strategy).
3. **`score` (Ordinal / Scaled Evaluation)**:
   Graded evaluation on an ordered scale (e.g. risk level 1–5, defect severity minor/major/blocker).

### Key Characteristics
* **Zero Prose / No Hallucination**: Jev does not generate free-form explanatory text; its output is purely typed structs/JSON.
* **Calibrated Confidence**: Confidence scores reflect mathematical accuracy (rather than merely the false confidence of generative LLMs).
* **Extremely Low Latency & Cost**: Runs in ~25–300ms with very small VRAM/token consumption compared with calling a large reasoning model just to make a classification decision.

---

## 2. Gaps in the Current Software Factory

Based on an analysis of our factory architecture (`labq-software-factory`, `factory/consumer.py`, and `app.py`):
1. **Intake Triage Is Too Slow or Too Permissive**:
   * Currently, the *workability gate* uses simple string rules (the `Depends on` regex), or requires calling a full reasoning LLM just to check whether a ticket has clear acceptance criteria.
2. **Selecting Probing Winners (Harness² Task-Level)**:
   * When implementing the Harness² *Propose-Probe-Compose* cycle, evaluating strategy candidates with generative LLMs is susceptible to *positional bias* and consumes many tokens.
3. **Safety Brake & Stale-Loop Detection**:
   * Distinguishing an agent that is "thinking hard to solve a complex problem" from "an agent stuck in an infinite retry loop" requires fast classification of execution traces without adding latency overhead.
4. **`develop` Auto-Merge Authorization**:
   * Deciding whether a PR is safe to merge automatically requires a deterministic binary evaluation of the diff and test results, without divergent free-form interpretation.

---

## 3. Use Cases Well Suited to Our Software Factory

The following 5 use cases offer the highest ROI for adopting TypeSafe Jev into the Software Factory ecosystem:

### Case 1: Issue Readiness & Scope Gatekeeper (Intake Triage)
* **Jev Primitives:** `noul` + `score`
* **How It Works:**
  When a new issue is created or before it enters the lap queue, Jev evaluates its description against the factory's readiness criteria:
  ```json
  Question: noul(
    target="is_ready_for_agent",
    criteria="The issue has objectively verifiable acceptance criteria and a clear, unambiguous code scope."
  )
  Question: score(
    target="scope_complexity",
    levels=["trivial", "single_file", "multi_file_feature", "architectural_refactor", "epic_needs_breakdown"]
  )
  ```
* **Benefit:** Unready tickets are immediately labeled `needs-info` in milliseconds before wasting Archon/Pi lap execution quota.

### Case 2: Candidate Arbitration in Harness² Probing (Task-Level Recursion)
* **Jev Primitive:** `choice`
* **How It Works:**
  When a lap fails verification and runs *targeted probes* (e.g. comparing 2 alternative diff/patch fixes):
  ```json
  Question: choice(
    target="best_remediation_candidate",
    options={
      "patch_a": "Fixes the bug without adding new dependencies and passes the entire regression suite.",
      "patch_b": "Adds a wrapper layer that changes the module's public signature.",
      "reject_both": "Both patches introduce harmful side effects."
    }
  )
  ```
* **Benefit:** Objective, sub-second arbitration unaffected by text order (*option-order invariant*) selects the best patch before proceeding to *Compose*.

### Case 3: Loop Detection & Circuit Breaker (Runtime Safety)
* **Jev Primitives:** `noul` + `choice`
* **How It Works:**
  In `factory/consumer.py`, monitor the last 5 shell commands and the lap's error history.
  ```json
  Question: noul(
    target="is_execution_stuck",
    criteria="The log shows the agent repeating the same command with identical parameters and receiving the same error repeatedly."
  )
  Question: choice(
    target="brake_action",
    options={
      "continue": "The agent is making concrete progress (editing new files or reducing errors).",
      "intervene_hint": "Inject an error-correction instruction.",
      "pause_lap": "Stop the lap and mark its status needs-owner."
    }
  )
  ```
* **Benefit:** Automatically stops *token burning* when the looping agent's logic degrades, before exceeding the large timeout limit.

### Case 4: Dynamic Merge Authority Gate (`develop` Auto-Merge)
* **Jev Primitive:** `noul`
* **How It Works:**
  As an absolute prerequisite before executing an automatic merge into the `develop` branch:
  ```json
  Question: noul(
    target="authorized_for_auto_merge",
    criteria="The PR diff touches only files within the ticket's scope, the entire test suite is green, there are no security/linter bypasses, and the target branch is develop."
  )
  ```
* **Benefit:** Provides a deterministic *zero-trust* verification layer before code enters the shared integration branch.

### Case 5: Curation & Pruning of Learned Lessons (Harnessing-Level)
* **Jev Primitives:** `score` + `noul`
* **How It Works:**
  When *Post-Lap Reflexion* drafts a new lesson for inclusion in `.factory/lessons.jsonl`:
  ```json
  Question: noul(
    target="is_lesson_valid_and_non_trivial",
    criteria="The lesson records a repeatable repository-specific technical fact, not merely a general summary or hallucination."
  )
  Question: score(
    target="hallucination_risk",
    levels=["grounded_in_logs", "plausible_inference", "unsupported_claim"]
  )
  ```
* **Benefit:** Filters out "junk" rules or "prompt bloat" to keep `.factory/` memory clean and high-quality.

---

## 4. Architectural Pattern: Dual-System (System 1 + System 2)

The most robust combination for the Software Factory is to separate the roles explicitly:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   SOFTWARE FACTORY OPERATING SYSTEM                    │
│                                                                        │
│   [ SYSTEM 1: TypeSafe Jev ]            [ SYSTEM 2: Archon + Pi/Claude]│
│   - Sub-300ms Latency                   - Deep Reasoning               │
│   - Non-autoregressive (Encoder)        - Autoregressive Generation    │
│   - Pure Typed Decisions                - Code Writing & Architecture  │
│   - Deterministic Gates & Routing       - Complex Refactoring & Design │
│   ─────────────────────────────         ────────────────────────────── │
│   * Intake Filter (Ready/Hold)          * Feature Implementation       │
│   * Worktree Arbitration (Probing)      * Bug Diagnosis & Fix          │
│   * Loop Detection & Safe Brake         * Post-Mortem Deep Reflection  │
│   * Merge Gatekeeper                    * Synthesis of New Skills      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Primary Sources & References

1. **Jev Architecture & Specifications:**
   * [intikhab49/open-jev-typed-decision-engine](https://github.com/intikhab49/open-jev-typed-decision-engine) — Open reproduction of TypeSafe Jev, encoder design, `<<q>>`/`<<l>>` token serialization, Brier penalty loss.
   * [Heman10x-NGU/Verdict-open-jev](https://github.com/Heman10x-NGU/Verdict-open-jev) — Non-autoregressive ModernBERT decision engine with calibrated uncertainty (RLCD).
2. **Autonomous Agent Applications:**
   * [h0j5bz0adh0-stack/jev-pilot](https://github.com/h0j5bz0adh0-stack/jev-pilot) — Fast System-1 Decision, Arbitration & Safety Engine for Autonomous AI Agents.
   * [sergio-lim/ai-decision-engine](https://github.com/sergio-lim/ai-decision-engine) — Typed AI decisions, confidence-gated routing.
   * [zhangcy122/OpenJev](https://github.com/zhangcy122/OpenJev) — Deliberative decision flywheel (System 2 ➔ System 1).
3. **Local Repository Context:**
   * `docs/current-factory-analysis.md` & `factory/consumer.py` — Delivery loop lifecycle, claim logic, and merge gating.
