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
  resolveArchonCommandsDir,
  ARCHON_BUILDER_PROMPT,
  ARCHON_QA_PROMPT,
  ARCHON_REVIEWER_PROMPT,
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

test("extractReport normalizes Canonical Archon check-app structured reports", () => {
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

test("extractReport normalizes Canonical Archon review structured reports", () => {
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

test("Archon prompt templates include canonical SDLC roles and strict contracts", () => {
  const root = resolve(import.meta.dir, "../..");
  const dir = resolveArchonCommandsDir(root);
  if (dir) {
    expect(existsSync(dir)).toBe(true);
  }

  expect(ARCHON_BUILDER_PROMPT).toContain("# Make the move");
  expect(ARCHON_BUILDER_PROMPT).toContain("Two reviewers check your work right after you.");
  expect(ARCHON_BUILDER_PROMPT).toContain("Evidence");

  expect(ARCHON_QA_PROMPT).toContain("# Check the app as a user would");
  expect(ARCHON_QA_PROMPT).toContain("You are the black-box tester");
  expect(ARCHON_QA_PROMPT).toContain("merged_with");

  expect(ARCHON_REVIEWER_PROMPT).toContain(
    "# Review, then merge, send back, or return to the owner",
  );
  expect(ARCHON_REVIEWER_PROMPT).toContain("dispositions");
  expect(ARCHON_REVIEWER_PROMPT).toContain("Loop review:");
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

  // Verifies Archon 1:1 artifact and handoff structure
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
    url: "https://github.com/labq/labq-software-factory/issues/73",
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
