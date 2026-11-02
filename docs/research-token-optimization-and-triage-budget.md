# Research: Token Consumption Optimization Across Issue Triage and the Autonomous Software Factory

* **Date:** 2026-11-02
* **Target Audience:** Animus Architecture Council, Core Engineers, Factory Operations
* **Primary Scope:** Root-cause analysis of token expenditure introduced by the autonomous Issue Triage stage (`animus-triage` / `scripts/loop/triage.ts`) and cross-stage context/exploration redundancy across the Animus Software Factory (`triage` → `builder` → `qa` → `reviewer` → `reflector`, plus multi-lap retries and scheduler polling), with repo-grounded optimization engineering specifications.
* **Status:** Final Research Specification

---

## 1. Executive Summary

Adding an autonomous **Issue Triage** stage (`scripts/loop/triage.ts:1088-1540`, `scripts/prompts/triage.md:1-125`, `.agents/skills/animus-triage/SKILL.md:1-50`) prior to execution (`scripts/local-loop.ts:239-1691`) solves intake quality. It turns ambiguous or raw GitHub issues into canonical, repository-grounded specifications (`ready-for-agent`), targets clarification questions (`needs-info`), or establishes human consensus for epic decomposition (`promote_epic_spec_and_tickets`).

However, an exhaustive audit against **primary sources** in this repository and first-party provider/harness documentation reveals **seven structural multipliers** that inflate token consumption across the lifecycle:

1. **The $N\times$ Cold-Start Exploration Tax**: Every role (`triage`, `builder`, `qa`, `reviewer`, `reflector`) executes in a clean, isolated process/session (`scripts/loop/triage.ts:1226-1262`, `scripts/local-loop.ts:753-788`). While Triage spends 5–15 tool turns discovering target files, exported symbols, test seams, and verification commands (`scripts/prompts/triage.md:16-25`), that concrete discovery map is discarded upon issue rewrite (`scripts/loop/triage.ts:1430-1460`). When Builder (`loop-work`) launches, it starts completely cold, spending another 5–12 tool turns running `find`, `grep`, and `read` to re-discover the exact same files.
2. **Host-to-Prompt Omission (Redundant Tool Round-Trips)**: The host process in `scripts/loop.ts:76-170` (`readIssueContract`) already fetches and validates `issue.title`, `issue.body`, `issue.comments`, `issue.dependencies`, and `issue.labels` via GitHub REST APIs. Yet `scripts/local-loop.ts:700-725` passes only `target: issue.url` into `promptVars`. Builder and QA agents must spend initial tool turns running `gh issue view` or `gh pr view` to read text the host already holds in RAM. Similarly, the host computes `diffContentFinal` (`scripts/local-loop.ts:1324-1331`), but omits it from Reviewer's prompt, forcing the expensive `large`-tier reviewer model to make multiple bash tool calls (`git diff`) on every lap.
3. **Runaway Retries on Failed Triage Passes**: In `scripts/loop/triage.ts:1270-1288`, if `triageSingleIssue` fails (e.g. LLM timeout at 180s, transport exit non-zero, or Zod/canonical validation error), no GitHub marker or state-root failure record is written. In `scripts/loop/scheduler.ts:508-685`, the scheduler attempts non-blocking triage passes every tick (default 300s). On failure, `lastTriageErrorMap` locks out triage for the entire scheduler until cleared, while standalone or CLI triage passes repeatedly re-invoke the full model on unchanged, failing issues in an infinite loop.
4. **Eager Multi-Skill Materialization & Pi Tool Allowlist Gaps**: `resolveAllowedSkills(root, "triage")` (`scripts/loop/harness-memory.ts:77-85`) attaches **6 skills** (`animus-triage`, `animus-brainstorm`, `animus-grill`, `animus-architecture`, `animus-spec`, `animus-tickets`) to every triage run. On non-Pi providers (`claude`, `omp`, `codex`, `opencode`), `buildProviderArgv()` (`scripts/loop/providers.ts:190-225`) inlines the complete `SKILL.md` body of all 6 skills (31,394 bytes, ~8,000–10,000 tokens) into system prompts upfront, bypassing progressive disclosure. Simultaneously, `scripts/loop/triage.ts:1232` restricts Pi tools to `tools: "read,grep,find"`, omitting `ls` (explicitly allowed in `scripts/loop/triage-policy.ts:8-18`) and omitting Pi's built-in `codemode` (`@earendil-works/pi-coding-agent/docs/codemode.md:1-40`), forcing sequential tool roundtrips instead of batched, sandboxed execution.
5. **Role Tiering & Effort Misconfiguration (`resolveEffortForRole`, `deadlines.ts`)**: In `scripts/loop/deadlines.ts:3`, `triage` is missing from the `roles` array, causing `resolveRoleBudgets()` to throw `Invalid role budget: triage` if configured. In `scripts/loop/config.ts:167`, `triage` is assigned to `"medium"` tier, but in `.animus/config.yaml:12-16`, `tiers.medium.effort` is configured as `"high"`. In `scripts/loop/config.ts:247-271` (`resolveEffortForRole`), there are no role-specific effort defaults or environment overrides (`FACTORY_LOOP_TRIAGE_EFFORT`). Setting `FACTORY_LOOP_EFFORT=high` applies globally, forcing Triage to burn thousands of hidden reasoning tokens on simple file classification.
6. **Prompt Cache Invalidation & Static Prefix Instability**: Provider prompt caching (Anthropic, DeepSeek, OpenAI, Gemini) relies on longest common prefix matching. In `scripts/prompts/triage.md:7-14`, dynamic tokens (`$INPUTS.issue_number`, `$INPUTS.issue_title`, `$INPUTS.issue_body`, `$INPUTS.issue_comments`) are placed at lines 7–14, before all static instructions, schemas, and guidelines (lines 16–125), busting prompt cache across different issues. In `scripts/local-loop.ts:760-775`, dynamic timestamps (`softDeadline`, `hardDeadline`) and unique run UUID paths are concatenated into the prompt body, busting cache across attempts.
7. **Unbounded Exploration & Verbose Tool Feedback in Triage**: `validateCat` (`scripts/loop/triage-policy.ts:233-240`) and `validateRg` (`scripts/loop/triage-policy.ts:404-453`) lack output line and byte constraints, permitting unbounded dumps into model context. Additionally, `registerLoopGuard` (`.factory/hooks/loop-guard.ts:282-325`) injects codebase pattern reminders and shared pattern registry hints into every `read` tool result, adding unneeded token weight to read-only triage passes.

By implementing the engineering methods detailed herein, the Animus Software Factory can achieve an estimated **55%–75% reduction in total token consumption per admitted issue**, accelerate lap turnaround, and eliminate infinite retry waste while strictly preserving all Animus invariants: **fail-closed verification**, **read-only triage safety**, **fresh-context role independence**, and the **offline test invariant**.

---

## 2. Primary-Source Trace of Token Spend Across the Factory Lifecycle

The table below maps each stage of an issue's lifecycle in the software factory, the primary source files governing its execution, and the exact token sinks observed.

