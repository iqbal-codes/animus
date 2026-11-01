import { expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  parseGhChecksOutput,
  checkPrCiStatus,
  pollPrCiStatus,
  reconcileWaitingApprovalPrCi,
} from "../../scripts/loop/ci";
import { runSchedulerTick, type BacklogCandidate } from "../../scripts/loop/scheduler";
import { loadIssueDossier } from "../../scripts/loop/dossier";
import { runLocalLoop } from "../../scripts/local-loop";
import type { LocalIssue, PiTransport } from "../../scripts/loop/types";

test("parseGhChecksOutput classifies passing, failing, pending, and empty states cleanly", () => {
  // 1. All passing
  const passingOutput = JSON.stringify([
    { bucket: "pass", name: "gate-static", state: "SUCCESS", workflow: "CI" },
    { bucket: "pass", name: "gate-verify", state: "SUCCESS", workflow: "CI" },
    { bucket: "skipping", name: "gate-build", state: "SKIPPED", workflow: "CI" },
  ]);
  const resPassing = parseGhChecksOutput(passingOutput);
  expect(resPassing.status).toBe("pass");
  expect(resPassing.checks.length).toBe(3);
  expect(resPassing.failedChecks.length).toBe(0);

  // 2. Failing check
  const failingOutput = JSON.stringify([
    { bucket: "pass", name: "gate-static", state: "SUCCESS", workflow: "CI" },
    {
      bucket: "fail",
      name: "gate-verify",
      state: "FAILURE",
      workflow: "CI",
      link: "https://ci/job/1",
    },
  ]);
  const resFailing = parseGhChecksOutput(failingOutput);
  expect(resFailing.status).toBe("fail");
  expect(resFailing.failedChecks.length).toBe(1);
  expect(resFailing.failedChecks[0]!.name).toBe("gate-verify");
  expect(resFailing.failedChecks[0]!.link).toBe("https://ci/job/1");

  // 3. Cancelled check is treated as failure
  const cancelledOutput = JSON.stringify([
    { bucket: "cancel", name: "gate-static", state: "CANCELLED", workflow: "CI" },
  ]);
  const resCancelled = parseGhChecksOutput(cancelledOutput);
  expect(resCancelled.status).toBe("fail");
  expect(resCancelled.failedChecks.length).toBe(1);

  // 4. Pending checks
  const pendingOutput = JSON.stringify([
    { bucket: "pass", name: "gate-static", state: "SUCCESS", workflow: "CI" },
    { bucket: "pending", name: "gate-verify", state: "IN_PROGRESS", workflow: "CI" },
  ]);
  const resPending = parseGhChecksOutput(pendingOutput);
  expect(resPending.status).toBe("pending");
  expect(resPending.failedChecks.length).toBe(0);

  // 5. Empty array
  const emptyOutput = JSON.stringify([]);
  const resEmpty = parseGhChecksOutput(emptyOutput);
  expect(resEmpty.status).toBe("no_checks");

  // 6. Stderr no checks reported
  const resStderr = parseGhChecksOutput("", "no checks reported on the 'feat' branch");
  expect(resStderr.status).toBe("no_checks");
});

test("checkPrCiStatus calls gh runner and returns assessment", async () => {
  const mockRunner = async (cmd: string[]) => {
    expect(cmd).toEqual([
      "gh",
      "pr",
      "checks",
      "123",
      "--json",
      "bucket,name,state,workflow,link,description",
    ]);
    return {
      exitCode: 0,
      stdout: JSON.stringify([
        { bucket: "fail", name: "gate-verify", state: "FAILURE", workflow: "CI" },
      ]),
      stderr: "",
    };
  };

  const res = await checkPrCiStatus(123, { run: mockRunner });
  expect(res.status).toBe("fail");
  expect(res.failedChecks[0]!.name).toBe("gate-verify");
});

test("pollPrCiStatus returns immediately on fail without waiting full timeout", async () => {
  let callCount = 0;
  const mockRunner = async () => {
    callCount++;
    return {
      exitCode: 0,
      stdout: JSON.stringify([{ bucket: "fail", name: "gate-static", state: "FAILURE" }]),
      stderr: "",
    };
  };

  const start = Date.now();
  const res = await pollPrCiStatus("https://github.com/org/repo/pull/42", {
    maxWaitSeconds: 10,
    pollIntervalSeconds: 1,
    run: mockRunner,
  });

  const duration = Date.now() - start;
  expect(res.status).toBe("fail");
  expect(callCount).toBe(1);
  expect(duration).toBeLessThan(2000);
});

