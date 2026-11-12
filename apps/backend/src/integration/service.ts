import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AcceptanceDecision,
  type ChildIntegration,
  type IntegrationBlocker,
  type IntegrationStatus,
  type IntegrationStatusList,
  type PlanGateProfile,
  type PublicationStatus,
  type RequiredCheck,
  type IntegrationEvent,
} from "@animus/contracts/operator";
import {
  SerializedIntegrationManager,
  acquireCrossProcessIntegrationLock,
} from "../coordination/integration";
import type { ExecutionObservationService } from "../evidence/observations";
import { enqueuePublicationEvent } from "../publication/outbox";
import type { PublicationService } from "../publication/service";
import type { ForgeAdapter, ForgePullRequest } from "../registry/forge";
import { readRequiredChecks } from "../registry/required-checks";
import {
  InstallationHeldError,
  assertInstallationNotHeld,
} from "@animus/contracts/installation-hold";
import { assertExternalWriterAllowed } from "../authority/guard";
import { IntegrationError, type IntegrationErrorCode } from "./errors";

const execFileAsync = promisify(execFile);

export interface IntegrationRemoteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type IntegrationRemoteRunner = (
  args: string[],
  cwd: string,
) => Promise<IntegrationRemoteResult>;

export interface ChildIntegrationServiceOptions {
  observations?: ExecutionObservationService;
  publication?: PublicationService;
  forge?: ForgeAdapter;
  gitRunner?: (cmd: string[], options: { cwd: string }) => string;
  remoteRunner?: IntegrationRemoteRunner;
  clock?: () => number;
  /** Cross-process integration lock wait before failing closed. */
  lockTimeoutMs?: number;
  /**
   * Read the current Stop/hold control for the run's budget scope. A Stop issued
   * while the pre-merge remote reads are in flight must block the merge.
   */
  readControl?: (run: {
    projectId: string;
    deliveryId: string;
    workId: string;
  }) => { status: string } | null;
}

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
  state: string;
  branch: string;
  base_sha: string;
  head_sha: string | null;
  lap: number;
  checkout_path: string;
  repo_name: string;
  delivery_kind: "standalone" | "spec";
  delivery_branch: string;
  integration_branch: string | null;
}

interface IntegrationRow {
  id: string;
  project_id: string;
  delivery_id: string;
  plan_id: string;
  work_id: string;
  run_id: string;
  issue_number: number;
  source_branch: string;
  target_branch: string;
  candidate_head_sha: string;
  base_sha: string;
  target_tip_before_sha: string;
  target_tip_after_sha: string;
  merge_sha: string;
  remote_pull_request_number: number;
  remote_pull_request_url: string | null;
  evidence_identity: string;
  integrated_at: number;
}

interface EventRow {
  id: string;
  project_id: string;
  run_id: string;
  kind: "blocked" | "merged" | "reconciled";
  candidate_head_sha: string;
  target_tip_sha: string;
  merge_sha: string | null;
  reasons: string;
  created_at: number;
}

interface CheckResult {
  checks: RequiredCheck[];
  blockers: IntegrationBlocker[];
}

