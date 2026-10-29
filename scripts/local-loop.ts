import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface LocalIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  comments: string[];
  dependencies: { number: number; state: string }[];
  activeClaim: boolean;
}

export type LoopRole = "builder" | "qa" | "reviewer";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PiTransport = (request: {
  argv: string[];
  cwd: string;
  role: LoopRole;
  timeoutMs: number;
}) => Promise<ProcessResult>;

export interface LocalLoopOptions {
  pi?: PiTransport;
  model?: string;
  timeoutMs?: number;
  push?: boolean;
}

export interface LoopEvidence {
  kind: "pi" | "check";
  role?: LoopRole;
  candidate: string;
  artifact: string;
  exitCode: number;
}

export interface LocalLoopResult {
  runId: string;
  issue: string;
  route: "simple" | "continue";
  status:
    | "preparing"
    | "building"
    | "checking"
    | "qa"
    | "reviewing"
    | "waiting_approval"
    | "sent_back"
    | "needs_owner"
    | "failed";
  runDirectory: string;
  worktree: string;
  branch: string;
  base: string;
  candidate?: string;
  pr?: string;
  reviewCommentUrl?: string;
  evidence: LoopEvidence[];
  error?: string;
}

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

export function parseAgentReport(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const blocks = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
    if (blocks.length !== 1) {
      throw new Error(
        "Agent report must contain one JSON object, either plain or in one code fence",
      );
    }
    try {
      return JSON.parse(blocks[0]![1]!);
    } catch {
      throw new Error("Agent report contains invalid JSON in its code fence");
    }
  }
}

function extractReport(stdout: string, candidate: string) {
  let message:
    | { role?: string; stopReason?: string; content?: { type: string; text?: string }[] }
    | undefined;
  let settled = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant")
        message = event.message;
      if (event.type === "agent_start") settled = false;
      if (event.type === "agent_settled") settled = event.aborted === false;
    } catch {}
  }
  if (!settled || !message || message.stopReason !== "stop" || !Array.isArray(message.content))
    throw new Error("Pi did not settle with a final assistant response");
  const textContent = message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  const value = parseAgentReport(textContent);
  if (
    !value ||
    typeof value !== "object" ||
    value.candidate !== candidate ||
    !["pass", "fail", "blocked"].includes(value.verdict) ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.checks)
  )
    throw new Error("Missing, malformed or stale candidate-bound checks/review verdict");
  return {
    ...value,
    passed:
      value.verdict === "pass" &&
      value.checks.every((c: { result: string }) => c.result === "pass"),
  };
}

