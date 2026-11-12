import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTriageStateRoot,
  isStateRootOutsideCheckout,
  resolveCanonicalGitCommon,
} from "../../scripts/loop/triage-state";
import { runTriagePass, acquireTriageIssueLock } from "../../scripts/loop/triage";
import { SyntheticForgeAdapter } from "../../apps/backend/src/registry";

describe("Triage State Containment & Linked Worktrees (#122 / #123 remediation)", () => {
  let tempDir: string;
  let repoDir: string;
  let worktreeDir: string;
  let animusHome: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "animus-containment-"));
    repoDir = join(tempDir, "main-repo");
    mkdirSync(repoDir, { recursive: true });

    // Initialize a standard git repository
    execFileSync("git", ["init", "--quiet", repoDir]);
    execFileSync("git", [
      "-C",
      repoDir,
      "remote",
      "add",
      "origin",
      "https://github.com/owner/containment-repo.git",
    ]);

    // Create initial commit
    writeFileSync(join(repoDir, "README.md"), "# Containment Repo\n");
    execFileSync("git", ["-C", repoDir, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      repoDir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial commit",
    ]);

    // Create linked worktree
    worktreeDir = join(tempDir, "linked-worktree");
    execFileSync("git", ["-C", repoDir, "worktree", "add", "-b", "feature-wt", worktreeDir]);

    // Configure external animus home
    animusHome = join(tempDir, "animus-home");
    mkdirSync(animusHome, { recursive: true });
    process.env.ANIMUS_HOME = animusHome;
    delete process.env.ANIMUS_STATE_DIR;
    delete process.env.FACTORY_HOME;
    delete process.env.FACTORY_STATE_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("resolveCanonicalGitCommon points to same git common directory for primary and linked worktree", () => {
    const mainCommon = resolveCanonicalGitCommon(repoDir);
    const wtCommon = resolveCanonicalGitCommon(worktreeDir);

    expect(mainCommon).toBe(wtCommon);
    expect(mainCommon).toBe(realpathSync(join(repoDir, ".git")));
  });

  test("resolveTriageStateRoot derives canonical external stateRoot outside checkout root", () => {
    const mainTriageRoot = resolveTriageStateRoot(repoDir);
    const wtTriageRoot = resolveTriageStateRoot(worktreeDir);

    // Both primary repo and linked worktree resolve to EXACT SAME triage stateRoot
    expect(mainTriageRoot).toBe(wtTriageRoot);

    // State root must be strictly outside main-repo checkout
    expect(isStateRootOutsideCheckout(repoDir, mainTriageRoot)).toBe(true);

    // State root must be strictly outside linked-worktree checkout
    expect(isStateRootOutsideCheckout(worktreeDir, wtTriageRoot)).toBe(true);

    // Located in external state dir
    expect(mainTriageRoot).toContain(join(animusHome, "state", "triage"));
  });

  test("explicit caller stateRoot outside checkout is accepted as-is, but inside checkout derives external root", () => {
    const externalDir = join(tempDir, "custom-external-state");
    mkdirSync(externalDir, { recursive: true });

    // Explicit stateRoot outside checkout is preserved
    const preserved = resolveTriageStateRoot(repoDir, externalDir);
    expect(preserved).toBe(externalDir);

    // Builder stateRoot inside checkout (.git/factory-local-loop) is overridden by canonical external stateRoot
    const insideBuilderState = join(repoDir, ".git", "factory-local-loop");
    const derived = resolveTriageStateRoot(repoDir, insideBuilderState);
    expect(derived).not.toBe(insideBuilderState);
    expect(derived).toBe(resolveTriageStateRoot(repoDir));
    expect(isStateRootOutsideCheckout(repoDir, derived)).toBe(true);
  });

  test("REAL runTriagePass succeeds with default derived stateRoot on regular git init repo without containment error", async () => {
    // Scaffold required planning skills and safety hook in repoDir
    mkdirSync(join(repoDir, ".agents"), { recursive: true });
    execFileSync("cp", [
      "-R",
      join(import.meta.dir, "../../.agents/skills"),
      join(repoDir, ".agents/skills"),
    ]);
    mkdirSync(join(repoDir, ".animus/hooks"), { recursive: true });
    execFileSync("cp", [
      join(import.meta.dir, "../../.animus/hooks/loop-guard.ts"),
      join(repoDir, ".animus/hooks/loop-guard.ts"),
    ]);
    execFileSync("git", ["-C", repoDir, "add", "."]);
    execFileSync("git", [
      "-C",
      repoDir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "add skills and hooks",
    ]);

    const forge = new SyntheticForgeAdapter({ "owner/containment-repo": 101 });
    const issue = await forge.createIssue("owner/containment-repo", {
      title: "Implement containment fix",
      body: "Deliver canonical state containment",
      labels: ["needs-triage"],
    });

    const fakeTransport = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        action: "ask_clarification",
        reason: "Missing database target details",
        question: "Which database version should we target?",
      }),
      stderr: "",
    });

    // Call REAL runTriagePass with default stateRoot derived for regular git init repo
    const defaultStateRoot = resolveTriageStateRoot(repoDir);

    const result = await runTriagePass({
      root: repoDir,
      repo: "owner/containment-repo",
      stateRoot: defaultStateRoot,
      forge,
      transport: fakeTransport,
      issueNumber: issue.number,
    });

    expect(result.failureCount).toBe(0);
    expect(result.successCount).toBe(1);
    expect(result.processed[0]?.issueNumber).toBe(issue.number);
    expect(result.processed[0]?.status).toBe("clarification_requested");

    // Verify lock directory was placed in external stateRoot, not inside checkout
    expect(existsSync(join(defaultStateRoot, "triage-locks"))).toBe(true);
    expect(existsSync(join(repoDir, ".git", "factory-local-loop", "triage-locks"))).toBe(false);
  });

  test("linked worktrees share the exact same lock root and prevent concurrent duplicate triage on same issue", async () => {
    const stateRootMain = resolveTriageStateRoot(repoDir);
    const stateRootWt = resolveTriageStateRoot(worktreeDir);
    expect(stateRootMain).toBe(stateRootWt);

    // Acquire lock in primary repo checkout
    const lock1 = await acquireTriageIssueLock(stateRootMain, 42);
    expect(lock1).not.toBeNull();

    // Attempting to acquire lock for issue #42 from linked worktree must fail (already locked)
    const lock2 = await acquireTriageIssueLock(stateRootWt, 42);
    expect(lock2).toBeNull();

    // Release lock in primary repo
    await lock1!.release();

    // Now linked worktree can acquire lock
    const lock3 = await acquireTriageIssueLock(stateRootWt, 42);
    expect(lock3).not.toBeNull();
    await lock3!.release();
  });
});
