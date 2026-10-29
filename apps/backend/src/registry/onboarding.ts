import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Project, type ProjectRegistration } from "@labq/contracts/operator";
import { ProjectRegistryError, ProjectRegistryService } from "./service";
import { resolveStateDir } from "./db";
import { resolveGitConfigPath, type ForgeRepoInfo } from "./forge";

export const CANONICAL_LABELS = [
  {
    name: "ready-for-agent",
    color: "0e8a16",
    description: "Specified work eligible for agent admission",
  },
  { name: "needs-info", color: "d876e3", description: "Waiting for more information" },
  { name: "ready-for-human", color: "fbca04", description: "Requires human implementation" },
  { name: "needs-triage", color: "ededed", description: "Waiting for maintainer triage" },
  { name: "wontfix", color: "ffffff", description: "Will not be actioned" },
];

const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function verifyRepositoryIdentity(info: ForgeRepoInfo): void {
  if (!Number.isSafeInteger(info.id) || info.id <= 0 || !REPOSITORY_NAME.test(info.repoName)) {
    throw new ProjectRegistryError(
      "project_checkout_invalid",
      "Forge returned an unsafe repository identity",
    );
  }
}

export class ProjectOnboardingService {
  constructor(
    private registry: ProjectRegistryService,
    private stateDir = resolveStateDir(),
  ) {}

  async prepareLabels(repo: string): Promise<void> {
    const forge = this.registry.getForge();
    if (!forge.listLabels || !forge.createLabel)
      throw new Error("Configured forge cannot provision repository labels");
    const existing = new Set(
      (await forge.listLabels(repo)).map((label) => label.name.toLowerCase()),
    );
    for (const label of CANONICAL_LABELS) {
      if (!existing.has(label.name)) await forge.createLabel(repo, label);
    }
  }

  private managedPath(info: ForgeRepoInfo): string {
    const parts = [resolve(this.stateDir), "projects", ...info.repoName.split("/")];
    let current = parts[0]!;
    mkdirSync(current, { recursive: true, mode: 0o700 });
    if (lstatSync(current).isSymbolicLink())
      throw new ProjectRegistryError(
        "project_checkout_invalid",
        "Managed state directory cannot be a symbolic link",
      );
    for (const segment of parts.slice(1)) {
      current = join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new ProjectRegistryError(
            "project_checkout_invalid",
            "Managed checkout path contains a symbolic link",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return current;
  }

  async register(input: ProjectRegistration): Promise<Project> {
    const forge = this.registry.getForge();
    if (input.method !== "local_checkout") {
      const repo = input.repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
      if (!REPOSITORY_NAME.test(repo))
        throw new ProjectRegistryError(
          "project_checkout_invalid",
          "Invalid GitHub repository name",
        );
    }
    let info: ForgeRepoInfo;
    let checkout: string;
    let created = false;
    if (input.method === "local_checkout") {
      checkout = resolve(input.checkout_path);
      if (
        !existsSync(checkout) ||
        !statSync(checkout).isDirectory() ||
        !resolveGitConfigPath(checkout)
      )
        throw new ProjectRegistryError(
          "project_checkout_invalid",
          `No valid local checkout at ${checkout}`,
        );
      info = await forge.detectLocalCheckout(checkout);
    } else {
      // Re-running create must not create another repository. Lookup failures on clone are never converted to create.
      if (input.method === "github_create") {
        try {
          info = await forge.getRepository(input.repo);
        } catch {
          info = await forge.createRepository(input.repo, input.private ?? true);
          created = true;
        }
      } else info = await forge.getRepository(input.repo);
      verifyRepositoryIdentity(info);
      checkout = input.target_path ? resolve(input.target_path) : this.managedPath(info);
    }
    verifyRepositoryIdentity(info);
    const existing = this.registry.getProjectByRepoId(info.id);
    if (
      existing &&
      resolve(existing.checkout_path) !== checkout &&
      (!existsSync(existing.checkout_path) ||
        !existsSync(checkout) ||
        realpathSync(existing.checkout_path) !== realpathSync(checkout))
    ) {
      throw new ProjectRegistryError(
        "project_already_exists",
        "Repository is enrolled at a different checkout; use retarget explicitly",
      );
    }
    const lockDir = join(resolve(this.stateDir), "registration-locks");
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const lock = join(lockDir, String(info.id));
    try {
      mkdirSync(lock);
    } catch {
      throw new ProjectRegistryError(
        "partial_registration_effect",
        "Registration is already in progress; retry after it completes",
      );
    }
    try {
      if (!existsSync(checkout) && input.method !== "local_checkout") {
        mkdirSync(dirname(checkout), { recursive: true });
        await forge.cloneRepository(info.repoName, checkout);
      }
      if (!resolveGitConfigPath(checkout))
        throw new Error(`Checkout at ${checkout} is invalid or incomplete`);
      const detected = await forge.detectLocalCheckout(checkout);
      if (
        detected.id !== info.id ||
        detected.repoName.toLowerCase() !== info.repoName.toLowerCase()
      )
        throw new Error("Checkout identity does not match requested repository");
      await this.prepareLabels(info.repoName);
      if (existing) {
        if (existing.status !== "active")
          return await this.registry.retargetProject(existing.id, { checkout_path: checkout });
        return existing;
      }
      try {
        return await this.registry.registerProject({
          method: "local_checkout",
          name: input.name,
          checkout_path: checkout,
        });
      } catch (error) {
        if (error instanceof ProjectRegistryError && error.code === "project_already_exists") {
          const winner = this.registry.getProjectByRepoId(info.id);
          if (winner && realpathSync(winner.checkout_path) === realpathSync(checkout))
            return winner;
        }
        throw error;
      }
    } catch (error) {
      throw new ProjectRegistryError(
        "partial_registration_effect",
        `${created ? "Remote repository created. " : ""}Registration preparation failed: ${error instanceof Error ? error.message : String(error)}. Existing repository, checkout and labels are preserved; ${existing ? "the existing enrollment is unchanged" : "enrollment was not completed"}.`,
      );
    } finally {
      rmdirSync(lock);
    }
  }
}
