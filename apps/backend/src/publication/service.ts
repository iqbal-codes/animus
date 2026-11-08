import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  publicationStatusSchema,
  type PlanGateProfile,
  type PublicationEventKind,
  type PublicationEventRecord,
  type PublicationEvidenceBinding,
  type PublicationIntentRecord,
  type PublicationPullRequest,
  type PublicationStatus,
  type PublicationTarget,
} from "@animus/contracts/operator";
import { ReportSanitizer } from "@animus/contracts/sanitizer";
import {
  AmbiguousEvidenceBoundaryError,
  EVIDENCE_SECTION_END,
  EVIDENCE_SECTION_START,
  escapeMarkdownTableCell,
  updatePrBodyEvidence,
} from "../../../../scripts/loop/pr-reporting";
import { extractValidDiffLines } from "../../../../scripts/loop/pr-publication";
import { validateHostedAssetUrl } from "../../../../scripts/loop/evidence-manager";
import { processRun } from "../../../../scripts/loop/process";
import type { ForgeAdapter, ForgePullRequest } from "../registry/forge";
import { PublicationError } from "./errors";

interface TargetRow {
  id: string;
  project_id: string;
  delivery_id: string;
  plan_id: string;
  work_id: string;
  issue_number: number;
  gate_profile: PlanGateProfile;
  source_branch: string;
  target_branch: string;
  candidate_head_sha: string;
  base_sha: string;
  remote_source_ref: string | null;
  remote_source_sha: string | null;
  remote_verified_at: number | null;
  state: PublicationTarget["state"];
  active_pull_request_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface PullRequestRow {
  id: string;
  target_id: string;
  project_id: string;
  repository: string | null;
  number: number | null;
  url: string | null;
  head_branch: string;
  base_branch: string;
  candidate_head_sha: string;
  head_ref_oid: string | null;
  draft: number;
  state: "open" | "closed" | "merged" | "superseded";
  active: number;
  remote_retired: number;
  created_by_intent: string | null;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: string;
  target_id: string;
  project_id: string;
  sequence: number;
  work_id: string;
  run_id: string | null;
  lap: number | null;
  candidate_head_sha: string;
  observation_id: string | null;
  finding_id: string | null;
  kind: PublicationEventKind;
  severity: "blocking" | "conditional" | "info";
  title: string;
  body: string;
  occurred_at: number;
}

interface IntentRow {
  id: string;
  target_id: string;
  project_id: string;
  operation_key: string;
  kind: "create_pr" | "publish_event" | "update_summary" | "create_review";
  state: "queued" | "attempting" | "accepted" | "failed" | "unknown";
  request_json: string;
  attempts: number;
  remote_object_id: string | null;
  remote_url: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface BindingRow {
  id: string;
  target_id: string;
  project_id: string;
  artifact_id: string;
  status: "pending" | "supplied_unverified";
  hosted_url: string | null;
  updated_at: number;
}

interface ProjectRow {
  id: string;
  repo_name: string;
  checkout_path: string;
}

interface ObservationRow {
  id: string;
  run_id: string;
  lap: number;
  stage: string;
  status: string;
  candidate_head_sha: string;
  producer_id: string;
  producer_role: string;
  created_at: number;
}

interface ArtifactRow {
  id: string;
  name: string;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  digest_sha256: string;
  observation_id: string;
}

interface FindingRow {
  id: string;
  summary: string;
  severity: string;
  status: string;
  issue_number: number;
  ac_key: string | null;
  file_context: string;
}

export interface PublicationRemoteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type PublicationRemoteRunner = (
  args: string[],
  cwd: string,
) => Promise<PublicationRemoteResult>;

export interface PublicationServiceOptions {
  clock?: () => number;
  gitRunner?: (cmd: string[], cwd: string) => string;
  /** Bounded remote git transport (push/ls-remote); injectable for offline tests. */
  gitRemote?: PublicationRemoteRunner;
  sanitizer?: ReportSanitizer;
}

/**
 * Production remote git transport. Reuses the bounded process owner used by the
 * local loop so a push cannot hang unbounded or outlive the publication attempt.
 */
export const defaultGitRemote: PublicationRemoteRunner = async (args, cwd) => {
  return processRun(["git", ...args], cwd, 30_000, undefined, { manageSignals: false });
};

const RETIRE_FAILED = "superseded_pull_request_retire_failed";

const LOCAL_PATH_PATTERNS: RegExp[] = [
  /file:\/\/[^\s)\]"'`]+/g,
  /(?:\/(?:Users|home|opt|tmp|private|var|mnt|workspace|root|etc))(?:\/[^\s)\]"'`]+)+/g,
  /[A-Za-z]:\\[^\s)\]"'`]+/g,
];

function isAmbiguousTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|aborted|killed|signal|socket hang up|network/i.test(
    message,
  );
}

function localPathSanitize(value: string): string {
  let next = value;
  for (const pattern of LOCAL_PATH_PATTERNS) {
    next = next.replace(pattern, "[LOCAL_PATH]");
  }
  return next;
}

export function publicationMarker(operationKey: string): string {
  return `<!-- animus-publication:${operationKey} -->`;
}

/**
 * Durable PR publication and per-lap audit.
 *
 * Audit events and their outgoing intents are written by the execution/evidence domain
 * writers. This service only reconciles those intents against the real forge transport;
 * it never invents a PR, an approval or a published state.
 */