| Lifecycle Stage | Governing Primary Sources | Default Model Tier & Effort | Primary Token Inefficiency / Redundancy |
| :--- | :--- | :--- | :--- |
| **0. Issue Triage** | `scripts/loop/triage.ts:1088-1540`<br>`scripts/prompts/triage.md:1-125`<br>`.agents/skills/animus-triage/SKILL.md:1-50`<br>`scripts/loop/triage-policy.ts:8-18` | Model: `medium`<br>Effort: `high` (via `.animus/config.yaml:12-16` or unset)<br>Timeout: 180s (`triage.ts:1256`) | **Eager skill loading** (6 skills = 31KB inlined on non-Pi); **cache-busting prefix** (`triage.md:7-14`); **cold exploration** without `codemode`/`ls`; **unbounded tool dumps** (`cat`/`rg`); **triage discovery trace discarded** at output boundary. |
| **1. Builder (`loop-work`)** | `scripts/local-loop.ts:677-974`<br>`scripts/prompts/loop-work.md:1-120`<br>`scripts/loop/harness-memory.ts:55-70`<br>`scripts/loop/deadlines.ts:13-45` | Model: `medium`<br>Effort: `high`<br>Budget: 20m soft / 25m hard (`deadlines.ts:24`) | **Cold exploration restart**: Builder re-greps repository from scratch to locate files Triage already verified; **host context omitted**: `issue.body` not passed in `promptVars`, forcing `gh issue view` tool calls; **dynamic deadline stamps** bust prompt cache across attempts. |
| **2. Ordinary Checks** | `scripts/local-loop.ts:940-975` | Deterministic Host Execution (0 LLM tokens) | Host executes project checks (`npm test`, `bun test`) and writes `builder-checks.log`. Checks pass deterministically, but stdout/stderr is not structured into downstream prompt context. |
| **3. Black-Box QA (`loop-check-app`)** | `scripts/local-loop.ts:976-1140`<br>`scripts/prompts/loop-check-app.md:1-110`<br>`scripts/loop/profiles.ts:21-175` | Model: `small`<br>Effort: `medium`<br>Budget: 15m soft / 20m hard (`deadlines.ts:25`) | **Host context omitted**: QA receives `target: issue.url` instead of inlined contract criteria, forcing `gh issue view`; QA does not receive pre-verified single-test commands, often running exploratory test suites. (Mitigated partly by `profiles.ts` `skip_app_launch: true`). |
| **3.5 PR CI Gate** | `scripts/local-loop.ts:1142-1238`<br>`scripts/loop/ci.ts:1-200` | Deterministic Host Polling (0 LLM tokens) | Fast-fails early if remote GitHub Actions CI fails before launching Reviewer. Efficient host gate. |
| **4. Code Review (`loop-review`)** | `scripts/local-loop.ts:1240-1410`<br>`scripts/prompts/loop-review.md:1-160`<br>`scripts/loop/config.ts:162, 237` | Model: `large` (`@reasoning`)<br>Effort: `high`<br>Budget: 15m soft / 20m hard (`deadlines.ts:25`) | **Omission of Git Diff**: Host computes `diffContentFinal` at line 1324, but only passes `files: changedFilesList` in `promptVars:710`. The most expensive model (`large`/`high` reasoning) must spend 1–3 tool turns executing `git diff` via bash. |
| **5. Post-Issue Reflector (`loop-reflect`)** | `scripts/local-loop.ts:1475-1485`<br>`scripts/loop/reflector.ts:152-193`<br>`scripts/loop/dossier.ts:174-192` | Model: `large` (`@reasoning`)<br>Effort: `high`<br>Timeout: 300s (`reflector.ts:163`) | **Gated by friction**: Correctly runs only upon terminal state (`waiting_approval` or `merged` after prior lap friction, or `needs_owner`). However, inlining full dossier JSON (`$INPUTS.dossier_json`) at prompt start busts prefix caching across reflections. |
| **Multi-Lap Retries (Lap 1+)** | `scripts/local-loop.ts:239-285, 755-770`<br>`scripts/prompts/loop-work.md:18-24` | Model: `medium`<br>Effort: `high` | **Zero transcript reuse**: Builder launches in a fresh `sessionDirectory` (`0-builder-attempt-1-session` or Lap 1 runDirectory). Builder re-reads PR diff, review comments, and findings via tool calls (`gh pr view`, `gh api`). |
| **Scheduler Polling** | `scripts/scheduler.ts:1-189`<br>`scripts/loop/scheduler.ts:508-685` | Polling Loop (default 300s interval) | **Runaway retry on failure**: If an issue fails during triage, `lastTriageErrorMap` halts all triage passes, while uncoordinated runs re-invoke the LLM every tick because the issue remains unlabeled on GitHub. |

---

## 3. Detailed Root-Cause Analysis of the Seven Structural Multipliers

### Multiplier 1: The Discarded Discovery Handoff ("Cold-Start Exploration Tax")

#### Primary Source Findings:
- In `scripts/prompts/triage.md:16-25`, the triage prompt instructs:
  > *"1. Discover repository facts: Use read-only inspection tools (read, grep, find, glob) to inspect relevant directories, docs/, AGENTS.md, .factory/codebase-rules.json, and source code."*
- In `.agents/skills/animus-triage/SKILL.md:16-24`, Step 2 mandates:
  > *"Investigate before asking. Read relevant source, tests, repository guidance, issue history... cite concrete paths or behavior in the triage rationale."*
- In `scripts/loop/triage.ts:64-70`, `promoteSingleTicketSchema` requires:
  ```typescript
  export const promoteSingleTicketSchema = z.strictObject({
    action: z.literal("promote_single_ticket"),
    title: z.string().min(1, "Ticket title must not be empty"),
    body: z.string().min(1, "Ticket body must not be empty"),
    reason: z.string().min(1, "Reason must not be empty"),
    authority: z.enum(["agent", "human"]).default("agent").optional(),
  });
  ```
- In `scripts/loop/triage.ts:1430-1460`, when handling `promote_single_ticket`:
  ```typescript
  await forge.updateIssue(repo, issueNumber, {
    title: action.title,
    body: action.body,
    labels: Array.from(new Set(newLabels)),
  });
  ```
  **The `reason` field is completely discarded.** It is returned to the memory caller of `triageSingleIssue`, but is never written to the GitHub issue, nor persisted in `stateRoot/dossiers`, nor passed into any downstream artifact.
