import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  runLocalLoop,
  parseAgentReport,
  extractReport,
  renderPrompt,
  resolveAnimusCommandsDir,
  ANIMUS_BUILDER_PROMPT,
  ANIMUS_QA_PROMPT,
  ANIMUS_REVIEWER_PROMPT,
  formatBuilderComment,
  formatEscalationHandoff,
  type LocalIssue,
  type PiTransport,
} from "../../scripts/local-loop";

test("accepts a single fenced JSON report without discarding findings and rejects ambiguous or invalid reports", () => {
  const value = { candidate: "abc", verdict: "pass", findings: ["must fix"], checks: [] };
  expect(parseAgentReport(JSON.stringify(value))).toEqual(value);
  expect(parseAgentReport(`QA summary\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``)).toEqual(
    value,
  );
  expect(() => parseAgentReport("I checked it, looks good")).toThrow();
  expect(() => parseAgentReport("```json\n{}\n```\n```json\n{}\n```")).toThrow();
  expect(() => parseAgentReport("```json\ninvalid\n```")).toThrow();
});

test("extractReport normalizes Canonical Animus check-app structured reports", () => {
  const canonicalCheckApp = {
    pr: "https://github.com/owner/repo/pull/1",
    head: "abc1234",
    merged_with: "def5678",
    lines: [
      {
        id: "C1",
        kind: "criterion",
        verdict: "PASS",
        text: "endpoint returns 200",
        evidence: ["artifacts/curl.log"],
        pre_existing: "",
        defect: "",
        carried_from: "",
      },
    ],
    noticed: ["minor deprecation warning"],
    overall: "PASS",
    summary: "All contract criteria observed passing.",
  };

  const stdout = [
    JSON.stringify({ type: "agent_settled", aborted: false }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(canonicalCheckApp) }],
      },
    }),
  ].join("\n");

  const report = extractReport(stdout, "abc1234");
  expect(report.passed).toBe(true);
  expect(report.verdict).toBe("pass");
  expect(report.candidate).toBe("abc1234");
  expect(report.checks[0].criterion).toBe("C1");
  expect(report.checks[0].result).toBe("pass");
  expect(report.checks[0].evidence).toBe("artifacts/curl.log");
  expect(report.noticed).toContain("minor deprecation warning");
});

test("extractReport normalizes Canonical Animus review structured reports", () => {
  const canonicalReview = {
    outcome: "merge",
    pr: "https://github.com/owner/repo/pull/1",
    sha: "abc1234",
    delivers: "all",
    dispositions: [
      {
        line: "D1",
        action: "accepted",
        file: "",
        issue: "",
        reason: "non-blocking question",
      },
    ],
    judge_changes: [],
    reason: "Diff verified cleanly.",
  };

  const stdout = [
    JSON.stringify({ type: "agent_settled", aborted: false }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(canonicalReview) }],
      },
    }),
  ].join("\n");

  const report = extractReport(stdout, "abc1234");
  expect(report.passed).toBe(true);
  expect(report.verdict).toBe("pass");
  expect(report.candidate).toBe("abc1234");
  expect(report.checks[0].criterion).toBe("review-outcome");
  expect(report.delivers).toBe("all");
});

test("renderPrompt interpolates $INPUTS and $ARTIFACTS_DIR cleanly", () => {
  const template = "Work on $INPUTS.target with $INPUTS.route in $ARTIFACTS_DIR";
  const rendered = renderPrompt(
    template,
    { target: "https://github.com/test/issues/1", route: "simple" },
    "/tmp/artifacts",
  );
  expect(rendered).toBe("Work on https://github.com/test/issues/1 with simple in /tmp/artifacts");
});

test("Animus prompt templates include canonical SDLC roles and strict contracts", () => {
  const root = resolve(import.meta.dir, "../..");
  const dir = resolveAnimusCommandsDir(root);
  if (dir) {
    expect(existsSync(dir)).toBe(true);
  }

  expect(ANIMUS_BUILDER_PROMPT).toContain("# Make the move");
  expect(ANIMUS_BUILDER_PROMPT).toContain("Two reviewers check your work right after you.");
  expect(ANIMUS_BUILDER_PROMPT).toContain("Evidence");

  expect(ANIMUS_QA_PROMPT).toContain("# Check the app as a user would");
  expect(ANIMUS_QA_PROMPT).toContain("You are the black-box tester");
  expect(ANIMUS_QA_PROMPT).toContain("merged_with");

  expect(ANIMUS_REVIEWER_PROMPT).toContain(
    "# Review, then merge, send back, or return to the owner",
  );
  expect(ANIMUS_REVIEWER_PROMPT).toContain("dispositions");
  expect(ANIMUS_REVIEWER_PROMPT).toContain("Loop review:");
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: root });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-loop-"));
  roots.push(root);
  git(root, "init");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Offline Test");
  await mkdir(join(root, "harness"));
  await Bun.write(
    join(root, "harness/harness.config.json"),
    JSON.stringify({
      static: "true",
      unit: "true",
      unit_count_pattern: "(\\d+) passed",
      protected_paths: "MISSION.md",
    }),
  );
  await Bun.write(join(root, "README.md"), "# Base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  return root;
}

test("executes one clean lap: builder commits, checks run, QA silent, reviewer posts verdict", async () => {
  const root = await fixture();
  const issue: LocalIssue = {
    number: 72,
    url: "https://github.com/owner/repo/issues/72",
    title: "fix brakes",
    body: "fix it",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };

  const capturedRoles: string[] = [];
  const transport: PiTransport = async ({ cwd, role }) => {
    capturedRoles.push(role);
    if (role === "builder") {
      await Bun.write(join(cwd, "fix.txt"), "fixed");
      git(cwd, "add", "fix.txt");
      git(cwd, "commit", "-m", "fix issue 72");
    }
    const head = git(cwd, "rev-parse", "HEAD");
    return {
      exitCode: 0,
      stdout:
        JSON.stringify({
          type: "agent_settled",
          aborted: false,
        }) +
        "\n" +
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  candidate: head,
                  verdict: "pass",
                  checks: [{ criterion: "AC1", result: "pass", evidence: "unit test ok" }],
                  findings: [],
                }),
              },
            ],
          },
        }),
      stderr: "",
    };
  };

  const res = await runLocalLoop(root, issue, { pi: transport, push: false });
  expect(res.status).toBe("waiting_approval");
  expect(res.route).toBe("simple");
  expect(res.evidence.filter((e) => e.kind === "pi")).toHaveLength(3); // builder, qa, reviewer

  // Verifies Animus 1:1 artifact and handoff structure
  const handoffDir = join(res.runDirectory, "artifacts", "handoff");
  expect(existsSync(join(handoffDir, "builder.md"))).toBe(true);
  expect(existsSync(join(handoffDir, "app-check.json"))).toBe(true);
  expect(existsSync(join(handoffDir, "evidence-problems.txt"))).toBe(true);

  // Verifies session directory numbering for loop:watch
  expect(existsSync(join(res.runDirectory, "0-builder-session"))).toBe(true);
  expect(existsSync(join(res.runDirectory, "1-qa-session"))).toBe(true);
  expect(existsSync(join(res.runDirectory, "2-reviewer-session"))).toBe(true);

  // Verifies evidence round numbering
  for (const ev of res.evidence) {
    expect(ev.round).toBe(0);
  }
});

test("executes autonomous lap with alternative provider harness (e.g. claude)", async () => {
  const root = await fixture();
  const issue: LocalIssue = {
    number: 73,
    url: "https://github.com/animus/animus/issues/73",
    title: "Support Claude Harness",
    body: "AC1: claude harness runs cleanly",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };

  const capturedProviders: string[] = [];
  const claudeTransport = async ({
    cwd,
    role,
    provider,
    argv,
  }: {
    cwd: string;
    role: string;
    provider?: string;
    argv: string[];
  }) => {
    capturedProviders.push(provider ?? "");
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--effort");
    expect(argv).toContain("high");

    if (role === "builder") {
      await Bun.write(join(cwd, "claude-fix.txt"), "fixed by claude");
      git(cwd, "add", "claude-fix.txt");
      git(cwd, "commit", "-m", "fix issue 73 with claude");
    }
    const head = git(cwd, "rev-parse", "HEAD");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                candidate: head,
                verdict: "pass",
                checks: [{ criterion: "AC1", result: "pass", evidence: "unit test ok" }],
                findings: [],
              }),
            },
          ],
        },
      }),
      stderr: "",
    };
  };

  const claudeRes = await runLocalLoop(root, issue, {
    provider: "claude",
    effort: "high",
    transport: claudeTransport,
    push: false,
  });

  expect(claudeRes.status).toBe("waiting_approval");
  expect(capturedProviders).toEqual(["claude", "claude", "claude"]);
  expect(claudeRes.evidence.filter((e) => e.kind === "claude")).toHaveLength(3);
  for (const ev of claudeRes.evidence.filter((e) => e.kind === "claude")) {
    expect(ev.provider).toBe("claude");
    expect(ev.effort).toBe("high");
  }
});

test("triggers post-issue terminal reflection when Lap 0 is sent_back and Lap 1 is approved", async () => {
  const root = await fixture();
  const issue: LocalIssue = {
    number: 88,
    url: "https://github.com/owner/repo/issues/88",
    title: "handle dynamic port in launcher",
    body: "fix launcher port 0 crash",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };

  let lapRound = 0;
  const rolesInvoked: string[] = [];

  const transport: PiTransport = async ({ cwd, role }) => {
    rolesInvoked.push(`${lapRound}:${role}`);
    if (role === "builder") {
      await Bun.write(join(cwd, "fix.txt"), `attempt-${lapRound}`);
      git(cwd, "add", "fix.txt");
      git(cwd, "commit", "-m", `attempt ${lapRound}`);
    }
    const head = git(cwd, "rev-parse", "HEAD");

    if (role === "reflector") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          attribution: "helped",
          candidate_lessons: [
            {
              topic: "launcher-port-binding",
              trigger_patterns: ["fix.txt"],
              rule: "Resolve dynamic port before passing FACTORY_HOST_URL to backend.",
              evidence: "Lap 0 sent_back by reviewer; Lap 1 approved after resolving port.",
            },
          ],
        }),
        stderr: "",
      };
    }

    // Lap 0: reviewer sends back; Lap 1: reviewer approves
    const isRejected = lapRound === 0 && role === "reviewer";
    return {
      exitCode: 0,
      stdout:
        JSON.stringify({ type: "agent_settled", aborted: false }) +
        "\n" +
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  candidate: head,
                  verdict: isRejected ? "fail" : "pass",
                  checks: [
                    {
                      criterion: "AC1",
                      result: isRejected ? "fail" : "pass",
                      evidence: isRejected ? "port 0 rejected" : "port resolved",
                    },
                  ],
                  findings: isRejected ? ["Port 0 causes crash"] : [],
                }),
              },
            ],
          },
        }),
      stderr: "",
    };
  };

  // Run Lap 0 -> sent_back (NO reflection yet)
  const resLap0 = await runLocalLoop(root, issue, { pi: transport, push: false });
  expect(resLap0.status).toBe("sent_back");
  expect(rolesInvoked).toEqual(["0:builder", "0:qa", "0:reviewer"]);
  expect(existsSync(join(resLap0.runDirectory, "artifacts", "reflection.json"))).toBe(false);

  // Run Lap 1 -> waiting_approval (Contrastive reflection triggers automatically!)
  lapRound = 1;
  const resLap1 = await runLocalLoop(root, issue, { pi: transport, push: false });
  expect(resLap1.status).toBe("waiting_approval");
  expect(rolesInvoked).toEqual([
    "0:builder",
    "0:qa",
    "0:reviewer",
    "1:builder",
    "1:qa",
    "1:reviewer",
    "1:reflector",
  ]);
  expect(existsSync(join(resLap1.runDirectory, "artifacts", "reflection.json"))).toBe(true);
  expect(existsSync(join(root, ".factory/lessons.jsonl"))).toBe(true);
});

test("executes lap with verification profile: docs profile instructs QA to skip app launch", async () => {
  const root = await fixture();
  const issue: LocalIssue = {
    number: 105,
    url: "https://github.com/owner/repo/issues/105",
    title: "docs: update API overview and architecture notes",
    body: "AC1: update README.md and documentation without regressions",
    comments: [],
    dependencies: [],
    activeClaim: false,
    labels: ["profile:docs"],
  };

  let capturedQaPrompt = "";
  const transport: PiTransport = async ({ cwd, role, argv }) => {
    if (role === "builder") {
      await Bun.write(join(cwd, "docs.md"), "# Documentation\nUpdated.\n");
      git(cwd, "add", "docs.md");
      git(cwd, "commit", "-m", "docs: update documentation");
    }
    if (role === "qa") {
      capturedQaPrompt = argv.at(-1) ?? "";
    }
    const head = git(cwd, "rev-parse", "HEAD");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                candidate: head,
                verdict: "pass",
                checks: [{ criterion: "AC1", result: "pass", evidence: "docs verified" }],
                findings: [],
              }),
            },
          ],
        },
      }),
      stderr: "",
    };
  };

  const res = await runLocalLoop(root, issue, { pi: transport, push: false });
  expect(res.status).toBe("waiting_approval");
  expect(res.verificationProfile).toBe("docs");
  expect(capturedQaPrompt).toContain("Skip app launch: true");
  expect(capturedQaPrompt).toContain("Verification profile: docs");
  expect(capturedQaPrompt).toContain("Documentation only");
});

test("formatBuilderComment formats candidate, summary, changes, and checks cleanly", () => {
  const comment = formatBuilderComment(
    {
      summary: "Fixed edge case validation",
      changes: ["scripts/foo.ts: simplified regex"],
      checks: [{ criterion: "AC1", result: "pass", evidence: "tests passed" }],
    },
    2,
    "continue",
    "abc1234",
  );
  expect(comment).toContain("### 🛠️ Builder Update (Lap 2 — route: continue)");
  expect(comment).toContain("Candidate**: `abc1234`");
  expect(comment).toContain("Fixed edge case validation");
  expect(comment).toContain("scripts/foo.ts: simplified regex");
  expect(comment).toContain("[x] **AC1**: `pass` (tests passed)");
});

test("formatEscalationHandoff formats executive maintainer briefing cleanly", () => {
  const issue: LocalIssue = {
    number: 85,
    url: "https://github.com/org/repo/issues/85",
    title: "governance rules",
    body: "setup governance",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };
  const handoff = formatEscalationHandoff(issue, 3, 3, "local-loop/issue-85-abc", true, {
    reason: "Reviewer requested owner intervention",
  });
  expect(handoff).toContain(
    "### 🛑 Autonomous Loop Halted: Handoff to Maintainer (`ready-for-human`)",
  );
  expect(handoff).toContain("Autonomous loop reached the maximum lap budget (3/3 laps)");
  expect(handoff).toContain("local-loop/issue-85-abc");
  expect(handoff).toContain("Reviewer requested owner intervention");
});

test("runLocalLoop transitions to needs_owner when review returns outcome needs-owner", async () => {
  const root = await fixture();
  const issue: LocalIssue = {
    number: 95,
    url: "https://github.com/owner/repo/issues/95",
    title: "complex refactor",
    body: "needs architectural guidance",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };

  const transport: PiTransport = async ({ cwd, role }) => {
    const head = git(cwd, "rev-parse", "HEAD");
    if (role === "reviewer") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  outcome: "needs-owner",
                  sha: head,
                  delivers: "part",
                  dispositions: [],
                  findings: ["Requires architectural owner intervention"],
                  reason: "Exceeded send-back budget; architectural guidance required",
                  passed: false,
                }),
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                candidate: head,
                verdict: "pass",
                checks: [{ criterion: "AC1", result: "pass", evidence: "pass" }],
                findings: [],
              }),
            },
          ],
        },
      }),
      stderr: "",
    };
  };

  const res = await runLocalLoop(root, issue, { pi: transport, push: false });
  expect(res.status).toBe("needs_owner");
});

test("runLocalLoop transitions to needs_owner when lap count reaches max_laps on sent_back", async () => {
  const root = await fixture();
  // Set max_laps = 1 in schedule.json
  await mkdir(join(root, ".factory"), { recursive: true });
  await Bun.write(
    join(root, ".factory", "schedule.json"),
    JSON.stringify({ workflow: "animus-loop", max_laps: 1 }),
  );

  const issue: LocalIssue = {
    number: 96,
    url: "https://github.com/owner/repo/issues/96",
    title: "single lap issue",
    body: "only allowed one lap",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };

  const transport: PiTransport = async ({ cwd, role }) => {
    const head = git(cwd, "rev-parse", "HEAD");
    if (role === "reviewer") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  outcome: "sent-back",
                  sha: head,
                  delivers: "part",
                  dispositions: [],
                  findings: ["Needs fixes"],
                  reason: "Some checks failed",
                  passed: false,
                }),
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                candidate: head,
                verdict: "pass",
                checks: [{ criterion: "AC1", result: "pass", evidence: "pass" }],
                findings: [],
              }),
            },
          ],
        },
      }),
      stderr: "",
    };
  };

  const res = await runLocalLoop(root, issue, { pi: transport, push: false });
  expect(res.status).toBe("needs_owner");
});
test("fetches origin baseBranch, fast-forwards clean local branch, and bases new worktree on remote commit", async () => {
  const origin = await mkdtemp(join(tmpdir(), "origin-"));
  roots.push(origin);
  git(origin, "init", "--bare");

  const root = await fixture();
  git(root, "branch", "-M", "main");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-u", "origin", "main");

  const other = await mkdtemp(join(tmpdir(), "other-"));
  roots.push(other);
  git(other, "clone", origin, ".");
  git(other, "config", "user.email", "other@example.invalid");
  git(other, "config", "user.name", "Other Dev");
  await Bun.write(join(other, "merged-feature.txt"), "merged upstream");
  git(other, "add", "merged-feature.txt");
  git(other, "commit", "-m", "feat: merged PR from another issue");
  git(other, "push", "origin", "main");
  const remoteHeadSha = git(other, "rev-parse", "HEAD");

  const rootHeadBefore = git(root, "rev-parse", "HEAD");
  expect(rootHeadBefore).not.toBe(remoteHeadSha);

  const issue: LocalIssue = {
    number: 101,
    url: "https://github.com/owner/repo/issues/101",
    title: "test fetch origin base",
    body: "test",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };

  let capturedWorktreeBaseParent = "";
  const transport: PiTransport = async ({ cwd, role }) => {
    if (role === "builder") {
      expect(existsSync(join(cwd, "merged-feature.txt"))).toBe(true);
      capturedWorktreeBaseParent = git(cwd, "rev-parse", "HEAD");
      await Bun.write(join(cwd, "issue-101.txt"), "done");
      git(cwd, "add", "issue-101.txt");
      git(cwd, "commit", "-m", "feat: issue 101");
    }
    const head = git(cwd, "rev-parse", "HEAD");
    return {
      exitCode: 0,
      stdout:
        JSON.stringify({ type: "agent_settled", aborted: false }) +
        "\n" +
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  candidate: head,
                  verdict: "pass",
                  checks: [{ criterion: "AC1", result: "pass", evidence: "test ok" }],
                  findings: [],
                }),
              },
            ],
          },
        }),
      stderr: "",
    };
  };

  const res = await runLocalLoop(root, issue, { pi: transport, push: false });
  expect(res.status).toBe("waiting_approval");
  expect(res.base).toBe(remoteHeadSha);
  expect(capturedWorktreeBaseParent).toBe(remoteHeadSha);
  expect(git(root, "rev-parse", "HEAD")).toBe(remoteHeadSha);
});