export class PublicationService {
  private readonly clock: () => number;
  private readonly gitRunner: (cmd: string[], cwd: string) => string;
  private readonly gitRemote: PublicationRemoteRunner;
  private readonly sanitizer: ReportSanitizer;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly forge: ForgeAdapter,
    options: PublicationServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.gitRunner =
      options.gitRunner ??
      ((cmd, cwd) =>
        execFileSync("git", cmd, {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim());
    this.sanitizer = options.sanitizer ?? new ReportSanitizer();
    this.gitRemote = options.gitRemote ?? defaultGitRemote;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getStatusByRun(projectId: string, runId: string): PublicationStatus {
    const target = this.db
      .prepare(
        `SELECT t.* FROM publication_targets t
          JOIN dispatch_runs r
            ON r.delivery_id = t.delivery_id AND r.work_id = t.work_id AND r.project_id = t.project_id
         WHERE t.project_id = ? AND r.id = ?`,
      )
      .get(projectId, runId) as unknown as TargetRow | undefined;
    if (!target) {
      throw new PublicationError(
        "publication_target_not_found",
        `No publication target exists for run ${runId}`,
      );
    }
    return this.getStatus(projectId, target.id);
  }

  getStatus(projectId: string, targetId: string): PublicationStatus {
    const target = this.loadTarget(projectId, targetId);
    const pullRequests = this.listPullRequests(targetId);
    const events = this.listEvents(targetId);
    const intents = this.listIntents(targetId);
    const evidence = this.listBindings(targetId);
    const summary = this.renderSummary(target, pullRequests, events, evidence, intents);
    const activePr = pullRequests.find((pr) => pr.active) ?? null;
    const eventIntents = intents.filter((intent) => intent.kind === "publish_event");
    const summaryIntent = intents.find(
      (intent) =>
        intent.kind === "update_summary" && intent.operationKey === `summary:${summary.hash}`,
    );
    const failedIntentCount = intents.filter((intent) => intent.state === "failed").length;
    const unknownIntentCount = intents.filter((intent) => intent.state === "unknown").length;
    const queuedEventCount = eventIntents.filter((intent) => intent.state !== "accepted").length;
    const publishedEventCount = eventIntents.filter((intent) => intent.state === "accepted").length;
    const remoteStale = Boolean(
      activePr &&
      (activePr.headRefOid !== target.candidate_head_sha ||
        activePr.baseBranch !== target.target_branch ||
        activePr.headBranch !== target.source_branch),
    );
    const evidenceState = this.evidenceCompleteness(target, evidence);
    // A merged PR is no longer "active", but its already-published audit remains
    // complete history. Only count a merged PR when it is explicitly bound to the
    // exact candidate/source/target; an unbound or superseded PR never qualifies.
    const auditPr =
      activePr ?? (pullRequests.length > 0 ? pullRequests[pullRequests.length - 1]! : null);
    const auditPrBound =
      auditPr !== null &&
      (auditPr.state === "open" || auditPr.state === "merged") &&
      auditPr.candidateHeadSha === target.candidate_head_sha &&
      auditPr.headBranch === target.source_branch &&
      auditPr.baseBranch === target.target_branch;
    const auditComplete =
      auditPrBound &&
      !remoteStale &&
      this.remoteSourceVerified(target) &&
      !this.isBlockingRemoteError(target.last_error) &&
      evidenceState.pending === 0 &&
      evidenceState.unsafe === 0 &&
      Boolean(summaryIntent && summaryIntent.state === "accepted") &&
      queuedEventCount === 0 &&
      failedIntentCount === 0 &&
      unknownIntentCount === 0 &&
      this.eventsTargetResolved(events, intents);

    return publicationStatusSchema.parse({
      target: this.mapTarget(target),
      pullRequests,
      events,
      intents,
      evidence,
      summary: summary.body,
      queuedEventCount,
      publishedEventCount,
      failedIntentCount,
      unknownIntentCount,
      auditComplete,
      remoteObservedAt: activePr?.updatedAt ?? null,
      remoteStale,
    });
  }

  listStatuses(projectId: string, query: { workId?: string; deliveryId?: string } = {}) {
    const clauses = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (query.workId) {
      clauses.push("work_id = ?");
      params.push(query.workId);
    }
    if (query.deliveryId) {
      clauses.push("delivery_id = ?");
      params.push(query.deliveryId);
    }
    const rows = this.db
      .prepare(
        `SELECT id FROM publication_targets WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...(params as never[])) as Array<{ id: string }>;
    return rows.map((row) => this.getStatus(projectId, row.id));
  }

  private eventsTargetResolved(
    events: PublicationEventRecord[],
    intents: PublicationIntentRecord[],
  ) {
    const byKey = new Map(intents.map((intent) => [intent.operationKey, intent]));
    return events.every((event) => byKey.get(`event:${event.id}`)?.state === "accepted");
  }

  // -------------------------------------------------------------------------
  // Publication and reconciliation
  // -------------------------------------------------------------------------

  async publish(projectId: string, targetId: string): Promise<PublicationStatus> {
    return this.serialize(targetId, async () => {
      const target = this.loadTarget(projectId, targetId);
      if (target.state !== "no_candidate") {
        await this.reconcileTarget(target);
      }
      this.refreshTargetState(target.id);
      return this.getStatus(projectId, target.id);
    });
  }

  async publishByRun(projectId: string, runId: string): Promise<PublicationStatus> {
    const status = this.getStatusByRun(projectId, runId);
    return this.publish(projectId, status.target.id);
  }

  async reconcileAll(projectId: string): Promise<PublicationStatus[]> {
    const rows = this.db
      .prepare(
        "SELECT id FROM publication_targets WHERE project_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(projectId) as Array<{ id: string }>;
    const results: PublicationStatus[] = [];
    for (const row of rows) {
      results.push(await this.publish(projectId, row.id));
    }
    return results;
  }

  async reconcile(projectId: string, targetId: string): Promise<PublicationStatus> {
    return this.publish(projectId, targetId);
  }

  bindEvidence(
    projectId: string,
    targetId: string,
    artifactId: string,
    hostedUrl: string,
  ): PublicationStatus {
    const target = this.loadTarget(projectId, targetId);
    const hostedCheck = validateHostedAssetUrl(hostedUrl);
    if (!hostedCheck.ok) {
      throw new PublicationError(
        "publication_invalid_url",
        `Hosted evidence URL is not publishable: ${hostedCheck.reason ?? "unsupported URL"}`,
      );
    }
    const artifact = this.db
      .prepare(
        `SELECT a.id FROM execution_artifacts a
          JOIN execution_observations o ON o.id = a.observation_id
         WHERE a.project_id = ? AND a.id = ? AND o.delivery_id = ? AND o.run_id IN (
           SELECT id FROM dispatch_runs WHERE delivery_id = ? AND work_id = ?
         )`,
      )
      .get(projectId, artifactId, target.delivery_id, target.delivery_id, target.work_id) as
      | { id: string }
      | undefined;
    if (!artifact) {
      throw new PublicationError(
        "publication_evidence_not_found",
        "Artifact does not belong to this publication target",
      );
    }
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO publication_evidence_bindings
           (id, target_id, project_id, artifact_id, status, hosted_url, updated_at)
         VALUES (?, ?, ?, ?, 'supplied_unverified', ?, ?)
         ON CONFLICT(target_id, artifact_id) DO UPDATE SET
           status = 'supplied_unverified', hosted_url = excluded.hosted_url, updated_at = excluded.updated_at`,
      )
      .run(`pub_bind_${targetId}_${artifactId}`, targetId, projectId, artifactId, hostedUrl, now);
    return this.getStatus(projectId, targetId);
  }

  private async reconcileTarget(target: TargetRow): Promise<void> {
    let pr = this.activePullRequest(target);
    const createIntent = this.ensureCreateIntent(target);
    if (createIntent) {
      // A new candidate (or a failed earlier attempt) needs its own PR. The create
      // intent supersedes an older active PR only after the replacement is accepted.
      pr = (await this.executeCreateIntent(target, createIntent)) ?? pr;
    }
    await this.retireSupersededPullRequests(this.loadTarget(target.project_id, target.id));
    if (!pr) {
      this.refreshTargetState(target.id);
      return;
    }

    const remote = await this.observeActivePullRequest(target, pr);
    if (!remote) {
      this.refreshTargetState(target.id);
      return;
    }
    if (remote !== pr) pr = remote;

    // Publish consequential events first so the mutable summary reflects their
    // accepted state instead of freezing a pre-publication snapshot.
    const pendingEvents = this.db
      .prepare(
        `SELECT * FROM publication_intents
          WHERE target_id = ? AND kind = 'publish_event' AND state != 'accepted'
          ORDER BY created_at ASC, id ASC`,
      )
      .all(target.id) as unknown as IntentRow[];
    for (const intent of pendingEvents) {
      await this.executeEventIntent(this.loadTarget(target.project_id, target.id), pr, intent);
    }

    const current = this.loadTarget(target.project_id, target.id);
    const projection = this.renderSummary(
      current,
      this.listPullRequests(target.id),
      this.listEvents(target.id),
      this.listBindings(target.id),
      this.listIntents(target.id),
    );
    this.persistSummary(current, projection.body);
    const summaryIntent = this.ensureSummaryIntent(current, projection.hash);
    if (summaryIntent) {
      await this.executeSummaryIntent(current, pr, summaryIntent);
    }
  }

  private ensureCreateIntent(target: TargetRow): IntentRow | null {
    const key = `create_pr:${target.source_branch}:${target.candidate_head_sha}`;
    const existing = this.db
      .prepare("SELECT * FROM publication_intents WHERE target_id = ? AND operation_key = ?")
      .get(target.id, key) as unknown as IntentRow | undefined;
    if (existing) return existing.state === "accepted" ? null : existing;
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO publication_intents
           (id, target_id, project_id, operation_key, kind, state, request_json, attempts,
            remote_object_id, remote_url, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'create_pr', 'queued', ?, 0, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        `int_${target.id}_create`,
        target.id,
        target.project_id,
        key,
        JSON.stringify({
          candidateHeadSha: target.candidate_head_sha,
          sourceBranch: target.source_branch,
        }),
        now,
        now,
      );
    return this.db
      .prepare("SELECT * FROM publication_intents WHERE target_id = ? AND operation_key = ?")
      .get(target.id, key) as unknown as IntentRow;
  }

  private ensureSummaryIntent(target: TargetRow, hash: string): IntentRow | null {
    const key = `summary:${hash}`;
    const existing = this.db
      .prepare("SELECT * FROM publication_intents WHERE target_id = ? AND operation_key = ?")
      .get(target.id, key) as unknown as IntentRow | undefined;
    if (existing) return existing.state === "accepted" ? null : existing;
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO publication_intents
           (id, target_id, project_id, operation_key, kind, state, request_json, attempts,
            remote_object_id, remote_url, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'update_summary', 'queued', ?, 0, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        `int_${target.id}_summary_${hash}`,
        target.id,
        target.project_id,
        key,
        JSON.stringify({ hash }),
        now,
        now,
      );
    return this.db
      .prepare("SELECT * FROM publication_intents WHERE target_id = ? AND operation_key = ?")
      .get(target.id, key) as unknown as IntentRow;
  }

  private async executeCreateIntent(
    target: TargetRow,
    intent: IntentRow,
  ): Promise<PullRequestRow | null> {
    // A crash between claim and the remote call must not leave the intent stuck in
    // 'attempting'. Coerce it to explicit 'unknown' and reconcile by remote read-back
    // before any retry, exactly like event and summary intents.
    if (intent.state === "attempting") {
      this.db
        .prepare("UPDATE publication_intents SET state = 'unknown', updated_at = ? WHERE id = ?")
        .run(this.clock(), intent.id);
      intent = this.loadIntent(intent.id);
    }
    if (!this.claimIntent(intent)) {
      return this.activePullRequest(target);
    }
    const project = this.loadProject(target.project_id);
    const now = this.clock();
    try {
      this.assertCandidateCommitted(target, project);
      await this.ensureRemoteSourceRef(target, project);
      const remotePrs = await this.listRemotePullRequests(project.repo_name);
      const matching = remotePrs.find(
        (pr) =>
          String(pr.state).toUpperCase() === "OPEN" &&
          pr.head === target.source_branch &&
          pr.base === target.target_branch,
      );
      if (matching) {
        this.assertRemoteBinding(target, project, matching, true);
        const prior = this.activePullRequest(target);
        const existing = this.findPullRequestByNumber(target.id, matching.number);
        const supersede = prior && prior.id !== existing?.id ? prior : null;
        const pr = this.bindPullRequest(target, matching, intent.id, now, supersede);
        if (supersede) await this.retirePullRequest(target, supersede);
        this.acceptIntent(intent, String(matching.number), matching.html_url ?? null);
        return pr;
      }

      if (typeof this.forge.createPullRequest !== "function") {
        throw new PublicationError(
          "publication_transport_unsupported",
          "Forge transport does not support pull request creation",
        );
      }
      const body = this.initialPullRequestBody(target);
      const created = await this.forge.createPullRequest(project.repo_name, {
        title: this.pullRequestTitle(target),
        body,
        head: target.source_branch,
        base: target.target_branch,
        draft: true,
      });
      const readBack = await this.readRemotePullRequest(project.repo_name, created.number);
      const verified = readBack ?? created;
      this.assertRemoteBinding(target, project, verified, true);

      // Only retire a prior active PR after the replacement exists and its remote
      // head/base/repo binding has been read back successfully. A failed create or a
      // mismatched head leaves the delivery's previous live PR untouched.
      const prior = this.activePullRequest(target);
      const supersede = prior && prior.number !== verified.number ? prior : null;
      const pr = this.bindPullRequest(target, verified, intent.id, now, supersede);
      if (supersede) await this.retirePullRequest(target, supersede);
      this.acceptIntent(intent, String(verified.number), verified.html_url ?? null);
      return pr;
    } catch (caught) {
      const recovered = await this.recoverCreatedPullRequest(target, intent, project);
      if (recovered) return recovered;
      this.failIntent(intent, caught);
      return null;
    }
  }

  private async recoverCreatedPullRequest(
    target: TargetRow,
    intent: IntentRow,
    project: ProjectRow,
  ): Promise<PullRequestRow | null> {
    try {
      const remotePrs = await this.listRemotePullRequests(project.repo_name);
      const matching = remotePrs.find(
        (pr) =>
          String(pr.state).toUpperCase() === "OPEN" &&
          pr.head === target.source_branch &&
          pr.base === target.target_branch,
      );
      if (!matching) return null;
      this.assertRemoteBinding(target, project, matching, true);
      const prior = this.activePullRequest(target);
      const existing = this.findPullRequestByNumber(target.id, matching.number);
      const supersede = prior && prior.id !== existing?.id ? prior : null;
      const pr = this.bindPullRequest(target, matching, intent.id, this.clock(), supersede);
      if (supersede) await this.retirePullRequest(target, supersede);
      this.acceptIntent(intent, String(matching.number), matching.html_url ?? null);
      return pr;
    } catch {
      return null;
    }
  }

  /**
   * Push the exact committed branch candidate to the recorded remote and persist the
   * observed source ref. A push rejection, timeout or read-back mismatch fails closed;
   * a PR is never created against a branch that only exists locally.
   */
  private async ensureRemoteSourceRef(target: TargetRow, project: ProjectRow): Promise<void> {
    const ref = `refs/heads/${target.source_branch}`;
    const push = await this.gitRemote(
      ["push", "--porcelain", "origin", `${ref}:${ref}`],
      project.checkout_path,
    );
    if (push.timedOut) {
      throw new PublicationError(
        "publication_push_unknown",
        `git push ${ref} timed out; the remote outcome is unknown`,
      );
    }
    if (push.exitCode !== 0) {
      throw new PublicationError(
        "publication_push_failed",
        `git push ${ref} failed: ${(push.stderr || push.stdout).trim() || `exit ${push.exitCode}`}`,
      );
    }
    const listed = await this.gitRemote(["ls-remote", "origin", ref], project.checkout_path);
    if (listed.timedOut) {
      throw new PublicationError(
        "publication_remote_unverified",
        `git ls-remote ${ref} timed out; the remote source ref is unverified`,
      );
    }
    if (listed.exitCode !== 0) {
      throw new PublicationError(
        "publication_remote_unverified",
        `git ls-remote ${ref} failed: ${(listed.stderr || listed.stdout).trim() || `exit ${listed.exitCode}`}`,
      );
    }
    const entry = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(`\t${ref}`) || line.endsWith(` ${ref}`));
    const remoteSha = entry?.split(/\s+/)[0] ?? null;
    if (!remoteSha) {
      throw new PublicationError(
        "publication_remote_unverified",
        `Remote source ref ${ref} is missing after push`,
      );
    }
    if (remoteSha !== target.candidate_head_sha) {
      throw new PublicationError(
        "publication_remote_ref_mismatch",
        `Remote source ref ${ref} is ${remoteSha}, not the committed candidate ${target.candidate_head_sha}`,
      );
    }
    this.db
      .prepare(
        `UPDATE publication_targets
            SET remote_source_ref = ?, remote_source_sha = ?, remote_verified_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(ref, remoteSha, this.clock(), this.clock(), target.id);
  }

  /**
   * Validate the exact repository/head/base/headRefOid binding a transport reports.
   * A missing or advanced remote head is never treated as the local candidate.
   */
  private assertRemoteBinding(
    target: TargetRow,
    project: ProjectRow,
    remote: ForgePullRequest,
    requireOpen: boolean,
  ): void {
    const normalize = (value: string) =>
      value
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .toLowerCase();
    if (remote.repository && normalize(remote.repository) !== normalize(project.repo_name)) {
      throw new PublicationError(
        "publication_wrong_binding",
        `Remote PR #${remote.number} belongs to '${remote.repository}', not '${project.repo_name}'`,
      );
    }
    if (remote.head !== target.source_branch || remote.base !== target.target_branch) {
      throw new PublicationError(
        "publication_wrong_binding",
        `Remote PR #${remote.number} does not match source '${target.source_branch}' and target '${target.target_branch}'`,
        { head: remote.head, base: remote.base, state: remote.state },
      );
    }
    if (requireOpen && String(remote.state).toUpperCase() !== "OPEN") {
      throw new PublicationError(
        "publication_wrong_binding",
        `Remote PR #${remote.number} is '${remote.state}', not OPEN`,
      );
    }
    if (!remote.headRefOid) {
      throw new PublicationError(
        "publication_head_unverified",
        `Remote PR #${remote.number} did not report its head SHA; refusing to bind an unverified candidate`,
      );
    }
    if (remote.headRefOid !== target.candidate_head_sha) {
      throw new PublicationError(
        "publication_head_mismatch",
        `Remote PR #${remote.number} head ${remote.headRefOid} does not match the pushed candidate ${target.candidate_head_sha}`,
      );
    }
  }

