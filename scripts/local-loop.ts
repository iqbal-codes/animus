import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  LocalIssue,
  LoopRole,
  ProcessResult,
  AgentTransport,
  PiTransport,
  LocalLoopOptions,
  LoopEvidence,
  LocalLoopResult,
} from "./loop/types";
import {
  resolveModelForRole,
  resolveProviderForRole,
  resolveEffortForRole,
} from "./loop/config";
import { loadScheduleConfig } from "./loop/scheduler";
import { buildProviderArgv } from "./loop/providers";
import {
  resolveAllowedSkills,
  resolveLoopExtensions,
  buildCuratedAppendPrompts,
} from "./loop/harness-memory";
import {
  resolveVerificationProfile,
  getProfileInstructions,
} from "./loop/profiles";
import { evaluateCodebaseRulesOnEdit } from "../.factory/hooks/loop-guard";
import {
  recordLapAttempt,
  shouldTriggerReflection,
  saveIssueDossier,
} from "./loop/dossier";
import { runPostIssueReflection } from "./loop/reflector";
import {
  loadPrompt,
  renderPrompt,
  resolveArchonCommandsDir,
} from "./loop/prompts";
import {
  setupArtifactDirectories,
  parseAgentReport,
  extractReport,
  validateEvidenceCitations,
} from "./loop/artifacts";

export type {
  LocalIssue,
  LoopRole,
  ProcessResult,
  AgentTransport,
  PiTransport,
  LocalLoopOptions,
  LoopEvidence,
  LocalLoopResult,
};

export {
  resolveArchonCommandsDir,
  renderPrompt,
  parseAgentReport,
  extractReport,
};

export const ARCHON_BUILDER_PROMPT = `# Make the move

You are the builder in an unattended development loop. The dispatcher has already chosen this
run's move; you do it, then stop. Two reviewers check your work right after you. Nobody is
watching: when something is in your way, work it out and keep going. Never wait for a human in
the middle of a run.

The move:
- Route: $INPUTS.route (\`continue\` addresses review findings on the PR below; \`simple\` implements the issue)
- Work item: $INPUTS.target
- Pull request: $INPUTS.pr
- Why it was chosen: $INPUTS.reason

## 1. Ground the contract

Read the issue body and comments completely before making changes:
- An issue comment headed \`Contract\` is the authoritative acceptance contract: build to it, criterion by criterion.
- For \`continue\`: inspect the PR diff, CI checks (\`gh pr checks <n>\`), review comments (\`Loop review:\` comments first), and previous builder reports. Address every identified finding directly with concrete code fixes and verifiable evidence.
- If a \`Loop review: not merged\` comment exists, inspect the refusal reason:
  - Code defects or failed pipeline steps: fix the root cause.
  - Base branch drift: merge the default branch in cleanly.
  - Review or evidence documentation gaps: update the record without touching working code.
- Read project steering conventions: \`engineering.md\`, \`MISSION.md\`, and product specs at the root or under \`docs/\`.

If the work item cannot be satisfied without changing what an in-repository check judges (adding skips, loosening thresholds, or ignoring edge cases) without owner approval, halt immediately: comment on the item, label it \`needs-owner\`, and report \`PR: none\`.

## 2. Implement with tight verification loops

1. **Branch workflow:** Work on the PR's branch, or create a delivery branch from the default branch (\`local-loop/issue-<number>-<id>\`). If another worktree holds the branch, use \`git checkout -B <branch> origin/<branch> --ignore-other-worktrees\`.
2. **Branch integration:** Keep the branch current strictly via \`git merge --no-edit origin/<default-branch>\`. Preserve commit history without rebasing or force-pushing.
3. **Smallest discriminating checks:** Iterate on the smallest unit test, frame, tick, or input path that isolates the behavior. Save exhaustive testing for final validation; running full end-to-end suites repeatedly on every edit wastes hours.
4. **Final validation:** Run the repository's ordinary checks once on your candidate commit (\`engineering.md\` or harness config). Save complete output to \`$ARTIFACTS_DIR/builder-checks.log\` so subsequent QA and review nodes reuse it without duplicate execution. If user-visible behavior changed, launch the app according to \`$INPUTS.runtime\` and verify the observable user path.
5. **Commit and push:** Commit with an imperative, conventional commit message (\`feat(...)\`, \`fix(...)\`). The host executor pushes to origin, opens or updates the PR with \`Closes #<n>\`, and ensures the PR is ready for review (\`gh pr ready <n>\`).

## 3. Pull Request Evidence Contract

Every pull request description must contain an \`## Evidence\` section before this step is complete:
- Map each contract criterion to its concrete verification evidence (command output line, log path, or test assertion) on your pushed candidate commit.
- If the change alters what an in-repository check samples or excuses, declare it under an explicit heading: \`### Judge Alterations (Requires Approval)\`.
- Detail the delivered changes, how criteria were satisfied, and any remaining context.

## 4. Boundaries & Invariants

- **Protected governance paths:** Keep all protected paths strictly untouched ($INPUTS.protected_paths). If a change is genuinely required, label \`needs-owner\` and explain.
- **Concurrency isolation:** Keep \`Loop claim\` comments untouched.
- **Process isolation:** Record process IDs (PIDs) for any spawned services or background tasks, and terminate every process you started before ending your turn. Apply an explicit timeout to every wait.
- **Filesystem scope:** Restrict all file operations to this checkout and \`$ARTIFACTS_DIR\`.

## 5. Completion & Report

Your turn is complete when all code changes are committed, pushed, project checks pass, the PR carries verified evidence, and you report your result.

Return your final report in JSON (plain or within a single \`\`\`json code fence):
\`\`\`json
{
  "candidate": "<full committed HEAD sha>",
  "verdict": "pass",
  "checks": [
    { "criterion": "<criterion id or check name>", "result": "pass", "evidence": "<concrete command output or test result>" }
  ],
  "findings": []
}
\`\`\`
Or finish with: \`PR: <full pull request URL>\` or \`PR: none\` followed by the reason.`;

