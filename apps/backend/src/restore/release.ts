import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  RestoreIntentFact,
  RestoreReleaseDisposition,
  RestoreRunFact,
  RestoreUnresolved,
} from "@animus/contracts/operator";
import { publicationMarker } from "../publication/service";
import type { ForgeAdapter, ForgePullRequest } from "../registry/forge";
import {
  InstallationHoldConflictError,
  readInstallationHold,
  reconcileInstallationHold,
} from "@animus/contracts/installation-hold";

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
  /** Present remote identity, recorded when an effect is definitely observed. */
  remoteObjectId?: string | null;
  remoteUrl?: string | null;
  /** How a relationship was observed (native relationship vs canonical text). */
  relationSource?: "textual" | "native" | "textual+native" | null;
  /** Full readback used to bind local PR bookkeeping for a resolved create_pr. */
  pullRequest?: ForgePullRequest | null;
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
        return await observeCreatePullRequest(forge, db, row);
      case "publish_event":
      case "update_summary":
        return observeTargetEvent(db, row);
      case "create_review":
        return await observeReview(forge, db, row);
      case "create_issue":
        return await observeIssueMarker(forge, row);
      case "create_issue_relationship":
        return await observeRelationship(db, forge, row);
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
  db: DatabaseSync,
  row: IntentRow,
): Promise<RemoteObservation> {
  if (typeof forge.listPullRequests !== "function") {
    return { observation: "unreadable", detail: "Forge transport cannot list pull requests" };
  }
  const request = parseRequest(row.request_json);
  const branch = typeof request.sourceBranch === "string" ? request.sourceBranch : null;
  const candidate = typeof request.candidateHeadSha === "string" ? request.candidateHeadSha : null;
  if (!branch || !candidate) {
    return {
      observation: "unreadable",
      detail: "Intent does not record its source branch and candidate",
    };
  }
  if (!row.target_id) {
    return { observation: "unreadable", detail: "Intent is not bound to a publication target" };
  }
  const target = db
    .prepare("SELECT target_branch, candidate_head_sha FROM publication_targets WHERE id = ?")
    .get(row.target_id) as { target_branch: string; candidate_head_sha: string } | undefined;
  if (!target) {
    return { observation: "unreadable", detail: "Publication target for this intent is missing" };
  }
  if (target.candidate_head_sha !== candidate) {
    return {
      observation: "unreadable",
      detail: `Intent candidate ${candidate} no longer matches its target ${target.candidate_head_sha}`,
    };
  }
  const pullRequests = await forge.listPullRequests(row.repo_name);
  const normalize = (value: string) =>
    value
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
  const exact = pullRequests.filter((pullRequest) => {
    if (pullRequest.head !== branch || pullRequest.base !== target.target_branch) return false;
    if (pullRequest.repository && normalize(pullRequest.repository) !== normalize(row.repo_name)) {
      return false;
    }
    return true;
  });
  if (exact.length === 0) {
    return {
      observation: "absent",
      detail: `No pull request targets ${branch} into ${target.target_branch}`,
    };
  }
  const open = exact.find((pullRequest) => String(pullRequest.state).toUpperCase() === "OPEN");
  if (!open) {
    const states = exact.map((pullRequest) => String(pullRequest.state).toUpperCase()).join(", ");
    return {
      observation: "unreadable",
      detail: `A matching pull request exists but is not open (${states}); operator confirmation is required`,
    };
  }
  if (!open.headRefOid) {
    return {
      observation: "unreadable",
      detail: `Pull request #${open.number} did not report its head SHA; the candidate is unverified`,
    };
  }
  if (open.headRefOid !== candidate) {
    return {
      observation: "unreadable",
      detail: `Pull request #${open.number} head ${open.headRefOid} is not the candidate ${candidate}`,
    };
  }
  return {
    observation: "present",
    detail: `Pull request #${open.number} exists for ${branch} into ${target.target_branch} at ${candidate}`,
    remoteObjectId: String(open.number),
    remoteUrl: open.html_url ?? null,
    pullRequest: open,
  };
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
      observation: "unreadable",
      detail: "Forge transport cannot list pull request reviews",
    };
  }
  const request = parseRequest(row.request_json);
  const commitId = typeof request.commitId === "string" ? request.commitId : null;
  const reviews = await forge.listPullRequestReviews(row.repo_name, active.number);
  const match = commitId ? reviews.find((review) => (review.body ?? "").includes(commitId)) : null;
  return match
    ? {
        observation: "present",
        detail: `Review exists on pull request #${active.number}`,
        remoteObjectId: match.id ?? `review:${commitId ?? row.operation_key}`,
        remoteUrl: match.html_url ?? null,
      }
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
    ? {
        observation: "present",
        detail: `Issue #${match.number} carries this operation marker`,
        remoteObjectId: String(match.number),
        remoteUrl: `https://github.com/${row.repo_name}/issues/${match.number}`,
      }
    : { observation: "absent", detail: "No issue carries this operation marker" };
}

