import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  invokeRoleWithDeadlines,
  type InvokeRoleWithDeadlinesOptions,
} from "../../scripts/loop/role-runner";
import * as loopExports from "../../scripts/loop/index";
import { git } from "../../scripts/loop/worktree";
import { RoleInterrupted } from "../../scripts/loop/deadlines";
import type { LocalIssue, LocalLoopResult } from "../../scripts/loop/types";

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

describe("scripts/loop/role-runner", () => {
  describe("AC1: invokeRoleWithDeadlines", () => {
    test("executes role, extracts structured report, and records evidence", async () => {
      const root = await createRepoFixture();
      const issue = makeValidIssue();
      const runDir = await mkdtemp(join(tmpdir(), "role-run-"));
      tempDirs.push(runDir);

      const artifactsDir = join(runDir, "artifacts");
      const handoffDir = join(artifactsDir, "handoff");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(handoffDir, { recursive: true });

      const base = await git(root, "rev-parse", "HEAD");
      const state: LocalLoopResult = {
        runId: "run-70",
        pid: process.pid,
        lap: 1,
        issue: issue.url,
        route: "simple",
        status: "preparing",
        runDirectory: runDir,
        worktree: root,
        branch: "local-loop/issue-70",
        base,
        verificationProfile: "docs",
        evidence: [],
      };

      const recoveries: any[] = [];
      const opts: InvokeRoleWithDeadlinesOptions = {
        role: "builder",
        root,
        issue,
        state,
        stateRoot: runDir,
        runDirectory: runDir,
        artifactsDir,
        handoffDir,
        route: "simple",
        base,
        template: "# Builder Prompt\n$INPUTS",
        options: { push: false },
        roleBudgets: {
          builder: { softMs: 10_000, hardMs: 15_000 },
          qa: { softMs: 10_000, hardMs: 15_000 },
          reviewer: { softMs: 10_000, hardMs: 15_000 },
          reflector: { softMs: 10_000, hardMs: 15_000 },
          planner: { softMs: 10_000, hardMs: 15_000 },
          investigator: { softMs: 10_000, hardMs: 15_000 },
          manager: { softMs: 10_000, hardMs: 15_000 },
          auditor: { softMs: 10_000, hardMs: 15_000 },
          simplifier: { softMs: 10_000, hardMs: 15_000 },
          triage: { softMs: 10_000, hardMs: 15_000 },
        },
        transport: async ({ cwd }) => {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(join(cwd, "delivered.txt"), "hello world\n");
          await git(cwd, "add", "delivered.txt");
          await git(cwd, "commit", "-m", "feat: deliver 70");
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
        acceptedRef: base,
        holdoutPath: "",
        protectedPaths: [],
        maxRejections: 2,
        initialProfile: "docs",
        recoveries,
        save: async () => {},
      };

      const report = await invokeRoleWithDeadlines(opts);
      expect(report).toBeDefined();
      expect(report.verdict).toBe("pass");
      expect(state.status).toBe("building");
      expect(state.evidence.length).toBeGreaterThan(0);
      expect(state.evidence[0]!.role).toBe("builder");
    });

    test("enforces checkpointing and throws RoleInterrupted when budget exhausted", async () => {
      const root = await createRepoFixture();
      const issue = makeValidIssue();
      const runDir = await mkdtemp(join(tmpdir(), "role-run-interrupted-"));
      tempDirs.push(runDir);

      const artifactsDir = join(runDir, "artifacts");
      const handoffDir = join(artifactsDir, "handoff");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(handoffDir, { recursive: true });

      const base = await git(root, "rev-parse", "HEAD");
      const state: LocalLoopResult = {
        runId: "run-71",
        pid: process.pid,
        lap: 1,
        issue: issue.url,
        route: "simple",
        status: "preparing",
        runDirectory: runDir,
        worktree: root,
        branch: "local-loop/issue-71",
        base,
        verificationProfile: "docs",
        evidence: [],
      };

      const opts: InvokeRoleWithDeadlinesOptions = {
        role: "builder",
        root,
        issue,
        state,
        stateRoot: runDir,
        runDirectory: runDir,
        artifactsDir,
        handoffDir,
        route: "simple",
        base,
        template: "# Builder Prompt",
        options: { push: false, maxContinuations: 0 },
        roleBudgets: {
          builder: { softMs: 1_000, hardMs: 2_000 },
          qa: { softMs: 1_000, hardMs: 2_000 },
          reviewer: { softMs: 1_000, hardMs: 2_000 },
          reflector: { softMs: 1_000, hardMs: 2_000 },
          planner: { softMs: 1_000, hardMs: 2_000 },
          investigator: { softMs: 1_000, hardMs: 2_000 },
          manager: { softMs: 1_000, hardMs: 2_000 },
          auditor: { softMs: 1_000, hardMs: 2_000 },
          simplifier: { softMs: 1_000, hardMs: 2_000 },
          triage: { softMs: 1_000, hardMs: 2_000 },
        },
        transport: async () => ({
          exitCode: 124, // Timed out
          stdout: "",
          stderr: "timed out",
          timedOut: true,
        }),
        acceptedRef: base,
        holdoutPath: "",
        protectedPaths: [],
        maxRejections: 2,
        initialProfile: "docs",
        recoveries: [],
        save: async () => {},
      };

      expect(invokeRoleWithDeadlines(opts)).rejects.toThrow(RoleInterrupted);

      // Verify checkpoint was written
      const checkpointPath = join(handoffDir, "checkpoint.md");
      expect(existsSync(checkpointPath)).toBe(true);
      const checkpointContent = readFileSync(checkpointPath, "utf8");
      expect(checkpointContent).toContain("Host checkpoint: builder attempt 0");
    });
  });

  describe("AC2: barrel export", () => {
    test("scripts/loop/index.ts barrel exports invokeRoleWithDeadlines", () => {
      expect((loopExports as any).invokeRoleWithDeadlines).toBeFunction();
    });
  });
});