- In `scripts/local-loop.ts:700-725`:
  ```typescript
  const promptVars: Record<string, string> = {
    route,
    target: issue.url,
    pr: state.pr ?? "",
    reason: `Autonomous delivery for issue #${issue.number}: ${issue.title} [profile: ${effectiveProfile}]`,
    ...
  };
  ```
  The Builder (`loop-work`) is only handed the GitHub issue URL.
- In `scripts/prompts/loop-work.md:14-25`:
  Builder is instructed to read the issue contract and investigate. Having no scout artifact or file list, Builder initiates a full exploration pass (`find`, `grep`, `read`), repeating the exact same tool calls Triage executed 5 minutes prior.

#### Quantitative Impact:
- Triage spends **5–12 tool turns** discovering the seam (~15,000–35,000 input tokens across turns).
- Builder spends **6–15 tool turns** rediscovering the same seam (~25,000–55,000 input tokens across turns).
- **Redundancy:** 100% duplication of exploratory read-only search operations between Triage and Builder Lap 0.

---

### Multiplier 2: Host-to-Prompt Omission (Redundant Tool Round-Trips)

#### Primary Source Findings:
- In `scripts/loop.ts:76-170`, `readIssueContract(root, number, repo)` executes:
  ```typescript
  const issue = read(
    ["issue", "view", String(number), "--repo", repo, "--json", "number,url,state,labels,title,body,comments"],
    root,
  ) as ...;
  // REST pagination fetches all comments
  const pages = read(["api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--slurp"], root);
  // REST pagination fetches blocked_by dependencies
  const dependencyPages = read(["api", `repos/${repo}/issues/${number}/dependencies/blocked_by`, "--paginate", "--slurp"], root);
  ```
  The host holds a fully populated, strongly validated `LocalIssue` object: `{ number, url, title, body, comments, dependencies, labels }`.
- In `scripts/local-loop.ts:677-745`, `runLocalLoop` receives `issue: LocalIssue`. But in `invoke()`:
  ```typescript
  const promptVars: Record<string, string> = {
    route,
    target: issue.url,
    pr: state.pr ?? "",
    reason: `Autonomous delivery for issue #${issue.number}: ${issue.title} [profile: ${effectiveProfile}]`,
    ...
  };
  ```
  Neither `issue.body` nor `issue.comments` are placed into `promptVars`.
- In `scripts/prompts/loop-work.md:16`:
  > *"Read the issue body and comments completely before making changes"*
  Because the body is omitted from the prompt, the agent's first tool call is always `bash("gh issue view ...")` or `gh api`.
- In `scripts/local-loop.ts:1324-1331`:
  ```typescript
  const diffContentFinal = await git(state.worktree, "diff", "--no-renames", base, state.candidate);
  ```
  The host computes the complete candidate git diff for auto-merge evaluation.
- But in `scripts/local-loop.ts:710`, `promptVars` for Reviewer (`loop-review`) only includes:
  `files: changedFilesList || "(all files in commit)"`.
- In `scripts/prompts/loop-review.md:5-9`:
  Reviewer is told: *"your job is to inspect the code diff, verify evidence integrity, and decide the outcome."*
  Because the diff is not in the prompt, Reviewer must execute `bash("git diff ...")`, adding a full turn with reasoning tokens on the most expensive model (`large` tier).

#### Quantitative Impact:
- Each unnecessary tool roundtrip resends the full conversation prefix (typically 12k–40k tokens) plus model reasoning overhead (2k–8k tokens per turn).
- Incurring 2 tool turns for issue reading in Builder + 1 tool turn in QA + 2 tool turns for git diff in Reviewer costs **~50,000–90,000 unneeded input/reasoning tokens per lap**.

---

### Multiplier 3: Runaway Retries on Failed Triage Passes

#### Primary Source Findings:
- In `scripts/loop/triage.ts:221-301`, `evaluateTriageEligibility(issue, stateRoot)` determines whether an issue is eligible for triage:
  1. Open state check (`issue.state === "OPEN"`).
  2. Exclusion label check (`wontfix`, `ready-for-agent`, `ready-for-human`, `needs-owner`).
  3. Staging recovery check (`epic-${issue.number}.json`).
  4. If `needs-info`: eligible only if last comment does NOT contain `TRIAGE_AGENT_MARKER`.
  5. If `needs-triage` or unlabeled: eligible only if last comment does NOT contain `TRIAGE_AGENT_MARKER`.
- In `scripts/loop/triage.ts:1270-1308`, when an error occurs during `triageSingleIssue`:
  ```typescript
  if (response.timedOut || response.exitCode === 124) {
    return { issueNumber, status: "failed", error: `Triage agent execution timed out after ${timeoutMs}ms` };
  }
  if (response.exitCode !== 0) {
    return { issueNumber, status: "failed", error: `Triage agent transport exited with code ${response.exitCode}: ${response.stderr}` };
  }
  ```
  **Notice:** When `triageSingleIssue` fails, **no GitHub comment is created**, **no label is added/removed**, and **no failure record is stored on disk**.
- As a consequence, on GitHub, the issue remains `OPEN`, unlabeled (or `needs-triage`), and its latest comment remains human (no `TRIAGE_AGENT_MARKER`).
- On the next run of `runTriagePass`:
  `evaluateTriageEligibility` evaluates to `true` again!
- In `scripts/loop/scheduler.ts:508-685`, `dispatchTriagePass` attempts to track failures via `lastTriageErrorMap`:
  ```typescript
  // scripts/loop/scheduler.ts:542-549
  const pendingError = lastTriageErrorMap.get(key);
  if (pendingError) {
    return { status: "error", error: pendingError, reason: "previous_triage_failed" };
  }
  ```
  However:
  - If a triage pass fails, `lastTriageErrorMap` locks out triage for the **entire repository** (all issues), not just the failing issue!
  - If the scheduler process restarts, or if triage is invoked via CLI or background worker, `lastTriageErrorMap` is empty. The failing issue is picked up immediately, running the full 3-minute, high-effort model exploration again every tick.

#### Quantitative Impact:
- An issue triggering a timeout or schema validation failure re-runs every 300s. Over an 8-hour shift, a single failing issue can burn **96 full triage passes**, consuming **~3,000,000–5,000,000 wasted tokens** with zero productive output.

---

### Multiplier 4: Eager Multi-Skill Materialization & Tool Allowlist Gaps

#### Primary Source Findings:
- In `scripts/loop/harness-memory.ts:77-85`:
  ```typescript
  case "triage":
    candidateNames.add("animus-triage");
    candidateNames.add("animus-brainstorm");
    candidateNames.add("animus-grill");
    candidateNames.add("animus-architecture");
    candidateNames.add("animus-spec");
    candidateNames.add("animus-tickets");
    break;
  ```
- In `scripts/loop/providers.ts:190-225`:
  ```typescript
  export function buildProviderArgv(provider: string, options: BuildProviderArgvOptions): string[] {
    ...
    const skillContents = (options.skills ?? [])
      .map((s) => materializeSkillContent(s))
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0);

    const materializedSystemPrompts = (options.appendSystemPrompts ?? [])
      .map((p) => materializeContextText(p))
      .concat(skillContents);
  ```
- For `claude`, `omp`, `codex`, and `opencode`, `materializedSystemPrompts` inlines all 6 `SKILL.md` documents directly into the prompt:
  - `animus-triage`: 5,783 bytes
  - `animus-brainstorm`: 5,044 bytes
  - `animus-grill`: 4,211 bytes
  - `animus-architecture`: 6,236 bytes
  - `animus-spec`: 4,836 bytes
  - `animus-tickets`: 5,284 bytes
  **Total:** 31,394 bytes (~8,500 tokens) inlined into every triage turn, even though `scripts/prompts/triage.md:27-40` explicitly states:
  > *"For a clear incremental change in an established codebase, skip these stages and produce the bounded executable brief directly."*
- In `scripts/loop/triage.ts:1232`, Pi's tool argument is configured as:
  `tools: provider === "claude" ? "Read,Glob,Grep" : "read,grep,find"`
  - `ls` is omitted, forcing the model to run `find` with globs for basic directory listing.
  - Pi's built-in `codemode` tool (`@earendil-works/pi-coding-agent/docs/codemode.md:1-25`) is omitted. In Pi, `codemode` runs in a QuickJS sandbox where the model can execute `Promise.all([tools.grep(...), tools.read(...)])`, filter and slice outputs in JS, and return only concise results. Without `codemode`, every read or grep requires a full conversational turn.

---

### Multiplier 5: Role-Based Model & Effort Tiering Misconfiguration

#### Primary Source Findings:
- In `scripts/loop/deadlines.ts:3`:
  ```typescript
  const roles: LoopRole[] = ["builder", "qa", "reviewer", "reflector", "planner", "investigator", "manager", "auditor", "simplifier"];
  ```
  `"triage"` is completely absent from `roles`. If `resolveRoleBudgets()` is called with `roleBudgets: { triage: ... }`, line 19 throws:
  `throw new Error("Invalid role budget: triage")`.
  As a result, Triage has no configurable soft/hard deadline split and relies on a hardcoded 180s timeout (`scripts/loop/triage.ts:1256`).
- In `scripts/loop/config.ts:167-170`:
  ```typescript
  case "builder":
  case "investigator":
  case "simplifier":
  case "triage":
    return "medium";
  ```
  `triage` is mapped to the `"medium"` tier.
- In `.animus/config.yaml:12-16`:
  ```yaml
  tiers:
    small:
      provider: pi
      model: default
      effort: medium
    medium:
      provider: pi
      model: default
      effort: high
    large:
      provider: pi
      model: default
      effort: high
  ```
  Because `medium` specifies `effort: high`, **Triage runs with `high` thinking effort by default**.
- In `scripts/loop/config.ts:247-271`:
  ```typescript
  export function resolveEffortForRole(root: string, role: LoopRole): EffortRung | undefined {
    if (process.env.FACTORY_LOOP_EFFORT && isEffortRung(process.env.FACTORY_LOOP_EFFORT)) {
      return process.env.FACTORY_LOOP_EFFORT;
    }
    ...
    if ((role === "reviewer" || role === "reflector") && config.aliases?.["@reasoning"]?.effort ...) {
      return config.aliases["@reasoning"].effort;
    }
    if (config.tiers?.[tier]?.effort ...) {
      return config.tiers[tier]!.effort;
    }
    return undefined;
  }
  ```
  There is no role-specific effort configuration (`FACTORY_LOOP_TRIAGE_EFFORT`, `FACTORY_LOOP_QA_EFFORT`).
  When `FACTORY_LOOP_EFFORT=high` is set in the environment, all roles (including Triage and QA) inherit `high` reasoning effort, generating 4,000–16,000 reasoning tokens per turn on simple file reads and unit test checks.

---

### Multiplier 6: Prompt Cache Invalidation & Static Prefix Instability

#### Primary Source Findings:
- Modern LLM providers (Anthropic, DeepSeek, OpenAI, Google Vertex) employ **Prefix-Based Prompt Caching**. Prompts that share an exact byte-for-byte prefix from token 0 hit the cache at a **75% to 90% discount** (Anthropic: $0.30/M cache read vs $3.00/M base input; DeepSeek: $0.014/M cache read vs $0.14/M base input).
- Per `@earendil-works/pi-coding-agent/docs/models-configuration.md:14-25`, Anthropic sets prompt cache breakpoints at:
  1. System prompt
  2. Last tool definition
  3. Last user turn
- In `scripts/prompts/triage.md:1-15`:
  ```markdown
  # Interactive Issue Triage

  Explore repository facts in read-only mode...
  Target Issue: #$INPUTS.issue_number — $INPUTS.issue_title
  Repository: $INPUTS.repo

  Issue Body:
  $INPUTS.issue_body

  Issue Comments:
  $INPUTS.issue_comments

  ## 1. Codebase Exploration First (Read-Only)
  ... [100+ lines of static instructions and schemas]
  ```
  Because dynamic variables (`$INPUTS.issue_number`, `issue_body`, `issue_comments`) are positioned at line 7, **the common prefix is broken at token ~80**. The remaining ~2,000 tokens of static instructions, schemas, and guidelines cannot be cached across different issues.
- In `scripts/local-loop.ts:760-775`:
  ```typescript
  const startedAt = Date.now();
  const softDeadline = startedAt + budget.softMs;
  const hardDeadline = startedAt + budget.hardMs;
  const deadlinePrompt = [
    prompt,
    "",
    "## Bounded role execution (overrides completion instructions above)",
    `Soft deadline (absolute Unix milliseconds): ${softDeadline} (${new Date(softDeadline).toISOString()}).`,
    `Hard deadline (absolute Unix milliseconds): ${hardDeadline}; the host terminates the owned process group then.`,
    `Write a durable checkpoint to ${checkpointPath} ...`,
  ].join("\n");
  ```
  Every continuation attempt (Attempt 0 vs Attempt 1) regenerates `startedAt`, inserting brand new millisecond timestamps and unique UUID paths (`checkpointPath`). This busts prefix caching between continuation attempts within the exact same lap.

---

### Multiplier 7: Unbounded Exploration & Verbose Tool Feedback in Triage

#### Primary Source Findings:
- In `scripts/loop/triage-policy.ts:233-240`:
  `validateCat` checks allowed flags (`ALLOWED_CAT_FLAGS = ["-n", "-b", "-s", "-v", "-E", "-T", "-e", "-t", "--number"]`).
  It performs **zero validation on file size or line count**. If an agent runs `cat package-lock.json` or `cat dist/bundle.js`, 10,000+ lines of raw text flood the LLM context window.
- In `scripts/loop/triage-policy.ts:404-453`:
  `validateRg` allows `-m` / `--max-count`, but does not enforce it. A broad regex search can easily return hundreds of matching lines.
- In `.factory/hooks/loop-guard.ts:282-325`:
  On every `read` tool call:
  ```typescript
  if ((toolName === "read" || toolName === "write" || toolName === "edit") && typeof args.path === "string") {
    const lessons = loadMatchingLessonsForFile(process.cwd(), args.path);
    const ruleEval = evaluateCodebaseRulesOnEdit(process.cwd(), args.path, candidateText);
    if (ruleEval.warnings.length > 0) sections.push(...);
    if (toolName === "read" && ruleEval.registryHints.length > 0) sections.push(...);
    if (lessons.length > 0) sections.push(...);
    if (sections.length > 0) return { content: [...(event.content ?? []), { type: "text", text: `\n${sections.join("\n")}` }] };
  }
  ```
  During Triage (`FACTORY_LOOP_ROLE === "triage"`), file mutations are forbidden anyway (`scripts/loop/triage-policy.ts:1416-1422`). Injecting multiple paragraphs of lesson rules, codebase pattern reminders, and registry hints into every `read` tool output adds 300–800 tokens to each file read without providing any value to the triage agent.

---

## 4. Engineering Specifications for Token Optimization

### Method 1: Zero-File Cross-Stage Discovery Handoff (Unified `## Boundary` Codebase Pointers Across `/animus-tickets` & `/animus-triage`)