/**
 * Executes exactly ONE autonomous lap following the original Archon SDLC lifecycle:
 * pick/route -> claim -> build -> check-app (silent QA) -> review (posts 1 unified PR comment) -> land gate.
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
    evidence: [],
  };

  const save = async () => {
    await Bun.write(join(runDirectory, "state.tmp"), JSON.stringify(state, null, 2));
    await rename(join(runDirectory, "state.tmp"), join(runDirectory, "state.json"));
  };

  try {
    await mkdir(runDirectory, { recursive: true });
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
      // Checkout existing PR branch
      await git(root, "fetch", "origin", branch);
      await git(root, "worktree", "add", "--no-checkout", state.worktree, `origin/${branch}`);
      await git(state.worktree, "sparse-checkout", "set", "--no-cone", "/*", "!/.factory/holdout/");
      await git(state.worktree, "checkout", branch);
    } else {
      // New delivery branch from base
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
      return head;
    };

    const model = options.model ?? process.env.FACTORY_LOOP_MODEL;
    const pi = options.pi ?? ((req) => processRun(req.argv, req.cwd, req.timeoutMs));

    const invoke = async (role: LoopRole, candidate?: string) => {
      await inspectLocalLoop(root);
      state.status = role === "builder" ? "building" : role === "qa" ? "qa" : "reviewing";
      await save();

      let roleSpecificInstructions = "";
      if (role === "builder") {
        roleSpecificInstructions = [
          "You are the BUILDER.",
          "Implement the issue, run relevant checks locally, and commit all delivery changes.",
          "Write a comprehensive commit message following project standards.",
          route === "continue"
            ? `Read the latest review feedback on PR ${state.pr} and fix all noted findings.`
            : "Implement the specification cleanly.",
        ].join("\n");
      } else if (role === "qa") {
        roleSpecificInstructions = [
          "You are the BLACK-BOX APP CHECKER (QA).",
          "You DO NOT inspect source code diffs or commit implementations.",
          "Your job is to test the product as a user/caller through real HTTP/API/CLI entrypoints.",
          "Execute real scenarios in isolated test environments to verify each acceptance criterion.",
          "You do NOT post any comments to GitHub. Only return your structured test report.",
        ].join("\n");
      } else {
        roleSpecificInstructions = [
          "You are the INDEPENDENT CODE REVIEWER.",
          "Inspect the diff, adherence to documented coding standards, and the QA test results.",
          "Verify that acceptance criteria are truthfully met without scope creep or weakened checks.",
          "You are the ONLY agent that decides the outcome: merge, sent-back, or needs-owner.",
        ].join("\n");
      }

      const prompt = [
        `Role: ${role}. Work item: ${issue.url}. Route: ${route}. Fresh independent session.`,
        roleSpecificInstructions,
        "Never push directly or merge into base. Merging is strictly reserved for human approval.",
        "Read AGENTS.md and ordinary docs. Do NOT modify protected paths: " +
          protectedPaths.join(", "),
        JSON.stringify({
          issue,
          route,
          pr: state.pr,
          candidate: candidate ?? "Use your final committed HEAD",
        }),
        'Final response must be ONLY JSON: {"candidate":"full HEAD sha","verdict":"pass|fail|blocked","checks":[{"criterion":"AC identifier or scenario","result":"pass|fail|blocked|not_run","evidence":"concrete command/scenario and observed result"}],"findings":["concrete problem"]}. Never assert unexecuted checks passed.',
      ].join("\n");

      const sessionDirectory = join(runDirectory, `${role}-session`);
      const argv = [
        "pi",
        "--print",
        "--mode",
        "json",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
        "--session-dir",
        sessionDirectory,
        ...(model ? ["--model", model] : []),
        "--",
        prompt,
      ];

      const result = await pi({ argv, cwd: state.worktree, role, timeoutMs: timeout });
      const artifact = join(runDirectory, `${role}.json`);
      await Bun.write(artifact, JSON.stringify(result));
      const head = await git(state.worktree, "rev-parse", "HEAD");
      state.evidence.push({
        kind: "pi",
        role,
        candidate: head,
        artifact,
        exitCode: result.exitCode,
      });
      await save();
      if (result.exitCode !== 0) throw new Error(`Pi ${role} process failed; see ${artifact}`);
      return extractReport(result.stdout, head);
    };

    // -------------------------------------------------------------
    // STAGE 1: BUILDER
    // -------------------------------------------------------------
    const builderReport = await invoke("builder");
    state.candidate = await assertCandidate();

    // In Archon SDLC: Builder pushes branch and opens / updates PR immediately
    if (options.push !== false) {
      try {
        await git(state.worktree, "push", "-u", "origin", branch);
        if (!state.pr) {
          const body = [
            `Closes #${issue.number}`,
            "",
            "## Summary",
            `Autonomous delivery for issue #${issue.number}: ${issue.title}`,
            "",
            "## PR Evidence",
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
    for (let i = 0; i < checks.length; i++) {
      await inspectLocalLoop(root);
      const result = await processRun(["sh", "-c", checks[i]!], state.worktree, timeout);
      const artifact = join(runDirectory, `check-${i}.json`);
      await Bun.write(artifact, JSON.stringify({ command: checks[i], ...result }));
      state.evidence.push({
        kind: "check",
        candidate: state.candidate,
        artifact,
        exitCode: result.exitCode,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Ordinary project check failed: ${checks[i]}`);
      }
    }
    await assertCandidate(state.candidate);

    // -------------------------------------------------------------
    // STAGE 3: BLACK-BOX QA (check-app) - NO GITHUB COMMENTS!
    // -------------------------------------------------------------
    const qaReport = await invoke("qa", state.candidate);
    await assertCandidate(state.candidate);

    // -------------------------------------------------------------
    // STAGE 4: CODE REVIEW (review) - POSTS EXACTLY ONE PR COMMENT
    // -------------------------------------------------------------
    const reviewReport = await invoke("reviewer", state.candidate);
    await assertCandidate(state.candidate);

    // Format single unified Archon review comment
    const isApproved = qaReport.passed && reviewReport.passed;
    const reviewOutcome = isApproved ? "approved" : "sent back";
    state.status = isApproved ? "waiting_approval" : "sent_back";

    if (state.pr) {
      const commentLines = [
        `### Loop review: ${reviewOutcome} (route: ${route})`,
        "",
        `**Candidate**: \`${state.candidate}\``,
        "",
        "#### 🧪 Black-box QA Verification:",
        ...(qaReport.checks?.map(
          (c: any) => `- [${c.result === "pass" ? "x" : " "}] **${c.criterion}**: ${c.evidence}`,
        ) || ["- No QA checks reported"]),
        "",
        "#### 🔍 Code Review Findings:",
        ...(reviewReport.findings?.length
          ? reviewReport.findings.map((f: string) => `- ${f}`)
          : ["- No blocking standards or specification findings."]),
        "",
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
    await save();
    return state;
  } finally {
    // Release per-issue lock at lap termination so next lap can proceed
    try {
      await Bun.spawn(["rm", "-rf", lock]).exited;
    } catch {}
  }
}
