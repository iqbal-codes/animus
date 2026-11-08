import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  PlanGateProfile,
  PublicationEventKind,
  PublicationEventSeverity,
} from "@animus/contracts/operator";

export interface PublicationTargetSeed {
  projectId: string;
  deliveryId: string;
  planId: string;
  workId: string;
  issueNumber: number;
  gateProfile: PlanGateProfile;
  sourceBranch: string;
  targetBranch: string;
  candidateHeadSha: string;
  baseSha: string;
  /** A draft PR may only be created when the run produced a real committed change. */
  eligible: boolean;
}

export interface PublicationEventInput {
  targetId: string;
  projectId: string;
  workId: string;
  runId: string | null;
  lap: number | null;
  candidateHeadSha: string;
  observationId: string | null;
  findingId: string | null;
  kind: PublicationEventKind;
  severity: PublicationEventSeverity;
  title: string;
  body: string;
  occurredAt: number;
}

interface TargetRow {
  id: string;
  state: string;
  candidate_head_sha: string;
  source_branch: string;
  base_sha: string;
}

/**
 * Insert or refresh the durable publication target for one executable ticket.
 *
 * Called by the execution/evidence domain writers inside their own transaction so a
 * candidate, its audit queue and the run cannot diverge. It never starts a transaction
 * itself.
 */
export function ensurePublicationTarget(
  db: DatabaseSync,
  seed: PublicationTargetSeed,
  now = Date.now(),
): string {
  const existing = db
    .prepare(
      `SELECT id, state, candidate_head_sha, source_branch, base_sha
         FROM publication_targets
        WHERE project_id = ? AND delivery_id = ? AND work_id = ?`,
    )
    .get(seed.projectId, seed.deliveryId, seed.workId) as unknown as TargetRow | undefined;

  if (!existing) {
    const targetId = `pub_${randomUUID()}`;
    db.prepare(
      `INSERT INTO publication_targets
         (id, project_id, delivery_id, plan_id, work_id, issue_number, gate_profile,
          source_branch, target_branch, candidate_head_sha, base_sha, state,
          active_pull_request_id, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      targetId,
      seed.projectId,
      seed.deliveryId,
      seed.planId,
      seed.workId,
      seed.issueNumber,
      seed.gateProfile,
      seed.sourceBranch,
      seed.targetBranch,
      seed.candidateHeadSha,
      seed.baseSha,
      seed.eligible ? "ready" : "no_candidate",
      now,
      now,
    );
    if (seed.eligible) ensureCreatePullRequestIntent(db, targetId, seed, now);
    return targetId;
  }

  const candidateChanged =
    existing.candidate_head_sha !== seed.candidateHeadSha ||
    existing.source_branch !== seed.sourceBranch ||
    existing.base_sha !== seed.baseSha;
  const nextState = seed.eligible
    ? existing.state === "no_candidate" || candidateChanged
      ? "ready"
      : existing.state
    : existing.state === "no_candidate"
      ? "no_candidate"
      : existing.state;

  if (candidateChanged || nextState !== existing.state) {
    db.prepare(
      `UPDATE publication_targets
          SET candidate_head_sha = ?, base_sha = ?, source_branch = ?, target_branch = ?,
              state = ?, last_error = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(
      seed.candidateHeadSha,
      seed.baseSha,
      seed.sourceBranch,
      seed.targetBranch,
      nextState,
      now,
      existing.id,
    );
  }

  if (seed.eligible) ensureCreatePullRequestIntent(db, existing.id, seed, now);
  return existing.id;
}

/** Queue the idempotent draft-PR intent for the exact source branch and candidate. */
export function ensureCreatePullRequestIntent(
  db: DatabaseSync,
  targetId: string,
  seed: Pick<PublicationTargetSeed, "candidateHeadSha" | "sourceBranch">,
  now = Date.now(),
): void {
  const operationKey = `create_pr:${seed.sourceBranch}:${seed.candidateHeadSha}`;
  const present = db
    .prepare(
      "SELECT 1 AS present FROM publication_intents WHERE target_id = ? AND operation_key = ?",
    )
    .get(targetId, operationKey);
  if (present) return;
  db.prepare(
    `INSERT INTO publication_intents
       (id, target_id, project_id, operation_key, kind, state, request_json, attempts,
        remote_object_id, remote_url, last_error, created_at, updated_at)
     VALUES (?, ?, (SELECT project_id FROM publication_targets WHERE id = ?),
             ?, 'create_pr', 'queued', ?, 0, NULL, NULL, NULL, ?, ?)`,
  ).run(
    `int_${randomUUID()}`,
    targetId,
    targetId,
    operationKey,
    JSON.stringify({
      candidateHeadSha: seed.candidateHeadSha,
      sourceBranch: seed.sourceBranch,
    }),
    now,
    now,
  );
}

/** Append one consequential audit event and its durable outgoing intent atomically. */
export function enqueuePublicationEvent(db: DatabaseSync, input: PublicationEventInput): string {
  const sequenceRow = db
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM publication_events WHERE target_id = ?",
    )
    .get(input.targetId) as { sequence: number };
  const eventId = `pevt_${randomUUID()}`;
  db.prepare(
    `INSERT INTO publication_events
       (id, target_id, project_id, sequence, work_id, run_id, lap, candidate_head_sha,
        observation_id, finding_id, kind, severity, title, body, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    input.targetId,
    input.projectId,
    sequenceRow.sequence + 1,
    input.workId,
    input.runId,
    input.lap,
    input.candidateHeadSha,
    input.observationId,
    input.findingId,
    input.kind,
    input.severity,
    input.title,
    input.body,
    input.occurredAt,
  );
  db.prepare(
    `INSERT INTO publication_intents
       (id, target_id, project_id, operation_key, kind, state, request_json, attempts,
        remote_object_id, remote_url, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'publish_event', 'queued', ?, 0, NULL, NULL, NULL, ?, ?)`,
  ).run(
    `int_${randomUUID()}`,
    input.targetId,
    input.projectId,
    `event:${eventId}`,
    JSON.stringify({ eventId }),
    input.occurredAt,
    input.occurredAt,
  );
  return eventId;
}
