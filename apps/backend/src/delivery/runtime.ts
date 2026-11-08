import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  GATE_PROFILE_VERSION,
  type DeliveryGateState,
  type ExecutionCheckKind,
  type ExecutionObservationSubmissionInput,
  type ExecutionStage,
  type PlanDispatchRun,
  type ProducerRole,
} from "@animus/contracts/operator";
import { resolveAnimusStateDir } from "@animus/contracts/paths";
import { processRun } from "../../../../scripts/loop/process";
import { runBoundedRole } from "../../../../scripts/loop/role-runner";
import { resolveRoleBudgets } from "../../../../scripts/loop/deadlines";
import {
  resolveEffortForRole,
  resolveModelForRole,
  resolveProviderForRole,
} from "../../../../scripts/loop/config";
import { readHarnessChecks } from "../../../../scripts/loop/worktree";
import type { AgentTransport, LoopRole, RoleBudget } from "../../../../scripts/loop/types";
import type { DispatchService } from "../dispatch";
import type { ExecutionObservationService } from "../evidence";
import type { ExecutionBudgetService } from "../work/budget";
import type { PublicationService } from "../publication";
import { DeliveryGateService } from "./service";

export interface DeliveryRuntimeRoleRequest {
  projectId: string;
  runId: string;
  lap: number;
  gateProfile: "standalone" | "final";
  stage: "independent_review" | "final_acceptance";
  projectRoot: string;
  worktreePath: string;
  branch: string;
  candidateHeadSha: string;
  baseSha: string;
  targetBranch: string;
  contractBody: string;
  acceptanceCriteria: string[];
  findings: DeliveryRuntimeFinding[];
  runDirectory: string;
}

export interface DeliveryRuntimeFinding {
  id: string;
  severity: "blocking" | "conditional";
  acKey: string | null;
  fileContext: string;
  summary: string;
  /** Actor of the run that opened the finding; a fix must be attributed to it. */
  actor: string;
}

export interface DeliveryRuntimeCheck {
  name: string;
  command: string;
  result: "PASS" | "FAIL";
  kind: ExecutionCheckKind;
  criterionKey?: string;
  detail?: string;
}

export interface DeliveryRuntimeRoleResult {
  status: "passed" | "failed" | "inconclusive";
  summary: string;
  checks: DeliveryRuntimeCheck[];
  findings: Array<{
    severity: "blocking" | "conditional";
    acKey?: string;
    fileContext: string;
    summary: string;
  }>;
  rawReport: unknown;
}

export type DeliveryRuntimeRoleExecutor = (
  request: DeliveryRuntimeRoleRequest,
) => Promise<DeliveryRuntimeRoleResult>;

export interface DeliveryRuntimeEngine {
  /** External model/process transport. Production defaults to the owned process runner. */
  transport?: AgentTransport;
  provider?: string;
  model?: string;
  effort?: string;
  roleBudgets?: Partial<Record<"qa" | "reviewer", RoleBudget>>;
  maxContinuations?: number;
}

export interface DeliveryRuntimeOptions {
  gate: DeliveryGateService;
  observations: ExecutionObservationService;
  dispatch: DispatchService;
  budget: ExecutionBudgetService;
  publication: PublicationService;
  /** Root holding project-scoped finalized artifacts; must match the observation service. */
  artifactRoot?: string;
  /** Production role execution engine (real provider/process transport by default). */
  engine?: DeliveryRuntimeEngine;
  /** Override for narrower tests; production uses the bounded role runner below. */
  executor?: DeliveryRuntimeRoleExecutor;
  /** Declared ordinary regression commands. Production reads harness/harness.config.json. */
  regressionChecks?: string[];
  maxCorrections?: number;
  clock?: () => number;
}

export interface DeliveryRuntimeResult {
  projectId: string;
  runId: string;
  action:
    | "skipped"
    | "verification_recorded"
    | "findings_resolved"
    | "correction_dispatched"
    | "published"
    | "stopped"
    | "failed";
  state: DeliveryGateState | null;
  reasons: string[];
  correctionRunId?: string;
}