export const ARCHON_QA_PROMPT = `# Check the app as a user would

You are the black-box tester in an unattended development loop. You did not write this change, and
you evaluate what the product does by running it—without reading its diff, its pull request description,
or its builder's report beforehand. A second reviewer inspects the diff after you, and a deterministic
merge gate lands only commits your evidence supports.

The move this run:
- Route: $INPUTS.route
- Work item: $INPUTS.target
- Pull request: $INPUTS.pr
- Verification profile: $INPUTS.profile
- Skip app launch: $INPUTS.skip_app_launch
- Candidate head commit: $INPUTS.head, against default branch \`$INPUTS.base\`
- Files changed:
\`\`\`
$INPUTS.files
\`\`\`

If no pull request URL is provided above, report \`overall: "NO PR"\` with an empty \`pr\` and no lines, state what is observable in \`summary\`, and stop.

## 1. What to test

Read the work item and its \`Contract\` comment (or acceptance criteria). Test whether the change satisfies the contract without breaking existing capabilities. Broad product exploration belongs to the manager on the default branch; focus your inspection on the behavior this change creates or affects.

## 2. Test Depth: $INPUTS.depth

Apply the depth selected for this work item's risk profile:
- **\`light\`** (internal refactors, tests, tools, documentation where user-observable behavior is unchanged): Build the app, run declared ordinary checks once, confirm the service starts cleanly, and verify contract criteria. Skip exploratory probes and holdouts.
- **\`normal\`** (default for user-visible features or fixes): Build, run ordinary checks once, and observe each contract criterion through the live app's public user surface. Execute up to three plausible user interaction variations beyond the criteria (\`probes\`). Run holdouts only if they exercise the modified behavior.
- **\`deep\`** (core architectural changes, security, authentication, data models, or migrations): Probe all states the change introduces; evaluate both public UI/CLI interfaces and automated harnesses; run all holdout scenarios touched by the modified files.

Sample decisive states and edge transitions rather than attempting combinatorial exhaustive input sweeps. Where the builder or host executor has already saved complete check logs on the identical commit under \`$ARTIFACTS_DIR\` (such as \`builder-checks.log\`), reuse those logs instead of repeating identical commands.

## 3. Verify what would merge (Detached Base Merge)

Because the landed artifact is this pull request merged with the current default branch, evaluate that exact integration state:
1. Check out the candidate head: \`gh pr checkout <n>\` (or \`git checkout -B <branch> origin/<branch> --ignore-other-worktrees\`). Verify HEAD matches $INPUTS.head.
2. Form a detached integration commit: \`git checkout --detach && git fetch origin $INPUTS.base && git merge --no-edit origin/$INPUTS.base\`.
3. If merge conflicts arise, record criterion \`C0: FAIL (Merge conflict with base branch)\` with \`overall: FAIL\`, and stop.
4. Record the resulting detached commit SHA as \`merged_with\`.

## 4. Black-Box Execution & Evidence

1. **Launch the application:** When "$INPUTS.skip_app_launch" is "false", start the app according to "$INPUTS.runtime" on its real code path rather than mock stubs. When "$INPUTS.skip_app_launch" is "true", do not launch background processes, HTTP servers, or browser drivers; evaluate criteria directly against modified files, syntax, and test logs.
2. **Drive the public surface:** Interact via documented CLI commands, HTTP endpoints, or driver libraries. Avoid using tools or scripts introduced in the PR itself to validate the PR's own claims.
3. **Record concrete artifacts:** Save every command log, curl output, screenshot, and measurement as an immutable file under \`$ARTIFACTS_DIR\`. Cite each piece of evidence by its absolute path.
4. **Line classification:**
   - Contract criteria (\`C1\`, \`C2\`...): \`PASS\`, \`FAIL\`, or \`INCOMPLETE\`.
   - Fenced holdouts (\`H1\`...): Scenarios evaluated via \`holdout-verifier\` subagent.
   - Probes (\`P1\`...): User variations (\`OK\` or \`SURPRISE\` pointing to a defect).
   - Defects (\`D1\`...): \`DEFECT\` for regressions introduced by this change, or \`QUESTION\` when unclear whether behavior is defective.
   - Noticed observations: Document pre-existing base flaws under \`noticed\` (narrative strings; not scored as PR defects).
5. **Clean process teardown:** Record PIDs of all background processes you start, and terminate them completely before finishing your turn.

## 5. Boundaries & Invariants

- **Read-only governance:** Do not push git commits, edit code, post GitHub comments, or mutate labels. The local detached merge above is temporary and never pushed.
- **Diff blindfold:** Do not inspect git diffs, PR descriptions, or builder comments prior to running tests. Only inspect diffs if an observed failure requires tracing a root cause for the summary.
- **Process hygiene:** Stop only processes you started, by PID. Do not terminate external browser sessions or system processes.

## 6. Report Format

Return your structured report in JSON (plain or within a single \`\`\`json code fence):
\`\`\`json
{
  "pr": "$INPUTS.pr",
  "head": "$INPUTS.head",
  "merged_with": "<commit of merge with default branch>",
  "lines": [
    {
      "id": "C1",
      "kind": "criterion",
      "verdict": "PASS",
      "text": "<observable user behavior or command result>",
      "evidence": ["<absolute file paths in $ARTIFACTS_DIR>"],
      "pre_existing": "",
      "defect": "",
      "carried_from": ""
    }
  ],
  "noticed": ["<pre-existing base observations not caused by this change>"],
  "overall": "PASS",
  "summary": "<concise summary of tested behaviors and depth>"
}
\`\`\`
\`overall\` must be \`PASS\` only when every criterion passed and zero defect lines remain. Any caveat or unverified criterion mandates \`FAIL\`.`;

