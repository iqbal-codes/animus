import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ensureStateDirectory,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { createFactoryClient } from "@labq/client";
import { projectSchema, projectListSchema, deregisterResultSchema } from "@labq/contracts/operator";

type DatabaseInstance = ReturnType<typeof initializeDatabase>;

describe("Project Registry & Persistence (Issue #59)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseInstance;
  let forge: SyntheticForgeAdapter;
  let service: ProjectRegistryService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "labq-registry-test-"));
    dbPath = join(tempDir, "state", "console.db");
    db = initializeDatabase(dbPath);
    forge = new SyntheticForgeAdapter({
      "owner/repo-alpha": 101,
      "owner/repo-beta": 102,
    });
    service = new ProjectRegistryService(db, forge);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockCheckout(name: string, remoteRepo = "owner/repo-alpha"): string {
    const checkoutPath = join(tempDir, name);
    mkdirSync(join(checkoutPath, ".git"), { recursive: true });
    writeFileSync(
      join(checkoutPath, ".git", "config"),
      `[remote "origin"]\n  url = https://github.com/${remoteRepo}.git\n`,
    );
    return checkoutPath;
  }

  function createMockWorktreeCheckout(name: string, remoteRepo = "owner/repo-alpha"): string {
    const mainRepo = join(tempDir, "main-repo");
    const worktreeGitDir = join(mainRepo, ".git", "worktrees", name);
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(
      join(mainRepo, ".git", "config"),
      `[remote "origin"]\n  url = https://github.com/${remoteRepo}.git\n`,
    );
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");

    const checkoutPath = join(tempDir, name);
    mkdirSync(checkoutPath, { recursive: true });
    writeFileSync(join(checkoutPath, ".git"), `gitdir: ${worktreeGitDir}\n`);
    return checkoutPath;
  }

  describe("AC1: Verified Project Registration & Duplicate Rejection", () => {
    test("registers project via local Git checkout with verified GitHub repo ID", async () => {
      const checkoutPath = createMockCheckout("checkout-alpha", "owner/repo-alpha");

      const project = await service.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      expect(project.id).toMatch(/^proj_/);
      expect(project.name).toBe("Alpha Project");
      expect(project.repo_id).toBe(101);
      expect(project.repo_name).toBe("owner/repo-alpha");
      expect(project.checkout_path).toBe(checkoutPath);
      expect(project.status).toBe("active");
      expect(project.status_reason).toBeNull();

      // Schema verification
      expect(projectSchema.parse(project)).toEqual(project);
    });

    test("registers project via Git worktree checkout with pointer .git file", async () => {
      const worktreePath = createMockWorktreeCheckout("checkout-worktree", "owner/repo-alpha");

      const project = await service.registerProject({
        method: "local_checkout",
        name: "Worktree Project",
        checkout_path: worktreePath,
      });

      expect(project.id).toMatch(/^proj_/);
      expect(project.name).toBe("Worktree Project");
      expect(project.repo_id).toBe(101);
      expect(project.checkout_path).toBe(worktreePath);
      expect(project.status).toBe("active");
    });

    test("registers project via GitHub clone", async () => {
      const targetPath = join(tempDir, "cloned-beta");

      const project = await service.registerProject({
        method: "github_clone",
        name: "Beta Cloned",
        repo: "owner/repo-beta",
        target_path: targetPath,
      });

      expect(project.repo_id).toBe(102);
      expect(project.checkout_path).toBe(targetPath);
      expect(project.status).toBe("active");
    });

    test("registers project via GitHub create + checkout", async () => {
      const targetPath = join(tempDir, "created-gamma");

      const project = await service.registerProject({
        method: "github_create",
        name: "Gamma Created",
        repo: "owner/repo-gamma",
        target_path: targetPath,
        private: true,
      });

      expect(project.name).toBe("Gamma Created");
      expect(project.repo_name).toBe("owner/repo-gamma");
      expect(project.status).toBe("active");
      expect(project.repo_id).toBeGreaterThanOrEqual(1000);
    });

    test("strictly rejects duplicate registration for the same GitHub repo ID", async () => {
      const checkout1 = createMockCheckout("checkout-1", "owner/repo-alpha");
      const checkout2 = createMockCheckout("checkout-2", "owner/repo-alpha");

      await service.registerProject({
        method: "local_checkout",
        name: "First Instance",
        checkout_path: checkout1,
      });

      await expect(
        service.registerProject({
          method: "local_checkout",
          name: "Second Instance",
          checkout_path: checkout2,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "project_already_exists" }));
    });

    test("offline checkouts preserve identity without mutation", async () => {
      const checkoutPath = createMockCheckout("checkout-offline", "owner/repo-alpha");
      const project = await service.registerProject({
        method: "local_checkout",
        name: "Offline Project",
        checkout_path: checkoutPath,
      });

      // Reading project when forge is offline
      const freshService = new ProjectRegistryService(db, {
        async getRepository() {
          throw new Error("Network down: offline");
        },
        async createRepository() {
          throw new Error("Network down: offline");
        },
        async cloneRepository() {
          throw new Error("Network down: offline");
        },
        async detectLocalCheckout() {
          throw new Error("Network down: offline");
        },
      });

      const retrieved = freshService.getProject(project.id);
      expect(retrieved.repo_id).toBe(101);
      expect(retrieved.repo_name).toBe("owner/repo-alpha");
      expect(retrieved.status).toBe("active");
    });
  });

  describe("AC2: Partial Registration Failure, Held State, & Retargeting", () => {
    test("reports partial registration failure without deleting target directory", async () => {
      forge.failNextClone = true;
      const targetPath = join(tempDir, "partial-gamma");
      mkdirSync(targetPath, { recursive: true });
      writeFileSync(join(targetPath, "partial_evidence.txt"), "keep this file");

      await expect(
        service.registerProject({
          method: "github_clone",
          name: "Partial Gamma",
          repo: "owner/repo-alpha",
          target_path: targetPath,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "partial_registration_effect" }));

      // Verify directory was NOT deleted
      expect(statSync(targetPath).isDirectory()).toBe(true);
      expect(statSync(join(targetPath, "partial_evidence.txt")).isFile()).toBe(true);
    });

    test("missing checkout transitions project status to held with checkout_missing", async () => {
      const checkoutPath = createMockCheckout("temp-to-delete", "owner/repo-alpha");
      const project = await service.registerProject({
        method: "local_checkout",
        name: "Doomed Path",
        checkout_path: checkoutPath,
      });

      expect(project.status).toBe("active");

      // Delete checkout directory
      rmSync(checkoutPath, { recursive: true, force: true });

      const checked = service.getProject(project.id);
      expect(checked.status).toBe("held");
      expect(checked.status_reason).toBe("checkout_missing");
    });

    test("corrupted .git directory transitions project status to held with checkout_altered", async () => {
      const checkoutPath = createMockCheckout("corrupted-git", "owner/repo-alpha");
      const project = await service.registerProject({
        method: "local_checkout",
        name: "Corrupt Git Project",
        checkout_path: checkoutPath,
      });

      // Remove .git directory
      rmSync(join(checkoutPath, ".git"), { recursive: true, force: true });

      const checked = service.getProject(project.id);
      expect(checked.status).toBe("held");
      expect(checked.status_reason).toBe("checkout_altered");
    });

    test("retargeting to same repo ID updates path and restores active status", async () => {
      const checkout1 = createMockCheckout("checkout-orig", "owner/repo-alpha");
      const checkout2 = createMockCheckout("checkout-relocated", "owner/repo-alpha");

      const project = await service.registerProject({
        method: "local_checkout",
        name: "Relocatable Project",
        checkout_path: checkout1,
      });

      // Simulate checkout1 deleted
      rmSync(checkout1, { recursive: true, force: true });
      expect(service.getProject(project.id).status).toBe("held");

      // Retarget to checkout2 pointing to the same repo
      const retargeted = await service.retargetProject(project.id, {
        checkout_path: checkout2,
      });

      expect(retargeted.checkout_path).toBe(checkout2);
      expect(retargeted.status).toBe("active");
      expect(retargeted.status_reason).toBeNull();
    });

    test("retargeting to a different repo ID is strictly rejected", async () => {
      const checkoutAlpha = createMockCheckout("checkout-alpha-1", "owner/repo-alpha");
      const checkoutBeta = createMockCheckout("checkout-beta-1", "owner/repo-beta");

      const project = await service.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutAlpha,
      });

      await expect(
        service.retargetProject(project.id, {
          checkout_path: checkoutBeta,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "retarget_rejected" }));
    });
  });

  describe("AC3: Project Isolation & Scope Enforcement", () => {
    test("scope validation rejects unknown or mismatched project scope", async () => {
      const checkoutAlpha = createMockCheckout("co-alpha", "owner/repo-alpha");
      const checkoutBeta = createMockCheckout("co-beta", "owner/repo-beta");

      const projAlpha = await service.registerProject({
        method: "local_checkout",
        name: "Alpha",
        checkout_path: checkoutAlpha,
      });
      const projBeta = await service.registerProject({
        method: "local_checkout",
        name: "Beta",
        checkout_path: checkoutBeta,
      });

      // Matching scope succeeds
      expect(service.validateScope(projAlpha.id, projAlpha.id).id).toBe(projAlpha.id);

      // Unknown scope throws project_not_found
      expect(() => service.validateScope("non_existent_id")).toThrow(
        expect.objectContaining({ code: "project_not_found" }),
      );

      // Mismatched scope throws scope_mismatch
      expect(() => service.validateScope(projAlpha.id, projBeta.id)).toThrow(
        expect.objectContaining({ code: "scope_mismatch" }),
      );

      // Empty scope throws scope_mismatch
      expect(() => service.validateScope("")).toThrow(
        expect.objectContaining({ code: "scope_mismatch" }),
      );
    });

    test("records and partitions runs strictly by project ID", async () => {
      const checkoutAlpha = createMockCheckout("co-run-alpha", "owner/repo-alpha");
      const checkoutBeta = createMockCheckout("co-run-beta", "owner/repo-beta");

      const projAlpha = await service.registerProject({
        method: "local_checkout",
        name: "Alpha",
        checkout_path: checkoutAlpha,
      });
      const projBeta = await service.registerProject({
        method: "local_checkout",
        name: "Beta",
        checkout_path: checkoutBeta,
      });

      service.recordRun("run-shared-number-1", projAlpha.id, "running");
      service.recordRun("run-shared-number-2", projBeta.id, "running");

      expect(service.getRunProject("run-shared-number-1")).toBe(projAlpha.id);
      expect(service.getRunProject("run-shared-number-2")).toBe(projBeta.id);
    });
  });

  describe("AC4: SQLite WAL Persistence & Directory Permissions", () => {
    test("state directory is created with 0700 permissions", () => {
      const stateDir = join(tempDir, "secure-state");
      ensureStateDirectory(stateDir);
      const stat = statSync(stateDir);
      // Mode 0700: (stat.mode & 0o777) === 0o700
      expect(stat.mode & 0o777).toBe(0o700);
    });

    test("survives restart across distinct connection instances in WAL mode", async () => {
      const checkoutPath = createMockCheckout("co-persist", "owner/repo-alpha");
      const project = await service.registerProject({
        method: "local_checkout",
        name: "Persistent Project",
        checkout_path: checkoutPath,
      });

      // Close first connection
      db.close();

      // Open second connection on same file
      const db2 = initializeDatabase(dbPath);
      const service2 = new ProjectRegistryService(db2, forge);

      const restored = service2.getProject(project.id);
      expect(restored.id).toBe(project.id);
      expect(restored.repo_name).toBe("owner/repo-alpha");
      expect(restored.status).toBe("active");

      // Verify WAL mode is enabled
      const walPragma = db2.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
      expect(walPragma.journal_mode.toLowerCase()).toBe("wal");

      db2.close();
    });
  });

  describe("AC5: Deregistration Rejection on Active Runs & Tombstone Retention", () => {
    test("rejects deregistration when active runs exist", async () => {
      const checkoutPath = createMockCheckout("co-active-run", "owner/repo-alpha");
      const project = await service.registerProject({
        method: "local_checkout",
        name: "Active Work Project",
        checkout_path: checkoutPath,
      });

      service.recordRun("run-active-123", project.id, "running");

      await expect(service.deregisterProject(project.id)).rejects.toThrow(
        expect.objectContaining({ code: "project_has_active_runs" }),
      );
    });

    test("deregistration succeeds once active run is updated to completed", async () => {
      const checkoutPath = createMockCheckout("co-completed-run", "owner/repo-alpha");
      const project = await service.registerProject({
        method: "local_checkout",
        name: "Lifecycle Project",
        checkout_path: checkoutPath,
      });

      service.recordRun("run-lifecycle-1", project.id, "running");
      expect(service.getActiveRunCount(project.id)).toBe(1);

      await expect(service.deregisterProject(project.id)).rejects.toThrow(
        expect.objectContaining({ code: "project_has_active_runs" }),
      );

      service.updateRunStatus("run-lifecycle-1", "completed");
      expect(service.getActiveRunCount(project.id)).toBe(0);

      const result = await service.deregisterProject(project.id);
      expect(result.status).toBe("tombstone");
      expect(service.getProject(project.id).status).toBe("tombstone");
    });

    test("marks project as tombstone and preserves files on disk when deregistered", async () => {
      const checkoutPath = createMockCheckout("co-tombstone", "owner/repo-alpha");
      const project = await service.registerProject({
        method: "local_checkout",
        name: "Dying Project",
        checkout_path: checkoutPath,
      });

      service.recordRun("run-done-123", project.id, "completed");

      const result = await service.deregisterProject(project.id);
      expect(result.status).toBe("tombstone");
      expect(result.id).toBe(project.id);

      // Check project in DB
      const tombstoned = service.getProject(project.id);
      expect(tombstoned.status).toBe("tombstone");
      expect(tombstoned.status_reason).toBe("deregistered_by_operator");

      // Active list excludes tombstones
      const activeList = service.listProjects(false);
      expect(activeList.find((p) => p.id === project.id)).toBeUndefined();

      // All list includes tombstones
      const allList = service.listProjects(true);
      expect(allList.find((p) => p.id === project.id)).toBeDefined();

      // Crucial: Disk checkout files are preserved
      expect(statSync(checkoutPath).isDirectory()).toBe(true);
      expect(statSync(join(checkoutPath, ".git")).isDirectory()).toBe(true);
    });
  });

  describe("AC6: Client SDK Integration via @labq/client", () => {
    test("client handles projects, registration, retargeting, and project-scoped calls", async () => {
      const mockProject = {
        id: "proj_mock_123",
        name: "Client Mock",
        repo_id: 201,
        repo_name: "owner/client-repo",
        checkout_path: "/tmp/mock-checkout",
        status: "active" as const,
        status_reason: null,
        created_at: "2026-10-28T00:00:00Z",
        updated_at: "2026-10-28T00:00:00Z",
      };

      const client = createFactoryClient({
        baseUrl: "http://localhost:8080",
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/api/v1/projects") && init?.method === "GET") {
            return Response.json([mockProject]);
          }
          if (url.endsWith("/api/v1/projects") && init?.method === "POST") {
            return Response.json(mockProject);
          }
          if (url.endsWith("/api/v1/projects/proj_mock_123") && init?.method === "GET") {
            return Response.json(mockProject);
          }
          if (url.endsWith("/api/v1/projects/proj_mock_123/retarget") && init?.method === "POST") {
            return Response.json({ ...mockProject, checkout_path: "/tmp/new-path" });
          }
          if (url.endsWith("/api/v1/projects/proj_mock_123") && init?.method === "DELETE") {
            return Response.json({ status: "tombstone", id: "proj_mock_123" });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      });

      const list = await client.projects();
      expect(projectListSchema.parse(list)).toHaveLength(1);
      expect(list[0].id).toBe("proj_mock_123");

      const single = await client.project("proj_mock_123");
      expect(projectSchema.parse(single)).toEqual(mockProject);

      const registered = await client.registerProject({
        method: "local_checkout",
        name: "Client Mock",
        checkout_path: "/tmp/mock-checkout",
      });
      expect(registered.id).toBe("proj_mock_123");

      const retargeted = await client.retargetProject("proj_mock_123", {
        checkout_path: "/tmp/new-path",
      });
      expect(retargeted.checkout_path).toBe("/tmp/new-path");

      const deregistered = await client.deregisterProject("proj_mock_123");
      expect(deregisterResultSchema.parse(deregistered)).toEqual({
        status: "tombstone",
        id: "proj_mock_123",
      });

      // Project-scoped client
      const scopedClient = client.forProject("proj_mock_123");
      const scopedProject = await scopedClient.project();
      expect(scopedProject.id).toBe("proj_mock_123");
    });
  });
});