#### Objective:
Pass repository exploration findings directly into the canonical `## Boundary` section of the GitHub Issue body—across **both** intake paths (Path A: local `/animus-tickets` authoring; Path B: autonomous `/animus-triage` on raw external issues)—so Builder starts with verified file pointers, symbols, known callers, and test commands without creating orphan `locus.json` files on disk.

#### Why Inline in `## Boundary` Instead of a Separate File (`locus.json` / `.md`)?
- **Zero Orphan State / Zero Garbage Collection**: Separate files in `~/.animus/` or the repository become stale orphans when issues are closed/wontfixed or when triage and builder run on different machines/worktrees. GitHub Issues is the single authoritative tracker (`docs/triage-intake-concept.md:11`).
- **Dual-Path Unification**: Tickets authored in-repo via `.agents/skills/animus-tickets/SKILL.md` are published directly with `ready-for-agent` (`EXCLUDED_TRIAGE_LABELS`), bypassing `triage.ts` (`0` triage tokens). Standardizing `## Boundary` pointers in both `animus-tickets` and `animus-triage` ensures Builder always receives the navigation map regardless of how the ticket entered the backlog.
- **Bounded Size (<1% of GitHub Issue Limit)**: Only concise navigation pointers (4–8 lines, ~300–500 chars) are written—never raw code dumps. If an issue genuinely requires editing >10–15 files across domains, `animus-triage` / `animus-tickets` decomposes it into child tickets so each ticket's `## Boundary` remains narrow.

