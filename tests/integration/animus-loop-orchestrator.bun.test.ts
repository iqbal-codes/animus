import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runAnimusLoop, runLocalLoop } from "../../scripts/animus-loop";
import * as animusLoopMod from "../../scripts/animus-loop";
import * as localLoopMod from "../../scripts/local-loop";
import type { LocalIssue, AgentTransport } from "../../scripts/animus-loop";

function runCmd(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(args, { cwd, stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

async function createGitRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "animus-loop-fixture-"));
  runCmd(root, "git", "init", "-b", "main");
  runCmd(root, "git", "config", "user.name", "Animus Test");
  runCmd(root, "git", "config", "user.email", "animus@example.com");
  runCmd(root, "git", "config", "commit.gpgsign", "false");

  // Harness config with ordinary checks
  await Bun.write(
    join(root, "harness/harness.config.json"),
    JSON.stringify({
      static: "echo static-ok",
      unit: "echo unit-ok",
      protected_paths: ".factory/holdout/**,harness/**",
    }),
  );

  // Animus config
  await Bun.write(
    join(root, ".animus/config.yaml"),
    `
roles:
  builder:
    model: "medium"
  qa:
    model: "small"
  reviewer:
    model: "large"
`,
  );

  await Bun.write(join(root, "README.md"), "# Test Repo");
  runCmd(root, "git", "add", ".");
  runCmd(root, "git", "commit", "-m", "Initial commit");
  return root;
}

