import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { CommandLedger } from "../../apps/backend/src/command";
import {
  SpecCoordinatorService,
  CoordinationError,
  buildDependencyDAG,
  WorktreeManager,
  validateTargetedPrimitive,
  SerializedIntegrationManager,
  handleProjectCoordinationRoute,
} from "../../apps/backend/src/coordination";
import { createFactoryClient } from "@labq/client";
import { specCoordinationPlanSchema } from "@labq/contracts/operator";

describe("Spec Coordination via Targeted archon-implement, Worktree Isolation & Single Final PR (Issue #62)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let ledger: CommandLedger;
  let coordinator: SpecCoordinatorService;
  let repoPath: string;
  let projectId: string;

  function initGitRepo(dir: string, remoteRepo = "owner/repo-spec"): string {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(join(dir, "README.md"), "# Spec Coordination Test Repo\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
    writeFileSync(
      join(dir, ".git", "config"),
      `[remote "origin"]\n  url = https://github.com/${remoteRepo}.git\n`,
      { flag: "a" },
    );
    return dir;
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "labq-coord-test-"));
    dbPath = join(tempDir, "state", "console.db");
    db = initializeDatabase(dbPath);
    forge = new SyntheticForgeAdapter({
      "owner/repo-spec": 201,
    });
    registry = new ProjectRegistryService(db, forge);
    ledger = new CommandLedger(db);
    coordinator = new SpecCoordinatorService(db, forge, { ledger });

    repoPath = join(tempDir, "checkout-spec");
    mkdirSync(repoPath, { recursive: true });
    initGitRepo(repoPath, "owner/repo-spec");

    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Spec Project",
      checkout_path: repoPath,
    });
    projectId = project.id;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("AC1 (Parent AC09, P2): Spec Coordinator Snapshot & Targeted archon-implement Primitive", () => {
    test("coordinator snapshots admitted child tickets, dependency DAG, and frozen contracts", async () => {
      // Setup spec parent and child tickets on forge
      forge.addIssue("owner/repo-spec", {
        number: 58,
        title: "Spec: Multi-repo software factory",
        state: "OPEN",
        body: "## Source and problem\nParent spec for console.\n## Outcome\nDelivers console.",
        labels: ["needs-info"],
      });

      forge.addIssue("owner/repo-spec", {
        number: 60,
        title: "feat(command): durable command ledger",
        state: "OPEN",
        body: "Part of #58\n\n## Source and problem\nNeed durable ledger.\n\n## Outcome\nWAL persistence.\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      forge.addIssue("owner/repo-spec", {
        number: 61,
        title: "feat(intake): structured intake",
        state: "OPEN",
        body: "Part of #58\n\n## Source and problem\nNeed intake.\n\n## Outcome\nAdmission gate.\n\nDepends on: #60",
        labels: ["ready-for-agent"],
      });

      forge.addIssue("owner/repo-spec", {
        number: 62,
        title: "feat(coordination): spec coordination",
        state: "OPEN",
        body: "Part of #58\n\n## Source and problem\nNeed coordination.\n\n## Outcome\nIsolated worktrees.\n\nDepends on: #60, #61",
        labels: ["ready-for-agent"],
      });

      const plan = await coordinator.planSpec(projectId, 58);

      expect(plan.specIssueNumber).toBe(58);
      expect(plan.isStandalone).toBe(false);
      expect(plan.children).toHaveLength(3);
      expect(plan.dag["60"]).toEqual([]);
      expect(plan.dag["61"]).toEqual([60]);
      expect(plan.dag["62"]).toEqual([60, 61]);

      // Verify contract freezing
      const child60 = plan.children.find((c) => c.number === 60)!;
      expect(child60.contract.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(child60.contract.outcome).toContain("WAL persistence");

      // Verify schema conformity
      expect(specCoordinationPlanSchema.parse(plan)).toEqual(plan);
    });

    test("dispatches execution via targeted engine-host primitive archon-implement bound to exact contract", async () => {
      forge.addIssue("owner/repo-spec", {
        number: 58,
        title: "Spec: Coordination",
        state: "OPEN",
        body: "Part of #58",
      });
      forge.addIssue("owner/repo-spec", {
        number: 60,
        title: "feat(command): durable command ledger",
        state: "OPEN",
        body: "Part of #58\n\n## Source and problem\nNeed ledger.\n\n## Outcome\nWAL.\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      await coordinator.planSpec(projectId, 58);

      let capturedSubmission: any = null;
      const runner = async (sub: any) => {
        capturedSubmission = sub;
        // Simulate commit in child worktree
        writeFileSync(join(sub.worktreePath, "command.txt"), "ledger implemented");
        execFileSync("git", ["add", "command.txt"], { cwd: sub.worktreePath, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "feat: command ledger"], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sub.worktreePath,
          encoding: "utf-8",
        }).trim();
        return {
          success: true,
          childIssueNumber: sub.childIssueNumber,
          headSha,
        };
      };

      const result = await coordinator.dispatchChild({
        projectId,
        specIssueNumber: 58,
        childIssueNumber: 60,
        runner,
      });

      expect(result.success).toBe(true);
      expect(capturedSubmission.primitive).toBe("archon-implement");
      expect(capturedSubmission.childIssueNumber).toBe(60);
      expect(capturedSubmission.contract.digest).toMatch(/^[0-9a-f]{64}$/);

      // Verify command ledger recorded before dispatch with state='succeeded' after completion
      const commands = ledger.listCommands({ projectId });
      expect(commands.length).toBeGreaterThanOrEqual(1);
      const cmd = commands.find((c) => c.action === "coordinate_dispatch")!;
      expect(cmd).toBeDefined();
      expect(cmd.state).toBe("succeeded");
    });

    test("strictly rejects general unbound loop pickers (Invariant 1)", () => {
      expect(() => validateTargetedPrimitive("archon-loop")).toThrow(CoordinationError);
      expect(() => validateTargetedPrimitive("unbound-picker")).toThrow(CoordinationError);
      expect(() => validateTargetedPrimitive("archon-implement")).not.toThrow();
    });

    test("detects and rejects dependency cycles in child tickets", () => {
      expect(() =>
        buildDependencyDAG([
          { number: 1, dependencies: [2] },
          { number: 2, dependencies: [3] },
          { number: 3, dependencies: [1] },
        ]),
      ).toThrow(CoordinationError);
    });

    test("prevents dispatching child ticket before its prerequisites are satisfied", async () => {
      forge.addIssue("owner/repo-spec", {
        number: 58,
        title: "Spec: DAG Dependencies",
        state: "OPEN",
        body: "Spec",
      });
      forge.addIssue("owner/repo-spec", {
        number: 10,
        title: "Prerequisite Ticket",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });
      forge.addIssue("owner/repo-spec", {
        number: 11,
        title: "Dependent Ticket",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: #10",
        labels: ["ready-for-agent"],
      });

      await coordinator.planSpec(projectId, 58);

      // Attempting to dispatch #11 when #10 is neither integrated nor closed on forge fails
      await expect(
        coordinator.dispatchChild({
          projectId,
          specIssueNumber: 58,
          childIssueNumber: 11,
        }),
      ).rejects.toThrow(/prerequisite #10 is neither integrated to branch nor closed/);
    });
  });

  describe("AC2 (Parent AC10, P2): Isolated Git Worktree Lifecycle & Exclusive Lock", () => {
    test("worker allocates isolated git worktree with verified starting SHA and cleanliness", () => {
      const worktreeManager = new WorktreeManager();
      const worktreeDir = join(tempDir, "worktree-clean");
      const startSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();

      const allocation = worktreeManager.allocateWorktree({
        repoRoot: repoPath,
        worktreeDir,
        branch: "test/isolated-branch-clean",
        startSha,
        issueNumber: 42,
      });

      expect(allocation.worktreeDir).toBe(worktreeDir);
      expect(allocation.startSha).toBe(startSha);
      expect(existsSync(join(worktreeDir, ".worktree.lock"))).toBe(true);

      allocation.releaseLock();
      expect(existsSync(join(worktreeDir, ".worktree.lock"))).toBe(false);
    });

    test("fails closed if starting SHA mismatches expected base", () => {
      const worktreeManager = new WorktreeManager();
      const worktreeDir = join(tempDir, "worktree-sha-mismatch");
      const bogusSha = "0000000000000000000000000000000000000000";

      expect(() =>
        worktreeManager.allocateWorktree({
          repoRoot: repoPath,
          worktreeDir,
          branch: "test/isolated-branch-bad-sha",
          startSha: bogusSha,
          issueNumber: 42,
        }),
      ).toThrow(CoordinationError);
    });

    test("fails closed if worktree is dirty with uncommitted changes", () => {
      const worktreeManager = new WorktreeManager();
      const worktreeDir = join(tempDir, "worktree-dirty");
      const startSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();

      // Pre-create worktree and make it dirty
      execFileSync("git", ["worktree", "add", "-b", "test/dirty-branch", worktreeDir, startSha], {
        cwd: repoPath,
        stdio: "ignore",
      });
      writeFileSync(join(worktreeDir, "uncommitted.txt"), "dirty untracked file");

      expect(() =>
        worktreeManager.allocateWorktree({
          repoRoot: repoPath,
          worktreeDir,
          branch: "test/dirty-branch",
          startSha,
          issueNumber: 42,
        }),
      ).toThrow(/uncommitted changes or untracked files detected/);
    });

    test("enforces exclusive locking: concurrent allocation on locked worktree is rejected", () => {
      const worktreeManager = new WorktreeManager();
      const worktreeDir = join(tempDir, "worktree-locked");
      const startSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();

      const alloc1 = worktreeManager.allocateWorktree({
        repoRoot: repoPath,
        worktreeDir,
        branch: "test/locked-branch",
        startSha,
        issueNumber: 42,
      });

      // Attempting to allocate second worker while lock is held throws worktree_lock_conflict
      expect(() =>
        worktreeManager.allocateWorktree({
          repoRoot: repoPath,
          worktreeDir,
          branch: "test/locked-branch",
          startSha,
          issueNumber: 42,
        }),
      ).toThrow(/exclusively locked/);

      alloc1.releaseLock();
    });
  });

  describe("AC3 (Parent AC10, P2): Serialized Integration Branch & unblocking dependent child tickets", () => {
    test("successful child run merges into local integration branch, sets integrated_to_branch, and unblocks downstream children", async () => {
      forge.addIssue("owner/repo-spec", {
        number: 58,
        title: "Spec: Serialized Integration",
        state: "OPEN",
        body: "Spec",
      });
      forge.addIssue("owner/repo-spec", {
        number: 101,
        title: "Child Ticket 1",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });
      forge.addIssue("owner/repo-spec", {
        number: 102,
        title: "Child Ticket 2",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: #101",
        labels: ["ready-for-agent"],
      });

      await coordinator.planSpec(projectId, 58);

      // Child 1 executes successfully
      const runner = async (sub: any) => {
        writeFileSync(
          join(sub.worktreePath, `child-${sub.childIssueNumber}.txt`),
          `done ${sub.childIssueNumber}`,
        );
        execFileSync("git", ["add", `child-${sub.childIssueNumber}.txt`], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", `feat: child ${sub.childIssueNumber}`], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sub.worktreePath,
          encoding: "utf-8",
        }).trim();
        return { success: true, childIssueNumber: sub.childIssueNumber, headSha };
      };

      const res1 = await coordinator.dispatchChild({
        projectId,
        specIssueNumber: 58,
        childIssueNumber: 101,
        runner,
      });

      expect(res1.success).toBe(true);

      // Check SQLite table project_issue_integrations
      const integrationRow = db
        .prepare(
          "SELECT * FROM project_issue_integrations WHERE project_id = ? AND issue_number = ?",
        )
        .get(projectId, 101) as any;
      expect(integrationRow).toBeDefined();
      expect(integrationRow.issue_number).toBe(101);
      expect(integrationRow.commit_sha).toBe(res1.headSha);

      // Check that GitHub issue 101 was NOT closed prematurely
      const forgeIssue101 = await forge.getIssue("owner/repo-spec", 101);
      expect(forgeIssue101?.state).toBe("OPEN");

      // Check that child 102 is now unblocked and can be dispatched
      const res2 = await coordinator.dispatchChild({
        projectId,
        specIssueNumber: 58,
        childIssueNumber: 102,
        runner,
      });

      expect(res2.success).toBe(true);
      const integrationRow2 = db
        .prepare(
          "SELECT * FROM project_issue_integrations WHERE project_id = ? AND issue_number = ?",
        )
        .get(projectId, 102) as any;
      expect(integrationRow2).toBeDefined();
      expect(integrationRow2.issue_number).toBe(102);
    });
  });

  describe("AC4 (Parent AC10, P2): Single Final PR & Zero Child PRs", () => {
    test("multi-ticket spec creates exactly one final GitHub PR once all children are integrated", async () => {
      forge.addIssue("owner/repo-spec", {
        number: 58,
        title: "Spec: Full Delivery",
        state: "OPEN",
        body: "Spec",
      });
      forge.addIssue("owner/repo-spec", {
        number: 201,
        title: "Subticket 1",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });
      forge.addIssue("owner/repo-spec", {
        number: 202,
        title: "Subticket 2",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      await coordinator.planSpec(projectId, 58);

      const runner = async (sub: any) => {
        writeFileSync(
          join(sub.worktreePath, `feat-${sub.childIssueNumber}.txt`),
          `content ${sub.childIssueNumber}`,
        );
        execFileSync("git", ["add", `feat-${sub.childIssueNumber}.txt`], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", `feat: subticket ${sub.childIssueNumber}`], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sub.worktreePath,
          encoding: "utf-8",
        }).trim();
        return { success: true, childIssueNumber: sub.childIssueNumber, headSha };
      };

      // Dispatch and integrate both children
      await coordinator.dispatchChild({
        projectId,
        specIssueNumber: 58,
        childIssueNumber: 201,
        runner,
      });

      // Attempting to create final PR before subticket 202 is integrated is rejected
      await expect(
        coordinator.createFinalPullRequest({ projectId, specIssueNumber: 58 }),
      ).rejects.toThrow(/child ticket\(s\) are not integrated: #202/);

      // Verify zero PRs exist so far
      const prsBefore = await forge.listPullRequests("owner/repo-spec");
      expect(prsBefore).toHaveLength(0);

      // Complete subticket 202
      await coordinator.dispatchChild({
        projectId,
        specIssueNumber: 58,
        childIssueNumber: 202,
        runner,
      });

      // Now create final PR
      const finalPr = await coordinator.createFinalPullRequest({
        projectId,
        specIssueNumber: 58,
        baseBranch: "main",
      });

      expect(finalPr.prNumber).toBeGreaterThan(0);
      expect(finalPr.integratedChildren).toEqual([201, 202]);

      // Exactly ONE PR was created on forge, not per child!
      const allPrs = await forge.listPullRequests("owner/repo-spec");
      expect(allPrs).toHaveLength(1);
      expect(allPrs[0].number).toBe(finalPr.prNumber);
      expect(allPrs[0].head).toContain("factory/spec-58-integration");
    });

    test("standalone tickets create exactly one PR", async () => {
      forge.addIssue("owner/repo-spec", {
        number: 300,
        title: "feat(standalone): independent feature",
        state: "OPEN",
        body: "## Source and problem\nStandalone work.\n## Outcome\nSingle PR delivery.\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      const plan = await coordinator.planSpec(projectId, 300);
      expect(plan.isStandalone).toBe(true);
      expect(plan.children).toHaveLength(1);

      const runner = async (sub: any) => {
        writeFileSync(join(sub.worktreePath, "standalone.txt"), "standalone code");
        execFileSync("git", ["add", "standalone.txt"], { cwd: sub.worktreePath, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "feat: standalone"], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sub.worktreePath,
          encoding: "utf-8",
        }).trim();
        return { success: true, childIssueNumber: sub.childIssueNumber, headSha };
      };

      await coordinator.dispatchChild({
        projectId,
        specIssueNumber: 300,
        childIssueNumber: 300,
        runner,
      });

      const finalPr = await coordinator.createFinalPullRequest({ projectId, specIssueNumber: 300 });
      expect(finalPr.prNumber).toBeGreaterThan(0);
      expect(finalPr.integratedChildren).toEqual([300]);

      const prs = await forge.listPullRequests("owner/repo-spec");
      expect(prs).toHaveLength(1);
    });
  });

  describe("AC5 (Parent AC09, P2): Integration Conflicts, Drift, Worker Crashes & Ledger Audit", () => {
    test("integration conflict halts pipeline, preserves attribution & worktree, and leaves integration branch uncorrupted", async () => {
      forge.addIssue("owner/repo-spec", {
        number: 58,
        title: "Spec: Conflict Test",
        state: "OPEN",
        body: "Spec",
      });
      forge.addIssue("owner/repo-spec", {
        number: 401,
        title: "Conflicting Child 1",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });
      forge.addIssue("owner/repo-spec", {
        number: 402,
        title: "Conflicting Child 2",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      await coordinator.planSpec(projectId, 58);

      // First child modifies conflict.txt
      const runner1 = async (sub: any) => {
        writeFileSync(join(sub.worktreePath, "conflict.txt"), "Version from child 401\n");
        execFileSync("git", ["add", "conflict.txt"], { cwd: sub.worktreePath, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "feat: child 401 conflict.txt"], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sub.worktreePath,
          encoding: "utf-8",
        }).trim();
        return { success: true, childIssueNumber: sub.childIssueNumber, headSha };
      };
      await coordinator.dispatchChild({
        projectId,
        specIssueNumber: 58,
        childIssueNumber: 401,
        runner: runner1,
      });

      // Second child modifies conflict.txt with conflicting content
      const runner2 = async (sub: any) => {
        writeFileSync(
          join(sub.worktreePath, "conflict.txt"),
          "Completely different Version from child 402\n",
        );
        execFileSync("git", ["add", "conflict.txt"], { cwd: sub.worktreePath, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "feat: child 402 conflict.txt"], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sub.worktreePath,
          encoding: "utf-8",
        }).trim();
        return { success: true, childIssueNumber: sub.childIssueNumber, headSha };
      };

      // Attempting to integrate child 402 triggers a merge conflict
      await expect(
        coordinator.dispatchChild({
          projectId,
          specIssueNumber: 58,
          childIssueNumber: 402,
          runner: runner2,
        }),
      ).rejects.toThrow(CoordinationError);

      // Verify coordination pipeline halted
      const updatedPlan = coordinator.getPlan(projectId, 58)!;
      expect(updatedPlan.status).toBe("halted");
      expect(updatedPlan.haltAttribution?.stage).toBe("serialized_integration");
      expect(updatedPlan.haltAttribution?.childIssueNumber).toBe(402);

      // Verify worktree state is preserved on disk for post-mortem analysis
      const worktreeDir = updatedPlan.haltAttribution?.worktreePath;
      expect(worktreeDir).toBeDefined();
      expect(existsSync(worktreeDir!)).toBe(true);
      expect(existsSync(join(worktreeDir!, "conflict.txt"))).toBe(true);

      // Verify integration branch is NOT corrupted (no unresolved conflict markers)
      const integrationBranchHead = execFileSync(
        "git",
        ["rev-parse", updatedPlan.integrationBranch],
        {
          cwd: repoPath,
          encoding: "utf-8",
        },
      ).trim();
      expect(integrationBranchHead).toBe(updatedPlan.currentIntegrationSha);

      // Command ledger recorded failure
      const commands = ledger.listCommands({ projectId });
      const failedCmd = commands.find((c) => c.state === "failed");
      expect(failedCmd).toBeDefined();
    });

    test("integration drift halts pipeline without corrupting branch", async () => {
      const integrationManager = new SerializedIntegrationManager();

      // Fake stale expectedIntegrationSha
      const staleSha = "1111111111111111111111111111111111111111";

      await expect(
        integrationManager.integrateChildSerialized({
          repoRoot: repoPath,
          integrationBranch: "main",
          expectedIntegrationSha: staleSha,
          childBranch: "main",
          childIssueNumber: 999,
        }),
      ).rejects.toThrow(/Integration drift detected/);
    });

    test("worker crash halts coordination pipeline and preserves worktree & ledger failure", async () => {
      forge.addIssue("owner/repo-spec", {
        number: 58,
        title: "Spec: Crash Test",
        state: "OPEN",
        body: "Spec",
      });
      forge.addIssue("owner/repo-spec", {
        number: 501,
        title: "Crashing Child",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      await coordinator.planSpec(projectId, 58);

      const crashingRunner = async () => {
        throw new Error("Worker SIGSEGV crash during execution");
      };

      const result = await coordinator.dispatchChild({
        projectId,
        specIssueNumber: 58,
        childIssueNumber: 501,
        runner: crashingRunner,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Worker SIGSEGV crash");

      const plan = coordinator.getPlan(projectId, 58)!;
      expect(plan.status).toBe("halted");
      expect(plan.haltAttribution?.error).toContain("Worker SIGSEGV crash");

      // Worktree remains intact on disk
      const crashWorktreeDir = plan.haltAttribution?.worktreePath;
      expect(crashWorktreeDir).toBeDefined();
      expect(existsSync(crashWorktreeDir!)).toBe(true);
    });
  });

  describe("HTTP Routes & Scoped Client SDK Integration (@labq/client)", () => {
    test("handles full coordination lifecycle via HTTP and @labq/client", async () => {
      forge.addIssue("owner/repo-spec", {
        number: 58,
        title: "Spec: API Coordination",
        state: "OPEN",
        body: "Part of #58",
      });
      forge.addIssue("owner/repo-spec", {
        number: 601,
        title: "Subticket 601",
        state: "OPEN",
        body: "Part of #58\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      const testRunner = async (sub: any) => {
        writeFileSync(join(sub.worktreePath, `sub-${sub.childIssueNumber}.txt`), "done");
        execFileSync("git", ["add", `sub-${sub.childIssueNumber}.txt`], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "-m", `feat: sub ${sub.childIssueNumber}`], {
          cwd: sub.worktreePath,
          stdio: "ignore",
        });
        const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sub.worktreePath,
          encoding: "utf-8",
        }).trim();
        return { success: true, childIssueNumber: sub.childIssueNumber, headSha };
      };

      const customCoordinator = new SpecCoordinatorService(db, forge, {
        ledger,
        implementRunner: testRunner,
      });

      // Synthetic HTTP handler simulating backend server
      const transport = async (url: string, init?: RequestInit): Promise<Response> => {
        const u = new URL(url);
        const parts = u.pathname.replace(/^\/api\/v1\/projects\//, "").split("/");
        const req = new Request(url, init);
        const res = await handleProjectCoordinationRoute(req, parts[0], parts, customCoordinator);
        if (!res) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        return res;
      };

      const client = createFactoryClient({
        baseUrl: "http://127.0.0.1:4000",
        fetch: transport,
      });

      const projectClient = client.forProject(projectId);

      // 1. Plan coordination
      const plan = await projectClient.planSpecCoordination(58);
      expect(plan.specIssueNumber).toBe(58);
      expect(plan.children).toHaveLength(1);

      // 2. Query plan
      const fetchedPlan = await projectClient.getSpecCoordinationPlan(58);
      expect(fetchedPlan.id).toBe(plan.id);

      // 3. Dispatch child
      const res = await projectClient.dispatchSubticket(58, 601);
      expect(res.childIssueNumber).toBe(601);
      expect(res.success).toBe(true);

      // 4. Create final PR
      const finalPr = await projectClient.createFinalPullRequest({
        specIssueNumber: 58,
        baseBranch: "main",
      });
      expect(finalPr.prNumber).toBeGreaterThan(0);
      expect(finalPr.integratedChildren).toEqual([601]);
    });

    test("client parses structured coordination error codes instead of generic invalid_operator_response", async () => {
      const transport = async (url: string, init?: RequestInit): Promise<Response> => {
        const u = new URL(url);
        const parts = u.pathname.replace(/^\/api\/v1\/projects\//, "").split("/");
        const req = new Request(url, init);
        const res = await handleProjectCoordinationRoute(req, parts[0], parts, coordinator);
        if (!res) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        return res;
      };

      const client = createFactoryClient({
        baseUrl: "http://127.0.0.1:4000",
        fetch: transport,
      });

      const projectClient = client.forProject(projectId);

      // Attempting to get nonexistent plan throws FactoryClientError with code 'plan_not_found'
      try {
        await projectClient.getSpecCoordinationPlan(9999);
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.code).toBe("plan_not_found");
      }
    });
  });
});
