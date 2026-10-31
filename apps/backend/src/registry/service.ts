import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type Project,
  type ProjectRegistration,
  type ProjectRetarget,
  type DeregisterResult,
  type OperatorErrorCode,
} from "@animus/contracts/operator";
import { type ForgeAdapter, SystemForgeAdapter, resolveGitConfigPath } from "./forge";

export class ProjectRegistryError extends Error {
  constructor(
    public readonly code: OperatorErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ProjectRegistryError";
  }
}

interface ProjectRow {
  id: string;
  name: string;
  repo_id: number;
  repo_name: string;
  checkout_path: string;
  status: "active" | "held" | "tombstone";
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

export class ProjectRegistryService {
  private forge: ForgeAdapter;

  constructor(
    private db: DatabaseSync,
    forge?: ForgeAdapter,
  ) {
    this.forge = forge ?? new SystemForgeAdapter();
  }

  getDb(): DatabaseSync {
    return this.db;
  }

  getForge(): ForgeAdapter {
    return this.forge;
  }

  private mapRow(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      repo_id: row.repo_id,
      repo_name: row.repo_name,
      checkout_path: row.checkout_path,
      status: row.status,
      status_reason: row.status_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private verifyCheckoutIntegrity(row: ProjectRow): ProjectRow {
    if (row.status === "tombstone") {
      return row;
    }
    const checkoutExists =
      existsSync(row.checkout_path) && statSync(row.checkout_path).isDirectory();
    if (!checkoutExists) {
      if (row.status !== "held" || row.status_reason !== "checkout_missing") {
        this.updateProjectStatus(row.id, "held", "checkout_missing");
        row.status = "held";
        row.status_reason = "checkout_missing";
      }
      return row;
    }

    const gitConfig = resolveGitConfigPath(row.checkout_path);
    if (!gitConfig) {
      if (row.status !== "held" || row.status_reason !== "checkout_altered") {
        this.updateProjectStatus(row.id, "held", "checkout_altered");
        row.status = "held";
        row.status_reason = "checkout_altered";
      }
      return row;
    }

    return row;
  }

  private updateProjectStatus(
    id: string,
    status: "active" | "held" | "tombstone",
    statusReason: string | null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE projects SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, statusReason, now, id);
  }

  listProjects(includeTombstones = false): Project[] {
    const query = includeTombstones
      ? "SELECT * FROM projects ORDER BY created_at ASC"
      : "SELECT * FROM projects WHERE status != 'tombstone' ORDER BY created_at ASC";
    const rows = this.db.prepare(query).all() as unknown as ProjectRow[];
    return rows.map((r) => this.mapRow(this.verifyCheckoutIntegrity(r)));
  }

  getProject(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as
      | ProjectRow
      | undefined;
    if (!row) {
      throw new ProjectRegistryError("project_not_found");
    }
    return this.mapRow(this.verifyCheckoutIntegrity(row));
  }

  getProjectByRepoId(repoId: number): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE repo_id = ? AND status != 'tombstone'")
      .get(repoId) as unknown as ProjectRow | undefined;
    if (!row) return null;
    return this.mapRow(this.verifyCheckoutIntegrity(row));
  }

  async registerProject(registration: ProjectRegistration): Promise<Project> {
    const now = new Date().toISOString();
    const id = `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    if (registration.method === "local_checkout") {
      const checkoutPath = registration.checkout_path;
      if (!existsSync(checkoutPath) || !statSync(checkoutPath).isDirectory()) {
        throw new ProjectRegistryError(
          "project_checkout_invalid",
          `Checkout directory does not exist: ${checkoutPath}`,
        );
      }
      if (!resolveGitConfigPath(checkoutPath)) {
        throw new ProjectRegistryError(
          "project_checkout_invalid",
          `Directory is not a valid git repository or worktree: ${checkoutPath}`,
        );
      }

      let repoInfo;
      try {
        repoInfo = await this.forge.detectLocalCheckout(checkoutPath);
      } catch (err: any) {
        throw new ProjectRegistryError(
          "project_checkout_invalid",
          `Failed to detect GitHub repository: ${err?.message || String(err)}`,
        );
      }

      const existing = this.getProjectByRepoId(repoInfo.id);
      if (existing) {
        throw new ProjectRegistryError(
          "project_already_exists",
          `An active project already exists for repository ${repoInfo.repoName} (ID: ${repoInfo.id})`,
        );
      }

      this.db
        .prepare(
          `INSERT INTO projects (id, name, repo_id, repo_name, checkout_path, status, status_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
        )
        .run(id, registration.name, repoInfo.id, repoInfo.repoName, checkoutPath, now, now);

      return this.getProject(id);
    }

