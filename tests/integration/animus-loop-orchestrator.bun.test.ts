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
});
