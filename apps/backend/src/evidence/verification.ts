import type { DatabaseSync } from "node:sqlite";
import {
  candidateVerificationRecordSchema,
  type CandidateVerificationRecord,
  type CandidateVerificationSubmission,
} from "@animus/contracts/operator";
import { EvidenceError } from "./errors";

export class CandidateVerificationEngine {
  constructor(private db: DatabaseSync) {}

  recordVerification(
    projectId: string,
    submission: CandidateVerificationSubmission,
  ): CandidateVerificationRecord {
    // Invariant 2: Builder does not self-approve
    if (submission.producerIdentity.role === "builder") {
      throw new EvidenceError(
        "builder_self_approval_rejected",
        "Builder self-approval is strictly forbidden: ordinary child checks do not substitute for independent candidate verification.",
        { producer: submission.producerIdentity },
      );
    }

    // Invariant 1: Candidate-bound verification integrity
    if (submission.verificationStatus === "passed") {
      if (submission.checks.length === 0) {
        throw new EvidenceError(
          "verification_failed",
          "Verification marked as passed but contains zero verified contract checks.",
        );
      }
      const failedChecks = submission.checks.filter((c) => c.result !== "PASS");
      if (failedChecks.length > 0) {
        throw new EvidenceError(
          "verification_failed",
          `Verification contains ${failedChecks.length} failed/unverified check(s).`,
          { failedChecks: failedChecks.map((c) => c.name) },
        );
      }
      if (submission.review && submission.review.status !== "passed") {
        throw new EvidenceError("verification_failed", "Independent review did not pass.", {
          reviewStatus: submission.review.status,
        });
      }
    }

    const id = `verif_${projectId}_pr${submission.prNumber}_${Date.now()}`;
    const now = new Date().toISOString();

    const record: CandidateVerificationRecord = {
      id,
      projectId,
      specIssueNumber: submission.specIssueNumber,
      prNumber: submission.prNumber,
      candidateHeadSha: submission.candidateHeadSha,
      mergeBaseSha: submission.mergeBaseSha,
      runtimeEnvironment: submission.runtimeEnvironment,
      producerIdentity: submission.producerIdentity,
      verificationStatus: submission.verificationStatus,
      checks: submission.checks,
      review: submission.review,
      createdAt: now,
      updatedAt: now,
    };

    const validated = candidateVerificationRecordSchema.parse(record);

    this.db
      .prepare(
        `INSERT INTO candidate_verifications (
          id, project_id, spec_issue_number, pr_number, candidate_head_sha,
          merge_base_sha, runtime_environment, producer_identity, verification_status,
          checks, review, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          verification_status = excluded.verification_status,
          checks = excluded.checks,
          review = excluded.review,
          updated_at = excluded.updated_at`,
      )
      .run(
        validated.id,
        validated.projectId,
        validated.specIssueNumber ?? null,
        validated.prNumber,
        validated.candidateHeadSha,
        validated.mergeBaseSha,
        JSON.stringify(validated.runtimeEnvironment),
        JSON.stringify(validated.producerIdentity),
        validated.verificationStatus,
        JSON.stringify(validated.checks),
        validated.review ? JSON.stringify(validated.review) : null,
        now,
        now,
      );

    return validated;
  }

  getVerificationByPr(projectId: string, prNumber: number): CandidateVerificationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM candidate_verifications 
         WHERE project_id = ? AND pr_number = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, prNumber) as any;

    if (!row) return null;
    return this.mapRowToRecord(row);
  }

  getVerificationByHead(
    projectId: string,
    candidateHeadSha: string,
  ): CandidateVerificationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM candidate_verifications 
         WHERE project_id = ? AND candidate_head_sha = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, candidateHeadSha) as any;

    if (!row) return null;
    return this.mapRowToRecord(row);
  }

  listVerifications(projectId: string): CandidateVerificationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM candidate_verifications 
         WHERE project_id = ?
         ORDER BY created_at DESC`,
      )
      .all(projectId) as any[];

    return rows.map((r) => this.mapRowToRecord(r));
  }

  private mapRowToRecord(row: any): CandidateVerificationRecord {
    return candidateVerificationRecordSchema.parse({
      id: row.id,
      projectId: row.project_id,
      specIssueNumber: row.spec_issue_number ?? undefined,
      prNumber: row.pr_number,
      candidateHeadSha: row.candidate_head_sha,
      mergeBaseSha: row.merge_base_sha,
      runtimeEnvironment: JSON.parse(row.runtime_environment),
      producerIdentity: JSON.parse(row.producer_identity),
      verificationStatus: row.verification_status,
      checks: JSON.parse(row.checks || "[]"),
      review: row.review ? JSON.parse(row.review) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
