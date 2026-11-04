import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupLoopLifecycle, type LoopLifecycleContext } from "../../scripts/loop/lifecycle";
import * as loopExports from "../../scripts/loop/index";
import { git, inspectLocalLoop, acquireIssueLock } from "../../scripts/loop/worktree";
import type { LocalIssue } from "../../scripts/loop/types";

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

  // harness config with static and unit checks
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

  // animus config
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

describe("scripts/loop/lifecycle", () => {
  describe("AC1: setupLoopLifecycle", () => {
    test("initializes run directory, state.json, locks, and returns context", async () => {
      const root = await createRepoFixture();
      const issue = makeValidIssue();

      const lc: LoopLifecycleContext = await setupLoopLifecycle(root, issue, {
        push: false,
      });

      try {
        expect(lc.runId).toBeDefined();
        expect(lc.stateRoot).toBeDefined();
        expect(lc.runDirectory).toBeDefined();
        expect(existsSync(lc.runDirectory)).toBe(true);
        expect(existsSync(join(lc.runDirectory, "state.json"))).toBe(true);
        expect(existsSync(join(lc.runDirectory, "issue.json"))).toBe(true);
        expect(existsSync(lc.artifactsDir)).toBe(true);
        expect(existsSync(lc.handoffDir)).toBe(true);

        // Check lock acquisition
        const lockDir = join(lc.stateRoot, "locks", `issue-${issue.number}`);
        expect(existsSync(lockDir)).toBe(true);
        const ownerJson = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
        expect(ownerJson.pid).toBe(process.pid);
        expect(ownerJson.runId).toBe(lc.runId);

        // State check
        expect(lc.state.runId).toBe(lc.runId);
        expect(lc.state.status).toBe("preparing");
        expect(lc.state.route).toBe("simple");
        expect(lc.route).toBe("simple");
        expect(lc.checks).toEqual(["echo static-check-ok", "echo unit-check-ok"]);
        expect(lc.maxLaps).toBeGreaterThanOrEqual(1);

        // Save mutation verification
        lc.state.status = "building";
        await lc.save();
        const savedState = JSON.parse(readFileSync(join(lc.runDirectory, "state.json"), "utf8"));
        expect(savedState.status).toBe("building");
      } finally {
        await lc.releaseLock();
      }

      // Verify lock is released
      const lockDirAfter = join(lc.stateRoot, "locks", `issue-${issue.number}`);
      expect(existsSync(lockDirAfter)).toBe(false);
    });

    test("fails closed if harness config lacks ordinary checks", async () => {
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
      expect(setupLoopLifecycle(root, issue, { push: false })).rejects.toThrow(
        "No declared ordinary project checks",
      );
    });

    test("parses partOf subticket and configures integration branch", async () => {
      const root = await createRepoFixture();
      const issue = makeValidIssue({
        number: 57,
        url: "https://github.com/example/repo/issues/57",
        body: "Part of #10: build auth subfeature",
      });

      const lc = await setupLoopLifecycle(root, issue, { push: false });
      try {
        expect(lc.partOf).toBe(10);
        expect(lc.integrationBranch).toBe("factory/spec-10-integration");
        expect(lc.baseBranch).toBe("factory/spec-10-integration");
      } finally {
        await lc.releaseLock();
      }
    });

    test("F1: post-acquisition failure in setupLoopLifecycle releases lock so same issue can reacquire", async () => {
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

      // setupLoopLifecycle should fail with our simulated post-acquisition error
      expect(setupLoopLifecycle(root, issue, { push: false })).rejects.toThrow(
        "Simulated post-acquisition failure",
      );

      // Prove same issue can reacquire lock immediately without throwing "Issue 99 is locked"
      const { common } = await inspectLocalLoop(root);
      const stateRoot = join(common, "factory-local-loop");
      const lockRelease = await acquireIssueLock(stateRoot, 99);
      expect(typeof lockRelease).toBe("function");
      await lockRelease();
    });
  });

  describe("AC2: barrel export", () => {
    test("scripts/loop/index.ts barrel exports setupLoopLifecycle", () => {
      expect((loopExports as any).setupLoopLifecycle).toBeFunction();
    });
  });
});