export const ARCHON_REVIEWER_PROMPT = `# Review, then merge, send back, or return to the owner

You are the reviewer in an unattended development loop. You did not write this change, and you judge
it strictly on what it does, not on what anyone claims it does. Black-box QA has already tested the
running app; your job is to inspect the code diff, verify evidence integrity, and decide the outcome.
A deterministic merge gate runs after you, landing the candidate only if your record and evidence hold.

The move this run:
- Route: $INPUTS.route
- Work item: $INPUTS.target
- Pull request: $INPUTS.pr
- Builder's report: \`$INPUTS.handoff/builder.md\`
- QA report: \`$INPUTS.handoff/app-check.json\` (read this first)
- Evidence check: ok = $INPUTS.evidence_ok
- Evidence problems, if any: \`$INPUTS.handoff/evidence-problems.txt\`

## 1. When nothing was delivered

If QA reported \`overall: "NO PR"\`, no pull request was delivered. Leave one comment on the work item:
\`Loop review: no pull request\` explaining the observed situation. If the item has reached $INPUTS.rejections attempts without progress, label it \`needs-owner\`. Return outcome \`nothing\` or \`needs-owner\`.

## 2. Code Inspection & Verification (Standards & Spec Axes)

In this unattended loop, you conduct the code inspection directly as the independent reviewer across two unified evaluation axes. Do NOT attempt to delegate to external subagents; you are already running in a clean, separate reviewer session isolated from the builder. Evaluate both axes directly:

1. **Standards Axis:**
   - Inspect diff for code smells: Mysterious Name, Duplicated Code, Feature Envy, Shotgun Surgery, Divergent Change, Speculative Generality.
   - Verify compliance with documented repo rules in \`AGENTS.md\` and codebase conventions.
   - Protected paths: verify zero modifications to protected paths ($INPUTS.protected_paths). Any alteration mandates \`needs-owner\`.
   - Weakened tests: verify no skipped, commented-out, or loosened checks without owner approval.

2. **Spec Axis:**
   - Map every acceptance criterion and invariant in the source issue/contract to the implementation and evidence.
   - Verify that all QA lines in \`app-check.json\` (both criteria and runtime probes) pass or have valid dispositions.
   - Inspect for scope creep or behavioral regressions against \`$INPUTS.base\`.
   - Check CI status (\`gh pr checks <n>\`).

3. **Evidence & Preconditions:**
   - Candidate checkout: \`git checkout -B <branch> origin/<branch> --ignore-other-worktrees\`.
   - Reuse check outputs saved in \`$ARTIFACTS_DIR\` by builder and QA; re-run checks only if resolving contested lines.

## 3. Mandatory Line Dispositions

Assign exactly one disposition to every QA line that is not a plain \`PASS\` or \`OK\`:
- \`blocks\`: Regressions or failures caused by this change that must be fixed. Triggers \`sent-back\`.
- \`rechecked\`: You independently verified the app check was mistaken, citing your own fresh evidence file in \`$ARTIFACTS_DIR\`.
- \`pre-existing\`: The failure reproduces identically on the default branch. Cite your base run file and the open tracking issue.
- \`issue\`: A non-blocking question or defect to be tracked in a future issue.
- \`accepted\`: A question confirmed not to be a defect and invisible to end-users.

## 4. Decide Outcome

- **\`merge\` / \`approved\`:** Every criterion passed or was rechecked; holdouts passed or are tracked pre-existing; all defects resolved; zero regressions; zero protected paths touched; project checks clean. (Return \`merge\` when merge mode is auto; return \`approved\` when merge is human-gated).
- **\`sent-back\`:** The change has fixable defects. Detail exact required corrections with reproducible evidence. If the item has accumulated $INPUTS.rejections send-backs, return it to the owner instead.
- **\`needs-owner\`:** The work item requires human product direction, scope clarification, changes protected files, alters judge constants without approval, or hit the send-back limit.

## 5. Unified PR Review Comment

The host loop executor publishes the unified review comment on the pull request (or issue) starting with:
\`Loop review: <outcome> (route: $INPUTS.route)\`

Include all findings, dispositions, and your rationale in your final JSON report below so the host executor can post the exact review record.

## 6. Report Format

Return your final decision in JSON (plain or within a single \`\`\`json code fence):
\`\`\`json
{
  "outcome": "merge | sent-back | needs-owner | approved | nothing",
  "pr": "$INPUTS.pr",
  "sha": "$INPUTS.head",
  "delivers": "all | part | none",
  "dispositions": [
    {
      "line": "D1",
      "action": "blocks | rechecked | pre-existing | issue | accepted",
      "file": "",
      "issue": "",
      "reason": ""
    }
  ],
  "judge_changes": [],
  "reason": "<concise decision rationale>"
}
\`\`\``;

