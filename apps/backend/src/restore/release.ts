import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  RestoreIntentFact,
  RestoreReleaseDisposition,
  RestoreRunFact,
  RestoreUnresolved,
} from "@animus/contracts/operator";
import { publicationMarker } from "../publication/service";
import type { ForgeAdapter } from "../registry/forge";

export type RestoreReleaseErrorCode =
  | "restore_reconcile_unresolved"
  | "restore_reconcile_conflict"
  | "restore_reconcile_unverified";

export class RestoreReleaseError extends Error {
  constructor(
    public readonly code: RestoreReleaseErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RestoreReleaseError";
  }
}

export interface RunDisposition {
  runId: string;
  disposition: RestoreReleaseDisposition;
  note?: string;
}

export interface IntentDisposition {
  intentId: string;
  disposition: RestoreReleaseDisposition;
  note?: string;
}

export interface ReleaseDispositions {
  runs: RunDisposition[];
  intents: IntentDisposition[];
}

interface RunRow {
  id: string;
  project_id: string;
  issue_number: number;
  state: string;
  branch: string;
  worktree_path: string;
  owner_pid: number | null;
  lease_expires_at: number | null;
}

interface IntentRow {
  id: string;
  project_id: string;
  draft_publication_id: string | null;
  target_id: string | null;
  operation_key: string;
  kind: string;
  resource_kind: string;
  state: "queued" | "attempting" | "failed" | "unknown";
  attempts: number;
  request_json: string;
  repo_name: string;
}

const UNRESOLVED_RUN_STATES = "('claimed', 'dispatched', 'running', 'interrupted')";
const UNRESOLVED_INTENT_STATES = "('queued', 'attempting', 'failed', 'unknown')";

export function listUnresolvedRuns(db: DatabaseSync): RunRow[] {
  return db
    .prepare(
      `SELECT id, project_id, issue_number, state, branch, worktree_path, owner_pid, lease_expires_at
         FROM dispatch_runs
        WHERE state IN ${UNRESOLVED_RUN_STATES}
        ORDER BY project_id ASC, id ASC`,
    )
    .all() as unknown as RunRow[];
}

export function listUnresolvedIntents(db: DatabaseSync): IntentRow[] {
  return db
    .prepare(
      `SELECT i.id, i.project_id, i.draft_publication_id, i.target_id, i.operation_key,
              i.kind, i.resource_kind, i.state, i.attempts, i.request_json,
              p.repo_name AS repo_name
         FROM publication_intents i
         JOIN projects p ON p.id = i.project_id
        WHERE i.state IN ${UNRESOLVED_INTENT_STATES}
        ORDER BY i.project_id ASC, i.created_at ASC, i.id ASC`,
    )
    .all() as unknown as IntentRow[];
}

/** Local, network-free facts for operator status. Remote readback happens on release. */
export function enumerateRestoreUnresolved(db: DatabaseSync): RestoreUnresolved {
  return {
    runs: listUnresolvedRuns(db).map(toRunFact),
    intents: listUnresolvedIntents(db).map((row) => ({
      intentId: row.id,
      projectId: row.project_id,
      kind: row.kind,
      operationKey: row.operation_key,
      state: row.state,
      attempts: row.attempts,
      remoteObservation: "unverified",
      remoteDetail: "Remote readback runs when the installation hold is released",
    })),
  };
}

function toRunFact(row: RunRow): RestoreRunFact {
  return {
    runId: row.id,
    projectId: row.project_id,
    issueNumber: row.issue_number,
    state: row.state,
    branch: row.branch,
    worktreePath: row.worktree_path,
    worktreePresent: existsSync(row.worktree_path),
    ownerPidCleared: row.owner_pid === null,
    leaseCleared: row.lease_expires_at === null,
  };
}

interface RemoteObservation {
  observation: RestoreIntentFact["remoteObservation"];
  detail: string | null;
}

/**
 * Read-only reconciliation of one pending external intent. Nothing is written to
 * the forge; a failed readback reports `unreadable` and blocks release instead of
 * guessing a remote outcome.
 */
