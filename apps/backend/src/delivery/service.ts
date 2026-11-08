import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  GATE_PROFILE_VERSION,
  deliveryGateStatusSchema,
  deliveryMergeVerificationSchema,
  type AcceptanceDecision,
  type DeliveryGateMerge,
  type DeliveryGatePublication,
  type DeliveryGateStage,
  type DeliveryGateStageStatus,
  type DeliveryGateState,
  type DeliveryGateStatus,
  type DeliveryMergeVerification,
  type ExecutionCheckRecord,
  type ExecutionObservationRecord,
  type ExecutionStage,
  type PlanGateProfile,
} from "@animus/contracts/operator";
import type { ForgeAdapter, ForgePullRequest } from "../registry/forge";
import { readRequiredChecks } from "../registry/required-checks";
import type { ExecutionObservationService } from "../evidence";
import {
  defaultGitRemote,
  type PublicationService,
  type PublicationRemoteRunner,
} from "../publication";
import { DeliveryError } from "./errors";

interface RunRow {
  id: string;
  project_id: string;
  delivery_id: string;
  plan_id: string;
  work_id: string;
  issue_number: number;
  gate_profile: PlanGateProfile;
  merge_policy: "auto_after_gates" | "manual";
  target_branch: string;
  branch: string;
  head_sha: string | null;
  base_sha: string;
  state: string;
  checkout_path: string;
  repo_name: string;
  graph_hash: string;
}

interface VerificationRow {
  id: string;
  project_id: string;
  delivery_id: string;
  plan_id: string;
  work_id: string;
  run_id: string;
  gate_profile: "standalone" | "final";
  target_id: string;
  pull_request_id: string;
  repository: string;
  pr_number: number;
  source_branch: string;
  target_branch: string;
  candidate_head_sha: string;
  remote_head_ref_oid: string;
  remote_target_tip_sha: string;
  merge_commit_sha: string | null;
  verified_at: number;
  verified_by: string;
}

interface RemoteMergeProof {
  ok: boolean;
  mergeCommitSha: string | null;
  detail: string;
  reason?: string;
}

interface RemoteCiCheck {
  status: DeliveryGateStageStatus;
  detail: string;
  reasons: string[];
}

export interface DeliveryGateServiceOptions {
  observations: ExecutionObservationService;
  publication: PublicationService;
  forge: ForgeAdapter;
  /** Bounded git transport for remote target lineage verification. */
  gitRemote?: PublicationRemoteRunner;
  gitRunner?: (cmd: string[], cwd: string) => string;
  clock?: () => number;
}

/**
 * Reusable full-delivery gate for standalone tickets and the later final-spec
 * delivery. It consumes the same candidate-bound evidence, publication target and
 * forge transport as child work; it never invents a second evidence or PR store.
 *
 * A delivery is locally complete only after the remote PR reports MERGED into the
 * exact configured target and the candidate is proven to be included in that
 * target's remote lineage.
 */
