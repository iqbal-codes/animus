import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOrdinaryChecks, handleCiFastFail } from "../../scripts/loop/ci";
import { executeBlackBoxQa, handleQaFastFail } from "../../scripts/loop/qa-runner";
import {
  evaluateReviewReadiness,
  finalizeReviewAndPublish,
  handleLoopCatch,
} from "../../scripts/loop/review-gate";
import { recordLapAndReflect } from "../../scripts/loop/pr-publication";
import { LoopPublisher } from "../../scripts/loop/publisher";
import * as loopExports from "../../scripts/loop/index";
import { git } from "../../scripts/loop/worktree";
import type { LocalIssue, LocalLoopResult } from "../../scripts/loop/types";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verification-fixture-"));
  tempDirs.push(root);

  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test Agent");
  await git(root, "config", "user.email", "agent@animus.local");
  await git(root, "config", "commit.gpgsign", "false");

  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "README.md"), "# Test Verification\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial commit");
  return root;
}

function makeValidIssue(overrides: Partial<LocalIssue> = {}): LocalIssue {
  return {
    number: 80,
    url: "https://github.com/example/repo/issues/80",
    title: "Implement verification extraction",
    body: "AC1: Validate checks, QA fast-fail, CI fast-fail, and publication",
    comments: [],
    dependencies: [],
    activeClaim: false,
    ...overrides,
  };
}

