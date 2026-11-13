import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type FsBrowseResult,
  type Project,
  type ProjectCloneJobStatus,
  type ProjectInspectLocalResult,
  type ProjectInspectRemoteResult,
  type ProjectRegistration,
} from "@animus/contracts/operator";
import {
  MachineOnboardingRequiredError,
  readMachineConfig,
} from "@animus/contracts/machine-config";
import { resolveAnimusProjectsDir } from "@animus/contracts/paths";
import { resolveStateDir } from "./db";
import { ProjectRegistryError, ProjectRegistryService } from "./service";
import {
  normalizeGitHubRepoSpecifier,
  parseGitRemoteUrl,
  resolveGitConfigPath,
  type ForgeRepoInfo,
} from "./forge";
const execFileAsync = promisify(execFile);

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
const LOCAL_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export function verifyRepositoryIdentity(info: ForgeRepoInfo): void {
  if (!Number.isSafeInteger(info.id) || info.id <= 0 || !REPOSITORY_NAME.test(info.repoName)) {
    throw new ProjectRegistryError(
      "project_checkout_invalid",
      "Forge returned an unsafe repository identity",
    );
  }
}

interface InternalCloneJob {
  jobId: string;
  status: ProjectCloneJobStatus["status"];
  phaseLabel: string;
  destinationPath: string;
  repoName: string | null;
  project: Project | null;
  errorCode: string | null;
  errorMessage: string | null;
  controller: AbortController;
  createdAt: number;
}