describe("Canonical Animus Loop Orchestrator & Facade Shim", () => {
  test("AC1 & AC2: exports runAnimusLoop and runLocalLoop alias with identical reference", () => {
    expect(typeof runAnimusLoop).toBe("function");
    expect(typeof runLocalLoop).toBe("function");
    expect(runLocalLoop).toBe(runAnimusLoop);
  });

  test("AC2: scripts/local-loop.ts transparently re-exports all animus-loop exports", () => {
    const animusKeys = Object.keys(animusLoopMod).sort();
    const localKeys = Object.keys(localLoopMod).sort();

    // Verify all keys from animus-loop exist in local-loop facade
    for (const key of animusKeys) {
      expect(localKeys).toContain(key);
      expect((localLoopMod as any)[key]).toBe((animusLoopMod as any)[key]);
    }

    // Verify critical named exports remain resolvable from local-loop
    expect(typeof localLoopMod.runAnimusLoop).toBe("function");
    expect(typeof localLoopMod.runLocalLoop).toBe("function");
    expect(typeof localLoopMod.computeExternalBlastRadius).toBe("function");
    expect(typeof localLoopMod.extractRequiredAcIds).toBe("function");
    expect(typeof localLoopMod.annotateDiffWithLineNumbers).toBe("function");
    expect(typeof localLoopMod.assembleRolePromptContext).toBe("function");
    expect(typeof localLoopMod.validateIssue).toBe("function");
    expect(typeof localLoopMod.inspectLocalLoop).toBe("function");
    expect(typeof localLoopMod.findExistingWorktreeForBranch).toBe("function");
    expect(typeof localLoopMod.acquireIssueLock).toBe("function");
    expect(typeof localLoopMod.prepareLoopWorktree).toBe("function");
    expect(typeof localLoopMod.assertCandidate).toBe("function");
    expect(typeof localLoopMod.executeSubticketAutoMerge).toBe("function");
    expect(typeof localLoopMod.executeTerminalReflection).toBe("function");
  });

  test("AC4: internal stage-bag helpers are removed from public exports and barrels", async () => {
    const loopExports = await import("../../scripts/loop/index");
    const obsoleteStageHelpers = [
      "setupLoopLifecycle",
      "invokeRoleWithDeadlines",
      "runOrdinaryChecks",
      "executeBlackBoxQa",
      "handleQaFastFail",
      "handleCiFastFail",
      "verifyPrCiGate",
      "evaluateReviewReadiness",
      "finalizeReviewAndPublish",
      "handleLoopCatch",
      "recordLapAndReflect",
    ];

    for (const helper of obsoleteStageHelpers) {
      expect((animusLoopMod as any)[helper]).toBeUndefined();
      expect((localLoopMod as any)[helper]).toBeUndefined();
      expect((loopExports as any)[helper]).toBeUndefined();
    }
  });

  test("AC1: runAnimusLoop executes a complete autonomous lap through all stages", async () => {
    const root = await createGitRepoFixture();
    try {
      const issue: LocalIssue = {
        number: 136,
        url: "https://github.com/iqbal-codes/animus/issues/136",
        title: "establish animus-loop orchestrator",
        body: "AC1: runAnimusLoop executes cleanly",
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const capturedRoles: string[] = [];
      const transport: AgentTransport = async ({ cwd, role }) => {
        capturedRoles.push(role);
        if (role === "builder") {
          await Bun.write(join(cwd, "delivered.txt"), "delivered content");
          runCmd(cwd, "git", "add", "delivered.txt");
          runCmd(cwd, "git", "commit", "-m", "deliver issue 136");
        }
        const head = runCmd(cwd, "git", "rev-parse", "HEAD");
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
                      passed: true,
                      overall: "PASS",
                      checks: [
                        { criterion: "AC1", result: "pass", evidence: "builder-checks.log" },
                      ],
                      lines: [
                        {
                          id: "AC1",
                          kind: "criterion",
                          verdict: "PASS",
                          evidence: ["builder-checks.log"],
                        },
                      ],
                      findings: [],
                    }),
                  },
                ],
              },
            }),
          stderr: "",
        };
      };

      const result = await runAnimusLoop(root, issue, {
        transport,
        push: false,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("waiting_approval");
      expect(result.route).toBe("simple");
      expect(capturedRoles).toEqual(["builder", "qa", "reviewer"]);

      // Verify handoff and session artifacts
      const handoffDir = join(result.runDirectory, "artifacts", "handoff");
      expect(existsSync(join(handoffDir, "builder.md"))).toBe(true);
      expect(existsSync(join(handoffDir, "app-check.json"))).toBe(true);
      expect(existsSync(join(result.runDirectory, "0-builder-session"))).toBe(true);
      expect(existsSync(join(result.runDirectory, "1-qa-session"))).toBe(true);
      expect(existsSync(join(result.runDirectory, "2-reviewer-session"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("AC1: runAnimusLoop short-circuits reviewer when Black-Box QA fails (QA Fast-Fail Gate)", async () => {
    const root = await createGitRepoFixture();
    try {
      const issue: LocalIssue = {
        number: 137,
        url: "https://github.com/iqbal-codes/animus/issues/137",
        title: "test qa fast fail",
        body: "AC1: must pass QA",
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const capturedRoles: string[] = [];
      const transport: AgentTransport = async ({ cwd, role }) => {
        capturedRoles.push(role);
        if (role === "builder") {
          await Bun.write(join(cwd, "code.txt"), "initial code");
          runCmd(cwd, "git", "add", "code.txt");
          runCmd(cwd, "git", "commit", "-m", "add code");
          const head = runCmd(cwd, "git", "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: JSON.stringify({ candidate: head, verdict: "pass" }) },
                ],
              },
            }),
            stderr: "",
          };
        }
        if (role === "qa") {
          const head = runCmd(cwd, "git", "rev-parse", "HEAD");
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
                      head,
                      verdict: "fail",
                      overall: "FAIL",
                      passed: false,
                      lines: [
                        {
                          id: "AC1",
                          kind: "criterion",
                          verdict: "FAIL",
                          observed: "Broken behavior",
                        },
                      ],
                    }),
                  },
                ],
              },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const result = await runAnimusLoop(root, issue, {
        transport,
        push: false,
      });

      // Reviewer should NOT have been invoked
      expect(capturedRoles).toEqual(["builder", "qa"]);
      expect(result.status).toBe("sent_back");
      expect(result.qaReport?.overall).toBe("FAIL");
      expect((result.qaReport as any)?.passed).toBe(false);
      expect(result.reviewerReport).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("F1: successful runs remain locked during execution and release on completion", async () => {
    const root = await createGitRepoFixture();
    try {
      const issue: LocalIssue = {
        number: 138,
        url: "https://github.com/iqbal-codes/animus/issues/138",
        title: "test lock retention during execution",
        body: "AC1: verify lock retention",
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const { inspectLocalLoop, acquireIssueLock } = await import("../../scripts/loop/worktree");
      const { common } = await inspectLocalLoop(root);
      const stateRoot = join(common, "factory-local-loop");

      let lockWasHeldDuringExecution = false;

      const transport: AgentTransport = async ({ cwd, role }) => {
        if (role === "builder") {
          // Probe that issue lock is currently held by the running loop
          try {
            await acquireIssueLock(stateRoot, 138);
          } catch (lockErr: any) {
            if (/Issue 138 is locked/i.test(lockErr.message)) {
              lockWasHeldDuringExecution = true;
            }
          }

          await Bun.write(join(cwd, "code.txt"), "committed code");
          runCmd(cwd, "git", "add", "code.txt");
          runCmd(cwd, "git", "commit", "-m", "committed code");
          const head = runCmd(cwd, "git", "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: JSON.stringify({ candidate: head, verdict: "pass" }) },
                ],
              },
            }),
            stderr: "",
          };
        }
        const head = runCmd(cwd, "git", "rev-parse", "HEAD");
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
                      passed: true,
                      overall: "PASS",
                      checks: [
                        { criterion: "AC1", result: "pass", evidence: "builder-checks.log" },
                      ],
                      lines: [
                        {
                          id: "AC1",
                          kind: "criterion",
                          verdict: "PASS",
                          evidence: ["builder-checks.log"],
                        },
                      ],
                      findings: [],
                    }),
                  },
                ],
              },
            }),
          stderr: "",
        };
      };

      const result = await runAnimusLoop(root, issue, {
        transport,
        push: false,
      });

      expect(lockWasHeldDuringExecution).toBe(true);
      expect(result.status).toBe("waiting_approval");

      // Verify lock has been released on completion and can be reacquired cleanly
      const reacquired = await acquireIssueLock(stateRoot, 138);
      expect(typeof reacquired).toBe("function");
      await reacquired();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("AC2: QA fast-fail with lap >= maxLaps escalates to needs_owner through unified terminal disposition", async () => {
    const root = await createGitRepoFixture();
    try {
      await Bun.write(
        join(root, ".factory/schedule.json"),
        JSON.stringify({ workflow: "animus-loop", max_laps: 1 }),
      );

      const issue: LocalIssue = {
        number: 139,
        url: "https://github.com/iqbal-codes/animus/issues/139",
        title: "test qa fast fail max laps",
        body: "AC1: must escalate on max laps",
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const transport: AgentTransport = async ({ cwd, role }) => {
        if (role === "builder") {
          await Bun.write(join(cwd, "code.txt"), "built code");
          runCmd(cwd, "git", "add", "code.txt");
          runCmd(cwd, "git", "commit", "-m", "built code");
          const head = runCmd(cwd, "git", "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: JSON.stringify({ candidate: head, verdict: "pass" }) },
                ],
              },
            }),
            stderr: "",
          };
        }
        const head = runCmd(cwd, "git", "rev-parse", "HEAD");
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
                    head,
                    verdict: "fail",
                    overall: "FAIL",
                    passed: false,
                    lines: [
                      { id: "AC1", kind: "criterion", verdict: "FAIL", observed: "failed qa" },
                    ],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      };

      const result = await runAnimusLoop(root, issue, {
        transport,
        push: false,
      });

      expect(result.status).toBe("needs_owner");
      expect((result.qaReport as any)?.passed).toBe(false);

      // Verify lock is released
      const { common } = await (await import("../../scripts/loop/worktree")).inspectLocalLoop(root);
      const stateRoot = join(common, "factory-local-loop");
      const reacquired = await (
        await import("../../scripts/loop/worktree")
      ).acquireIssueLock(stateRoot, 139);
      expect(typeof reacquired).toBe("function");
      await reacquired();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("AC2: PR CI check failure fast-fails through unified terminal disposition before reviewer", async () => {
    const root = await createGitRepoFixture();
    try {
      const issue: LocalIssue = {
        number: 140,
        url: "https://github.com/iqbal-codes/animus/issues/140",
        title: "test ci fast fail",
        body: "AC1: must fast fail on ci failure",
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const capturedRoles: string[] = [];
      const transport: AgentTransport = async ({ cwd, role }) => {
        capturedRoles.push(role);
        if (role === "builder") {
          await Bun.write(join(cwd, "code.txt"), "built code");
          runCmd(cwd, "git", "add", "code.txt");
          runCmd(cwd, "git", "commit", "-m", "built code");
          const head = runCmd(cwd, "git", "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: JSON.stringify({ candidate: head, verdict: "pass" }) },
                ],
              },
            }),
            stderr: "",
          };
        }
        const head = runCmd(cwd, "git", "rev-parse", "HEAD");
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
                    head,
                    verdict: "pass",
                    overall: "PASS",
                    passed: true,
                    checks: [{ criterion: "AC1", result: "pass", evidence: "builder-checks.log" }],
                    lines: [
                      {
                        id: "AC1",
                        kind: "criterion",
                        verdict: "PASS",
                        evidence: ["builder-checks.log"],
                      },
                    ],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      };

      const result = await runAnimusLoop(root, issue, {
        transport,
        push: false,
        checkPrCi: async () => ({
          status: "fail",
          checks: [{ name: "gate-verify", state: "failure", bucket: "fail" }],
          failedChecks: [{ name: "gate-verify", state: "failure", bucket: "fail" }],
          summary: "CI checks failed: gate-verify",
        }),
      });

      expect(capturedRoles).toEqual(["builder", "qa"]);
      expect(result.status).toBe("sent_back");
      expect(existsSync(join(result.runDirectory, "artifacts", "pr-ci.json"))).toBe(true);

      // Verify lock is released
      const { common } = await (await import("../../scripts/loop/worktree")).inspectLocalLoop(root);
      const stateRoot = join(common, "factory-local-loop");
      const reacquired = await (
        await import("../../scripts/loop/worktree")
      ).acquireIssueLock(stateRoot, 140);
      expect(typeof reacquired).toBe("function");
      await reacquired();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("AC2 & AC3: unhandled error in checks and role interruption route through terminal disposition and release lock", async () => {
    const root = await createGitRepoFixture();
    try {
      const issue: LocalIssue = {
        number: 141,
        url: "https://github.com/iqbal-codes/animus/issues/141",
        title: "test interruption handling",
        body: "AC1: must handle interruption",
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const result = await runAnimusLoop(root, issue, {
        push: false,
        maxContinuations: 0,
        transport: async () => ({
          exitCode: 124,
          stdout: "",
          stderr: "timed out",
          timedOut: true,
        }),
      });

      expect(result.status).toBe("interrupted");
      expect(result.error).toContain("interrupted");

      // Verify lock is released
      const { common } = await (await import("../../scripts/loop/worktree")).inspectLocalLoop(root);
      const stateRoot = join(common, "factory-local-loop");
      const reacquired = await (
        await import("../../scripts/loop/worktree")
      ).acquireIssueLock(stateRoot, 141);
      expect(typeof reacquired).toBe("function");
      await reacquired();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("AC2: exact-once terminal disposition and clean lock release even when reflection encounters error", async () => {
    const root = await createGitRepoFixture();
    try {
      const issue: LocalIssue = {
        number: 142,
        url: "https://github.com/iqbal-codes/animus/issues/142",
        title: "test exact-once terminal disposition",
        body: "AC1: must record exact-once dossier attempt and release lock",
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const transport: AgentTransport = async ({ cwd, role }) => {
        if (role === "builder") {
          await Bun.write(join(cwd, "delivered.txt"), "hello");
          runCmd(cwd, "git", "add", "delivered.txt");
          runCmd(cwd, "git", "commit", "-m", "deliver");
          const head = runCmd(cwd, "git", "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: JSON.stringify({ candidate: head, verdict: "pass" }) },
                ],
              },
            }),
            stderr: "",
          };
        }
        if (role === "qa") {
          const head = runCmd(cwd, "git", "rev-parse", "HEAD");
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
                      head,
                      verdict: "fail",
                      overall: "FAIL",
                      passed: false,
                      lines: [
                        { id: "AC1", kind: "criterion", verdict: "FAIL", observed: "qa fail" },
                      ],
                    }),
                  },
                ],
              },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const result = await runAnimusLoop(root, issue, {
        transport,
        push: false,
      });

      expect(result.status).toBe("sent_back");

      // Verify issue dossier has exactly 1 attempt record (exact-once)
      const { common } = await (await import("../../scripts/loop/worktree")).inspectLocalLoop(root);
      const stateRoot = join(common, "factory-local-loop");
      const { loadIssueDossier } = await import("../../scripts/loop/dossier");
      const dossier = loadIssueDossier(stateRoot, 142);
      expect(dossier).toBeDefined();
      expect(dossier!.attempts.length).toBe(1);

      // Verify lock is completely released
      const reacquired = await (
        await import("../../scripts/loop/worktree")
      ).acquireIssueLock(stateRoot, 142);
      expect(typeof reacquired).toBe("function");
      await reacquired();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("LapSession resolves canonical workspace paths when ANIMUS_HOME is set, visible via monitor and engine host", async () => {
    const root = await createGitRepoFixture();
    const animusHome = await mkdtemp(join(tmpdir(), "animus-home-canonical-"));
    const origAnimusHome = process.env.ANIMUS_HOME;
    process.env.ANIMUS_HOME = animusHome;

    try {
      const issue: LocalIssue = {
        number: 143,
        title: "Canonical Workspace Resolution Test",
        url: "https://github.com/owner/repo/issues/143",
        body: "## Source and problem\nNeed canonical workspace path resolution.\n\n## Outcome\nVisible to host and monitor.\n\n## Invariants\nAll paths derive via ProjectWorkspace.\n\n## Acceptance criteria\n- [ ] AC1: Passes canonical check\n\n## Boundary\nLocal loop session only.",
        labels: ["ready-for-agent"],
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const transport: AgentTransport = async ({ cwd, role }) => {
        if (role === "builder") {
          await Bun.write(join(cwd, "canonical.txt"), "canonical content\n");
          runCmd(cwd, "git", "add", "canonical.txt");
          runCmd(cwd, "git", "commit", "-m", "feat: canonical paths");
        }
        const head = runCmd(cwd, "git", "rev-parse", "HEAD");
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
                      sha: head,
                      verdict: "pass",
                      passed: true,
                      overall: "PASS",
                      outcome: "approved",
                      summary: "Review approved",
                      checks: [
                        { criterion: "AC1", result: "pass", evidence: "builder-checks.log" },
                      ],
                      lines: [
                        {
                          id: "AC1",
                          kind: "criterion",
                          verdict: "PASS",
                          evidence: ["builder-checks.log"],
                        },
                      ],
                      findings: [],
                    }),
                  },
                ],
              },
            }),
          stderr: "",
        };
      };

      const result = await runAnimusLoop(root, issue, {
        transport,
        push: false,
      });

      expect(result.status).toBe("waiting_approval");

      const { resolveProjectWorkspace } = await import("@animus/contracts/paths");
      const ws = resolveProjectWorkspace(root);

      // Verify LapSession wrote into canonical workspace.runsDir under ANIMUS_HOME
      expect(ws.isExternalState).toBe(true);
      expect(ws.runsDir.startsWith(animusHome)).toBe(true);
      expect(result.runDirectory.startsWith(ws.runsDir)).toBe(true);

      const statePath = join(ws.runsDir, result.runId, "state.json");
      expect(existsSync(statePath)).toBe(true);

      // Verify visible via actual engine host
      const { readLapDetail, readLapEvidence, readLapReport } =
        await import("../../apps/engine-host/src/native");
      const hostDetail = readLapDetail(root, result.runId);
      expect(hostDetail.id).toBe(result.runId);
      expect(hostDetail.product_status).toBe("waiting_approval");

      const hostEvidence = readLapEvidence(root, result.runId);
      expect(hostEvidence.peer_review?.outcome).toBe("approved");

      const hostReport = readLapReport(root, result.runId);
      expect(hostReport).toContain("Review approved");

      // Verify visible via monitor service
      const { getIssuesWaitingApproval } = await import("@animus/contracts/paths");
      const waiting = getIssuesWaitingApproval(ws.runsDir);
      expect(waiting.has(143)).toBe(true);

      const { readRunStates } = await import("../../apps/backend/src/intake/admission");
      const runStates = readRunStates(ws.runsDir);
      expect(runStates.get(143)).toBe("waiting_approval");
    } finally {
      if (origAnimusHome !== undefined) {
        process.env.ANIMUS_HOME = origAnimusHome;
      } else {
        delete process.env.ANIMUS_HOME;
      }
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await rm(animusHome, { recursive: true, force: true }).catch(() => {});
    }
  });
});