async function processRun(argv: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await processRun(["git", ...args], root, 30_000);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function validateIssue(issue: LocalIssue) {
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1 ||
    !issue.url.endsWith(`/issues/${issue.number}`) ||
    !issue.title.trim() ||
    !issue.body.trim()
  )
    throw new Error("Incomplete issue contract");
  if (issue.activeClaim !== false) throw new Error("Issue has an active or unverified claim");
  if (
    !Array.isArray(issue.dependencies) ||
    issue.dependencies.some((d) => d.number === issue.number || d.state !== "CLOSED")
  )
    throw new Error("Issue dependencies are unresolved");
}

export async function inspectLocalLoop(root: string) {
  const common = resolve(root, await git(root, "rev-parse", "--git-common-dir"));
  const primary = (await git(root, "worktree", "list", "--porcelain"))
    .split("\n")[0]!
    .replace(/^worktree /, "");
  for (const directory of new Set([root, primary, common])) {
    for (const brake of ["STOP", "PAUSE"]) {
      if (existsSync(join(directory, ".factory", brake)))
        throw new Error(`${brake} brake is active`);
    }
  }
  return { common, primary };
}

/**
 * Executes exactly ONE autonomous lap following the original Archon SDLC lifecycle:
 * pick/route -> claim -> build (loop-work) -> check-app (silent QA) -> handoff/evidence -> review (loop-review) -> land gate.
 */