describe("scripts/loop/verification", () => {
  describe("AC1: runOrdinaryChecks", () => {
    test("runs checks in worktree, records command records, and writes builder-checks.log", async () => {
      const root = await createRepoFixture();
      const runDir = await mkdtemp(join(tmpdir(), "checks-run-"));
      tempDirs.push(runDir);

      const artifactsDir = join(runDir, "artifacts");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(artifactsDir, { recursive: true });

      const commandRecords: any[] = [];
      const evidence: any[] = [];
      const candidate = await git(root, "rev-parse", "HEAD");

      await runOrdinaryChecks({
        root,
        worktree: root,
        checks: ["echo check1", "echo check2"],
        timeoutMs: 10_000,
        runId: "run-chk",
        candidate,
        runDirectory: runDir,
        artifactsDir,
        commandRecords,
        evidence,
      });

      expect(commandRecords.length).toBe(2);
      expect(evidence.length).toBe(2);
      expect(existsSync(join(artifactsDir, "builder-checks.log"))).toBe(true);
      expect(existsSync(join(artifactsDir, "host-command-records.json"))).toBe(true);
    });

    test("fails closed when ordinary check fails", async () => {
      const root = await createRepoFixture();
      const runDir = await mkdtemp(join(tmpdir(), "checks-fail-"));
      tempDirs.push(runDir);

      const artifactsDir = join(runDir, "artifacts");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(artifactsDir, { recursive: true });

      const candidate = await git(root, "rev-parse", "HEAD");
      expect(
        runOrdinaryChecks({
          root,
          worktree: root,
          checks: ["exit 1"],
          timeoutMs: 10_000,
          runId: "run-chk-fail",
          candidate,
          runDirectory: runDir,
          artifactsDir,
          commandRecords: [],
          evidence: [],
        }),
      ).rejects.toThrow("Ordinary project check failed: exit 1");
    });
  });

  describe("AC1: executeBlackBoxQa", () => {
    test("executes QA in isolated worktree and saves app-check.json", async () => {
      const root = await createRepoFixture();
      const runDir = await mkdtemp(join(tmpdir(), "qa-exec-"));
      tempDirs.push(runDir);

      const artifactsDir = join(runDir, "artifacts");
      const handoffDir = join(artifactsDir, "handoff");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(handoffDir, { recursive: true });

      const candidate = await git(root, "rev-parse", "HEAD");
      const identities = {
        targetBaseTip: candidate,
        mergeBase: candidate,
        prHead: candidate,
        testedHead: candidate,
        environment: "test-env",
      };

      const qaResult = await executeBlackBoxQa({
        root,
        candidate,
        identities,
        runDirectory: runDir,
        artifactsDir,
        handoffDir,
        worktree: root,
        push: false,
        invokeQa: async () => ({
          overall: "PASS",
          passed: true,
          lines: [{ id: "C1", verdict: "PASS", evidence: [] }],
        }),
      });

      expect(qaResult.qaReport.overall).toBe("PASS");
      expect(existsSync(join(handoffDir, "app-check.json"))).toBe(true);
      expect(existsSync(join(artifactsDir, "app-check.json"))).toBe(true);
    });
  });

  describe("AC1: handleQaFastFail & handleCiFastFail", () => {
    test("handleQaFastFail short-circuits with sent_back when lap < maxLaps", async () => {
      const root = await createRepoFixture();
      const issue = makeValidIssue();
      const runDir = await mkdtemp(join(tmpdir(), "qa-fast-fail-"));
      tempDirs.push(runDir);

      const artifactsDir = join(runDir, "artifacts");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(artifactsDir, { recursive: true });

      const candidate = await git(root, "rev-parse", "HEAD");
      const state: LocalLoopResult = {
        runId: "run-qaff",
        pid: process.pid,
        lap: 1,
        issue: issue.url,
        route: "simple",
        status: "qa",
        runDirectory: runDir,
        worktree: root,
        branch: "local-loop/issue-80",
        base: candidate,
        candidate,
        verificationProfile: "docs",
        evidence: [],
      };

      const qaReport = {
        passed: false,
        overall: "FAIL",
        lines: [{ id: "AC1", verdict: "FAIL", observed: "broken" }],
      };

      let reflectedDossier: any = null;
      const res = await handleQaFastFail({
        qaReport,
        lap: 1,
        maxLaps: 3,
        state,
        issue,
        branch: "local-loop/issue-80",
        stateRoot: runDir,
        runId: "run-qaff",
        artifactsDir,
        commandRecords: [],
        recoveries: [],
        base: candidate,
        route: "simple",
        options: { push: false },
        reflectTerminal: async (d) => {
          reflectedDossier = d;
        },
        save: async () => {},
      });

      expect(res.status).toBe("sent_back");
      expect(reflectedDossier).not.toBeNull();
      expect(reflectedDossier.attempts[0].failedStage).toBe("qa");
    });

    test("handleQaFastFail escalates to needs_owner when lap reaches maxLaps", async () => {
      const root = await createRepoFixture();
      const issue = makeValidIssue();
      const runDir = await mkdtemp(join(tmpdir(), "qa-max-laps-"));
      tempDirs.push(runDir);

      const artifactsDir = join(runDir, "artifacts");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(artifactsDir, { recursive: true });

      const candidate = await git(root, "rev-parse", "HEAD");
      const state: LocalLoopResult = {
        runId: "run-qaff-max",
        pid: process.pid,
        lap: 3,
        issue: issue.url,
        route: "simple",
        status: "qa",
        runDirectory: runDir,
        worktree: root,
        branch: "local-loop/issue-80",
        base: candidate,
        candidate,
        verificationProfile: "docs",
        evidence: [],
      };

      const qaReport = {
        passed: false,
        overall: "FAIL",
        lines: [{ id: "AC1", verdict: "FAIL", observed: "maxed out" }],
      };

      const res = await handleQaFastFail({
        qaReport,
        lap: 3,
        maxLaps: 3,
        state,
        issue,
        branch: "local-loop/issue-80",
        stateRoot: runDir,
        runId: "run-qaff-max",
        artifactsDir,
        commandRecords: [],
        recoveries: [],
        base: candidate,
        route: "simple",
        options: { push: false },
        reflectTerminal: async () => {},
        save: async () => {},
      });

      expect(res.status).toBe("needs_owner");
    });

    test("handleCiFastFail short-circuits on failing checks and formats comments", async () => {
      const root = await createRepoFixture();
      const issue = makeValidIssue();
      const runDir = await mkdtemp(join(tmpdir(), "ci-fast-fail-"));
      tempDirs.push(runDir);

      const artifactsDir = join(runDir, "artifacts");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(artifactsDir, { recursive: true });

      const candidate = await git(root, "rev-parse", "HEAD");
      const state: LocalLoopResult = {
        runId: "run-ciff",
        pid: process.pid,
        lap: 1,
        issue: issue.url,
        route: "simple",
        status: "checking",
        runDirectory: runDir,
        worktree: root,
        branch: "local-loop/issue-80",
        base: candidate,
        candidate,
        verificationProfile: "docs",
        evidence: [],
      };

      let reflected = false;
      const res = await handleCiFastFail({
        failedChecks: [{ name: "gate-verify", state: "failure" }],
        lap: 1,
        maxLaps: 3,
        state,
        issue,
        branch: "local-loop/issue-80",
        stateRoot: runDir,
        runId: "run-ciff",
        artifactsDir,
        commandRecords: [],
        recoveries: [],
        base: candidate,
        route: "simple",
        options: { push: false },
        reflectTerminal: async () => {
          reflected = true;
        },
        save: async () => {},
      });

      expect(res.status).toBe("sent_back");
      expect(reflected).toBe(true);
    });
  });

  describe("AC1: publication helpers", () => {
    test("recordLapAndReflect records lap attempt and executes terminal reflection", async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), "dossier-root-"));
      tempDirs.push(stateRoot);

      const artifactsDir = join(stateRoot, "artifacts");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(artifactsDir, { recursive: true });

      const issue = makeValidIssue();
      let reflected = false;
      const dossier = await recordLapAndReflect({
        stateRoot,
        issue,
        branch: "local-loop/issue-80",
        runId: "lap-run-1",
        status: "waiting_approval",
        candidate: "abc1234",
        artifactsDir,
        evidence: [],
        commandRecords: [],
        recoveries: [],
        changedFiles: ["src/index.ts"],
        reflectTerminal: async () => {
          reflected = true;
        },
      });

      expect(dossier.attempts.length).toBe(1);
      expect(dossier.attempts[0]!.candidateHead).toBe("abc1234");
      expect(reflected).toBe(true);
    });

    test("LoopPublisher isolates publication errors when remote is unavailable", async () => {
      const root = await createRepoFixture();
      const publisher = new LoopPublisher({
        worktree: root,
        runDirectory: root,
        artifactsDir: root,
        issueNumber: 80,
        push: false,
      });

      // Test when remote PR is unavailable: should not throw, should handle error gracefully
      expect(
        publisher.publishLoopComment({
          pr: "non-existent-pr",
          commentType: "builder",
          commentBody: "test comment",
          candidate: "abc",
        }),
      ).resolves.toBeUndefined();

      expect(
        publisher.syncAndPublishPrEvidence({
          pr: "non-existent-pr",
          candidate: "abc",
          stageName: "Test",
        }),
      ).resolves.toBeUndefined();

      const p2 = new LoopPublisher({
        worktree: root,
        runDirectory: root,
        artifactsDir: root,
        issueNumber: 999999,
        push: false,
      });
      expect(p2.escalateToHuman("abc")).resolves.toBeDefined();
    });
  });

  describe("AC2: barrel export and review-gate mechanics", () => {
    test("scripts/loop/index.ts barrel exports decomposed verification utilities", () => {
      expect((loopExports as any).runOrdinaryChecks).toBeFunction();
      expect((loopExports as any).executeBlackBoxQa).toBeFunction();
      expect((loopExports as any).handleQaFastFail).toBeFunction();
      expect((loopExports as any).handleCiFastFail).toBeFunction();
      expect((loopExports as any).evaluateReviewReadiness).toBeFunction();
      expect((loopExports as any).finalizeReviewAndPublish).toBeFunction();
      expect((loopExports as any).handleLoopCatch).toBeFunction();
      expect((loopExports as any).LoopPublisher).toBeFunction();
      expect((loopExports as any).recordLapAndReflect).toBeFunction();
    });

    test("evaluateReviewReadiness evaluates approval cleanly on passing QA and review", async () => {
      const root = await createRepoFixture();
      const candidate = await git(root, "rev-parse", "HEAD");
      const issue = makeValidIssue({ number: 85 });
      const artifactsDir = await mkdtemp(join(tmpdir(), "review-artifacts-"));
      tempDirs.push(artifactsDir);

      const evalRes = await evaluateReviewReadiness({
        stateRoot: root,
        issue,
        branch: "main",
        candidate,
        base: candidate,
        baseBranch: "main",
        defaultBaseBranch: "main",
        worktree: root,
        lap: 1,
        maxLaps: 3,
        qaReport: { passed: true, checks: [] },
        reviewReport: { passed: true, verdict: "approved", findings: [], dispositions: [] },
        artifactsDir,
        protectedPaths: [],
      });

      expect(evalRes.isApproved).toBe(true);
      expect(evalRes.finalStatus).toBe("waiting_approval");
      expect(evalRes.reviewOutcome).toBe("approved");
    });

    test("finalizeReviewAndPublish records terminal lap reflection and saves review", async () => {
      const root = await createRepoFixture();
      const candidate = await git(root, "rev-parse", "HEAD");
      const issue = makeValidIssue({ number: 87 });
      const artifactsDir = await mkdtemp(join(tmpdir(), "finalize-artifacts-"));
      tempDirs.push(artifactsDir);
      const runDir = await mkdtemp(join(tmpdir(), "finalize-run-"));
      tempDirs.push(runDir);

      const reviewEval = await evaluateReviewReadiness({
        stateRoot: root,
        issue,
        branch: "main",
        candidate,
        base: candidate,
        baseBranch: "main",
        defaultBaseBranch: "main",
        worktree: root,
        lap: 1,
        maxLaps: 3,
        qaReport: { passed: true, checks: [] },
        reviewReport: { passed: true, verdict: "approved", findings: [], dispositions: [] },
        artifactsDir,
        protectedPaths: [],
      });

      const state: LocalLoopResult = {
        runId: "finalize-test",
        pid: process.pid,
        lap: 1,
        issue: issue.url,
        route: "simple",
        status: "preparing",
        runDirectory: runDir,
        worktree: root,
        branch: "main",
        base: "main",
        evidence: [],
      };

      let reflected = false;
      await finalizeReviewAndPublish({
        worktree: root,
        issue,
        branch: "main",
        runId: "finalize-test",
        candidate,
        artifactsDir,
        runDirectory: runDir,
        stateRoot: root,
        evidence: [],
        commandRecords: [],
        recoveries: [],
        qaReport: { passed: true, checks: [] },
        reviewReport: { passed: true, verdict: "approved", findings: [], dispositions: [] },
        builderReport: { verdict: "pass" },
        identities: {
          targetBaseTip: candidate,
          mergeBase: candidate,
          prHead: candidate,
          testedHead: candidate,
          environment: "test-env",
        },
        lap: 1,
        maxLaps: 3,
        route: "simple",
        push: false,
        reviewEval,
        reflectTerminal: async () => {
          reflected = true;
        },
        state,
      });

      expect(reflected).toBe(true);
      expect(state.status).toBe("waiting_approval");
      expect(existsSync(join(artifactsDir, "review.json"))).toBe(true);
    });

    test("handleLoopCatch handles errors, records terminal state, and escalates on max laps", async () => {
      const root = await createRepoFixture();
      const issue = makeValidIssue({ number: 86 });
      const runDir = await mkdtemp(join(tmpdir(), "catch-run-"));
      tempDirs.push(runDir);
      const artifactsDir = join(runDir, "artifacts");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(artifactsDir, { recursive: true });

      const state: LocalLoopResult = {
        runId: "catch-test",
        pid: process.pid,
        lap: 3,
        issue: issue.url,
        route: "simple",
        status: "preparing",
        runDirectory: runDir,
        worktree: root,
        branch: "main",
        base: "main",
        evidence: [],
      };

      let reflected = false;
      const catchResult = await handleLoopCatch({
        error: new Error("simulated failure"),
        state,
        root,
        issue,
        branch: "main",
        lap: 3,
        maxLaps: 3,
        stateRoot: root,
        runId: "catch-test",
        artifactsDir,
        commandRecords: [],
        recoveries: [],
        reflectTerminal: async () => {
          reflected = true;
        },
        save: async () => {},
      });

      expect(catchResult.status).toBe("needs_owner");
      expect(catchResult.error).toBe("simulated failure");
      expect(reflected).toBe(true);
    });
  });
});