interface RuntimeRunRow {
  id: string;
  project_id: string;
  delivery_id: string;
  plan_id: string;
  work_id: string;
  revision_id: string;
  issue_number: number;
  gate_profile: "standalone" | "final";
  target_branch: string;
  branch: string;
  head_sha: string | null;
  base_sha: string;
  state: string;
  lap: number;
  actor: string;
  checkout_path: string;
  graph_hash: string;
  contract_body: string | null;
}

const REVIEW_ROLE: ProducerRole = "peer_reviewer";
const ACCEPTANCE_ROLE: ProducerRole = "independent_evaluator";

/**
 * Normal production producer for standalone/final delivery. It drives the real
 * bounded role runner (reviewer + black-box QA), runs the repository's declared
 * regression checks, persists immutable candidate-bound observations/artifacts,
 * and turns failures into bounded correction laps dispatched through the existing
 * dispatch/budget/Stop ownership path.
 *
 * The gate remains the only consumer that decides readiness; this coordinator
 * never marks a merge, never fabricates a pass and never writes an observation
 * with a caller-supplied identity.
 */
export class DeliveryRuntimeCoordinator {
  private readonly executor: DeliveryRuntimeRoleExecutor;
  private readonly artifactRoot: string;
  private readonly maxCorrections: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: DeliveryRuntimeOptions,
  ) {
    this.executor = options.executor ?? createDeliveryRoleExecutor(options.engine ?? {});
    this.artifactRoot = options.artifactRoot ?? join(resolveAnimusStateDir(), "artifacts");
    this.maxCorrections = options.maxCorrections ?? 2;
  }

  /**
   * Advance one run through independent verification, bounded correction and
   * publication. Idempotent: the next tick observes recorded stages and continues
   * from where the previous tick stopped.
   */
  async process(projectId: string, runId: string): Promise<DeliveryRuntimeResult> {
    let currentRunId = runId;
    let corrections = 0;
    let iterations = 0;
    const reasons: string[] = [];
    while (true) {
      iterations += 1;
      if (iterations > 20) {
        break;
      }
      const run = this.loadRun(projectId, currentRunId);
      if (run.state !== "succeeded" || !run.head_sha) {
        return {
          projectId,
          runId: run.id,
          action: "skipped",
          state: null,
          reasons: [`run_not_succeeded:${run.state}`],
        };
      }
      if (this.isStopped(run)) {
        return { projectId, runId: run.id, action: "stopped", state: null, reasons };
      }

      const gate = await this.options.gate.getGate(projectId, run.id);
      if (
        gate.state === "ready_for_operator_review" ||
        gate.state === "awaiting_manual_merge" ||
        gate.state === "awaiting_merge_verification" ||
        gate.state === "delivered"
      ) {
        return {
          projectId,
          runId: run.id,
          action: "skipped",
          state: gate.state,
          reasons: gate.reasons,
        };
      }

      const openFindings = this.openBlockingFindings(run);
      const review = this.options.observations.latestObservation(
        projectId,
        run.id,
        "independent_review",
      );
      const acceptance = this.options.observations.latestObservation(
        projectId,
        run.id,
        "final_acceptance",
      );
      const reviewPassed = review?.status === "passed";
      const acceptancePassed = acceptance?.status === "passed";
      const bothPassed = reviewPassed && acceptancePassed;
      const currentFailed =
        (review !== null && review.status !== "passed") ||
        (acceptance !== null && acceptance.status !== "passed");

      if (openFindings.length > 0 && bothPassed) {
        // A fresh independent pass already exists for the corrected candidate.
        this.resolveFindings(run, openFindings);
        reasons.push("findings_resolved");
        continue;
      }
      if (openFindings.length > 0 && currentFailed) {
        if (corrections >= this.maxCorrections) {
          return {
            projectId,
            runId: run.id,
            action: "failed",
            state: gate.state,
            reasons: [...reasons, "correction_budget_exhausted"],
          };
        }
        corrections += 1;
        const correctionRun = await this.dispatchCorrection(run, openFindings);
        if (!correctionRun) {
          return {
            projectId,
            runId: run.id,
            action: "failed",
            state: gate.state,
            reasons: [...reasons, ...gate.reasons],
          };
        }
        reasons.push(`correction_dispatched:${correctionRun.id}`);
        currentRunId = correctionRun.id;
        continue;
      }

      if (!bothPassed) {
        if (!reviewPassed) {
          const result = await this.runRole(run, "independent_review");
          await this.recordRoleResult(run, "independent_review", result);
        }
        if (!acceptancePassed) {
          const result = await this.runAcceptance(run);
          await this.recordRoleResult(run, "final_acceptance", result);
        }
        const refreshed = await this.options.gate.getGate(projectId, run.id);
        if (refreshed.state === "ready_for_operator_review") {
          return {
            projectId,
            runId: run.id,
            action: "verification_recorded",
            state: refreshed.state,
            reasons: refreshed.reasons,
          };
        }
        reasons.push(...refreshed.reasons);
        continue;
      }

      await this.publishIfNeeded(run);
      const finalGate = await this.options.gate.getGate(projectId, run.id);
      return {
        projectId,
        runId: run.id,
        action: "published",
        state: finalGate.state,
        reasons: finalGate.reasons,
      };
    }

    const last = this.loadRun(projectId, currentRunId);
    const gate = await this.options.gate.getGate(projectId, last.id);
    return {
      projectId,
      runId: last.id,
      action: "failed",
      state: gate.state,
      reasons: [...reasons, "correction_budget_exhausted"],
    };
  }

  private isStopped(run: RuntimeRunRow): boolean {
    const control = this.options.budget.getControl({
      projectId: run.project_id,
      deliveryId: run.delivery_id,
      workId: run.work_id,
    });
    return (
      control?.status === "held" || control?.status === "stopping" || control?.status === "stopped"
    );
  }

  private openBlockingFindings(run: RuntimeRunRow): DeliveryRuntimeFinding[] {
    return this.options.observations
      .listFindings(run.project_id, {
        deliveryId: run.delivery_id,
        workId: run.work_id,
        status: "open",
      })
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => {
        const runActor = this.db
          .prepare("SELECT actor FROM dispatch_runs WHERE id = ?")
          .get(finding.runId) as { actor: string } | undefined;
        return {
          id: finding.id,
          severity: finding.severity,
          acKey: finding.acKey,
          fileContext: finding.fileContext,
          summary: finding.summary,
          actor: runActor?.actor ?? run.actor,
        };
      });
  }

  private resolveFindings(run: RuntimeRunRow, findings: DeliveryRuntimeFinding[]): void {
    const evaluator = this.ensureProducer(run, ACCEPTANCE_ROLE);
    for (const finding of findings) {
      this.options.observations.recordFindingFix(run.project_id, finding.id, {
        actor: finding.actor,
        detail: `Builder corrected the finding in lap ${run.lap}`,
      });
      this.options.observations.recordFindingRecheck(run.project_id, finding.id, {
        runId: run.id,
        producer: evaluator,
        status: "passed",
        stage: "technical_checks",
        checks: [
          {
            name: `recheck ${finding.acKey ?? finding.id}`,
            command: "independent fresh recheck",
            result: "PASS",
            kind: finding.acKey ? "acceptance" : "review",
            ...(finding.acKey ? { criterionKey: finding.acKey } : {}),
          },
        ],
      });
    }
  }

  private async dispatchCorrection(
    run: RuntimeRunRow,
    findings: DeliveryRuntimeFinding[],
  ): Promise<PlanDispatchRun | null> {
    try {
      const correction = await this.options.dispatch.dispatch(run.project_id, {
        plan_id: run.plan_id,
        work_id: run.work_id,
        actor: "delivery-runtime",
        findings: findings.map((finding) => ({
          summary: finding.summary,
          fileContext: finding.fileContext,
          ...(finding.acKey ? { acKey: finding.acKey } : {}),
        })),
      });
      return correction;
    } catch {
      return null;
    }
  }

  private async publishIfNeeded(run: RuntimeRunRow): Promise<void> {
    const status = this.options.publication.getStatusByRun(run.project_id, run.id);
    const hasActive = status.pullRequests.some((pullRequest) => pullRequest.active);
    if (status.target.state !== "published" || !hasActive) {
      await this.options.publication.publishByRun(run.project_id, run.id);
    }
  }

  private async runRole(
    run: RuntimeRunRow,
    stage: "independent_review",
  ): Promise<DeliveryRuntimeRoleResult> {
    const request = this.roleRequest(run, stage);
    return this.executor(request);
  }

  private async runAcceptance(run: RuntimeRunRow): Promise<DeliveryRuntimeRoleResult> {
    const request = this.roleRequest(run, "final_acceptance");
    const result = await this.executor(request);
    const regression = await this.runRegressionChecks(run);
    const checks = [...result.checks, regression.check];
    const findings = [...result.findings];
    if (regression.check.result === "FAIL") {
      findings.push({
        severity: "blocking",
        fileContext: "regression",
        summary: `Declared regression checks failed: ${regression.detail}`,
      });
    }
    const status =
      result.status === "passed" && regression.check.result === "PASS" ? "passed" : "failed";
    return {
      ...result,
      status,
      checks,
      findings: status === "passed" ? [] : findings,
      rawReport: { report: result.rawReport, regression },
    };
  }

  private async runRegressionChecks(
    run: RuntimeRunRow,
  ): Promise<{ check: DeliveryRuntimeCheck; detail: string }> {
    let commands = this.options.regressionChecks;
    if (!commands) {
      try {
        commands = readHarnessChecks(run.checkout_path).checks;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          check: {
            name: "relevant regression",
            command: "harness/harness.config.json",
            result: "FAIL",
            kind: "regression",
            detail,
          },
          detail,
        };
      }
    }
    const failures: string[] = [];
    const worktreePath = this.worktreePath(run);
    for (const command of commands) {
      const result = await processRun(["sh", "-c", command], worktreePath, 30_000, undefined, {
        manageSignals: false,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        failures.push(
          `${command} (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""})`,
        );
      }
    }
    return {
      check: {
        name: "relevant regression",
        command: commands.join(" && "),
        result: failures.length === 0 ? "PASS" : "FAIL",
        kind: "regression",
        ...(failures.length > 0 ? { detail: failures.join("; ") } : {}),
      },
      detail: failures.join("; "),
    };
  }

  private async recordRoleResult(
    run: RuntimeRunRow,
    stage: "independent_review" | "final_acceptance",
    result: DeliveryRuntimeRoleResult,
  ): Promise<DeliveryRuntimeFinding[]> {
    const producer = this.ensureProducer(
      run,
      stage === "independent_review" ? REVIEW_ROLE : ACCEPTANCE_ROLE,
    );
    const relativePath = ["runtime", run.id, `${stage}-${run.lap}-${randomUUID()}.json`].join("/");
    const absolute = join(this.artifactRoot, run.project_id, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(
      absolute,
      JSON.stringify(
        {
          stage,
          runId: run.id,
          lap: run.lap,
          candidateHeadSha: run.head_sha,
          gateProfileVersion: GATE_PROFILE_VERSION,
          report: result.rawReport,
        },
        null,
        2,
      ),
    );

    const submission: ExecutionObservationSubmissionInput = {
      stage: stage as ExecutionStage,
      status: result.status,
      producer,
      checks: result.checks.map((check) => ({
        name: check.name,
        command: check.command,
        result: check.result,
        kind: check.kind,
        ...(check.criterionKey ? { criterionKey: check.criterionKey } : {}),
        ...(check.detail ? { detail: check.detail } : {}),
        artifactPath: relativePath,
      })),
      findings:
        result.status === "passed"
          ? []
          : result.findings.length > 0
            ? result.findings.map((finding) => ({
                severity: finding.severity,
                ...(finding.acKey ? { acKey: finding.acKey } : {}),
                fileContext: finding.fileContext,
                summary: finding.summary,
                workId: run.work_id,
              }))
            : [
                {
                  severity: "blocking",
                  fileContext: stage,
                  summary: result.summary || `${stage} did not pass (${result.status})`,
                  workId: run.work_id,
                },
              ],
      artifacts: [
        {
          ownerType: "observation",
          name: `${stage} report`,
          relativePath,
          mediaType: "application/json",
        },
      ],
    };
    this.options.observations.recordRunObservation(run.project_id, run.id, submission);
    return (submission.findings ?? []).map((finding, index) => ({
      id: `pending-${index}`,
      severity: finding.severity,
      acKey: finding.acKey ?? null,
      fileContext: finding.fileContext,
      summary: finding.summary,
      actor: run.actor,
    }));
  }

  private ensureProducer(
    run: RuntimeRunRow,
    role: ProducerRole,
  ): { id: string; role: ProducerRole } {
    const suffix = role === REVIEW_ROLE ? "reviewer" : "evaluator";
    return this.options.observations.ensureTrustedProducer(run.project_id, {
      id: `runtime-${suffix}-${run.id}`,
      role,
    });
  }

  private roleRequest(
    run: RuntimeRunRow,
    stage: "independent_review" | "final_acceptance",
  ): DeliveryRuntimeRoleRequest {
    return {
      projectId: run.project_id,
      runId: run.id,
      lap: run.lap,
      gateProfile: run.gate_profile,
      stage,
      projectRoot: run.checkout_path,
      worktreePath: this.worktreePath(run),
      branch: run.branch,
      candidateHeadSha: run.head_sha!,
      baseSha: run.base_sha,
      targetBranch: run.target_branch,
      contractBody: run.contract_body ?? "",
      acceptanceCriteria: this.acceptanceCriteria(run),
      findings: this.openBlockingFindings(run),
      runDirectory: join(this.artifactRoot, run.project_id, "runtime", run.id),
    };
  }

  private worktreePath(run: RuntimeRunRow): string {
    const row = this.db
      .prepare("SELECT worktree_path FROM dispatch_runs WHERE project_id = ? AND id = ?")
      .get(run.project_id, run.id) as { worktree_path: string } | undefined;
    return row?.worktree_path ?? run.checkout_path;
  }

  private acceptanceCriteria(run: RuntimeRunRow): string[] {
    return (
      this.db
        .prepare(
          `SELECT ac_key FROM plan_acceptance_criteria
           WHERE plan_id = ? AND work_id = ? ORDER BY ordinal ASC`,
        )
        .all(run.plan_id, run.work_id) as Array<{ ac_key: string }>
    ).map((row) => row.ac_key);
  }

  private loadRun(projectId: string, runId: string): RuntimeRunRow {
    const row = this.db
      .prepare(
        `SELECT r.id, r.project_id, r.delivery_id, r.plan_id, r.work_id, r.revision_id,
                r.issue_number, r.gate_profile, r.target_branch, r.branch, r.head_sha,
                r.base_sha, r.state, r.lap, r.actor, p.checkout_path, d.graph_hash,
                w.source_body AS contract_body
         FROM dispatch_runs r
         JOIN projects p ON p.id = r.project_id
         JOIN deliveries d ON d.id = r.delivery_id AND d.project_id = r.project_id
         LEFT JOIN work_revisions w
           ON w.id = r.revision_id AND w.work_id = r.work_id AND w.project_id = r.project_id
         WHERE r.project_id = ? AND r.id = ?`,
      )
      .get(projectId, runId) as unknown as RuntimeRunRow | undefined;
    if (!row) throw new Error(`Run ${runId} not found for project ${projectId}`);
    return row;
  }
}