async function observeIntent(
  db: DatabaseSync,
  forge: ForgeAdapter | undefined,
  row: IntentRow,
): Promise<RemoteObservation> {
  if (!forge) {
    return { observation: "unreadable", detail: "No forge transport is configured" };
  }
  try {
    switch (row.kind) {
      case "create_pr":
        return await observeCreatePullRequest(forge, row);
      case "publish_event":
      case "update_summary":
        return observeTargetEvent(db, row);
      case "create_review":
        return await observeReview(forge, db, row);
      case "create_issue":
        return await observeIssueMarker(forge, row);
      case "create_issue_relationship":
        return await observeRelationship(forge, row);
      case "link_source_issue":
        return await observeSourceLink(forge, row);
      default:
        return { observation: "unreadable", detail: `Unknown intent kind ${row.kind}` };
    }
  } catch (error) {
    return {
      observation: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function observeCreatePullRequest(
  forge: ForgeAdapter,
  row: IntentRow,
): Promise<RemoteObservation> {
  if (typeof forge.listPullRequests !== "function") {
    return { observation: "unreadable", detail: "Forge transport cannot list pull requests" };
  }
  const request = parseRequest(row.request_json);
  const branch = typeof request.sourceBranch === "string" ? request.sourceBranch : null;
  if (!branch) {
    return { observation: "unreadable", detail: "Intent does not record its source branch" };
  }
  const pullRequests = await forge.listPullRequests(row.repo_name);
  const match = pullRequests.find((pullRequest) => pullRequest.head === branch);
  return match
    ? { observation: "present", detail: `Pull request #${match.number} exists for ${branch}` }
    : { observation: "absent", detail: `No pull request exists for ${branch}` };
}

function observeTargetEvent(db: DatabaseSync, row: IntentRow): RemoteObservation {
  if (!row.target_id) {
    return { observation: "unverified", detail: "Intent is not bound to a publication target" };
  }
  const active = db
    .prepare(
      `SELECT number FROM publication_pull_requests
        WHERE target_id = ? AND active = 1 AND number IS NOT NULL
        LIMIT 1`,
    )
    .get(row.target_id) as { number: number } | undefined;
  if (!active) {
    return {
      observation: "absent",
      detail: "No active pull request exists to carry this audit event",
    };
  }
  return {
    observation: "unverified",
    detail: `Active pull request #${active.number} exists; comment mark readback is unavailable offline`,
  };
}

async function observeReview(
  forge: ForgeAdapter,
  db: DatabaseSync,
  row: IntentRow,
): Promise<RemoteObservation> {
  const target = observeTargetEvent(db, row);
  if (target.observation === "absent") return target;
  if (!row.target_id) return target;
  const active = db
    .prepare(
      `SELECT number FROM publication_pull_requests
        WHERE target_id = ? AND active = 1 AND number IS NOT NULL
        LIMIT 1`,
    )
    .get(row.target_id) as { number: number } | undefined;
  if (!active) return target;
  if (typeof forge.listPullRequestReviews !== "function") {
    return {
      observation: "unverified",
      detail: "Forge transport cannot list pull request reviews",
    };
  }
  const request = parseRequest(row.request_json);
  const commitId = typeof request.commitId === "string" ? request.commitId : null;
  const reviews = await forge.listPullRequestReviews(row.repo_name, active.number);
  const match = commitId ? reviews.find((review) => (review.body ?? "").includes(commitId)) : null;
  return match
    ? { observation: "present", detail: `Review exists on pull request #${active.number}` }
    : {
        observation: "unverified",
        detail: `Pull request #${active.number} exists; matching review not observed`,
      };
}

async function observeIssueMarker(forge: ForgeAdapter, row: IntentRow): Promise<RemoteObservation> {
  if (typeof forge.listIssues !== "function") {
    return { observation: "unreadable", detail: "Forge transport cannot list issues" };
  }
  const marker = publicationMarker(row.operation_key);
  const issues = await forge.listIssues(row.repo_name, "ALL");
  const match = issues.find((issue) => (issue.body ?? "").includes(marker));
  return match
    ? { observation: "present", detail: `Issue #${match.number} carries this operation marker` }
    : { observation: "absent", detail: "No issue carries this operation marker" };
}

async function observeRelationship(
  forge: ForgeAdapter,
  row: IntentRow,
): Promise<RemoteObservation> {
  const request = parseRequest(row.request_json);
  const from = typeof request.fromIssueNumber === "number" ? request.fromIssueNumber : null;
  const to = typeof request.toIssueNumber === "number" ? request.toIssueNumber : null;
  if (from === null || to === null) {
    return {
      observation: "absent",
      detail: "Both relationship issue numbers must exist before a relationship can be published",
    };
  }
  if (typeof forge.getIssue !== "function") {
    return { observation: "unreadable", detail: "Forge transport cannot read issues" };
  }
  const child = await forge.getIssue(row.repo_name, to);
  if (!child) return { observation: "absent", detail: `Issue #${to} does not exist` };
  const textual = (child.body ?? "").includes(`#${from}`);
  return textual
    ? { observation: "present", detail: `Issue #${to} references #${from}` }
    : { observation: "absent", detail: `Issue #${to} does not reference #${from}` };
}

async function observeSourceLink(forge: ForgeAdapter, row: IntentRow): Promise<RemoteObservation> {
  const request = parseRequest(row.request_json);
  const source = typeof request.sourceIssueNumber === "number" ? request.sourceIssueNumber : null;
  if (source === null) {
    return { observation: "unreadable", detail: "Intent does not record its source issue" };
  }
  if (typeof forge.getIssue !== "function") {
    return { observation: "unreadable", detail: "Forge transport cannot read issues" };
  }
  const marker = publicationMarker(row.operation_key);
  const issue = await forge.getIssue(row.repo_name, source);
  if (!issue) return { observation: "absent", detail: `Source issue #${source} does not exist` };
  const present = (issue.comments ?? []).some((comment) => (comment.body ?? "").includes(marker));
  return present
    ? { observation: "present", detail: `Source issue #${source} carries the backlink marker` }
    : { observation: "absent", detail: `Source issue #${source} has no backlink marker` };
}

function parseRequest(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Verified release of a restored installation.
 *
 * Every interrupted run and every pending/unknown external intent must be
 * explicitly enumerated by the caller. Server-side facts decide whether each
 * disposition is admissible: a run may only be released after its copied owner
 * identity and lease were cleared, and an intent may only be `resolved` when a
 * positive remote readback exists. Owners are never signalled and a reused PID
 * is never treated as authority. Budgets, laps and history are untouched.
 */
export async function verifyRestoreRelease(input: {
  db: DatabaseSync;
  forge?: ForgeAdapter;
  dispositions: ReleaseDispositions;
  now: number;
}): Promise<{ runs: RunRow[]; intents: IntentRow[]; report: Record<string, unknown> }> {
  const runs = listUnresolvedRuns(input.db);
  const intents = listUnresolvedIntents(input.db);

  const runDispositions = indexDispositions(input.dispositions.runs);
  const intentDispositions = indexDispositions(input.dispositions.intents);

  const expectedRuns = new Set(runs.map((run) => run.id));
  const expectedIntents = new Set(intents.map((intent) => intent.id));
  assertExactSet("run", runDispositions, expectedRuns);
  assertExactSet("intent", intentDispositions, expectedIntents);

  const runFacts = runs.map(toRunFact);
  const blocked: Record<string, unknown>[] = [];
  for (const fact of runFacts) {
    if (!fact.ownerPidCleared || !fact.leaseCleared) {
      blocked.push({
        runId: fact.runId,
        reason: "owner_identity_not_cleared",
        message:
          "Restored run still carries a process owner or lease; copied ownership is not authority and must be cleared before release",
      });
      continue;
    }
    if (fact.state !== "interrupted" && fact.state !== "reconciled") {
      blocked.push({
        runId: fact.runId,
        reason: "run_still_active",
        message: `Run is still ${fact.state}; only an interrupted or terminal run can be released`,
      });
    }
  }

  const intentFacts: (RestoreIntentFact & { repoName: string })[] = [];
  for (const row of intents) {
    const disposition = intentDispositions.get(row.id)!;
    const remote = await observeIntent(input.db, input.forge, row);
    intentFacts.push({
      intentId: row.id,
      projectId: row.project_id,
      kind: row.kind,
      operationKey: row.operation_key,
      state: row.state,
      attempts: row.attempts,
      remoteObservation: remote.observation,
      remoteDetail: remote.detail,
      repoName: row.repo_name,
    });
    if (remote.observation === "unreadable") {
      blocked.push({
        intentId: row.id,
        reason: "remote_unreadable",
        message: `Remote outcome could not be read: ${remote.detail ?? "unknown error"}`,
      });
      continue;
    }
    if (remote.observation === "present" && disposition.disposition !== "resolved") {
      blocked.push({
        intentId: row.id,
        reason: "remote_effect_present",
        message:
          "A remote object exists for this intent; it must be dispositioned `resolved`, not abandoned",
      });
      continue;
    }
    if (remote.observation !== "present" && disposition.disposition === "resolved") {
      blocked.push({
        intentId: row.id,
        reason: "remote_effect_unverified",
        message:
          "`resolved` requires a positive remote readback; use `abandoned` for an effect that is verifiably absent or ambiguous",
      });
    }
  }

  if (blocked.length > 0) {
    const summary = blocked
      .map((entry) => {
        const id = typeof entry.runId === "string" ? entry.runId : entry.intentId;
        return `${String(entry.reason)} (${String(id)})`;
      })
      .join(", ");
    throw new RestoreReleaseError(
      "restore_reconcile_unverified",
      `Cannot release the restored installation: ${blocked.length} unresolved verification issue(s): ${summary}`,
      {
        blocked,
        runs: runFacts,
        intents: intentFacts,
      },
    );
  }

  const runReport = runFacts.map((fact) => {
    const disposition = runDispositions.get(fact.runId)!;
    return {
      runId: fact.runId,
      state: fact.state,
      issueNumber: fact.issueNumber,
      branch: fact.branch,
      worktreePath: fact.worktreePath,
      worktreePresent: fact.worktreePresent,
      ownerIdentityCleared: fact.ownerPidCleared && fact.leaseCleared,
      disposition: disposition.disposition,
      note: disposition.note ?? null,
    };
  });
  const intentReport = intentFacts.map((fact) => {
    const disposition = intentDispositions.get(fact.intentId)!;
    return {
      intentId: fact.intentId,
      projectId: fact.projectId,
      kind: fact.kind,
      operationKey: fact.operationKey,
      state: fact.state,
      attempts: fact.attempts,
      repository: fact.repoName,
      remoteObservation: fact.remoteObservation,
      remoteDetail: fact.remoteDetail,
      disposition: disposition.disposition,
      note: disposition.note ?? null,
    };
  });

  return {
    runs,
    intents,
    report: {
      verifiedAt: input.now,
      runs: runReport,
      intents: intentReport,
      unresolvedRunCount: runReport.length,
      unresolvedIntentCount: intentReport.length,
    },
  };
}

function indexDispositions(
  entries: readonly (
    | { runId: string; disposition: RestoreReleaseDisposition; note?: string }
    | { intentId: string; disposition: RestoreReleaseDisposition; note?: string }
  )[],
): Map<string, { disposition: RestoreReleaseDisposition; note?: string }> {
  const index = new Map<string, { disposition: RestoreReleaseDisposition; note?: string }>();
  for (const entry of entries) {
    const id = "runId" in entry ? entry.runId : entry.intentId;
    if (index.has(id)) {
      throw new RestoreReleaseError(
        "restore_reconcile_conflict",
        `Duplicate disposition for ${id}`,
      );
    }
    index.set(id, { disposition: entry.disposition, note: entry.note });
  }
  return index;
}

function assertExactSet(
  kind: "run" | "intent",
  provided: Map<string, { disposition: RestoreReleaseDisposition; note?: string }>,
  expected: Set<string>,
): void {
  const missing = [...expected].filter((id) => !provided.has(id));
  const extra = [...provided.keys()].filter((id) => !expected.has(id));
  if (extra.length > 0) {
    throw new RestoreReleaseError(
      "restore_reconcile_conflict",
      `Dispositions reference ${kind}(s) that are not unresolved: ${extra.join(", ")}`,
      { extra },
    );
  }
  if (missing.length > 0) {
    throw new RestoreReleaseError(
      "restore_reconcile_unresolved",
      `Dispositions are missing for ${missing.length} unresolved ${kind}(s): ${missing.join(", ")}`,
      { missing },
    );
  }
}

/** Re-exported so callers keep one row shape between enumeration and release. */
export type { IntentRow as RestoreIntentRow, RunRow as RestoreRunRow };