  private remoteSourceVerified(target: TargetRow): boolean {
    return (
      target.remote_source_ref === `refs/heads/${target.source_branch}` &&
      target.remote_source_sha === target.candidate_head_sha
    );
  }

  private isBlockingRemoteError(error: string | null): boolean {
    return error === "remote_pull_request_unreadable" || error === RETIRE_FAILED;
  }

  private setTargetError(targetId: string, error: string | null): void {
    this.db
      .prepare("UPDATE publication_targets SET last_error = ?, updated_at = ? WHERE id = ?")
      .run(error, this.clock(), targetId);
  }

  /**
   * Retire a superseded remote PR only after the replacement exists. Retire failure is
   * durable and retried by reconciliation instead of silently leaving two live PRs.
   */
  private async retirePullRequest(target: TargetRow, pr: PullRequestRow): Promise<boolean> {
    if (pr.number === null) {
      this.db
        .prepare(
          "UPDATE publication_pull_requests SET remote_retired = 1, updated_at = ? WHERE id = ?",
        )
        .run(this.clock(), pr.id);
      return true;
    }
    if (typeof this.forge.updatePullRequest !== "function") {
      this.setTargetError(target.id, RETIRE_FAILED);
      return false;
    }
    const project = this.loadProject(target.project_id);
    try {
      await this.forge.updatePullRequest(project.repo_name, pr.number, { state: "closed" });
      this.db
        .prepare(
          "UPDATE publication_pull_requests SET remote_retired = 1, updated_at = ? WHERE id = ?",
        )
        .run(this.clock(), pr.id);
      return true;
    } catch {
      this.setTargetError(target.id, RETIRE_FAILED);
      return false;
    }
  }

