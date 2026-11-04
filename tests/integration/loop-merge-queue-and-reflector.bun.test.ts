import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { executeSubticketAutoMerge } from "../../scripts/loop/merge-queue";
import {
  createBoundedReflectionTransport,
  executeTerminalReflection,
} from "../../scripts/loop/reflector";
import { git } from "../../scripts/loop/worktree";
import { RoleInterrupted } from "../../scripts/loop/deadlines";
import type { AutoMergeEvaluationResult } from "../../scripts/loop/types";
import type { IssueDossier } from "../../scripts/loop/dossier";
import * as loopExports from "../../scripts/loop/index";
import * as localLoopExports from "../../scripts/local-loop";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function initGitRepo(): Promise<{ repo: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "merge-reflector-test-"));
  tempDirs.push(dir);
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.name", "Test Agent");
  await git(dir, "config", "user.email", "agent@animus.local");
  await writeFile(join(dir, "README.md"), "# Test Repo\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "initial commit");
  const baseSha = (await git(dir, "rev-parse", "HEAD")).trim();
  return { repo: dir, baseSha };
}

function makeStubEval(
  overrides: Partial<AutoMergeEvaluationResult> = {},
): AutoMergeEvaluationResult {
  return {
    authorized: true,
    decision: "auto_merge",
    isSubticket: true,
    targetBranch: "factory/spec-100-integration",
    baseBranch: "main",
    riskLevel: "low",
    scopeAligned: true,
    criticalImpacts: [],
    deterministicImpacts: [],
    reviewerImpacts: [],
    reasons: [],
    ...overrides,
  };
}

