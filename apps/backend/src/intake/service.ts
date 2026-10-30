import type { DatabaseSync } from "node:sqlite";
import {
  intakeResultSchema,
  evaluatedIssueSchema,
  intakePreviewSubmissionSchema,
  intakePreviewResultSchema,
  intakePublishSubmissionSchema,
  intakePublishResultSchema,
  intakeUpdateSubmissionSchema,
  targetBindingSubmissionSchema,
  targetBindingResultSchema,
  branchIntegrationSubmissionSchema,
  type IntakeResult,
  type EvaluatedIssue,
  type IntakePreviewSubmission,
  type IntakePreviewResult,
  type IntakePublishSubmission,
  type IntakePublishResult,
  type IntakeUpdateSubmission,
  type TargetBindingSubmission,
  type TargetBindingResult,
  type BranchIntegrationResult,
} from "@labq/contracts/operator";
import type { ForgeAdapter, IssueForgeAdapter } from "../registry/forge";
import { SystemForgeAdapter, assertIssueForge } from "../registry/forge";
import { ProjectRegistryError } from "../registry/service";
import { evaluateIssueAdmission, type RawIssue, type JevSystemOneResponse } from "./admission";
import { parseDependencies, isActiveClaim, computeDiff, computeLabelEffects } from "./parser";
import { verifyTargetBinding, TargetBindingError } from "./binding";

interface ProjectRow {
  id: string;
  name: string;
  repo_id: number;
  repo_name: string;
  checkout_path: string;
  status: "active" | "held" | "tombstone";
  status_reason: string | null;
}

export interface IntakeServiceOptions {
  repo?: string;
  ttlSeconds?: number;
  runner?: (cmd: string[]) => Promise<string>;
  jevFetcher?: (payload: unknown) => Promise<JevSystemOneResponse>;
}

export class IntakeService {
  private cache = new Map<string, { result: IntakeResult; cachedAt: number }>();
  private readonly ttlSeconds: number;
  private readonly defaultRepo: string;
  private readonly jevFetcher?: (payload: unknown) => Promise<JevSystemOneResponse>;
  private forge: ForgeAdapter;
  private db?: DatabaseSync;

  constructor(
    dbOrOptions?: DatabaseSync | IntakeServiceOptions,
    forge?: ForgeAdapter,
    options?: IntakeServiceOptions,
  ) {
    let resolvedOptions: IntakeServiceOptions | undefined = options;
    if (dbOrOptions && typeof (dbOrOptions as any).prepare !== "function") {
      resolvedOptions = dbOrOptions as IntakeServiceOptions;
      this.db = undefined;
    } else if (dbOrOptions) {
      this.db = dbOrOptions as DatabaseSync;
    }

    this.forge = forge ?? new SystemForgeAdapter(resolvedOptions?.runner);
    this.defaultRepo = resolvedOptions?.repo || "labq-software-factory";
    this.ttlSeconds = resolvedOptions?.ttlSeconds ?? 60.0;
    this.jevFetcher = resolvedOptions?.jevFetcher;
  }

  setForge(forge: ForgeAdapter): void {
    this.forge = forge;
  }

  setDb(db: DatabaseSync): void {
    this.db = db;
  }

  private getIssueForge(): IssueForgeAdapter {
    return assertIssueForge(this.forge);
  }

  private resolveProject(projectId: string): ProjectRow {
    if (!this.db) {
      throw new ProjectRegistryError("project_not_found", "Database not initialized");
    }
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as unknown as
      | ProjectRow
      | undefined;
    if (!row || row.status === "tombstone") {
      throw new ProjectRegistryError("project_not_found", `Project ${projectId} not found`);
    }
    return row;
  }

  private getBranchIntegrations(projectId: string): Map<number, string> {
    const map = new Map<number, string>();
    if (!this.db) return map;
    try {
      const rows = this.db
        .prepare("SELECT issue_number, branch FROM project_issue_integrations WHERE project_id = ?")
        .all(projectId) as unknown as Array<{ issue_number: number; branch: string }>;
      for (const r of rows) {
        map.set(r.issue_number, r.branch);
      }
    } catch {}
    return map;
  }