/**
 * Production executor: real bounded reviewer/QA roles through the same role
 * runner used by the factory loop. Only the external model/process transport is
 * injectable for offline proof.
 */
export function createDeliveryRoleExecutor(
  engine: DeliveryRuntimeEngine,
): DeliveryRuntimeRoleExecutor {
  const transport: AgentTransport =
    engine.transport ??
    ((request) =>
      processRun(request.argv, request.cwd, request.timeoutMs, request.env, {
        manageSignals: false,
      }));

  return async (request) => {
    const role: LoopRole = request.stage === "independent_review" ? "reviewer" : "qa";
    const provider = engine.provider ?? resolveProviderForRole(request.projectRoot, role);
    const model = engine.model ?? resolveModelForRole(request.projectRoot, role) ?? "small";
    const effort = engine.effort ?? resolveEffortForRole(request.projectRoot, role);
    const budgets = resolveRoleBudgets({
      maxContinuations: engine.maxContinuations ?? 1,
      ...(engine.roleBudgets ? { roleBudgets: engine.roleBudgets } : {}),
    });
    const runDirectory = join(request.runDirectory, request.stage);
    const result = await runBoundedRole({
      role,
      root: request.projectRoot,
      cwd: request.worktreePath,
      prompt:
        request.stage === "independent_review" ? reviewPrompt(request) : acceptancePrompt(request),
      sessionDir: join(runDirectory, "session"),
      checkpointPath: join(runDirectory, "checkpoint.md"),
      handoffDir: join(runDirectory, "handoff"),
      runDirectory,
      budget: budgets[role],
      maxContinuations: engine.maxContinuations ?? 1,
      provider,
      model,
      effort,
      transport,
      candidate: request.candidateHeadSha,
      optionsOverride: { requiredAcIds: request.acceptanceCriteria },
    });
    if (request.stage === "independent_review") {
      return reviewResult(result.report);
    }
    return acceptanceResult(request, result.report);
  };
}

