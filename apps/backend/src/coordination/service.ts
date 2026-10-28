import type { DatabaseSync } from "node:sqlite";
import {
  type SpecCoordinationPlan,
  type CoordinatedChildTicket,
  type TargetedImplementSubmission,
  type TargetedImplementResult,
  type CoordinationFinalPrResult,
  specCoordinationPlanSchema,
} from "@labq/contracts/operator";
import type { ForgeAdapter, IssueForgeAdapter } from "../registry/forge";
import { assertIssueForge } from "../registry/forge";
import { CommandLedger } from "../command/ledger";
import { CommandService } from "../command/service";
import { evaluateIssueAdmission, type RawIssue } from "../intake/admission";
import { parseDependencies } from "../intake/parser";
import { buildDependencyDAG } from "./dag";
import { WorktreeManager } from "./worktree";
import { freezeContract, executeTargetedImplement, type ImplementRunner } from "./primitive";
import { SerializedIntegrationManager } from "./integration";
import { CoordinationError } from "./errors";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

interface ProjectRow {
  id: string;
  name: string;
  repo_id: number;
  repo_name: string;
  checkout_path: string;
  status: "active" | "held" | "tombstone";
  status_reason: string | null;
}

export class SpecCoordinatorService {
  private db: DatabaseSync;
  private forge: IssueForgeAdapter;
  private ledger: CommandLedger;
  private commandService: CommandService;
  private worktreeManager: WorktreeManager;
  private integrationManager: SerializedIntegrationManager;
  private gitRunner?: (cmd: string[], options: { cwd: string }) => string;
  private implementRunner?: ImplementRunner;

  constructor(
    db: DatabaseSync,
    forge: ForgeAdapter,
    options?: {
      ledger?: CommandLedger;
      commandService?: CommandService;
      worktreeManager?: WorktreeManager;
      integrationManager?: SerializedIntegrationManager;
      gitRunner?: (cmd: string[], options: { cwd: string }) => string;
      implementRunner?: ImplementRunner;
    },
  ) {
    this.db = db;
    this.forge = assertIssueForge(forge);
    this.ledger = options?.ledger ?? options?.commandService?.ledger ?? new CommandLedger(db);
    this.commandService = options?.commandService ?? new CommandService(db);
    this.gitRunner = options?.gitRunner;
    this.implementRunner = options?.implementRunner;
    this.worktreeManager = options?.worktreeManager ?? new WorktreeManager(this.gitRunner);
    this.integrationManager =
      options?.integrationManager ?? new SerializedIntegrationManager(this.gitRunner);
  }