  async evaluateProjectBacklog(projectId: string, forceRefresh = false): Promise<IntakeResult> {
    const project = this.resolveProject(projectId);
    const now = Date.now() / 1000;
    const cacheKey = `proj:${projectId}`;
    const cached = this.cache.get(cacheKey);

    if (!forceRefresh && cached && now - cached.cachedAt < this.ttlSeconds) {
      return { ...cached.result, cached: true };
    }

    const forge = this.getIssueForge();
    const rawIssues = (await forge.listIssues(project.repo_name)).filter(
      (issue) => issue.state.toUpperCase() === "OPEN",
    );
    const branchIntegrations = this.getBranchIntegrations(projectId);
    const evaluated = await this.evaluateIssues(project.repo_name, rawIssues, branchIntegrations);

    evaluated.sort((a, b) => a.number - b.number);

    const admittedCount = evaluated.filter((x) => x.admission_status === "admitted").length;
    const heldCount = evaluated.filter((x) => x.admission_status === "held").length;
    const excludedCount = evaluated.filter((x) => x.admission_status === "excluded").length;

    const result: IntakeResult = {
      repo: project.repo_name,
      as_of: new Date().toISOString(),
      cached: false,
      total_count: evaluated.length,
      admitted_count: admittedCount,
      held_count: heldCount,
      excluded_count: excludedCount,
      issues: evaluated,
    };

    this.cache.set(cacheKey, { result, cachedAt: now });
    return result;
  }

  async getProjectIssue(projectId: string, issueNumber: number): Promise<EvaluatedIssue> {
    const project = this.resolveProject(projectId);
    const raw = await this.getIssueForge().getIssue(project.repo_name, issueNumber);
    const found = raw
      ? (
          await this.evaluateIssues(project.repo_name, [raw], this.getBranchIntegrations(projectId))
        )[0]
      : null;
    if (!found) {
      throw new ProjectRegistryError("issue_not_found", `Issue #${issueNumber} not found`);
    }
    return found;
  }

  async previewProjectIntake(
    projectId: string,
    submission: IntakePreviewSubmission,
  ): Promise<IntakePreviewResult> {
    const project = this.resolveProject(projectId);
    let titleDiff: string | null = null;
    let bodyDiff: string | null = null;
    let currentLabels: string[] = [];

    if (submission.issue_number) {
      const forge = this.getIssueForge();
      const existing = await forge.getIssue(project.repo_name, submission.issue_number);
      if (existing) {
        titleDiff = computeDiff(existing.title, submission.title);
        bodyDiff = computeDiff(existing.body ?? "", submission.body);
        currentLabels = (existing.labels || []).map((l) => (typeof l === "string" ? l : l.name));
      }
    }

    const labelEffects = computeLabelEffects(currentLabels, submission.labels || []);

    const branchIntegrations = this.getBranchIntegrations(projectId);
    const simulatedIssue: RawIssue = {
      number: submission.issue_number || 999999,
      title: submission.title,
      state: "OPEN",
      body: submission.body,
      labels: (submission.labels || []).map((name) => ({ name })),
      comments: [],
    };

    const [simulatedAdmission] = await this.evaluateIssues(
      project.repo_name,
      [simulatedIssue],
      branchIntegrations,
      true,
    );
    if (!simulatedAdmission) throw new Error("Admission preview unavailable");

    const proposedLower = (submission.labels || []).map((l) => l.trim().toLowerCase());
    const blockingLabels = proposedLower.filter((l) =>
      ["needs-info", "ready-for-human", "needs-triage"].includes(l),
    );
    const exclusionLabels = proposedLower.filter((l) => l === "wontfix");
    const activeClaim = isActiveClaim([], submission.body);

    return {
      target_repo: project.repo_name,
      target_issue_number: submission.issue_number ?? null,
      title: submission.title,
      title_diff: titleDiff,
      body: submission.body,
      body_diff: bodyDiff,
      label_effects: labelEffects,
      admission_preview: {
        status: simulatedAdmission.admission_status,
        reason: simulatedAdmission.reason,
        dependencies: simulatedAdmission.dependencies,
        unsatisfied_dependencies: simulatedAdmission.unsatisfied_dependencies,
        blocking_labels: blockingLabels,
        exclusion_labels: exclusionLabels,
        active_claim: activeClaim,
      },
    };
  }

