import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type {
  CandidateVerificationSubmission,
  CandidateVerificationRecord,
  LandingGuardResult,
  LandingSubmission,
  LandingExecutionResult,
  TieredActionSubmission,
  TieredActionResult,
  RunCancellationSubmission,
  RunCancellationResult,
  GateApprovalSubmission,
  GateApprovalRecord,
  ReleaseReadinessResult,
  SanitizedReport,
} from "@animus/contracts/operator";
import type { ForgeAdapter } from "../registry/forge";
import type { CommandLedger } from "../command/ledger";
import { CandidateVerificationEngine } from "./verification";
import { LandingGuard } from "./landing-guard";
import { TieredActionMatrix, type FreshnessResolver } from "./tiered-actions";
import { RunControlManager, type ProcessTreeTerminator } from "./run-controls";
import { GateAndReleaseManager } from "./gates-and-release";
import { ReportSanitizer } from "@animus/contracts/sanitizer";
import { EvidenceError } from "./errors";

export class EvidenceService {
  public readonly verificationEngine: CandidateVerificationEngine;
  public readonly landingGuard: LandingGuard;
  public readonly tieredActions: TieredActionMatrix;
  public readonly runControls: RunControlManager;
  public readonly gateAndRelease: GateAndReleaseManager;
  public readonly sanitizer: ReportSanitizer;

  constructor(
    private db: DatabaseSync,
    private forge?: ForgeAdapter,
    private ledger?: CommandLedger,
  ) {
    this.verificationEngine = new CandidateVerificationEngine(db);
    this.landingGuard = new LandingGuard(this.verificationEngine, db);
    this.tieredActions = new TieredActionMatrix();
    this.runControls = new RunControlManager(db);
    this.gateAndRelease = new GateAndReleaseManager(db, this.verificationEngine);
    this.sanitizer = new ReportSanitizer();
  }

  // AC1, AC2: Candidate Verification
  recordVerification(
    projectId: string,
    submission: CandidateVerificationSubmission,
  ): CandidateVerificationRecord {
    const requestId = `cmd_verif_${projectId}_pr${submission.prNumber}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (this.ledger) {
      this.ledger.recordBeforeDispatch({
        requestId,
        actor: submission.producerIdentity?.id ?? "evaluator",
        projectId,
        action: "candidate_verification",
        target: {
          prNumber: submission.prNumber,
          candidateHeadSha: submission.candidateHeadSha,
          status: submission.verificationStatus,
        },
      });
    }

    try {
      const record = this.verificationEngine.recordVerification(projectId, submission);

      if (this.ledger) {
        this.ledger.updateOutcome(requestId, {
          state: submission.verificationStatus === "passed" ? "succeeded" : "failed",
          provenance: {
            source: submission.producerIdentity?.id ?? "evaluator",
            timestamp: new Date().toISOString(),
            details: `Candidate verification status: ${submission.verificationStatus}`,
          },
          result: record as unknown as Record<string, unknown>,
        });
      }

      return record;
    } catch (err: any) {
      if (this.ledger) {
        this.ledger.updateOutcome(requestId, {
          state: "failed",
          provenance: {
            source: submission.producerIdentity?.id ?? "evaluator",
            timestamp: new Date().toISOString(),
          },
          error: err.message,
        });
      }
      throw err;
    }
  }

  getVerificationByPr(projectId: string, prNumber: number): CandidateVerificationRecord | null {
    return this.verificationEngine.getVerificationByPr(projectId, prNumber);
  }

  listVerifications(projectId: string): CandidateVerificationRecord[] {
    return this.verificationEngine.listVerifications(projectId);
  }

  // AC1, AC2: Landing Guard
  async evaluateLanding(
    projectId: string,
    prNumber: number,
    options?: { currentHeadSha?: string; currentBaseSha?: string; repoName?: string },
  ): Promise<LandingGuardResult> {
    const repoName = options?.repoName ?? this.getProjectRepoName(projectId);
    return this.landingGuard.evaluateLanding({
      projectId,
      prNumber,
      repoName,
      currentHeadSha: options?.currentHeadSha,
      currentBaseSha: options?.currentBaseSha,
      forge: this.forge,
    });
  }

  async executeLanding(
    projectId: string,
    submission: LandingSubmission,
  ): Promise<LandingExecutionResult> {
    const repoName = this.getProjectRepoName(projectId);
    const requestId = `cmd_landing_${projectId}_pr${submission.prNumber}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (this.ledger) {
      this.ledger.recordBeforeDispatch({
        requestId,
        actor: submission.actor ?? "operator",
        projectId,
        action: "merge_landing",
        target: { ...submission, repoName },
      });
    }

    try {
      const result = await this.landingGuard.executeLanding({
        projectId,
        prNumber: submission.prNumber,
        repoName,
        expectedHeadSha: submission.expectedHeadSha,
        expectedBaseSha: submission.expectedBaseSha,
        forge: this.forge,
        actor: submission.actor,
      });

      if (this.ledger) {
        this.ledger.updateOutcome(requestId, {
          state: "succeeded",
          provenance: {
            source: "landing_guard",
            timestamp: new Date().toISOString(),
          },
          result: result as unknown as Record<string, unknown>,
        });
      }

      return result;
    } catch (err: any) {
      if (this.ledger) {
        this.ledger.updateOutcome(requestId, {
          state: "failed",
          provenance: {
            source: "landing_guard",
            timestamp: new Date().toISOString(),
          },
          error: err.message,
        });
      }
      throw err;
    }
  }