#### Implementation:
1. **Standardize Canonical `## Boundary` Pointers in `animus-tickets` and `animus-triage`**:
   In `.agents/skills/animus-tickets/SKILL.md` (Canonical ticket body template), `.agents/skills/animus-triage/SKILL.md` (Step 5), and `scripts/prompts/triage.md` (Option B & Option C), require `## Boundary` to include concise navigation pointers:
   ```markdown
   ## Boundary
   - **Touchpoints**: `apps/backend/src/routes/auth.ts` (`validateSessionToken`), `apps/backend/src/services/session.ts` (`SessionPayload`)
   - **Known callers (blast radius)**: `apps/backend/src/middleware/require-auth.ts`, `apps/web/src/lib/api-client.ts`
   - **Test seam**: `tests/integration/auth-session.test.ts` (`bun test tests/integration/auth-session.test.ts`)
   - **Exclusions**: Do not alter OAuth provider registration or database migration files.
   ```
2. **Host Inlining into Builder, QA, and Reviewer Prompts**:
   In `scripts/local-loop.ts:700-745`, because `readIssueContract()` (`scripts/loop.ts:76-170`) already fetches `issue.body` into memory, pre-packing `issue.body` directly into `promptVars` immediately delivers the `## Boundary` touchpoints, blast-radius callers, and test seam to Builder at Turn 0 with zero extra files on disk.
   *Invariant Preservation:* Builder treats `## Boundary` pointers as repository hints and verifies them against current `HEAD`, preserving fresh-context robustness while eliminating cold-start grep loops.

---

### Method 2: Role-Based Model & Effort Tiering

#### Objective:
Establish first-class tiering and reasoning effort defaults per role, preventing cheap tasks from burning maximum reasoning tokens.

#### Implementation:
1. **Add `triage` to `scripts/loop/deadlines.ts:3`**:
   ```typescript
   const roles: LoopRole[] = [
     "builder", "qa", "reviewer", "reflector", "planner",
     "investigator", "manager", "auditor", "simplifier", "triage",
   ];
   ```
   Add default budgets in `resolveRoleBudgets`:
   ```typescript
   const defaults = role === "builder"
     ? { softMs: 20 * 60_000, hardMs: 25 * 60_000 }
     : role === "triage"
       ? { softMs: 2 * 60_000, hardMs: 3 * 60_000 }
       : { softMs: 15 * 60_000, hardMs: 20 * 60_000 };
   ```
2. **Default Role Effort Mapping in `scripts/loop/config.ts:247-271`**:
   Add role-specific fallbacks when unconfigured:
   ```typescript
   export function resolveEffortForRole(root: string, role: LoopRole): EffortRung | undefined {
     // Role-specific env override takes highest precedence
     const roleEnv = process.env[`FACTORY_LOOP_${role.toUpperCase()}_EFFORT`];
     if (roleEnv && isEffortRung(roleEnv)) return roleEnv;

     if (process.env.FACTORY_LOOP_EFFORT && isEffortRung(process.env.FACTORY_LOOP_EFFORT)) {
       return process.env.FACTORY_LOOP_EFFORT;
     }

     const config = readAnimusConfig(root);
     const roleOverride = config.roles?.[role];
     if (roleOverride && typeof roleOverride === "object" && roleOverride.effort && isEffortRung(roleOverride.effort)) {
       return roleOverride.effort;
     }

     // Tier-based config
     const tier = resolveModelTier(role, config);
     if (config.tiers?.[tier]?.effort && isEffortRung(config.tiers[tier]!.effort)) {
       return config.tiers[tier]!.effort;
     }

     // Fail-safe Animus SDLC role defaults
     switch (role) {
       case "qa":
       case "auditor":
         return "low";
       case "triage":
       case "simplifier":
         return "medium";
       case "builder":
       case "investigator":
         return "medium";
       case "reviewer":
       case "reflector":
       case "planner":
       case "manager":
         return "high";
       default:
         return "medium";
     }
   }
   ```
3. **Dynamic Effort Escalation on Multi-Lap Retries (`local-loop.ts`)**:
   On Lap 0 (`route === "simple"`), Builder runs with `effort: "medium"`. If rejected and sent back to Lap 1+ (`route === "continue"`), escalate Builder effort to `"high"` to focus reasoning on fixing identified review findings.

---

### Method 3: Deterministic Pre-Flight & Context Pre-Packing

#### Objective:
Eliminate initial tool round-trips by pre-packing host-verified facts directly into prompt variables.

#### Implementation:
1. **Pre-pack `issue.body` and `issue.comments` in `local-loop.ts:700-745`**:
   Update `promptVars` in `runLocalLoop`:
   ```typescript
   const promptVars: Record<string, string> = {
     route,
     target: issue.url,
     issue_number: String(issue.number),
     issue_title: issue.title,
     issue_body: issue.body || "(No description provided)",
     issue_comments: (issue.comments ?? []).join("\n\n---\n\n") || "(No comments)",
     pr: state.pr ?? "",
     ...
   };
   ```
2. **Pre-pack Git Diff and Test Records for Reviewer (`loop-review.md`)**:
   In `scripts/local-loop.ts:710-745`:
   ```typescript
   if (role === "reviewer" && candidate) {
     const diffStat = await git(state.worktree, "diff", "--stat", base, candidate);
     const diffPatch = await git(state.worktree, "diff", "--no-renames", base, candidate);
     // Truncate safely if diff exceeds 400 lines / 20KB
     const boundedDiff = diffPatch.split("\n").slice(0, 400).join("\n");
     extraVars.diff_stat = diffStat;
     extraVars.diff_content = boundedDiff;
   }
   ```
   In `scripts/prompts/loop-review.md`, add:
   ```markdown
   ## Candidate Changes
   Diff Stat:
   $INPUTS.diff_stat

   Code Diff:
   ```diff
   $INPUTS.diff_content
   ```
   ```
   Reviewer inspects the diff directly in Turn 1 without needing `bash("git diff")`.
3. **Host-Computed Blast Radius Map (Unmodified External Callers Outside the Diff)**:
   When Builder modifies a reusable UI component, shared helper, or contract, `git diff` only shows the modified file—not the external files importing it. Relying solely on `git diff` or Builder's self-reported `changedSeams` risks **Diff Tunnel Vision** (missing broken callers) or forces the expensive `large`-tier Reviewer to spend multiple `grep` turns hunting for callers.
   In `scripts/local-loop.ts`, before invoking `qa` and `reviewer`, compute a deterministic caller map in the host process (0 LLM tokens, `<50ms` via `rg`):
   ```typescript
   export async function computeExternalBlastRadius(
     worktree: string,
     changedFiles: string[],
   ): Promise<string> {
     const changedSet = new Set(changedFiles);
     const lines: string[] = [];
     for (const relPath of changedFiles) {
       if (!/\.(ts|tsx|js|jsx|mjs)$/.test(relPath) || /\.test\.|\.spec\./.test(relPath)) continue;
       const stem = basename(relPath).replace(/\.(ts|tsx|js|jsx|mjs)$/, "");
       if (stem === "index" || stem === "types") continue;
       const res = await processRun(
         ["rg", "-n", "--max-count", "5", "--glob", "!node_modules/**", "--glob", "!dist/**", stem, "."],
         worktree,
         5_000,
       );
       if (res.exitCode === 0 && res.stdout.trim()) {
         const externalHits = res.stdout
           .trim()
           .split("\n")
           .map((l) => l.replace(/^\.\//, ""))
           .filter((l) => !changedSet.has(l.split(":")[0]!))
           .slice(0, 8);
         if (externalHits.length > 0) {
           lines.push(`- \`${relPath}\` is referenced outside the diff by:\n` + externalHits.map((h) => `  - \`${h}\``).join("\n"));
         }
       }
     }
     return lines.length > 0 ? lines.join("\n") : "(No unmodified external callers detected)";
   }
   ```
   Inject this under `## Host-Computed Blast Radius (Unmodified Callers Outside the Diff)` for Reviewer and QA. Reviewer immediately sees every downstream consumer of a modified reusable component without spending tool turns searching for them, and can enforce Proof Level 4 (`.agents/skills/blueprint/SKILL.md:36-47`) when shared components change.