describe("scripts/loop/merge-queue (executeSubticketAutoMerge)", () => {
  test("AC1: advances target integration branch ref with candidate commit via update-ref", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-100-integration";
    await git(repo, "branch", integrationBranch, baseSha);

    // Create candidate commit on a separate branch
    await git(repo, "checkout", "-b", "subticket-42");
    await writeFile(join(repo, "subticket.txt"), "subticket work\n");
    await git(repo, "add", "subticket.txt");
    await git(repo, "commit", "-m", "feat: subticket 42");
    const candidateSha = (await git(repo, "rev-parse", "HEAD")).trim();

    // Checkout main so repo HEAD is not on the integration branch
    await git(repo, "checkout", "main");

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: candidateSha,
      integrationBranch,
      targetBaseTip: baseSha,
      worktree: repo,
      issueNumber: 42,
      defaultBaseBranch: "main",
      push: false,
      autoMergeEval: makeStubEval(),
      assertCandidateFn: async () => {},
    });

    expect(result.success).toBe(true);
    expect(result.finalStatus).toBe("merged");
    expect(result.reviewOutcome).toBe("merged");
    expect(result.evaluation.authorized).toBe(true);

    const intTip = (await git(repo, "rev-parse", `refs/heads/${integrationBranch}`)).trim();
    expect(intTip).toBe(candidateSha);
  });

  test("AC1: fast-forward merges when repository HEAD is checked out to integration branch", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-100-integration";
    await git(repo, "checkout", "-b", integrationBranch);

    // Create candidate commit on another branch
    await git(repo, "checkout", "-b", "subticket-43");
    await writeFile(join(repo, "feature.txt"), "feature work\n");
    await git(repo, "add", "feature.txt");
    await git(repo, "commit", "-m", "feat: feature 43");
    const candidateSha = (await git(repo, "rev-parse", "HEAD")).trim();

    // Switch back to integration branch
    await git(repo, "checkout", integrationBranch);

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: candidateSha,
      integrationBranch,
      targetBaseTip: baseSha,
      worktree: repo,
      issueNumber: 43,
      defaultBaseBranch: "main",
      push: false,
      autoMergeEval: makeStubEval(),
      assertCandidateFn: async () => {},
    });

    expect(result.success).toBe(true);
    expect(result.finalStatus).toBe("merged");
    const intTip = (await git(repo, "rev-parse", "HEAD")).trim();
    expect(intTip).toBe(candidateSha);
  });

  test("AC1: fail-closed integration drift detection holds for human review on conflicting tip", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-100-integration";
    await git(repo, "branch", integrationBranch, baseSha);

    // Simulate concurrent drift on the integration branch
    await git(repo, "checkout", integrationBranch);
    await writeFile(join(repo, "concurrent.txt"), "drift\n");
    await git(repo, "add", "concurrent.txt");
    await git(repo, "commit", "-m", "concurrent commit");
    const driftedSha = (await git(repo, "rev-parse", "HEAD")).trim();

    await git(repo, "checkout", "main");

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: "deadbeef00000000000000000000000000000000",
      integrationBranch,
      targetBaseTip: baseSha, // Stale base tip
      worktree: repo,
      issueNumber: 44,
      defaultBaseBranch: "main",
      push: false,
      autoMergeEval: makeStubEval(),
      assertCandidateFn: async () => {},
    });

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe("waiting_approval");
    expect(result.reviewOutcome).toBe("approved");
    expect(result.evaluation.authorized).toBe(false);
    expect(result.evaluation.decision).toBe("hold_for_human");
    expect(result.evaluation.reasons.some((r) => r.includes("drifted"))).toBe(true);
    expect(result.error).toContain("drifted");

    // Integration branch remains untouched at driftedSha
    const intTip = (await git(repo, "rev-parse", `refs/heads/${integrationBranch}`)).trim();
    expect(intTip).toBe(driftedSha);
  });

  test("AC1: executes gh pr merge, push, and issue close when push is enabled", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-100-integration";
    await git(repo, "branch", integrationBranch, baseSha);

    await git(repo, "checkout", "-b", "subticket-45");
    await writeFile(join(repo, "file.txt"), "file content\n");
    await git(repo, "add", "file.txt");
    await git(repo, "commit", "-m", "subticket 45");
    const candidateSha = (await git(repo, "rev-parse", "HEAD")).trim();
    await git(repo, "checkout", "main");

    const capturedCommands: string[][] = [];
    const mockProcessRun = async (cmd: string[]) => {
      capturedCommands.push(cmd);
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ number: 999, body: "Part of #100 unrelated" }]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: candidateSha,
      integrationBranch,
      targetBaseTip: baseSha,
      worktree: repo,
      issueNumber: 45,
      partOf: 100,
      defaultBaseBranch: "main",
      pr: "https://github.com/o/r/pull/45",
      hasOrigin: false,
      push: true,
      autoMergeEval: makeStubEval(),
      assertCandidateFn: async () => {},
      processRunFn: mockProcessRun,
    });

    expect(result.success).toBe(true);
    // Verified gh pr merge was invoked
    const prMergeCall = capturedCommands.find(
      (c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge",
    );
    expect(prMergeCall).toBeDefined();
    expect(prMergeCall).toEqual([
      "gh",
      "pr",
      "merge",
      "https://github.com/o/r/pull/45",
      "--squash",
      "--match-head-commit",
      candidateSha,
    ]);

    // Verified gh issue close was invoked
    const issueCloseCall = capturedCommands.find(
      (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "close",
    );
    expect(issueCloseCall).toBeDefined();
    expect(issueCloseCall![3]).toBe("45");
  });

  test("AC1: creates final parent integration PR when all sibling subtickets are completed", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-100-integration";
    await git(repo, "branch", integrationBranch, baseSha);

    await git(repo, "checkout", "-b", "subticket-46");
    await writeFile(join(repo, "file2.txt"), "final sibling\n");
    await git(repo, "add", "file2.txt");
    await git(repo, "commit", "-m", "subticket 46");
    const candidateSha = (await git(repo, "rev-parse", "HEAD")).trim();
    await git(repo, "checkout", "main");

    const capturedCommands: string[][] = [];
    const mockProcessRun = async (cmd: string[]) => {
      capturedCommands.push(cmd);
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "list") {
        // Return only current issue and parent spec (zero remaining open siblings)
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { number: 46, body: "Part of #100" },
            { number: 100, body: "Parent spec" },
          ]),
          stderr: "",
        };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list") {
        // No existing final PR open
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "create") {
        return { exitCode: 0, stdout: "https://github.com/o/r/pull/500\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: candidateSha,
      integrationBranch,
      targetBaseTip: baseSha,
      worktree: repo,
      issueNumber: 46,
      partOf: 100,
      defaultBaseBranch: "main",
      pr: "https://github.com/o/r/pull/46",
      hasOrigin: false,
      push: true,
      autoMergeEval: makeStubEval(),
      assertCandidateFn: async () => {},
      processRunFn: mockProcessRun,
    });

    expect(result.success).toBe(true);
    expect(result.finalIntegrationPr).toBe("https://github.com/o/r/pull/500");

    const prCreateCall = capturedCommands.find(
      (c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create",
    );
    expect(prCreateCall).toBeDefined();
    expect(prCreateCall).toContain(`feat(spec-100): integrated delivery for spec #100`);
  });

  test("F2: injected TypeError in assertCandidateFn is propagated/held exactly once without retry", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-101-integration";
    await git(repo, "branch", integrationBranch, baseSha);

    await git(repo, "checkout", "-b", "subticket-47");
    await writeFile(join(repo, "file3.txt"), "subticket 47\n");
    await git(repo, "add", "file3.txt");
    await git(repo, "commit", "-m", "subticket 47");
    const candidateSha = (await git(repo, "rev-parse", "HEAD")).trim();
    await git(repo, "checkout", "main");

    let callCount = 0;
    const injectedError = new TypeError("injected candidate type error");

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: candidateSha,
      integrationBranch,
      targetBaseTip: baseSha,
      worktree: repo,
      issueNumber: 47,
      defaultBaseBranch: "main",
      push: false,
      autoMergeEval: makeStubEval(),
      assertCandidateFn: async (opts) => {
        callCount++;
        expect(opts.root).toBe(repo);
        expect(opts.expectedCandidate).toBe(candidateSha);
        expect(opts.base).toBe(baseSha);
        throw injectedError;
      },
    });

    expect(callCount).toBe(1);
    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe("waiting_approval");
    expect(result.reviewOutcome).toBe("approved");
    expect(result.error).toContain("injected candidate type error");
  });

  test("F2: default assertCandidate validator protects real candidate from uncommitted changes", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-102-integration";
    await git(repo, "branch", integrationBranch, baseSha);

    await git(repo, "checkout", "-b", "subticket-48");
    await writeFile(join(repo, "file4.txt"), "subticket 48\n");
    await git(repo, "add", "file4.txt");
    await git(repo, "commit", "-m", "subticket 48");
    const candidateSha = (await git(repo, "rev-parse", "HEAD")).trim();

    // Leave an untracked dirty file in repo worktree
    await writeFile(join(repo, "untracked.txt"), "untracked dirty content\n");

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: candidateSha,
      integrationBranch,
      targetBaseTip: baseSha,
      worktree: repo,
      issueNumber: 48,
      defaultBaseBranch: "main",
      push: false,
      autoMergeEval: makeStubEval(),
      // assertCandidateFn omitted to exercise default adapter
    });

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe("waiting_approval");
    expect(result.error).toMatch(/Candidate has uncommitted or untracked changes/i);
  });

  test("AC1: checkout-free CAS ref update preserves dirty uncommitted files in primary checkout", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-103-integration";
    await git(repo, "branch", integrationBranch, baseSha);

    // Create candidate commit in a separate worktree
    const wtDir = await mkdtemp(join(tmpdir(), "wt-cand-"));
    tempDirs.push(wtDir);
    await git(repo, "worktree", "add", "-b", "subticket-49", wtDir, baseSha);
    await writeFile(join(wtDir, "sub-49.txt"), "subticket 49 content\n");
    await git(wtDir, "add", "sub-49.txt");
    await git(wtDir, "commit", "-m", "feat: subticket 49");
    const candidateSha = (await git(wtDir, "rev-parse", "HEAD")).trim();

    // Leave dirty uncommitted files in primary repo
    await writeFile(join(repo, "dirty-primary.txt"), "dirty untracked file\n");
    await writeFile(join(repo, "README.md"), "# Modified tracked README\n");

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: candidateSha,
      integrationBranch,
      targetBaseTip: baseSha,
      worktree: wtDir,
      issueNumber: 49,
      defaultBaseBranch: "main",
      push: false,
      autoMergeEval: makeStubEval(),
      assertCandidateFn: async () => {},
    });

    expect(result.success).toBe(true);
    // Invariant: Dirty files in primary repo checkout remain completely preserved
    expect(existsSync(join(repo, "dirty-primary.txt"))).toBe(true);
    expect(readFileSync(join(repo, "dirty-primary.txt"), "utf-8")).toBe("dirty untracked file\n");
    expect(readFileSync(join(repo, "README.md"), "utf-8")).toBe("# Modified tracked README\n");

    // Invariant: Integration branch was advanced in git refs
    const intTip = (await git(repo, "rev-parse", `refs/heads/${integrationBranch}`)).trim();
    expect(intTip).toBe(candidateSha);
  });

  test("AC5: writes verified SQLite project_issue_integrations and updates project_spec_coordinations when DB is attached", async () => {
    const { repo, baseSha } = await initGitRepo();
    const integrationBranch = "factory/spec-104-integration";
    await git(repo, "branch", integrationBranch, baseSha);

    const wtDir = await mkdtemp(join(tmpdir(), "wt-cand-db-"));
    tempDirs.push(wtDir);
    await git(repo, "worktree", "add", "-b", "subticket-50", wtDir, baseSha);
    await writeFile(join(wtDir, "sub-50.txt"), "subticket 50\n");
    await git(wtDir, "add", "sub-50.txt");
    await git(wtDir, "commit", "-m", "feat: subticket 50");
    const candidateSha = (await git(wtDir, "rev-parse", "HEAD")).trim();

    // Create an in-memory or file-based SQLite database with project_issue_integrations and project_spec_coordinations
    const dbDir = await mkdtemp(join(tmpdir(), "db-test-"));
    tempDirs.push(dbDir);
    const dbPath = join(dbDir, "console.db");
    const testDb = new DatabaseSync(dbPath);
    testDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, checkout_path TEXT);
      CREATE TABLE project_issue_integrations (
        project_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        branch TEXT NOT NULL,
        commit_sha TEXT,
        integrated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, issue_number)
      );
      CREATE TABLE project_spec_coordinations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        spec_issue_number INTEGER NOT NULL,
        current_integration_sha TEXT NOT NULL,
        plan_snapshot TEXT NOT NULL,
        final_pr_url TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const projectId = "proj_104";
    testDb.prepare("INSERT INTO projects (id, checkout_path) VALUES (?, ?)").run(projectId, repo);
    const initialPlan = {
      specIssueNumber: 104,
      currentIntegrationSha: baseSha,
      children: [{ number: 50, title: "Subticket 50", status: "running", commitSha: null }],
    };
    testDb
      .prepare(
        `INSERT INTO project_spec_coordinations (id, project_id, spec_issue_number, current_integration_sha, plan_snapshot, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "coord_104",
        projectId,
        104,
        baseSha,
        JSON.stringify(initialPlan),
        "active",
        new Date().toISOString(),
      );

    const result = await executeSubticketAutoMerge({
      root: repo,
      candidate: candidateSha,
      integrationBranch,
      targetBaseTip: baseSha,
      worktree: wtDir,
      issueNumber: 50,
      partOf: 104,
      defaultBaseBranch: "main",
      push: false,
      db: testDb,
      projectId,
      autoMergeEval: makeStubEval(),
      assertCandidateFn: async () => {},
    });

    expect(result.success).toBe(true);

    // Verify row in project_issue_integrations
    const row = testDb
      .prepare("SELECT * FROM project_issue_integrations WHERE project_id = ? AND issue_number = ?")
      .get(projectId, 50) as any;
    expect(row).toBeDefined();
    expect(row.commit_sha).toBe(candidateSha);
    expect(row.branch).toBe(integrationBranch);

    // Verify project_spec_coordinations updated
    const coordRow = testDb
      .prepare(
        "SELECT * FROM project_spec_coordinations WHERE project_id = ? AND spec_issue_number = ?",
      )
      .get(projectId, 104) as any;
    expect(coordRow.current_integration_sha).toBe(candidateSha);
    const updatedPlan = JSON.parse(coordRow.plan_snapshot);
    expect(updatedPlan.children[0].status).toBe("integrated_to_branch");
    expect(updatedPlan.children[0].commitSha).toBe(candidateSha);

    testDb.close();
  });
});

describe("scripts/loop/reflector (createBoundedReflectionTransport)", () => {
  test("AC2: wraps transport with deadline prompt, environment variables, and records artifacts", async () => {
    const { repo } = await initGitRepo();
    const handoffDir = join(repo, "handoff");
    const runDir = join(repo, "run");
    await mkdir(handoffDir, { recursive: true });
    await mkdir(runDir, { recursive: true });

    let receivedArgv: string[] = [];
    let receivedEnv: Record<string, string | undefined> = {};

    const rawTransport = async (req: {
      argv: string[];
      env?: Record<string, string | undefined>;
    }) => {
      receivedArgv = req.argv;
      receivedEnv = req.env ?? {};
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schema_version: 1,
          attribution: "no_observed_effect",
          mutations: [],
        }),
        stderr: "",
      };
    };

    const bounded = createBoundedReflectionTransport({
      transport: rawTransport,
      budget: { softMs: 2000, hardMs: 4000 },
      handoffDir,
      runDirectory: runDir,
      maxContinuations: 1,
    });

    const response = await bounded({
      argv: ["pi", "reflector prompt"],
      cwd: repo,
      role: "reflector",
      provider: "test",
      timeoutMs: 30000,
    });

    expect(response.exitCode).toBe(0);
    expect(receivedArgv[receivedArgv.length - 1]).toContain("Bounded role execution");
    expect(receivedArgv[receivedArgv.length - 1]).toContain("Soft deadline");
    expect(receivedEnv.FACTORY_LOOP_SOFT_DEADLINE_MS).toBeDefined();
    expect(receivedEnv.FACTORY_LOOP_HARD_DEADLINE_MS).toBeDefined();
    expect(receivedEnv.FACTORY_LOOP_CHECKPOINT_PATH).toBe(
      join(handoffDir, "reflector-checkpoint.md"),
    );

    const attemptArtifact = join(runDir, "reflector-attempt-0.json");
    expect(existsSync(attemptArtifact)).toBe(true);
  });

  test("AC2: checkpoints dirty state and throws RoleInterrupted when budget is exhausted", async () => {
    const { repo } = await initGitRepo();
    const handoffDir = join(repo, "handoff");
    const runDir = join(repo, "run");
    await mkdir(handoffDir, { recursive: true });
    await mkdir(runDir, { recursive: true });

    const rawTransport = async (req: { cwd: string }) => {
      // Simulate dirty reflector work
      await writeFile(join(req.cwd, "dirty-reflection.txt"), "evidence");
      return {
        exitCode: 124, // Timeout
        timedOut: true,
        stdout: "",
        stderr: "timeout",
      };
    };

    const bounded = createBoundedReflectionTransport({
      transport: rawTransport,
      budget: { softMs: 500, hardMs: 1000 },
      handoffDir,
      runDirectory: runDir,
      maxContinuations: 0, // Zero continuations: immediately exhausts
    });

    expect(
      bounded({
        argv: ["pi", "prompt"],
        cwd: repo,
        role: "reflector",
        timeoutMs: 30000,
      }),
    ).rejects.toThrow(RoleInterrupted);

    const checkpointPath = join(handoffDir, "reflector-checkpoint.md");
    expect(existsSync(checkpointPath)).toBe(true);
    const content = readFileSync(checkpointPath, "utf8");
    expect(content).toContain("hard deadline exceeded");
    expect(content).toContain("dirty-reflection.txt");
  });
});

describe("scripts/loop/reflector (executeTerminalReflection)", () => {
  function makeStubDossier(
    status: "waiting_approval" | "merged" | "sent_back" | "failed" | "needs_owner",
  ): IssueDossier {
    return {
      issueNumber: 99,
      issueTitle: "Test Issue",
      issueUrl: "https://github.com/o/r/issues/99",
      branch: "local-loop/issue-99",
      attempts: [
        {
          lapIndex: 0,
          runId: "attempt-0",
          timestamp: new Date().toISOString(),
          status,
          changedFiles: [],
          reviewFindings: [],
          qaFailures: [],
          recoveries: [{ role: "builder", artifact: "b0.json", reason: "checkpoint" }],
        },
      ],
    };
  }

  test("AC2: detaches reflection worktree, executes reflection, and cleans up worktree in finally", async () => {
    const { repo, baseSha } = await initGitRepo();
    const stateRoot = await mkdtemp(join(tmpdir(), "state-root-"));
    tempDirs.push(stateRoot);
    const runDir = join(stateRoot, "runs/test-run");
    const artifactsDir = join(runDir, "artifacts");
    const handoffDir = join(runDir, "artifacts/handoff");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(handoffDir, { recursive: true });

    const dossier = makeStubDossier("waiting_approval");
    let statusTracker = "waiting_approval";

    const mockTransport = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schema_version: 1,
        attribution: "no_observed_effect",
        mutations: [],
      }),
      stderr: "",
    });

    await executeTerminalReflection({
      root: repo,
      stateRoot,
      runDirectory: runDir,
      artifactsDir,
      handoffDir,
      worktree: repo,
      candidate: baseSha,
      defaultBaseBranch: "main",
      dossier,
      transport: mockTransport,
      budget: { softMs: 2000, hardMs: 4000 },
      maxContinuations: 0,
      currentStatus: "waiting_approval",
      setStatus: (s) => {
        statusTracker = s;
      },
    });

    // Worktree was removed in finally
    expect(existsSync(join(runDir, "reflection-worktree"))).toBe(false);
    // Terminal status restored
    expect(statusTracker).toBe("waiting_approval");
    // Reflection artifact written
    const reflectionArtifact = join(artifactsDir, "reflection.json");
    expect(existsSync(reflectionArtifact)).toBe(true);
    // Dossier reflectedAt marked for no_entry
    expect(dossier.reflectedAt).toBeDefined();
  });

  test("AC2: detects unauthorized candidate mutation during reflection and fails closed", async () => {
    const { repo, baseSha } = await initGitRepo();
    const stateRoot = await mkdtemp(join(tmpdir(), "state-root-"));
    tempDirs.push(stateRoot);
    const runDir = join(stateRoot, "runs/test-run-mut");
    const artifactsDir = join(runDir, "artifacts");
    const handoffDir = join(runDir, "artifacts/handoff");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(handoffDir, { recursive: true });

    const dossier = makeStubDossier("waiting_approval");

    const mutatingTransport = async () => {
      // Simulate malicious out-of-band edit to the verified candidate worktree
      await writeFile(join(repo, "unauthorized.txt"), "tampered");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schema_version: 1,
          attribution: "no_observed_effect",
          mutations: [],
        }),
        stderr: "",
      };
    };

    expect(
      executeTerminalReflection({
        root: repo,
        stateRoot,
        runDirectory: runDir,
        artifactsDir,
        handoffDir,
        worktree: repo,
        candidate: baseSha,
        defaultBaseBranch: "main",
        dossier,
        transport: mutatingTransport,
        budget: { softMs: 2000, hardMs: 4000 },
        maxContinuations: 0,
      }),
    ).rejects.toThrow("Reflection changed the verified candidate or dirty state; delivery held");

    // Reflection record records error
    const reflectionRecord = JSON.parse(
      readFileSync(join(artifactsDir, "reflection.json"), "utf8"),
    );
    expect(reflectionRecord.status).toBe("error");
    // Dossier reflectedAt NOT updated
    expect(dossier.reflectedAt).toBeUndefined();
  });

  test("AC2: triggers deliverLearningProposal on clean candidate when proposal is 'proposed'", async () => {
    const { repo, baseSha } = await initGitRepo();
    const stateRoot = await mkdtemp(join(tmpdir(), "state-root-"));
    tempDirs.push(stateRoot);
    const runDir = join(stateRoot, "runs/test-run-prop");
    const artifactsDir = join(runDir, "artifacts");
    const handoffDir = join(runDir, "artifacts/handoff");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(handoffDir, { recursive: true });

    // Write a command artifact in artifactsDir
    const commandRecord = {
      executionId: "exec-1",
      runId: "attempt-0",
      candidate: baseSha,
      command: "bun test",
      cwd: repo,
      exitCode: 0,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      completedAt: new Date().toISOString(),
      artifact: {
        runId: "attempt-0",
        candidate: baseSha,
        path: "command-0.json",
        lineStart: 1,
        lineEnd: 1,
        quote: JSON.stringify({ command: "bun test", exitCode: 0 }),
      },
    };
    await writeFile(join(artifactsDir, "command-0.json"), commandRecord.artifact.quote);

    const dossier = makeStubDossier("waiting_approval");
    dossier.attempts[0]!.candidateHead = baseSha;
    dossier.attempts[0]!.artifactsDir = artifactsDir;
    dossier.attempts[0]!.commandRecords = [commandRecord];

    const proposalTransport = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schema_version: 1,
        attribution: "helped",
        mutations: [
          {
            category: "tool",
            key: "test_cmd",
            value: { command: "bun test", executionId: "exec-1" },
            evidence: [commandRecord.artifact],
          },
        ],
      }),
      stderr: "",
    });

    await executeTerminalReflection({
      root: repo,
      stateRoot,
      runDirectory: runDir,
      artifactsDir,
      handoffDir,
      worktree: repo,
      candidate: baseSha,
      defaultBaseBranch: "main",
      dossier,
      transport: proposalTransport,
      budget: { softMs: 2000, hardMs: 4000 },
      maxContinuations: 0,
      push: false,
      commandRecords: [commandRecord],
      proposalEvaluator: async () => ({
        grounding: { approved: true, confidence: 1 },
        quality: { approved: true, confidence: 1 },
        hallucinationRisk: "grounded_in_logs",
      }),
    });

    expect(existsSync(join(artifactsDir, "learning-delivery.json"))).toBe(true);
    const delivery = JSON.parse(readFileSync(join(artifactsDir, "learning-delivery.json"), "utf8"));
    expect(delivery.status).toBe("proposed");
    expect(dossier.reflectedAt).toBeDefined();
  });
});

describe("AC3: barrel and facade re-exports", () => {
  test("preserves existing triage lock contract through scripts/loop/index.ts barrel", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "barrel-triage-lock-"));
    tempDirs.push(stateRoot);
    const lock = await loopExports.acquireIssueLock(stateRoot, 501);
    expect(lock).not.toBeNull();
    try {
      expect(await loopExports.acquireIssueLock(stateRoot, 501)).toBeNull();
      expect(existsSync(join(stateRoot, "locks", "issue-501"))).toBe(false);
    } finally {
      await lock!.release();
    }
  });

  test("scripts/loop/index.ts barrel exports subticket auto-merge and terminal reflection utilities", () => {
    expect(typeof loopExports.executeSubticketAutoMerge).toBe("function");
    expect(typeof loopExports.executeTerminalReflection).toBe("function");
    expect(typeof loopExports.createBoundedReflectionTransport).toBe("function");
  });

  test("scripts/local-loop.ts facade re-exports match direct domain exports", () => {
    expect(localLoopExports.executeSubticketAutoMerge).toBe(executeSubticketAutoMerge);
    expect(localLoopExports.executeTerminalReflection).toBe(executeTerminalReflection);
    expect(localLoopExports.createBoundedReflectionTransport).toBe(
      createBoundedReflectionTransport,
    );
  });
});