function defaultGitRunner(cmd: string[], options: { cwd: string }): string {
  return execFileSync("git", cmd, {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const defaultRemoteRunner: IntegrationRemoteRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout.trim() : "",
      stderr:
        typeof error?.stderr === "string" && error.stderr.trim() !== ""
          ? error.stderr.trim()
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
};

function dedupeBlockers(blockers: IntegrationBlocker[]): IntegrationBlocker[] {
  const seen = new Set<string>();
  const result: IntegrationBlocker[] = [];
  for (const blocker of blockers) {
    const key = `${blocker.code}:${blocker.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(blocker);
  }
  return result;
}

/**
 * Drives one approved child from its frozen plan to a *verified* merge in the
 * designated spec integration branch.
 *
 * It composes existing durable mechanisms instead of adding a second engine:
 * dispatch runs, candidate-bound evidence, the publication outbox/PR transport,
 * the cross-process integration lock and git ref compare-and-swap. Merge itself
 * is performed by the configured forge (so GitHub protections still apply); the
 * service only records completion after re-reading the remote target and proving
 * the candidate is included in that lineage.
 */
export class ChildIntegrationService {
  private readonly observations: ExecutionObservationService;
  private readonly publication: PublicationService;
  private readonly forge: ForgeAdapter;
  private readonly gitRunner: (cmd: string[], options: { cwd: string }) => string;
  private readonly remoteRunner: IntegrationRemoteRunner;
  private readonly clock: () => number;
  private readonly lockTimeoutMs: number;
  private readonly mergeManager: SerializedIntegrationManager;
  private readonly readControl:
    | ((run: {
        projectId: string;
        deliveryId: string;
        workId: string;
      }) => { status: string } | null)
    | null;

  constructor(
    private readonly db: DatabaseSync,
    options: ChildIntegrationServiceOptions & {
      observations: ExecutionObservationService;
      publication: PublicationService;
      forge: ForgeAdapter;
    },
  ) {
    this.observations = options.observations;
    this.publication = options.publication;
    this.forge = options.forge;
    this.gitRunner = options.gitRunner ?? defaultGitRunner;
    this.remoteRunner = options.remoteRunner ?? defaultRemoteRunner;
    this.clock = options.clock ?? (() => Date.now());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
    this.mergeManager = new SerializedIntegrationManager(this.gitRunner);
    this.readControl = options.readControl ?? null;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getStatus(projectId: string, runId: string): IntegrationStatus {
    const run = this.loadRun(projectId, runId);
    const integration = this.loadIntegration(projectId, run.id);
    const events = this.listEvents(projectId, run.id);
    const acceptance = this.observations.evaluateAcceptance(projectId, run.id);
    const publication = this.safePublication(projectId, run.id);
    const blockers = this.localBlockers(run, acceptance);
    return this.buildStatus(run, {
      state: integration
        ? "integrated"
        : publication?.target.state === "unknown"
          ? "unknown"
          : blockers.length > 0
            ? "blocked"
            : "ready",
      blockers,
      acceptance,
      publication,
      checks: [],
      integration,
      events,
    });
  }

  listStatuses(
    projectId: string,
    query: { workId?: string; deliveryId?: string; planId?: string } = {},
  ): IntegrationStatusList {
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
    if (query.planId) {
      clauses.push("plan_id = ?");
      params.push(query.planId);
    }
    const rows = this.db
      .prepare(
        `SELECT id FROM dispatch_runs WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...(params as never[])) as Array<{ id: string }>;
    return rows.map((row) => this.getStatus(projectId, row.id));
  }

  // -------------------------------------------------------------------------
  // Land
  // -------------------------------------------------------------------------

  async land(
    projectId: string,
    runId: string,
    submission: { actor?: string; reason?: string } = {},
  ): Promise<IntegrationStatus> {
    this.assertInstallationReady();
    const run = this.loadRun(projectId, runId);
    this.assertChildProfile(run);

    const existing = this.loadIntegration(projectId, run.id);
    if (existing) {
      return this.getStatus(projectId, run.id);
    }

    const release = await acquireCrossProcessIntegrationLock(
      run.checkout_path,
      this.gitRunner,
      this.lockTimeoutMs,
    );
    try {
      const targetBefore = await this.ensureTarget(run);
      await this.syncLocalTarget(run, targetBefore);

      const publication: PublicationStatus | null = null;
      const acceptance = this.observations.evaluateAcceptance(projectId, run.id);

      // A child ticket has no pull request of its own. Its branch is pushed so the
      // required checks can report on the commit; the merge itself is a local
      // compare-and-swap under the cross-process lock, then pushed.
      const pushBlocker = await this.pushCandidateBranch(run);
      if (pushBlocker) {
        return await this.block(
          run,
          [pushBlocker],
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }

      // Distinguish a real content conflict from mere stale evidence: both hold,
      // but the operator needs the precise reason to reverify or rebase.
      if (!acceptance.authorized) {
        const conflict = this.probeMerge(run, targetBefore);
        if (conflict) {
          return await this.block(
            run,
            [
              {
                code: "integration_conflict",
                message: `Candidate ${run.head_sha} does not merge cleanly into ${run.target_branch}`,
                details: { detail: conflict, acceptanceReasons: acceptance.reasons },
              },
            ],
            acceptance,
            publication,
            targetBefore,
            submission,
          );
        }
      }

      const blockers = this.localBlockers(run, acceptance);
      if (blockers.length > 0) {
        return await this.block(run, blockers, acceptance, publication, targetBefore, submission);
      }

      const checks = await this.requiredChecks(run);
      if (checks.blockers.length > 0) {
        return await this.block(
          run,
          checks.blockers,
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }

      const remoteNow = await this.readRemoteTarget(run);
      if (remoteNow === null) {
        return await this.block(
          run,
          [
            {
              code: "integration_target_missing",
              message: `Integration branch ${run.target_branch} is not present on the remote`,
            },
          ],
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }
      if (remoteNow !== targetBefore) {
        return await this.block(
          run,
          [
            {
              code: "integration_target_drift",
              message: `Integration branch ${run.target_branch} advanced during preflight`,
              details: { expected: targetBefore, actual: remoteNow },
            },
          ],
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }

      const conflict = this.probeMerge(run, targetBefore);
      if (conflict) {
        return await this.block(
          run,
          [
            {
              code: "integration_conflict",
              message: `Candidate ${run.head_sha} does not merge cleanly into ${run.target_branch}`,
              details: { detail: conflict },
            },
          ],
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }

      let mergeSha: string | null = null;
      let effectiveChecks = checks;
      try {
        // Re-check immediately before the forge merge; the fence may have been set
        // while the earlier verification/awaits were in flight.
        this.assertInstallationReady();

        // Refresh every local candidate-bound gate after the remote/CI/target
        // awaits. A late failed/inconclusive review, a revoked authorization, an
        // exhausted budget, a new finding, an incomplete audit or a changed
        // artifact must invalidate the merge before any forge effect. Acceptance
        // was snapshotted before those awaits; re-read the latest result now.
        //
        // Order matters: read the target FIRST, then CI, then acceptance, then the
        // Stop control. A CI conclusion that changes while the target is read is
        // observed by the later read; a late review/Stop that lands during the
        // final target read is observed by the acceptance/control re-checks below.
        const freshRemoteTarget = await this.readRemoteTarget(run);
        const freshChecks = await this.requiredChecks(run);
        const freshBlockerList: IntegrationBlocker[] = [];
        if (freshRemoteTarget === null || freshRemoteTarget !== targetBefore) {
          freshBlockerList.push({
            code: "integration_target_drift",
            message: `Integration branch ${run.target_branch} changed before the merge effect`,
            details: { expected: targetBefore, actual: freshRemoteTarget },
          });
        }
        freshBlockerList.push(...freshChecks.blockers);

        const freshAcceptance = this.observations.evaluateAcceptance(projectId, run.id);
        const freshPublication = this.safePublication(projectId, run.id);
        if (freshAcceptance.candidateHeadSha !== run.head_sha) {
          freshBlockerList.push({
            code: "integration_candidate_mismatch",
            message: `Candidate ${freshAcceptance.candidateHeadSha} no longer matches ${run.head_sha}`,
          });
        }
        if (freshAcceptance.targetTipSha && freshAcceptance.targetTipSha !== targetBefore) {
          freshBlockerList.push({
            code: "integration_target_drift",
            message: `Acceptance target tip ${freshAcceptance.targetTipSha} no longer matches ${targetBefore}`,
          });
        }
        freshBlockerList.push(...this.localBlockers(run, freshAcceptance));

        // A Stop issued during the pre-merge awaits must block the merge too.
        const control = this.readControl?.({
          projectId: run.project_id,
          deliveryId: run.delivery_id,
          workId: run.work_id,
        });
        if (
          control &&
          (control.status === "held" ||
            control.status === "stopping" ||
            control.status === "stopped")
        ) {
          freshBlockerList.push({
            code: "integration_stopped",
            message: `A Stop control (${control.status}) was set before the merge effect`,
          });
        }

        if (freshBlockerList.length > 0) {
          return await this.block(
            run,
            freshBlockerList,
            freshAcceptance,
            freshPublication,
            targetBefore,
            submission,
          );
        }

        effectiveChecks = freshChecks;
        this.assertInstallationReady();
        const merged = this.mergeManager.mergeSerializedWhileLocked({
          repoRoot: run.checkout_path,
          integrationBranch: run.target_branch,
          expectedIntegrationSha: targetBefore,
          childBranch: run.branch,
          childIssueNumber: run.issue_number,
          childHeadSha: run.head_sha!,
          gitRunner: this.gitRunner,
        });
        mergeSha = merged.newSha;
      } catch (error) {
        return await this.block(
          run,
          [
            {
              code:
                error instanceof IntegrationError
                  ? "integration_merge_rejected"
                  : "integration_merge_unknown",
              message: `Child merge into ${run.target_branch} was not applied: ${this.message(error)}`,
            },
          ],
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }

      if (!mergeSha) {
        return await this.block(
          run,
          [
            {
              code: "integration_merge_unknown",
              message: `Child merge into ${run.target_branch} produced no merge commit`,
            },
          ],
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }

      // The merge commit only counts once the remote integration lineage contains it.
      const pushed = await this.remoteRunner(
        ["push", "origin", `refs/heads/${run.target_branch}:refs/heads/${run.target_branch}`],
        run.checkout_path,
      );
      if (pushed.exitCode !== 0) {
        return await this.block(
          run,
          [
            {
              code: "integration_merge_unknown",
              message: `Integration branch ${run.target_branch} could not be pushed: ${
                (pushed.stderr || pushed.stdout).trim() || `exit ${pushed.exitCode}`
              }`,
            },
          ],
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }
      const targetAfter = await this.readRemoteTarget(run);
      if (!targetAfter || !this.isAncestor(run, mergeSha, targetAfter)) {
        return await this.block(
          run,
          [
            {
              code: "integration_merge_unknown",
              message: `Merge ${mergeSha} is not included in the remote ${run.target_branch} lineage`,
            },
          ],
          acceptance,
          publication,
          targetBefore,
          submission,
        );
      }
      await this.syncLocalTarget(run, targetAfter);

      const recorded = this.recordIntegration(run, {
        acceptance,
        mergeSha,
        targetBefore,
        targetAfter,
        remotePullRequest: null,
        targetId: null,
        pullRequestId: null,
        actor: submission.actor ?? "operator",
        reconciliation: false,
      });

      return this.buildStatus(run, {
        state: "integrated",
        blockers: [],
        acceptance,
        publication,
        checks: effectiveChecks.checks,
        integration: recorded,
        events: this.listEvents(run.project_id, run.id),
      });
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Completion verification and durable recording
  // -------------------------------------------------------------------------

  private recordIntegration(
    run: RunRow,
    details: {
      acceptance: AcceptanceDecision;
      mergeSha: string;
      targetBefore: string;
      targetAfter: string;
      remotePullRequest: ForgePullRequest | null;
      targetId: string | null;
      pullRequestId: string | null;
      actor: string;
      reconciliation: boolean;
    },
  ): ChildIntegration {
    const now = this.clock();
    const id = `integ_${randomUUID()}`;
    const evidenceIdentity = `${details.acceptance.integrationLineage}#${run.head_sha}#lap${run.lap}`;
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db
          .prepare(
            `INSERT INTO delivery_merges
               (id, project_id, delivery_id, plan_id, work_id, run_id, gate_profile, issue_number,
                target_id, pull_request_id, repository, pr_number, pr_url, source_branch,
                target_branch, candidate_head_sha, base_sha, target_tip_before_sha,
                target_tip_after_sha, remote_head_ref_oid, merge_sha, evidence_identity,
                verified_at, verified_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'child', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, delivery_id, work_id, target_branch)
               WHERE gate_profile = 'child' DO UPDATE SET
               id = excluded.id,
               run_id = excluded.run_id,
               issue_number = excluded.issue_number,
               target_id = excluded.target_id,
               pull_request_id = excluded.pull_request_id,
               source_branch = excluded.source_branch,
               candidate_head_sha = excluded.candidate_head_sha,
               base_sha = excluded.base_sha,
               target_tip_before_sha = excluded.target_tip_before_sha,
               target_tip_after_sha = excluded.target_tip_after_sha,
               remote_head_ref_oid = excluded.remote_head_ref_oid,
               merge_sha = excluded.merge_sha,
               repository = excluded.repository,
               pr_number = excluded.pr_number,
               pr_url = excluded.pr_url,
               evidence_identity = excluded.evidence_identity,
               verified_at = excluded.verified_at,
               verified_by = excluded.verified_by,
               created_at = excluded.created_at`,
          )
          .run(
            id,
            run.project_id,
            run.delivery_id,
            run.plan_id,
            run.work_id,
            run.id,
            run.issue_number,
            details.targetId,
            details.pullRequestId,
            run.repo_name,
            details.remotePullRequest?.number ?? null,
            details.remotePullRequest?.html_url ?? null,
            run.branch,
            run.target_branch,
            run.head_sha!,
            run.base_sha,
            details.targetBefore,
            details.targetAfter,
            run.head_sha!,
            details.mergeSha,
            evidenceIdentity,
            now,
            details.actor,
            now,
          );

        this.db
          .prepare(
            `INSERT INTO project_issue_integrations
               (project_id, issue_number, branch, commit_sha, integrated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(project_id, issue_number) DO UPDATE SET
               branch = excluded.branch,
               commit_sha = excluded.commit_sha,
               integrated_at = excluded.integrated_at`,
          )
          .run(
            run.project_id,
            run.issue_number,
            run.branch,
            details.mergeSha,
            new Date(now).toISOString(),
          );

        this.db
          .prepare(
            `INSERT INTO delivery_events
               (id, project_id, delivery_id, plan_id, work_id, run_id, kind, candidate_head_sha,
                target_tip_sha, merge_sha, reasons, detail, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'merged', ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            `ievt_${randomUUID()}`,
            run.project_id,
            run.delivery_id,
            run.plan_id,
            run.work_id,
            run.id,
            run.head_sha!,
            details.targetAfter,
            details.mergeSha,
            JSON.stringify([
              details.reconciliation ? "reconciled_remote_merge" : "merged",
              `actor:${details.actor}`,
            ]),
            now,
          );

        this.db.exec("COMMIT;");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {}
        throw error;
      }
    } catch (error) {
      throw new IntegrationError(
        "integration_storage_failed",
        `Verified merge could not be recorded: ${this.message(error)}`,
      );
    }

    return this.mapIntegration(
      this.db
        .prepare(
          "SELECT *, pr_number AS remote_pull_request_number, pr_url AS remote_pull_request_url, verified_at AS integrated_at FROM delivery_merges WHERE project_id = ? AND delivery_id = ? AND work_id = ? AND target_branch = ? AND gate_profile = 'child'",
        )
        .get(
          run.project_id,
          run.delivery_id,
          run.work_id,
          run.target_branch,
        ) as unknown as IntegrationRow,
    );
  }

  private async block(
    run: RunRow,
    blockers: IntegrationBlocker[],
    acceptance: AcceptanceDecision,
    publication: PublicationStatus | null,
    targetTipSha: string,
    submission: { actor?: string; reason?: string },
  ): Promise<IntegrationStatus> {
    const deduped = dedupeBlockers(blockers);
    const reasons = deduped.map((blocker) => `${blocker.code}: ${blocker.message}`);
    if (submission.reason) reasons.push(`operator_reason:${submission.reason}`);
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db
          .prepare(
            `INSERT INTO delivery_events
               (id, project_id, delivery_id, plan_id, work_id, run_id, kind, candidate_head_sha,
                target_tip_sha, merge_sha, reasons, detail, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'blocked', ?, ?, NULL, ?, NULL, ?)`,
          )
          .run(
            `ievt_${randomUUID()}`,
            run.project_id,
            run.delivery_id,
            run.plan_id,
            run.work_id,
            run.id,
            run.head_sha ?? run.base_sha,
            targetTipSha || run.base_sha,
            JSON.stringify(reasons),
            this.clock(),
          );
        this.db.exec("COMMIT;");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {}
        throw error;
      }
    } catch {
      // Blocking history is observational; the refusal itself already fails closed.
    }

    if (publication) {
      try {
        enqueuePublicationEvent(this.db, {
          targetId: publication.target.id,
          projectId: run.project_id,
          workId: run.work_id,
          runId: run.id,
          lap: run.lap,
          candidateHeadSha: run.head_sha ?? run.base_sha,
          observationId: null,
          findingId: null,
          kind: "escalation",
          severity: "blocking",
          title: `Integration blocked for #${run.issue_number}`,
          body: deduped.map((blocker) => `- \`${blocker.code}\`: ${blocker.message}`).join("\n"),
          occurredAt: this.clock(),
        });
        await this.publication.publishByRun(run.project_id, run.id).catch(() => {});
      } catch {
        // The blocker is still returned even if the PR audit cannot be queued.
      }
    }

    return this.buildStatus(run, {
      state: "blocked",
      blockers: deduped,
      acceptance,
      publication: publication ?? this.safePublication(run.project_id, run.id),
      checks: [],
      integration: null,
      events: this.listEvents(run.project_id, run.id),
    });
  }

  // -------------------------------------------------------------------------
  // Preconditions
  // -------------------------------------------------------------------------

  private localBlockers(run: RunRow, acceptance: AcceptanceDecision): IntegrationBlocker[] {
    const blockers: IntegrationBlocker[] = [];
    if (run.gate_profile !== "child") {
      blockers.push({
        code: "integration_profile_invalid",
        message: `Run ${run.id} has gate profile ${run.gate_profile}, not child`,
      });
    }
    if (run.delivery_kind !== "spec" || !run.integration_branch) {
      blockers.push({
        code: "integration_profile_invalid",
        message: "Child auto-integration requires a spec delivery with an integration branch",
      });
    }
    if (run.merge_policy !== "auto_after_gates") {
      blockers.push({
        code: "integration_merge_policy_manual",
        message: "This delivery is configured for manual merge",
      });
    }
    if (run.state !== "succeeded") {
      blockers.push({
        code: "integration_run_not_succeeded",
        message: `Run ${run.id} is ${run.state}`,
      });
    }
    if (!run.head_sha) {
      blockers.push({
        code: "integration_candidate_missing",
        message: "The run has no committed candidate head",
      });
    }
    if (!acceptance.authorized) {
      blockers.push({
        code: "integration_acceptance_blocked",
        message: "Candidate-bound acceptance is not authorized",
        details: { reasons: acceptance.reasons },
      });
    }
    return dedupeBlockers(blockers);
  }

  /**
   * Publish the candidate branch itself, without a pull request. Required checks
   * are read against the commit, so the branch only has to exist on the remote and
   * point at the exact candidate we verified.
   */
  private async pushCandidateBranch(run: RunRow): Promise<IntegrationBlocker | null> {
    const head = run.head_sha;
    if (!head) {
      return {
        code: "integration_candidate_missing",
        message: `Run ${run.id} has no committed candidate head`,
      };
    }
    const ref = `refs/heads/${run.branch}`;
    this.assertInstallationReady();
    const pushed = await this.remoteRunner(["push", "origin", `${ref}:${ref}`], run.checkout_path);
    if (pushed.exitCode !== 0) {
      return {
        code: "integration_remote_unreadable",
        message: `Candidate branch ${run.branch} could not be pushed: ${
          (pushed.stderr || pushed.stdout).trim() || `exit ${pushed.exitCode}`
        }`,
      };
    }
    const listed = await this.remoteRunner(["ls-remote", "origin", ref], run.checkout_path);
    if (listed.exitCode !== 0) {
      return {
        code: "integration_remote_unreadable",
        message: `Candidate branch ${run.branch} could not be read back from the remote`,
      };
    }
    const remoteSha =
      listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.endsWith(`\t${ref}`) || line.endsWith(` ${ref}`))
        ?.split(/\s+/)[0] ?? null;
    if (remoteSha !== head) {
      return {
        code: "integration_remote_binding_mismatch",
        message: `Remote ${run.branch} is ${remoteSha ?? "missing"}, not the candidate ${head}`,
        details: { expected: head, actual: remoteSha },
      };
    }
    return null;
  }

  private async requiredChecks(run: RunRow): Promise<CheckResult> {
    const readback = await readRequiredChecks(
      this.forge,
      run.repo_name,
      run.target_branch,
      run.head_sha,
    );
    const checks: RequiredCheck[] = readback.checks.map((check) => ({
      name: check.name,
      required: true,
      status: check.status,
      conclusion: check.conclusion,
    }));
    const blockers: IntegrationBlocker[] = readback.blockers.map((blocker) => {
      if (blocker.code === "unreadable") {
        return { code: "integration_remote_unreadable", message: blocker.message };
      }
      const code =
        blocker.code === "missing"
          ? "integration_ci_missing"
          : blocker.code === "pending"
            ? "integration_ci_pending"
            : "integration_ci_failed";
      return {
        code,
        message: blocker.message,
        ...(blocker.name
          ? {
              details: {
                check: blocker.name,
                status: blocker.status,
                conclusion: blocker.conclusion,
              },
            }
          : {}),
      };
    });
    return { checks, blockers };
  }

  // -------------------------------------------------------------------------
  // Git / target helpers
  // -------------------------------------------------------------------------

  private async ensureTarget(run: RunRow): Promise<string> {
    const local = this.localTargetSha(run);
    let remote = await this.readRemoteTarget(run);

    if (!remote) {
      if (!local) {
        const base = this.tryResolve(run, run.delivery_branch);
        if (!base) {
          throw new IntegrationError(
            "integration_target_missing",
            `Integration branch ${run.target_branch} and delivery branch ${run.delivery_branch} are both missing`,
          );
        }
        this.gitRunner(["update-ref", `refs/heads/${run.target_branch}`, base], {
          cwd: run.checkout_path,
        });
      }
      this.assertInstallationReady();
      const pushed = await this.remoteRunner(
        ["push", "origin", `refs/heads/${run.target_branch}:refs/heads/${run.target_branch}`],
        run.checkout_path,
      );
      if (pushed.exitCode !== 0) {
        throw new IntegrationError(
          "integration_target_missing",
          `Integration branch ${run.target_branch} does not exist remotely and could not be created: ${pushed.stderr}`,
        );
      }
      remote = await this.readRemoteTarget(run);
      if (!remote) {
        throw new IntegrationError(
          "integration_target_missing",
          `Integration branch ${run.target_branch} is still missing remotely after push`,
        );
      }
    }

    return remote;
  }

  private async syncLocalTarget(run: RunRow, remoteTip: string): Promise<void> {
    const local = this.localTargetSha(run);
    if (local === remoteTip) return;
    if (local === null) {
      this.gitRunner(["update-ref", `refs/heads/${run.target_branch}`, remoteTip], {
        cwd: run.checkout_path,
      });
      return;
    }
    if (this.isAncestor(run, local, remoteTip)) {
      this.gitRunner(["update-ref", `refs/heads/${run.target_branch}`, remoteTip, local], {
        cwd: run.checkout_path,
      });
      return;
    }
    throw new IntegrationError(
      "integration_target_drift",
      `Local ${run.target_branch} has commits that are not on the remote; refusing to rewind`,
      { local, remote: remoteTip },
    );
  }

  private async readRemoteTarget(run: RunRow): Promise<string | null> {
    const result = await this.remoteRunner(
      ["ls-remote", "origin", `refs/heads/${run.target_branch}`],
      run.checkout_path,
    );
    if (result.exitCode !== 0) {
      throw new IntegrationError(
        "integration_remote_unreadable",
        `Could not read ${run.target_branch} from the remote: ${result.stderr}`,
      );
    }
    const first = result.stdout.split("\n").find((line) => line.trim() !== "");
    if (!first) return null;
    const [sha] = first.trim().split(/\s+/);
    return sha && sha.length === 40 ? sha : null;
  }

  private localTargetSha(run: RunRow): string | null {
    return this.tryResolve(run, run.target_branch);
  }

  private tryResolve(run: RunRow, ref: string): string | null {
    try {
      return this.gitRunner(["rev-parse", "--verify", ref], { cwd: run.checkout_path });
    } catch {
      return null;
    }
  }

  private isAncestor(run: RunRow, ancestor: string, descendant: string): boolean {
    try {
      this.gitRunner(["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd: run.checkout_path,
      });
      return true;
    } catch {
      return false;
    }
  }

  private commitExists(run: RunRow, sha: string): boolean {
    try {
      this.gitRunner(["cat-file", "-e", `${sha}^{commit}`], { cwd: run.checkout_path });
      return true;
    } catch {
      return false;
    }
  }

  private probeMerge(run: RunRow, targetTip: string): string | null {
    if (!this.commitExists(run, run.head_sha!)) {
      return null;
    }
    try {
      this.gitRunner(["merge-tree", "--write-tree", targetTip, run.head_sha!], {
        cwd: run.checkout_path,
      });
      return null;
    } catch (error) {
      return this.message(error);
    }
  }

  // -------------------------------------------------------------------------
  // Persistence / mapping
  // -------------------------------------------------------------------------

  private loadRun(projectId: string, runId: string): RunRow {
    const row = this.db
      .prepare(
        `SELECT r.id, r.project_id, r.delivery_id, r.plan_id, r.work_id, r.issue_number,
                r.gate_profile, r.merge_policy, r.target_branch, r.state, r.branch, r.base_sha,
                r.head_sha, r.lap, p.checkout_path, p.repo_name,
                d.kind AS delivery_kind, d.delivery_branch, d.integration_branch
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
      throw new IntegrationError(
        "integration_run_not_found",
        "The referenced run belongs to a different project",
      );
    }
    throw new IntegrationError("integration_run_not_found", `Run ${runId} not found`);
  }

  private assertChildProfile(run: RunRow): void {
    if (run.gate_profile !== "child" || run.delivery_kind !== "spec" || !run.integration_branch) {
      throw new IntegrationError(
        "integration_run_not_child",
        "Only child tickets in a spec delivery can auto-integrate",
      );
    }
    if (run.merge_policy !== "auto_after_gates") {
      throw new IntegrationError(
        "integration_merge_policy_manual",
        "This delivery is configured for manual merge",
      );
    }
  }

  private loadIntegration(projectId: string, runId: string): ChildIntegration | null {
    const row = this.db
      .prepare(
        `SELECT *, pr_number AS remote_pull_request_number,
                pr_url AS remote_pull_request_url,
                verified_at AS integrated_at
         FROM delivery_merges
         WHERE project_id = ? AND run_id = ? AND gate_profile = 'child'`,
      )
      .get(projectId, runId) as unknown as IntegrationRow | undefined;
    return row ? this.mapIntegration(row) : null;
  }

  private listEvents(projectId: string, runId: string): IntegrationEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM delivery_events
          WHERE project_id = ? AND run_id = ?
            AND kind IN ('blocked', 'merged', 'reconciled')
          ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId, runId) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      kind: row.kind,
      candidateHeadSha: row.candidate_head_sha,
      targetTipSha: row.target_tip_sha,
      mergeSha: row.merge_sha,
      reasons: this.parseReasons(row.reasons),
      createdAt: row.created_at,
    }));
  }

  private mapIntegration(row: IntegrationRow): ChildIntegration {
    return {
      id: row.id,
      projectId: row.project_id,
      deliveryId: row.delivery_id,
      planId: row.plan_id,
      workId: row.work_id,
      runId: row.run_id,
      issueNumber: row.issue_number,
      sourceBranch: row.source_branch,
      targetBranch: row.target_branch,
      candidateHeadSha: row.candidate_head_sha,
      baseSha: row.base_sha,
      targetTipBeforeSha: row.target_tip_before_sha,
      targetTipAfterSha: row.target_tip_after_sha,
      mergeSha: row.merge_sha,
      remotePullRequestNumber: row.remote_pull_request_number,
      remotePullRequestUrl: row.remote_pull_request_url,
      evidenceIdentity: row.evidence_identity,
      integratedAt: row.integrated_at,
    };
  }

  private buildStatus(
    run: RunRow,
    input: {
      state: IntegrationStatus["state"];
      blockers: IntegrationBlocker[];
      acceptance: AcceptanceDecision;
      publication: PublicationStatus | null;
      checks: RequiredCheck[];
      integration: ChildIntegration | null;
      events: IntegrationEvent[];
    },
  ): IntegrationStatus {
    return {
      runId: run.id,
      projectId: run.project_id,
      deliveryId: run.delivery_id,
      planId: run.plan_id,
      workId: run.work_id,
      issueNumber: run.issue_number,
      gateProfile: run.gate_profile,
      mergePolicy: run.merge_policy,
      targetBranch: run.target_branch,
      state: input.state,
      blockers: input.blockers,
      acceptance: input.acceptance,
      publication: input.publication,
      requiredChecks: input.checks,
      integration: input.integration,
      events: input.events,
    };
  }

  private safePublication(projectId: string, runId: string): PublicationStatus | null {
    try {
      return this.publication.getStatusByRun(projectId, runId);
    } catch {
      return null;
    }
  }

  private async publishTargetUpdate(
    run: RunRow,
    publication: PublicationStatus,
    event: {
      kind: "verdict" | "escalation";
      severity: "blocking" | "conditional" | "info";
      title: string;
      body: string;
    },
  ): Promise<void> {
    try {
      enqueuePublicationEvent(this.db, {
        targetId: publication.target.id,
        projectId: run.project_id,
        workId: run.work_id,
        runId: run.id,
        lap: run.lap,
        candidateHeadSha: run.head_sha ?? run.base_sha,
        observationId: null,
        findingId: null,
        kind: event.kind,
        severity: event.severity,
        title: event.title,
        body: event.body,
        occurredAt: this.clock(),
      });
    } catch {
      // The durable merge record is the completion authority; audit retry is visible.
    }
  }

  private parseReasons(value: string): string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * A restored installation never auto-merges or pushes integration refs. The
   * verified hold is the same authority that fences dispatch and publication.
   */
  private assertInstallationReady(): void {
    try {
      assertInstallationNotHeld(this.db);
    } catch (error) {
      if (error instanceof InstallationHeldError) {
        throw new IntegrationError("integration_installation_held", error.message);
      }
      throw error;
    }
    // Child landing/merging is an external writer. It is allowed before cutover
    // (legacy) and after verified activation, but never while the authority is
    // migrating or a local marker is unverified.
    assertExternalWriterAllowed(this.db);
  }
}

export function integrationErrorStatus(code: IntegrationErrorCode): number {
  switch (code) {
    case "integration_project_not_found":
    case "integration_run_not_found":
      return 404;
    case "integration_run_not_child":
    case "integration_run_not_succeeded":
    case "integration_merge_policy_manual":
    case "integration_acceptance_blocked":
    case "integration_stopped":
    case "integration_publication_missing":
    case "integration_publication_incomplete":
    case "integration_remote_binding_mismatch":
    case "integration_pull_request_closed":
    case "integration_ci_missing":
    case "integration_ci_pending":
    case "integration_ci_failed":
    case "integration_target_missing":
    case "integration_target_drift":
    case "integration_conflict":
    case "integration_merge_rejected":
    case "integration_lineage_unverified":
    case "integration_installation_held":
      return 409;
    case "integration_remote_unreadable":
    case "integration_merge_unknown":
      return 502;
    case "integration_storage_failed":
      return 500;
  }
}
