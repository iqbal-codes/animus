import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedRole, RoleInterrupted } from "../../scripts/loop/role-runner";
import { runAnimusLoop } from "../../scripts/animus-loop";
import * as loopExports from "../../scripts/loop/index";
import * as animusExports from "../../scripts/animus-loop";
import { git } from "../../scripts/loop/worktree";
import type { LocalIssue } from "../../scripts/loop/types";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "role-runner-fixture-"));
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
      static: "echo static-ok",
      unit: "echo unit-ok",
      protected_paths: "harness/**,.factory/holdout/**",
    }),
  );

  await mkdir(join(root, ".animus"), { recursive: true });
  await writeFile(
    join(root, ".animus/config.yaml"),
    `
roles:
  builder:
    model: "small"
`,
  );
  await writeFile(join(root, "README.md"), "# Test Role Runner\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial commit");
  return root;
}

function makeValidIssue(): LocalIssue {
  return {
    number: 70,
    url: "https://github.com/example/repo/issues/70",
    title: "Implement role runner extraction",
    body: "AC1: Role runner executes bounded role sessions and enforces deadlines",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };
}

describe("scripts/loop/role-runner (unified bounded role runner)", () => {
  test("AC3: runBoundedRole executes bounded role, extracts structured report, and records evidence", async () => {
    const root = await createRepoFixture();
    const runDir = await mkdtemp(join(tmpdir(), "role-run-"));
    tempDirs.push(runDir);

    const artifactsDir = join(runDir, "artifacts");
    const handoffDir = join(artifactsDir, "handoff");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });

    let receivedEnv: Record<string, string | undefined> = {};
    let receivedArgv: string[] = [];

    const evidenceList: any[] = [];
    const res = await runBoundedRole({
      role: "builder",
      root,
      cwd: root,
      prompt: "Deliver feature 70",
      sessionDir: join(runDir, "0-builder-session"),
      checkpointPath: join(handoffDir, "checkpoint.md"),
      handoffDir,
      runDirectory: runDir,
      budget: { softMs: 10_000, hardMs: 15_000 },
      maxContinuations: 1,
      provider: "pi",
      model: "small",
      transport: async (req) => {
        receivedEnv = req.env ?? {};
        receivedArgv = req.argv;
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(req.cwd, "delivered.txt"), "hello world\n");
        await git(req.cwd, "add", "delivered.txt");
        await git(req.cwd, "commit", "-m", "feat: deliver 70");
        const head = await git(req.cwd, "rev-parse", "HEAD");
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
                    passed: true,
                    checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      },
      onEvidence: (ev) => {
        evidenceList.push(ev);
      },
    });

    expect(res.report).toBeDefined();
    expect(res.report.verdict).toBe("pass");
    expect(evidenceList.length).toBe(1);
    expect(evidenceList[0].role).toBe("builder");
    expect(receivedEnv.FACTORY_LOOP_SOFT_DEADLINE_MS).toBeDefined();
    expect(receivedEnv.FACTORY_LOOP_HARD_DEADLINE_MS).toBeDefined();
    expect(receivedEnv.FACTORY_LOOP_CHECKPOINT_PATH).toBe(join(handoffDir, "checkpoint.md"));
    expect(receivedArgv.length).toBeGreaterThan(0);
    expect(receivedArgv.at(-1)).toContain("Bounded role execution");
  });

  test("AC3: runBoundedRole enforces checkpointing and throws RoleInterrupted when budget exhausted", async () => {
    const root = await createRepoFixture();
    const runDir = await mkdtemp(join(tmpdir(), "role-run-interrupted-"));
    tempDirs.push(runDir);

    const artifactsDir = join(runDir, "artifacts");
    const handoffDir = join(artifactsDir, "handoff");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });

    const checkpointPath = join(handoffDir, "checkpoint.md");

    expect(
      runBoundedRole({
        role: "builder",
        root,
        cwd: root,
        prompt: "Deliver feature 71",
        checkpointPath,
        handoffDir,
        runDirectory: runDir,
        budget: { softMs: 1_000, hardMs: 2_000 },
        maxContinuations: 0,
        provider: "pi",
        model: "small",
        transport: async () => ({
          exitCode: 124,
          stdout: "",
          stderr: "timed out",
          timedOut: true,
        }),
      }),
    ).rejects.toThrow(RoleInterrupted);

    // Verify checkpoint was written
    expect(existsSync(checkpointPath)).toBe(true);
    const checkpointContent = readFileSync(checkpointPath, "utf8");
    expect(checkpointContent).toContain("Host checkpoint: builder attempt 0");
  });

  test("AC3: runAnimusLoop handles role interruption and transitions cleanly to interrupted", async () => {
    const root = await createRepoFixture();
    const issue = makeValidIssue();

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
    const checkpointPath = join(result.runDirectory, "artifacts", "handoff", "checkpoint.md");
    expect(existsSync(checkpointPath)).toBe(true);
  });

  test("AC4: invokeRoleWithDeadlines is NOT exported in barrel or public animus-loop orchestrator", () => {
    expect((loopExports as any).invokeRoleWithDeadlines).toBeUndefined();
    expect((animusExports as any).invokeRoleWithDeadlines).toBeUndefined();
    expect(typeof loopExports.runBoundedRole).toBe("function");
  });
});