  private runGit(cmd: string[], cwd: string): string {
    if (this.gitRunner) {
      return this.gitRunner(cmd, { cwd });
    }
    return execFileSync("git", cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  private getProject(projectId: string): ProjectRow {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      | ProjectRow
      | undefined;
    if (!row) {
      throw new CoordinationError("project_not_found", `Project ${projectId} not found`);
    }
    if (row.status !== "active") {
      throw new CoordinationError(
        "project_not_active",
        `Project ${projectId} is in ${row.status} state`,
      );
    }
    return row;
  }

  async planSpec(
    projectId: string,
    specIssueNumber: number,
    options?: { baseBranch?: string },
  ): Promise<SpecCoordinationPlan> {
    const project = this.getProject(projectId);
    const forgeIssue = await this.forge.getIssue(project.repo_name, specIssueNumber);
    if (!forgeIssue) {
      throw new CoordinationError(
        "spec_not_found",
        `Spec or issue #${specIssueNumber} not found on forge`,
      );
    }

    const allIssues = await this.forge.listIssues(project.repo_name);
    const allIssuesMap = new Map<number, RawIssue>(
      allIssues.map((i) => [
        i.number,
        {
          number: i.number,
          title: i.title,
          body: i.body,
          labels: i.labels,
          state: i.state,
          comments: i.comments,
        },
      ]),
    );
    // Find child tickets mentioning "Part of #<specIssueNumber>"
    const partOfRegex = new RegExp(`Part of\\s+#${specIssueNumber}\\b`, "i");
    const childIssues = allIssues.filter(
      (i) => i.number !== specIssueNumber && i.body && partOfRegex.test(i.body),
    );

    const isStandalone = childIssues.length === 0;
    const baseBranch = options?.baseBranch ?? "main";

    let baseSha = "";
    try {
      baseSha = this.runGit(["rev-parse", baseBranch], project.checkout_path);
    } catch {
      try {
        baseSha = this.runGit(["rev-parse", "HEAD"], project.checkout_path);
      } catch (err: any) {
        throw new CoordinationError(
          "git_ref_error",
          `Failed to resolve base ref ${baseBranch}: ${err.message}`,
        );
      }
    }

    const integrationBranch = isStandalone
      ? `factory/standalone-issue-${specIssueNumber}`
      : `factory/spec-${specIssueNumber}-integration`;

    // Initialize the integration branch from baseSha if it doesn't already exist
    try {
      this.runGit(["branch", integrationBranch, baseSha], project.checkout_path);
    } catch {
      // Branch might already exist; ensure it's valid
    }

    let currentIntegrationSha = baseSha;
    try {
      currentIntegrationSha = this.runGit(["rev-parse", integrationBranch], project.checkout_path);
    } catch {
      currentIntegrationSha = baseSha;
    }

    const children: CoordinatedChildTicket[] = [];

    if (isStandalone) {
      const contract = freezeContract(forgeIssue.body || "");
      children.push({
        number: specIssueNumber,
        title: forgeIssue.title,
        dependencies: parseDependencies(forgeIssue.body || ""),
        status: "pending",
        contract,
      });
    } else {
      for (const child of childIssues) {
        const raw: RawIssue = {
          number: child.number,
          title: child.title,
          body: child.body,
          labels: child.labels,
          state: child.state,
          comments: child.comments,
        };

        const admission = await evaluateIssueAdmission(raw, allIssuesMap);
        if (admission.admission_status === "excluded") {
          // Skip or mark excluded
          continue;
        }

        const contract = freezeContract(child.body || "");
        children.push({
          number: child.number,
          title: child.title,
          dependencies: admission.dependencies,
          status: "pending",
          contract,
        });
      }
    }

    // Build dependency DAG & validate cycles
    const dag = buildDependencyDAG(
      children.map((c) => ({ number: c.number, dependencies: c.dependencies })),
    );

    const planId = `plan_${projectId}_${specIssueNumber}`;
    const plan: SpecCoordinationPlan = {
      id: planId,
      projectId,
      specIssueNumber,
      isStandalone,
      integrationBranch,
      baseBranch,
      baseSha,
      currentIntegrationSha,
      status: "active",
      dag,
      children,
      snapshotTimestamp: new Date().toISOString(),
      finalPullRequest: null,
      haltReason: null,
      haltAttribution: null,
    };

    // Check existing integrations in SQLite for any children already integrated
    const existingIntegrations = this.db
      .prepare(
        "SELECT issue_number, commit_sha FROM project_issue_integrations WHERE project_id = ?",
      )
      .all(projectId) as Array<{ issue_number: number; commit_sha: string }>;
    const integratedMap = new Map(existingIntegrations.map((i) => [i.issue_number, i.commit_sha]));

    for (const child of plan.children) {
      if (integratedMap.has(child.number)) {
        child.status = "integrated_to_branch";
        child.commitSha = integratedMap.get(child.number);
      }
    }

    this.savePlan(plan);
    return plan;
  }

  getPlan(projectId: string, specIssueNumber: number): SpecCoordinationPlan | null {
    const row = this.db
      .prepare(
        "SELECT plan_snapshot FROM project_spec_coordinations WHERE project_id = ? AND spec_issue_number = ?",
      )
      .get(projectId, specIssueNumber) as { plan_snapshot: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.plan_snapshot) as SpecCoordinationPlan;
  }

  private savePlan(plan: SpecCoordinationPlan): void {
    const validated = specCoordinationPlanSchema.parse(plan);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO project_spec_coordinations (
          id, project_id, spec_issue_number, is_standalone, integration_branch,
          base_branch, base_sha, current_integration_sha, status, plan_snapshot,
          final_pr_number, final_pr_url, halt_reason, halt_attribution, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, spec_issue_number) DO UPDATE SET
          current_integration_sha = excluded.current_integration_sha,
          status = excluded.status,
          plan_snapshot = excluded.plan_snapshot,
          final_pr_number = excluded.final_pr_number,
          final_pr_url = excluded.final_pr_url,
          halt_reason = excluded.halt_reason,
          halt_attribution = excluded.halt_attribution,
          updated_at = excluded.updated_at`,
      )
      .run(
        validated.id,
        validated.projectId,
        validated.specIssueNumber,
        validated.isStandalone ? 1 : 0,
        validated.integrationBranch,
        validated.baseBranch,
        validated.baseSha,
        validated.currentIntegrationSha,
        validated.status,
        JSON.stringify(validated),
        validated.finalPullRequest?.number ?? null,
        validated.finalPullRequest?.url ?? null,
        validated.haltReason ?? null,
        validated.haltAttribution ? JSON.stringify(validated.haltAttribution) : null,
        now,
        now,
      );
  }

  async dispatchChild(params: {
    projectId: string;
    specIssueNumber: number;
    childIssueNumber: number;
    runner?: ImplementRunner;
    actor?: string;
  }): Promise<TargetedImplementResult> {
    const { projectId, specIssueNumber, childIssueNumber, runner, actor } = params;
    const project = this.getProject(projectId);
    const plan = this.getPlan(projectId, specIssueNumber);

    if (!plan) {
      throw new CoordinationError(
        "plan_not_found",
        `Coordination plan for spec #${specIssueNumber} not found`,
      );
    }

    if (plan.status === "halted") {
      throw new CoordinationError(
        "coordination_pipeline_halted",
        `Coordination pipeline is halted: ${plan.haltReason}`,
        { haltAttribution: plan.haltAttribution },
      );
    }

    const child = plan.children.find((c) => c.number === childIssueNumber);
    if (!child) {
      throw new CoordinationError(
        "child_not_in_plan",
        `Child issue #${childIssueNumber} is not part of spec #${specIssueNumber} plan`,
      );
    }

    if (child.status === "integrated_to_branch") {
      throw new CoordinationError(
        "child_already_integrated",
        `Child #${childIssueNumber} is already integrated into the integration branch`,
      );
    }

    // Verify dependencies are satisfied (integrated_to_branch or closed on forge)
    const integratedRows = this.db
      .prepare("SELECT issue_number FROM project_issue_integrations WHERE project_id = ?")
      .all(projectId) as Array<{ issue_number: number }>;
    const integratedSet = new Set(integratedRows.map((r) => r.issue_number));

    for (const dep of child.dependencies) {
      if (!integratedSet.has(dep)) {
        // Check if closed on forge
        const forgeDep = await this.forge.getIssue(project.repo_name, dep);
        if (!forgeDep || forgeDep.state.toUpperCase() !== "CLOSED") {
          throw new CoordinationError(
            "prerequisites_not_satisfied",
            `Cannot dispatch child #${childIssueNumber}: prerequisite #${dep} is neither integrated to branch nor closed on forge`,
            { childIssueNumber, unsatisfiedDependency: dep },
          );
        }
      }
    }

    // Command Ledger durable write BEFORE dispatch (AC1, AC5)
    const requestId = `cmd_coord_${projectId}_${specIssueNumber}_${childIssueNumber}_${Date.now()}`;
    const childBranch = plan.isStandalone
      ? plan.integrationBranch
      : `factory/spec-${specIssueNumber}/ticket-${childIssueNumber}`;
    const worktreeDir = join(
      project.checkout_path,
      ".factory",
      "worktrees",
      `spec-${specIssueNumber}`,
      `ticket-${childIssueNumber}`,
    );

    const startSha = child.dependencies.length > 0 ? plan.currentIntegrationSha : plan.baseSha;

    const submission: TargetedImplementSubmission = {
      specIssueNumber,
      childIssueNumber,
      worktreePath: worktreeDir,
      branch: childBranch,
      startSha,
      contract: child.contract,
      primitive: "archon-implement",
    };

    // Durable pre-dispatch record
    this.ledger.recordBeforeDispatch({
      requestId,
      actor: actor ?? "spec-coordinator",
      projectId,
      action: "coordinate_dispatch",
      target: submission as unknown as Record<string, unknown>,
    });

    // AC2: Allocate isolated worktree with exclusive lock & validate start SHA and cleanliness
    let allocation;
    try {
      allocation = this.worktreeManager.allocateWorktree({
        repoRoot: project.checkout_path,
        worktreeDir,
        branch: childBranch,
        startSha,
        issueNumber: childIssueNumber,
        gitRunner: this.gitRunner,
      });
    } catch (err: any) {
      // Worktree allocation or validation failure: halt pipeline (AC5)
      const errorMsg = err.message || "Worktree allocation failed";
      plan.status = "halted";
      plan.haltReason = errorMsg;
      plan.haltAttribution = {
        childIssueNumber,
        stage: "worktree_allocation",
        error: errorMsg,
        worktreePath: worktreeDir,
      };
      child.status = "failed";
      child.error = errorMsg;
      this.savePlan(plan);

      this.ledger.updateOutcome(requestId, {
        state: "failed",
        provenance: {
          source: "worktree_manager",
          timestamp: new Date().toISOString(),
          details: errorMsg,
        },
        error: errorMsg,
      });

      throw err;
    }

    child.status = "running";
    child.worktreePath = worktreeDir;
    child.branch = childBranch;
    this.savePlan(plan);

    // AC1: Targeted engine-host primitive execution
    let implementResult: TargetedImplementResult;
    try {
      const activeRunner = runner ?? this.implementRunner;
      implementResult = await executeTargetedImplement(submission, activeRunner);
    } catch (err: any) {
      // Worker crash / unhandled failure: halt pipeline, preserve worktree state & attribution (AC5)
      const crashMsg = err.message || "Worker crashed during execution";
      plan.status = "halted";
      plan.haltReason = crashMsg;
      plan.haltAttribution = {
        childIssueNumber,
        stage: "primitive_execution",
        error: crashMsg,
        worktreePath: worktreeDir,
      };
      child.status = "failed";
      child.error = crashMsg;
      this.savePlan(plan);

      this.ledger.updateOutcome(requestId, {
        state: "failed",
        provenance: {
          source: "archon-implement",
          timestamp: new Date().toISOString(),
          details: crashMsg,
        },
        error: crashMsg,
      });

      // Release exclusive process lock file but preserve worktree files on disk
      allocation.releaseLock();

      return {
        success: false,
        childIssueNumber,
        error: crashMsg,
      };
    }

    if (!implementResult.success) {
      // Execution failed against contract
      const failureMsg = implementResult.error || "Contract execution failed";
      plan.status = "halted";
      plan.haltReason = failureMsg;
      plan.haltAttribution = {
        childIssueNumber,
        stage: "contract_verification",
        error: failureMsg,
        worktreePath: worktreeDir,
      };
      child.status = "failed";
      child.error = failureMsg;
      this.savePlan(plan);

      this.ledger.updateOutcome(requestId, {
        state: "failed",
        provenance: {
          source: "archon-implement",
          timestamp: new Date().toISOString(),
          details: failureMsg,
        },
        error: failureMsg,
      });

      allocation.releaseLock();
      return implementResult;
    }

    // Release lock file for merge
    allocation.releaseLock();

    // Standalone ticket doesn't merge into a multi-ticket branch; it is already on its own branch
    if (plan.isStandalone) {
      child.status = "integrated_to_branch";
      child.commitSha = implementResult.headSha ?? plan.currentIntegrationSha;
      this.savePlan(plan);
      this.ledger.updateOutcome(requestId, {
        state: "succeeded",
        provenance: {
          source: "spec-coordinator",
          timestamp: new Date().toISOString(),
        },
        result: implementResult,
      });
      return implementResult;
    }

    // AC3: Merge into local integration branch via serialized compare-and-swap
    try {
      const integrationResult = await this.integrationManager.integrateChildSerialized({
        repoRoot: project.checkout_path,
        integrationBranch: plan.integrationBranch,
        expectedIntegrationSha: plan.currentIntegrationSha,
        childBranch,
        childIssueNumber,
        gitRunner: this.gitRunner,
      });

      // Update local integration status in SQLite (AC3)
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO project_issue_integrations (project_id, issue_number, branch, commit_sha, integrated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, issue_number) DO UPDATE SET
             branch = excluded.branch,
             commit_sha = excluded.commit_sha,
             integrated_at = excluded.integrated_at`,
        )
        .run(projectId, childIssueNumber, childBranch, integrationResult.newSha, now);

      // Update plan state
      child.status = "integrated_to_branch";
      child.commitSha = integrationResult.newSha;
      plan.currentIntegrationSha = integrationResult.newSha;
      this.savePlan(plan);

      this.ledger.updateOutcome(requestId, {
        state: "succeeded",
        provenance: {
          source: "serialized_integration",
          timestamp: now,
          details: `Integrated child #${childIssueNumber} at ${integrationResult.newSha}`,
        },
        result: integrationResult,
      });

      return {
        ...implementResult,
        headSha: integrationResult.newSha,
      };
    } catch (err: any) {
      // AC5: Integration conflicts or drift halt coordination pipeline, preserve attribution and worktree state
      const integrationError = err.message || "Serialized integration failed";
      plan.status = "halted";
      plan.haltReason = integrationError;
      plan.haltAttribution = {
        childIssueNumber,
        stage: "serialized_integration",
        error: integrationError,
        worktreePath: worktreeDir,
        preservedSha: plan.currentIntegrationSha,
      };
      child.status = "failed";
      child.error = integrationError;
      this.savePlan(plan);

      this.ledger.updateOutcome(requestId, {
        state: "failed",
        provenance: {
          source: "serialized_integration",
          timestamp: new Date().toISOString(),
          details: integrationError,
        },
        error: integrationError,
      });

      throw err;
    }
  }

  async createFinalPullRequest(params: {
    projectId: string;
    specIssueNumber: number;
    baseBranch?: string;
    title?: string;
    body?: string;
  }): Promise<CoordinationFinalPrResult> {
    const { projectId, specIssueNumber } = params;
    const project = this.getProject(projectId);
    const plan = this.getPlan(projectId, specIssueNumber);

    if (!plan) {
      throw new CoordinationError(
        "plan_not_found",
        `Coordination plan for spec #${specIssueNumber} not found`,
      );
    }

    if (plan.finalPullRequest) {
      return {
        prNumber: plan.finalPullRequest.number,
        url: plan.finalPullRequest.url,
        title: plan.finalPullRequest.title,
        head: plan.finalPullRequest.head,
        base: plan.finalPullRequest.base,
        integratedChildren: plan.children.map((c) => c.number),
      };
    }

    // AC4: Multi-ticket specs require ALL children to be integrated before final PR
    if (!plan.isStandalone) {
      const unintegrated = plan.children.filter((c) => c.status !== "integrated_to_branch");
      if (unintegrated.length > 0) {
        throw new CoordinationError(
          "unintegrated_children_remain",
          `Cannot create final PR: ${unintegrated.length} child ticket(s) are not integrated: ${unintegrated.map((c) => `#${c.number}`).join(", ")}`,
          { unintegratedChildren: unintegrated.map((c) => c.number) },
        );
      }
    }

    const base = params.baseBranch ?? plan.baseBranch;
    const head = plan.integrationBranch;
    const defaultTitle = plan.isStandalone
      ? `feat: implement issue #${specIssueNumber}`
      : `feat(spec-${specIssueNumber}): integrated delivery for spec #${specIssueNumber}`;

    const defaultBody = plan.isStandalone
      ? `Closes #${specIssueNumber}\n\nDelivered via isolated worktree execution.`
      : `Part of #${specIssueNumber}\n\n## Delivered Children\n` +
        plan.children.map((c) => `- #${c.number}: ${c.title}`).join("\n");

    const title = params.title ?? defaultTitle;
    const body = params.body ?? defaultBody;

    const pr = await this.forge.createPullRequest(project.repo_name, {
      title,
      body,
      head,
      base,
    });

    plan.finalPullRequest = {
      number: pr.number,
      url: pr.html_url || `https://github.com/${project.repo_name}/pull/${pr.number}`,
      title: pr.title,
      head: pr.head,
      base: pr.base,
    };
    plan.status = "completed";
    this.savePlan(plan);

    return {
      prNumber: pr.number,
      url: plan.finalPullRequest.url,
      title: pr.title,
      head: pr.head,
      base: pr.base,
      integratedChildren: plan.children.map((c) => c.number),
    };
  }
}