    if (registration.method === "github_clone") {
      if (!registration.target_path)
        throw new ProjectRegistryError(
          "invalid_payload",
          "Direct registry cloning requires target_path; use backend onboarding for managed checkout preparation",
        );
      let repoInfo;
      try {
        repoInfo = await this.forge.getRepository(registration.repo);
      } catch (err: any) {
        throw new ProjectRegistryError(
          "project_checkout_invalid",
          `Failed to find repository on forge: ${err?.message || String(err)}`,
        );
      }

      const existing = this.getProjectByRepoId(repoInfo.id);
      if (existing) {
        throw new ProjectRegistryError(
          "project_already_exists",
          `An active project already exists for repository ${repoInfo.repoName} (ID: ${repoInfo.id})`,
        );
      }

      const targetPath = registration.target_path;
      try {
        await this.forge.cloneRepository(registration.repo, targetPath);
      } catch {
        throw new ProjectRegistryError(
          "partial_registration_effect",
          `Cloning repository ${registration.repo} failed; target directory preserved without deletion.`,
        );
      }

      if (!existsSync(targetPath) || !existsSync(join(targetPath, ".git"))) {
        throw new ProjectRegistryError(
          "partial_registration_effect",
          `Cloned checkout at ${targetPath} is invalid or incomplete.`,
        );
      }

      this.db
        .prepare(
          `INSERT INTO projects (id, name, repo_id, repo_name, checkout_path, status, status_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
        )
        .run(id, registration.name, repoInfo.id, repoInfo.repoName, targetPath, now, now);

      return this.getProject(id);
    }

    if (registration.method === "github_create") {
      if (!registration.target_path)
        throw new ProjectRegistryError(
          "invalid_payload",
          "Direct registry creation requires target_path; use backend onboarding for managed checkout preparation",
        );
      let createdRepo;
      try {
        createdRepo = await this.forge.createRepository(
          registration.repo,
          registration.private ?? true,
        );
      } catch (err: any) {
        throw new ProjectRegistryError(
          "project_checkout_invalid",
          `Failed to create repository on GitHub: ${err?.message || String(err)}`,
        );
      }

      const existing = this.getProjectByRepoId(createdRepo.id);
      if (existing) {
        throw new ProjectRegistryError(
          "project_already_exists",
          `An active project already exists for repository ${createdRepo.repoName} (ID: ${createdRepo.id})`,
        );
      }

      const targetPath = registration.target_path;
      try {
        await this.forge.cloneRepository(createdRepo.repoName, targetPath);
      } catch {
        throw new ProjectRegistryError(
          "partial_registration_effect",
          `Repository ${createdRepo.repoName} was created on GitHub, but clone to ${targetPath} failed. Remote repository and target path preserved.`,
        );
      }

      if (!existsSync(targetPath) || !existsSync(join(targetPath, ".git"))) {
        throw new ProjectRegistryError(
          "partial_registration_effect",
          `Repository ${createdRepo.repoName} created, but local checkout at ${targetPath} is missing .git.`,
        );
      }

      this.db
        .prepare(
          `INSERT INTO projects (id, name, repo_id, repo_name, checkout_path, status, status_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
        )
        .run(id, registration.name, createdRepo.id, createdRepo.repoName, targetPath, now, now);

      return this.getProject(id);
    }

    throw new ProjectRegistryError("invalid_payload");
  }