test("reconcileWaitingApprovalPrCi converts waiting_approval with failing CI to sent_back", async () => {
  const root = join(tmpdir(), `reconcile-test-${randomUUID()}`);
  const stateRoot = join(root, "factory-local-loop");
  const runsDir = join(stateRoot, "runs");
  const runId = "test-run-1";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });

  const initialState = {
    runId,
    lap: 1,
    issue: "https://github.com/org/repo/issues/77",
    pr: "https://github.com/org/repo/pull/77",
    branch: "local-loop/issue-77-abc",
    candidate: "commit-sha-77",
    status: "waiting_approval",
    evidence: [],
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(initialState, null, 2), "utf-8");

  const commentsPosted: string[] = [];
  const mockGhRunner = async (cmd: string[]) => {
    if (cmd[1] === "pr" && cmd[2] === "view") {
      return { exitCode: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (cmd[1] === "pr" && cmd[2] === "checks") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            bucket: "fail",
            name: "Gate 2: Unit Verification",
            workflow: "CI",
            state: "FAILURE",
            link: "https://github.com/actions/run/1",
          },
        ]),
        stderr: "",
      };
    }
    if (cmd[1] === "pr" && cmd[2] === "comment") {
      commentsPosted.push(cmd[cmd.indexOf("--body") + 1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const reconciled = await reconcileWaitingApprovalPrCi(runsDir, root, {
    ghRun: mockGhRunner,
    maxLaps: 3,
  });

  expect(reconciled.length).toBe(1);
  expect(reconciled[0]!.issueNumber).toBe(77);
  expect(reconciled[0]!.previousStatus).toBe("waiting_approval");
  expect(reconciled[0]!.newStatus).toBe("sent_back");
  expect(reconciled[0]!.failedChecks).toEqual(["Gate 2: Unit Verification"]);

  // Verify updated state.json
  const updatedState = JSON.parse(await Bun.file(join(runDir, "state.json")).text());
  expect(updatedState.status).toBe("sent_back");

  // Verify dossier recorded the failure with stage "ci"
  const dossier = loadIssueDossier(stateRoot, 77);
  expect(dossier).not.toBeNull();
  expect(dossier?.attempts.length).toBe(1);
  expect(dossier?.attempts[0]!.status).toBe("sent_back");
  expect(dossier?.attempts[0]!.failedStage).toBe("ci");
  expect(dossier?.attempts[0]!.reviewFindings[0]).toContain("Gate 2: Unit Verification");

  // Verify PR comment was posted
  expect(commentsPosted.length).toBe(1);
  expect(commentsPosted[0]).toContain("Remote CI checks failed");
  expect(commentsPosted[0]).toContain(
    "Automatically returning this PR to the loop for builder auto-fix",
  );
});

test("reconcileWaitingApprovalPrCi escalates to needs_owner when maxLaps reached", async () => {
  const root = join(tmpdir(), `reconcile-escalate-${randomUUID()}`);
  const stateRoot = join(root, "factory-local-loop");
  const runsDir = join(stateRoot, "runs");
  const runId = "test-run-max";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });

  const initialState = {
    runId,
    lap: 3, // At maxLaps = 3
    issue: "https://github.com/org/repo/issues/88",
    pr: "https://github.com/org/repo/pull/88",
    branch: "local-loop/issue-88-abc",
    candidate: "commit-sha-88",
    status: "waiting_approval",
    evidence: [],
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(initialState, null, 2), "utf-8");

  const issueEdits: string[][] = [];
  const mockGhRunner = async (cmd: string[]) => {
    if (cmd[1] === "pr" && cmd[2] === "view") {
      return { exitCode: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (cmd[1] === "pr" && cmd[2] === "checks") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { bucket: "fail", name: "gate-build", workflow: "CI", state: "FAILURE" },
        ]),
        stderr: "",
      };
    }
    if (cmd[1] === "issue" && cmd[2] === "edit") {
      issueEdits.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const reconciled = await reconcileWaitingApprovalPrCi(runsDir, root, {
    ghRun: mockGhRunner,
    maxLaps: 3,
  });

  expect(reconciled.length).toBe(1);
  expect(reconciled[0]!.newStatus).toBe("needs_owner");

  const updatedState = JSON.parse(await Bun.file(join(runDir, "state.json")).text());
  expect(updatedState.status).toBe("needs_owner");

  // Verify ready-for-human label applied
  expect(issueEdits.length).toBe(1);
  expect(issueEdits[0]).toContain("ready-for-human");
});