async function observeRelationship(
  db: DatabaseSync,
  forge: ForgeAdapter,
  row: IntentRow,
): Promise<RemoteObservation> {
  const request = parseRequest(row.request_json);
  let from = typeof request.fromIssueNumber === "number" ? request.fromIssueNumber : null;
  let to = typeof request.toIssueNumber === "number" ? request.toIssueNumber : null;
  if ((from === null || to === null) && row.draft_publication_id) {
    const members = new Map(
      (
        db
          .prepare(
            "SELECT node_key, issue_number FROM draft_publication_members WHERE publication_id = ?",
          )
          .all(row.draft_publication_id) as Array<{
          node_key: string;
          issue_number: number | null;
        }>
      ).map((member) => [member.node_key, member.issue_number]),
    );
    const fromKey = typeof request.fromNodeKey === "string" ? request.fromNodeKey : null;
    const toKey = typeof request.toNodeKey === "string" ? request.toNodeKey : null;
    if (from === null && fromKey) from = members.get(fromKey) ?? null;
    if (to === null && toKey) to = members.get(toKey) ?? null;
  }
  if (from === null || to === null) {
    return {
      observation: "absent",
      detail: "Both relationship issue numbers must exist before a relationship can be published",
    };
  }
  if (typeof forge.getIssue !== "function") {
    return { observation: "unreadable", detail: "Forge transport cannot read issues" };
  }
  // The intent records the child as `from` and its parent/blocker as `to`.
  const childNumber = from;
  const relatedNumber = to;
  const child = await forge.getIssue(row.repo_name, childNumber);
  if (!child) return { observation: "absent", detail: `Issue #${childNumber} does not exist` };
  const body = child.body ?? "";
  const kind = typeof request.kind === "string" ? request.kind : null;
  const textual = textualRelationshipMatches(body, kind, relatedNumber);
  if (textual) {
    return {
      observation: "present",
      detail: `Issue #${childNumber} carries the exact ${kind ?? "canonical"} reference to #${relatedNumber}`,
      remoteObjectId: `#${childNumber}->#${relatedNumber}`,
      relationSource: "textual",
    };
  }
  // Native relationships may exist without a textual line; distinguish a
  // genuine absence from an unsupported or unreadable native readback.
  const native = await nativeRelationshipMatches(
    forge,
    row.repo_name,
    kind,
    childNumber,
    relatedNumber,
  );
  if (native === true) {
    return {
      observation: "present",
      detail: `Native ${kind ?? "relationship"} #${childNumber} -> #${relatedNumber} exists`,
      remoteObjectId: `#${childNumber}->#${relatedNumber}`,
      relationSource: "native",
    };
  }
  if (native === "unreadable") {
    return {
      observation: "unreadable",
      detail: `Native relationship services for #${childNumber} -> #${relatedNumber} are unsupported by this transport`,
    };
  }
  return {
    observation: "absent",
    detail: `Issue #${childNumber} has neither a textual nor a native ${kind ?? "relationship"} reference to #${relatedNumber}`,
  };
}

/**
 * Canonical textual relationship check. `#1` must never match `#10`, and a
 * parent reference must be its own `Part of #N` line while a dependency must be
 * an exact comma-separated entry on the `Depends on:` line.
 */
export function textualRelationshipMatches(
  body: string,
  kind: string | null,
  from: number,
): boolean {
  if (kind === "parent_child") {
    return new RegExp(`^Part of #${from}\\s*$`, "m").test(body);
  }
  if (kind === "dependency") {
    const line = body.match(/^Depends on:\s*(.+)$/m)?.[1] ?? "";
    return line.split(",").some((entry) => entry.trim() === `#${from}`);
  }
  return new RegExp(`(?:^|[^0-9])#${from}(?![0-9])`).test(body);
}

