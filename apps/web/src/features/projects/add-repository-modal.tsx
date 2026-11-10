import React, { useState } from "react";
import {
  FolderOpen,
  GitPullRequest,
  FolderPlus,
  ChevronRight,
  ArrowLeft,
  Loader2,
  AlertCircle,
} from "lucide-react";
import type { Project, ProjectRegistration } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "choose" | "local" | "remote" | "create";

export interface AddRepositoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (project: Project) => void;
}

export function AddRepositoryModal({ open, onOpenChange, onSuccess }: AddRepositoryModalProps) {
  const [mode, setMode] = useState<Mode>("choose");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [localPath, setLocalPath] = useState("");
  const [remoteRepo, setRemoteRepo] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [createName, setCreateName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  const reset = () => {
    setMode("choose");
    setError(null);
    setLoading(false);
    setLocalPath("");
    setRemoteRepo("");
    setRemotePath("");
    setCreateName("");
    setIsPrivate(true);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const handleSubmitLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localPath.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const name = localPath.trim().split("/").filter(Boolean).pop() || "local-project";
      const submission: ProjectRegistration = {
        method: "local_checkout",
        name,
        checkout_path: localPath.trim(),
      };
      const project = await client.registerProject(submission);
      onSuccess(project);
      handleOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!remoteRepo.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const name = remoteRepo.trim().split("/").pop() || remoteRepo.trim();
      const submission: ProjectRegistration = {
        method: "github_clone",
        name,
        repo: remoteRepo.trim(),
        ...(remotePath.trim() ? { target_path: remotePath.trim() } : {}),
      };
      const project = await client.registerProject(submission);
      onSuccess(project);
      handleOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const submission: ProjectRegistration = {
        method: "github_create",
        name: createName.trim(),
        repo: createName.trim(),
        private: isPrivate,
      };
      const project = await client.registerProject(submission);
      onSuccess(project);
      handleOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[560px] bg-[#1A1A1A] border-[rgba(255,255,255,0.12)] p-7 text-foreground shadow-2xl rounded-2xl">
        {mode === "choose" && (
          <div className="flex flex-col gap-6">
            <DialogHeader className="gap-1.5 text-left">
              <DialogTitle className="text-xl font-semibold text-white tracking-tight">
                Add repository
              </DialogTitle>
              <DialogDescription className="text-sm text-[#888888]">
                Choose how to add a repository to Animus.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              {/* Option 1: Local folder */}
              <button
                type="button"
                onClick={() => {
                  setMode("local");
                  setError(null);
                }}
                className="group flex items-center gap-4 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#202020] p-4 text-left transition-all hover:border-[rgba(255,99,8,0.4)] hover:bg-[#262626] cursor-pointer"
              >
                <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#2C2C2C] text-[#FF6308] group-hover:scale-105 transition-transform">
                  <FolderOpen className="size-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#EDEDED] group-hover:text-white">
                    Select local folder
                  </div>
                  <div className="text-xs text-[#888888] mt-0.5">
                    Use a Git repository already on this computer.
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-[#666666] group-hover:text-white transition-colors" />
              </button>

              {/* Option 2: Remote repo */}
              <button
                type="button"
                onClick={() => {
                  setMode("remote");
                  setError(null);
                }}
                className="group flex items-center gap-4 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#202020] p-4 text-left transition-all hover:border-[rgba(255,99,8,0.4)] hover:bg-[#262626] cursor-pointer"
              >
                <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#2C2C2C] text-[#FF6308] group-hover:scale-105 transition-transform">
                  <GitPullRequest className="size-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#EDEDED] group-hover:text-white">
                    Select Remote repository
                  </div>
                  <div className="text-xs text-[#888888] mt-0.5">
                    Select a GitHub repository to clone it automatically.
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-[#666666] group-hover:text-white transition-colors" />
              </button>

              {/* Option 3: Create new repo */}
              <button
                type="button"
                onClick={() => {
                  setMode("create");
                  setError(null);
                }}
                className="group flex items-center gap-4 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#202020] p-4 text-left transition-all hover:border-[rgba(255,99,8,0.4)] hover:bg-[#262626] cursor-pointer"
              >
                <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#2C2C2C] text-[#FF6308] group-hover:scale-105 transition-transform">
                  <FolderPlus className="size-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#EDEDED] group-hover:text-white">
                    Create new repo
                  </div>
                  <div className="text-xs text-[#888888] mt-0.5">
                    Name a project. Animus creates its folder and sets up Git.
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-[#666666] group-hover:text-white transition-colors" />
              </button>
            </div>
          </div>
        )}

        {mode === "local" && (
          <form onSubmit={handleSubmitLocal} className="flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode("choose");
                  setError(null);
                }}
                className="-ml-2 h-8 px-2 text-xs text-[#888888] hover:text-white"
              >
                <ArrowLeft className="mr-1 size-3.5" />
                Back
              </Button>
            </div>

            <DialogHeader className="gap-1 text-left">
              <DialogTitle className="text-lg font-semibold text-white">
                Select local folder
              </DialogTitle>
              <DialogDescription className="text-xs text-[#888888]">
                Provide the filesystem path to an existing Git repository.
              </DialogDescription>
            </DialogHeader>

            {error && (
              <div className="flex items-center gap-2 rounded-lg bg-red-950/40 border border-red-500/30 p-3 text-xs text-red-400">
                <AlertCircle className="size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="local-path" className="text-xs font-medium text-[#EDEDED]">
                Local checkout path
              </Label>
              <Input
                id="local-path"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/Users/username/workspace/repo"
                required
                className="bg-[#242424] border-[rgba(255,255,255,0.1)] text-xs text-foreground focus-visible:border-[#FF6308]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode("choose")}
                disabled={loading}
                className="text-xs border-[rgba(255,255,255,0.1)] bg-transparent text-[#888888] hover:text-white"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={loading || !localPath.trim()}
                className="text-xs bg-[#FF6308] hover:bg-[#FF6308]/90 text-white font-medium"
              >
                {loading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Add repository
              </Button>
            </div>
          </form>
        )}

        {mode === "remote" && (
          <form onSubmit={handleSubmitRemote} className="flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode("choose");
                  setError(null);
                }}
                className="-ml-2 h-8 px-2 text-xs text-[#888888] hover:text-white"
              >
                <ArrowLeft className="mr-1 size-3.5" />
                Back
              </Button>
            </div>

            <DialogHeader className="gap-1 text-left">
              <DialogTitle className="text-lg font-semibold text-white">
                Select Remote repository
              </DialogTitle>
              <DialogDescription className="text-xs text-[#888888]">
                Clone a repository from GitHub and enroll it in Animus.
              </DialogDescription>
            </DialogHeader>

            {error && (
              <div className="flex items-center gap-2 rounded-lg bg-red-950/40 border border-red-500/30 p-3 text-xs text-red-400">
                <AlertCircle className="size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="remote-repo" className="text-xs font-medium text-[#EDEDED]">
                GitHub repository (owner/repo)
              </Label>
              <Input
                id="remote-repo"
                value={remoteRepo}
                onChange={(e) => setRemoteRepo(e.target.value)}
                placeholder="efishery/feeder-agent"
                required
                className="bg-[#242424] border-[rgba(255,255,255,0.1)] text-xs text-foreground focus-visible:border-[#FF6308]"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="remote-target" className="text-xs font-medium text-[#888888]">
                Destination path (optional)
              </Label>
              <Input
                id="remote-target"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                placeholder="Defaults to ~/.animus/projects/..."
                className="bg-[#242424] border-[rgba(255,255,255,0.1)] text-xs text-foreground focus-visible:border-[#FF6308]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode("choose")}
                disabled={loading}
                className="text-xs border-[rgba(255,255,255,0.1)] bg-transparent text-[#888888] hover:text-white"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={loading || !remoteRepo.trim()}
                className="text-xs bg-[#FF6308] hover:bg-[#FF6308]/90 text-white font-medium"
              >
                {loading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Clone & enroll
              </Button>
            </div>
          </form>
        )}

        {mode === "create" && (
          <form onSubmit={handleSubmitCreate} className="flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode("choose");
                  setError(null);
                }}
                className="-ml-2 h-8 px-2 text-xs text-[#888888] hover:text-white"
              >
                <ArrowLeft className="mr-1 size-3.5" />
                Back
              </Button>
            </div>

            <DialogHeader className="gap-1 text-left">
              <DialogTitle className="text-lg font-semibold text-white">
                Create new repo
              </DialogTitle>
              <DialogDescription className="text-xs text-[#888888]">
                Initialize a new Git project with Animus agent workflows.
              </DialogDescription>
            </DialogHeader>

            {error && (
              <div className="flex items-center gap-2 rounded-lg bg-red-950/40 border border-red-500/30 p-3 text-xs text-red-400">
                <AlertCircle className="size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="create-name" className="text-xs font-medium text-[#EDEDED]">
                Repository name
              </Label>
              <Input
                id="create-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-agent-system"
                required
                className="bg-[#242424] border-[rgba(255,255,255,0.1)] text-xs text-foreground focus-visible:border-[#FF6308]"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="private-check"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                className="size-4 accent-[#FF6308] rounded cursor-pointer"
              />
              <Label htmlFor="private-check" className="text-xs text-[#888888] cursor-pointer">
                Private repository
              </Label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode("choose")}
                disabled={loading}
                className="text-xs border-[rgba(255,255,255,0.1)] bg-transparent text-[#888888] hover:text-white"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={loading || !createName.trim()}
                className="text-xs bg-[#FF6308] hover:bg-[#FF6308]/90 text-white font-medium"
              >
                {loading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Create repository
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
