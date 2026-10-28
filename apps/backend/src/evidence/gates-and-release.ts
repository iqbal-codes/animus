import type { DatabaseSync } from "node:sqlite";
import {
  gateApprovalRecordSchema,
  releaseReadinessResultSchema,
  type GateApprovalRecord,
  type GateApprovalSubmission,
  type ReleaseReadinessResult,
  type ReleasePolicyStage,
} from "@labq/contracts/operator";
import type { CandidateVerificationEngine } from "./verification";
import { EvidenceError } from "./errors";

export class GateAndReleaseManager {
  constructor(
    private db: DatabaseSync,
    private verificationEngine: CandidateVerificationEngine,
  ) {}

  approveGate(projectId: string, submission: GateApprovalSubmission): GateApprovalRecord {
    const { gateId, candidateSha, decision, actor, comment } = submission;

    // Check project exists
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as any;

    if (!project) {
      throw new EvidenceError("project_not_found", `Project '${projectId}' does not exist.`);
    }

    if (project.status !== "active") {
      throw new EvidenceError("project_not_active", `Project '${projectId}' is not active.`);
    }

    // Verify candidate SHA is not drifted if there is a plan or active coordination
    const coord = this.db
      .prepare(
        "SELECT current_integration_sha FROM project_spec_coordinations WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(projectId) as any;

    if (coord && coord.current_integration_sha && coord.current_integration_sha !== candidateSha) {
      throw new EvidenceError(
        "stale_candidate_drift",
        `Gate approval specifies candidate '${candidateSha}', but current active candidate is '${coord.current_integration_sha}'.`,
        { expectedSha: candidateSha, currentActiveSha: coord.current_integration_sha },
      );
    }

    const id = `gate_${projectId}_${gateId}_${Date.now()}`;
    const now = new Date().toISOString();

    const record: GateApprovalRecord = {
      id,
      projectId,
      gateId,
      candidateSha,
      decision,
      actor: actor ?? "operator",
      comment,
      createdAt: now,
    };

    const validated = gateApprovalRecordSchema.parse(record);

    this.db
      .prepare(
        `INSERT INTO gate_approvals (id, project_id, gate_id, candidate_sha, decision, actor, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.id,
        validated.projectId,
        validated.gateId,
        validated.candidateSha,
        validated.decision,
        validated.actor,
        validated.comment ?? null,
        now,
      );

    return validated;
  }

  getGateApproval(
    projectId: string,
    gateId: string,
    candidateSha: string,
  ): GateApprovalRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM gate_approvals 
         WHERE project_id = ? AND gate_id = ? AND candidate_sha = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, gateId, candidateSha) as any;

    if (!row) return null;
    return gateApprovalRecordSchema.parse({
      id: row.id,
      projectId: row.project_id,
      gateId: row.gate_id,
      candidateSha: row.candidate_sha,
      decision: row.decision,
      actor: row.actor,
      comment: row.comment ?? undefined,
      createdAt: row.created_at,
    });
  }

  verifyCandidateForRelease(projectId: string, candidateSha: string): void {
    const verif = this.verificationEngine.getVerificationByHead(projectId, candidateSha);
    if (!verif || verif.verificationStatus !== "passed") {
      throw new EvidenceError(
        "unverified_candidate_blocked",
        `Candidate '${candidateSha}' has not passed independent candidate verification. Promotion and deployment blocked.`,
        { candidateSha, verificationStatus: verif?.verificationStatus ?? "missing" },
      );
    }
  }

  checkReleaseReadiness(projectId: string, candidateSha: string): ReleaseReadinessResult {
    const stages: ReleasePolicyStage[] = [];
    const pendingStages: string[] = [];

    // Stage 1: Candidate Verification
    const verif = this.verificationEngine.getVerificationByHead(projectId, candidateSha);
    const verifPassed = verif !== null && verif.verificationStatus === "passed";
    stages.push({
      stage: "candidate_verification",
      passed: verifPassed,
      status: verifPassed ? "passed" : verif ? "failed" : "pending",
      details: verif ? `Status: ${verif.verificationStatus}` : "No candidate verification record",
    });
    if (!verifPassed) pendingStages.push("candidate_verification");

    // Stage 2: Independent Review
    const reviewPassed = verif !== null && verif.review?.status === "passed";
    stages.push({
      stage: "independent_review",
      passed: Boolean(reviewPassed),
      status: reviewPassed ? "passed" : verif?.review ? "failed" : "pending",
      details: verif?.review
        ? `Review status: ${verif.review.status}`
        : "No independent review completed",
    });
    if (!reviewPassed) pendingStages.push("independent_review");

    // Stage 3: Quality Gate Approval
    const gateApproval = this.db
      .prepare(
        `SELECT decision FROM gate_approvals 
         WHERE project_id = ? AND candidate_sha = ? AND decision = 'approved'
         LIMIT 1`,
      )
      .get(projectId, candidateSha) as any;
    const gatePassed = Boolean(gateApproval);
    stages.push({
      stage: "gate_approval",
      passed: gatePassed,
      status: gatePassed ? "passed" : "pending",
      details: gatePassed ? "Approved by authorized actor" : "Awaiting gate approval",
    });
    if (!gatePassed) pendingStages.push("gate_approval");

    // Stage 4: Landing Verified
    const landingRow = this.db
      .prepare(
        `SELECT final_pr_number, status FROM project_spec_coordinations
         WHERE project_id = ? AND current_integration_sha = ? AND status = 'completed'
         LIMIT 1`,
      )
      .get(projectId, candidateSha) as any;
    const landingPassed = Boolean(landingRow);
    stages.push({
      stage: "landing_verified",
      passed: landingPassed,
      status: landingPassed ? "passed" : "pending",
      details: landingPassed ? "Final PR merged / landing verified" : "Landing pending",
    });
    if (!landingPassed) pendingStages.push("landing_verified");

    const releaseComplete = pendingStages.length === 0;

    return releaseReadinessResultSchema.parse({
      projectId,
      candidateSha,
      releaseComplete,
      stages,
      pendingStages,
    });
  }
}