async function nativeRelationshipMatches(
  forge: ForgeAdapter,
  repo: string,
  kind: string | null,
  childNumber: number,
  relatedNumber: number,
): Promise<boolean | "unreadable"> {
  try {
    if (kind === "parent_child") {
      if (typeof forge.getSubIssues !== "function") return "unreadable";
      return (await forge.getSubIssues(repo, relatedNumber)).includes(childNumber);
    }
    if (kind === "dependency") {
      if (typeof forge.getIssueDependencies !== "function") return "unreadable";
      return (await forge.getIssueDependencies(repo, childNumber)).includes(relatedNumber);
    }
    return "unreadable";
  } catch {
    return "unreadable";
  }
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
  const present = (issue.comments ?? []).find((comment) => (comment.body ?? "").includes(marker));
  return present
    ? {
        observation: "present",
        detail: `Source issue #${source} carries the backlink marker`,
        remoteObjectId: present.id ?? `comment:${marker}`,
      }
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
export interface VerifiedRestoreRelease {
  runs: RunRow[];
  intents: IntentRow[];
  observations: Map<string, RemoteObservation>;
  report: Record<string, unknown>;
}

export async function verifyRestoreRelease(input: {
  db: DatabaseSync;
  forge?: ForgeAdapter;
  dispositions: ReleaseDispositions;
  now: number;
}): Promise<VerifiedRestoreRelease> {
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

  const intentFacts: (RestoreIntentFact & {
    repoName: string;
    remoteObjectId: string | null;
    remoteUrl: string | null;
  })[] = [];
  const observations = new Map<string, RemoteObservation>();
  for (const row of intents) {
    const disposition = intentDispositions.get(row.id)!;
    const remote = await observeIntent(input.db, input.forge, row);
    observations.set(row.id, remote);
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
      remoteObjectId: remote.remoteObjectId ?? null,
      remoteUrl: remote.remoteUrl ?? null,
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
      continue;
    }
    if (
      remote.observation === "present" &&
      disposition.disposition === "resolved" &&
      !remote.remoteObjectId
    ) {
      blocked.push({
        intentId: row.id,
        reason: "remote_identity_unverified",
        message:
          "A resolved intent must bind the real remote object identity; a blank remote id is not accepted",
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
      remoteObjectId: fact.remoteObjectId,
      remoteUrl: fact.remoteUrl,
      disposition: disposition.disposition,
      note: disposition.note ?? null,
    };
  });

  return {
    runs,
    intents,
    observations,
    report: {
      verifiedAt: input.now,
      runs: runReport,
      intents: intentReport,
      unresolvedRunCount: runReport.length,
      unresolvedIntentCount: intentReport.length,
    },
  };
}

/**
 * Durably settle the verified release before the hold can clear.
 *
 * Every disposition is applied in one SQLite transaction together with the
 * snapshot-fenced hold CAS. The unresolved sets and the hold fence are re-read
 * inside the transaction, so a concurrent restore, enqueue or competing release
 * makes the whole disposition roll back instead of partially applying it.
 *
 * `resolved` writes the real remote identity and converges local bookkeeping
 * (a PR binding for `create_pr`, a verified relationship row). `abandoned` is a
 * terminal state that publication and issue reconciliation never replay, so the
 * original uncertain effect cannot be duplicated after release or restart.
 */
export function settleRestoreRelease(input: {
  db: DatabaseSync;
  verification: VerifiedRestoreRelease;
  dispositions: ReleaseDispositions;
  expected: { sourceRestoreId: string | null; restoredAt: number | null };
  actor: string;
  now: number;
  reconciliation: Record<string, unknown>;
}): void {
  const { db, verification, expected, actor, now, reconciliation } = input;
  const runDispositions = indexDispositions(input.dispositions.runs);
  const intentDispositions = indexDispositions(input.dispositions.intents);

  db.exec("BEGIN IMMEDIATE;");
  try {
    const hold = readInstallationHold(db);
    if (
      !hold.held ||
      hold.sourceRestoreId !== expected.sourceRestoreId ||
      hold.restoredAt !== expected.restoredAt
    ) {
      throw new RestoreReleaseError(
        "restore_reconcile_conflict",
        "The held installation changed before its dispositions could be committed",
      );
    }

    const currentRuns = listUnresolvedRuns(db);
    const currentIntents = listUnresolvedIntents(db);
    assertSameSet(
      "run",
      currentRuns.map((run) => run.id),
      verification.runs.map((run) => run.id),
    );
    assertSameSet(
      "intent",
      currentIntents.map((intent) => intent.id),
      verification.intents.map((intent) => intent.id),
    );

    for (const run of currentRuns) {
      if (!runDispositions.has(run.id)) {
        throw new RestoreReleaseError(
          "restore_reconcile_conflict",
          `Run ${run.id} appeared after verification; re-read and disposition the new unresolved set`,
        );
      }
    }

    for (const row of currentIntents) {
      const disposition = intentDispositions.get(row.id);
      if (!disposition) {
        throw new RestoreReleaseError(
          "restore_reconcile_conflict",
          `Intent ${row.id} appeared after verification; re-read and disposition the new unresolved set`,
        );
      }
      const observation = verification.observations.get(row.id);
      if (!observation) {
        throw new RestoreReleaseError(
          "restore_reconcile_conflict",
          `Intent ${row.id} was not verified`,
        );
      }
      if (disposition.disposition === "resolved") {
        if (observation.observation !== "present") {
          throw new RestoreReleaseError(
            "restore_reconcile_conflict",
            `Intent ${row.id} is no longer verifiably present`,
          );
        }
        applyResolvedIntent(db, row, observation, now);
      } else {
        const reason = `abandoned_during_restore_reconciliation: ${observation.observation}${
          observation.detail ? ` (${observation.detail})` : ""
        }`;
        const result = db
          .prepare(
            `UPDATE publication_intents
                SET state = 'abandoned', last_error = ?, updated_at = ?
              WHERE id = ? AND state IN ('queued', 'attempting', 'failed', 'unknown')`,
          )
          .run(reason, now, row.id);
        if (Number(result.changes ?? 0) !== 1) {
          throw new RestoreReleaseError(
            "restore_reconcile_conflict",
            `Intent ${row.id} changed before its abandonment could be recorded`,
          );
        }
      }
    }

    reconcileInstallationHold(db, { actor, now, reconciliation, expected });
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {}
    if (error instanceof InstallationHoldConflictError) {
      throw new RestoreReleaseError("restore_reconcile_conflict", error.message);
    }
    throw error;
  }
}

function assertSameSet(kind: "run" | "intent", current: string[], verified: string[]): void {
  const currentSet = new Set(current);
  const verifiedSet = new Set(verified);
  const added = current.filter((id) => !verifiedSet.has(id));
  const removed = verified.filter((id) => !currentSet.has(id));
  if (added.length > 0 || removed.length > 0) {
    throw new RestoreReleaseError(
      "restore_reconcile_conflict",
      `The ${kind} set changed between verification and release`,
      { added, removed },
    );
  }
}

function applyResolvedIntent(
  db: DatabaseSync,
  row: IntentRow,
  observation: RemoteObservation,
  now: number,
): void {
  switch (row.kind) {
    case "create_pr": {
      if (!observation.pullRequest) {
        throw new RestoreReleaseError(
          "restore_reconcile_conflict",
          `Intent ${row.id} is present but its pull request binding is missing`,
        );
      }
      bindObservedPullRequest(db, row, observation.pullRequest, now);
      acceptRestoredIntent(db, row, observation, now);
      return;
    }
    case "create_issue_relationship": {
      const request = parseRequest(row.request_json);
      const kind = typeof request.kind === "string" ? request.kind : null;
      const fromKey = typeof request.fromNodeKey === "string" ? request.fromNodeKey : null;
      const toKey = typeof request.toNodeKey === "string" ? request.toNodeKey : null;
      if (!row.draft_publication_id || !kind || !fromKey || !toKey) {
        throw new RestoreReleaseError(
          "restore_reconcile_conflict",
          `Relationship intent ${row.id} is missing its publication/node identity`,
        );
      }
      const result = db
        .prepare(
          `UPDATE draft_publication_relationships
              SET state = 'verified', source = ?, detail = ?, updated_at = ?
            WHERE publication_id = ? AND kind = ? AND from_node_key = ? AND to_node_key = ?`,
        )
        .run(
          observation.relationSource ?? "textual",
          observation.detail,
          now,
          row.draft_publication_id,
          kind,
          fromKey,
          toKey,
        );
      if (Number(result.changes ?? 0) !== 1) {
        throw new RestoreReleaseError(
          "restore_reconcile_conflict",
          `Relationship row for intent ${row.id} could not be marked verified`,
        );
      }
      acceptRestoredIntent(db, row, observation, now);
      return;
    }
    default:
      acceptRestoredIntent(db, row, observation, now);
  }
}

function acceptRestoredIntent(
  db: DatabaseSync,
  row: IntentRow,
  observation: RemoteObservation,
  now: number,
): void {
  if (!observation.remoteObjectId) {
    throw new RestoreReleaseError(
      "restore_reconcile_conflict",
      `Intent ${row.id} has no verified remote identity to bind`,
    );
  }
  const result = db
    .prepare(
      `UPDATE publication_intents
          SET state = 'accepted', remote_object_id = ?, remote_url = ?,
              last_error = NULL, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'attempting', 'failed', 'unknown')`,
    )
    .run(observation.remoteObjectId, observation.remoteUrl ?? null, now, row.id);
  if (Number(result.changes ?? 0) !== 1) {
    throw new RestoreReleaseError(
      "restore_reconcile_conflict",
      `Intent ${row.id} changed before its acceptance could be recorded`,
    );
  }
}

/** Bind the observed open pull request using the same rows the publisher uses. */
function bindObservedPullRequest(
  db: DatabaseSync,
  row: IntentRow,
  remote: ForgePullRequest,
  now: number,
): void {
  if (!row.target_id) {
    throw new RestoreReleaseError(
      "restore_reconcile_conflict",
      `Pull request intent ${row.id} has no target`,
    );
  }
  const target = db
    .prepare(
      "SELECT id, project_id, source_branch, target_branch, candidate_head_sha FROM publication_targets WHERE id = ?",
    )
    .get(row.target_id) as
    | {
        id: string;
        project_id: string;
        source_branch: string;
        target_branch: string;
        candidate_head_sha: string;
      }
    | undefined;
  if (!target) {
    throw new RestoreReleaseError(
      "restore_reconcile_conflict",
      `Publication target ${row.target_id} disappeared`,
    );
  }
  if (
    remote.head !== target.source_branch ||
    remote.base !== target.target_branch ||
    remote.headRefOid !== target.candidate_head_sha
  ) {
    throw new RestoreReleaseError(
      "restore_reconcile_conflict",
      `Pull request #${remote.number} no longer matches target ${target.id}`,
    );
  }
  const project = db
    .prepare("SELECT repo_name FROM projects WHERE id = ?")
    .get(target.project_id) as { repo_name: string } | undefined;
  if (!project) {
    throw new RestoreReleaseError(
      "restore_reconcile_conflict",
      `Project ${target.project_id} disappeared`,
    );
  }
  db.prepare(
    "UPDATE publication_pull_requests SET active = 0, updated_at = ? WHERE target_id = ? AND active = 1",
  ).run(now, target.id);
  const existing = db
    .prepare("SELECT id FROM publication_pull_requests WHERE target_id = ? AND number = ?")
    .get(target.id, remote.number) as { id: string } | undefined;
  let pullRequestId: string;
  if (existing) {
    pullRequestId = existing.id;
    db.prepare(
      `UPDATE publication_pull_requests
          SET active = 1, state = 'open', repository = ?, head_branch = ?, base_branch = ?,
              candidate_head_sha = ?, head_ref_oid = ?, url = ?, remote_retired = 0,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      remote.repository ?? project.repo_name,
      remote.head,
      remote.base,
      target.candidate_head_sha,
      remote.headRefOid ?? null,
      remote.html_url ?? null,
      now,
      existing.id,
    );
  } else {
    pullRequestId = `pr_${target.id}_${remote.number}`;
    db.prepare(
      `INSERT INTO publication_pull_requests
         (id, target_id, project_id, repository, number, url, head_branch, base_branch,
          candidate_head_sha, head_ref_oid, draft, state, active, created_by_intent,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', 1, ?, ?, ?)`,
    ).run(
      pullRequestId,
      target.id,
      target.project_id,
      remote.repository ?? project.repo_name,
      remote.number,
      remote.html_url ?? `https://github.com/${project.repo_name}/pull/${remote.number}`,
      remote.head,
      remote.base,
      target.candidate_head_sha,
      remote.headRefOid ?? null,
      row.id,
      now,
      now,
    );
  }
  db.prepare(
    "UPDATE publication_targets SET active_pull_request_id = ?, state = 'publishing', last_error = NULL, updated_at = ? WHERE id = ?",
  ).run(pullRequestId, now, target.id);
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