  async publishProjectTicket(
    projectId: string,
    submission: IntakePublishSubmission,
  ): Promise<IntakePublishResult> {
    const project = this.resolveProject(projectId);
    const forge = this.getIssueForge();
    const createdIssue = await forge.createIssue(project.repo_name, {
      title: submission.title,
      body: submission.body,
      labels: submission.labels,
    });

    // Invalidate project backlog cache
    this.cache.delete(`proj:${projectId}`);

    // Re-evaluate backlog to obtain evaluated issue
    const backlog = await this.evaluateProjectBacklog(projectId, true);
    const evaluated = backlog.issues.find((i) => i.number === createdIssue.number) ?? {
      number: createdIssue.number,
      title: createdIssue.title,
      state: createdIssue.state,
      admission_status: "held" as const,
      reason: "newly_created",
      labels: submission.labels || [],
      dependencies: parseDependencies(submission.body),
      unsatisfied_dependencies: [],
      body: submission.body,
    };

    return {
      repo: project.repo_name,
      issue: evaluated,
      created_at: new Date().toISOString(),
    };
  }

  async updateProjectTicket(
    projectId: string,
    issueNumber: number,
    submission: IntakeUpdateSubmission,
  ): Promise<EvaluatedIssue> {
    const project = this.resolveProject(projectId);
    const forge = this.getIssueForge();
    await forge.updateIssue(project.repo_name, issueNumber, {
      title: submission.title,
      body: submission.body,
      state: submission.state,
      labels: submission.labels,
    });

    // Invalidate project backlog cache
    this.cache.delete(`proj:${projectId}`);

    // Return fresh evaluated issue
    return await this.getProjectIssue(projectId, issueNumber);
  }

  async bindProjectTarget(
    projectId: string,
    issueNumber: number,
    submission: TargetBindingSubmission,
  ): Promise<TargetBindingResult> {
    const project = this.resolveProject(projectId);
    if (!this.db) {
      throw new ProjectRegistryError("project_not_found", "Database not initialized");
    }
    return await verifyTargetBinding({
      projectId,
      repoName: project.repo_name,
      issueNumber,
      submission,
      forge: this.forge,
      db: this.db,
    });
  }

  recordBranchIntegration(
    projectId: string,
    issueNumber: number,
    branch: string,
    commitSha?: string,
  ): BranchIntegrationResult {
    const project = this.resolveProject(projectId);
    if (!this.db) {
      throw new ProjectRegistryError("project_not_found", "Database not initialized");
    }
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
      .run(project.id, issueNumber, branch, commitSha ?? null, now);

    // Invalidate cache so dependent issues can re-evaluate with this branch integration
    this.cache.delete(`proj:${projectId}`);

    return {
      project_id: project.id,
      issue_number: issueNumber,
      branch,
      commit_sha: commitSha ?? null,
      integrated_at: now,
    };
  }

  getBranchIntegration(projectId: string, issueNumber: number): BranchIntegrationResult | null {
    if (!this.db) return null;
    const row = this.db
      .prepare(
        "SELECT project_id, issue_number, branch, commit_sha, integrated_at FROM project_issue_integrations WHERE project_id = ? AND issue_number = ?",
      )
      .get(projectId, issueNumber) as unknown as BranchIntegrationResult | undefined;
    return row ?? null;
  }

  // --- Legacy / Global Support for backwards compatibility ---

  private repoName(): string {
    return this.defaultRepo.includes("/") ? this.defaultRepo : "iqbal-codes/" + this.defaultRepo;
  }

  async fetchRawIssues(): Promise<RawIssue[]> {
    const issues = await this.getIssueForge().listIssues(this.repoName());
    return issues.filter((issue) => issue.state?.toUpperCase() === "OPEN");
  }

  async getIssue(issueNumber: number): Promise<EvaluatedIssue | null> {
    const raw = await this.getIssueForge().getIssue(this.repoName(), issueNumber);
    return raw ? ((await this.evaluateIssues(this.repoName(), [raw]))[0] ?? null) : null;
  }

