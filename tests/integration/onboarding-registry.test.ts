import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { ProjectOnboardingService } from "../../apps/backend/src/registry/onboarding";

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
    expect(project.checkout_path).toBe(join(root, "state", "projects", "Owner", "Repo"));
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
    mkdirSync(join(root, "state", "projects"), { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "state", "projects", "Owner"));
    await expect(
      onboarding.register({ method: "github_clone", name: "Repo", repo: "Owner/Repo" }),
    ).rejects.toMatchObject({ code: "project_checkout_invalid" });
    expect(registry.listProjects()).toEqual([]);
    rmSync(join(root, "state", "projects", "Owner"));
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
});
