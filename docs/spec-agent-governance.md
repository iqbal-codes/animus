# Spec: Enforce foundational agent governance for single-operator and solo-company factory execution

- **Date:** 2026-11-01
- **Status:** **Implementation-Ready Specification** (Complete contract; zero material open questions)
- **Target repository:** `iqbal-codes/animus`
- **Source:** [`docs/research-enterprise-agent-governance.md`](research-enterprise-agent-governance.md) and operator scoping discussion (Iteration 1: Solo Founder / First-Person Company Governance Foundation)
- **Baseline commit:** `8db3c528d97fd32d496eb1691a838cedc856ecb0`
- **Proposed tracker labels (when authorized for GitHub publication):** `spec`, `ready-for-human` (never `ready-for-agent` on a parent spec)

---

## Source and problem

Primary-source research in [`docs/research-enterprise-agent-governance.md`](research-enterprise-agent-governance.md) audited `animus` (software factory) at commit `8db3c528d97fd32d496eb1691a838cedc856ecb0` against agentic governance standards (`NIST AI RMF 1.0`, `OWASP LLM Top 10 2025`, and `MISSION.md` / `FACTORY_RULES.md`). For an initial Iteration 1 deployment targeting a solo founder / one-person company, multi-user enterprise bureaucracy (SSO/OIDC, multi-role human RBAC hierarchies, external KMS/Ed25519 attestation chains, and SOC2 hash-chained ledgers) is unnecessary overhead. However, five concrete runtime governance gaps directly expose a single operator to unrevokable gate approvals, protected-file tampering via shell commands, runaway agent processes after emergency halt, credential leakage into child processes or git commits, and untrusted GitHub comment injection:

