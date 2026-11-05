import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnimusLoop } from "../../scripts/animus-loop";
import * as animusExports from "../../scripts/animus-loop";
import * as loopExports from "../../scripts/loop/index";
import { git, inspectLocalLoop, acquireIssueLock } from "../../scripts/loop/worktree";
import type { LocalIssue, AgentTransport } from "../../scripts/loop/types";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-fixture-"));
  tempDirs.push(root);

  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test Agent");
  await git(root, "config", "user.email", "agent@animus.local");
  await git(root, "config", "commit.gpgsign", "false");

  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(root, "harness"), { recursive: true });
  await writeFile(
    join(root, "harness/harness.config.json"),
    JSON.stringify({
      static: "echo static-check-ok",
      unit: "echo unit-check-ok",
      protected_paths: "harness/**,.factory/holdout/**",
    }),
  );

  await mkdir(join(root, ".animus"), { recursive: true });
  await writeFile(
    join(root, ".animus/config.yaml"),
    `
worktree:
  baseBranch: "main"
roles:
  builder:
    model: "small"
`,
  );

  await writeFile(join(root, "README.md"), "# Test Lifecycle Repository\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial commit");
  return root;
}

function makeValidIssue(overrides: Partial<LocalIssue> = {}): LocalIssue {
  return {
    number: 55,
    url: "https://github.com/example/repo/issues/55",
    title: "Implement lifecycle setup extraction",
    body: "AC1: Initialize loop run directory and locks cleanly",
    comments: [],
    dependencies: [],
    activeClaim: false,
    ...overrides,
  };
}

const mockTransport: AgentTransport = async ({ cwd, role }) => {
  if (role === "builder") {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(cwd, "delivered.txt"), "hello world\n");
    await git(cwd, "add", "delivered.txt");
    await git(cwd, "commit", "-m", "deliver issue");
  }
  const head = await git(cwd, "rev-parse", "HEAD");
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
              sha: head,
              verdict: "pass",
              outcome: "approved",
              passed: true,
              overall: "PASS",
              delivers: "all",
              checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
              lines: [
                { id: "AC1", kind: "criterion", verdict: "PASS", evidence: ["builder-checks.log"] },
              ],
              findings: [],
              dispositions: [],
            }),
          },
        ],
      },
    }),
    stderr: "",
  };
};

describe("scripts/loop/lifecycle (migrated to public runAnimusLoop seam)", () => {
  test("AC1: runAnimusLoop initializes run directory, state.json, locks, and cleans up on completion", async () => {
    const root = await createRepoFixture();
    const issue = makeValidIssue();

    const { common } = await inspectLocalLoop(root);
    const stateRoot = join(common, "factory-local-loop");

    let lockWasHeldDuringRun = false;
    const transportWithLockProbe: AgentTransport = async (req) => {
      try {
        await acquireIssueLock(stateRoot, issue.number);
      } catch (lockErr: any) {
        if (/is locked/i.test(lockErr.message)) {
          lockWasHeldDuringRun = true;
        }
      }
      return mockTransport(req);
    };

    const result = await runAnimusLoop(root, issue, {
      transport: transportWithLockProbe,
      push: false,
    });

    expect(lockWasHeldDuringRun).toBe(true);
    expect(result.runId).toBeDefined();
    expect(result.runDirectory).toBeDefined();
    expect(existsSync(result.runDirectory)).toBe(true);
    expect(existsSync(join(result.runDirectory, "state.json"))).toBe(true);
    expect(existsSync(join(result.runDirectory, "issue.json"))).toBe(true);
    expect(existsSync(join(result.runDirectory, "artifacts"))).toBe(true);
    expect(existsSync(join(result.runDirectory, "artifacts", "handoff"))).toBe(true);

    // Verify persisted state.json is valid
    const savedState = JSON.parse(readFileSync(join(result.runDirectory, "state.json"), "utf8"));
    expect(savedState.runId).toBe(result.runId);
    expect(savedState.status).toBe("waiting_approval");

    // Verify lock is released upon completion
    const lockDirAfter = join(stateRoot, "locks", `issue-${issue.number}`);
    expect(existsSync(lockDirAfter)).toBe(false);

    // Verify lock can be immediately reacquired
    const reacquired = await acquireIssueLock(stateRoot, issue.number);
    expect(typeof reacquired).toBe("function");
    await reacquired();
  });

  test("AC1: runAnimusLoop fails closed if harness config lacks ordinary checks", async () => {
    const root = await createRepoFixture();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, "harness/harness.config.json"),
      JSON.stringify({ static: "", unit: "" }),
    );

    const issue = makeValidIssue({
      number: 56,
      url: "https://github.com/example/repo/issues/56",
    });

    expect(runAnimusLoop(root, issue, { transport: mockTransport, push: false })).rejects.toThrow(
      "No declared ordinary project checks",
    );

    // Verify lock was released even though initialization threw
    const { common } = await inspectLocalLoop(root);
    const stateRoot = join(common, "factory-local-loop");
    const reacquired = await acquireIssueLock(stateRoot, 56);
    expect(typeof reacquired).toBe("function");
    await reacquired();
  });

  test("AC1: runAnimusLoop parses partOf subticket and configures integration branch", async () => {
    const root = await createRepoFixture();
    const issue = makeValidIssue({
      number: 57,
      url: "https://github.com/example/repo/issues/57",
      body: "Part of #10: build auth subfeature",
    });

    const result = await runAnimusLoop(root, issue, {
      transport: mockTransport,
      push: false,
    });

    expect(result.partOf).toBe(10);
    expect(result.integrationBranch).toBe("factory/spec-10-integration");
  });

  test("F1: post-acquisition failure in LapSession.init releases lock so same issue can reacquire", async () => {
    const root = await createRepoFixture();
    const issue = makeValidIssue({
      number: 99,
      url: "https://github.com/example/repo/issues/99",
    });
    Object.defineProperty(issue, "verificationProfile", {
      get() {
        throw new Error("Simulated post-acquisition failure");
      },
      configurable: true,
    });

    expect(runAnimusLoop(root, issue, { transport: mockTransport, push: false })).rejects.toThrow(
      "Simulated post-acquisition failure",
    );

    // Prove same issue can reacquire lock immediately without throwing "Issue 99 is locked"
    const { common } = await inspectLocalLoop(root);
    const stateRoot = join(common, "factory-local-loop");
    const lockRelease = await acquireIssueLock(stateRoot, 99);
    expect(typeof lockRelease).toBe("function");
    await lockRelease();
  });

  test("AC4: setupLoopLifecycle is NOT exported in barrel or public animus-loop orchestrator", () => {
    expect((loopExports as any).setupLoopLifecycle).toBeUndefined();
    expect((animusExports as any).setupLoopLifecycle).toBeUndefined();
  });
});
