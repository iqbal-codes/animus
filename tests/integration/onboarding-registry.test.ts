import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { ProjectOnboardingService } from "../../apps/backend/src/registry/onboarding";
import { installOnboardedAnimusHome } from "./machine-home-fixture";
describe("backend registration preparation", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let onboarding: ProjectOnboardingService;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "onboarding-registry-"));
    db = initializeDatabase(join(root, "state", "console.db"));
    forge = new SyntheticForgeAdapter({ "Owner/Repo": 123 });
    registry = new ProjectRegistryService(db, forge);
    onboarding = new ProjectOnboardingService(registry, join(root, "state"));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("clones into a verified managed path, preserves existing labels/issues, and repeats without duplicate enrollment", async () => {
    await forge.createLabel("Owner/Repo", {
      name: "custom",
      color: "123456",
      description: "Keep me",
    });
    await forge.createLabel("Owner/Repo", {
      name: "ready-for-agent",
      color: "abcdef",
      description: "Keep this too",
    });
    forge.addIssue("Owner/Repo", { number: 1, title: "Untriaged", state: "OPEN", labels: [] });
    const project = await onboarding.register({
      method: "github_clone",
      name: "Repo",
      repo: "Owner/Repo",
    });
    expect(project.checkout_path).toBe(join(root, "projects", "Repo"));
    expect(registry.getProject(project.id).status).toBe("active");
    expect(
      await onboarding.register({ method: "github_clone", name: "Repo", repo: "Owner/Repo" }),
    ).toEqual(project);
    expect((await forge.listLabels("Owner/Repo")).map((label) => label.name).sort()).toEqual([
      "custom",
      "needs-info",
      "needs-triage",
      "ready-for-agent",
      "ready-for-human",
      "wontfix",
    ]);
    expect(
      (await forge.listLabels("Owner/Repo")).find((label) => label.name === "ready-for-agent"),
    ).toEqual({ name: "ready-for-agent", color: "abcdef", description: "Keep this too" });
    expect((await forge.getIssue("Owner/Repo", 1))?.labels).toEqual([]);
    await expect(
      registry.registerProject({
        method: "local_checkout",
        name: "Repo",
        checkout_path: project.checkout_path,
      }),
    ).rejects.toMatchObject({ code: "project_already_exists" });
  });

  test("label failure preserves checkout but blocks enrollment, and retry completes", async () => {
    forge.failNextLabel = true;
    await expect(
      onboarding.register({ method: "github_clone", name: "Repo", repo: "Owner/Repo" }),
    ).rejects.toMatchObject({
      code: "partial_registration_effect",
      message: expect.stringContaining("labels are preserved"),
    });
    expect(registry.listProjects()).toEqual([]);
    const project = await onboarding.register({
      method: "github_clone",
      name: "Repo",
      repo: "Owner/Repo",
    });
    expect(project.status).toBe("active");
  });

  test("create prepares labels and retry reuses the repository and local checkout", async () => {
    const project = await onboarding.register({
      method: "github_create",
      name: "New",
      repo: "Owner/New",
      private: true,
    });
    expect(project.repo_name).toBe("Owner/New");
    expect((await forge.listLabels("Owner/New")).length).toBe(5);
    expect(
      (await onboarding.register({ method: "github_create", name: "New", repo: "Owner/New" })).id,
    ).toBe(project.id);
  });

  test("local checkout must exist on this machine and match the selected repository", async () => {
    await expect(
      onboarding.register({
        method: "local_checkout",
        name: "Remote",
        checkout_path: join(root, "not-on-this-machine"),
      }),
    ).rejects.toMatchObject({ code: "project_checkout_invalid" });
    const local = join(root, "local");
    mkdirSync(join(local, ".git"), { recursive: true });
    writeFileSync(
      join(local, ".git/config"),
      '[remote "origin"]\n  url = https://github.com/Owner/Other.git\n',
    );
    await expect(
      onboarding.register({
        method: "github_clone",
        name: "Wrong",
        repo: "Owner/Repo",
        target_path: local,
      }),
    ).rejects.toMatchObject({
      code: "partial_registration_effect",
      message: expect.stringContaining("identity does not match"),
    });
    expect(registry.listProjects()).toEqual([]);
  });

  test("managed paths reject symbolic-link escapes and alternate checkout enrollment", async () => {
    mkdirSync(join(root, "projects"), { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "projects", "Repo"));
    await expect(
      onboarding.register({ method: "github_clone", name: "Repo", repo: "Owner/Repo" }),
    ).rejects.toMatchObject({ code: "project_checkout_invalid" });
    expect(registry.listProjects()).toEqual([]);
    rmSync(join(root, "projects", "Repo"));
    const project = await onboarding.register({
      method: "github_clone",
      name: "Repo",
      repo: "Owner/Repo",
    });
    await expect(
      onboarding.register({
        method: "github_clone",
        name: "Repo",
        repo: "Owner/Repo",
        target_path: join(root, "different"),
      }),
    ).rejects.toMatchObject({ code: "project_already_exists" });
    expect(registry.listProjects().map((entry) => entry.id)).toEqual([project.id]);
  });

  test("unsafe verified identities never become managed paths", async () => {
    forge.addRepository("../escape", 124);
    await expect(
      onboarding.register({ method: "github_clone", name: "Escape", repo: "../escape" }),
    ).rejects.toMatchObject({ code: "project_checkout_invalid" });
    expect(registry.listProjects()).toEqual([]);
  });

  test("getProjectByRepoName looks up case-insensitively and ignores tombstones", async () => {
    const project = await onboarding.register({
      method: "github_clone",
      name: "Repo",
      repo: "Owner/Repo",
    });

    // Exact and case-insensitive match
    expect(registry.getProjectByRepoName("Owner/Repo")?.id).toBe(project.id);
    expect(registry.getProjectByRepoName("owner/repo")?.id).toBe(project.id);
    expect(registry.getProjectByRepoName("OWNER/REPO")?.id).toBe(project.id);

    // Non-existent repo returns null
    expect(registry.getProjectByRepoName("NonExistent/Repo")).toBeNull();

    // Tombstone project returns null
    await registry.deregisterProject(project.id);
    expect(registry.getProjectByRepoName("Owner/Repo")).toBeNull();
  });

  test("initializes local-only repository in managed projects dir and allows multiple local-only projects", async () => {
    const projA = await onboarding.register({
      method: "local_init",
      name: "alpha-local",
      default_branch: "main",
    });
    expect(projA.repo_id).toBe(0);
    expect(projA.repo_name).toBe("alpha-local");
    expect(projA.checkout_path).toBe(join(root, "projects", "alpha-local"));
    expect(projA.status).toBe("active");

    const projB = await onboarding.register({
      method: "local_init",
      name: "beta-local",
    });
    expect(projB.repo_id).toBe(0);
    expect(projB.checkout_path).toBe(join(root, "projects", "beta-local"));
    expect(registry.listProjects().map((p) => p.id)).toEqual([projA.id, projB.id]);
  });

  test("supports fs browse, local inspection, remote link inspection, and abortable clone job cancellation", async () => {
    const outsideRepo = join(root, "outside-repo");
    mkdirSync(join(outsideRepo, ".git"), { recursive: true });
    writeFileSync(join(outsideRepo, ".git", "HEAD"), "ref: refs/heads/develop\n");
    writeFileSync(
      join(outsideRepo, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:Owner/Repo.git\n',
    );

    const browse = onboarding.browseDirectories(root);
    expect(browse.entries.some((e) => e.name === "outside-repo" && e.isGitRepo)).toBe(true);

    const localInfo = await onboarding.inspectLocal(outsideRepo);
    expect(localInfo.isGitRepo).toBe(true);
    expect(localInfo.branch).toBe("develop");
    expect(localInfo.repoName).toBe("Owner/Repo");
    expect(localInfo.errorCode).toBeNull();

    const invalidInfo = await onboarding.inspectLocal(join(root, "does-not-exist"));
    expect(invalidInfo.exists).toBe(false);
    expect(invalidInfo.errorCode).toBe("not_found");

    const remoteBad = await onboarding.inspectRemote("not-a-valid-url");
    expect(remoteBad.valid).toBe(false);
    expect(remoteBad.errorCode).toBe("invalid_url");

    const remoteOk = await onboarding.inspectRemote("https://github.com/Owner/Repo.git");
    expect(remoteOk.valid).toBe(true);
    expect(remoteOk.repoName).toBe("Owner/Repo");
    expect(remoteOk.destinationPath).toBe(join(root, "projects", "Repo"));

    const gate = Promise.withResolvers<void>();
    const origClone = forge.cloneRepository.bind(forge);
    forge.cloneRepository = async (repo, targetPath, opts) => {
      opts?.signal?.addEventListener("abort", () => gate.reject(new Error("Clone cancelled")));
      await gate.promise;
      return origClone(repo, targetPath, opts);
    };

    const job = await onboarding.startCloneJob("git@github.com:Owner/Repo.git");
    expect(["preparing", "cloning"]).toContain(job.status);
    const cancelled = onboarding.cancelCloneJob(job.jobId);
    expect(cancelled.status).toBe("cancelled");
    gate.resolve();
    expect(registry.listProjects()).toEqual([]);
  });

  test("automatically runs deterministic animus setup on local_init, local_checkout, and github_clone when machine is onboarded", async () => {
    const machineHome = installOnboardedAnimusHome();
    try {
      const localInitProj = await onboarding.register({
        method: "local_init",
        name: "auto-setup-local",
        default_branch: "develop",
      });
      expect(existsSync(join(localInitProj.checkout_path, ".animus/config.yaml"))).toBe(true);
      expect(existsSync(join(localInitProj.checkout_path, "harness/harness.config.json"))).toBe(
        true,
      );
      expect(existsSync(join(localInitProj.checkout_path, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(localInitProj.checkout_path, ".animus/hooks/loop-guard.ts"))).toBe(
        true,
      );
      expect(
        readFileSync(join(localInitProj.checkout_path, ".animus/config.yaml"), "utf-8"),
      ).toContain("baseBranch: develop");

      const clonedProj = await onboarding.register({
        method: "github_clone",
        name: "Repo",
        repo: "Owner/Repo",
      });
      expect(existsSync(join(clonedProj.checkout_path, ".animus/config.yaml"))).toBe(true);
      expect(existsSync(join(clonedProj.checkout_path, "harness/harness.config.json"))).toBe(true);
      expect(existsSync(join(clonedProj.checkout_path, "AGENTS.md"))).toBe(true);

      const localCheckoutDir = join(root, "existing-local-repo");
      execFileSync("git", ["init", "-q", "-b", "main", localCheckoutDir]);
      const localProj = await onboarding.register({
        method: "local_checkout",
        name: "existing-local-repo",
        checkout_path: localCheckoutDir,
      });
      expect(existsSync(join(localProj.checkout_path, ".animus/config.yaml"))).toBe(true);
      expect(existsSync(join(localProj.checkout_path, "harness/harness.config.json"))).toBe(true);
      expect(existsSync(join(localProj.checkout_path, "AGENTS.md"))).toBe(true);
    } finally {
      machineHome.restore();
    }
  });
});