export class DeliveryGateService {
  private readonly gitRemote: PublicationRemoteRunner;
  private readonly gitRunner: (cmd: string[], cwd: string) => string;
  private readonly clock: () => number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: DeliveryGateServiceOptions,
  ) {
    this.gitRemote = options.gitRemote ?? defaultGitRemote;
    this.gitRunner =
      options.gitRunner ??
      ((cmd, cwd) =>
        execFileSync("git", cmd, {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim());
    this.clock = options.clock ?? (() => Date.now());
  }

  async getGate(projectId: string, runId: string): Promise<DeliveryGateStatus> {
    return this.evaluate(projectId, runId);
  }

  /**
   * Records local completion after the operator has merged the standalone/final PR
   * in GitHub. This never merges anything: it verifies an already-observed remote
   * merge and target lineage.
   */
  async verifyMerge(
    projectId: string,
    runId: string,
    actor = "operator",
  ): Promise<DeliveryGateStatus> {
    const evaluated = await this.evaluate(projectId, runId);
    if (evaluated.merge.verified) return evaluated;
    if (evaluated.state === "remote_unavailable") {
      throw new DeliveryError(
        "delivery_remote_unreadable",
        "The remote pull request is unreadable; merge verification remains incomplete",
        { reasons: evaluated.reasons },
      );
    }
    if (evaluated.state === "closed_unmerged") {
      throw new DeliveryError(
        "delivery_merge_not_verified",
        "The remote pull request is closed without a verified merge",
        { reasons: evaluated.reasons },
      );
    }
    if (evaluated.state !== "awaiting_merge_verification") {
      throw new DeliveryError(
        "delivery_gate_unsatisfied",
        "The full-delivery gate is not satisfied; a merge cannot be marked delivered",
        { state: evaluated.state, reasons: evaluated.reasons },
      );
    }
    const targetId = evaluated.publication.targetId;
    const pullRequestId = evaluated.publication.pullRequestId;
    const prNumber = evaluated.publication.prNumber;
    if (!targetId || !pullRequestId || !prNumber) {
      throw new DeliveryError(
        "delivery_merge_not_verified",
        "The remote merge lacks the exact target/PR/lineage binding required for delivery",
        { state: evaluated.state },
      );
    }
    if (!evaluated.candidateHeadSha) {
      throw new DeliveryError(
        "delivery_merge_not_verified",
        "The remote merge lacks a verified candidate head",
      );
    }

    // Re-read and re-prove the remote merge at write time. A transport-reported
    // mergeCommitOid is never stored unless it is a real commit on the target
    // lineage whose first parent is the tested target tip.
    const run = this.loadRun(projectId, runId);
    const acceptance = this.options.observations.evaluateAcceptance(projectId, runId);
    const forge = this.options.forge;
    if (typeof forge.getPullRequest !== "function") {
      throw new DeliveryError(
        "delivery_remote_unreadable",
        "The forge transport cannot read the remote pull request",
      );
    }
    const remote = await forge.getPullRequest(run.repo_name, prNumber);
    if (!remote) {
      throw new DeliveryError(
        "delivery_merge_not_verified",
        "The remote pull request is no longer readable",
      );
    }
    if (String(remote.state).toUpperCase() !== "MERGED") {
      throw new DeliveryError(
        "delivery_gate_unsatisfied",
        "The remote pull request is not merged",
        { state: String(remote.state) },
      );
    }
    const remoteTargetTipSha = await this.fetchRemoteTargetTip(run);
    const proof = this.verifyRemoteMerge(run, acceptance, remote, remoteTargetTipSha);
    if (!proof.ok || !remoteTargetTipSha) {
      throw new DeliveryError("delivery_merge_not_verified", proof.detail, {
        reason: proof.reason ?? "merge_commit_unverified",
      });
    }
    const headRefOid = remote.headRefOid ?? evaluated.publication.headRefOid;
    if (!headRefOid || headRefOid !== run.head_sha) {
      throw new DeliveryError(
        "delivery_merge_not_verified",
        "The remote merge head does not match the tested candidate",
        { remoteHeadRefOid: headRefOid, candidateHeadSha: run.head_sha },
      );
    }

    const verificationId = `dmv_${randomUUID()}`;
    const verifiedAt = this.clock();
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      this.db
        .prepare(
          `INSERT INTO delivery_merge_verifications
             (id, project_id, delivery_id, plan_id, work_id, run_id, gate_profile,
              target_id, pull_request_id, repository, pr_number, source_branch, target_branch,
              candidate_head_sha, remote_head_ref_oid, remote_target_tip_sha, merge_commit_sha,
              verified_at, verified_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, run_id, candidate_head_sha) DO NOTHING`,
        )
        .run(
          verificationId,
          projectId,
          evaluated.deliveryId,
          evaluated.planId,
          evaluated.workId,
          evaluated.runId,
          evaluated.gateProfile as "standalone" | "final",
          targetId,
          pullRequestId,
          this.loadProjectRepo(projectId),
          prNumber,
          evaluated.sourceBranch,
          evaluated.targetBranch,
          evaluated.candidateHeadSha,
          headRefOid,
          remoteTargetTipSha,
          proof.mergeCommitSha,
          verifiedAt,
          actor,
        );
      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw new DeliveryError(
        "delivery_storage_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    return this.evaluate(projectId, runId);
  }

  private async evaluate(projectId: string, runId: string): Promise<DeliveryGateStatus> {
    const run = this.loadRun(projectId, runId);
    if (run.gate_profile === "child") {
      throw new DeliveryError(
        "delivery_profile_unsupported",
        `Run ${runId} uses the child gate profile; full-delivery gates only apply to standalone/final work`,
      );
    }
    const acceptance = this.options.observations.evaluateAcceptance(projectId, runId);
    const latest = (stage: ExecutionStage): ExecutionObservationRecord | null =>
      this.options.observations.latestObservation(projectId, runId, stage);
    const builder = latest("builder_execution");
    const review = latest("independent_review");
    const finalAcceptance = latest("final_acceptance");

    const reasons = new Set<string>(acceptance.reasons);
    const correctionReasons = new Set<string>();
    const blockedReasons = new Set<string>();
    const staleReasons = new Set<string>();
    const classifyAcceptanceReasons = () => {
      for (const reason of acceptance.reasons) {
        if (this.isStaleReason(reason)) {
          staleReasons.add(reason);
          continue;
        }
        if (
          reason.startsWith("required_stage_not_passed") ||
          reason.startsWith("self_certified_stage") ||
          reason === "open_blocking_findings"
        ) {
          correctionReasons.add(reason);
          continue;
        }
        blockedReasons.add(reason);
      }
    };
    classifyAcceptanceReasons();

    const stages: DeliveryGateStage[] = [
      this.stageFor("builder_execution", builder),
      this.stageFor("independent_review", review),
      this.stageFor("final_acceptance", finalAcceptance),
    ];
    for (const observation of [review, finalAcceptance]) {
      if (!observation) continue;
      for (const reason of this.observationStaleness(observation, run, acceptance)) {
        staleReasons.add(reason);
        reasons.add(reason);
        const index = stages.findIndex((stage) => stage.name === observation.stage);
        if (index >= 0) {
          stages[index] = { ...stages[index]!, status: "stale", detail: reason };
        }
      }
      if (
        observation.status === "failed" ||
        observation.status === "inconclusive" ||
        observation.status === "interrupted"
      ) {
        correctionReasons.add(
          `required_stage_not_passed:${observation.stage}:${observation.status}`,
        );
      }
    }

    if (review && finalAcceptance && review.producer.id === finalAcceptance.producer.id) {
      correctionReasons.add("independent_stages_share_producer");
      reasons.add("independent_stages_share_producer");
    }

    const criteria = this.acceptanceCriteria(run);
    const acceptanceStage = this.acceptanceCriteriaStage(finalAcceptance, criteria);
    stages.push(acceptanceStage);
    if (acceptanceStage.status !== "passed") {
      (acceptanceStage.status === "missing" ? blockedReasons : correctionReasons).add(
        acceptanceStage.detail,
      );
      reasons.add(acceptanceStage.detail);
    }

    const regressionStage = this.requiredKindStage(
      "regression",
      [review, finalAcceptance],
      "regression",
    );
    const reviewStage = this.requiredKindStage("review", [review], "review");
    stages.push(regressionStage, reviewStage);
    for (const stage of [regressionStage, reviewStage]) {
      if (stage.status === "passed") continue;
      blockedReasons.add(stage.detail);
      reasons.add(stage.detail);
    }

    let publication = this.publicationSummary(run);
    const publicationStage: DeliveryGateStage = {
      name: "publication_audit",
      status: publication.auditComplete ? "passed" : publication.targetId ? "failed" : "missing",
      detail: publication.auditComplete
        ? `audit complete for target ${publication.targetId}`
        : publication.targetId
          ? `audit incomplete for target ${publication.targetId}`
          : "no publication target exists",
      observationId: null,
    };
    stages.push(publicationStage);

    let remote: ForgePullRequest | null = null;
    let remoteError: string | null = null;
    if (publication.prNumber) {
      if (typeof this.options.forge.getPullRequest !== "function") {
        remoteError = "remote_pull_request_unreadable: forge transport cannot read pull requests";
      } else {
        try {
          remote = await this.options.forge.getPullRequest(run.repo_name, publication.prNumber);
          if (!remote) {
            remoteError = "remote_pull_request_missing";
          }
        } catch (error) {
          remoteError = `remote_pull_request_unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }
    publication = {
      ...publication,
      remoteState: remote
        ? (String(remote.state).toLowerCase() as "open" | "closed" | "merged")
        : remoteError
          ? "unknown"
          : publication.remoteState,
      draft: remote ? Boolean(remote.draft) : publication.draft,
      headRefOid: remote?.headRefOid ?? publication.headRefOid,
      headBranch: remote?.head ?? publication.headBranch,
      baseBranch: remote?.base ?? publication.baseBranch,
      mergeCommitOid: remote?.mergeCommitOid ?? null,
    };
    const remoteDrift = this.remoteDriftReasons(run, publication, remote);
    for (const reason of remoteDrift) {
      staleReasons.add(reason);
      reasons.add(reason);
    }
    const remoteStage: DeliveryGateStage = {
      name: "remote_pull_request",
      status: remoteError
        ? "failed"
        : remoteDrift.length > 0
          ? "stale"
          : remote
            ? "passed"
            : "missing",
      detail: remoteError
        ? remoteError
        : remoteDrift.length > 0
          ? remoteDrift.join(", ")
          : remote
            ? `PR #${remote.number} ${remote.state} ${remote.head} -> ${remote.base}${
                remote.draft ? " (draft)" : ""
              }`
            : publication.prNumber
              ? "pull request unreadable"
              : "no pull request yet",
      observationId: null,
    };
    stages.push(remoteStage);

    const existing = this.loadVerification(projectId, runId, run.head_sha);
    const publicationComplete =
      publication.state === "published" ||
      (publication.auditComplete && publication.remoteState === "merged");
    const remoteStateUpper = String(remote?.state ?? "").toUpperCase();

    // Required remote CI is authoritative: read the target branch's branch-protection
    // contexts and the check runs reported for this exact PR head. A producer-asserted
    // `remote_ci` observation alone is never sufficient.
    const remoteCi = await this.readRemoteCi(run, remote, publication);
    const remoteCiStage: DeliveryGateStage = {
      name: "remote_ci",
      status: remoteCi.status,
      detail: remoteCi.detail,
      observationId: null,
    };
    stages.push(remoteCiStage);
    for (const reason of remoteCi.reasons) {
      blockedReasons.add(reason);
      reasons.add(reason);
    }

    let remoteTargetTipSha: string | null = null;
    let targetTipUnavailable = false;
    let mergeProof: RemoteMergeProof | null = null;
    if (remote && remoteStateUpper !== "CLOSED") {
      remoteTargetTipSha = await this.fetchRemoteTargetTip(run);
      if (!remoteTargetTipSha) {
        targetTipUnavailable = true;
        reasons.add("remote_target_unavailable");
      }
    }
    if (
      remote &&
      remoteStateUpper !== "MERGED" &&
      remoteStateUpper !== "CLOSED" &&
      remoteTargetTipSha &&
      acceptance.targetTipSha &&
      remoteTargetTipSha !== acceptance.targetTipSha
    ) {
      staleReasons.add("stale_target_tip");
      reasons.add("stale_target_tip");
    }
    if (remote && remoteStateUpper === "MERGED" && run.head_sha) {
      mergeProof = this.verifyRemoteMerge(run, acceptance, remote, remoteTargetTipSha);
    }

    const lineageStage: DeliveryGateStage = {
      name: "target_lineage",
      status:
        remoteStateUpper !== "MERGED"
          ? "not_applicable"
          : mergeProof?.ok
            ? "passed"
            : remoteTargetTipSha
              ? "failed"
              : "missing",
      detail:
        remoteStateUpper !== "MERGED"
          ? "no merged remote target lineage to verify yet"
          : (mergeProof?.detail ?? "remote target tip is unreadable"),
      observationId: null,
    };
    stages.push(lineageStage);

    let state: DeliveryGateState;
    if (existing) {
      state = "delivered";
    } else if (remoteError) {
      state = "remote_unavailable";
      reasons.add(remoteError);
    } else if (remoteDrift.length > 0) {
      state = "invalidated";
    } else if (targetTipUnavailable) {
      state = "remote_unavailable";
    } else if (remoteStateUpper === "CLOSED") {
      state = "closed_unmerged";
      reasons.add("remote_pull_request_closed_unmerged");
    } else if (staleReasons.size > 0) {
      state = "invalidated";
    } else if (correctionReasons.size > 0) {
      state = "correction_required";
    } else if (blockedReasons.size > 0) {
      state = "blocked";
    } else if (!publicationComplete) {
      state = "awaiting_publication";
      reasons.add("publication_not_complete");
    } else if (remoteStateUpper === "MERGED") {
      if (mergeProof?.ok) {
        state = "awaiting_merge_verification";
        reasons.add("merge_verification_required");
      } else {
        state = "invalidated";
        reasons.add(mergeProof?.reason ?? "target_lineage_not_verified");
      }
    } else if (!remote) {
      state = "blocked";
      reasons.add("remote_pull_request_missing");
    } else if (remote.draft) {
      state = "ready_for_operator_review";
    } else {
      state = "awaiting_manual_merge";
    }

    if (run.merge_policy !== "manual") {
      blockedReasons.add("manual_merge_policy_required");
      reasons.add("manual_merge_policy_required");
      if (state === "ready_for_operator_review" || state === "awaiting_manual_merge") {
        state = "blocked";
      }
    }

    const mergeState: DeliveryGateMerge = existing
      ? {
          state: "verified",
          verified: true,
          verification: existing,
          remoteTargetTipSha: existing.remoteTargetTipSha,
          detail: `verified merge of PR #${existing.prNumber} into ${existing.targetBranch}`,
        }
      : remoteStateUpper === "MERGED"
        ? {
            state: "unverified",
            verified: false,
            verification: null,
            remoteTargetTipSha,
            detail: mergeProof?.detail ?? "remote merged; target lineage has not been verified",
          }
        : remote?.state?.toUpperCase() === "CLOSED"
          ? {
              state: "closed_unmerged",
              verified: false,
              verification: null,
              remoteTargetTipSha: null,
              detail: "remote pull request closed without merge",
            }
          : remoteError
            ? {
                state: "remote_unavailable",
                verified: false,
                verification: null,
                remoteTargetTipSha: null,
                detail: remoteError,
              }
            : {
                state: "not_merged",
                verified: false,
                verification: null,
                remoteTargetTipSha: null,
                detail: "remote pull request is not merged",
              };

    return deliveryGateStatusSchema.parse({
      runId: run.id,
      projectId: run.project_id,
      deliveryId: run.delivery_id,
      planId: run.plan_id,
      workId: run.work_id,
      issueNumber: run.issue_number,
      gateProfile: run.gate_profile,
      mergePolicy: run.merge_policy,
      sourceBranch: run.branch,
      targetBranch: run.target_branch,
      candidateHeadSha: run.head_sha,
      targetTipSha: acceptance.targetTipSha,
      mergeBaseSha: acceptance.mergeBaseSha,
      integrationLineage: acceptance.integrationLineage,
      gateProfileVersion: GATE_PROFILE_VERSION,
      state,
      reasons: [...reasons],
      stages,
      acceptance,
      publication,
      merge: mergeState,
      manualMergeRequired: run.merge_policy === "manual",
    });
  }

  private stageFor(
    stage: string,
    observation: ExecutionObservationRecord | null,
  ): DeliveryGateStage {
    if (!observation) {
      return {
        name: stage,
        status: "missing",
        detail: `no ${stage} observation`,
        observationId: null,
      };
    }
    const status: DeliveryGateStageStatus =
      observation.status === "passed"
        ? "passed"
        : observation.status === "failed"
          ? "failed"
          : observation.status === "running"
            ? "running"
            : "inconclusive";
    return {
      name: stage,
      status,
      detail: `${observation.status} by ${observation.producer.id} (${observation.producer.role})`,
      observationId: observation.id,
    };
  }

  private acceptanceCriteriaStage(
    finalAcceptance: ExecutionObservationRecord | null,
    criteria: string[],
  ): DeliveryGateStage {
    if (!finalAcceptance) {
      return {
        name: "acceptance_criteria",
        status: "missing",
        detail: "missing_acceptance_check:final_acceptance",
        observationId: null,
      };
    }
    if (criteria.length === 0) {
      return {
        name: "acceptance_criteria",
        status: "failed",
        detail: "acceptance_criteria_missing",
        observationId: finalAcceptance.id,
      };
    }
    const missing = criteria.filter(
      (key) =>
        !finalAcceptance.checks.some(
          (check) =>
            check.kind === "acceptance" && check.criterionKey === key && check.result === "PASS",
        ),
    );
    if (missing.length > 0) {
      return {
        name: "acceptance_criteria",
        status: "failed",
        detail: `missing_acceptance_check:${missing.join(",")}`,
        observationId: finalAcceptance.id,
      };
    }
    return {
      name: "acceptance_criteria",
      status: "passed",
      detail: `${criteria.length} acceptance criteria independently verified`,
      observationId: finalAcceptance.id,
    };
  }

  private requiredKindStage(
    name: string,
    observations: Array<ExecutionObservationRecord | null>,
    kind: ExecutionCheckRecord["kind"],
  ): DeliveryGateStage {
    for (const observation of observations) {
      if (!observation) continue;
      const check = observation.checks.find(
        (candidate) => candidate.kind === kind && candidate.result === "PASS",
      );
      if (check) {
        return {
          name,
          status: "passed",
          detail: `${check.name} passed on ${observation.stage}`,
          observationId: observation.id,
        };
      }
    }
    return {
      name,
      status: "missing",
      detail: `missing_gate_check:${kind}`,
      observationId: null,
    };
  }

  private publicationSummary(run: RunRow): DeliveryGatePublication {
    let status;
    try {
      status = this.options.publication.getStatusByRun(run.project_id, run.id);
    } catch {
      return {
        targetId: null,
        state: null,
        auditComplete: false,
        pullRequestId: null,
        prNumber: null,
        url: null,
        headBranch: null,
        baseBranch: null,
        remoteState: null,
        draft: null,
        headRefOid: null,
        mergeCommitOid: null,
      };
    }
    const pullRequest =
      status.pullRequests.find((pr) => pr.active) ??
      (status.pullRequests.length > 0
        ? status.pullRequests[status.pullRequests.length - 1]!
        : null);
    return {
      targetId: status.target.id,
      state: status.target.state,
      auditComplete: status.auditComplete,
      pullRequestId: pullRequest?.id ?? null,
      prNumber: pullRequest?.number ?? null,
      url: pullRequest?.url ?? null,
      headBranch: pullRequest?.headBranch ?? null,
      baseBranch: pullRequest?.baseBranch ?? null,
      remoteState: pullRequest?.state === "superseded" ? "closed" : (pullRequest?.state ?? null),
      draft: pullRequest?.draft ?? null,
      headRefOid: pullRequest?.headRefOid ?? null,
      mergeCommitOid: null,
    };
  }

  private remoteDriftReasons(
    run: RunRow,
    publication: DeliveryGatePublication,
    remote: ForgePullRequest | null,
  ): string[] {
    if (!remote) return [];
    const reasons: string[] = [];
    const normalize = (value: string) =>
      value
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .toLowerCase();
    if (remote.repository && normalize(remote.repository) !== normalize(run.repo_name)) {
      reasons.push("remote_repository_mismatch");
    }
    if (remote.head !== run.branch) {
      reasons.push("remote_head_branch_mismatch");
    }
    if (remote.base !== run.target_branch) {
      reasons.push("remote_base_branch_mismatch");
    }
    if (!remote.headRefOid) {
      reasons.push("remote_head_unverified");
    } else if (run.head_sha && remote.headRefOid !== run.head_sha) {
      reasons.push("remote_head_mismatch");
    }
    if (publication.targetId && publication.headBranch && publication.headBranch !== run.branch) {
      reasons.push("publication_head_branch_mismatch");
    }
    if (
      publication.targetId &&
      publication.baseBranch &&
      publication.baseBranch !== run.target_branch
    ) {
      reasons.push("publication_base_branch_mismatch");
    }
    return reasons;
  }

  private observationStaleness(
    observation: ExecutionObservationRecord,
    run: RunRow,
    acceptance: AcceptanceDecision,
  ): string[] {
    const reasons: string[] = [];
    if (observation.gateProfileVersion !== GATE_PROFILE_VERSION) {
      reasons.push(`gate_profile_version_stale:${observation.stage}`);
    }
    if (run.head_sha && observation.candidateHeadSha !== run.head_sha) {
      reasons.push(`candidate_mismatch:${observation.stage}`);
    }
    if (observation.integrationLineage !== acceptance.integrationLineage) {
      reasons.push(`lineage_mismatch:${observation.stage}`);
    }
    if (acceptance.targetTipSha && observation.targetTipSha !== acceptance.targetTipSha) {
      reasons.push(`stale_target_tip:${observation.stage}`);
    }
    if (acceptance.mergeBaseSha && observation.mergeBaseSha !== acceptance.mergeBaseSha) {
      reasons.push(`stale_merge_base:${observation.stage}`);
    }
    return reasons;
  }

  private isStaleReason(reason: string): boolean {
    return (
      reason.startsWith("stale_target_tip") ||
      reason.startsWith("stale_merge_base") ||
      reason.startsWith("lineage_mismatch") ||
      reason.startsWith("candidate_mismatch") ||
      reason.startsWith("gate_profile_version_stale")
    );
  }

  private acceptanceCriteria(run: RunRow): string[] {
    const rows = this.db
      .prepare(
        `SELECT ac_key FROM plan_acceptance_criteria
         WHERE plan_id = ? AND work_id = ?
         ORDER BY ordinal ASC`,
      )
      .all(run.plan_id, run.work_id) as Array<{ ac_key: string }>;
    return rows.map((row) => row.ac_key);
  }

  private loadRun(projectId: string, runId: string): RunRow {
    const row = this.db
      .prepare(
        `SELECT r.id, r.project_id, r.delivery_id, r.plan_id, r.work_id, r.issue_number,
                r.gate_profile, r.merge_policy, r.target_branch, r.branch, r.head_sha,
                r.base_sha, r.state, p.checkout_path, p.repo_name, d.graph_hash
         FROM dispatch_runs r
         JOIN projects p ON p.id = r.project_id
         JOIN deliveries d ON d.id = r.delivery_id AND d.project_id = r.project_id
         WHERE r.project_id = ? AND r.id = ?`,
      )
      .get(projectId, runId) as unknown as RunRow | undefined;
    if (row) return row;
    const foreign = this.db.prepare("SELECT id FROM dispatch_runs WHERE id = ?").get(runId) as
      | { id: string }
      | undefined;
    if (foreign) {
      throw new DeliveryError(
        "delivery_forged_ownership",
        "The referenced run belongs to a different project",
        { runId, projectId },
      );
    }
    throw new DeliveryError("delivery_run_not_found", `Run ${runId} not found`);
  }

  private loadProjectRepo(projectId: string): string {
    const row = this.db.prepare("SELECT repo_name FROM projects WHERE id = ?").get(projectId) as
      | { repo_name: string }
      | undefined;
    if (!row) {
      throw new DeliveryError("delivery_project_not_found", `Project ${projectId} not found`);
    }
    return row.repo_name;
  }

  private loadVerification(
    projectId: string,
    runId: string,
    candidateHeadSha: string | null,
  ): DeliveryMergeVerification | null {
    if (!candidateHeadSha) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM delivery_merge_verifications
         WHERE project_id = ? AND run_id = ? AND candidate_head_sha = ?`,
      )
      .get(projectId, runId, candidateHeadSha) as unknown as VerificationRow | undefined;
    if (!row) return null;
    return this.mapVerification(row);
  }

  private mapVerification(row: VerificationRow): DeliveryMergeVerification {
    return deliveryMergeVerificationSchema.parse({
      id: row.id,
      projectId: row.project_id,
      deliveryId: row.delivery_id,
      planId: row.plan_id,
      workId: row.work_id,
      runId: row.run_id,
      gateProfile: row.gate_profile,
      targetId: row.target_id,
      pullRequestId: row.pull_request_id,
      repository: row.repository,
      prNumber: row.pr_number,
      sourceBranch: row.source_branch,
      targetBranch: row.target_branch,
      candidateHeadSha: row.candidate_head_sha,
      remoteHeadRefOid: row.remote_head_ref_oid,
      remoteTargetTipSha: row.remote_target_tip_sha,
      mergeCommitSha: row.merge_commit_sha,
      verifiedAt: row.verified_at,
      verifiedBy: row.verified_by,
    });
  }

  private async readRemoteCi(
    run: RunRow,
    remote: ForgePullRequest | null,
    publication: DeliveryGatePublication,
  ): Promise<RemoteCiCheck> {
    if (!publication.targetId || !publication.prNumber || !remote) {
      return {
        status: "not_applicable",
        detail: "no published remote pull request to verify yet",
        reasons: [],
      };
    }
    const readback = await readRequiredChecks(
      this.options.forge,
      run.repo_name,
      run.target_branch,
      run.head_sha,
    );
    if (readback.blockers.length === 0) {
      return {
        status: "passed",
        detail:
          readback.required.length === 0
            ? `no required remote checks configured for ${run.target_branch}`
            : `required remote checks passed for ${run.head_sha}`,
        reasons: [],
      };
    }
    const reasons = new Set<string>();
    for (const blocker of readback.blockers) {
      reasons.add(
        blocker.code === "unreadable" ? "remote_ci_unreadable" : `remote_ci_${blocker.code}`,
      );
    }
    return {
      status: "failed",
      detail: readback.blockers
        .map((blocker) =>
          blocker.name
            ? `remote_ci_${blocker.code}:${blocker.name}${
                blocker.code === "pending"
                  ? `:${blocker.status}`
                  : blocker.code === "failed"
                    ? `:${blocker.conclusion ?? "unknown"}`
                    : ""
              }`
            : `remote_ci_${blocker.code}: ${blocker.message}`,
        )
        .join(", "),
      reasons: [...reasons],
    };
  }

  private verifyRemoteMerge(
    run: RunRow,
    acceptance: AcceptanceDecision,
    remote: ForgePullRequest,
    remoteTargetTipSha: string | null,
  ): RemoteMergeProof {
    const candidate = run.head_sha;
    const testedTip = acceptance.targetTipSha;
    if (!candidate) {
      return {
        ok: false,
        mergeCommitSha: null,
        reason: "candidate_missing",
        detail: "the run has no recorded candidate head",
      };
    }
    if (!remoteTargetTipSha) {
      return {
        ok: false,
        mergeCommitSha: null,
        reason: "remote_target_unavailable",
        detail: "the remote target tip is unreadable",
      };
    }
    if (!testedTip) {
      return {
        ok: false,
        mergeCommitSha: null,
        reason: "stale_target_tip",
        detail: "the acceptance observation has no tested target tip",
      };
    }
    if (!this.isAncestor(run, candidate, remoteTargetTipSha)) {
      return {
        ok: false,
        mergeCommitSha: null,
        reason: "target_lineage_not_verified",
        detail: `candidate ${candidate} is not in remote ${run.target_branch} ${remoteTargetTipSha}`,
      };
    }

    const reported = remote.mergeCommitOid ?? null;
    if (
      reported &&
      this.commitExists(run, reported) &&
      this.isAncestor(run, reported, remoteTargetTipSha)
    ) {
      const parents = this.commitParents(run, reported);
      const [firstParent, secondParent] = parents;
      if (firstParent !== testedTip) {
        return {
          ok: false,
          mergeCommitSha: null,
          reason: "merge_base_mismatch",
          detail: `merge commit ${reported} first parent ${firstParent ?? "(none)"} is not the tested target tip ${testedTip}`,
        };
      }
      if (secondParent !== candidate) {
        return {
          ok: false,
          mergeCommitSha: null,
          reason: "merge_candidate_mismatch",
          detail: `merge commit ${reported} second parent ${secondParent ?? "(none)"} is not the candidate ${candidate}`,
        };
      }
      return {
        ok: true,
        mergeCommitSha: reported,
        detail: `merge commit ${reported} is on remote ${run.target_branch} ${remoteTargetTipSha} and merged candidate ${candidate} onto tested tip ${testedTip}`,
      };
    }

    // Fast-forward: the candidate itself is the remote target tip. There is no
    // merge commit to store, but its first parent must be the tested target tip.
    if (remoteTargetTipSha === candidate) {
      const parents = this.commitParents(run, candidate);
      const firstParent = parents[0];
      if (firstParent !== testedTip) {
        return {
          ok: false,
          mergeCommitSha: null,
          reason: "merge_base_mismatch",
          detail: `fast-forward candidate parent ${firstParent ?? "(none)"} is not the tested target tip ${testedTip}`,
        };
      }
      return {
        ok: true,
        mergeCommitSha: null,
        detail: `candidate ${candidate} fast-forwarded onto tested target tip ${testedTip}`,
      };
    }

    return {
      ok: false,
      mergeCommitSha: null,
      reason: "merge_commit_unverified",
      detail: reported
        ? `reported merge commit ${reported} is not a verified commit on remote ${run.target_branch} ${remoteTargetTipSha}`
        : `remote ${run.target_branch} advanced to ${remoteTargetTipSha} without a verifiable merge commit`,
    };
  }

  private commitExists(run: RunRow, sha: string): boolean {
    try {
      this.gitRunner(["cat-file", "-e", `${sha}^{commit}`], run.checkout_path);
      return true;
    } catch {
      return false;
    }
  }

  private commitParents(run: RunRow, sha: string): string[] {
    const line = this.gitRunner(
      ["rev-list", "--parents", "-n", "1", sha],
      run.checkout_path,
    ).trim();
    const parts = line.split(/\s+/).filter(Boolean);
    return parts.slice(1);
  }

  private async fetchRemoteTargetTip(run: RunRow): Promise<string | null> {
    const verifyRef = `refs/animus/delivery-verify/${randomUUID()}`;
    try {
      const fetched = await this.gitRemote(
        ["fetch", "--no-tags", "origin", `+refs/heads/${run.target_branch}:${verifyRef}`],
        run.checkout_path,
      );
      if (fetched.timedOut || fetched.exitCode !== 0) return null;
      return this.gitRunner(["rev-parse", verifyRef], run.checkout_path);
    } catch {
      return null;
    } finally {
      try {
        this.gitRunner(["update-ref", "-d", verifyRef], run.checkout_path);
      } catch {}
    }
  }

  private isAncestor(run: RunRow, candidate: string, targetTip: string): boolean {
    try {
      this.gitRunner(["merge-base", "--is-ancestor", candidate, targetTip], run.checkout_path);
      return true;
    } catch {
      return false;
    }
  }
}
