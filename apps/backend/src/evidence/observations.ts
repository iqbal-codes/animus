import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  GATE_PROFILE_VERSION,
  acceptanceDecisionSchema,
  executionObservationRecordSchema,
  executionObservationSubmissionSchema,
  factoryFindingRecordSchema,
  findingRecheckSubmissionSchema,
  type AcceptanceDecision,
  type ArtifactOwnerType,
  type ArtifactSubmission,
  type ExecutionArtifactRecord,
  type ExecutionCheckRecord,
  type ExecutionObservationRecord,
  type ExecutionObservationStatus,
  type ExecutionObservationSubmission,
  type ExecutionObservationSubmissionInput,
  type ExecutionStage,
  type FactoryFindingRecord,
  type FindingEventAction,
  type FindingEventRecord,
  type FindingFixSubmission,
  type FindingRecheckSubmissionInput,
  type PlanGateProfile,
  type ProducerIdentity,
  type ProducerRole,
} from "@animus/contracts/operator";
import { resolveAnimusStateDir } from "@animus/contracts/paths";
import { EvidenceError } from "./errors";

interface RunRow {
  id: string;
  project_id: string;
  delivery_id: string;
  work_id: string;
  issue_number: number;
  gate_profile: PlanGateProfile;
  target_branch: string;
  ownership_generation: number;
  state: string;
  actor: string;
  base_sha: string;
  head_sha: string | null;
  delivery_graph_hash: string;
  checkout_path: string;
}

interface ObservationRow {
  id: string;
  project_id: string;
  delivery_id: string;
  run_id: string;
  lap: number;
  stage: ExecutionStage;
  status: ExecutionObservationStatus;
  candidate_head_sha: string;
  target_tip_sha: string;
  merge_base_sha: string;
  tested_identity: string;
  integration_lineage: string;
  producer_id: string;
  producer_role: ProducerRole;
  producer_name: string | null;
  gate_profile: PlanGateProfile;
  gate_profile_version: number;
  error: string | null;
  created_at: number;
}

interface CheckRow {
  id: string;
  observation_id: string;
  name: string;
  command: string;
  result: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  duration_ms: number | null;
  detail: string | null;
  artifact_path: string | null;
  created_at: number;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  observation_id: string;
  owner_type: ArtifactOwnerType;
  owner_id: string;
  name: string;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  digest_sha256: string;
  created_at: number;
}

interface FindingRow {
  id: string;
  project_id: string;
  delivery_id: string;
  run_id: string;
  work_id: string | null;
  issue_number: number;
  ac_key: string | null;
  severity: "blocking" | "conditional";
  file_context: string;
  summary: string;
  origin_observation_id: string;
  status: "open" | "resolved";
  created_at: number;
  resolved_at: number | null;
}

interface FindingEventRow {
  id: string;
  finding_id: string;
  sequence: number;
  action: FindingEventAction;
  actor: string;
  actor_role: ProducerRole;
  observation_id: string | null;
  detail: string | null;
  created_at: number;
}

const STAGE_PRODUCER_ROLES: Record<ExecutionStage, readonly ProducerRole[]> = {
  builder_execution: ["builder"],
  technical_checks: ["automated_gate", "independent_evaluator", "peer_reviewer"],
  independent_review: ["peer_reviewer", "independent_evaluator"],
  final_acceptance: ["independent_evaluator"],
};

const REQUIRED_INDEPENDENT_STAGE: Record<PlanGateProfile, ExecutionStage> = {
  child: "technical_checks",
  standalone: "independent_review",
  final: "final_acceptance",
};

export interface ExecutionObservationServiceOptions {
  /** Root holding project-scoped finalized artifacts. Defaults to `<animus state>/artifacts`. */
  artifactRoot?: string;
  clock?: () => number;
  gitRunner?: (cmd: string[], cwd: string) => string;
}

export interface ObservationQuery {
  runId?: string;
  deliveryId?: string;
  candidateHeadSha?: string;
  workId?: string;
}

export interface FindingQuery {
  runId?: string;
  deliveryId?: string;
  workId?: string;
  status?: "open" | "resolved";
}

export interface RunEvidence {
  observations: ExecutionObservationRecord[];
  findings: FactoryFindingRecord[];
  acceptance: AcceptanceDecision;
}