  async retargetProject(id: string, submission: ProjectRetarget): Promise<Project> {
    const project = this.getProject(id);
    if (project.status === "tombstone") {
      throw new ProjectRegistryError("project_not_found");
    }

    const newPath = submission.checkout_path;
    if (!existsSync(newPath) || !statSync(newPath).isDirectory()) {
      throw new ProjectRegistryError(
        "project_checkout_invalid",
        `New checkout path does not exist: ${newPath}`,
      );
    }
    if (!resolveGitConfigPath(newPath)) {
      throw new ProjectRegistryError(
        "project_checkout_invalid",
        `New checkout path is not a valid git repository or worktree: ${newPath}`,
      );
    }

    let repoInfo;
    try {
      repoInfo = await this.forge.detectLocalCheckout(newPath);
    } catch (err: any) {
      throw new ProjectRegistryError(
        "project_checkout_invalid",
        `Failed to verify new checkout repository: ${err?.message || String(err)}`,
      );
    }

    if (repoInfo.id !== project.repo_id) {
      throw new ProjectRegistryError(
        "retarget_rejected",
        `New checkout points to repository ID ${repoInfo.id} (${repoInfo.repoName}), which does not match active project repository ID ${project.repo_id} (${project.repo_name}).`,
      );
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE projects SET checkout_path = ?, status = 'active', status_reason = NULL, updated_at = ? WHERE id = ?",
      )
      .run(newPath, now, id);

    return this.getProject(id);
  }

  async deregisterProject(id: string): Promise<DeregisterResult> {
    const project = this.getProject(id);
    if (project.status === "tombstone") {
      throw new ProjectRegistryError("project_not_found");
    }

    // Check for active runs
    const activeRuns = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM project_runs WHERE project_id = ? AND status = 'running'",
      )
      .get(id) as unknown as { count: number } | undefined;

    if (activeRuns && activeRuns.count > 0) {
      throw new ProjectRegistryError(
        "project_has_active_runs",
        `Project ${id} has ${activeRuns.count} active run(s) and cannot be deregistered.`,
      );
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE projects SET status = 'tombstone', status_reason = 'deregistered_by_operator', updated_at = ? WHERE id = ?",
      )
      .run(now, id);

    return {
      status: "tombstone",
      id,
    };
  }

  validateScope(projectId: string, resourceProjectId?: string): Project {
    if (!projectId || projectId.trim() === "") {
      throw new ProjectRegistryError("scope_mismatch");
    }
    const project = this.getProject(projectId);
    if (project.status === "tombstone") {
      throw new ProjectRegistryError("project_not_found");
    }
    if (resourceProjectId && resourceProjectId !== projectId) {
      throw new ProjectRegistryError("scope_mismatch");
    }
    return project;
  }

  // Helpers for testing project runs & isolation
  recordRun(runId: string, projectId: string, status = "running"): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO project_runs (id, project_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, projectId, status, now, now);
  }

  completeTrackedRun(trackingId: string, runId: string, status: string): void {
    this.db
      .prepare("UPDATE project_runs SET id = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(runId, status, new Date().toISOString(), trackingId);
  }

  updateRunStatus(runId: string, status: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE project_runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, runId);
  }

  getActiveRunCount(projectId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM project_runs WHERE project_id = ? AND status = 'running'",
      )
      .get(projectId) as unknown as { count: number } | undefined;
    return row ? row.count : 0;
  }

  getProjectRunIds(projectId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM project_runs WHERE project_id = ?")
      .all(projectId) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  getRunProject(runId: string): string | null {
    const row = this.db
      .prepare("SELECT project_id FROM project_runs WHERE id = ?")
      .get(runId) as unknown as
      | {
          project_id: string;
        }
      | undefined;
    return row ? row.project_id : null;
  }
}