  private async evaluateIssues(
    repo: string,
    issues: RawIssue[],
    integrations = new Map<number, string>(),
    advisory = false,
  ): Promise<EvaluatedIssue[]> {
    const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
    const dependencies = new Set<number>();
    for (const issue of issues) {
      for (const text of [
        issue.body ?? "",
        ...(issue.comments ?? []).map((comment) => comment.body ?? ""),
      ]) {
        for (const number of parseDependencies(text)) {
          if (!byNumber.has(number) && !integrations.has(number)) dependencies.add(number);
        }
      }
    }
    const failed = new Set<number>();
    const forge = this.getIssueForge();
    const numbers = [...dependencies];
    if (numbers.length && forge.getIssueStates) {
      try {
        const states = await forge.getIssueStates(repo, numbers);
        for (const number of numbers) {
          const state = states.get(number);
          if (state) byNumber.set(number, { number, title: "", state });
          else failed.add(number);
        }
      } catch {
        for (const number of numbers) failed.add(number);
      }
    } else {
      // Bound concurrency for adapters without batched status reads.
      for (let offset = 0; offset < numbers.length; offset += 5) {
        await Promise.all(
          numbers.slice(offset, offset + 5).map(async (number) => {
            try {
              const dependency = await forge.getIssue(repo, number);
              if (dependency) byNumber.set(number, dependency);
              else failed.add(number);
            } catch {
              failed.add(number);
            }
          }),
        );
      }
    }
    return Promise.all(
      issues.map(async (issue) => {
        const result = await evaluateIssueAdmission(issue, byNumber, {
          integratedBranchIssues: integrations,
          advisory,
          jevFetcher: this.jevFetcher,
        });
        const unavailable = result.unsatisfied_dependencies.filter((number) => failed.has(number));
        if (unavailable.length && result.reason.startsWith("waiting_on_dependency:")) {
          result.reason =
            "dependency_lookup_failed:" + unavailable.map((number) => "#" + number).join(",");
        }
        return result;
      }),
    );
  }

  async evaluateBacklog(forceRefresh = false): Promise<IntakeResult> {
    const now = Date.now() / 1000;
    const cacheKey = `legacy:${this.defaultRepo}`;
    const cached = this.cache.get(cacheKey);

    if (!forceRefresh && cached && now - cached.cachedAt < this.ttlSeconds) {
      return { ...cached.result, cached: true };
    }

    const rawIssues = await this.fetchRawIssues();
    const evaluated = await this.evaluateIssues(this.repoName(), rawIssues);

    evaluated.sort((a, b) => a.number - b.number);

    const admittedCount = evaluated.filter((x) => x.admission_status === "admitted").length;
    const heldCount = evaluated.filter((x) => x.admission_status === "held").length;
    const excludedCount = evaluated.filter((x) => x.admission_status === "excluded").length;

    const result: IntakeResult = {
      repo: this.defaultRepo,
      as_of: new Date().toISOString(),
      cached: false,
      total_count: evaluated.length,
      admitted_count: admittedCount,
      held_count: heldCount,
      excluded_count: excludedCount,
      issues: evaluated,
    };

    this.cache.set(cacheKey, { result, cachedAt: now });
    return result;
  }
}