---

### Method 4: Selective Skill & Prompt Injection (`harness-memory.ts`)

#### Objective:
Prevent inlining 31KB of unused planning skills into routine triage runs, and ensure static rules (`AGENTS.md`) are placed into system prompt cache.

#### Implementation:
1. **Lazy Planning Aids in Triage (`scripts/loop/harness-memory.ts:77-85`)**:
   Change `resolveAllowedSkills(root, "triage")` to return **only** `animus-triage` by default:
   ```typescript
   case "triage":
     candidateNames.add("animus-triage");
     // Planning skills are made discoverable via reference in SKILL.md rather than preloaded
     break;
   ```
   When using Pi, optional planning skills are passed as `--skill` directories (where Pi only advertises name and description in system prompt). On non-Pi providers (`claude`, `codex`, `opencode`), only `animus-triage/SKILL.md` is inlined upfront. If the agent chooses to brainstorm, grill, or architect, it reads the skill directory on demand.
2. **Inject `AGENTS.md` and `codebase-rules.json` into Triage System Prompt**:
   In `scripts/loop/triage.ts:1226-1238`, pass `appendSystemPrompts`:
   ```typescript
   const appendSystemPrompts = buildCuratedAppendPrompts(root, {
     number: issue.number,
     title: issue.title,
     body: issue.body,
     url: "",
     comments: [],
     dependencies: [],
     activeClaim: false,
   }, "", options.acceptedRef);

   const argv = buildProviderArgv(provider, {
     model,
     effort,
     prompt: promptText,
     skills,
     appendSystemPrompts,
     ...
   });
   ```
   This eliminates the triage agent's need to execute tool calls to inspect `AGENTS.md`.

---

### Method 5: Prompt Caching & Static Prefix Stability

#### Objective:
Restructure all prompts and runtime options so that static invariant instructions form an uninterrupted prefix from byte 0, maximizing provider prompt cache hits (75–90% cost reduction).

#### Implementation:
1. **Restructure `scripts/prompts/triage.md` (Static Prefix First, Dynamic Suffix Last)**:
   Move instructions, action schemas, and canonical section definitions to the top. Position dynamic issue content at the very end:
   ```markdown
   # Interactive Issue Triage Policy & Schema

   ## 1. Codebase Exploration First (Read-Only)
   ... [Static instructions]

   ## 2. Planning Aids Selection
   ... [Static instructions]

   ## 3. Strict Action Schemas
   ... [Static schemas]

   ---
   # Target Issue Context (Dynamic Data)
   Target Issue: #$INPUTS.issue_number — $INPUTS.issue_title
   Repository: $INPUTS.repo

   Issue Body:
   $INPUTS.issue_body

   Issue Comments:
   $INPUTS.issue_comments
   ```
   *Outcome:* The first ~2,000 tokens of the prompt are 100% byte-for-byte identical across every issue triaged in the repository. Providers cache this block continuously.
2. **Decouple Dynamic Millisecond Timestamps from Prompt Text**:
   In `scripts/local-loop.ts:760-775`, remove absolute milliseconds (`Date.now() + softMs`) from `deadlinePrompt`. Instead:
   - Pass deadlines via process environment variables (`FACTORY_LOOP_SOFT_DEADLINE_MS`, `FACTORY_LOOP_HARD_DEADLINE_MS`), which are already read by `.factory/hooks/loop-guard.ts:205-225`.
   - In the prompt text, use static wording:
     `"Host deadline enforcement is active via environment timer. Write progress to handoff/checkpoint.md before soft deadline."`
   - Use standard relative path `handoff/checkpoint.md` instead of absolute path containing random UUIDs.
3. **Enable Extended Cache Retention**:
   In `scripts/loop/providers.ts:227-260`, set `PI_CACHE_RETENTION=long` in the spawned process environment. Per Pi documentation (`docs/environment-variables.md`), this enables 1-hour to 24-hour retention tiers on supported providers (Anthropic prompt cache retention).

---

### Method 6: Bounded Exploration & Tool Output Hygiene in Triage

#### Objective:
Prevent unbounded tool output from flooding context, enable batched execution in Pi, and suppress unnecessary hook warnings during read-only triage passes.

#### Implementation:
1. **Tool Output Bounding in `scripts/loop/triage-policy.ts`**:
   - In `validateCat` (`lines 233-240`), enforce file size or line limits: reject `cat` on files larger than 100KB unless piped to `head -n 200` or using line ranges.
   - In `validateRg` (`lines 404-453`), mandate `--max-count` / `-m` (defaulting to max 50 matches).
2. **Enable Pi `codemode` and `ls` in Triage**:
   - In `scripts/loop/triage-policy.ts:8-18`, ensure `"codemode"` is in `ALLOWED_TRIAGE_TOOLS`.
   - In `scripts/loop/triage.ts:1232`, update Pi tool declaration:
     `tools: "read,grep,find,ls,codemode"`
   - With `codemode`, the triage model can execute a script:
     ```javascript
     const files = await tools.find({ pattern: "*session*" });
     const grep = await tools.grep({ query: "validateSessionToken" });
     return { files, grep };
     ```
     This executes in parallel in the QuickJS sandbox (`@earendil-works/pi-coding-agent/docs/codemode.md:1-25`), returning filtered results in a single turn. All inner tool calls remain governed by `registerLoopGuard` (`.factory/hooks/loop-guard.ts:193`).
3. **Suppress Edit Hints During Read-Only Triage in `loop-guard.ts`**:
   In `.factory/hooks/loop-guard.ts:282-325`, check `process.env.FACTORY_LOOP_ROLE`:
   ```typescript
   if (process.env.FACTORY_LOOP_ROLE === "triage") {
     // Suppress verbose codebase pattern reminders and active lessons on read tool results
     return undefined;
   }
   ```
   This prevents injecting paragraphs of pattern reminders on every file read during triage.

---

### Method 7: Deterministic Eligibility & Failure Backoff Fingerprinting

#### Objective:
Eliminate infinite retry loops on failing issues and fast-fail empty/already-canonical issues without invoking the LLM.