  // AC3: Tiered Action Matrix & Live Freshness Check
  async executeTieredAction(
    projectId: string,
    submission: TieredActionSubmission,
    resolver: FreshnessResolver,
    executeFn?: () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
  ): Promise<TieredActionResult> {
    const requestId = `cmd_tiered_${projectId}_${submission.action}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (this.ledger) {
      this.ledger.recordBeforeDispatch({
        requestId,
        actor: submission.actor ?? "operator",
        projectId,
        action: submission.action,
        target: submission as unknown as Record<string, unknown>,
      });
    }

    try {
      const result = await this.tieredActions.validateAndExecute(submission, resolver, executeFn);

      if (this.ledger) {
        this.ledger.updateOutcome(requestId, {
          state: "succeeded",
          provenance: {
            source: "tiered_action_matrix",
            timestamp: result.executedAt,
            details: `Freshness verified in ${result.freshnessDurationMs}ms`,
          },
          result: result as unknown as Record<string, unknown>,
        });
      }

      return result;
    } catch (err: any) {
      if (this.ledger) {
        this.ledger.updateOutcome(requestId, {
          state: "failed",
          provenance: {
            source: "tiered_action_matrix",
            timestamp: new Date().toISOString(),
          },
          error: err.message,
        });
      }
      throw err;
    }
  }

  // AC4: Verified Per-Run Controls
  async cancelRun(
    projectId: string,
    submission: RunCancellationSubmission,
    terminator?: ProcessTreeTerminator,
  ): Promise<RunCancellationResult> {
    const requestId = `cmd_cancel_${projectId}_${submission.runId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (this.ledger) {
      this.ledger.recordBeforeDispatch({
        requestId,
        actor: submission.actor ?? "operator",
        projectId,
        action: "run_cancel",
        target: submission as unknown as Record<string, unknown>,
      });
    }

    try {
      const result = await this.runControls.cancelRun(submission, {
        projectId,
        terminator,
      });

      if (this.ledger) {
        this.ledger.updateOutcome(requestId, {
          state: "succeeded",
          provenance: {
            source: "run_control_manager",
            timestamp: new Date().toISOString(),
            details: `Cleanup verified, terminated pids: ${result.killedPids.join(", ")}`,
          },
          result: result as unknown as Record<string, unknown>,
        });
      }

      return result;
    } catch (err: any) {
      if (this.ledger) {
        this.ledger.updateOutcome(requestId, {
          state: "failed",
          provenance: {
            source: "run_control_manager",
            timestamp: new Date().toISOString(),
          },
          error: err.message,
        });
      }
      throw err;
    }
  }

  // AC5: Gate Approval & Release Readiness
  approveGate(projectId: string, submission: GateApprovalSubmission): GateApprovalRecord {
    return this.gateAndRelease.approveGate(projectId, submission);
  }

  getReleaseReadiness(projectId: string, candidateSha: string): ReleaseReadinessResult {
    return this.gateAndRelease.checkReleaseReadiness(projectId, candidateSha);
  }

  verifyCandidateForRelease(projectId: string, candidateSha: string): void {
    this.gateAndRelease.verifyCandidateForRelease(projectId, candidateSha);
  }

  // AC6: Sanitized Reports
  sanitizeReport(rawContent: string): SanitizedReport {
    return this.sanitizer.sanitizeMarkdown(rawContent);
  }

  createLiveFreshnessResolver(projectId: string): FreshnessResolver {
    const project = this.getProject(projectId);
    return {
      resolveBranchSha: (targetBranch: string) => {
        try {
          const sha = execFileSync("git", ["rev-parse", targetBranch], {
            cwd: project.checkout_path,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
          return sha;
        } catch (err: any) {
          throw new EvidenceError(
            "freshness_check_failed",
            `Failed to resolve live branch SHA for ${targetBranch}: ${err?.message || String(err)}`,
            { targetBranch, projectId },
          );
        }
      },
      checkPrerequisite: (key: string) => {
        if (key === "gate_approved") {
          const row = this.db
            .prepare(
              "SELECT id FROM gate_approvals WHERE project_id = ? AND decision = 'approved' LIMIT 1",
            )
            .get(projectId);
          return row ? "true" : "false";
        }
        if (key === "verification_passed") {
          const row = this.db
            .prepare(
              "SELECT id FROM candidate_verifications WHERE project_id = ? AND verification_status = 'passed' LIMIT 1",
            )
            .get(projectId);
          return row ? "true" : "false";
        }
        return undefined;
      },
    };
  }

  getProject(projectId: string): { id: string; checkout_path: string; repo_name: string } {
    const row = this.db
      .prepare("SELECT id, checkout_path, repo_name FROM projects WHERE id = ?")
      .get(projectId) as any;
    if (!row) {
      throw new EvidenceError("project_not_found", `Project '${projectId}' does not exist.`);
    }
    return row;
  }

  private getProjectRepoName(projectId: string): string {
    return this.getProject(projectId).repo_name;
  }
}