export async function runLocalLoop(
  root: string,
  issue: LocalIssue,
  options: LocalLoopOptions = {},
): Promise<LocalLoopResult> {
  validateIssue(issue);
  const timeout = options.timeoutMs ?? 20 * 60_000;
  const { common } = await inspectLocalLoop(root);
  const base = await git(root, "rev-parse", "HEAD");
  const config = await Bun.file(join(root, "harness/harness.config.json")).json();
  const checks = [config.static, config.unit].filter(
    (s): s is string => typeof s === "string" && !!s.trim(),
  );
  if (!checks.length) throw new Error("No declared ordinary project checks");
  const protectedPaths = [
    ".factory/holdout/**",
    ".factory/hooks/**",
    ".claude/settings.json",
    "harness/**",
    ...String(config.protected_paths ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  ];

  // 1. DISCOVERY & ROUTING: Check if an open PR already exists for this issue
  let existingPr: { url: string; number: number; headRefName: string } | null = null;
  const prSearch = await processRun(
    ["gh", "pr", "list", "--state", "open", "--json", "number,url,headRefName,body"],
    root,
    30_000,
  );
  if (prSearch.exitCode === 0) {
    try {
      const openPrs = JSON.parse(prSearch.stdout);
      for (const pr of openPrs) {
        if (
          pr.headRefName?.includes(`issue-${issue.number}`) ||
          pr.body?.includes(`Closes #${issue.number}`) ||
          pr.body?.includes(`Refs #${issue.number}`)
        ) {
          existingPr = { url: pr.url, number: pr.number, headRefName: pr.headRefName };
          break;
        }
      }
    } catch {}
  }

  const route: "simple" | "continue" = existingPr ? "continue" : "simple";
  const runId = randomUUID();
  const stateRoot = join(common, "factory-local-loop");
  const runDirectory = join(stateRoot, "runs", runId);
  const { artifactsDir, handoffDir } = await setupArtifactDirectories(runDirectory);
  const lock = join(stateRoot, "locks", `issue-${issue.number}`);

  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch {
    throw new Error(`Issue ${issue.number} is locked; inspect ${lock} before manual release`);
  }

  const branch = existingPr
    ? existingPr.headRefName
    : `local-loop/issue-${issue.number}-${runId.slice(0, 8)}`;
  const initialProfile = issue.verificationProfile ?? resolveVerificationProfile(issue);
  const state: LocalLoopResult = {
    runId,
    issue: issue.url,
    route,
    status: "preparing",
    runDirectory,
    worktree: join(stateRoot, "worktrees", runId),
    branch,
    base,
    pr: existingPr?.url,
    verificationProfile: initialProfile,
    evidence: [],
  };

  const save = async () => {
    await Bun.write(join(runDirectory, "state.tmp"), JSON.stringify(state, null, 2));
    await rename(join(runDirectory, "state.tmp"), join(runDirectory, "state.json"));
  };

  const transport =
    options.transport ?? options.pi ?? ((req) => processRun(req.argv, req.cwd, req.timeoutMs));

  try {
    await Bun.write(
      join(lock, "owner.json"),
      JSON.stringify({
        runId,
        pid: process.pid,
        issue: issue.url,
        route,
        pr: state.pr,
        runDirectory,
        startedAt: new Date().toISOString(),
      }),
    );
    await Bun.write(join(runDirectory, "issue.json"), JSON.stringify(issue, null, 2));
    await save();

    // 2. ISOLATED WORKTREE ALLOCATION
    await mkdir(dirname(state.worktree), { recursive: true });
    if (route === "continue") {
      await git(root, "fetch", "origin", branch);
      await git(root, "worktree", "add", "--no-checkout", state.worktree, `origin/${branch}`);
      await git(state.worktree, "sparse-checkout", "set", "--no-cone", "/*", "!/.factory/holdout/");
      await git(state.worktree, "checkout", branch);
    } else {
      await git(root, "worktree", "add", "--no-checkout", "-b", branch, state.worktree, base);
      await git(state.worktree, "sparse-checkout", "set", "--no-cone", "/*", "!/.factory/holdout/");
      await git(state.worktree, "checkout", branch);
    }

    const assertCandidate = async (expectedCandidate?: string) => {
      await inspectLocalLoop(root);
      await inspectLocalLoop(state.worktree);
      if (await git(state.worktree, "status", "--porcelain", "--untracked-files=all"))
        throw new Error("Candidate has uncommitted or untracked changes");
      const head = await git(state.worktree, "rev-parse", "HEAD");
      if (expectedCandidate && expectedCandidate !== head)
        throw new Error("Candidate changed during verification");
      await git(state.worktree, "merge-base", "--is-ancestor", base, head);
      const changed = (await git(state.worktree, "diff", "--name-only", "--no-renames", base, head))
        .split("\n")
        .filter(Boolean);
      if (changed.some((p) => protectedPaths.some((pattern) => new Bun.Glob(pattern).match(p))))
        throw new Error("Candidate changed protected paths");

      // Deterministic codebase rules enforcement across all harnesses (Pi, Claude, Codex, OpenCode)
      for (const relPath of changed) {
        const fullPath = join(state.worktree, relPath);
        if (existsSync(fullPath)) {
          try {
            const content = readFileSync(fullPath, "utf-8");
            const ruleCheck = evaluateCodebaseRulesOnEdit(state.worktree, relPath, content);
            if (ruleCheck.blocked) {
              throw new Error(`Candidate violated codebase rules: ${ruleCheck.reasons.join("; ")}`);
            }
          } catch (err: any) {
            if (err.message.includes("Candidate violated codebase rules")) throw err;
          }
        }
      }

      return head;
    };

    // Dynamic prompt loading with modular fallback
    const getPromptTemplate = (name: string, fallback: string) => {
      try {
        return loadPrompt(name, root);
      } catch {
        return fallback;
      }
    };

    const builderTemplate = getPromptTemplate("loop-work", ARCHON_BUILDER_PROMPT);
    const qaTemplate = getPromptTemplate("loop-check-app", ARCHON_QA_PROMPT);
    const reviewerTemplate = getPromptTemplate("loop-review", ARCHON_REVIEWER_PROMPT);

    const holdoutPath = existsSync(join(root, ".factory/holdout/HOLDOUT.md"))
      ? join(root, ".factory/holdout/HOLDOUT.md")
      : "";

    const scheduleCfg = loadScheduleConfig(root);
    const maxLaps = scheduleCfg.max_laps ?? 3;
    const maxRejections = Math.max(1, maxLaps - 1);
    const invoke = async (role: LoopRole, candidate?: string, extraVars: Record<string, string> = {}) => {
      await inspectLocalLoop(root);
      state.status = role === "builder" ? "building" : role === "qa" ? "qa" : "reviewing";
      await save();

      const changedFilesList = candidate
        ? (await git(state.worktree, "diff", "--name-only", "--no-renames", base, candidate)).trim()
        : "";

      const currentFiles = changedFilesList
        ? changedFilesList.split("\n").map((s) => s.trim()).filter(Boolean)
        : [];
      const effectiveProfile = candidate
        ? resolveVerificationProfile(
            { ...issue, verificationProfile: issue.verificationProfile },
            currentFiles,
          )
        : initialProfile;
      state.verificationProfile = effectiveProfile;
      const profileInstructions = getProfileInstructions(effectiveProfile, root);

      const template = role === "builder"
        ? builderTemplate
        : role === "qa"
          ? qaTemplate
          : reviewerTemplate;

      const promptVars: Record<string, string> = {
        route,
        target: issue.url,
        pr: state.pr ?? "",
        reason: `Autonomous delivery for issue #${issue.number}: ${issue.title} [profile: ${effectiveProfile}]`,
        runtime: profileInstructions.runtimeInstructions,
        head: candidate ?? "HEAD",
        base,
        files: changedFilesList || "(all files in commit)",
        depth: profileInstructions.depth,
        profile: effectiveProfile,
        skip_app_launch: profileInstructions.skipAppLaunch ? "true" : "false",
        checks_status: existsSync(join(artifactsDir, "builder-checks.log")) ? "passed" : "pending",
        holdout: holdoutPath,
        protected_paths: protectedPaths.join(", "),
        handoff: handoffDir,
        evidence_ok: extraVars.evidence_ok ?? "true",
        merge: "approve",
        rejections: String(maxRejections),
        ...extraVars,
      };

      const prompt = renderPrompt(template, promptVars, artifactsDir);

      // Provider, Model, & Effort Tiering from .archon/config.yaml or option override
      const roleProvider = options.provider ?? resolveProviderForRole(root, role);
      const roleModel = options.model ?? resolveModelForRole(root, role);
      const roleEffort = options.effort ?? resolveEffortForRole(root, role);

      const stepNum = role === "builder" ? 0 : role === "qa" ? 1 : 2;
      const sessionDirectory = join(runDirectory, `${stepNum}-${role}-session`);
      await mkdir(sessionDirectory, { recursive: true });
      const argv = buildProviderArgv(roleProvider, {
        model: roleModel,
        effort: roleEffort,
        prompt,
        sessionDir: sessionDirectory,
        skills: resolveAllowedSkills(root, role),
        extensions: resolveLoopExtensions(root),
        appendSystemPrompts: buildCuratedAppendPrompts(root, issue, changedFilesList),
      });

      const result = await transport({
        argv,
        cwd: state.worktree,
        role,
        provider: roleProvider,
        timeoutMs: timeout,
      });
      const artifact = join(runDirectory, `${role}.json`);
      await Bun.write(artifact, JSON.stringify(result));
      const head = await git(state.worktree, "rev-parse", "HEAD");
      state.evidence.push({
        kind: roleProvider === "pi" ? "pi" : (roleProvider as any),
        role,
        round: 0,
        candidate: head,
        artifact,
        exitCode: result.exitCode,
        provider: roleProvider,
        effort: roleEffort,
      });
      await save();
      if (result.exitCode !== 0) throw new Error(`${roleProvider} ${role} process failed; see ${artifact}`);
      return extractReport(result.stdout, head);
    };

    // -------------------------------------------------------------
    // STAGE 1: BUILDER (loop-work)
    // -------------------------------------------------------------
    const builderReport = await invoke("builder");
    state.candidate = await assertCandidate();

    await Bun.write(
      join(handoffDir, "builder.md"),
      `# Builder Report\n\nCandidate: ${state.candidate}\nVerdict: ${builderReport.verdict}\n\n` +
        (builderReport.checks?.map((c: any) => `- ${c.criterion}: ${c.result} (${c.evidence})`).join("\n") || "No explicit checks"),
    );

    if (options.push !== false) {
      try {
        await git(state.worktree, "push", "-u", "origin", branch);
        if (!state.pr) {
          const prView = await processRun(
            ["gh", "pr", "view", branch, "--json", "url"],
            state.worktree,
            15_000,
          );
          if (prView.exitCode === 0) {
            try {
              const parsed = JSON.parse(prView.stdout);
              if (parsed.url) state.pr = parsed.url;
            } catch {}
          }
        }
        if (!state.pr) {
          const body = [
            `Closes #${issue.number}`,
            "",
            "## Summary",
            `Autonomous delivery for issue #${issue.number}: ${issue.title}`,
            "",
            "## Evidence",
            `- **Candidate Head**: \`${state.candidate}\``,
            `- **Route**: ${route}`,
            "",
            "### Verification Checks",
            ...(builderReport.checks?.map(
              (c: any) => `- [x] **${c.criterion}**: \`${c.result}\` (${c.evidence})`,
            ) || ["- [x] Initial build & verification complete"]),
            "",
            "> **Archon SDLC Note**: Black-box QA and Code Review run on this PR.",
          ].join("\n");

          const prCreate = await processRun(
            ["gh", "pr", "create", "--head", branch, "--title", issue.title, "--body", body],
            state.worktree,
            30_000,
          );
          if (prCreate.exitCode === 0) {
            state.pr = prCreate.stdout.trim();
          }
        }
      } catch (pushErr: any) {
        console.error("Warning: Git push / PR synchronization error:", pushErr.message);
      }
    }

    // -------------------------------------------------------------
    // STAGE 2: ORDINARY CHECKS
    // -------------------------------------------------------------
    state.status = "checking";
    await save();
    const checkOutputs: string[] = [];
    for (let i = 0; i < checks.length; i++) {
      await inspectLocalLoop(root);
      const result = await processRun(["sh", "-c", checks[i]!], state.worktree, timeout);
      const artifact = join(runDirectory, `check-${i}.json`);
      await Bun.write(artifact, JSON.stringify({ command: checks[i], ...result }));
      checkOutputs.push(`Check [${checks[i]}]: exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
      state.evidence.push({
        kind: "check",
        round: 0,
        candidate: state.candidate,
        artifact,
        exitCode: result.exitCode,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Ordinary project check failed: ${checks[i]}`);
      }
    }
    await Bun.write(join(artifactsDir, "builder-checks.log"), checkOutputs.join("\n\n"));
    await assertCandidate(state.candidate);

    // -------------------------------------------------------------
    // STAGE 3: BLACK-BOX QA (loop-check-app)
    // -------------------------------------------------------------
    const qaReport = await invoke("qa", state.candidate);
    await assertCandidate(state.candidate);

    await Bun.write(join(handoffDir, "app-check.json"), JSON.stringify(qaReport, null, 2));
    await Bun.write(join(artifactsDir, "app-check.json"), JSON.stringify(qaReport, null, 2));

    const { ok: evidenceOkBool, problems: evidenceProblems } = validateEvidenceCitations(qaReport, artifactsDir);
    await Bun.write(join(handoffDir, "evidence-problems.txt"), evidenceProblems.join("\n"));
    const evidenceOk = evidenceOkBool ? "true" : "false";

    // -------------------------------------------------------------
    // STAGE 4: CODE REVIEW (loop-review)
    // -------------------------------------------------------------
    const reviewReport = await invoke("reviewer", state.candidate, { evidence_ok: evidenceOk });
    await assertCandidate(state.candidate);
    await Bun.write(join(artifactsDir, "review.json"), JSON.stringify(reviewReport, null, 2));

    const isApproved = qaReport.passed && reviewReport.passed;
    const reviewOutcome = isApproved ? "approved" : "sent back";
    const finalStatus = isApproved ? "waiting_approval" : "sent_back";

    const changedFilesFinal = (
      await git(state.worktree, "diff", "--name-only", "--no-renames", base, state.candidate)
    )
      .split("\n")
      .filter(Boolean);

    const dossier = recordLapAttempt(
      stateRoot,
      {
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        branch,
        prUrl: state.pr,
      },
      {
        runId,
        timestamp: new Date().toISOString(),
        status: finalStatus,
        candidateHead: state.candidate,
        changedFiles: changedFilesFinal,
        failedStage: isApproved ? undefined : !qaReport.passed ? "qa" : "reviewer",
        reviewFindings: Array.isArray(reviewReport.findings) ? reviewReport.findings : [],
        qaFailures: Array.isArray(qaReport.checks)
          ? qaReport.checks
              .filter((c: any) => c.result !== "pass")
              .map((c: any) => `${c.criterion}: ${c.evidence}`)
          : [],
      },
    );

    if (shouldTriggerReflection(dossier, { maxRejections })) {
      state.status = "reflecting";
      await save();
      const reflection = await runPostIssueReflection({
        root,
        worktree: state.worktree,
        dossier,
        artifactsDir,
        transport,
        timeoutMs: timeout,
      });
      await Bun.write(join(artifactsDir, "reflection.json"), JSON.stringify(reflection, null, 2));
      dossier.reflectedAt = new Date().toISOString();
      saveIssueDossier(stateRoot, dossier);
    }

    state.status = finalStatus;

    if (state.pr) {
      const commentLines = [
        `### Loop review: ${reviewOutcome} (route: ${route})`,
        "",
        `**Candidate**: \`${state.candidate}\``,
        `**Blast Radius**: ${changedFilesFinal.length} file(s) modified`,
        "",
        ...(qaReport.summary
          ? [
              "#### 📝 Summary of Observed Behavior:",
              qaReport.summary,
              "",
            ]
          : []),
        "#### 🧪 Black-box QA Verification:",
        ...(qaReport.checks?.map((c: any) => {
          const isPass = c.result === "pass" || c.result === "ok";
          const label = c.kind === "probe" ? "Runtime Probe" : "Criteria";
          const desc = c.text ? ` - ${c.text}` : c.evidence ? ` (${c.evidence})` : "";
          return `- [${isPass ? "x" : " "}] **${c.criterion} (${label})**${desc}`;
        }) || ["- No QA checks reported"]),
        "",
        "#### 🔍 Code Review Findings:",
        ...(reviewReport.findings?.length
          ? reviewReport.findings.map((f: string) => `- ${f}`)
          : ["- No blocking standards or specification findings."]),
        "",
        ...(reviewReport.reason
          ? [
              "#### 🧐 Reviewer Decision & Rationale:",
              reviewReport.reason,
              "",
            ]
          : []),
        ...(Array.isArray(reviewReport.dispositions) && reviewReport.dispositions.length > 0
          ? [
              "#### 📋 Dispositions:",
              ...reviewReport.dispositions.map(
                (d: any) => `- **${d.line}** (${d.action}): ${d.reason || d.issue || d.file}`,
              ),
              "",
            ]
          : []),
        ...(Array.isArray(qaReport.noticed) && qaReport.noticed.length > 0
          ? [
              "#### ℹ️ Noticed (not this change's):",
              ...qaReport.noticed.map((n: string) => `- ${n}`),
              "",
            ]
          : []),
        isApproved
          ? "✅ **Candidate verified and approved.** Awaiting human merge approval (`merge=approve`)."
          : "⚠️ **Work item sent back.** Review feedback has been recorded for the next lap.",
      ];

      const commentProc = await processRun(
        ["gh", "pr", "comment", state.pr, "--body", commentLines.join("\n")],
        state.worktree,
        30_000,
      );
      if (commentProc.exitCode === 0) {
        state.reviewCommentUrl = commentProc.stdout.trim();
      }
    }

    await save();
    return state;
  } catch (error) {
    state.status = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    try {
      const dossier = recordLapAttempt(
        stateRoot,
        {
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          branch,
          prUrl: state.pr,
        },
        {
          runId,
          timestamp: new Date().toISOString(),
          status: "failed",
          candidateHead: state.candidate,
          changedFiles: [],
          failedStage: state.evidence.some((e) => e.kind === "check" && e.exitCode !== 0)
            ? "ordinary_checks"
            : "builder",
          errorExcerpt: state.error,
          reviewFindings: [],
          qaFailures: [],
        },
      );
      if (shouldTriggerReflection(dossier)) {
        const reflection = await runPostIssueReflection({
          root,
          worktree: existsSync(state.worktree) ? state.worktree : root,
          dossier,
          artifactsDir,
          transport,
          timeoutMs: timeout,
        });
        await Bun.write(join(artifactsDir, "reflection.json"), JSON.stringify(reflection, null, 2));
        dossier.reflectedAt = new Date().toISOString();
        saveIssueDossier(stateRoot, dossier);
      }
    } catch {}
    await save();
    return state;
  } finally {
    try {
      await Bun.spawn(["rm", "-rf", lock]).exited;
    } catch {}
  }
}