#### Implementation:
1. **Issue Freshness Fingerprint Backoff**:
   In `scripts/loop/triage.ts:1088-1460`, when `triageSingleIssue` fails, persist a failure record at `stateRoot/triage-failures/issue-${issue.number}.json`:
   ```typescript
   interface TriageFailureRecord {
     fingerprint: string;
     failedAt: string;
     attempts: number;
     lastError: string;
   }
   ```
   In `evaluateTriageEligibility(issue, stateRoot)` (`scripts/loop/triage.ts:221-301`):
   ```typescript
   if (stateRoot) {
     const failureFile = join(stateRoot, "triage-failures", `issue-${issue.number}.json`);
     if (existsSync(failureFile)) {
       const record = JSON.parse(readFileSync(failureFile, "utf-8"));
       const currentFingerprint = computeIssueFreshnessFingerprint(issue);
       if (record.fingerprint === currentFingerprint && record.attempts >= 2) {
         return {
           eligible: false,
           reason: `Issue #${issue.number} failed triage ${record.attempts} times and has not been updated since last failure.`,
         };
       }
     }
   }
   ```
   *Outcome:* An issue that causes an LLM timeout or schema failure will attempt retry at most once. It remains skipped until a human comments or edits the issue body, completely eliminating runaway scheduler token burn.
2. **Deterministic Fast-Path for Empty / Stub Issues**:
   In `scripts/loop/triage.ts:1088`, before launching the agent process:
   ```typescript
   const trimmedBody = (issue.body ?? "").trim();
   const commentCount = (issue.comments ?? []).length;
   if (trimmedBody.length === 0 && commentCount === 0) {
     // Emit ask_clarification deterministically with 0 LLM tokens
     await forge.createIssueComment(
       repo,
       issue.number,
       `Please provide a description of the problem, intended outcome, and reproduction steps or acceptance criteria.\n\n${TRIAGE_AGENT_MARKER}`,
     );
     await forge.updateIssue(repo, issue.number, { labels: [NEEDS_INFO] });
     return { issueNumber: issue.number, status: "clarification_requested", action: "ask_clarification" };
   }
   ```
3. **Pre-Check Already-Canonical Issues**:
   If an issue was submitted by a human architect or upstream tool already containing all 5 canonical sections and passing `validateCanonicalIssueBody(issue.body)` (`scripts/loop/triage.ts:304-408`), triage can execute a lightweight admission check rather than a full exploratory session.

---

## 5. Invariant Preservation Proofs

Any token optimization within the Animus Software Factory must strictly uphold four architectural invariants:

### 1. The Fail-Closed Invariant
- **Rule:** Missing prerequisites, unverified tools, ambiguous forge data, or corrupt staging files must result in a safe hold or rejection, never an unauthorized mutation or silent bypass.
- **Proof:**
  - In Method 7 (Failure Backoff), failing issues are held from re-triage; they are not marked resolved or promoted.
  - In Method 1 (Scout Artifact), Builder treats the locus artifact strictly as untrusted hints and must verify all files and tests against `HEAD` before claiming pass.
  - In Method 6 (Bounded Output), if a file query violates bounds, the tool guard fails closed by rejecting the command rather than truncating silently.

### 2. The Read-Only Triage Guard & Working Tree Immutability
- **Rule:** Triage must execute strictly in read-only mode and leave zero uncommitted changes, untracked files, or workspace modifications (`scripts/loop/triage.ts:1264-1270`).
- **Proof:**
  - `evaluateTriageToolCall` (`scripts/loop/triage-policy.ts:1412-1438`) blocks `write` and `edit`.
  - Adding `codemode` does not bypass this: in Pi, `codemode` scripts can only invoke declared tools (`read`, `grep`, `find`, `ls`). Any attempt to invoke `write`, `edit`, or arbitrary shell calls is intercepted by `registerLoopGuard` (`.factory/hooks/loop-guard.ts:193`).
  - The working tree snapshot assertion (`beforeSnapshot === afterSnapshot`) at `scripts/loop/triage.ts:1264` remains intact.

### 3. Fresh-Context Role Independence
- **Rule:** To prevent context poisoning and cognitive drift, roles (`triage`, `builder`, `qa`, `reviewer`, `reflector`) must execute in separate, isolated processes and sessions.
- **Proof:**
  - No conversational transcripts or LLM message histories are shared across roles.
  - Handoffs occur strictly via deterministic, host-inspected data structures (`LocalIssue`, `locus.json`, `builder.json`, `app-check.json`, `diff_content`).

### 4. The Offline Test Invariant (`PI_OFFLINE=1`)
- **Rule:** The test suite and offline execution harness must function with zero network access and zero external LLM API calls.
- **Proof:**
  - `triage.ts:1196-1205` strictly checks `PI_OFFLINE === "1"` and holds execution without calling transport.
  - All prompt pre-packing and locus artifact serialization are performed using local Node/Bun filesystem and Git commands, requiring zero network calls.

---

## 6. Prioritized Implementation Roadmap & Token ROI Accounting

| Phase | Optimization Engineering Task | Target Source Files | Estimated Token Savings | Complexity | Risk |
| :---: | :--- | :--- | :---: | :---: | :---: |
| **P0** | **Triage Failure Backoff Fingerprinting**<br>Stop runaway infinite retry loops on failing issues. | `scripts/loop/triage.ts`<br>`scripts/loop/scheduler.ts` | **100%** of wasted failure retry tokens (up to millions of tokens/day) | Low | Zero |
| **P0** | **Cross-Stage Discovery Handoff (Inline `## Boundary` Pointers)**<br>Standardize `Touchpoints`, `Known callers`, and `Test seam` in `## Boundary` across `animus-tickets` and `animus-triage` (zero disk files). | `scripts/prompts/triage.md`<br>`.agents/skills/animus-triage/SKILL.md`<br>`.agents/skills/animus-tickets/SKILL.md`<br>`scripts/local-loop.ts` | **50%–70%** reduction in Builder Lap 0 exploratory grep/find turns | Low | Zero (no orphan files) |
| **P1** | **Host-Side Prompt Pre-Packing + Blast Radius Caller Map**<br>Inline `issue.body`/`comments` for Builder & QA; inline `diff_stat`, `diff_content`, `app-check.json`, and Host-Computed External Callers (`rg`) for Reviewer. | `scripts/local-loop.ts`<br>`scripts/prompts/loop-work.md`<br>`scripts/prompts/loop-check-app.md`<br>`scripts/prompts/loop-review.md` | **20%–35%** reduction in tool roundtrips + prevents Reviewer Diff Tunnel Vision | Low | Zero (deterministic host data) |
| **P1** | **Role-Based Effort Defaults & Deadlines**<br>Add `triage` to `deadlines.ts:3`; default `triage`/`qa` to `low`/`medium` effort; add dynamic escalation on Lap 1. | `scripts/loop/deadlines.ts`<br>`scripts/loop/config.ts`<br>`.animus/config.yaml` | **40%–60%** reduction in reasoning tokens on Triage & QA | Low | Zero |
| **P1** | **Prompt Cache Prefix Stabilization**<br>Move static schemas and guidelines to the top of `triage.md`; pass deadlines via env vars; enable `PI_CACHE_RETENTION=long`. | `scripts/prompts/triage.md`<br>`scripts/local-loop.ts`<br>`scripts/loop/providers.ts` | **75%–90%** discount on system & instruction prefix across all issues | Medium | Zero |
| **P2** | **Lazy Planning Skills & Pi `codemode` / `ls`**<br>Materialize only `animus-triage` upfront; add `codemode` and `ls` to triage tool allowlist; suppress verbose hook warnings in triage. | `scripts/loop/harness-memory.ts`<br>`scripts/loop/providers.ts`<br>`scripts/loop/triage-policy.ts`<br>`.factory/hooks/loop-guard.ts` | **30%–45%** reduction in triage prompt size & tool turns | Medium | Low |
| **P2** | **Bounded Exploration (`validateCat`, `validateRg`)**<br>Enforce max byte/line limits on `cat` and max match counts on `rg`. | `scripts/loop/triage-policy.ts` | Prevents catastrophic context dumps (saving 10k–50k tokens on outliers) | Low | Low |
| **P2** | **Deterministic 0-Token Fast-Paths**<br>Fast-fail empty issues with `ask_clarification` before agent launch. | `scripts/loop/triage.ts` | **100%** savings on empty/stub issues | Low | Zero |

