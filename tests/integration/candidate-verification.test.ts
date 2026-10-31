import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  EvidenceService,
  EvidenceError,
  ReportSanitizer,
  handleProjectEvidenceRoute,
} from "../../apps/backend/src/evidence";
import { createFactoryClient } from "@animus/client";

describe("Candidate-Bound Verification, Landing Guard & Tiered Action Freshness (Issue #63)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let ledger: CommandLedger;
  let evidenceService: EvidenceService;
  let repoPath: string;
  let projectId: string;

  function initGitRepo(dir: string, remoteRepo = "owner/repo-evidence"): string {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(join(dir, "README.md"), "# Evidence Test Repo\n");
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
    tempDir = mkdtempSync(join(tmpdir(), "animus-evid-test-"));
    dbPath = join(tempDir, "state", "console.db");
    db = initializeDatabase(dbPath);
    forge = new SyntheticForgeAdapter({
      "owner/repo-evidence": 301,
    });
    registry = new ProjectRegistryService(db, forge);
    ledger = new CommandLedger(db);
    evidenceService = new EvidenceService(db, forge, ledger);

    repoPath = join(tempDir, "checkout");
    mkdirSync(repoPath, { recursive: true });
    initGitRepo(repoPath, "owner/repo-evidence");

    const project = await registry.registerProject({
      method: "local_checkout",
      checkout_path: repoPath,
      name: "Evidence Project",
    });
    projectId = project.id;
  });

  describe("AC1 & AC2: Candidate-Bound Verification Records & Landing Guard", () => {
    test("records independent candidate verification and strictly rejects builder self-approval (Invariant 2)", () => {
      // 1. Builder self-approval must fail closed
      expect(() => {
        evidenceService.recordVerification(projectId, {
          specIssueNumber: 58,
          prNumber: 10,
          candidateHeadSha: "sha_cand_123456",
          mergeBaseSha: "sha_base_000000",
          runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
          producerIdentity: { id: "builder-agent-1", role: "builder" },
          verificationStatus: "passed",
          checks: [
            {
              name: "contract-check",
              command: "bun test",
              result: "PASS",
            },
          ],
        });
      }).toThrowError(EvidenceError);

      try {
        evidenceService.recordVerification(projectId, {
          specIssueNumber: 58,
          prNumber: 10,
          candidateHeadSha: "sha_cand_123456",
          mergeBaseSha: "sha_base_000000",
          runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
          producerIdentity: { id: "builder-agent-1", role: "builder" },
          verificationStatus: "passed",
          checks: [{ name: "test", command: "bun test", result: "PASS" }],
        });
      } catch (err: any) {
        expect(err.code).toBe("builder_self_approval_rejected");
      }

      // 2. Independent evaluator verification succeeds
      const record = evidenceService.recordVerification(projectId, {
        specIssueNumber: 58,
        prNumber: 10,
        candidateHeadSha: "sha_cand_123456",
        mergeBaseSha: "sha_base_000000",
        runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
        producerIdentity: { id: "evaluator-synthetic", role: "independent_evaluator" },
        verificationStatus: "passed",
        checks: [
          {
            name: "independent-e2e-check",
            command: "bun test tests/integration/e2e.test.ts",
            result: "PASS",
            durationMs: 420,
          },
        ],
        review: {
          reviewerId: "peer-reviewer-alice",
          role: "peer_reviewer",
          status: "passed",
          summary: "Standards and Spec axes passed with 0 critical findings.",
          standardsFindingCount: 0,
          specFindingCount: 0,
          reviewedAt: new Date().toISOString(),
        },
      });

      expect(record.id).toBeDefined();
      expect(record.prNumber).toBe(10);
      expect(record.candidateHeadSha).toBe("sha_cand_123456");
      expect(record.mergeBaseSha).toBe("sha_base_000000");
      expect(record.verificationStatus).toBe("passed");
      expect(record.review?.status).toBe("passed");

      // Verify retrieval
      const fetched = evidenceService.getVerificationByPr(projectId, 10);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(record.id);
    });

    test("landing guard allows merge when candidate head SHA and merge base match verified evidence", async () => {
      // Add PR to synthetic forge
      forge.addPullRequest("owner/repo-evidence", {
        number: 11,
        title: "feat: delivery PR",
        body: "Delivery body",
        head: "sha_cand_valid_11",
        base: "sha_base_valid_11",
        state: "OPEN",
      });

      // Record verified evidence
      evidenceService.recordVerification(projectId, {
        prNumber: 11,
        candidateHeadSha: "sha_cand_valid_11",
        mergeBaseSha: "sha_base_valid_11",
        runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
        producerIdentity: { id: "evaluator-ci", role: "independent_evaluator" },
        verificationStatus: "passed",
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
      });

      // Evaluate landing guard
      const evaluation = await evidenceService.evaluateLanding(projectId, 11, {
        currentHeadSha: "sha_cand_valid_11",
        currentBaseSha: "sha_base_valid_11",
      });

      expect(evaluation.allowed).toBe(true);
      expect(evaluation.decision).toBe("allowed");
      expect(evaluation.blockReason).toBeUndefined();

      // Execute landing
      const landing = await evidenceService.executeLanding(projectId, {
        prNumber: 11,
        expectedHeadSha: "sha_cand_valid_11",
        expectedBaseSha: "sha_base_valid_11",
        actor: "operator",
      });

      expect(landing.success).toBe(true);
      expect(landing.merged).toBe(true);
    });

    test("landing guard blocks merge on candidate head SHA drift (Invariant 1)", async () => {
      forge.addPullRequest("owner/repo-evidence", {
        number: 12,
        title: "feat: drifted PR",
        body: "Delivery body",
        head: "sha_cand_DRIFTED_99",
        base: "sha_base_valid_12",
        state: "OPEN",
      });

      evidenceService.recordVerification(projectId, {
        prNumber: 12,
        candidateHeadSha: "sha_cand_ORIGINAL_12",
        mergeBaseSha: "sha_base_valid_12",
        runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
        producerIdentity: { id: "evaluator-ci", role: "independent_evaluator" },
        verificationStatus: "passed",
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
      });

      const evaluation = await evidenceService.evaluateLanding(projectId, 12, {
        currentHeadSha: "sha_cand_DRIFTED_99",
        currentBaseSha: "sha_base_valid_12",
      });

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.decision).toBe("blocked");
      expect(evaluation.blockReason).toBe("candidate_drift");

      // Execution must fail closed
      await expect(
        evidenceService.executeLanding(projectId, {
          prNumber: 12,
          expectedHeadSha: "sha_cand_DRIFTED_99",
          expectedBaseSha: "sha_base_valid_12",
        }),
      ).rejects.toThrow("Landing guard blocked merge");
    });

    test("landing guard blocks merge on base tree drift", async () => {
      forge.addPullRequest("owner/repo-evidence", {
        number: 13,
        title: "feat: base drifted PR",
        body: "Delivery body",
        head: "sha_cand_valid_13",
        base: "sha_base_DRIFTED_88",
        state: "OPEN",
      });

      evidenceService.recordVerification(projectId, {
        prNumber: 13,
        candidateHeadSha: "sha_cand_valid_13",
        mergeBaseSha: "sha_base_ORIGINAL_13",
        runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
        producerIdentity: { id: "evaluator-ci", role: "independent_evaluator" },
        verificationStatus: "passed",
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
      });

      const evaluation = await evidenceService.evaluateLanding(projectId, 13, {
        currentHeadSha: "sha_cand_valid_13",
        currentBaseSha: "sha_base_DRIFTED_88",
      });

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.decision).toBe("blocked");
      expect(evaluation.blockReason).toBe("base_drift");
    });

    test("landing guard blocks merge when evidence is missing or verification failed", async () => {
      const evaluationMissing = await evidenceService.evaluateLanding(projectId, 999, {
        currentHeadSha: "sha_head_999",
        currentBaseSha: "sha_base_999",
      });
      expect(evaluationMissing.allowed).toBe(false);
      expect(evaluationMissing.blockReason).toBe("evidence_missing");

      evidenceService.recordVerification(projectId, {
        prNumber: 14,
        candidateHeadSha: "sha_cand_14",
        mergeBaseSha: "sha_base_14",
        runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
        producerIdentity: { id: "evaluator-ci", role: "independent_evaluator" },
        verificationStatus: "failed",
        checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
      });

      const evaluationFailed = await evidenceService.evaluateLanding(projectId, 14, {
        currentHeadSha: "sha_cand_14",
        currentBaseSha: "sha_base_14",
      });
      expect(evaluationFailed.allowed).toBe(false);
      expect(evaluationFailed.blockReason).toBe("verification_failed");
    });
  });

  describe("AC3: Tiered Action Matrix & Freshness Check (≤10s)", () => {
    test("consequential action requires explicit confirmation and succeeds with live fresh SHA", async () => {
      const resolver = {
        resolveBranchSha: () => "sha_live_branch_fresh",
      };

      // 1. Unconfirmed fails closed
      await expect(
        evidenceService.executeTieredAction(
          projectId,
          {
            action: "launch",
            targetBranch: "main",
            expectedBranchSha: "sha_live_branch_fresh",
            issueNumbers: [63],
            confirmed: false,
          },
          resolver,
        ),
      ).rejects.toThrow("requires explicit confirmation");

      // 2. Confirmed with matching SHA succeeds
      let actionExecuted = false;
      const result = await evidenceService.executeTieredAction(
        projectId,
        {
          action: "launch",
          targetBranch: "main",
          expectedBranchSha: "sha_live_branch_fresh",
          issueNumbers: [63],
          confirmed: true,
        },
        resolver,
        async () => {
          actionExecuted = true;
          return { launched: true };
        },
      );

      expect(actionExecuted).toBe(true);
      expect(result.success).toBe(true);
      expect(result.freshnessVerified).toBe(true);
      expect(result.freshnessDurationMs).toBeLessThanOrEqual(10_000);
    });

    test("consequential action fails closed on branch SHA drift (Invariant 3)", async () => {
      const resolver = {
        resolveBranchSha: () => "sha_remote_drifted_branch",
      };

      await expect(
        evidenceService.executeTieredAction(
          projectId,
          {
            action: "merge",
            targetBranch: "main",
            expectedBranchSha: "sha_expected_before_drift",
            issueNumbers: [63],
            confirmed: true,
          },
          resolver,
        ),
      ).rejects.toThrow("SHA drifted between confirmation and execution");
    });

    test("consequential action fails closed when live freshness check exceeds 10s", async () => {
      let currentMockTime = 1000;
      const originalNow = Date.now;
      Date.now = () => currentMockTime;

      const slowResolver = {
        resolveBranchSha: async () => {
          currentMockTime += 12000; // Simulate 12 seconds passing during resolve (>10s)
          return "sha_fresh";
        },
      };

      try {
        await expect(
          evidenceService.executeTieredAction(
            projectId,
            {
              action: "deploy",
              targetBranch: "production",
              expectedBranchSha: "sha_fresh",
              issueNumbers: [63],
              confirmed: true,
            },
            slowResolver,
          ),
        ).rejects.toThrow("Live freshness check exceeded maximum 10-second threshold");
      } finally {
        Date.now = originalNow;
      }
    });

    test("consequential action fails closed on prerequisite state drift", async () => {
      const resolver = {
        resolveBranchSha: () => "sha_fresh",
        checkPrerequisite: (key: string) => {
          if (key === "gate_approved") return "false"; // Drifted from expected "true"
          return undefined;
        },
      };

      await expect(
        evidenceService.executeTieredAction(
          projectId,
          {
            action: "promotion_pr",
            targetBranch: "develop",
            expectedBranchSha: "sha_fresh",
            issueNumbers: [63],
            prerequisiteStates: { gate_approved: "true" },
            confirmed: true,
          },
          resolver,
        ),
      ).rejects.toThrow("Prerequisite state drifted for 'gate_approved'");
    });
  });

  describe("AC4: Verified Per-Run Controls & Process Hierarchy Cleanup", () => {
    test("cancels run, terminates process hierarchy, and verifies cleanup before reporting status", async () => {
      // Register run with tracked parent PID and child PIDs
      evidenceService.runControls.registerRunProcess({
        runId: "run_active_100",
        projectId,
        pid: 12345,
        childPids: [12346, 12347],
      });

      let terminatedPids: number[] = [];
      const mockTerminator = async (pids: number[], _signal: string) => {
        terminatedPids = [...pids];
        return { killed: pids, verifiedDead: true };
      };

      const result = await evidenceService.cancelRun(
        projectId,
        {
          runId: "run_active_100",
          signal: "SIGTERM",
        },
        mockTerminator,
      );

      expect(result.success).toBe(true);
      expect(result.cleanupVerified).toBe(true);
      expect(result.status).toBe("cancelled");
      expect(terminatedPids).toEqual([12345, 12346, 12347]);

      // Cancelling an already cancelled run returns classified error run_not_cancellable (not a successful no-op)
      await expect(
        evidenceService.cancelRun(projectId, { runId: "run_active_100" }, mockTerminator),
      ).rejects.toThrow("already in terminal state");
    });

    test("rejects unauthorized control or scope mismatch", async () => {
      const otherCheckout = join(tempDir, "other-checkout");
      mkdirSync(otherCheckout, { recursive: true });
      initGitRepo(otherCheckout, "owner/repo-other");
      forge.addRepository("owner/repo-other", 302);
      const proj2 = await registry.registerProject({
        method: "local_checkout",
        checkout_path: otherCheckout,
        name: "Other Project",
      });

      evidenceService.runControls.registerRunProcess({
        runId: "run_proj_other",
        projectId: proj2.id,
        pid: 99999,
      });

      await expect(
        evidenceService.cancelRun(projectId, { runId: "run_proj_other" }),
      ).rejects.toThrow("Run control rejected");
    });

    test("fails closed if process tree termination verification fails (lingering descendants)", async () => {
      evidenceService.runControls.registerRunProcess({
        runId: "run_lingering",
        projectId,
        pid: 55555,
      });

      const failingTerminator = async () => {
        return { killed: [55555], verifiedDead: false };
      };

      await expect(
        evidenceService.cancelRun(projectId, { runId: "run_lingering" }, failingTerminator),
      ).rejects.toThrow("Failed to verify termination of process tree");
    });
  });

  describe("AC5: Gate Approval & Release Readiness", () => {
    test("approves gate specifying exact gate ID, project ID, and candidate SHA", () => {
      const approval = evidenceService.approveGate(projectId, {
        gateId: "gate_quality_ac",
        candidateSha: "sha_verified_cand_200",
        decision: "approved",
        actor: "release-manager",
        comment: "All ACs verified with independent black-box evidence.",
      });

      expect(approval.id).toBeDefined();
      expect(approval.gateId).toBe("gate_quality_ac");
      expect(approval.candidateSha).toBe("sha_verified_cand_200");
      expect(approval.decision).toBe("approved");

      const fetched = evidenceService.gateAndRelease.getGateApproval(
        projectId,
        "gate_quality_ac",
        "sha_verified_cand_200",
      );
      expect(fetched).not.toBeNull();
      expect(fetched?.decision).toBe("approved");
    });

    test("gate approval fails closed on stale candidate drift", () => {
      // Simulate active coordination plan in DB with different candidate SHA
      db.prepare(
        `INSERT INTO project_spec_coordinations (
          id, project_id, spec_issue_number, integration_branch, base_branch,
          base_sha, current_integration_sha, status, plan_snapshot, created_at, updated_at
        ) VALUES ('coord_1', ?, 58, 'factory/spec-58', 'main', 'sha_base', 'sha_NEW_INTEGRATED_SHA', 'active', '{}', datetime('now'), datetime('now'))`,
      ).run(projectId);

      expect(() => {
        evidenceService.approveGate(projectId, {
          gateId: "gate_quality_ac",
          candidateSha: "sha_STALE_OLD_SHA",
          decision: "approved",
        });
      }).toThrow(
        "Gate approval specifies candidate 'sha_STALE_OLD_SHA', but active coordination candidate does not match.",
      );
    });

    test("promotion PR and deployment blocked for unverified candidate", () => {
      expect(() => {
        evidenceService.verifyCandidateForRelease(projectId, "sha_unverified_999");
      }).toThrow(
        "Candidate 'sha_unverified_999' has not passed independent candidate verification",
      );
    });

    test("release-complete declared ONLY when all policy-required stages pass", async () => {
      const candidateSha = "sha_complete_candidate";

      // 1. Initial state: all stages pending
      let readiness = evidenceService.getReleaseReadiness(projectId, candidateSha);
      expect(readiness.releaseComplete).toBe(false);
      expect(readiness.pendingStages).toContain("candidate_verification");
      expect(readiness.pendingStages).toContain("independent_review");
      expect(readiness.pendingStages).toContain("gate_approval");
      expect(readiness.pendingStages).toContain("landing_verified");

      // 2. Add verification + review
      evidenceService.recordVerification(projectId, {
        prNumber: 20,
        candidateHeadSha: candidateSha,
        mergeBaseSha: "sha_base_000",
        runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
        producerIdentity: { id: "evaluator-synthetic", role: "independent_evaluator" },
        verificationStatus: "passed",
        checks: [{ name: "e2e", command: "bun test", result: "PASS" }],
        review: {
          reviewerId: "reviewer-1",
          role: "peer_reviewer",
          status: "passed",
          summary: "Clean",
          standardsFindingCount: 0,
          specFindingCount: 0,
          reviewedAt: new Date().toISOString(),
        },
      });

      readiness = evidenceService.getReleaseReadiness(projectId, candidateSha);
      expect(readiness.releaseComplete).toBe(false);
      expect(readiness.pendingStages).not.toContain("candidate_verification");
      expect(readiness.pendingStages).not.toContain("independent_review");
      expect(readiness.pendingStages).toContain("gate_approval");

      // 3. Add gate approval
      evidenceService.approveGate(projectId, {
        gateId: "gate_quality",
        candidateSha,
        decision: "approved",
      });

      // 4. Execute real landing via landingGuard (truthful verification)
      forge.addPullRequest("owner/repo-evidence", {
        number: 20,
        title: "feat: release candidate PR",
        body: "body",
        head: candidateSha,
        base: "sha_base_000",
        state: "OPEN",
      });
      await evidenceService.executeLanding(projectId, {
        prNumber: 20,
        expectedHeadSha: candidateSha,
        expectedBaseSha: "sha_base_000",
      });

      // Now all stages pass -> release-complete is true!
      readiness = evidenceService.getReleaseReadiness(projectId, candidateSha);
      expect(readiness.releaseComplete).toBe(true);
      expect(readiness.pendingStages).toHaveLength(0);
    });
  });

  describe("AC6: Report Sanitization & Secret Scrubbing (Invariant 4)", () => {
    test("scrubs GitHub tokens, API keys, passwords, and holdout paths from evidence reports", () => {
      const rawReport = `
# Candidate Evidence Report
- GitHub Token: ghp_1234567890abcdef1234567890abcdef1234
- GitHub PAT: github_pat_11AAAAAAA000000000000000000000000000000000000000000000000000000000
- OpenRouter Key: sk-or-v1-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
- Generic Bearer: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0
- Factory Host Token: FACTORY_HOST_TOKEN=host_secret_token_123456
- Private Holdout Path: /private/evaluator/secret_test.holdout.json
- Holdout Secret: HOLDOUT_SECRET_alpha_beta_gamma
- Synthetic Secret: synthetic_fixture_secret_xyz123
<script>alert("xss")</script>
<iframe src="https://evil.com"></iframe>
[Safe Documentation](https://example.com/docs)
      `;

      const sanitizer = new ReportSanitizer();
      const sanitized = sanitizer.sanitizeMarkdown(rawReport);

      expect(sanitized.sanitized).toBe(true);
      expect(sanitized.redactedTokensCount).toBeGreaterThanOrEqual(4);
      expect(sanitized.scrubbedHoldoutsCount).toBeGreaterThanOrEqual(3);

      // Check all secrets are scrubbed
      expect(sanitized.report).not.toContain("ghp_1234567890abcdef1234567890abcdef1234");
      expect(sanitized.report).not.toContain(
        "github_pat_11AAAAAAA000000000000000000000000000000000000000000000000000000000",
      );
      expect(sanitized.report).not.toContain(
        "sk-or-v1-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      );
      expect(sanitized.report).not.toContain("host_secret_token_123456");
      expect(sanitized.report).not.toContain("secret_test.holdout.json");
      expect(sanitized.report).not.toContain("HOLDOUT_SECRET_alpha_beta_gamma");
      expect(sanitized.report).not.toContain("synthetic_fixture_secret_xyz123");

      // Check unsafe tags are stripped
      expect(sanitized.report).not.toContain("<script>");
      expect(sanitized.report).not.toContain("<iframe>");

      // Check safe markdown remains
      expect(sanitized.report).toContain("[Safe Documentation](https://example.com/docs)");
    });
  });

  describe("HTTP Routes & Scoped Client SDK Integration (@animus/client)", () => {
    test("handles full verification, landing guard, and release readiness lifecycle via HTTP and @animus/client", async () => {
      // Create custom transport routing identical to main.ts subPath splitting
      const client = createFactoryClient({
        baseUrl: "http://localhost:4000",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const urlStr =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const url = new URL(urlStr);
          const req = new Request(url.toString(), init);

          // Exercises exact main.ts routing: slice("/api/v1/projects/".length).split("/")
          if (url.pathname.startsWith("/api/v1/projects/")) {
            const subPath = url.pathname.slice("/api/v1/projects/".length);
            const parts = subPath.split("/");
            if (parts[1] === "evidence") {
              const res = await handleProjectEvidenceRoute(req, parts[0], parts, evidenceService);
              if (res) return res;
            }
          }
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        },
      });

      // 1. Record verification via client
      const verif = await client.forProject(projectId).recordCandidateVerification({
        prNumber: 50,
        candidateHeadSha: "sha_client_head_50",
        mergeBaseSha: "sha_client_base_50",
        runtimeEnvironment: { runtime: "bun-1.4.2", os: "darwin-arm64" },
        producerIdentity: { id: "evaluator-agent", role: "independent_evaluator" },
        verificationStatus: "passed",
        checks: [{ name: "client-test", command: "bun test", result: "PASS" }],
      });
      expect(verif.prNumber).toBe(50);

      // 2. Retrieve verification
      const fetched = await client.forProject(projectId).getCandidateVerification(50);
      expect(fetched.candidateHeadSha).toBe("sha_client_head_50");

      // 3. Evaluate landing guard via client
      const guard = await client.forProject(projectId).evaluateLandingGuard(50, {
        headSha: "sha_client_head_50",
        baseSha: "sha_client_base_50",
      });
      expect(guard.allowed).toBe(true);

      // 4. Gate approval via client
      const approval = await client.forProject(projectId).approveGate({
        gateId: "quality_gate_1",
        candidateSha: "sha_client_head_50",
        decision: "approved",
      });
      expect(approval.decision).toBe("approved");

      // 5. Tiered action via client exercising live git branch freshness
      const currentMainSha = execFileSync("git", ["rev-parse", "main"], {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();

      const tieredResult = await client.forProject(projectId).executeTieredAction({
        action: "launch",
        targetBranch: "main",
        expectedBranchSha: currentMainSha,
        issueNumbers: [63],
        confirmed: true,
      });
      expect(tieredResult.success).toBe(true);
      expect(tieredResult.freshnessVerified).toBe(true);
      expect(tieredResult.branchSha).toBe(currentMainSha);

      // 6. Sanitized report via client
      const report = await client.forProject(projectId).getSanitizedReport(50);
      expect(report.sanitized).toBe(true);
      expect(report.report).toContain("Candidate Head: sha_client_head_50");
    });
  });
});
