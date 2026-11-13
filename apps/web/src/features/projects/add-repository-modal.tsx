import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Home,
  Loader2,
} from "lucide-react";
import type {
  FsBrowseResult,
  Project,
  ProjectCloneJobStatus,
  ProjectInspectLocalResult,
  ProjectInspectRemoteResult,
} from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ModalStep = "choose" | "local" | "remote" | "create" | "added";

export interface AddRepositoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (project: Project) => void;
}

function formatProjectsPreviewPath(projectsPath: string | null | undefined, name: string): string {
  const cleanName = name.trim() || "<name>";
  if (!projectsPath) return `~/.animus/projects/${cleanName}`;
  return `${projectsPath.replace(/\/+$/, "")}/${cleanName}`;
}

function validateLocalRepoName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a repository name.";
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    return "Repository name cannot contain path separators.";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(trimmed)) {
    return "Use letters, numbers, '.', '-', or '_' starting with a letter or number.";
  }
  return null;
}

export function AddRepositoryModal({ open, onOpenChange, onSuccess }: AddRepositoryModalProps) {
  const [step, setStep] = useState<ModalStep>("choose");
  const [addedVia, setAddedVia] = useState<"local" | "remote" | "create">("local");
  const [addedProject, setAddedProject] = useState<Project | null>(null);

  // Local folder state
  const [localPath, setLocalPath] = useState("");
  const [localInspecting, setLocalInspecting] = useState(false);
  const [localInspection, setLocalInspection] = useState<ProjectInspectLocalResult | null>(null);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserState, setBrowserState] = useState<FsBrowseResult | null>(null);

  // Remote link clone state
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteInspecting, setRemoteInspecting] = useState(false);
  const [remoteInspection, setRemoteInspection] = useState<ProjectInspectRemoteResult | null>(null);
  const [remoteCheckError, setRemoteCheckError] = useState<string | null>(null);
  const [cloneJob, setCloneJob] = useState<ProjectCloneJobStatus | null>(null);
  const [cloneStarting, setCloneStarting] = useState(false);
  const [cloneCancelling, setCloneCancelling] = useState(false);
  const clonePollRef = useRef<number | null>(null);

  // Create local-only repo state
  const [createName, setCreateName] = useState("");
  const [createNameTouched, setCreateNameTouched] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [managedProjectsRoot, setManagedProjectsRoot] = useState<string | null>(null);

  const stopClonePolling = () => {
    if (clonePollRef.current !== null) {
      window.clearInterval(clonePollRef.current);
      clonePollRef.current = null;
    }
  };

  const resetAll = () => {
    stopClonePolling();
    setStep("choose");
    setAddedProject(null);
    setLocalPath("");
    setLocalInspecting(false);
    setLocalInspection(null);
    setLocalSubmitting(false);
    setLocalError(null);
    setBrowserOpen(false);
    setBrowserLoading(false);
    setBrowserState(null);
    setRemoteUrl("");
    setRemoteInspecting(false);
    setRemoteInspection(null);
    setRemoteCheckError(null);
    setCloneJob(null);
    setCloneStarting(false);
    setCloneCancelling(false);
    setCreateName("");
    setCreateNameTouched(false);
    setCreateSubmitting(false);
    setCreateError(null);
  };

  useEffect(() => {
    return () => stopClonePolling();
  }, []);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (
        cloneJob &&
        (cloneJob.status === "preparing" ||
          cloneJob.status === "cloning" ||
          cloneJob.status === "enrolling")
      ) {
        void client.cancelProjectClone(cloneJob.jobId).catch(() => {});
      }
      resetAll();
    }
    onOpenChange(nextOpen);
  };

  // Inspect local folder on debounced input change
  const runLocalInspect = async (targetPath: string) => {
    const trimmed = targetPath.trim();
    if (!trimmed) {
      setLocalInspection(null);
      setLocalError(null);
      return;
    }
    setLocalInspecting(true);
    setLocalError(null);
    try {
      const result = await client.inspectLocalProject(trimmed);
      setLocalInspection(result);
    } catch (err: unknown) {
      setLocalInspection(null);
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalInspecting(false);
    }
  };

  useEffect(() => {
    if (!open || step !== "local") return;
    const trimmed = localPath.trim();
    if (!trimmed) {
      setLocalInspection(null);
      setLocalError(null);
      return;
    }
    const timer = setTimeout(() => {
      void runLocalInspect(trimmed);
    }, 250);
    return () => clearTimeout(timer);
  }, [open, step, localPath]);

  const loadDirectoryBrowser = async (targetPath?: string) => {
    setBrowserLoading(true);
    try {
      const result = await client.browseDirectories(targetPath);
      setBrowserState(result);
      if (result.projectsPath) setManagedProjectsRoot(result.projectsPath);
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowserLoading(false);
    }
  };

  const handleToggleBrowser = () => {
    if (browserOpen) {
      setBrowserOpen(false);
      return;
    }
    setBrowserOpen(true);
    void loadDirectoryBrowser(localPath.trim() || undefined);
  };

  const handleSelectDirectory = (entryPath: string, isGitRepo: boolean) => {
    setLocalPath(entryPath);
    setLocalError(null);
    if (isGitRepo) {
      setBrowserOpen(false);
      void runLocalInspect(entryPath);
    } else {
      void loadDirectoryBrowser(entryPath);
    }
  };

  const handleUseCurrentFolder = () => {
    if (!browserState?.currentPath) return;
    setLocalPath(browserState.currentPath);
    setBrowserOpen(false);
    void runLocalInspect(browserState.currentPath);
  };

  const handleSubmitLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = localPath.trim();
    if (!trimmed) return;
    if (localInspection?.alreadyEnrolled && localInspection.existingProject) {
      onSuccess(localInspection.existingProject);
      handleOpenChange(false);
      return;
    }
    setLocalSubmitting(true);
    setLocalError(null);
    try {
      const name =
        localInspection?.name || trimmed.split("/").filter(Boolean).pop() || "local-project";
      const project = await client.registerProject({
        method: "local_checkout",
        name,
        checkout_path: trimmed,
      });
      setAddedVia("local");
      setAddedProject(project);
      setStep("added");
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalSubmitting(false);
    }
  };

  // Remote link inspection & clone job polling
  const runRemoteInspect = async (urlToCheck: string) => {
    const trimmed = urlToCheck.trim();
    if (!trimmed) {
      setRemoteInspection(null);
      setRemoteCheckError(null);
      return;
    }
    setRemoteInspecting(true);
    setRemoteCheckError(null);
    setCloneJob(null);
    try {
      const res = await client.inspectRemoteRepository(trimmed);
      setRemoteInspection(res);
    } catch (err: unknown) {
      setRemoteInspection(null);
      setRemoteCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteInspecting(false);
    }
  };

  const handleRemoteUrlChange = (value: string) => {
    setRemoteUrl(value);
    setRemoteCheckError(null);
    if (remoteInspection && value.trim() !== remoteInspection.inputUrl.trim()) {
      setRemoteInspection(null);
    }
    if (
      cloneJob &&
      cloneJob.status !== "preparing" &&
      cloneJob.status !== "cloning" &&
      cloneJob.status !== "enrolling"
    ) {
      setCloneJob(null);
    }
  };

  const startPollingCloneJob = (jobId: string) => {
    stopClonePolling();
    clonePollRef.current = window.setInterval(async () => {
      try {
        const latest = await client.projectCloneStatus(jobId);
        setCloneJob(latest);
        if (latest.status === "completed" && latest.project) {
          stopClonePolling();
          setAddedVia("remote");
          setAddedProject(latest.project);
          setStep("added");
        } else if (latest.status === "failed" || latest.status === "cancelled") {
          stopClonePolling();
        }
      } catch (err: unknown) {
        stopClonePolling();
        setRemoteCheckError(err instanceof Error ? err.message : String(err));
      }
    }, 200);
  };

  const handleStartClone = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = remoteUrl.trim();
    if (!trimmed) return;

    if (remoteInspection?.alreadyEnrolled && remoteInspection.existingProject) {
      onSuccess(remoteInspection.existingProject);
      handleOpenChange(false);
      return;
    }

    if (!remoteInspection || !remoteInspection.valid) {
      await runRemoteInspect(trimmed);
      return;
    }

    setCloneStarting(true);
    setRemoteCheckError(null);
    try {
      const started = await client.startProjectClone(
        trimmed,
        remoteInspection.suggestedName ?? undefined,
      );
      setCloneJob(started);
      if (started.status === "completed" && started.project) {
        setAddedVia("remote");
        setAddedProject(started.project);
        setStep("added");
      } else if (
        started.status === "preparing" ||
        started.status === "cloning" ||
        started.status === "enrolling"
      ) {
        startPollingCloneJob(started.jobId);
      }
    } catch (err: unknown) {
      setRemoteCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloneStarting(false);
    }
  };

  const handleCancelClone = async () => {
    if (!cloneJob) return;
    setCloneCancelling(true);
    stopClonePolling();
    try {
      const cancelled = await client.cancelProjectClone(cloneJob.jobId);
      setCloneJob(cancelled);
    } catch (err: unknown) {
      setRemoteCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloneCancelling(false);
    }
  };

  // Fetch managed projects root when entering create mode
  useEffect(() => {
    if (!open || step !== "create" || managedProjectsRoot) return;
    void client
      .browseDirectories()
      .then((res) => {
        if (res.projectsPath) setManagedProjectsRoot(res.projectsPath);
      })
      .catch(() => {});
  }, [open, step, managedProjectsRoot]);

  const createNameError = createNameTouched ? validateLocalRepoName(createName) : null;

  const handleSubmitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateNameTouched(true);
    const validationErr = validateLocalRepoName(createName);
    if (validationErr) {
      setCreateError(validationErr);
      return;
    }
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const project = await client.registerProject({
        method: "local_init",
        name: createName.trim(),
        default_branch: "main",
      });
      setAddedVia("create");
      setAddedProject(project);
      setStep("added");
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateSubmitting(false);
    }
  };

  const isCloningInFlight =
    cloneJob !== null &&
    (cloneJob.status === "preparing" ||
      cloneJob.status === "cloning" ||
      cloneJob.status === "enrolling");

  const localInvalid =
    localInspection !== null &&
    localInspection.errorCode !== null &&
    localInspection.errorCode !== "already_enrolled";

  const localAlreadyEnrolled =
    localInspection !== null && localInspection.errorCode === "already_enrolled";

  const localCanSubmit =
    !localSubmitting &&
    !localInspecting &&
    Boolean(localPath.trim()) &&
    localInspection !== null &&
    (localInspection.isGitRepo || localAlreadyEnrolled) &&
    !localInvalid;

  const remoteInvalid =
    remoteInspection !== null &&
    !remoteInspection.valid &&
    remoteInspection.errorCode !== "already_enrolled";

  const remoteAlreadyEnrolled =
    remoteInspection !== null && remoteInspection.errorCode === "already_enrolled";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[520px] max-w-[calc(100vw-2rem)] sm:max-w-[520px] gap-6 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface)] p-7 text-foreground shadow-[var(--shadow-elevation-3)]">
        {step === "choose" && (
          <div className="flex flex-col gap-5">
            <DialogHeader className="gap-1.5 pr-8 text-left">
              <DialogTitle className="text-[20px] leading-[1.3] font-medium tracking-[-0.01em] text-foreground">
                Add repository
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                Choose how you want to bring a codebase into Animus.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              {/* Option 1: Select local folder */}
              <button
                type="button"
                onClick={() => {
                  setStep("local");
                  setLocalError(null);
                }}
                className="group flex items-center gap-3.5 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] p-4 text-left transition-colors hover:border-[var(--elevation-edge)] hover:bg-[var(--elevation-3-surface)]"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--elevation-3-surface)] text-foreground">
                  <FolderOpen className="size-[18px]" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">Select local folder</div>
                  <div className="mt-0.5 text-xs leading-[1.45] text-[var(--text-secondary)]">
                    Use a Git repository already on this computer.
                  </div>
                </div>
                <ChevronRight
                  className="size-4 shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-foreground"
                  aria-hidden="true"
                />
              </button>

              {/* Option 2: Clone repository by link */}
              <button
                type="button"
                onClick={() => {
                  setStep("remote");
                  setRemoteCheckError(null);
                }}
                className="group flex items-center gap-3.5 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] p-4 text-left transition-colors hover:border-[var(--elevation-edge)] hover:bg-[var(--elevation-3-surface)]"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--elevation-3-surface)] text-foreground">
                  <GitPullRequest className="size-[18px]" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">Clone repository</div>
                  <div className="mt-0.5 text-xs leading-[1.45] text-[var(--text-secondary)]">
                    Paste a GitHub repository link to validate and clone into Animus.
                  </div>
                </div>
                <ChevronRight
                  className="size-4 shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-foreground"
                  aria-hidden="true"
                />
              </button>

              {/* Option 3: Create new repo (local-only in ~/.animus/projects) */}
              <button
                type="button"
                onClick={() => {
                  setStep("create");
                  setCreateError(null);
                }}
                className="group flex items-center gap-3.5 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] p-4 text-left transition-colors hover:border-[var(--elevation-edge)] hover:bg-[var(--elevation-3-surface)]"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--elevation-3-surface)] text-foreground">
                  <FolderPlus className="size-[18px]" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">Create new repo</div>
                  <div className="mt-0.5 text-xs leading-[1.45] text-[var(--text-secondary)]">
                    Name a project. Animus creates its folder and sets up Git.
                  </div>
                </div>
                <ChevronRight
                  className="size-4 shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-foreground"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        )}

        {step === "local" && (
          <form onSubmit={handleSubmitLocal} className="flex flex-col gap-5">
            <DialogHeader className="gap-1.5 pr-8 text-left">
              <DialogTitle className="text-[20px] leading-[1.3] font-medium tracking-[-0.01em] text-foreground">
                Select local folder
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                Browse for a folder on this computer or paste a repository path.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2.5">
              <Label htmlFor="local-path" className="text-xs font-medium text-foreground">
                Repository folder
              </Label>
              <Input
                id="local-path"
                value={localPath}
                onChange={(e) => {
                  setLocalPath(e.target.value);
                  setLocalError(null);
                }}
                placeholder="/Users/alex/Projects/platform"
                aria-invalid={localInvalid || Boolean(localError)}
                className="h-11 rounded-[var(--radius-news)] border-[var(--border-subtle)] bg-[var(--overlay)] px-3.5 text-[13px] text-foreground placeholder:text-[var(--text-muted)]"
              />
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleToggleBrowser}
                  className="h-8 rounded-full border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-3.5 text-xs font-medium text-foreground hover:bg-[var(--elevation-3-surface)]"
                >
                  <FolderOpen className="size-3.5" aria-hidden="true" />
                  {browserOpen ? "Hide folder browser" : "Browse folders"}
                </Button>
                {localInspecting && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    Checking folder…
                  </span>
                )}
              </div>
            </div>

            {/* Server-backed folder browser */}
            {browserOpen && (
              <div
                data-testid="local-folder-browser"
                className="flex flex-col overflow-hidden rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--overlay)]"
              >
                <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void loadDirectoryBrowser(browserState?.homePath)}
                      title="Home folder"
                      aria-label="Go to home folder"
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--white-04)] hover:text-foreground"
                    >
                      <Home className="size-3.5" />
                    </button>
                    {browserState?.parentPath && (
                      <button
                        type="button"
                        onClick={() =>
                          void loadDirectoryBrowser(browserState.parentPath ?? undefined)
                        }
                        title="Parent folder"
                        aria-label="Go to parent folder"
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--white-04)] hover:text-foreground"
                      >
                        <ArrowUp className="size-3.5" />
                      </button>
                    )}
                    <span className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
                      {browserState?.currentPath ?? "Loading…"}
                    </span>
                  </div>
                  {browserState?.currentPath && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={handleUseCurrentFolder}
                      className="h-7 shrink-0 rounded-full px-2.5 text-[11px] text-foreground hover:bg-[var(--white-04)]"
                    >
                      Select current
                    </Button>
                  )}
                </div>

                <div className="max-h-[176px] overflow-y-auto p-1.5">
                  {browserLoading ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--text-secondary)]">
                      <Loader2 className="size-3.5 animate-spin" />
                      <span>Loading folders…</span>
                    </div>
                  ) : browserState?.error ? (
                    <div className="px-3 py-4 text-xs text-[var(--error)]">
                      {browserState.error}
                    </div>
                  ) : !browserState || browserState.entries.length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">
                      No subfolders found here.
                    </div>
                  ) : (
                    browserState.entries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        onClick={() => handleSelectDirectory(entry.path, entry.isGitRepo)}
                        className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-news)] px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-[var(--white-04)]"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {entry.isGitRepo ? (
                            <FolderGit2 className="size-3.5 shrink-0 text-[var(--success)]" />
                          ) : (
                            <Folder className="size-3.5 shrink-0 text-[var(--text-secondary)]" />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </span>
                        {entry.isGitRepo && (
                          <span className="shrink-0 rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--success)]">
                            Git repo
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Live Git Inspection Preview */}
            {localInspection && localInspection.isGitRepo && !localAlreadyEnrolled && (
              <div
                data-testid="local-repo-preview"
                className="flex flex-col gap-1.5 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {localInspection.name}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--white-04)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
                    <GitBranch className="size-3" aria-hidden="true" />
                    {localInspection.branch || "Git repository"}
                  </span>
                </div>
                <div className="truncate font-mono text-xs text-[var(--text-secondary)]">
                  {localInspection.repoName
                    ? `github.com/${localInspection.repoName}`
                    : localInspection.remoteUrl || "Local Git repository · No remote configured"}
                </div>
              </div>
            )}

            {/* Error / Already Enrolled States */}
            {(localError || localInvalid || localAlreadyEnrolled) && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--overlay)] px-4 py-3 text-xs"
              >
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0 text-[var(--error)]"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium text-foreground">
                    {localAlreadyEnrolled
                      ? "This repository is already added"
                      : localInspection?.errorCode === "access_denied"
                        ? "Animus cannot access this folder"
                        : localInspection?.errorCode === "not_git_repo"
                          ? "This folder is not a Git repository"
                          : "Could not add local folder"}
                  </div>
                  <div className="leading-[1.45] text-[var(--text-secondary)]">
                    {localError || localInspection?.errorMessage}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep("choose")}
                disabled={localSubmitting}
                className="rounded-full border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-5 text-[13px] font-medium text-foreground hover:bg-[var(--elevation-3-surface)]"
              >
                Back
              </Button>
              <Button
                type="submit"
                disabled={!localCanSubmit}
                className="rounded-full bg-primary px-5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                {localSubmitting && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                )}
                {localAlreadyEnrolled ? "Open repository" : "Add repository"}
              </Button>
            </div>
          </form>
        )}

        {step === "remote" && (
          <form onSubmit={handleStartClone} className="flex flex-col gap-5">
            <DialogHeader className="gap-1.5 pr-8 text-left">
              <DialogTitle className="text-[20px] leading-[1.3] font-medium tracking-[-0.01em] text-foreground">
                Clone repository
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                Paste a GitHub repository link. Animus validates access before cloning it into{" "}
                <span className="font-mono text-foreground">~/.animus/projects</span>.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <Label htmlFor="remote-url" className="text-xs font-medium text-foreground">
                Repository link
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="remote-url"
                  value={remoteUrl}
                  onChange={(e) => handleRemoteUrlChange(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  disabled={isCloningInFlight || cloneStarting}
                  aria-invalid={remoteInvalid || Boolean(remoteCheckError)}
                  className="h-11 flex-1 rounded-[var(--radius-news)] border-[var(--border-subtle)] bg-[var(--overlay)] px-3.5 text-[13px] text-foreground placeholder:text-[var(--text-muted)]"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void runRemoteInspect(remoteUrl)}
                  disabled={
                    !remoteUrl.trim() || remoteInspecting || isCloningInFlight || cloneStarting
                  }
                  className="h-11 shrink-0 rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-4 text-xs font-medium text-foreground hover:bg-[var(--elevation-3-surface)]"
                >
                  {remoteInspecting ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      Validating…
                    </>
                  ) : (
                    "Validate"
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                Supports HTTPS, SSH (
                <span className="font-mono">git@github.com:owner/repo.git</span>), or{" "}
                <span className="font-mono">owner/repo</span>.
              </p>
            </div>

            {/* Validated remote preview + automatic storage path */}
            {remoteInspection && remoteInspection.valid && !isCloningInFlight && (
              <div
                data-testid="remote-repo-preview"
                className="flex flex-col gap-2.5 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {remoteInspection.repoName}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-[var(--text-secondary)]">
                      {remoteInspection.normalizedUrl}
                    </div>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--success-bg)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--success)]">
                    Verified
                  </span>
                </div>
                <div className="border-t border-[var(--border-subtle)] pt-2.5 text-xs text-[var(--text-secondary)]">
                  <span className="font-medium text-foreground">Managed by Animus:</span>{" "}
                  <span className="font-mono break-all">
                    {formatProjectsPreviewPath(
                      remoteInspection.destinationPath?.replace(/\/[^/]+$/, ""),
                      remoteInspection.suggestedName ?? "",
                    )}
                  </span>
                </div>
              </div>
            )}

            {/* In-flight cloning state */}
            {isCloningInFlight && cloneJob && (
              <div
                data-testid="clone-progress-card"
                role="status"
                className="flex flex-col gap-2.5 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] p-4"
              >
                <div className="flex items-center gap-2.5">
                  <Loader2
                    className="size-4 shrink-0 animate-spin text-foreground"
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium text-foreground">{cloneJob.phaseLabel}</span>
                </div>
                <div className="truncate font-mono text-xs text-[var(--text-secondary)]">
                  {cloneJob.repoName} → {cloneJob.destinationPath}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--elevation-3-surface)]">
                  <div
                    className={`h-full rounded-full bg-primary transition-all duration-300 ${
                      cloneJob.status === "preparing"
                        ? "w-1/4"
                        : cloneJob.status === "cloning"
                          ? "w-2/3"
                          : "w-11/12"
                    }`}
                  />
                </div>
              </div>
            )}

            {/* Validation / Clone failure / Cancelled / Already enrolled alert */}
            {(remoteCheckError ||
              remoteInvalid ||
              remoteAlreadyEnrolled ||
              cloneJob?.status === "failed" ||
              cloneJob?.status === "cancelled") && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--overlay)] px-4 py-3 text-xs"
              >
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0 text-[var(--error)]"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium text-foreground">
                    {remoteAlreadyEnrolled
                      ? "Repository is already enrolled"
                      : cloneJob?.status === "cancelled"
                        ? "Clone cancelled"
                        : cloneJob?.status === "failed"
                          ? "Clone could not finish"
                          : remoteInspection?.errorCode === "destination_exists"
                            ? "Project folder already exists"
                            : "Repository validation failed"}
                  </div>
                  <div className="leading-[1.45] text-[var(--text-secondary)]">
                    {remoteCheckError || cloneJob?.errorMessage || remoteInspection?.errorMessage}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-1">
              {isCloningInFlight ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleCancelClone()}
                  disabled={cloneCancelling}
                  className="rounded-full border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-5 text-[13px] font-medium text-foreground hover:bg-[var(--elevation-3-surface)]"
                >
                  {cloneCancelling ? "Cancelling…" : "Cancel clone"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setCloneJob(null);
                    setStep("choose");
                  }}
                  disabled={cloneStarting}
                  className="rounded-full border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-5 text-[13px] font-medium text-foreground hover:bg-[var(--elevation-3-surface)]"
                >
                  Back
                </Button>
              )}

              <Button
                type="submit"
                disabled={
                  !remoteUrl.trim() ||
                  remoteInspecting ||
                  cloneStarting ||
                  isCloningInFlight ||
                  remoteInvalid
                }
                className="rounded-full bg-primary px-5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                {(remoteInspecting || cloneStarting || isCloningInFlight) && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                )}
                {remoteAlreadyEnrolled
                  ? "Open repository"
                  : cloneJob?.status === "failed" || cloneJob?.status === "cancelled"
                    ? "Retry clone"
                    : remoteInspection?.valid
                      ? "Clone repository"
                      : "Validate link"}
              </Button>
            </div>
          </form>
        )}

        {step === "create" && (
          <form onSubmit={handleSubmitCreate} className="flex flex-col gap-5">
            <DialogHeader className="gap-1.5 pr-8 text-left">
              <DialogTitle className="text-[20px] leading-[1.3] font-medium tracking-[-0.01em] text-foreground">
                Create new repository
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                Animus creates a new folder and initializes a local Git repository automatically.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <Label htmlFor="create-name" className="text-xs font-medium text-foreground">
                Repository name
              </Label>
              <Input
                id="create-name"
                value={createName}
                onChange={(e) => {
                  setCreateName(e.target.value);
                  setCreateNameTouched(true);
                  setCreateError(null);
                }}
                placeholder="my-agent-system"
                aria-invalid={Boolean(createNameError || createError)}
                className="h-11 rounded-[var(--radius-news)] border-[var(--border-subtle)] bg-[var(--overlay)] px-3.5 text-[13px] text-foreground placeholder:text-[var(--text-muted)]"
              />
              {createNameError && <p className="text-xs text-[var(--error)]">{createNameError}</p>}
            </div>

            <div className="flex flex-col gap-1.5 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-4 py-3 text-xs">
              <div className="font-medium text-foreground">Created automatically in</div>
              <div className="truncate font-mono text-[var(--text-secondary)]">
                {formatProjectsPreviewPath(managedProjectsRoot, createName)}
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                Local only · Default branch <span className="font-mono">main</span> · No remote
                created
              </div>
            </div>

            {createError && !createNameError && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--overlay)] px-4 py-3 text-xs"
              >
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0 text-[var(--error)]"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium text-foreground">Could not create repository</div>
                  <div className="leading-[1.45] text-[var(--text-secondary)]">{createError}</div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep("choose")}
                disabled={createSubmitting}
                className="rounded-full border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-5 text-[13px] font-medium text-foreground hover:bg-[var(--elevation-3-surface)]"
              >
                Back
              </Button>
              <Button
                type="submit"
                disabled={createSubmitting || Boolean(validateLocalRepoName(createName))}
                className="rounded-full bg-primary px-5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                {createSubmitting && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                )}
                Create repository
              </Button>
            </div>
          </form>
        )}

        {step === "added" && addedProject && (
          <div className="flex flex-col gap-5" data-testid="repository-added-step">
            <DialogHeader className="gap-1.5 pr-8 text-left">
              <DialogTitle className="text-[20px] leading-[1.3] font-medium tracking-[-0.01em] text-foreground">
                Repository added
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-[1.45] text-[var(--text-secondary)]">
                {addedVia === "create"
                  ? "Your new local repository is initialized and ready in Animus."
                  : addedVia === "remote"
                    ? "Repository cloned and enrolled in your workspace."
                    : "Local repository connected to your workspace."}
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-start gap-3 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] p-4">
              <CheckCircle2
                className="mt-0.5 size-5 shrink-0 text-[var(--success)]"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {addedProject.repo_name}
                </div>
                <div className="truncate font-mono text-xs text-[var(--text-secondary)]">
                  {addedProject.checkout_path}
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  {addedVia === "create"
                    ? "Local repository · Nothing was published remotely"
                    : addedProject.repo_id === 0
                      ? "Local Git repository"
                      : "Connected to GitHub"}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <Button
                type="button"
                onClick={() => {
                  onSuccess(addedProject);
                  handleOpenChange(false);
                }}
                className="rounded-full bg-primary px-5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                Open repository
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