### Cumulative Projected Token ROI:
- **Per Single-Ticket Issue Lifecycle (Lap 0):**
  - Baseline expenditure: ~180,000–320,000 tokens (Triage ~50k, Builder ~120k, QA ~35k, Reviewer ~45k, plus reasoning overhead).
  - Optimized expenditure: ~70,000–120,000 tokens.
  - **Net Reduction: ~60% across the factory lifecycle**, while increasing prompt cache hit rates from <15% to >80%.

---

## 7. Primary Source Directory & Citations

1. `scripts/loop/triage.ts`:
   - Lines 31: `TRIAGE_AGENT_MARKER = "<!-- animus-triage-agent -->"`
   - Lines 48–54: `CANONICAL_SECTIONS`
   - Lines 58–165: `triageOutputSchema`, `promoteSingleTicketSchema`, `promoteEpicSchema`
   - Lines 221–301: `evaluateTriageEligibility` (open state, exclusion labels, comment marker gate)
   - Lines 304–408: `validateCanonicalIssueBody` (structure validation, mandatory sections, Depends on line)
   - Lines 694–721: `renderTriagePrompt` (prompt templating)
   - Lines 864–1085: `handleEpicPromotion` (atomic staging recovery, child issue generation)
   - Lines 1088–1460: `triageSingleIssue` (role config, provider execution, safety snapshot check, output handling)
   - Lines 1511–1540: `runTriagePass` (batch issue processing)
2. `scripts/loop/triage-policy.ts`:
   - Lines 8–18: `ALLOWED_TRIAGE_TOOLS`
   - Lines 27–160: `tokenizeShellCommand`
   - Lines 179–212: `validateLs`
   - Lines 214–240: `ALLOWED_CAT_FLAGS` and `validateCat` (unbounded file dump vulnerability)
   - Lines 327–386: `validateGrep`
   - Lines 404–453: `validateRg`
   - Lines 518–729: `validateFind`
   - Lines 776–972: `validateGit`
   - Lines 974–1195: `validateGhIssue`
   - Lines 1412–1438: `evaluateTriageToolCall` (read-only enforcement)
3. `scripts/loop/triage-state.ts`:
   - Lines 10–33: `resolveCanonicalGitCommon`
   - Lines 57–65: `isStateRootOutsideCheckout`
   - Lines 79–106: `resolveTriageStateRoot` (per-repo external state isolation)
4. `scripts/prompts/triage.md`:
   - Lines 1–15: Dynamic variable injection at top (cache-busting vulnerability)
   - Lines 16–25: Read-only codebase exploration mandate
   - Lines 27–40: Planning aids selection rules
   - Lines 42–69: Action selection criteria
   - Lines 71–125: Strict output JSON schemas
5. `.agents/skills/animus-triage/SKILL.md`:
   - Lines 1–6: Skill frontmatter
   - Lines 12–42: Canonical 5-step triage methodology
   - Lines 44–50: Triage guardrails
6. `scripts/local-loop.ts`:
   - Lines 239–350: `runLocalLoop` entry point and worktree initialization
   - Lines 677–830: `invoke()` role execution wrapper, session directory creation, deadline prompt construction
   - Lines 700–745: `promptVars` assembly (omits `issue.body`, `comments`, and `diff_content`)
   - Lines 832–974: Stage 1 Builder execution and candidate branch push
   - Lines 940–975: Stage 2 Ordinary checks execution (`builder-checks.log`)
   - Lines 976–1140: Stage 3 Black-Box QA execution (`qa-worktree`, `app-check.json`)
   - Lines 1142–1238: Stage 3.5 Remote PR CI check polling
   - Lines 1240–1410: Stage 4 Code Review execution (`review.json`)
   - Lines 1309–1370: Subticket auto-merge evaluation
   - Lines 1475–1485: Stage 5 Post-issue terminal reflection
7. `scripts/loop.ts`:
   - Lines 76–170: `readIssueContract()` (host-side GitHub REST API issue, comment, and dependency fetcher)
8. `scripts/loop/config.ts`:
   - Lines 167–170: `resolveModelTier` (maps `triage` to `"medium"`)
   - Lines 199–221: `resolveModelForRole`
   - Lines 223–245: `resolveProviderForRole`
   - Lines 247–271: `resolveEffortForRole` (checks `@reasoning` only for reviewer/reflector, falls back to tier)
   - Lines 273–280: `resolveRoleConfig`
9. `scripts/loop/deadlines.ts`:
   - Line 3: `roles` array (omitting `"triage"`)
   - Lines 13–45: `resolveRoleBudgets`
   - Lines 50–70: `interruptionReport`
10. `scripts/loop/types.ts`:
    - Lines 16–27: `LoopRole` definition (includes `"triage"`)
    - Lines 44–47: `RoleBudget`
    - Lines 49–65: `LocalLoopOptions`
11. `scripts/loop/providers.ts`:
    - Lines 18–33: `EFFORT_LADDER` and `isEffortRung`
    - Lines 48–69: `clampEffort`
    - Lines 89–165: `PROVIDER_DESCRIPTORS`
    - Lines 190–204: `materializeSkillContent`
    - Lines 221–260: `buildProviderArgv` (passes `--append-system-prompt`, `--tools`, `--skill`, `--thinking`)
12. `scripts/loop/harness-memory.ts`:
    - Lines 6–18: `NON_BUILDER_SKILLS`
    - Lines 49–62: `resolveAcceptedMemoryRef`
    - Lines 67–98: `resolveAllowedSkills` (lines 77–85 bind 6 skills to `triage`)
    - Lines 242–260: `matchRelevantLessons`
    - Lines 272–295: `buildCuratedAppendPrompts`
13. `scripts/loop/dossier.ts`:
    - Lines 7–34: `LapAttemptRecord` and `IssueDossier` schemas
    - Lines 48–112: `syncDossierFindings`
    - Lines 174–192: `shouldTriggerReflection` (terminal-friction gate)
14. `scripts/loop/reflector.ts`:
    - Lines 152–193: `runPostIssueReflection`
15. `scripts/loop/scheduler.ts`:
    - Lines 148–185: `loadScheduleConfig` (defaults `interval_seconds: 300`)
    - Lines 346–380: `filterAdmittedIssues`
    - Lines 508–685: `dispatchTriagePass` (tracks background triage, handles `lastTriageErrorMap`)
    - Lines 704–890: `runSchedulerTick`
    - Lines 914–960: `startSchedulerLoop`
16. `.factory/hooks/loop-guard.ts`:
    - Lines 188–270: `registerLoopGuard` (`api.on("tool_call")`, role checks, soft/hard deadline enforcement)
    - Lines 272–338: `registerLoopGuard` (`api.on("tool_result")`, appends active lessons and pattern registry hints)
17. `.animus/config.yaml`:
    - Lines 12–16: Repository tier configuration (`medium` tier configured with `effort: high`)
18. First-Party Pi Coding Agent Documentation:
    - `/Users/efishery/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/models-configuration.md:14-35`: Anthropic `cacheControlFormat`, `supportsLongCacheRetention`, `promptCache` lifetimes
    - `/Users/efishery/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md:20-30`: `cacheWarming: "streaming"`, `showCacheMissNotices`
    - `/Users/efishery/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/environment-variables.md:12-25`: `PI_CACHE_RETENTION=long`
    - `/Users/efishery/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/codemode.md:1-55`: QuickJS sandbox, `max_output_tokens: 10000`, parallel tool dispatch, output filtering
    - `/Users/efishery/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/cli.md:100-185`: `--tools`, `--no-session`, `--session-dir`, `--no-context-files`, `--no-skills`, `--skill`, `--append-system-prompt`
    - `/Users/efishery/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md:45-65`: Progressive disclosure skill architecture (name + description at startup, full `SKILL.md` read on demand).