function reviewPrompt(request: DeliveryRuntimeRoleRequest): string {
  const findings =
    request.findings.length === 0
      ? "(none)"
      : request.findings
          .map(
            (finding) =>
              `- ${finding.id}${finding.acKey ? ` [${finding.acKey}]` : ""} ${finding.fileContext}: ${finding.summary}`,
          )
          .join("\n");
  return [
    "# Independent delivery review",
    "",
    "You are the independent reviewer for a standalone delivery. You did not write",
    "this change. Judge what the candidate does, not what anyone claims.",
    "",
    `- Ticket: #${request.runId}`,
    `- Branch: ${request.branch}`,
    `- Candidate: ${request.candidateHeadSha}`,
    `- Base: ${request.baseSha}`,
    `- Target: ${request.targetBranch}`,
    "",
    "## Frozen contract",
    "",
    request.contractBody.trim(),
    "",
    "## Open blocking findings",
    "",
    findings,
    "",
    "## Rules",
    "",
    "- Inspect `git diff` and the candidate files line by line.",
    "- Enforce the repository's AGENTS.md, CODING_STANDARDS.md and security rules.",
    "- Reject shallow wrappers, dead code, tautological tests and missing negative cases.",
    "- Verification runs in this worktree; do not push, merge or edit and commit source.",
    "- Return sent-back whenever any blocking defect remains.",
    "",
    "## Report format",
    "",
    'Return one JSON object: {"outcome":"approved"|"sent-back","sha":"<candidate>","summary":"...","findings":[{"id":"F1","axis":"standards","classification":"defect","blocking":true,"title":"...","description":"...","location":{"file":"path","line":1},"evidence":"...","status":"open"}]}',
  ].join("\n");
}