export async function handleProjectIntakeRoute(
  request: Request,
  projectId: string,
  parts: string[],
  intakeService: IntakeService,
): Promise<Response | null> {
  // GET /api/v1/projects/:projectId/intake
  if (parts.length === 2) {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("refresh") === "true";
    try {
      const backlog = await intakeService.evaluateProjectBacklog(projectId, forceRefresh);
      const parsed = intakeResultSchema.safeParse(backlog);
      if (!parsed.success)
        return Response.json({ error: "invalid_operator_response" }, { status: 502 });
      return Response.json(parsed.data);
    } catch {
      return Response.json({ error: "intake_unavailable" }, { status: 503 });
    }
  }

  if (parts.length === 3) {
    // POST /api/v1/projects/:projectId/intake/preview
    if (parts[2] === "preview") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = intakePreviewSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      try {
        const preview = await intakeService.previewProjectIntake(projectId, parsed.data);
        const validated = intakePreviewResultSchema.safeParse(preview);
        if (!validated.success)
          return Response.json({ error: "invalid_operator_response" }, { status: 502 });
        return Response.json(validated.data);
      } catch {
        return Response.json({ error: "intake_unavailable" }, { status: 503 });
      }
    }

    // POST /api/v1/projects/:projectId/intake/publish
    if (parts[2] === "publish") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = intakePublishSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      try {
        const published = await intakeService.publishProjectTicket(projectId, parsed.data);
        const validated = intakePublishResultSchema.safeParse(published);
        if (!validated.success)
          return Response.json({ error: "invalid_operator_response" }, { status: 502 });
        return Response.json(validated.data);
      } catch {
        return Response.json({ error: "intake_unavailable" }, { status: 503 });
      }
    }

    // /api/v1/projects/:projectId/intake/:number
    const rawNum = parts[2];
    const issueNum = parseInt(rawNum, 10);
    if (Number.isNaN(issueNum) || issueNum <= 0) {
      return Response.json({ error: "issue_not_found" }, { status: 404 });
    }

    if (request.method === "GET") {
      try {
        const found = await intakeService.getProjectIssue(projectId, issueNum);
        const parsed = evaluatedIssueSchema.safeParse(found);
        if (!parsed.success)
          return Response.json({ error: "invalid_operator_response" }, { status: 502 });
        return Response.json(parsed.data);
      } catch (err: any) {
        if (err instanceof ProjectRegistryError && err.code === "issue_not_found") {
          return Response.json({ error: "issue_not_found" }, { status: 404 });
        }
        return Response.json({ error: "intake_unavailable" }, { status: 503 });
      }
    }

    if (request.method === "PATCH") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = intakeUpdateSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      try {
        const updated = await intakeService.updateProjectTicket(projectId, issueNum, parsed.data);
        const validated = evaluatedIssueSchema.safeParse(updated);
        if (!validated.success)
          return Response.json({ error: "invalid_operator_response" }, { status: 502 });
        return Response.json(validated.data);
      } catch {
        return Response.json({ error: "intake_unavailable" }, { status: 503 });
      }
    }

    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "GET, PATCH" } },
    );
  }

  if (parts.length === 4) {
    const rawNum = parts[2];
    const issueNum = parseInt(rawNum, 10);
    if (Number.isNaN(issueNum) || issueNum <= 0) {
      return Response.json({ error: "issue_not_found" }, { status: 404 });
    }
    const subAction = parts[3];

    // POST /api/v1/projects/:projectId/intake/:number/update
    if (subAction === "update") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = intakeUpdateSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      try {
        const updated = await intakeService.updateProjectTicket(projectId, issueNum, parsed.data);
        const validated = evaluatedIssueSchema.safeParse(updated);
        if (!validated.success)
          return Response.json({ error: "invalid_operator_response" }, { status: 502 });
        return Response.json(validated.data);
      } catch {
        return Response.json({ error: "intake_unavailable" }, { status: 503 });
      }
    }

    // POST /api/v1/projects/:projectId/intake/:number/bind
    if (subAction === "bind") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = targetBindingSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      try {
        const bound = await intakeService.bindProjectTarget(projectId, issueNum, parsed.data);
        const validated = targetBindingResultSchema.safeParse(bound);
        if (!validated.success)
          return Response.json({ error: "invalid_operator_response" }, { status: 502 });
        return Response.json(validated.data);
      } catch (err: any) {
        if (err instanceof TargetBindingError) {
          const status = err.code === "issue_not_found" ? 404 : 409;
          return Response.json({ error: err.code, details: err.message }, { status });
        }
        return Response.json({ error: "intake_unavailable" }, { status: 503 });
      }
    }

    // POST /api/v1/projects/:projectId/intake/:number/integrate
    if (subAction === "integrate") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = branchIntegrationSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      try {
        const res = intakeService.recordBranchIntegration(
          projectId,
          issueNum,
          parsed.data.branch,
          parsed.data.commit_sha,
        );
        return Response.json(res);
      } catch {
        return Response.json({ error: "intake_unavailable" }, { status: 503 });
      }
    }

    // GET /api/v1/projects/:projectId/intake/:number/integration
    if (subAction === "integration") {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      const res = intakeService.getBranchIntegration(projectId, issueNum);
      if (!res) {
        return Response.json({ error: "issue_not_found" }, { status: 404 });
      }
      return Response.json(res);
    }
  }

  return null;
}
