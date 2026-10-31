import type { LandingGuardResult, LandingExecutionResult } from "@animus/contracts/operator";
import type { DatabaseSync } from "node:sqlite";
import type { CandidateVerificationEngine } from "./verification";
import type { ForgeAdapter } from "../registry/forge";
import { EvidenceError } from "./errors";

export interface EvaluateLandingOptions {
  projectId: string;
  prNumber: number;
  repoName: string;
  currentHeadSha?: string;
  currentBaseSha?: string;
  forge?: ForgeAdapter;
}

export interface ExecuteLandingOptions {
  projectId: string;
  prNumber: number;
  repoName: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  forge?: ForgeAdapter;
  actor?: string;
}

export class LandingGuard {
  constructor(
    private verificationEngine: CandidateVerificationEngine,
    private db?: DatabaseSync,
  ) {}

  async evaluateLanding(options: EvaluateLandingOptions): Promise<LandingGuardResult> {
    const { projectId, prNumber, repoName, forge } = options;

    let currentHead = options.currentHeadSha;
    let currentBase = options.currentBaseSha;

    if ((!currentHead || !currentBase) && forge && forge.getPullRequest) {
      const pr = await forge.getPullRequest(repoName, prNumber);
      if (pr) {
        currentHead = currentHead ?? pr.head;
        currentBase = currentBase ?? pr.base;
      }
    }

    currentHead = currentHead ?? "unknown_head";
    currentBase = currentBase ?? "unknown_base";

    const verification = this.verificationEngine.getVerificationByPr(projectId, prNumber);

    if (!verification) {
      return {
        decision: "blocked",
        allowed: false,
        prNumber,
        candidateHeadSha: currentHead,
        mergeBaseSha: currentBase,
        blockReason: "evidence_missing",
        blockDetails: { message: `No candidate verification record found for PR #${prNumber}` },
      };
    }

    // Invariant 2: Builder self-approval rejection
    if (verification.producerIdentity.role === "builder") {
      return {
        decision: "blocked",
        allowed: false,
        prNumber,
        candidateHeadSha: currentHead,
        mergeBaseSha: currentBase,
        evidenceId: verification.id,
        blockReason: "builder_self_approval_rejected",
        blockDetails: {
          producer: verification.producerIdentity,
          message:
            "Builder cannot self-approve: verification must be produced by an independent evaluator or peer reviewer.",
        },
      };
    }

    // Verification status check
    if (verification.verificationStatus !== "passed") {
      return {
        decision: "blocked",
        allowed: false,
        prNumber,
        candidateHeadSha: currentHead,
        mergeBaseSha: currentBase,
        evidenceId: verification.id,
        blockReason: "verification_failed",
        blockDetails: {
          status: verification.verificationStatus,
          message: "Candidate verification record is not in 'passed' status.",
        },
      };
    }

    // Invariant 1: Candidate head SHA drift check
    if (verification.candidateHeadSha !== currentHead) {
      return {
        decision: "blocked",
        allowed: false,
        prNumber,
        candidateHeadSha: currentHead,
        mergeBaseSha: currentBase,
        evidenceId: verification.id,
        blockReason: "candidate_drift",
        blockDetails: {
          expectedHeadSha: verification.candidateHeadSha,
          actualHeadSha: currentHead,
          message: `Candidate head SHA drifted: evidence verified ${verification.candidateHeadSha}, but PR head is ${currentHead}`,
        },
      };
    }

    // Invariant 1: Merge base tree drift check
    if (verification.mergeBaseSha !== currentBase) {
      return {
        decision: "blocked",
        allowed: false,
        prNumber,
        candidateHeadSha: currentHead,
        mergeBaseSha: currentBase,
        evidenceId: verification.id,
        blockReason: "base_drift",
        blockDetails: {
          expectedBaseSha: verification.mergeBaseSha,
          actualBaseSha: currentBase,
          message: `Merge base SHA drifted: evidence verified ${verification.mergeBaseSha}, but PR base is ${currentBase}`,
        },
      };
    }

    return {
      decision: "allowed",
      allowed: true,
      prNumber,
      candidateHeadSha: currentHead,
      mergeBaseSha: currentBase,
      evidenceId: verification.id,
    };
  }

  async executeLanding(options: ExecuteLandingOptions): Promise<LandingExecutionResult> {
    const { projectId, prNumber, repoName, expectedHeadSha, expectedBaseSha, forge } = options;

    const evalResult = await this.evaluateLanding({
      projectId,
      prNumber,
      repoName,
      currentHeadSha: expectedHeadSha,
      currentBaseSha: expectedBaseSha,
      forge,
    });

    if (!evalResult.allowed) {
      throw new EvidenceError(
        "landing_guard_blocked",
        `Landing guard blocked merge for PR #${prNumber}: ${evalResult.blockReason}`,
        evalResult.blockDetails,
      );
    }

    let mergeSha = expectedHeadSha;
    if (forge && (forge as any).mergePullRequest) {
      const res = await (forge as any).mergePullRequest(repoName, prNumber);
      if (res && res.sha) mergeSha = res.sha;
    }

    const landingId = `land_${projectId}_pr${prNumber}_${Date.now()}`;
    const landedAt = new Date().toISOString();
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO candidate_landings (
            id, project_id, pr_number, candidate_head_sha, merge_base_sha, merge_sha, landed_by, landed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          landingId,
          projectId,
          prNumber,
          expectedHeadSha,
          expectedBaseSha,
          mergeSha,
          options.actor ?? "operator",
          landedAt,
        );
    }

    return {
      success: true,
      prNumber,
      merged: true,
      mergeSha,
      candidateHeadSha: expectedHeadSha,
      mergeBaseSha: expectedBaseSha,
    };
  }
}