function acceptancePrompt(request: DeliveryRuntimeRoleRequest): string {
  const criteria =
    request.acceptanceCriteria.length === 0
      ? "(no criteria recorded)"
      : request.acceptanceCriteria.map((key) => `- ${key}`).join("\n");
  return [
    "# Black-box delivery acceptance",
    "",
    "You are the independent black-box tester for a standalone delivery. Test the",
    "product through its real supported transports; do not inspect the builder's",
    "narrative as proof.",
    "",
    `- Candidate: ${request.candidateHeadSha}`,
    `- Base: ${request.baseSha}`,
    `- Worktree: ${request.worktreePath}`,
    "",
    "## Acceptance criteria",
    "",
    criteria,
    "",
    "## Rules",
    "",
    "- Exercise each criterion against the running product or its public CLI/HTTP surface.",
    "- Run the relevant existing test suites and report regressions honestly.",
    "- Record concrete command output/evidence under the artifacts directory.",
    "- Do not edit source, commit, push or merge.",
    "- Return FAIL when any criterion is unverified or any regression remains.",
    "",
    "## Report format",
    "",
    'Return one JSON object: {"head":"<candidate>","overall":"PASS"|"FAIL","summary":"...","lines":[{"id":"AC1","kind":"criterion","verdict":"PASS"|"FAIL","text":"...","evidence":["file"]}],"noticed":[]}',
  ].join("\n");
}