/**
 * Candidate-bound evidence: immutable stage observations, individual checks,
 * findings with an append-only lifecycle, and finalized artifact references.
 *
 * Ownership is never trusted from the caller: the run, delivery, candidate,
 * target tip, merge base, lineage and gate profile are all read from durable
 * dispatch state and re-verified against the repository at acceptance time.
 */
export class ExecutionObservationService {
  private readonly artifactRoot: string;
  private readonly clock: () => number;
  private readonly gitRunner: (cmd: string[], cwd: string) => string;

  constructor(
    private readonly db: DatabaseSync,
    options: ExecutionObservationServiceOptions = {},
  ) {
    this.artifactRoot = options.artifactRoot ?? join(resolveAnimusStateDir(), "artifacts");
    this.clock = options.clock ?? (() => Date.now());
    this.gitRunner =
      options.gitRunner ??
      ((cmd, cwd) =>
        execFileSync("git", cmd, {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim());
  }

  // -------------------------------------------------------------------------
  // Observation writes
  // -------------------------------------------------------------------------

  recordRunObservation(
    projectId: string,
    runId: string,
    submission: ExecutionObservationSubmissionInput,
    options: { findingOwnerId?: string } = {},
  ): ExecutionObservationRecord {
    const record = executionObservationSubmissionSchema.parse(submission);
    const run = this.loadRun(projectId, runId);
    if (record.stage !== "builder_execution" && run.state !== "succeeded") {
      throw new EvidenceError(
        "stale_candidate_evidence",
        "External stage observations require a succeeded candidate run",
        { runId, state: run.state },
      );
    }
    this.assertProducerAllowed(run, record.stage, record.producer);
    this.assertObservationCoherent(record);

    const candidateHeadSha = run.head_sha ?? run.base_sha;
    const lineage = this.lineage(run.delivery_graph_hash, run.target_branch);
    const now = this.clock();

    return this.withSavepoint(() => {
      const observationId = `obs_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO execution_observations
             (id, project_id, delivery_id, run_id, lap, stage, status, candidate_head_sha,
              target_tip_sha, merge_base_sha, tested_identity, integration_lineage, producer_id,
              producer_role, producer_name, gate_profile, gate_profile_version, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          observationId,
          projectId,
          run.delivery_id,
          run.id,
          run.ownership_generation,
          record.stage,
          record.status,
          candidateHeadSha,
          run.base_sha,
          run.base_sha,
          candidateHeadSha,
          lineage,
          record.producer.id,
          record.producer.role,
          record.producer.name ?? null,
          run.gate_profile,
          GATE_PROFILE_VERSION,
          record.stage === "builder_execution"
            ? (record.checks.find((check) => check.result !== "PASS")?.detail ?? null)
            : null,
          now,
        );

      const checkPaths = new Set<string>();
      for (const check of record.checks) {
        this.db
          .prepare(
            `INSERT INTO execution_checks
               (id, observation_id, project_id, name, command, result, duration_ms, detail,
                artifact_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `chk_${randomUUID()}`,
            observationId,
            projectId,
            check.name,
            check.command,
            check.result,
            check.durationMs ?? null,
            check.detail ?? null,
            check.artifactPath === undefined
              ? null
              : this.normalizeArtifactPath(check.artifactPath),
            now,
          );
        if (check.artifactPath !== undefined) {
          checkPaths.add(this.normalizeArtifactPath(check.artifactPath));
        }
      }

      const findingIds: string[] = [];
      for (const finding of record.findings) {
        const findingId = `find_${randomUUID()}`;
        findingIds.push(findingId);
        this.db
          .prepare(
            `INSERT INTO factory_findings
               (id, project_id, delivery_id, run_id, work_id, issue_number, ac_key, severity,
                file_context, summary, origin_observation_id, status, created_at, resolved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
          )
          .run(
            findingId,
            projectId,
            run.delivery_id,
            run.id,
            finding.workId ?? run.work_id,
            run.issue_number,
            finding.acKey ?? null,
            finding.severity,
            finding.fileContext,
            finding.summary,
            observationId,
            now,
          );
        this.insertFindingEvent({
          findingId,
          projectId,
          sequence: 1,
          action: "opened",
          actor: record.producer.id,
          actorRole: record.producer.role,
          observationId,
          detail: null,
          createdAt: now,
        });
      }

      for (const artifact of record.artifacts) {
        this.insertArtifact({
          projectId,
          observationId,
          submission: artifact,
          findingIds,
          findingOwnerId: options.findingOwnerId,
          createdAt: now,
        });
      }

      for (const path of checkPaths) {
        const present = this.db
          .prepare(
            `SELECT 1 AS present FROM execution_artifacts
             WHERE observation_id = ? AND owner_type = 'observation' AND relative_path = ?`,
          )
          .get(observationId, path);
        if (!present) {
          throw new EvidenceError(
            "artifact_not_found",
            `Check artifact '${path}' was not finalized with the observation`,
            { observationId, relativePath: path },
          );
        }
      }

      return this.getObservation(projectId, observationId);
    }, "observation");
  }

  // -------------------------------------------------------------------------
  // Finding lifecycle
  // -------------------------------------------------------------------------

  recordFindingFix(
    projectId: string,
    findingId: string,
    submission: FindingFixSubmission,
  ): FactoryFindingRecord {
    const finding = this.loadFinding(projectId, findingId);
    if (finding.status === "resolved") {
      throw new EvidenceError(
        "finding_not_found",
        `Finding ${findingId} is already resolved; a fix submission cannot reopen resolved history`,
      );
    }
    return this.withSavepoint(() => {
      const sequence = this.nextFindingSequence(finding.id);
      const runActor = this.runActor(projectId, finding.run_id);
      this.insertFindingEvent({
        findingId: finding.id,
        projectId,
        sequence,
        action: "fix_submitted",
        actor: submission.actor,
        actorRole: submission.actor === runActor ? "builder" : "independent_evaluator",
        observationId: null,
        detail: submission.detail ?? null,
        createdAt: this.clock(),
      });
      // A builder (or anyone) claiming a fix must not resolve the finding.
      return this.getFinding(projectId, finding.id);
    }, "fix");
  }

  recordFindingRecheck(
    projectId: string,
    findingId: string,
    submission: FindingRecheckSubmissionInput,
  ): FactoryFindingRecord {
    const record = findingRecheckSubmissionSchema.parse(submission);
    const finding = this.loadFinding(projectId, findingId);
    const runId = record.runId ?? finding.run_id;
    const run = this.loadRun(projectId, runId);
    if (run.delivery_id !== finding.delivery_id) {
      throw new EvidenceError(
        "forged_ownership",
        "A recheck must observe a run that belongs to the finding's delivery",
        { findingId, runId, deliveryId: run.delivery_id, expectedDeliveryId: finding.delivery_id },
      );
    }
    this.assertProducerAllowed(run, record.stage ?? "independent_review", record.producer);

    return this.withSavepoint(() => {
      const observation = this.recordRunObservation(
        projectId,
        run.id,
        {
          stage: record.stage ?? "independent_review",
          status: record.status,
          producer: record.producer,
          checks: record.checks,
          artifacts: record.artifacts,
        },
        { findingOwnerId: finding.id },
      );
      const now = this.clock();
      const action: FindingEventAction =
        record.status === "passed"
          ? "recheck_passed"
          : record.status === "failed"
            ? "recheck_failed"
            : "recheck_inconclusive";
      this.insertFindingEvent({
        findingId: finding.id,
        projectId,
        sequence: this.nextFindingSequence(finding.id),
        action,
        actor: record.producer.id,
        actorRole: record.producer.role,
        observationId: observation.id,
        detail: record.detail ?? null,
        createdAt: now,
      });
      if (record.status === "passed") {
        this.db
          .prepare(`UPDATE factory_findings SET status = 'resolved', resolved_at = ? WHERE id = ?`)
          .run(now, finding.id);
      } else {
        // Failed or inconclusive rechecks preserve/reopen the finding and its history.
        this.db
          .prepare(`UPDATE factory_findings SET status = 'open', resolved_at = NULL WHERE id = ?`)
          .run(finding.id);
      }
      return this.getFinding(projectId, finding.id);
    }, "recheck");
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  listObservations(projectId: string, query: ObservationQuery = {}): ExecutionObservationRecord[] {
    const clauses = ["o.project_id = ?"];
    const params: unknown[] = [projectId];
    if (query.runId) {
      clauses.push("o.run_id = ?");
      params.push(query.runId);
    }
    if (query.deliveryId) {
      clauses.push("o.delivery_id = ?");
      params.push(query.deliveryId);
    }
    if (query.candidateHeadSha) {
      clauses.push("o.candidate_head_sha = ?");
      params.push(query.candidateHeadSha);
    }
    if (query.workId) {
      clauses.push("r.work_id = ?");
      params.push(query.workId);
    }
    const rows = this.db
      .prepare(
        `SELECT o.* FROM execution_observations o
         JOIN dispatch_runs r ON r.id = o.run_id AND r.project_id = o.project_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY o.created_at ASC, o.id ASC`,
      )
      .all(...(params as never[])) as unknown as ObservationRow[];
    return rows.map((row) => this.mapObservation(row));
  }

  getObservation(projectId: string, observationId: string): ExecutionObservationRecord {
    const row = this.db
      .prepare("SELECT * FROM execution_observations WHERE project_id = ? AND id = ?")
      .get(projectId, observationId) as unknown as ObservationRow | undefined;
    if (!row) {
      throw new EvidenceError("observation_not_found", `Observation ${observationId} not found`);
    }
    return this.mapObservation(row);
  }

  listFindings(projectId: string, query: FindingQuery = {}): FactoryFindingRecord[] {
    const clauses = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (query.runId) {
      clauses.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.deliveryId) {
      clauses.push("delivery_id = ?");
      params.push(query.deliveryId);
    }
    if (query.workId) {
      clauses.push("work_id = ?");
      params.push(query.workId);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM factory_findings WHERE ${clauses.join(" AND ")}
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...(params as never[])) as unknown as FindingRow[];
    return rows.map((row) => this.mapFinding(row));
  }

  getFinding(projectId: string, findingId: string): FactoryFindingRecord {
    return this.mapFinding(this.loadFinding(projectId, findingId));
  }

  private loadFinding(projectId: string, findingId: string): FindingRow {
    const row = this.db
      .prepare("SELECT * FROM factory_findings WHERE project_id = ? AND id = ?")
      .get(projectId, findingId) as unknown as FindingRow | undefined;
    if (row) return row;
    const foreign = this.db
      .prepare("SELECT id FROM factory_findings WHERE id = ?")
      .get(findingId) as { id: string } | undefined;
    if (foreign) {
      throw new EvidenceError(
        "forged_ownership",
        "The referenced finding belongs to a different project",
        { findingId, projectId },
      );
    }
    throw new EvidenceError("finding_not_found", `Finding ${findingId} not found`);
  }

  getRunEvidence(projectId: string, runId: string): RunEvidence {
    const run = this.loadRun(projectId, runId);
    return {
      observations: this.listObservations(projectId, { runId }),
      // Findings belong to the delivery and persist across laps, so a later run's
      // detail must still show defects opened by an earlier candidate.
      findings: this.listFindings(projectId, { deliveryId: run.delivery_id }),
      acceptance: this.evaluateAcceptance(projectId, runId),
    };
  }

  // -------------------------------------------------------------------------
  // Acceptance
  // -------------------------------------------------------------------------

  evaluateAcceptance(projectId: string, runId: string): AcceptanceDecision {
    const run = this.loadRun(projectId, runId);
    const reasons: string[] = [];
    const lineage = this.lineage(run.delivery_graph_hash, run.target_branch);
    const candidateHeadSha = run.head_sha;

    const openBlocking = this.db
      .prepare(
        `SELECT id FROM factory_findings
         WHERE project_id = ? AND delivery_id = ? AND status = 'open' AND severity = 'blocking'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId, run.delivery_id) as Array<{ id: string }>;
    const openBlockingFindingIds = openBlocking.map((row) => row.id);
    if (openBlockingFindingIds.length > 0) {
      reasons.push("open_blocking_findings");
    }

    if (run.state !== "succeeded") {
      reasons.push("run_not_succeeded");
    }

    const builderObservation = this.latestPassed(projectId, run.id, "builder_execution", null);
    if (!builderObservation) {
      reasons.push("builder_result_missing");
    }

    const builderIdentity = builderObservation?.producer.id ?? null;
    const requiredStage = REQUIRED_INDEPENDENT_STAGE[run.gate_profile];
    const independentObservation = this.latestPassed(
      projectId,
      run.id,
      requiredStage,
      builderIdentity,
    );
    if (!independentObservation) {
      reasons.push(`required_stage_missing:${requiredStage}`);
    }

    const targetTipSha = this.currentTargetTip(run, reasons);
    const mergeBaseSha =
      candidateHeadSha && targetTipSha
        ? this.currentMergeBase(run, candidateHeadSha, targetTipSha, reasons)
        : null;

    if (!candidateHeadSha) {
      reasons.push("candidate_missing");
    } else if (!this.commitExists(run, candidateHeadSha)) {
      reasons.push("candidate_missing");
    }

    for (const observation of [builderObservation, independentObservation]) {
      if (!observation) continue;
      if (observation.gateProfileVersion !== GATE_PROFILE_VERSION) {
        reasons.push("gate_profile_version_stale");
      }
      if (observation.integrationLineage !== lineage) {
        reasons.push("lineage_mismatch");
      }
      if (observation.candidateHeadSha !== candidateHeadSha) {
        reasons.push("candidate_mismatch");
      }
      if (targetTipSha && observation.targetTipSha !== targetTipSha) {
        reasons.push("stale_target_tip");
      }
      if (mergeBaseSha && observation.mergeBaseSha !== mergeBaseSha) {
        reasons.push("stale_merge_base");
      }
    }

    const verifiedArtifactIds: string[] = [];
    for (const observation of [builderObservation, independentObservation]) {
      if (!observation) continue;
      for (const artifact of observation.artifacts) {
        const outcome = this.verifyArtifact(projectId, artifact);
        if (outcome === null) {
          verifiedArtifactIds.push(artifact.id);
        } else {
          reasons.push(outcome);
        }
      }
      for (const check of observation.checks) {
        if (!check.artifactPath) continue;
        const present = observation.artifacts.some(
          (artifact) =>
            artifact.ownerType === "observation" && artifact.relativePath === check.artifactPath,
        );
        if (!present) {
          reasons.push(`artifact_missing:${check.artifactPath}`);
        }
      }
    }

    return acceptanceDecisionSchema.parse({
      runId: run.id,
      projectId,
      deliveryId: run.delivery_id,
      gateProfile: run.gate_profile,
      candidateHeadSha,
      targetTipSha,
      mergeBaseSha,
      integrationLineage: lineage,
      authorized: reasons.length === 0,
      reasons: [...new Set(reasons)],
      builderObservationId: builderObservation?.id ?? null,
      independentObservationId: independentObservation?.id ?? null,
      openBlockingFindingIds,
      verifiedArtifactIds,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private loadRun(projectId: string, runId: string): RunRow {
    const row = this.db
      .prepare(
        `SELECT r.id, r.project_id, r.delivery_id, r.work_id, r.issue_number, r.gate_profile,
                r.target_branch, r.ownership_generation, r.state, r.actor, r.base_sha, r.head_sha,
                d.graph_hash AS delivery_graph_hash, p.checkout_path AS checkout_path
         FROM dispatch_runs r
         JOIN deliveries d ON d.id = r.delivery_id AND d.project_id = r.project_id
         JOIN projects p ON p.id = r.project_id
         WHERE r.project_id = ? AND r.id = ?`,
      )
      .get(projectId, runId) as unknown as RunRow | undefined;
    if (row) return row;
    const foreign = this.db.prepare("SELECT id FROM dispatch_runs WHERE id = ?").get(runId) as
      | { id: string }
      | undefined;
    if (foreign) {
      throw new EvidenceError(
        "forged_ownership",
        "The referenced run belongs to a different project",
        { runId, projectId },
      );
    }
    throw new EvidenceError("run_not_found", `Run ${runId} not found`);
  }

  private assertProducerAllowed(
    run: RunRow,
    stage: ExecutionStage,
    producer: ProducerIdentity,
  ): void {
    if (!STAGE_PRODUCER_ROLES[stage].includes(producer.role)) {
      throw new EvidenceError(
        "invalid_stage_producer",
        `Producer role '${producer.role}' is not authorized for stage '${stage}'`,
        { stage, role: producer.role },
      );
    }
    if (stage === "builder_execution") return;
    const builderIdentities = this.builderIdentities(run.delivery_id);
    if (builderIdentities.has(producer.id)) {
      throw new EvidenceError(
        "self_certification_rejected",
        "A builder identity cannot certify its own independent stage result",
        { stage, producerId: producer.id },
      );
    }
  }

  private assertObservationCoherent(submission: ExecutionObservationSubmission): void {
    if (submission.status === "passed" && submission.checks.length === 0) {
      throw new EvidenceError(
        "verification_failed",
        "A passed observation requires at least one contract check",
      );
    }
    if (submission.status === "passed") {
      const failed = submission.checks.filter((check) => check.result !== "PASS");
      if (failed.length > 0) {
        throw new EvidenceError(
          "verification_failed",
          `A passed observation cannot contain ${failed.length} non-passing check(s)`,
          { checks: failed.map((check) => check.name) },
        );
      }
    }
  }

  private builderIdentities(deliveryId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT producer_id FROM execution_observations
         WHERE delivery_id = ? AND stage = 'builder_execution'`,
      )
      .all(deliveryId) as Array<{ producer_id: string }>;
    return new Set(rows.map((row) => row.producer_id));
  }

  private runActor(projectId: string, runId: string): string {
    const row = this.db
      .prepare("SELECT actor FROM dispatch_runs WHERE project_id = ? AND id = ?")
      .get(projectId, runId) as { actor: string } | undefined;
    return row?.actor ?? "builder";
  }

  private latestPassed(
    projectId: string,
    runId: string,
    stage: ExecutionStage,
    builderIdentity: string | null,
  ): ExecutionObservationRecord | null {
    if (stage === "builder_execution") {
      const rows = this.db
        .prepare(
          `SELECT * FROM execution_observations
           WHERE project_id = ? AND run_id = ? AND stage = 'builder_execution' AND status = 'passed'
           ORDER BY created_at DESC, id DESC`,
        )
        .all(projectId, runId) as unknown as ObservationRow[];
      return rows.length > 0 ? this.mapObservation(rows[0]!) : null;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_observations
         WHERE project_id = ? AND run_id = ? AND stage = ? AND status = 'passed'
           AND producer_role != 'builder'
         ORDER BY created_at DESC, id DESC`,
      )
      .all(projectId, runId, stage) as unknown as ObservationRow[];
    const row = rows.find((candidate) => candidate.producer_id !== builderIdentity);
    return row ? this.mapObservation(row) : null;
  }

  private currentTargetTip(run: RunRow, reasons: string[]): string | null {
    try {
      return this.gitRunner(["rev-parse", run.target_branch], run.checkout_path);
    } catch {
      reasons.push("target_unresolvable");
      return null;
    }
  }

  private currentMergeBase(
    run: RunRow,
    candidateHeadSha: string,
    targetTipSha: string,
    reasons: string[],
  ): string | null {
    try {
      return this.gitRunner(["merge-base", candidateHeadSha, targetTipSha], run.checkout_path);
    } catch {
      reasons.push("merge_base_unresolvable");
      return null;
    }
  }

  private commitExists(run: RunRow, sha: string): boolean {
    try {
      this.gitRunner(["cat-file", "-e", `${sha}^{commit}`], run.checkout_path);
      return true;
    } catch {
      return false;
    }
  }

  private lineage(graphHash: string, targetBranch: string): string {
    return `${graphHash}@${targetBranch}`;
  }

  private insertFindingEvent(input: {
    findingId: string;
    projectId: string;
    sequence: number;
    action: FindingEventAction;
    actor: string;
    actorRole: ProducerRole;
    observationId: string | null;
    detail: string | null;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO factory_finding_events
           (id, finding_id, project_id, sequence, action, actor, actor_role, observation_id,
            detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `evt_${randomUUID()}`,
        input.findingId,
        input.projectId,
        input.sequence,
        input.action,
        input.actor,
        input.actorRole,
        input.observationId,
        input.detail,
        input.createdAt,
      );
  }

  private nextFindingSequence(findingId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM factory_finding_events WHERE finding_id = ?",
      )
      .get(findingId) as { sequence: number };
    return row.sequence + 1;
  }

  private insertArtifact(input: {
    projectId: string;
    observationId: string;
    submission: ArtifactSubmission;
    findingIds: string[];
    findingOwnerId?: string;
    createdAt: number;
  }): void {
    const { projectId, observationId, submission } = input;
    let ownerId = observationId;
    if (submission.ownerType === "finding") {
      const index = submission.ownerFindingIndex;
      if (index === undefined && input.findingOwnerId) {
        ownerId = input.findingOwnerId;
      } else {
        if (index === undefined || !Number.isInteger(index) || index < 0) {
          throw new EvidenceError(
            "forged_ownership",
            "A finding-owned artifact must reference a finding in the same observation",
          );
        }
        const findingId = input.findingIds[index];
        if (!findingId) {
          throw new EvidenceError(
            "forged_ownership",
            `Artifact references finding index ${index}, which is not part of this observation`,
          );
        }
        ownerId = findingId;
      }
    } else if (submission.ownerFindingIndex !== undefined) {
      throw new EvidenceError(
        "forged_ownership",
        "Observation-owned artifacts cannot carry a finding index",
      );
    }
    const relativePath = this.normalizeArtifactPath(submission.relativePath);
    const finalized = this.finalizeArtifactFile(projectId, relativePath);
    this.db
      .prepare(
        `INSERT INTO execution_artifacts
           (id, project_id, observation_id, owner_type, owner_id, name, relative_path,
            media_type, size_bytes, digest_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `art_${randomUUID()}`,
        projectId,
        observationId,
        submission.ownerType,
        ownerId,
        submission.name,
        relativePath,
        submission.mediaType,
        finalized.sizeBytes,
        finalized.digestSha256,
        input.createdAt,
      );
  }

  private normalizeArtifactPath(relativePath: string): string {
    const candidate = relativePath.trim();
    if (
      candidate === "" ||
      isAbsolute(candidate) ||
      candidate.includes("\\") ||
      candidate.includes("\0")
    ) {
      throw new EvidenceError(
        "artifact_unsafe_path",
        `Artifact path must be a normalized project-relative path: ${relativePath}`,
      );
    }
    const normalized = posix.normalize(candidate).replace(/^\.\//, "");
    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.split("/").some((segment) => segment === "..")
    ) {
      throw new EvidenceError(
        "artifact_unsafe_path",
        `Artifact path escapes the project artifact root: ${relativePath}`,
      );
    }
    return normalized;
  }

  private artifactRootFor(projectId: string): string {
    return join(this.artifactRoot, projectId);
  }

  private resolveArtifactAbsolute(projectId: string, relativePath: string): string {
    const root = resolve(this.artifactRootFor(projectId));
    const absolute = resolve(root, relativePath);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new EvidenceError(
        "artifact_unsafe_path",
        `Artifact path escapes the project artifact root: ${relativePath}`,
      );
    }
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      throw new EvidenceError(
        "artifact_not_found",
        `Required artifact is missing: ${relativePath}`,
        { relativePath },
      );
    }
    // Only regular files are finalized proof: live streams, sockets, directories
    // and symlinks are never accepted as a complete public artifact.
    if (!stats.isFile()) {
      throw new EvidenceError(
        "artifact_corrupt",
        `Artifact is not a regular finalized file: ${relativePath}`,
        { relativePath },
      );
    }
    const realRoot = realpathSync(root);
    const realFile = realpathSync(absolute);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
      throw new EvidenceError(
        "artifact_unsafe_path",
        `Artifact resolves outside the project artifact root: ${relativePath}`,
        { relativePath },
      );
    }
    return absolute;
  }

  private finalizeArtifactFile(
    projectId: string,
    relativePath: string,
  ): { sizeBytes: number; digestSha256: string } {
    const absolute = this.resolveArtifactAbsolute(projectId, relativePath);
    const bytes = readFileSync(absolute);
    return {
      sizeBytes: bytes.byteLength,
      digestSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  /** Re-verifies a finalized artifact on disk. Returns null when intact, else a blocker. */
  private verifyArtifact(projectId: string, artifact: ExecutionArtifactRecord): string | null {
    try {
      const absolute = this.resolveArtifactAbsolute(projectId, artifact.relativePath);
      const bytes = readFileSync(absolute);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== artifact.sizeBytes) {
        return `artifact_size_mismatch:${artifact.relativePath}`;
      }
      if (digest !== artifact.digestSha256) {
        return `artifact_digest_mismatch:${artifact.relativePath}`;
      }
      return null;
    } catch (error) {
      if (error instanceof EvidenceError) {
        return error.code === "artifact_not_found"
          ? `artifact_missing:${artifact.relativePath}`
          : `artifact_corrupt:${artifact.relativePath}`;
      }
      return `artifact_unreadable:${artifact.relativePath}`;
    }
  }

  private withSavepoint<T>(work: () => T, label: string): T {
    const name = `sp_${label}_${randomUUID().replace(/-/g, "")}`;
    this.db.exec(`SAVEPOINT ${name};`);
    try {
      const result = work();
      this.db.exec(`RELEASE ${name};`);
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO ${name};`);
        this.db.exec(`RELEASE ${name};`);
      } catch {}
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError(
        "invalid_payload",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private mapObservation(row: ObservationRow): ExecutionObservationRecord {
    const checks = this.db
      .prepare("SELECT * FROM execution_checks WHERE observation_id = ? ORDER BY rowid ASC")
      .all(row.id) as unknown as CheckRow[];
    const artifacts = this.db
      .prepare("SELECT * FROM execution_artifacts WHERE observation_id = ? ORDER BY rowid ASC")
      .all(row.id) as unknown as ArtifactRow[];
    return executionObservationRecordSchema.parse({
      id: row.id,
      projectId: row.project_id,
      deliveryId: row.delivery_id,
      runId: row.run_id,
      lap: row.lap,
      stage: row.stage,
      status: row.status,
      candidateHeadSha: row.candidate_head_sha,
      targetTipSha: row.target_tip_sha,
      mergeBaseSha: row.merge_base_sha,
      testedIdentity: row.tested_identity,
      integrationLineage: row.integration_lineage,
      producer: {
        id: row.producer_id,
        role: row.producer_role,
        ...(row.producer_name ? { name: row.producer_name } : {}),
      },
      gateProfile: row.gate_profile,
      gateProfileVersion: row.gate_profile_version,
      error: row.error,
      createdAt: row.created_at,
      checks: checks.map((check): ExecutionCheckRecord => ({
        id: check.id,
        observationId: check.observation_id,
        name: check.name,
        command: check.command,
        result: check.result,
        durationMs: check.duration_ms,
        detail: check.detail,
        artifactPath: check.artifact_path,
        createdAt: check.created_at,
      })),
      artifacts: artifacts.map((artifact): ExecutionArtifactRecord => ({
        id: artifact.id,
        projectId: artifact.project_id,
        observationId: artifact.observation_id,
        ownerType: artifact.owner_type,
        ownerId: artifact.owner_id,
        name: artifact.name,
        relativePath: artifact.relative_path,
        mediaType: artifact.media_type,
        sizeBytes: artifact.size_bytes,
        digestSha256: artifact.digest_sha256,
        createdAt: artifact.created_at,
      })),
    });
  }

  private mapFinding(row: FindingRow): FactoryFindingRecord {
    const events = this.db
      .prepare("SELECT * FROM factory_finding_events WHERE finding_id = ? ORDER BY sequence ASC")
      .all(row.id) as unknown as FindingEventRow[];
    return factoryFindingRecordSchema.parse({
      id: row.id,
      projectId: row.project_id,
      deliveryId: row.delivery_id,
      runId: row.run_id,
      workId: row.work_id,
      issueNumber: row.issue_number,
      acKey: row.ac_key,
      severity: row.severity,
      fileContext: row.file_context,
      summary: row.summary,
      originObservationId: row.origin_observation_id,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      events: events.map((event): FindingEventRecord => ({
        id: event.id,
        findingId: event.finding_id,
        sequence: event.sequence,
        action: event.action,
        actor: event.actor,
        actorRole: event.actor_role,
        observationId: event.observation_id,
        detail: event.detail,
        createdAt: event.created_at,
      })),
    });
  }
}
