import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  git,
  inspectLocalLoop,
  findExistingWorktreeForBranch,
  acquireIssueLock,
  prepareLoopWorktree,
  assertCandidate,
} from "../../scripts/loop/worktree";
import * as loopExports from "../../scripts/loop/index";
import {
  inspectLocalLoop as localLoopInspect,
  findExistingWorktreeForBranch as localLoopFindWorktree,
  acquireIssueLock as localLoopAcquireLock,
  prepareLoopWorktree as localLoopPrepareWorktree,
  assertCandidate as localLoopAssertCandidate,
} from "../../scripts/local-loop";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function initGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "worktree-test-repo-"));
  tempDirs.push(dir);
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.name", "Test Agent");
  await git(dir, "config", "user.email", "agent@animus.local");
  await writeFile(join(dir, "README.md"), "# Test Repository\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "initial commit");
  return dir;
}

describe("scripts/loop/worktree", () => {
  describe("AC1: git helper", () => {
    test("runs git commands in target root and returns trimmed stdout", async () => {
      const repo = await initGitRepo();
      const branch = await git(repo, "symbolic-ref", "--short", "HEAD");
      expect(branch).toBe("main");
    });

    test("throws fail-closed with command name and stderr on git failure", async () => {
      const repo = await initGitRepo();
      expect(git(repo, "rev-parse", "refs/heads/non-existent-xyz")).rejects.toThrow(
        "git rev-parse failed",
      );
    });
  });

  describe("AC1: inspectLocalLoop", () => {
    test("identifies git common dir and primary worktree", async () => {
      const repo = await initGitRepo();
      const { common, primary } = await inspectLocalLoop(repo);
      expect(common).toBeDefined();
      expect(primary).toBeDefined();
      expect(realpathSync(primary)).toBe(realpathSync(repo));
    });

    test("throws when STOP or PAUSE brake file exists", async () => {
      const repo = await initGitRepo();
      const brakeDir = join(repo, ".factory");
      await mkdir(brakeDir, { recursive: true });
      await writeFile(join(brakeDir, "STOP"), "emergency stop");

      expect(inspectLocalLoop(repo)).rejects.toThrow("STOP brake is active");

      await rm(join(brakeDir, "STOP"));
      await writeFile(join(brakeDir, "PAUSE"), "temporary pause");

      expect(inspectLocalLoop(repo)).rejects.toThrow("PAUSE brake is active");
    });
  });

  describe("AC1: findExistingWorktreeForBranch", () => {
    test("returns path of worktree holding branch and null for non-existent branch", async () => {
      const repo = await initGitRepo();
      const wtPath = await mkdtemp(join(tmpdir(), "worktree-extra-"));
      tempDirs.push(wtPath);
      await rm(wtPath, { recursive: true, force: true });

      await git(repo, "branch", "feature-abc");
      await git(repo, "worktree", "add", wtPath, "feature-abc");

      const found = await findExistingWorktreeForBranch(repo, "feature-abc");
      expect(found).not.toBeNull();
      expect(realpathSync(found!)).toBe(realpathSync(wtPath));

      const nonExistent = await findExistingWorktreeForBranch(repo, "feature-not-there");
      expect(nonExistent).toBeNull();
    });
  });

  describe("AC1: acquireIssueLock & stale PID cleanup", () => {
    test("acquires lock, writes owner.json, and releases cleanly", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "lock-root-"));
      tempDirs.push(stateRoot);

      const release = await acquireIssueLock(stateRoot, 101, {
        runId: "run-101",
        issue: "https://github.com/org/repo/issues/101",
      });

      const lockDir = join(stateRoot, "locks", "issue-101");
      expect(existsSync(lockDir)).toBe(true);

      const ownerFile = join(lockDir, "owner.json");
      expect(existsSync(ownerFile)).toBe(true);
      const owner = JSON.parse(readFileSync(ownerFile, "utf-8"));
      expect(owner.pid).toBe(process.pid);
      expect(owner.runId).toBe("run-101");

      await release();
      expect(existsSync(lockDir)).toBe(false);
    });

    test("fails closed when lock is held by active process", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "lock-root-"));
      tempDirs.push(stateRoot);

      const release = await acquireIssueLock(stateRoot, 102);
      try {
        expect(acquireIssueLock(stateRoot, 102)).rejects.toThrow("Issue 102 is locked");
      } finally {
        await release();
      }
    });

    test("reclaims stale lock when owner PID is dead", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "lock-root-"));
      tempDirs.push(stateRoot);

      const lockDir = join(stateRoot, "locks", "issue-103");
      await mkdir(lockDir, { recursive: true });
      // Write dead PID 99999999 (almost certainly dead on POSIX)
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid: 99999999, runId: "stale-run" }),
      );

      const release = await acquireIssueLock(stateRoot, 103, { runId: "fresh-run" });
      try {
        const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8"));
        expect(owner.pid).toBe(process.pid);
        expect(owner.runId).toBe("fresh-run");
      } finally {
        await release();
      }
    });

    test("fails closed when owner.json is missing or corrupted and directory exists", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "lock-root-"));
      tempDirs.push(stateRoot);

      const lockDir = join(stateRoot, "locks", "issue-104");
      await mkdir(lockDir, { recursive: true });

      // No owner.json -> stale=false -> fails closed
      expect(acquireIssueLock(stateRoot, 104)).rejects.toThrow("Issue 104 is locked");
    });

    test("ownerToken protects lock against replacement and same-PID ABA release", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "lock-root-"));
      tempDirs.push(stateRoot);

      const release1 = await acquireIssueLock(stateRoot, 105);
      const lockDir = join(stateRoot, "locks", "issue-105");
      const ownerFile = join(lockDir, "owner.json");

      const owner1 = JSON.parse(readFileSync(ownerFile, "utf-8"));
      expect(owner1.ownerToken).toBeDefined();

      // Simulate same-PID replacement with a new ownerToken (e.g. renewal or nested run)
      const replacedPayload = {
        pid: process.pid,
        ownerToken: "new-replacement-token",
        runId: "replacement-run",
      };
      await writeFile(ownerFile, JSON.stringify(replacedPayload, null, 2));

      // Attempting to release via the FIRST callback must NOT delete the replaced lock!
      await release1();
      expect(existsSync(lockDir)).toBe(true);
      expect(existsSync(ownerFile)).toBe(true);

      const afterAttempt = JSON.parse(readFileSync(ownerFile, "utf-8"));
      expect(afterAttempt.ownerToken).toBe("new-replacement-token");
    });

    test("competing stale lock reclamation atomically reclaims without cross-process corruption", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "lock-root-"));
      tempDirs.push(stateRoot);

      const lockDir = join(stateRoot, "locks", "issue-106");
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid: 99999999, runId: "dead-run" }),
      );

      // Two competing workers try to reclaim the stale lock concurrently
      const results = await Promise.allSettled([
        acquireIssueLock(stateRoot, 106, { worker: "A" }),
        acquireIssueLock(stateRoot, 106, { worker: "B" }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");

      // At least one must succeed; lock must be in a clean, consistent state
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(lockDir)).toBe(true);

      const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8"));
      expect(owner.pid).toBe(process.pid);
      expect(owner.ownerToken).toBeDefined();

      // Clean up the successful lock
      for (const res of fulfilled) {
        if (res.status === "fulfilled") {
          await res.value();
        }
      }
    });
  });

  describe("AC1: prepareLoopWorktree", () => {
    test("allocates new worktree with sparse-checkout and sets hooksPath if .githooks exists", async () => {
      const repo = await initGitRepo();
      const githooksDir = join(repo, ".githooks");
      await mkdir(githooksDir, { recursive: true });
      await writeFile(join(githooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");

      const wtPath = join(repo, "worktrees", "issue-201");
      const base = await git(repo, "rev-parse", "HEAD");

      const res = await prepareLoopWorktree({
        root: repo,
        worktreePath: wtPath,
        branch: "local-loop/issue-201",
        base,
        route: "simple",
      });

      expect(res.worktreePath).toBe(wtPath);
      expect(res.isReused).toBe(false);
      expect(existsSync(wtPath)).toBe(true);

      // Verify sparse checkout pattern includes !/.factory/holdout/
      const sparsePatterns = await git(wtPath, "sparse-checkout", "list");
      expect(sparsePatterns).toContain("!/.factory/holdout/");

      // Verify core.hooksPath was configured
      const hooksPath = await git(wtPath, "config", "core.hooksPath");
      expect(hooksPath).toBe(githooksDir);
    });

    test("reuses existing worktree and configures core.hooksPath", async () => {
      const repo = await initGitRepo();
      const githooksDir = join(repo, ".githooks");
      await mkdir(githooksDir, { recursive: true });

      const wtPath = join(repo, "worktrees", "issue-202");
      const base = await git(repo, "rev-parse", "HEAD");

      // First run allocates
      await prepareLoopWorktree({
        root: repo,
        worktreePath: wtPath,
        branch: "local-loop/issue-202",
        base,
      });

      // Add untracked file to worktree
      await writeFile(join(wtPath, "untracked.tmp"), "temp");

      // Second run reuses worktree and cleans untracked files
      const res = await prepareLoopWorktree({
        root: repo,
        worktreePath: wtPath,
        branch: "local-loop/issue-202",
        base,
        existingWorktree: wtPath,
      });

      expect(res.isReused).toBe(true);
      expect(existsSync(join(wtPath, "untracked.tmp"))).toBe(false);

      const hooksPath = await git(wtPath, "config", "core.hooksPath");
      expect(hooksPath).toBe(githooksDir);
    });
  });

  describe("AC1: assertCandidate", () => {
    test("validates clean candidate, ancestors, and returns candidate SHA", async () => {
      const repo = await initGitRepo();
      const wtPath = join(repo, "worktrees", "issue-301");
      const base = await git(repo, "rev-parse", "HEAD");

      await prepareLoopWorktree({
        root: repo,
        worktreePath: wtPath,
        branch: "local-loop/issue-301",
        base,
      });

      // Add a valid commit in the worktree
      await writeFile(join(wtPath, "feature.txt"), "hello world\n");
      await git(wtPath, "add", "feature.txt");
      await git(wtPath, "commit", "-m", "feat: add feature.txt");
      const candidateSha = await git(wtPath, "rev-parse", "HEAD");

      const validatedSha = await assertCandidate({
        root: repo,
        worktree: wtPath,
        base,
        expectedCandidate: candidateSha,
      });

      expect(validatedSha).toBe(candidateSha);
    });

    test("fails closed when worktree has uncommitted changes", async () => {
      const repo = await initGitRepo();
      const wtPath = join(repo, "worktrees", "issue-302");
      const base = await git(repo, "rev-parse", "HEAD");

      await prepareLoopWorktree({
        root: repo,
        worktreePath: wtPath,
        branch: "local-loop/issue-302",
        base,
      });

      await writeFile(join(wtPath, "dirty.txt"), "dirty uncommitted\n");

      expect(
        assertCandidate({
          root: repo,
          worktree: wtPath,
          base,
        }),
      ).rejects.toThrow("Candidate has uncommitted or untracked changes");
    });

    test("fails closed when expectedCandidate does not match HEAD", async () => {
      const repo = await initGitRepo();
      const wtPath = join(repo, "worktrees", "issue-303");
      const base = await git(repo, "rev-parse", "HEAD");

      await prepareLoopWorktree({
        root: repo,
        worktreePath: wtPath,
        branch: "local-loop/issue-303",
        base,
      });

      expect(
        assertCandidate({
          root: repo,
          worktree: wtPath,
          base,
          expectedCandidate: "0000000000000000000000000000000000000000",
        }),
      ).rejects.toThrow("Candidate changed during verification");
    });

    test("fails closed when candidate changes protected paths", async () => {
      const repo = await initGitRepo();
      const wtPath = join(repo, "worktrees", "issue-304");
      const base = await git(repo, "rev-parse", "HEAD");

      await prepareLoopWorktree({
        root: repo,
        worktreePath: wtPath,
        branch: "local-loop/issue-304",
        base,
      });

      await mkdir(join(wtPath, "harness"), { recursive: true });
      await writeFile(join(wtPath, "harness", "secret.txt"), "protected");
      await git(wtPath, "add", "harness/secret.txt");
      await git(wtPath, "commit", "-m", "violation");

      expect(
        assertCandidate({
          root: repo,
          worktree: wtPath,
          base,
        }),
      ).rejects.toThrow("Candidate changed protected paths");
    });

    test("fails closed when candidate violates blocking codebase rules", async () => {
      const repo = await initGitRepo();
      const wtPath = join(repo, "worktrees", "issue-305");
      const base = await git(repo, "rev-parse", "HEAD");

      await prepareLoopWorktree({
        root: repo,
        worktreePath: wtPath,
        branch: "local-loop/issue-305",
        base,
      });

      // Configure a blocking codebase rule in the worktree
      await mkdir(join(wtPath, ".factory"), { recursive: true });
      await writeFile(
        join(wtPath, ".factory", "codebase-rules.json"),
        JSON.stringify({
          schema_version: 1,
          rules: [
            {
              id: "no-eval",
              description: "eval is prohibited",
              file_glob: "**/*.ts",
              forbid_regex: "\\beval\\(",
              replacement_hint: "avoid eval",
              mode: "block",
            },
          ],
        }),
      );
      await git(wtPath, "add", ".factory/codebase-rules.json");
      await git(wtPath, "commit", "-m", "chore: configure codebase rules");

      await writeFile(join(wtPath, "logic.ts"), "eval('bad code');\n");
      await git(wtPath, "add", "logic.ts");
      await git(wtPath, "commit", "-m", "feat: add logic with eval");

      expect(
        assertCandidate({
          root: repo,
          worktree: wtPath,
          base,
        }),
      ).rejects.toThrow("Candidate violated codebase rules");
    });
  });

  describe("AC2: barrel and facade re-exports", () => {
    test("preserves the existing triage lock contract through the barrel", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "barrel-triage-lock-"));
      tempDirs.push(stateRoot);
      const lock = await loopExports.acquireTriageIssueLock(stateRoot, 401);
      expect(lock).not.toBeNull();
      try {
        expect(await loopExports.acquireTriageIssueLock(stateRoot, 401)).toBeNull();
        expect(existsSync(join(stateRoot, "locks", "issue-401"))).toBe(false);
      } finally {
        await lock!.release();
      }
      const reacquired = await loopExports.acquireTriageIssueLock(stateRoot, 401);
      expect(reacquired).not.toBeNull();
      await reacquired!.release();
    });

    test("scripts/loop/index.ts barrel exports worktree utilities", () => {
      expect(typeof loopExports.git).toBe("function");
      expect(typeof loopExports.inspectLocalLoop).toBe("function");
      expect(typeof loopExports.findExistingWorktreeForBranch).toBe("function");
      expect(typeof loopExports.acquireIssueLock).toBe("function");
      expect(typeof loopExports.acquireWorktreeIssueLock).toBe("function");
      expect(typeof loopExports.prepareLoopWorktree).toBe("function");
      expect(typeof loopExports.assertCandidate).toBe("function");
      expect(typeof loopExports.isPidAlive).toBe("function");
      expect(typeof loopExports.allocateWorktree).toBe("function");
    });

    test("scripts/loop/index.ts barrel exports acquireWorktreeIssueLock without collision", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "barrel-worktree-lock-"));
      tempDirs.push(stateRoot);
      const releaseLock = await loopExports.acquireWorktreeIssueLock(stateRoot, 402, {
        runId: "test-run",
      });
      expect(typeof releaseLock).toBe("function");
      expect(loopExports.acquireWorktreeIssueLock(stateRoot, 402)).rejects.toThrow(
        "Issue 402 is locked",
      );
      await releaseLock();
      const reacquired = await loopExports.acquireWorktreeIssueLock(stateRoot, 402);
      expect(typeof reacquired).toBe("function");
      await reacquired();
    });

    test("scripts/local-loop.ts re-exports inspectLocalLoop and findExistingWorktreeForBranch", () => {
      expect(typeof localLoopInspect).toBe("function");
      expect(typeof localLoopFindWorktree).toBe("function");
      expect(typeof localLoopAcquireLock).toBe("function");
      expect(typeof localLoopPrepareWorktree).toBe("function");
      expect(typeof localLoopAssertCandidate).toBe("function");
    });

    test("isPidAlive accurately identifies PID liveness without relying on age", () => {
      // Current process is alive
      expect(loopExports.isPidAlive(process.pid)).toBe(true);
      // Dead PID 99999999 on POSIX
      expect(loopExports.isPidAlive(99999999)).toBe(false);
      // Invalid inputs return false
      expect(loopExports.isPidAlive(-1)).toBe(false);
      expect(loopExports.isPidAlive(0)).toBe(false);
      expect(loopExports.isPidAlive(NaN)).toBe(false);
    });

    test("allocateWorktree enforces sparse holdout fence, hooks binding, and PID-verified locking", async () => {
      const repo = await initGitRepo();
      const holdoutDir = join(repo, ".factory", "holdout");
      await mkdir(holdoutDir, { recursive: true });
      await writeFile(join(holdoutDir, "secret.json"), JSON.stringify({ key: "val" }));
      const githooksDir = join(repo, ".githooks");
      await mkdir(githooksDir, { recursive: true });
      await writeFile(join(githooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
      await git(repo, "add", "-A");
      await git(repo, "commit", "-m", "chore: setup holdout and hooks");

      const baseSha = await git(repo, "rev-parse", "HEAD");
      const wtDir = join(repo, "worktrees", "alloc-test-501");

      const alloc = loopExports.allocateWorktree({
        repoRoot: repo,
        worktreeDir: wtDir,
        branch: "factory/alloc-501",
        startSha: baseSha,
        issueNumber: 501,
      });

      expect(alloc.worktreeDir).toBe(wtDir);
      expect(existsSync(join(wtDir, ".factory", "holdout", "secret.json"))).toBe(false);
      const sparseList = await git(wtDir, "sparse-checkout", "list");
      expect(sparseList).toContain("!/.factory/holdout/");

      const configuredHooks = await git(wtDir, "config", "core.hooksPath");
      expect(configuredHooks).toBe(githooksDir);

      alloc.releaseLock();
    });

    test("allocateWorktree fails closed on malformed PID in .worktree.lock", async () => {
      const repo = await initGitRepo();
      const baseSha = await git(repo, "rev-parse", "HEAD");
      const wtDir = join(repo, "worktrees", "alloc-bad-pid");
      await mkdir(wtDir, { recursive: true });
      const lockPath = join(wtDir, ".worktree.lock");

      for (const badPid of [-1, 0, "not-a-pid", null]) {
        await writeFile(
          lockPath,
          JSON.stringify({
            runId: "bad-run",
            branch: "factory/bad-branch",
            startSha: baseSha,
            issueNumber: 502,
            lockedAt: new Date(Date.now() - 3600_000 * 24).toISOString(),
            pid: badPid,
          }),
        );

        expect(() =>
          loopExports.allocateWorktree({
            repoRoot: repo,
            worktreeDir: wtDir,
            branch: "factory/bad-branch",
            startSha: baseSha,
            issueNumber: 502,
          }),
        ).toThrow();
      }
    });

    test("allocateWorktree releaseLock enforces owner-only release", async () => {
      const repo = await initGitRepo();
      const baseSha = await git(repo, "rev-parse", "HEAD");
      const wtDir = join(repo, "worktrees", "alloc-owner-release");

      const alloc = loopExports.allocateWorktree({
        repoRoot: repo,
        worktreeDir: wtDir,
        branch: "factory/alloc-owner",
        startSha: baseSha,
        issueNumber: 503,
      });

      const lockPath = join(wtDir, ".worktree.lock");
      expect(existsSync(lockPath)).toBe(true);

      // Overwrite with different runId (simulating another run/process lock)
      await writeFile(
        lockPath,
        JSON.stringify({
          runId: "different-run",
          branch: "factory/alloc-owner",
          startSha: baseSha,
          issueNumber: 503,
          lockedAt: new Date().toISOString(),
          pid: process.pid,
        }),
      );

      // alloc.releaseLock() must not delete a lock owned by different-run
      alloc.releaseLock();
      expect(existsSync(lockPath)).toBe(true);

      // Clean up for test
      unlinkSync(lockPath);
    });
  });
});