function reviewResult(report: any): DeliveryRuntimeRoleResult {
  const outcome = String(report?.outcome ?? "").toLowerCase();
  const passed = report?.passed === true || ["approved", "merge"].includes(outcome);
  const rawFindings: any[] = Array.isArray(report?.findings) ? report.findings : [];
  const findings = rawFindings
    .filter((finding) => finding?.blocking !== false)
    .map((finding) => ({
      severity: "blocking" as const,
      fileContext: finding.location?.file
        ? `${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""}`
        : "review",
      summary: [finding.title, finding.description].filter(Boolean).join(": ") || "Review finding",
    }));
  return {
    status: passed && findings.length === 0 ? "passed" : "failed",
    summary: String(report?.summary ?? outcome),
    checks: [
      {
        name: "independent standards and contract review",
        command: "review candidate diff",
        result: passed && findings.length === 0 ? "PASS" : "FAIL",
        kind: "review",
      },
    ],
    findings: passed && findings.length === 0 ? [] : findings,
    rawReport: report,
  };
}

function acceptanceResult(
  request: DeliveryRuntimeRoleRequest,
  report: any,
): DeliveryRuntimeRoleResult {
  const lines: any[] = Array.isArray(report?.lines) ? report.lines : [];
  const checks: DeliveryRuntimeCheck[] = request.acceptanceCriteria.map((criterion) => {
    const line = lines.find((item) => item?.id === criterion);
    const passed = String(line?.verdict ?? "").toUpperCase() === "PASS";
    return {
      name: `AC ${criterion} black-box`,
      command: "black-box acceptance",
      result: passed ? "PASS" : "FAIL",
      kind: "acceptance",
      criterionKey: criterion,
      ...(line?.text ? { detail: String(line.text) } : {}),
    };
  });
  const failedLines = lines.filter((line) => String(line?.verdict ?? "").toUpperCase() !== "PASS");
  const passed =
    String(report?.overall ?? "").toUpperCase() === "PASS" &&
    checks.every((check) => check.result === "PASS") &&
    failedLines.length === 0;
  const findings = failedLines.map((line) => ({
    severity: "blocking" as const,
    ...(request.acceptanceCriteria.includes(line?.id) ? { acKey: String(line.id) } : {}),
    fileContext: "black-box acceptance",
    summary: `${line?.id ?? "QA"}: ${line?.text ?? "criterion did not pass"}`,
  }));
  return {
    status: passed ? "passed" : "failed",
    summary: String(report?.summary ?? ""),
    checks,
    findings,
    rawReport: report,
  };
}