  private async retireSupersededPullRequests(target: TargetRow): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT * FROM publication_pull_requests
          WHERE target_id = ? AND state = 'superseded' AND remote_retired = 0`,
      )
      .all(target.id) as unknown as PullRequestRow[];
    if (rows.length === 0) {
      if (target.last_error === RETIRE_FAILED) this.setTargetError(target.id, null);
      return;
    }
    for (const row of rows) {
      const retired = await this.retirePullRequest(target, row);
      if (!retired) return;
    }
    if (this.loadTarget(target.project_id, target.id).last_error === RETIRE_FAILED) {
      this.setTargetError(target.id, null);
    }
  }

  private findPullRequestByNumber(targetId: string, number: number): PullRequestRow | null {
    const row = this.db
      .prepare("SELECT * FROM publication_pull_requests WHERE target_id = ? AND number = ?")
      .get(targetId, number) as unknown as PullRequestRow | undefined;
    return row ?? null;
  }

  private async observeActivePullRequest(
    target: TargetRow,
    pr: PullRequestRow,
  ): Promise<PullRequestRow | null> {
    if (pr.number === null) return pr;
    const project = this.loadProject(target.project_id);
    let remote: ForgePullRequest | null;
    try {
      remote = await this.readRemotePullRequest(project.repo_name, pr.number);
    } catch {
      this.markTarget(target.id, "unknown", "remote_pull_request_unreadable");
      return null;
    }
    if (!remote) {
      this.db
        .prepare(
          "UPDATE publication_pull_requests SET active = 0, state = 'closed', updated_at = ? WHERE id = ?",
        )
        .run(this.clock(), pr.id);
      this.db
        .prepare(
          "UPDATE publication_targets SET active_pull_request_id = NULL, updated_at = ? WHERE id = ?",
        )
        .run(this.clock(), target.id);
      return null;
    }
    const state = String(remote.state).toUpperCase();
    const nextState = state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open";
    if (nextState === "open") {
      // A healthy read clears only the transport-unreadable marker. Durable
      // publication problems (failed retirement, head mismatch) stay visible until
      // reconciliation actually resolves them.
      this.db
        .prepare(
          "UPDATE publication_targets SET last_error = NULL, updated_at = ? WHERE id = ? AND last_error = 'remote_pull_request_unreadable'",
        )
        .run(this.clock(), target.id);
    }
    this.db
      .prepare(
        `UPDATE publication_pull_requests
            SET state = ?, head_branch = ?, base_branch = ?, head_ref_oid = ?, active = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        nextState,
        remote.head,
        remote.base,
        remote.headRefOid ?? null,
        nextState === "open" ? 1 : 0,
        this.clock(),
        pr.id,
      );
    if (nextState !== "open") {
      this.db
        .prepare(
          "UPDATE publication_targets SET active_pull_request_id = NULL, updated_at = ? WHERE id = ?",
        )
        .run(this.clock(), target.id);
      return null;
    }
    return this.loadPullRequest(pr.id);
  }

  private async executeEventIntent(
    target: TargetRow,
    pr: PullRequestRow,
    intent: IntentRow,
  ): Promise<void> {
    if (intent.state === "attempting") {
      this.db
        .prepare("UPDATE publication_intents SET state = 'unknown', updated_at = ? WHERE id = ?")
        .run(this.clock(), intent.id);
      intent = this.loadIntent(intent.id);
    }
    const event = this.loadEvent(JSON.parse(intent.request_json).eventId);
    if (!event) {
      this.failIntent(intent, new Error("publication event is missing"));
      return;
    }
    if (pr.number === null) {
      this.failIntent(intent, new Error("active pull request has no remote number"));
      return;
    }
    if (!this.claimIntent(intent)) return;

    const project = this.loadProject(target.project_id);
    const body = this.renderEventBody(intent.operation_key, event);
    const location = event.kind === "finding" ? this.findingLocation(event) : null;
    const marker = publicationMarker(intent.operation_key);

    try {
      if (location && typeof this.forge.createPullRequestReview === "function") {
        const valid = this.validDiffLine(target, project, location);
        if (valid) {
          try {
            const review = await this.forge.createPullRequestReview(project.repo_name, pr.number, {
              commitId: target.candidate_head_sha,
              body,
              event: "COMMENT",
              // Every outbound nested comment body crosses the same sanitizer as the
              // review body; raw event bodies may still carry secrets or local paths.
              comments: [
                { path: location.path, line: location.line, body: this.sanitize(event.body) },
              ],
            });
            this.acceptIntent(intent, review.id ?? null, review.html_url ?? null);
            return;
          } catch (reviewError) {
            const recovered = await this.recoverRemoteMarker(project, pr.number, marker, intent);
            if (recovered) return;
            void reviewError;
          }
        }
      }
      if (typeof this.forge.createIssueComment !== "function") {
        throw new PublicationError(
          "publication_transport_unsupported",
          "Forge transport does not support audit comments",
        );
      }
      const comment = await this.forge.createIssueComment(project.repo_name, pr.number, body);
      this.acceptIntent(intent, comment.id ?? null, null);
    } catch (caught) {
      const recovered = await this.recoverRemoteMarker(project, pr.number, marker, intent);
      if (recovered) return;
      this.failIntent(intent, caught);
    }
  }

  private async executeSummaryIntent(
    target: TargetRow,
    pr: PullRequestRow,
    intent: IntentRow,
  ): Promise<void> {
    if (intent.state === "attempting") {
      this.db
        .prepare("UPDATE publication_intents SET state = 'unknown', updated_at = ? WHERE id = ?")
        .run(this.clock(), intent.id);
      intent = this.loadIntent(intent.id);
    }
    if (!this.claimIntent(intent)) return;
    const project = this.loadProject(target.project_id);
    const hash = JSON.parse(intent.request_json).hash as string;
    const marker = publicationMarker(intent.operation_key);
    const summary = this.db
      .prepare("SELECT body FROM publication_summaries WHERE target_id = ?")
      .get(target.id) as { body: string } | undefined;
    if (!summary) {
      this.failIntent(intent, new Error("publication summary is missing"));
      return;
    }
    try {
      if (pr.number === null) throw new Error("active pull request has no remote number");
      if (typeof this.forge.updatePullRequest !== "function") {
        throw new PublicationError(
          "publication_transport_unsupported",
          "Forge transport does not support pull request body updates",
        );
      }
      const current = await this.readRemotePullRequest(project.repo_name, pr.number);
      if (!current) throw new Error("active pull request is no longer readable");
      let body: string;
      try {
        body = updatePrBodyEvidence(
          current.body ?? "",
          [EVIDENCE_SECTION_START, summary.body, EVIDENCE_SECTION_END].join("\n"),
        );
      } catch (caught) {
        if (caught instanceof AmbiguousEvidenceBoundaryError) {
          throw new PublicationError(
            "publication_summary_binding_ambiguous",
            "PR body no longer contains unambiguous evidence boundaries; refusing destructive update",
            { migrationPreview: caught.migrationPreview },
          );
        }
        throw caught;
      }
      if (!body.includes(marker)) {
        body = body.replace(EVIDENCE_SECTION_START, `${EVIDENCE_SECTION_START}\n${marker}`);
      }
      await this.forge.updatePullRequest(project.repo_name, pr.number, { body });
      const readBack = await this.readRemotePullRequest(project.repo_name, pr.number);
      if (!readBack || !(readBack.body ?? "").includes(marker)) {
        throw new Error("readback did not contain the publication summary marker");
      }
      this.acceptIntent(intent, null, null);
    } catch (caught) {
      const recovered = await this.recoverSummary(project, pr, marker, intent, hash);
      if (recovered) return;
      this.failIntent(intent, caught);
    }
  }

  private async recoverRemoteMarker(
    project: ProjectRow,
    prNumber: number,
    marker: string,
    intent: IntentRow,
  ): Promise<boolean> {
    try {
      if (typeof this.forge.listPullRequestReviews === "function") {
        const reviews = await this.forge.listPullRequestReviews(project.repo_name, prNumber);
        const found = reviews.find((review) => (review.body ?? "").includes(marker));
        if (found) {
          this.acceptIntent(intent, found.id ?? null, found.html_url ?? null);
          return true;
        }
      }
      if (typeof this.forge.getIssue === "function") {
        const issue = await this.forge.getIssue(project.repo_name, prNumber);
        const found = issue?.comments?.find((comment) => (comment.body ?? "").includes(marker));
        if (found) {
          this.acceptIntent(intent, found.id ?? null, null);
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private async recoverSummary(
    project: ProjectRow,
    pr: PullRequestRow,
    marker: string,
    intent: IntentRow,
    hash: string,
  ): Promise<boolean> {
    try {
      if (pr.number === null) return false;
      const current = await this.readRemotePullRequest(project.repo_name, pr.number);
      if (current && (current.body ?? "").includes(marker)) {
        this.acceptIntent(intent, null, null);
        return true;
      }
    } catch {
      return false;
    }
    void hash;
    return false;
  }

  private claimIntent(intent: IntentRow): boolean {
    if (intent.state === "accepted") return false;
    const result = this.db
      .prepare(
        `UPDATE publication_intents
            SET state = 'attempting', attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND state IN ('queued', 'failed', 'unknown')`,
      )
      .run(this.clock(), intent.id) as { changes: number };
    return result.changes > 0;
  }

  private acceptIntent(intent: IntentRow, remoteId: string | null, remoteUrl: string | null): void {
    this.db
      .prepare(
        `UPDATE publication_intents
            SET state = 'accepted', remote_object_id = ?, remote_url = ?, last_error = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(remoteId, remoteUrl, this.clock(), intent.id);
  }

  private failIntent(intent: IntentRow, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const state = isAmbiguousTransportError(error) ? "unknown" : "failed";
    this.db
      .prepare(
        "UPDATE publication_intents SET state = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(state, message, this.clock(), intent.id);
    this.markTarget(intent.target_id, state, message);
  }

  // -------------------------------------------------------------------------
  // Remote transport helpers
  // -------------------------------------------------------------------------

  private async listRemotePullRequests(repoName: string): Promise<ForgePullRequest[]> {
    if (typeof this.forge.listPullRequests !== "function") {
      throw new PublicationError(
        "publication_transport_unsupported",
        "Forge transport does not support pull request listing",
      );
    }
    return this.forge.listPullRequests(repoName);
  }

  private async readRemotePullRequest(
    repoName: string,
    number: number,
  ): Promise<ForgePullRequest | null> {
    if (typeof this.forge.getPullRequest !== "function") {
      throw new PublicationError(
        "publication_transport_unsupported",
        "Forge transport does not support pull request reads",
      );
    }
    return this.forge.getPullRequest(repoName, number);
  }

  private assertCandidateCommitted(target: TargetRow, project: ProjectRow): void {
    if (target.candidate_head_sha === target.base_sha) {
      throw new PublicationError(
        "publication_no_candidate",
        "No committed candidate change permits a draft pull request",
      );
    }
    try {
      this.gitRunner(
        ["cat-file", "-e", `${target.candidate_head_sha}^{commit}`],
        project.checkout_path,
      );
    } catch {
      throw new PublicationError(
        "publication_candidate_mismatch",
        `Candidate ${target.candidate_head_sha} is not a committed object`,
      );
    }
    let branchHead: string;
    try {
      branchHead = this.gitRunner(
        ["rev-parse", "--verify", `refs/heads/${target.source_branch}`],
        project.checkout_path,
      );
    } catch {
      throw new PublicationError(
        "publication_candidate_mismatch",
        `Source branch '${target.source_branch}' does not exist`,
      );
    }
    if (branchHead !== target.candidate_head_sha) {
      throw new PublicationError(
        "publication_candidate_mismatch",
        `Source branch '${target.source_branch}' points at ${branchHead}, not candidate ${target.candidate_head_sha}`,
      );
    }
  }

  private findingLocation(event: EventRow): { path: string; line: number } | null {
    const match = /^([^\s:]+):(\d+)$/.exec(
      event.body.match(/Location:\*{0,2}\s+`([^`]+)`/)?.[1] ?? "",
    );
    if (!match) return null;
    const line = Number(match[2]);
    if (!Number.isSafeInteger(line) || line <= 0) return null;
    return { path: match[1]!, line };
  }

  private validDiffLine(
    target: TargetRow,
    project: ProjectRow,
    location: { path: string; line: number },
  ): boolean {
    try {
      const diff = this.gitRunner(
        ["diff", "--unified=0", `${target.base_sha}..${target.candidate_head_sha}`],
        project.checkout_path,
      );
      const lines = extractValidDiffLines(diff);
      return Boolean(lines.get(location.path)?.has(location.line));
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  private loadProject(projectId: string): ProjectRow {
    const row = this.db
      .prepare("SELECT id, repo_name, checkout_path FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
    if (!row) {
      throw new PublicationError("publication_not_found", `Project ${projectId} not found`);
    }
    return row;
  }

  private loadTarget(projectId: string, targetId: string): TargetRow {
    const row = this.db
      .prepare("SELECT * FROM publication_targets WHERE project_id = ? AND id = ?")
      .get(projectId, targetId) as unknown as TargetRow | undefined;
    if (!row) {
      throw new PublicationError(
        "publication_target_not_found",
        `Publication target ${targetId} not found`,
      );
    }
    return row;
  }

  private loadIntent(intentId: string): IntentRow {
    return this.db
      .prepare("SELECT * FROM publication_intents WHERE id = ?")
      .get(intentId) as unknown as IntentRow;
  }

  private loadEvent(eventId: string): EventRow | null {
    const row = this.db
      .prepare("SELECT * FROM publication_events WHERE id = ?")
      .get(eventId) as unknown as EventRow | undefined;
    return row ?? null;
  }

  private listPullRequests(targetId: string): PublicationPullRequest[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM publication_pull_requests WHERE target_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(targetId) as unknown as PullRequestRow[];
    return rows.map((row) => this.mapPullRequest(row));
  }

  private listEvents(targetId: string): PublicationEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM publication_events WHERE target_id = ? ORDER BY sequence ASC")
      .all(targetId) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      targetId: row.target_id,
      projectId: row.project_id,
      sequence: row.sequence,
      workId: row.work_id,
      runId: row.run_id,
      lap: row.lap,
      candidateHeadSha: row.candidate_head_sha,
      observationId: row.observation_id,
      findingId: row.finding_id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      occurredAt: row.occurred_at,
    }));
  }

  private listIntents(targetId: string): PublicationIntentRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM publication_intents WHERE target_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(targetId) as unknown as IntentRow[];
    return rows.map((row) => ({
      id: row.id,
      targetId: row.target_id,
      projectId: row.project_id,
      operationKey: row.operation_key,
      kind: row.kind,
      state: row.state,
      attempts: row.attempts,
      remoteObjectId: row.remote_object_id,
      remoteUrl: row.remote_url,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private listBindings(targetId: string): PublicationEvidenceBinding[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM publication_evidence_bindings WHERE target_id = ? ORDER BY updated_at ASC",
      )
      .all(targetId) as unknown as BindingRow[];
    return rows.map((row) => ({
      id: row.id,
      targetId: row.target_id,
      projectId: row.project_id,
      artifactId: row.artifact_id,
      status: row.status,
      hostedUrl: row.hosted_url,
      updatedAt: row.updated_at,
    }));
  }

  private listTargetArtifacts(target: TargetRow): ArtifactRow[] {
    return this.db
      .prepare(
        `SELECT a.id, a.name, a.relative_path, a.media_type, a.size_bytes,
                a.digest_sha256, a.observation_id
           FROM execution_artifacts a
           JOIN execution_observations o ON o.id = a.observation_id
           JOIN dispatch_runs r ON r.id = o.run_id
          WHERE a.project_id = ? AND r.delivery_id = ? AND r.work_id = ?
          ORDER BY a.created_at ASC, a.id ASC`,
      )
      .all(target.project_id, target.delivery_id, target.work_id) as unknown as ArtifactRow[];
  }

  /**
   * Audit completeness requires every finalized artifact to have a currently valid
   * operator-supplied URL. A local path or an unsafe host is never counted as
   * externally accessible evidence.
   */
  private evidenceCompleteness(
    target: TargetRow,
    evidence: PublicationEvidenceBinding[],
  ): { pending: number; unsafe: number } {
    let pending = 0;
    let unsafe = 0;
    for (const artifact of this.listTargetArtifacts(target)) {
      const binding = evidence.find((item) => item.artifactId === artifact.id);
      if (!binding || binding.status !== "supplied_unverified" || !binding.hostedUrl) {
        pending += 1;
        continue;
      }
      if (!validateHostedAssetUrl(binding.hostedUrl).ok) unsafe += 1;
    }
    return { pending, unsafe };
  }

  private activePullRequest(target: TargetRow): PullRequestRow | null {
    if (!target.active_pull_request_id) return null;
    return this.loadPullRequest(target.active_pull_request_id);
  }

  private loadPullRequest(id: string): PullRequestRow | null {
    const row = this.db
      .prepare("SELECT * FROM publication_pull_requests WHERE id = ?")
      .get(id) as unknown as PullRequestRow | undefined;
    return row ?? null;
  }

  private bindPullRequest(
    target: TargetRow,
    remote: ForgePullRequest,
    intentId: string | null,
    now: number,
    supersede: PullRequestRow | null = null,
  ): PullRequestRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE publication_pull_requests SET active = 0, updated_at = ? WHERE target_id = ? AND active = 1",
        )
        .run(now, target.id);
      if (supersede && supersede.number !== remote.number) {
        this.db
          .prepare(
            "UPDATE publication_pull_requests SET state = 'superseded', remote_retired = 0, updated_at = ? WHERE id = ?",
          )
          .run(now, supersede.id);
      }
      const existing = this.db
        .prepare("SELECT * FROM publication_pull_requests WHERE target_id = ? AND number = ?")
        .get(target.id, remote.number) as unknown as PullRequestRow | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE publication_pull_requests
                SET active = 1, state = 'open', repository = ?, head_branch = ?, base_branch = ?,
                    candidate_head_sha = ?, head_ref_oid = ?, url = ?, remote_retired = 0,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(
            remote.repository ?? this.loadProject(target.project_id).repo_name,
            remote.head,
            remote.base,
            target.candidate_head_sha,
            remote.headRefOid ?? null,
            remote.html_url ?? existing.url,
            now,
            existing.id,
          );
        this.db
          .prepare(
            "UPDATE publication_targets SET active_pull_request_id = ?, state = 'publishing', last_error = NULL, updated_at = ? WHERE id = ?",
          )
          .run(existing.id, now, target.id);
        this.db.exec("COMMIT");
        return this.loadPullRequest(existing.id)!;
      }
      const prId = `pr_${target.id}_${remote.number}`;
      this.db
        .prepare(
          `INSERT INTO publication_pull_requests
             (id, target_id, project_id, repository, number, url, head_branch, base_branch,
              candidate_head_sha, head_ref_oid, draft, state, active, created_by_intent,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', 1, ?, ?, ?)`,
        )
        .run(
          prId,
          target.id,
          target.project_id,
          remote.repository ?? this.loadProject(target.project_id).repo_name,
          remote.number,
          remote.html_url ??
            `https://github.com/${this.loadProject(target.project_id).repo_name}/pull/${remote.number}`,
          remote.head,
          remote.base,
          target.candidate_head_sha,
          remote.headRefOid ?? null,
          intentId,
          now,
          now,
        );
      this.db
        .prepare(
          "UPDATE publication_targets SET active_pull_request_id = ?, state = 'publishing', last_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(prId, now, target.id);
      this.db.exec("COMMIT");
      return this.loadPullRequest(prId)!;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private markTarget(targetId: string, state: TargetRow["state"], error: string | null): void {
    this.db
      .prepare(
        "UPDATE publication_targets SET state = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(state, error, this.clock(), targetId);
  }

  private refreshTargetState(targetId: string): void {
    const target = this.db
      .prepare("SELECT * FROM publication_targets WHERE id = ?")
      .get(targetId) as unknown as TargetRow | undefined;
    if (!target) return;
    const intents = this.listIntents(targetId);
    const events = this.listEvents(targetId);
    const pullRequests = this.listPullRequests(targetId);
    const activePr = pullRequests.find((pr) => pr.active) ?? null;
    const unknown = intents.filter((intent) => intent.state === "unknown").length;
    const failed = intents.filter((intent) => intent.state === "failed").length;
    const eventIntents = intents.filter((intent) => intent.kind === "publish_event");
    const summary = this.renderSummary(
      target,
      pullRequests,
      events,
      this.listBindings(targetId),
      intents,
    );
    const summaryAccepted = intents.some(
      (intent) =>
        intent.kind === "update_summary" &&
        intent.operationKey === `summary:${summary.hash}` &&
        intent.state === "accepted",
    );
    const allEventsAccepted = eventIntents.every((intent) => intent.state === "accepted");
    const evidenceState = this.evidenceCompleteness(target, this.listBindings(targetId));
    const remoteStale = Boolean(
      activePr &&
      (activePr.headRefOid !== target.candidate_head_sha ||
        activePr.baseBranch !== target.target_branch ||
        activePr.headBranch !== target.source_branch),
    );
    const latestPr = pullRequests.length > 0 ? pullRequests[pullRequests.length - 1]! : null;
    const mergedBoundPr =
      !activePr &&
      latestPr !== null &&
      latestPr.state === "merged" &&
      latestPr.candidateHeadSha === target.candidate_head_sha &&
      latestPr.headBranch === target.source_branch &&
      latestPr.baseBranch === target.target_branch;
    let state: TargetRow["state"];
    if (target.state === "no_candidate") {
      state = "no_candidate";
    } else if (this.isBlockingRemoteError(target.last_error)) {
      state = "unknown";
    } else if (remoteStale) {
      state = "unknown";
    } else if (unknown > 0) {
      state = "unknown";
    } else if (failed > 0) {
      state = "failed";
    } else if (
      activePr &&
      allEventsAccepted &&
      summaryAccepted &&
      this.remoteSourceVerified(target) &&
      evidenceState.pending === 0 &&
      evidenceState.unsafe === 0
    ) {
      state = "published";
    } else if (mergedBoundPr && target.state === "published") {
      // The published audit remains a real historical fact after the operator
      // merges the PR; a post-merge summary refresh must not demote the target.
      state = "published";
    } else if (activePr) {
      state = "publishing";
    } else {
      state = "ready";
    }
    if (state !== target.state) {
      this.markTarget(targetId, state, target.last_error);
    }
  }

  private persistSummary(target: TargetRow, body: string): void {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO publication_summaries (target_id, project_id, body, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(target_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(target.id, target.project_id, body, now);
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private pullRequestTitle(target: TargetRow): string {
    const title = this.db
      .prepare(
        `SELECT source_title FROM work_revisions WHERE work_id = ?
         ORDER BY revision_number DESC LIMIT 1`,
      )
      .get(target.work_id) as { source_title: string } | undefined;
    return `#${target.issue_number} ${title?.source_title ?? "delivery"}`;
  }

  private initialPullRequestBody(target: TargetRow): string {
    const rootIssue = this.planRootIssue(target.plan_id);
    const relation =
      target.gate_profile === "child" && rootIssue && rootIssue !== target.issue_number
        ? `Part of #${rootIssue}`
        : `Closes #${target.issue_number}`;
    const summary = this.renderSummary(
      target,
      this.listPullRequests(target.id),
      this.listEvents(target.id),
      this.listBindings(target.id),
      this.listIntents(target.id),
    );
    return [
      relation,
      "",
      "## Summary",
      "",
      `Draft delivery PR for ticket #${target.issue_number} at candidate \`${target.candidate_head_sha}\`.`,
      "",
      "## Evidence",
      "",
      [EVIDENCE_SECTION_START, summary.body, EVIDENCE_SECTION_END].join("\n"),
      "",
    ].join("\n");
  }

  private planRootIssue(planId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT w.issue_number FROM plans p
          JOIN work_items w ON w.id = p.root_work_id
         WHERE p.id = ?`,
      )
      .get(planId) as { issue_number: number } | undefined;
    return row?.issue_number ?? null;
  }

  private renderEventBody(operationKey: string, event: EventRow): string {
    const raw = [
      publicationMarker(operationKey),
      `### ${event.title}`,
      "",
      `**Ticket:** #${event.work_id ? (this.issueForWork(event.work_id) ?? "?") : "?"}`,
      `**Work:** \`${event.work_id}\` · **Lap:** ${event.lap ?? "n/a"} · **Candidate:** \`${event.candidate_head_sha}\``,
      `**Kind:** ${event.kind} · **Severity:** ${event.severity} · **Observed:** ${new Date(event.occurred_at).toISOString()}`,
      "",
      event.body,
    ].join("\n");
    return this.sanitize(raw);
  }

  private issueForWork(workId: string): number | null {
    const row = this.db.prepare("SELECT issue_number FROM work_items WHERE id = ?").get(workId) as
      | { issue_number: number }
      | undefined;
    return row?.issue_number ?? null;
  }

  private sanitize(value: string): string {
    const sanitized = this.sanitizer.sanitizeMarkdown(value).report;
    return localPathSanitize(sanitized);
  }

  private renderSummary(
    target: TargetRow,
    pullRequests: PublicationPullRequest[],
    events: PublicationEventRecord[],
    evidence: PublicationEvidenceBinding[],
    intents: PublicationIntentRecord[],
  ): { body: string; hash: string } {
    const activePr = pullRequests.find((pr) => pr.active) ?? null;
    const queuedEvents = events.filter((event) => {
      const intent = intents.find((item) => item.operationKey === `event:${event.id}`);
      return intent && intent.state !== "accepted";
    });
    const failed = intents.filter((intent) => intent.state === "failed").length;
    const unknown = intents.filter((intent) => intent.state === "unknown").length;
    const evidenceState = this.evidenceCompleteness(target, evidence);
    const auditStatus =
      activePr &&
      queuedEvents.length === 0 &&
      failed === 0 &&
      unknown === 0 &&
      this.remoteSourceVerified(target) &&
      evidenceState.pending === 0 &&
      evidenceState.unsafe === 0
        ? "complete"
        : "incomplete";

    const observations = this.db
      .prepare(
        `SELECT o.id, o.run_id, o.lap, o.stage, o.status, o.candidate_head_sha,
                o.producer_id, o.producer_role, o.created_at
           FROM execution_observations o
           JOIN dispatch_runs r ON r.id = o.run_id
          WHERE o.project_id = ? AND r.delivery_id = ? AND r.work_id = ?
          ORDER BY o.created_at ASC, o.id ASC`,
      )
      .all(target.project_id, target.delivery_id, target.work_id) as unknown as ObservationRow[];
    const findings = this.db
      .prepare(
        `SELECT id, summary, severity, status, issue_number, ac_key, file_context
           FROM factory_findings
          WHERE project_id = ? AND delivery_id = ? AND work_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(target.project_id, target.delivery_id, target.work_id) as unknown as FindingRow[];
    const artifacts = this.db
      .prepare(
        `SELECT a.id, a.name, a.relative_path, a.media_type, a.size_bytes,
                a.digest_sha256, a.observation_id
           FROM execution_artifacts a
           JOIN execution_observations o ON o.id = a.observation_id
           JOIN dispatch_runs r ON r.id = o.run_id
          WHERE a.project_id = ? AND r.delivery_id = ? AND r.work_id = ?
          ORDER BY a.created_at ASC, a.id ASC`,
      )
      .all(target.project_id, target.delivery_id, target.work_id) as unknown as ArtifactRow[];

    const lines: string[] = [
      `**Ticket:** #${target.issue_number} · **Work:** \`${target.work_id}\` · **Profile:** ${target.gate_profile}`,
      `**Candidate:** \`${target.candidate_head_sha}\` · **Base:** \`${target.base_sha}\``,
      `**Source → target:** \`${target.source_branch}\` → \`${target.target_branch}\``,
      `**Audit status:** ${auditStatus}`,
      activePr
        ? `**Pull request:** [#${activePr.number}](${activePr.url}) (${activePr.draft ? "draft" : "ready"})`
        : "**Pull request:** none yet — audit events are queued until a real candidate PR exists.",
      "",
    ];

    if (failed > 0 || unknown > 0) {
      lines.push(
        `> Publication sync: failed=${failed} unknown=${unknown}. This is a publication problem, not a verification result.`,
        "",
      );
    }
    if (queuedEvents.length > 0) {
      lines.push(`> ${queuedEvents.length} audit event(s) remain queued for publication.`, "");
    }

    lines.push("#### Current stage results", "");
    if (observations.length === 0) {
      lines.push("No candidate-bound stage observations recorded.", "");
    } else {
      lines.push(
        "| Stage | Status | Lap | Producer | Candidate |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const observation of observations) {
        lines.push(
          `| ${escapeMarkdownTableCell(observation.stage)} | ${escapeMarkdownTableCell(observation.status)} | ${observation.lap} | ${escapeMarkdownTableCell(observation.producer_id)} (${escapeMarkdownTableCell(observation.producer_role)}) | \`${observation.candidate_head_sha}\` |`,
        );
      }
      lines.push("");
    }

    lines.push("#### Findings", "");
    if (findings.length === 0) {
      lines.push("No factory findings recorded.", "");
    } else {
      lines.push(
        "| Severity | Status | Ticket | AC | Location | Summary |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      for (const finding of findings) {
        lines.push(
          `| ${finding.severity} | ${finding.status} | #${finding.issue_number} | ${escapeMarkdownTableCell(finding.ac_key ?? "-")} | ${escapeMarkdownTableCell(finding.file_context)} | ${escapeMarkdownTableCell(finding.summary)} |`,
        );
      }
      lines.push("");
    }

    lines.push("#### Evidence artifacts", "");
    if (artifacts.length === 0) {
      lines.push("No finalized artifacts recorded.", "");
    } else {
      lines.push(
        "| Artifact | Media | Size | SHA-256 | Hosted access |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const artifact of artifacts) {
        const binding = evidence.find((item) => item.artifactId === artifact.id);
        const hostedCheck = binding?.hostedUrl ? validateHostedAssetUrl(binding.hostedUrl) : null;
        const access =
          binding?.hostedUrl && hostedCheck?.ok
            ? `[supplied by operator](<${binding.hostedUrl}>) *(supplied unverified)*`
            : "manual upload pending";
        lines.push(
          `| ${escapeMarkdownTableCell(artifact.name)} | ${escapeMarkdownTableCell(artifact.media_type)} | ${artifact.size_bytes}B | \`${artifact.digest_sha256.slice(0, 16)}…\` | ${access} |`,
        );
      }
      lines.push("");
    }

    lines.push("#### Audit history", "");
    if (events.length === 0) {
      lines.push("No consequential audit events recorded yet.", "");
    } else {
      lines.push(
        "| # | Kind | Severity | Lap | Candidate | State | Title |",
        "| --- | --- | --- | --- | --- | --- | --- |",
      );
      for (const event of events) {
        const intent = intents.find((item) => item.operationKey === `event:${event.id}`);
        lines.push(
          `| ${event.sequence} | ${event.kind} | ${event.severity} | ${event.lap ?? "-"} | \`${event.candidateHeadSha}\` | ${intent?.state ?? "queued"} | ${escapeMarkdownTableCell(event.title)} |`,
        );
      }
      lines.push("");
      const failedHistory = events.filter(
        (event) => event.kind === "verification_failure" || event.kind === "recheck_failed",
      );
      if (failedHistory.length > 0) {
        lines.push("Failed results are retained above; a later pass does not rewrite them.", "");
      }
    }

    const raw = lines.join("\n").trim();
    const body = this.sanitize(raw);
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    return { body, hash };
  }

  private mapTarget(row: TargetRow): PublicationTarget {
    return {
      id: row.id,
      projectId: row.project_id,
      deliveryId: row.delivery_id,
      planId: row.plan_id,
      workId: row.work_id,
      issueNumber: row.issue_number,
      gateProfile: row.gate_profile,
      sourceBranch: row.source_branch,
      targetBranch: row.target_branch,
      candidateHeadSha: row.candidate_head_sha,
      baseSha: row.base_sha,
      remoteSourceRef: row.remote_source_ref,
      remoteSourceSha: row.remote_source_sha,
      remoteVerifiedAt: row.remote_verified_at,
      state: row.state,
      activePullRequestId: row.active_pull_request_id,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapPullRequest(row: PullRequestRow): PublicationPullRequest {
    return {
      id: row.id,
      targetId: row.target_id,
      projectId: row.project_id,
      repository: row.repository,
      number: row.number,
      url: row.url,
      headBranch: row.head_branch,
      baseBranch: row.base_branch,
      candidateHeadSha: row.candidate_head_sha,
      headRefOid: row.head_ref_oid,
      draft: row.draft === 1,
      state: row.state,
      active: row.active === 1,
      createdByIntent: row.created_by_intent,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