1. **Irrevocable Gate Approvals on Identical Candidate SHAs (`apps/backend/src/evidence/gates-and-release.ts:148–155`):** `GateAndReleaseManager.approveGate()` (`lines 19–80`) appends new rows (`INSERT INTO gate_approvals`) for both `"approved"` and `"rejected"` decisions. While `getGateApproval()` (`lines 88–94`) correctly reads the latest row (`ORDER BY created_at DESC LIMIT 1`), Stage 3 of `checkReleaseReadiness()` (`lines 148–155`) queries `SELECT decision FROM gate_approvals WHERE project_id = ? AND candidate_sha = ? AND decision = 'approved' LIMIT 1`. Once a candidate SHA has been approved once, any subsequent `"rejected"` decision on that same SHA is ignored, leaving `gate_approval` permanently `"passed"`.
2. **Unchecked `bash` Mutations of Protected Paths & Missing Tool-Call Circuit Breaker (`.factory/hooks/loop-guard.ts:38–54, 172–244`):** `registerLoopGuard` enforces `isProtectedPath()` only when `toolName === "write" || toolName === "edit"` (`line 218`), leaving `toolName === "bash"` able to mutate or delete protected governance and judge files (`MISSION.md`, `FACTORY_RULES.md`, `FACTORY.md`, `harness/**`, `.factory/holdout/**`, `.factory/hooks/**`, `.claude/settings.json`, `.ignore`, `.factory/codebase-rules.json`, `.github/workflows/**`) or execute unauthorized forge/git history commands (`git push --force`, `gh pr merge`). Additionally, `loop-guard.ts` enforces wall-clock deadlines (`FACTORY_LOOP_SOFT_DEADLINE_MS` / `FACTORY_LOOP_HARD_DEADLINE_MS`) but lacks a per-turn tool-call count ceiling (`FACTORY_LOOP_MAX_TOOL_CALLS`) to stop runaway tool loops before the 20–25 minute timer expires.
3. **Decoupled Emergency Launch Brake (`apps/backend/src/command/brakes.ts:109–146`, `apps/backend/src/evidence/run-controls.ts:71–167`):** Engaging `setGlobalLaunchBrake(true)` or `setProjectLaunchBrake(projectId, true)` only blocks future `launch` dispatches in `CommandService.dispatch()` (`apps/backend/src/command/service.ts:68–101`). Active agent processes tracked in `run_processes` (`status = 'running'`) continue running until their role timeout expires unless cancelled individually.
4. **Subprocess Environment Secret Inheritance & Incomplete Secret Scrubbing (`scripts/loop/process.ts:34`, `apps/backend/src/security.ts:151`, `packages/contracts/src/sanitizer.ts:10–47`):**
   - `processRun()` (`scripts/loop/process.ts:34`) passes `{ ...process.env, ...env }` directly to child processes, exposing control-plane secrets (`FACTORY_OPERATOR_TOKEN`, `FACTORY_TOKEN`, `FACTORY_HOST_TOKEN`, `SESSION_SECRET`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_APP_PRIVATE_KEY`) to untrusted test and build subprocesses.
   - `sanitizeForTelemetry()` (`apps/backend/src/security.ts:151`) skips arrays (`!Array.isArray(value)`), leaking sensitive fields nested inside array elements.
   - `ReportSanitizer` (`packages/contracts/src/sanitizer.ts:10–47`) lacks redaction patterns for Anthropic keys (`sk-ant-...`), AWS access keys (`AKIA...`/`ASIA...`), and PEM private keys (`-----BEGIN .* PRIVATE KEY-----`), and `.factory/hooks/loop-guard.ts --pre-commit` (`lines 331–370`) does not scan staged file content for raw secrets.
5. **Unfiltered GitHub Comment Dependency Injection (`apps/backend/src/intake/admission.ts:215–225`, `apps/backend/src/registry/forge.ts:188–190`):** `evaluateIssueAdmission()` parses `Depends on: #N` across all `issue.comments` without inspecting comment `authorAssociation`. On public or external-collaborator repositories, an unprivileged GitHub account (`authorAssociation: "NONE"`, `"FIRST_TIMER"`, `"FIRST_TIME_CONTRIBUTOR"`, `"CONTRIBUTOR"`) can comment `Depends on: #9999` to block issue admission indefinitely.

---

## Outcome

A single operator running `animus` can:
1. Revoke a prior gate approval on the same `candidateSha` by submitting a `"rejected"` decision, immediately transitioning Stage 3 (`gate_approval`) in `checkReleaseReadiness()` from `"passed"` to `"failed"` (`releaseComplete: false`).
2. Rely on `.factory/hooks/loop-guard.ts` to deterministically block in-loop `bash` commands that mutate or delete protected governance/judge paths or invoke `git push --force` / `gh pr merge`, and to trigger soft-deadline checkpointing when tool calls reach `FACTORY_LOOP_MAX_TOOL_CALLS`.
3. Engage the global or project launch brake (`halt`) and have all active runs tracked in `run_processes` for that scope automatically terminated via `RunControlManager` and marked `'cancelled'`.
4. Execute `processRun()` without leaking host control-plane secrets into child subprocess environments, scrub Anthropic/AWS/PEM secrets and nested array objects across `ReportSanitizer` and `sanitizeForTelemetry()`, and block staged commits containing raw secrets in `loop-guard.ts --pre-commit`.
5. Admit issues using `Depends on: #N` directives from issue comments only when the comment author is trusted (`OWNER`, `MEMBER`, `COLLABORATOR`, or legacy/synthetic comments without an explicit untrusted association).

---

## Invariants

1. **Latest-decision authority per gate:** Gate readiness for `(projectId, candidateSha)` is determined strictly by the most recent recorded decision per `gate_id` (`ORDER BY created_at DESC, rowid DESC`), never by the historical existence of a superseded `"approved"` row.
2. **Constitutional and judge immutability across all tools (`MISSION.md:56–57`):** Protected paths (`MISSION.md`, `FACTORY_RULES.md`, `FACTORY.md`, `harness/**`, `.factory/holdout/**`, `.factory/hooks/**`, `.factory/codebase-rules.json`, `.claude/settings.json`, `.ignore`, `.github/workflows/**`) cannot be modified or deleted by `write`, `edit`, or `bash` tool calls inside a delivery lap.
3. **Fail-closed emergency brake termination:** Engaging a global or project `launch_brake` persists the brake state durably and terminates all tracked `running` processes within the affected scope (`global` = all projects; `project` = target `projectId`).
4. **Zero control-plane secret leakage (`MISSION.md:59`, `SECURITY.md:42–47`):** Control-plane tokens and cloud private keys are stripped from ambient `process.env` before spawning child processes in `processRun()` unless explicitly supplied in the `env` argument, and raw secrets are redacted in reports, array-containing telemetry payloads, and pre-commit checks.
5. **Trusted forge dependency provenance:** Comments authored by untrusted GitHub associations (`NONE`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, `CONTRIBUTOR`) convey zero authority to add `Depends on:` blockers during intake evaluation.
6. **Offline test invariant (`AGENTS.md:33`):** All verification suites execute 100% offline using synthetic/in-memory adapters and local temporary git repositories.

---

## Acceptance criteria

- [ ] **AC1 (Revocable Gate Approval in `GateAndReleaseManager`):** In `apps/backend/src/evidence/gates-and-release.ts`, `checkReleaseReadiness(projectId, candidateSha)` evaluates the latest `gate_approvals` record per `gate_id` (`ORDER BY created_at DESC, rowid DESC`). When a gate for `(projectId, candidateSha)` is first `"approved"` and subsequently `"rejected"`, `checkReleaseReadiness()` returns `passed: false`, `status: "failed"`, `releaseComplete: false`, and includes `"gate_approval"` in `pendingStages`. When no gate rows exist for `(projectId, candidateSha)`, Stage 3 remains `passed: false`, `status: "pending"`.
- [ ] **AC2 (Bash Protected-Path Guard & Tool-Call Budget in `loop-guard.ts`):** In `.factory/hooks/loop-guard.ts`:
  1. `isProtectedPath()` includes `.ignore`, `.factory/codebase-rules.json`, and `.github/workflows/**` in addition to existing protected patterns.
  2. During `tool_call` for `toolName === "bash"`, commands that mutate, redirect into, delete, or git-reset/checkout protected paths, or that execute `git push --force` / `git push -f` / `gh pr merge` / `gh repo delete`, return `{ block: true, reason: ... }`, while read-only commands (`git status`, `git diff`, `bun test`, `ls`) remain permitted.
  3. When `FACTORY_LOOP_MAX_TOOL_CALLS` is set to a positive integer $N$, tool call $N+1$ (and subsequent calls) triggers the soft-deadline checkpoint behavior (permitting only checkpoint file writes and read-only `git status`/`git diff`/`git rev-parse HEAD` inspection, blocking all other tool calls with a `MAX TOOL CALLS` reason).
- [ ] **AC3 (Active Process Termination on Emergency Launch Brake):** In `apps/backend/src/evidence/run-controls.ts` and `apps/backend/src/command/brakes.ts` (and HTTP brake/control routes):
  1. `RunControlManager` exposes `cancelActiveRuns(options?: { projectId?: string; terminator?: ProcessTreeTerminator }): Promise<RunCancellationResult[]>` which terminates all `run_processes` rows with `status = 'running'` matching the scope (all projects when `projectId` is omitted; the specific project when `projectId` is provided) and updates `run_processes.status` and `project_runs.status` to `'cancelled'`.
  2. Activating `launch_brake` (`halt`) via `BrakeService` / control endpoints triggers active run cancellation for the corresponding scope (`global` or `project`).
- [ ] **AC4 (Subprocess Env Scrubbing, Recursive Array Telemetry Sanitization & Secret Guard):**
  1. `scripts/loop/process.ts` exports `buildChildProcessEnv(explicitEnv?: Record<string, string>, baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv` and uses it in `processRun()` to strip control-plane secret keys (`FACTORY_OPERATOR_TOKEN`, `FACTORY_TOKEN`, `FACTORY_HOST_TOKEN`, `SESSION_SECRET`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_APP_PRIVATE_KEY`) from `baseEnv` unless explicitly overridden in `explicitEnv`.
  2. `sanitizeForTelemetry()` in `apps/backend/src/security.ts` recursively traverses arrays as well as nested plain objects, redacting sensitive keys inside array items to `"[REDACTED]"`.
  3. `ReportSanitizer` in `packages/contracts/src/sanitizer.ts` redacts Anthropic keys (`sk-ant-...`), AWS access key IDs (`AKIA...` / `ASIA...`), and PEM private key blocks (`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----...`), and `.factory/hooks/loop-guard.ts --pre-commit` exits `1` when staged files contain raw credentials matched by `ReportSanitizer`.
- [ ] **AC5 (Trusted Author Filtering on GitHub Issue Comment Dependencies):**
  1. `SystemForgeAdapter` in `apps/backend/src/registry/forge.ts` queries `authorAssociation` and `author { login }` on `comments(first: 100)` nodes and preserves them on `ForgeIssue.comments`.
  2. `evaluateIssueAdmission()` in `apps/backend/src/intake/admission.ts` ignores `Depends on: #N` directives inside comments whose `authorAssociation` is explicitly untrusted (`NONE`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, `CONTRIBUTOR`), while honoring `Depends on: #N` in the issue body, in comments from `OWNER`, `MEMBER`, or `COLLABORATOR`, and in legacy/test comment fixtures that omit `authorAssociation`.

---

## Boundary

### Included in Scope
- `apps/backend/src/evidence/gates-and-release.ts` (latest-decision per `gate_id` query and `"failed"` status on rejection).
- `.factory/hooks/loop-guard.ts` (`bash` protected-path mutation guard, destructive git/gh command guard, `FACTORY_LOOP_MAX_TOOL_CALLS` budget, and `--pre-commit` secret check).
- `apps/backend/src/evidence/run-controls.ts`, `apps/backend/src/command/brakes.ts`, and `apps/backend/src/main.ts` (coupling launch brake activation to active run cancellation).
- `scripts/loop/process.ts`, `apps/backend/src/security.ts`, and `packages/contracts/src/sanitizer.ts` (subprocess environment secret stripping, recursive array telemetry sanitization, and expanded credential regexes).
- `apps/backend/src/registry/forge.ts` and `apps/backend/src/intake/admission.ts` (comment `authorAssociation` retrieval and trusted-author dependency parsing).
- Integration and unit test coverage across existing test files (`tests/integration/candidate-verification.test.ts`, `tests/integration/loop-deadline-guard.test.ts`, `tests/integration/command-ledger.test.ts`, `tests/integration/evidence.test.ts`, `tests/integration/intake-admission.test.ts`).

### Explicitly Out of Scope (Parked for Later Enterprise Iterations)
- Multi-user RBAC role hierarchies, OIDC/SSO identity providers, or multi-tenant authentication (`MISSION.md:49`).
- Multiple GitHub App installation identities per role (`animus-builder[bot]` vs `animus-verifier[bot]`).
- DSSE / Ed25519 cryptographic attestation envelopes on `CandidateVerificationRecord`.
- SHA-256 hash-chained `command_audit_chain` tables and OpenTelemetry collector export.
- OS kernel sandboxing (`sandbox-exec` / `bwrap`) wrappers inside `processRun()`.

---

## Agreed decisions

| Decision | Rationale | Evidence Pointer |
| --- | --- | --- |
| **D1: Scope Iteration 1 to Solo Founder / One-Person Company governance** | Eliminates enterprise multi-user complexity while closing the 5 concrete runtime, security, and cost hazards that affect a single operator. | Operator scoping conversation; [`docs/research-enterprise-agent-governance.md`](research-enterprise-agent-governance.md) §2.2 |
| **D2: Evaluate latest decision per `gate_id` in `checkReleaseReadiness()`** | Candidate SHA drift is already guarded by `LandingGuard` (`apps/backend/src/evidence/landing-guard.ts:99–132`), whereas operator revocation on the *same* SHA failed because `checkReleaseReadiness()` queried `decision = 'approved' LIMIT 1` without ordering by latest decision. | `apps/backend/src/evidence/gates-and-release.ts:88–94, 148–155` |
| **D3: Enforce protected paths on `bash` tool calls and add `FACTORY_LOOP_MAX_TOOL_CALLS` in `loop-guard.ts`** | Prevents agents from bypassing `write`/`edit` guards via shell redirection/commands and caps runaway tool loops using the existing soft-deadline checkpoint contract. | `.factory/hooks/loop-guard.ts:38–54, 186–244` |
| **D4: Couple `launch_brake` (`halt`) to `RunControlManager` active process cancellation** | For a solo operator, pressing `Halt` must stop in-flight runaway agent processes immediately rather than waiting up to 25 minutes for role timeout expiry. | `apps/backend/src/command/brakes.ts:109–146`; `apps/backend/src/evidence/run-controls.ts:71–167` |
| **D5: Maintain backward compatibility for test fixtures omitting `authorAssociation`** | Existing unit/integration fixtures supply `comments: [{ body: "Depends on: #1" }]` without `authorAssociation`. Treating `undefined` as trusted in local fixtures while blocking explicit untrusted GitHub values (`NONE`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, `CONTRIBUTOR`) preserves all existing tests while securing live `SystemForgeAdapter` GraphQL responses (which always populate `authorAssociation`). | `apps/backend/src/intake/admission.ts:215–225`; `apps/backend/src/registry/forge.ts:188–190` |

---

## Verification

### Behavioral Scenarios & Existing Test Seams
1. **AC1 (`tests/integration/candidate-verification.test.ts`):**
   - Approve gate `release_readiness` on `sha_cand_123456` $\rightarrow$ assert `checkReleaseReadiness()` returns Stage 3 `passed: true, status: "passed"`.
   - Submit a subsequent `approveGate()` with `decision: "rejected"` on the same `sha_cand_123456` $\rightarrow$ assert `checkReleaseReadiness()` returns Stage 3 `passed: false, status: "failed"`, `releaseComplete: false`, and `pendingStages` contains `"gate_approval"`.
   - Submit a third `approveGate()` with `decision: "approved"` on `sha_cand_123456` $\rightarrow$ assert Stage 3 transitions back to `passed: true`.
2. **AC2 (`tests/integration/loop-deadline-guard.test.ts`):**
   - Invoke `registerLoopGuard` `tool_call` handler with `toolName: "bash"` and commands mutating protected files (`echo bad > MISSION.md`, `sed -i '' 's/a/b/' harness/ci.ts`, `rm .factory/hooks/loop-guard.ts`, `git checkout -- harness/ci.ts`) or forbidden commands (`git push --force origin main`, `gh pr merge 12`) $\rightarrow$ assert `{ block: true }`.
   - Invoke `tool_call` with safe commands (`bun test`, `git status --short`, `git diff`) $\rightarrow$ assert `undefined` (allowed).
   - Set `FACTORY_LOOP_MAX_TOOL_CALLS="3"` and `FACTORY_LOOP_CHECKPOINT_PATH="/tmp/cp.md"` $\rightarrow$ assert first 3 tool calls pass, 4th call to `bash` (`bun test`) or `write` (`src/a.ts`) is blocked with `MAX TOOL CALLS`, while `write` to `/tmp/cp.md` is permitted.
3. **AC3 (`tests/integration/candidate-verification.test.ts` & `tests/integration/command-ledger.test.ts`):**
   - Register running processes via `RunControlManager.registerRunProcess()` $\rightarrow$ activate `launch_brake` with a mock `ProcessTreeTerminator` $\rightarrow$ assert all active PIDs in scope are terminated and both `run_processes` and `project_runs` transition to `'cancelled'`.
4. **AC4 (`tests/integration/evidence.test.ts` & `tests/integration/loop-modules.bun.test.ts`):**
   - Set `FACTORY_OPERATOR_TOKEN="secret_op_token"` in `baseEnv` $\rightarrow$ assert `buildChildProcessEnv()` omits `FACTORY_OPERATOR_TOKEN` while preserving `PATH` and explicit `env` overrides.
   - Pass `{ items: [{ apiKey: "secret123", name: "ok" }] }` to `sanitizeForTelemetry()` $\rightarrow$ assert `items[0].apiKey === "[REDACTED]"` and `items[0].name === "ok"`.
   - Pass strings containing `sk-ant-api03-...`, `AKIAIOSFODNN7EXAMPLE`, and `-----BEGIN RSA PRIVATE KEY-----...` to `ReportSanitizer.sanitizeMarkdown()` $\rightarrow$ assert all three are redacted and `redactedTokensCount === 3`.
5. **AC5 (`tests/integration/intake-admission.test.ts`):**
   - Evaluate an open issue with `ready-for-agent` and a comment `{ body: "Depends on: #999", authorAssociation: "NONE", author: { login: "stranger" } }` $\rightarrow$ assert `999` is **not** added to `dependencies` or `unsatisfied_dependencies`, and `admission_status === "admitted"`.
   - Evaluate the same issue with `{ body: "Depends on: #999", authorAssociation: "OWNER", author: { login: "founder" } }` where `#999` is open $\rightarrow$ assert `999` is added to `unsatisfied_dependencies` and `admission_status === "held"`, `reason === "unsatisfied_dependencies"`.

### Ordinary Gate Commands
- Targeted Vitest suite: `node node_modules/vite-plus/bin/vp test run tests/integration/candidate-verification.test.ts tests/integration/loop-deadline-guard.test.ts tests/integration/command-ledger.test.ts tests/integration/evidence.test.ts tests/integration/intake-admission.test.ts`
- Full repository gate: `bun harness/ci.ts`

---

## Prerequisites and open questions

- **Prerequisites:** None. All target modules, SQLite schemas (`gate_approvals`, `run_processes`, `project_runs`, `system_brakes`), and test harnesses already exist in `animus`.
- **Open questions:** None. All 5 Iteration 1 contracts are settled and implementation-ready.
