# Spec & Implementation Plan: Post-Loop Self-Improving Harness (Harness² Adaptation)

* **Status:** Ready for Implementation
* **Date:** 2026-10-29
* **Reference Architecture:** [Google Research Harness²](https://github.com/google-research/harness2) (arXiv:2610.14224), TypeSafe Jev System 1 (`typesafe/jev-1.14`), Pi Coding Agent Extensions & Skills
* **Target Subsystems:** `scripts/local-loop.ts`, `scripts/loop/providers.ts`, `scripts/loop/config.ts`, `scripts/loop/types.ts`, `scripts/loop/scheduler.ts`, `.archon/config.yaml`, `.factory/`, `.agents/skills/`, `apps/backend/src/main.ts`

---

## 1. Executive Summary & Problem Statement

An audit of the `labq-software-factory` repository shows that the current **Post-Loop Self-Learning Harness** mechanism consists only of document specifications, passive schemas (`.factory/lessons.jsonl`), and UI mockups (`web/app.js`), but **does not yet run automatically within the execution loop**.

### 5 Existing Gaps Identified:
1. **No Reflection Trigger in `scripts/local-loop.ts`**: The lap cycle simply stops after review (`waiting_approval` or `sent_back`) or on failure (`failed`), without extracting lessons from the failures that occurred.
2. **Blind Isolation (`--no-skills` & `--no-context-files`)**: The `pi` CLI invocation arguments in `scripts/loop/providers.ts` (`buildProviderArgv`) disable *all* skills and context files to prevent host-machine pollution, but consequently also block the repository's official `.agents/skills/` and `.factory/lessons.jsonl`.
3. **Reactive vs Terminal Reflection**: There is no cross-lap trace collection mechanism (*Run Dossier*) yet. Reflection must not run prematurely mid-cycle (e.g. when Lap 0 fails); instead, traces must be collected and reflection executed at the **end of the issue cycle** (when *Approved* after revisions, or when reaching the maximum retry limit / *Needs Human Review*).
4. **No In-Loop Gatekeeper (Hooks) Yet**: New rules are written only as passive text that LLMs can easily ignore, without using *Pi Extension Hooks* (`-e`) that act directly within the *tool execution loop*.
5. **Phantom Backend Endpoints (404)**: The `web/app.js` UI calls `/api/harness/lessons`, `/api/harness/tools`, and `/api/harness/veto`, but these routes have not been implemented in `apps/backend/src/main.ts`.

---

## 2. Design Principles (Google Research Harness² Adaptation)

Adopt Google Research Harness²'s **Two-Level Recursion** approach, adapted to our factory architecture:

1. **Curated Hermetic Injection**:
   Keep `--no-skills`, `--no-context-files`, and `--no-extensions` so Pi sessions remain free of global host-machine files (`~/.agents/skills/`, `~/CLAUDE.md`), then explicitly inject **only** official repository skills (`--skill`), repository hooks (`-e`), and relevant lessons (`--append-system-prompt`).
2. **Contrastive Terminal Reflection (Not Reactive Per-Lap Reflection)**:
   High-quality lessons arise from **behavioral contrast** between failed Laps (Lap 0/1) and the Lap that successfully resolved the problem (Final Lap). Therefore, first collect the entire journey's logs into an **Issue Run Dossier**, and trigger reflection only once at a **terminal condition**.
3. **Dual-System Governance (System 2 Authoring + System 1 Gating)**:
   - **System 2 (Pi Agent)** analyzes the Dossier and drafts harness changes.
   - **System 1 (TypeSafe Jev)** deterministically validates (< 300ms) whether the lesson is specific, hallucination-free, and non-trivial (`confidence >= 0.70`).
4. **Component Hierarchy & Delivery Separation (Fast-Track vs Structural PR)**:
   - **Level 1 (`.factory/lessons.jsonl`) & Level 2 (`.factory/tool-guidance.json`)**: Commit directly to the active ticket PR branch (*Fast-Track*, without PR spam).
   - **Level 3 (`.agents/skills/<name>/SKILL.md`), Level 4 (`.factory/hooks/`), & Level 5 (`AGENTS.md`)**: Executed by Pi with guidance from the **`$writing-for-agents`** and **`$skill-creator`** skills, then submitted through a **separate Pull Request** (`chore(harness): ...`).

---

## 3. Workflow Architecture (Target Architecture)

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                   SELF-IMPROVING HARNESS PIPELINE                           │
│                                                                             │
│  [1. PRE-LAP: Curated Hermetic Injection] (scripts/loop/harness-memory.ts)  │
│  • --no-skills --no-context-files --no-extensions (Free of host context)    │
│  • --skill .agents/skills/<allowed> (Only official repository skills)      │
│  • -e .factory/hooks/loop-guard.ts (Pi Extension hook inside the tool loop) │
│  • --append-system-prompt (Active lessons matching target files)           │
│                                     │                                       │
│                                     ▼                                       │
│  [2. IN-LAP: Execution & Dossier Recording] (scripts/local-loop.ts)         │
│  • Laps 0..N work on the issue (Builder -> Checks -> QA -> Review)         │
│  • Record each attempt in `<stateRoot>/dossiers/issue-<num>.json`          │
│                                     │                                       │
│                                     ▼                                       │
│  [3. POST-ISSUE TERMINAL TRIGGER] (scripts/loop/reflector.ts)               │
│  • Run only when: Status == `waiting_approval` OR `needs_owner`            │
│  • Requires >= 1 friction/failure in earlier Laps (contrasting evidence)   │
│                                     │                                       │
│                                     ▼                                       │
│  [4. DUAL-SYSTEM REFLECTION & GOVERNANCE]                                   │
│  • System 2 (Pi + $writing-for-agents + $skill-creator): Draft changes      │
│  • System 1 (TypeSafe Jev): Validate non-triviality & confidence >= 0.70    │
│      ├── Level 1-2 (Lessons / Tool Guidance) ──> Commit directly to Issue PR│
│      └── Level 3-5 (New Skills / AGENTS.md) ──> Create Separate Harness PR │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Phased Implementation Plan

### Phase 1: Curated Hermetic Injection & Pi Loop Hooks

#### 1.1. Create `scripts/loop/harness-memory.ts` & Update `scripts/loop/types.ts` + `scripts/loop/config.ts`
1. Add `"reflector"` to the `LoopRole` union type in `scripts/loop/types.ts`.
2. In `scripts/loop/config.ts`, map the `"reflector"` role to the `"large"` tier (or the `@reasoning` alias in `.archon/config.yaml`, i.e. `router/cx/gpt-6.1-sol` with `effort: high`) to give trajectory contrast analysis and skill authoring the highest reasoning power.
3. Prepare selective context injection in `scripts/loop/harness-memory.ts` before running the provider:
- **`resolveAllowedSkills(root: string, role: LoopRole): string[]`**:
  - Return a list of absolute paths to repository-owned `.agents/skills/*` by role:
    - `builder`: `tdd`, `diagnosing-bugs`, `factory-implement`
    - `reviewer`: `factory-review`
    - `reflector`: `factory-harness`, plus the meta-skills `writing-for-agents` and `skill-creator`
- **`matchRelevantLessons(root: string, targetHints: string[]): LessonEntry[]`**:
  - Read `.factory/lessons.jsonl`, filtering for `vetoed === false`.
  - Match `trigger_patterns` (globs) against the list of files changed or mentioned in the ticket.
  - Format at most 5 matching rules into a concise Markdown block:
    ```markdown
    ## Active Repository Gotchas (Learned from Previous Laps)
    - [<topic>]: <rule> (Evidence: <evidence>)
    ```
  - **Safe Mode**: If `.factory/NO_HARNESS_MEMORY` is found, the function returns an empty string.

#### 1.2. Create Pi Extension Hook `.factory/hooks/loop-guard.ts`
Implement component `c8` (Lifecycle Hooks within Pi's tool execution loop):
- Register handlers for the `tool_call` and `tool_result` events:
  1. **Protected Paths Guard**: Prevent the `write` / `edit` tools from modifying `protected_paths` (`harness/**`, `.factory/holdout/**`, `MISSION.md`, etc.) by returning `{ block: true, reason: "..." }`.
  2. **Command Loop Hinting**: If a `bash` command fails with an error signature already known in `.factory/tool-guidance.json`, append a hint with the correct command to the output observation.

#### 1.3. Update the Multi-Harness Provider in `scripts/loop/providers.ts` & `scripts/local-loop.ts`
Since PR #77 (`761c367`), `local-loop.ts` has used `buildProviderArgv()`, which supports multiple harnesses (`pi`, `claude`, `codex`, `opencode`, `copilot`) and *reasoning effort* (`EFFORT_LADDER`). Modify `BuildProviderArgvOptions` and `buildProviderArgv()` in `scripts/loop/providers.ts` to accept `skills?: string[]`, `extensions?: string[]`, and `appendSystemPrompts?: string[]`:
```typescript
export interface BuildProviderArgvOptions {
  model?: string;
  effort?: EffortRung;
  prompt: string;
  sessionDir?: string;
  skills?: string[];
  extensions?: string[];
  appendSystemPrompts?: string[];
}
```
- **For provider `"pi"`**: Pass `--no-extensions` followed by `-e <hook>`, `--no-skills` followed by `--skill <path>`, and `--no-context-files` followed by `--append-system-prompt <text>`.
- **For providers `"claude"` / `"codex"` / `"opencode"` / `"copilot"`**: If `appendSystemPrompts` is available, cleanly append the *Active Repository Gotchas* block to the end of the prompt or use the `--append-system-prompt` flag (on `claude`) so memory injection works across provider harnesses.
- **Update `countActiveLaps()` in `scripts/loop/scheduler.ts`**: Include the statuses `"qa"`, `"reviewing"`, and `"reflecting"` in the *active laps* count so the scheduler does not consider a lap finished while it is still in QA, review, or post-lap reflection.

* **Phase 1 Completion Criterion**: Unit tests in `tests/integration/local-loop.bun.test.ts` verify that Pi's `argv` includes the appropriate `--skill`, `-e`, and `--append-system-prompt`, and disables memory injection when `.factory/NO_HARNESS_MEMORY` is active.

---

### Phase 2: Journey Evidence Collection (*Issue Run Dossier*)

#### 2.1. Create `scripts/loop/dossier.ts`
Record each lap iteration in `<stateRoot>/dossiers/issue-<number>.json`:

```typescript
export interface LapAttemptRecord {
  lapIndex: number;
  runId: string;
  timestamp: string;
  status: "waiting_approval" | "sent_back" | "failed" | "needs_owner";
  candidateHead?: string;
  changedFiles: string[];
  failedStage?: "builder" | "ordinary_checks" | "qa" | "reviewer";
  errorExcerpt?: string;
  reviewFindings: string[];
  qaFailures: string[];
}

export interface IssueDossier {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  branch: string;
  prUrl?: string;
  attempts: LapAttemptRecord[];
  reflectedAt?: string;
}
```

#### 2.2. Terminal Reflection Trigger Logic (`shouldTriggerReflection`)
Run reflection **only** if `dossier.reflectedAt` is still empty and one of the following two terminal conditions is met:
1. **Condition A (Approved After Friction)**:
   - The current lap status is `"waiting_approval"` **AND** there are $\ge 1$ previous failed attempts (`sent_back` or `failed`) in `dossier.attempts`, or there is error recovery within tool transitions.
2. **Condition B (Exhausted / Escalated to Human)**:
   - The lap status is `"needs_owner"` or the number of consecutive failures reaches the maximum limit (`attempts.length >= maxRejections`).

* **Phase 2 Completion Criterion**: A multi-lap simulation (Lap 0 `sent_back` $\rightarrow$ Lap 1 `waiting_approval`) produces a complete `dossier.json` file, and `shouldTriggerReflection()` returns `true` precisely at the end of Lap 1.

---

### Phase 3: Reflector Engine, Jev Curation, & Skill Evolution

#### 3.1. Create the Reflector Prompt (`scripts/prompts/loop-reflect.md`)
Adapt the `experience()` prompt from Google Research Harness²:
- Ask the agent to compare the failed Lap's *trajectory* with the successful Lap's trajectory.
- Provide explicit attribution: `helped`, `hurt`, `no observed effect`, or `confounded`.
- Reject lesson creation if the evidence is only `confounded` (`NO_ENTRY`).
- Produce structured JSON output containing candidates:
  - `tool_guidance_updates`: key-command pairs proven to exit with `exit code 0`.
  - `candidate_lessons`: follow the schema in `docs/agents/harness-authoring-standard.md` (positive imperative phrasing in $\le 2$ sentences, `trigger_patterns`, `evidence`).
  - `skill_promotion`: recommend creating/updating a skill if the failure pattern is multi-step or `occurrence_count >= 3`.

#### 3.2. Create `scripts/loop/reflector.ts`
Run the curation and harness-change persistence process:

1. **System 1 Curation (TypeSafe Jev)**:
   Test each candidate lesson through the Jev client:
   - `is_lesson_valid_and_non_trivial` (`noul` $\ge 0.70$): Does the lesson record a repeatable repository-specific technical fact?
   - `hallucination_risk` (`score`): Ensure it is at the `grounded_in_logs` level.

2. **Fast-Track Execution (Levels 1 & 2 — Lessons & Tool Guidance)**:
   - If the candidate lesson passes Jev:
     - If the topic already exists in `.factory/lessons.jsonl`, increment `occurrence_count += 1`.
     - Otherwise, append a new entry to `.factory/lessons.jsonl`.
   - Commit changes to `.factory/lessons.jsonl` and `.factory/tool-guidance.json` directly to the active ticket PR branch before closing the lap.

3. **Structural PR Execution (Levels 3–5 — Skills, Hooks, & `AGENTS.md`)**:
   - If `occurrence_count >= 3` or there is a `skill_promotion` recommendation:
   - Spawn a dedicated Pi session (*Skill Synthesis Agent*) including:
     - `--skill <path>/writing-for-agents`
     - `--skill <path>/skill-creator`
     - `--skill <path>/.agents/skills/factory-harness`
   - **Mandatory Authoring Rules**:
     - Create/update `.agents/skills/<skill-name>/SKILL.md` with YAML frontmatter (`name`, a `description` that clearly triggers conditional branches), numbered steps, and each step ending with a `*Completion Criterion*`.
     - Use *positive phrasing*, avoid negation, and use precise *leading words*.
     - Add **1 context-pointer line** in `AGENTS.md` (one trigger per branch).
     - Keep `AGENTS.md` at **$\le 150$ lines** (*prune* *no-op* sentences when approaching the limit).
   - **Isolated PR Creation**:
     - Create a new worktree/branch from `main` (`worktree.baseBranch` in `.archon/config.yaml`, e.g. `harness/skill-<skill-name>`).
     - Run integrity tests (`tests/integration/harness.test.ts`).
     - Create a separate Pull Request: `chore(harness): evolve <skill-name> skill from issue #<N> dossier`.

* **Phase 3 Completion Criterion**: Offline tests with mock Jev and Pi transports verify that:
  1. Lessons with confidence $\ge 0.70$ are stored in `.factory/lessons.jsonl`.
  2. Lessons with confidence $< 0.70$ are rejected.
  3. Skill escalation (`occurrence_count >= 3`) triggers creation of a valid `.agents/skills/<name>/SKILL.md` structure and keeps `AGENTS.md` at $\le 150$ lines.

---

### Phase 4: Backend API & Operator Web Console Integration

#### 4.1. Implement Endpoints in `apps/backend/src/main.ts`
Connect the Harness table UI in `web/app.js` to files in `.factory/`:
1. **`GET /api/v1/harness/lessons` & `/api/harness/lessons`**:
   - Read `.factory/lessons.jsonl` and check `.factory/NO_HARNESS_MEMORY`.
   - Response: `{ safe_mode: boolean, lessons: LessonEntry[] }`.
2. **`GET /api/v1/harness/tools` & `/api/harness/tools`**:
   - Read `.factory/tool-guidance.json`.
   - Response: `{ tools: Record<string, string> }`.
3. **`POST /api/v1/harness/veto` & `/api/harness/veto`**:
   - Accept `{ id: string }`.
   - Atomically set the `vetoed: true` flag for the corresponding lesson in `.factory/lessons.jsonl`.
   - Response: `{ ok: true, id: string, vetoed: true }`.

* **Phase 4 Completion Criterion**: The `/api/v1/harness/*` endpoints return HTTP 200 with valid data, the Veto action updates `.factory/lessons.jsonl`, and the web dashboard displays lessons and tool guidance without 404 errors.

---

## 5. Execution Roadmap

| Step | Work Package | Main Files | Verification |
|---|---|---|---|
| **Step 1** | **Backend Harness API** | `apps/backend/src/main.ts`, `packages/contracts/src/operator.ts` | `tests/integration/harness.test.ts` |
| **Step 2** | **Curated Hermetic Injection & Guard Hook** | `scripts/loop/harness-memory.ts`, `scripts/loop/providers.ts`, `.factory/hooks/loop-guard.ts`, `scripts/local-loop.ts` | `tests/integration/local-loop.bun.test.ts` |
| **Step 3** | **Issue Run Dossier & Terminal Trigger** | `scripts/loop/dossier.ts`, `scripts/local-loop.ts` | `tests/integration/loop-modules.bun.test.ts` |
| **Step 4** | **Post-Issue Reflector, Jev Gating & Skill PR** | `scripts/loop/reflector.ts`, `scripts/prompts/loop-reflect.md` | `tests/integration/harness.test.ts` |
| **Step 5** | **Full Verification Suite** | All files above | `bun harness/ci.ts` |