function readGitBranchSync(checkoutPath: string): string | null {
  try {
    const headPath = join(checkoutPath, ".git", "HEAD");
    if (existsSync(headPath) && statSync(headPath).isFile()) {
      const head = readFileSync(headPath, "utf-8").trim();
      if (head.startsWith("ref: refs/heads/")) {
        return head.slice("ref: refs/heads/".length) || null;
      }
    }
  } catch {}
  try {
    const res = execFileSync("git", ["-C", checkoutPath, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (res && res !== "HEAD") return res;
  } catch {}
  return null;
}

export class ProjectOnboardingService {
  private cloneJobs = new Map<string, InternalCloneJob>();

  constructor(
    private registry: ProjectRegistryService,
    private stateDir = resolveStateDir(),
    private projectsDir?: string,
  ) {}

  private resolveProjectsRoot(): string {
    if (this.projectsDir && this.projectsDir.trim() !== "") {
      return resolve(this.projectsDir);
    }
    const envProjects = process.env.ANIMUS_PROJECTS_DIR;
    if (envProjects && envProjects.trim() !== "") {
      return resolve(envProjects.trim());
    }
    const resolvedState = resolve(this.stateDir);
    if (basename(resolvedState) === "state") {
      return join(dirname(resolvedState), "projects");
    }
    return resolveAnimusProjectsDir();
  }

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

  private safeManagedTarget(folderSegments: string[]): string {
    const root = this.resolveProjectsRoot();
    const parts = [root, ...folderSegments];
    let current = parts[0]!;
    mkdirSync(current, { recursive: true, mode: 0o700 });
    if (lstatSync(current).isSymbolicLink())
      throw new ProjectRegistryError(
        "project_checkout_invalid",
        "Managed projects directory cannot be a symbolic link",
      );
    for (const segment of parts.slice(1)) {
      if (
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\")
      ) {
        throw new ProjectRegistryError("project_checkout_invalid", "Unsafe managed folder name");
      }
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

  private managedPath(info: ForgeRepoInfo): string {
    const repoLeaf = info.repoName.split("/")[1] || info.repoName;
    return this.safeManagedTarget([repoLeaf]);
  }

  private managedLocalPath(name: string): string {
    const trimmed = name.trim();
    if (!LOCAL_REPO_NAME.test(trimmed)) {
      throw new ProjectRegistryError(
        "project_checkout_invalid",
        "Repository name must start with a letter or number and contain only letters, numbers, '.', '-', or '_'.",
      );
    }
    return this.safeManagedTarget([trimmed]);
  }

  browseDirectories(rawPath?: string): FsBrowseResult {
    const homePath = homedir();
    const projectsPath = this.resolveProjectsRoot();
    const target = rawPath && rawPath.trim() !== "" ? resolve(rawPath.trim()) : homePath;
    const parent = dirname(target);
    const parentPath = parent !== target ? parent : null;

    try {
      const st = statSync(target);
      if (!st.isDirectory()) {
        return {
          currentPath: target,
          parentPath,
          homePath,
          projectsPath,
          entries: [],
          error: "Selected path is not a directory.",
        };
      }
      const dirents = readdirSync(target, { withFileTypes: true });
      const entries = dirents
        .filter((d) => {
          if (!d.isDirectory()) return false;
          if (d.name.startsWith(".")) return false;
          return true;
        })
        .map((d) => {
          const full = join(target, d.name);
          let isGitRepo = false;
          try {
            isGitRepo = Boolean(resolveGitConfigPath(full));
          } catch {}
          return { name: d.name, path: full, isGitRepo };
        })
        .sort((a, b) => Number(b.isGitRepo) - Number(a.isGitRepo) || a.name.localeCompare(b.name));
      return {
        currentPath: target,
        parentPath,
        homePath,
        projectsPath,
        entries,
        error: null,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        currentPath: target,
        parentPath,
        homePath,
        projectsPath,
        entries: [],
        error:
          code === "EACCES" || code === "EPERM"
            ? "Animus could not read this directory because access was denied."
            : "Directory does not exist or could not be opened.",
      };
    }
  }

  async inspectLocal(rawPath: string): Promise<ProjectInspectLocalResult> {
    const trimmed = rawPath.trim();
    const resolvedPath = trimmed.startsWith("~/")
      ? join(homedir(), trimmed.slice(2))
      : trimmed === "~"
        ? homedir()
        : resolve(trimmed);

    if (!existsSync(resolvedPath)) {
      return {
        path: resolvedPath,
        exists: false,
        isDirectory: false,
        readable: false,
        isGitRepo: false,
        isWorktree: false,
        name: null,
        branch: null,
        remoteUrl: null,
        repoName: null,
        alreadyEnrolled: false,
        existingProject: null,
        errorCode: "not_found",
        errorMessage: "Folder does not exist on this machine.",
      };
    }

    let isDir = false;
    try {
      isDir = statSync(resolvedPath).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        path: resolvedPath,
        exists: true,
        isDirectory: false,
        readable: false,
        isGitRepo: false,
        isWorktree: false,
        name: null,
        branch: null,
        remoteUrl: null,
        repoName: null,
        alreadyEnrolled: false,
        existingProject: null,
        errorCode: code === "EACCES" || code === "EPERM" ? "access_denied" : "not_found",
        errorMessage:
          code === "EACCES" || code === "EPERM"
            ? "Animus could not read the repository metadata because folder access was denied."
            : "Unable to read this path.",
      };
    }

    if (!isDir) {
      return {
        path: resolvedPath,
        exists: true,
        isDirectory: false,
        readable: true,
        isGitRepo: false,
        isWorktree: false,
        name: null,
        branch: null,
        remoteUrl: null,
        repoName: null,
        alreadyEnrolled: false,
        existingProject: null,
        errorCode: "not_directory",
        errorMessage: "Selected path is not a directory.",
      };
    }

    try {
      readdirSync(resolvedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        path: resolvedPath,
        exists: true,
        isDirectory: true,
        readable: false,
        isGitRepo: false,
        isWorktree: false,
        name: null,
        branch: null,
        remoteUrl: null,
        repoName: null,
        alreadyEnrolled: false,
        existingProject: null,
        errorCode: code === "EACCES" || code === "EPERM" ? "access_denied" : "not_found",
        errorMessage:
          "Animus could not read the repository metadata because folder access was denied.",
      };
    }

    const gitEntry = join(resolvedPath, ".git");
    const gitConfig = resolveGitConfigPath(resolvedPath);
    if (!gitConfig) {
      return {
        path: resolvedPath,
        exists: true,
        isDirectory: true,
        readable: true,
        isGitRepo: false,
        isWorktree: false,
        name: basename(resolvedPath) || null,
        branch: null,
        remoteUrl: null,
        repoName: null,
        alreadyEnrolled: false,
        existingProject: null,
        errorCode: "not_git_repo",
        errorMessage: "Choose a folder containing a .git directory or initialize a repository.",
      };
    }

    let isWorktree = false;
    try {
      isWorktree = statSync(gitEntry).isFile();
    } catch {}

    const remoteUrl = parseGitRemoteUrl(resolvedPath);
    const repoName = remoteUrl ? normalizeGitHubRepoSpecifier(remoteUrl) : null;
    const branch = readGitBranchSync(resolvedPath);
    const folderName = basename(resolvedPath) || repoName || "repository";

    let existing = this.registry.getProjectByCheckoutPath(resolvedPath);
    if (!existing && repoName) {
      existing = this.registry.getProjectByRepoName(repoName);
    }

    return {
      path: resolvedPath,
      exists: true,
      isDirectory: true,
      readable: true,
      isGitRepo: true,
      isWorktree,
      name: folderName,
      branch,
      remoteUrl,
      repoName,
      alreadyEnrolled: Boolean(existing),
      existingProject: existing,
      errorCode: existing ? "already_enrolled" : null,
      errorMessage: existing
        ? `This repository is already enrolled in your workspace at ${existing.checkout_path}.`
        : null,
    };
  }

  async inspectRemote(rawUrl: string): Promise<ProjectInspectRemoteResult> {
    const trimmed = rawUrl.trim();
    const cleanRepo = normalizeGitHubRepoSpecifier(trimmed);
    if (!cleanRepo) {
      return {
        inputUrl: rawUrl,
        valid: false,
        normalizedUrl: null,
        repoName: null,
        suggestedName: null,
        defaultBranch: null,
        destinationPath: null,
        destinationExists: false,
        alreadyEnrolled: false,
        existingProject: null,
        errorCode: "invalid_url",
        errorMessage:
          "Enter a valid repository link (e.g. https://github.com/owner/repo, git@github.com:owner/repo.git, or owner/repo).",
      };
    }

    const forge = this.registry.getForge();
    let info: ForgeRepoInfo;
    try {
      info = await forge.getRepository(cleanRepo);
    } catch (error) {
      return {
        inputUrl: rawUrl,
        valid: false,
        normalizedUrl: `https://github.com/${cleanRepo}`,
        repoName: cleanRepo,
        suggestedName: cleanRepo.split("/")[1] || cleanRepo,
        defaultBranch: null,
        destinationPath: null,
        destinationExists: false,
        alreadyEnrolled: false,
        existingProject: null,
        errorCode: "not_accessible",
        errorMessage:
          error instanceof Error
            ? error.message
            : "Repository could not be verified. Check the link and your GitHub access.",
      };
    }

    const suggestedName = info.repoName.split("/")[1] || info.repoName;
    const destinationPath = this.managedPath(info);
    const existing =
      this.registry.getProjectByRepoId(info.id) ??
      this.registry.getProjectByRepoName(info.repoName);
    if (existing) {
      return {
        inputUrl: rawUrl,
        valid: false,
        normalizedUrl: `https://github.com/${info.repoName}`,
        repoName: info.repoName,
        suggestedName,
        defaultBranch: null,
        destinationPath,
        destinationExists: existsSync(destinationPath),
        alreadyEnrolled: true,
        existingProject: existing,
        errorCode: "already_enrolled",
        errorMessage: `This repository is already enrolled at ${existing.checkout_path}.`,
      };
    }

    const destinationExists = existsSync(destinationPath);
    const destHasOtherGit = destinationExists && Boolean(resolveGitConfigPath(destinationPath));
    if (destinationExists) {
      const destRemote = destHasOtherGit ? parseGitRemoteUrl(destinationPath) : null;
      const destClean = destRemote ? normalizeGitHubRepoSpecifier(destRemote) : null;
      if (!destClean || destClean.toLowerCase() !== info.repoName.toLowerCase()) {
        return {
          inputUrl: rawUrl,
          valid: false,
          normalizedUrl: `https://github.com/${info.repoName}`,
          repoName: info.repoName,
          suggestedName,
          defaultBranch: null,
          destinationPath,
          destinationExists: true,
          alreadyEnrolled: false,
          existingProject: null,
          errorCode: "destination_exists",
          errorMessage: `Target folder ${destinationPath} already exists and is not empty.`,
        };
      }
    }

    return {
      inputUrl: rawUrl,
      valid: true,
      normalizedUrl: `https://github.com/${info.repoName}`,
      repoName: info.repoName,
      suggestedName,
      defaultBranch: "main",
      destinationPath,
      destinationExists,
      alreadyEnrolled: false,
      existingProject: null,
      errorCode: null,
      errorMessage: null,
    };
  }

  private serializeCloneJob(job: InternalCloneJob): ProjectCloneJobStatus {
    return {
      jobId: job.jobId,
      status: job.status,
      phaseLabel: job.phaseLabel,
      destinationPath: job.destinationPath,
      repoName: job.repoName,
      project: job.project,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
    };
  }

  async startCloneJob(url: string, name?: string): Promise<ProjectCloneJobStatus> {
    const inspection = await this.inspectRemote(url);
    if (!inspection.valid || !inspection.repoName || !inspection.destinationPath) {
      throw new ProjectRegistryError(
        inspection.errorCode === "already_enrolled"
          ? "project_already_exists"
          : inspection.errorCode === "destination_exists"
            ? "destination_already_exists"
            : "project_checkout_invalid",
        inspection.errorMessage ?? "Invalid remote repository",
      );
    }

    const jobId = `clone_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const job: InternalCloneJob = {
      jobId,
      status: "preparing",
      phaseLabel: "Preparing folder",
      destinationPath: inspection.destinationPath,
      repoName: inspection.repoName,
      project: null,
      errorCode: null,
      errorMessage: null,
      controller: new AbortController(),
      createdAt: Date.now(),
    };
    this.cloneJobs.set(jobId, job);

    const projectName = (name && name.trim()) || inspection.suggestedName || inspection.repoName;

    void (async () => {
      try {
        job.status = "cloning";
        job.phaseLabel = "Cloning repository…";
        const project = await this.register(
          {
            method: "github_clone",
            name: projectName,
            repo: inspection.repoName!,
          },
          {
            signal: job.controller.signal,
            onPhase: (phase, label) => {
              if (job.controller.signal.aborted) return;
              job.status = phase;
              job.phaseLabel = label;
            },
          },
        );
        if (job.controller.signal.aborted) {
          job.status = "cancelled";
          job.phaseLabel = "Clone cancelled";
          return;
        }
        job.status = "completed";
        job.phaseLabel = "Repository added";
        job.project = project;
      } catch (error) {
        if (job.controller.signal.aborted) {
          job.status = "cancelled";
          job.phaseLabel = "Clone cancelled";
          job.errorCode = "clone_cancelled";
          job.errorMessage = "Clone was cancelled before enrollment completed.";
          return;
        }
        job.status = "failed";
        job.phaseLabel = "Clone failed";
        job.errorCode = error instanceof ProjectRegistryError ? error.code : "clone_failed";
        job.errorMessage = error instanceof Error ? error.message : "Clone could not finish.";
      }
    })();

    return this.serializeCloneJob(job);
  }

  getCloneJob(jobId: string): ProjectCloneJobStatus {
    const job = this.cloneJobs.get(jobId);
    if (!job) {
      throw new ProjectRegistryError("clone_job_not_found", `Clone job ${jobId} not found`);
    }
    return this.serializeCloneJob(job);
  }

  cancelCloneJob(jobId: string): ProjectCloneJobStatus {
    const job = this.cloneJobs.get(jobId);
    if (!job) {
      throw new ProjectRegistryError("clone_job_not_found", `Clone job ${jobId} not found`);
    }
    if (job.status === "preparing" || job.status === "cloning" || job.status === "enrolling") {
      job.controller.abort();
      job.status = "cancelled";
      job.phaseLabel = "Clone cancelled";
      job.errorCode = "clone_cancelled";
      job.errorMessage = "Clone was cancelled.";
      if (
        existsSync(job.destinationPath) &&
        !this.registry.getProjectByCheckoutPath(job.destinationPath)
      ) {
        try {
          rmSync(job.destinationPath, { recursive: true, force: true });
        } catch {}
      }
    }
    return this.serializeCloneJob(job);
  }
  private async runAutomaticSetup(
    checkoutPath: string,
    options?: {
      allowLocalWithoutRemote?: boolean;
      baseBranch?: string;
      onPhase?: (phase: "preparing" | "cloning" | "enrolling", label: string) => void;
    },
  ): Promise<void> {
    options?.onPhase?.("enrolling", "Configuring repository harness & settings…");
    try {
      const machine = readMachineConfig();
      const factory = new URL("../../../../", import.meta.url);
      const setupMod = (await import(new URL("scripts/cli/commands/setup.ts", factory).href)) as {
        applyRepositorySetup: (
          opts: {
            repoRoot: string;
            nonInteractive?: boolean;
            allowLocalWithoutRemote?: boolean;
            agentsMdAction?: "keep" | "overwrite";
            baseBranch?: string;
            json?: boolean;
          },
          interaction?: { detectHarnesses?: () => unknown[] },
        ) => Promise<unknown>;
      };
      await setupMod.applyRepositorySetup(
        {
          repoRoot: checkoutPath,
          nonInteractive: true,
          allowLocalWithoutRemote: options?.allowLocalWithoutRemote ?? true,
          agentsMdAction: "keep",
          ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
          json: true,
        },
        machine?.system.defaultProvider ? { detectHarnesses: () => [] } : undefined,
      );
    } catch (error) {
      if (error instanceof MachineOnboardingRequiredError) {
        // Test environments or non-onboarded hosts still allow registering checkouts without writing config.
        return;
      }
      throw error;
    }
  }

  async register(
    input: ProjectRegistration,
    options?: {
      signal?: AbortSignal;
      onPhase?: (phase: "preparing" | "cloning" | "enrolling", label: string) => void;
    },
  ): Promise<Project> {
    const forge = this.registry.getForge();
    if (input.method === "local_init") {
      const trimmedName = input.name.trim();
      const targetPath = this.managedLocalPath(trimmedName);
      const existingAtPath = this.registry.getProjectByCheckoutPath(targetPath);
      if (existingAtPath) {
        throw new ProjectRegistryError(
          "project_already_exists",
          `An active project already exists at ${targetPath}`,
        );
      }
      if (existsSync(targetPath)) {
        throw new ProjectRegistryError(
          "destination_already_exists",
          `A folder named "${trimmedName}" already exists in ${this.resolveProjectsRoot()}. Choose a different repository name or open the existing folder instead.`,
        );
      }
      const branch = input.default_branch?.trim() || "main";
      mkdirSync(targetPath, { recursive: true });
      try {
        await execFileAsync("git", ["init", "-b", branch, targetPath], {
          encoding: "utf-8",
          timeout: 15_000,
        });
      } catch {
        await execFileAsync("git", ["init", targetPath], {
          encoding: "utf-8",
          timeout: 15_000,
        });
        try {
          await execFileAsync(
            "git",
            ["-C", targetPath, "symbolic-ref", "HEAD", `refs/heads/${branch}`],
            {
              encoding: "utf-8",
              timeout: 5_000,
            },
          );
        } catch {}
      }
      await this.runAutomaticSetup(targetPath, {
        allowLocalWithoutRemote: true,
        baseBranch: branch,
        onPhase: options?.onPhase,
      });
      return await this.registry.registerProject({
        method: "local_checkout",
        name: trimmedName,
        checkout_path: targetPath,
      });
    }
    if (input.method !== "local_checkout") {
      const repo = normalizeGitHubRepoSpecifier(input.repo);
      if (!repo)
        throw new ProjectRegistryError(
          "project_checkout_invalid",
          "Invalid GitHub repository name",
        );
    }
    let info: ForgeRepoInfo | null = null;
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
      const remoteUrl = parseGitRemoteUrl(checkout);
      const githubRepo = remoteUrl ? normalizeGitHubRepoSpecifier(remoteUrl) : null;
      if (githubRepo) {
        info = await forge.detectLocalCheckout(checkout);
      } else {
        const existingLocal = this.registry.getProjectByCheckoutPath(checkout);
        if (existingLocal) {
          if (existingLocal.status !== "active") {
            await this.runAutomaticSetup(checkout, {
              allowLocalWithoutRemote: true,
              onPhase: options?.onPhase,
            });
            return await this.registry.retargetProject(existingLocal.id, {
              checkout_path: checkout,
            });
          }
          return existingLocal;
        }
        await this.runAutomaticSetup(checkout, {
          allowLocalWithoutRemote: true,
          onPhase: options?.onPhase,
        });
        return await this.registry.registerProject({
          method: "local_checkout",
          name: input.name,
          checkout_path: checkout,
        });
      }
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
    let clonedNewDir = false;
    try {
      if (options?.signal?.aborted) {
        throw new ProjectRegistryError("clone_cancelled", "Clone was cancelled.");
      }
      if (!existsSync(checkout) && input.method !== "local_checkout") {
        options?.onPhase?.("cloning", "Cloning repository…");
        mkdirSync(dirname(checkout), { recursive: true });
        clonedNewDir = true;
        await forge.cloneRepository(info.repoName, checkout, { signal: options?.signal });
      }
      if (options?.signal?.aborted) {
        throw new ProjectRegistryError("clone_cancelled", "Clone was cancelled.");
      }
      if (!resolveGitConfigPath(checkout))
        throw new Error(`Checkout at ${checkout} is invalid or incomplete`);
      const detected = await forge.detectLocalCheckout(checkout);
      if (
        detected.id !== info.id ||
        detected.repoName.toLowerCase() !== info.repoName.toLowerCase()
      )
        throw new Error("Checkout identity does not match requested repository");
      options?.onPhase?.("enrolling", "Provisioning labels & enrolling repository…");
      await this.prepareLabels(info.repoName);
      await this.runAutomaticSetup(checkout, {
        allowLocalWithoutRemote: false,
        onPhase: options?.onPhase,
      });
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
      if (
        options?.signal?.aborted ||
        (error instanceof ProjectRegistryError && error.code === "clone_cancelled")
      ) {
        if (clonedNewDir && existsSync(checkout)) {
          try {
            rmSync(checkout, { recursive: true, force: true });
          } catch {}
        }
        throw new ProjectRegistryError("clone_cancelled", "Clone was cancelled.");
      }
      throw new ProjectRegistryError(
        "partial_registration_effect",
        `${created ? "Remote repository created. " : ""}Registration preparation failed: ${error instanceof Error ? error.message : String(error)}. Existing repository, checkout and labels are preserved; ${existing ? "the existing enrollment is unchanged" : "enrollment was not completed"}.`,
      );
    } finally {
      rmdirSync(lock);
    }
  }
}