test("runSchedulerTick reconciles CI failure and admits issue for auto-fix in same tick", async () => {
  const root = join(tmpdir(), `scheduler-ci-reconcile-${randomUUID()}`);
  const stateRoot = join(root, "factory-local-loop");
  const runsDir = join(stateRoot, "runs");
  const runId = "run-prior-waiting";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });

  // Run was waiting_approval from previous lap
  const initialState = {
    runId,
    lap: 1,
    issue: "https://github.com/org/repo/issues/42",
    pr: "https://github.com/org/repo/pull/42",
    branch: "local-loop/issue-42-abc",
    candidate: "sha-42",
    status: "waiting_approval",
    evidence: [],
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(initialState, null, 2), "utf-8");

  const mockBacklog: BacklogCandidate[] = [
    {
      number: 42,
      title: "Fix auth validation",
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
    },
  ];

  let launchedTarget: BacklogCandidate | undefined;
  const launchedResult = await runSchedulerTick({
    root,
    runsDir,
    config: { parallel: 2, max_laps: 3 },
    fetchBacklog: async () => ({
      issues: mockBacklog,
      closedNumbers: new Set<number>(),
    }),
    launchLap: async (issue) => {
      launchedTarget = issue;
      return { runId: "new-autofix-run-2" };
    },
    ghRun: async (cmd) => {
      if (cmd[1] === "pr" && cmd[2] === "view") {
        return { exitCode: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      }
      if (cmd[1] === "pr" && cmd[2] === "checks") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { bucket: "fail", name: "gate-verify", state: "FAILURE", workflow: "CI" },
          ]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  // Since CI failed on PR, it should have been converted to sent_back and immediately launched!
  expect(launchedResult.action).toBe("launched");
  expect(launchedResult.targetIssueNumber).toBe(42);
  expect(launchedTarget?.number).toBe(42);
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
  const root = await mkdtemp(join(tmpdir(), "local-loop-ci-"));
  roots.push(root);
  git(root, "init", "-b", "main");
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

test("runLocalLoop Stage 3.5 catches PR CI failure and fails fast before reviewer", async () => {
  const root = await fixture();
  const issue: LocalIssue = {
    number: 99,
    url: "https://github.com/owner/repo/issues/99",
    title: "fix ci check fail-fast",
    body: "fix it",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };

  const capturedRoles: string[] = [];
  const transport: PiTransport = async ({ cwd, role }) => {
    capturedRoles.push(role);
    if (role === "builder") {
      await Bun.write(join(cwd, "file.txt"), "hello");
      git(cwd, "add", "file.txt");
      git(cwd, "commit", "-m", "fix issue 99");
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
                  checks: [{ criterion: "C1", result: "pass", evidence: "unit test ok" }],
                  findings: [],
                }),
              },
            ],
          },
        }),
      stderr: "",
    };
  };

  const res = await runLocalLoop(root, issue, {
    pi: transport,
    push: false,
    checkPrCi: async () => ({
      status: "fail",
      checks: [{ name: "Gate 1: Static Lint", bucket: "fail", state: "FAILURE" }],
      failedChecks: [{ name: "Gate 1: Static Lint", bucket: "fail", state: "FAILURE" }],
      summary: "CI checks failed: Gate 1: Static Lint",
    }),
  });

  // Stage 3.5 fail-fast means reviewer was NEVER invoked!
  expect(capturedRoles).toContain("builder");
  expect(capturedRoles).toContain("qa");
  expect(capturedRoles).not.toContain("reviewer");

  // Status is sent_back
  expect(res.status).toBe("sent_back");

  // Artifact pr-ci.json was written
  const prCiArtifact = join(res.runDirectory, "artifacts", "pr-ci.json");
  expect(await Bun.file(prCiArtifact).exists()).toBe(true);

  // Dossier attempt reflects stage "ci"
  const gitCommonRes = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: root });
  const common = gitCommonRes.stdout.toString().trim();
  const stateRoot = join(root, common, "factory-local-loop");
  const dossier = loadIssueDossier(stateRoot, 99);
  expect(dossier).not.toBeNull();
  expect(dossier?.attempts[0]!.failedStage).toBe("ci");
});
