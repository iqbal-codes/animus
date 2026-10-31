import React from "react";
import type { Project } from "@labq/contracts/operator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FolderGit2, X, Terminal } from "lucide-react";

interface ProjectDetailProps {
  project: Project | null;
  onClose: () => void;
}

export function ProjectDetail({ project, onClose }: ProjectDetailProps) {
  if (!project) return null;

  return (
    <div
      data-testid="project-detail-panel"
      className="rounded-lg border border-[var(--border)] bg-[var(--container)] p-5 space-y-4"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-[#121316] border border-[var(--border)]">
            <FolderGit2 className="h-5 w-5 text-[var(--accent)]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-[var(--foreground)]">{project.name}</h3>
              <Badge variant={project.status === "active" ? "active" : "held"}>
                {project.status}
              </Badge>
            </div>
            <p className="font-mono text-xs text-[var(--muted-foreground)]">
              {project.repo_name} (ID: {project.repo_id})
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close project details"
          className="h-8 w-8 p-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs pt-2 border-t border-[var(--border)]">
        <div className="space-y-1">
          <span className="text-[var(--muted-foreground)] uppercase tracking-wider text-[10px]">
            Project Scope ID
          </span>
          <p className="font-mono bg-[#121316] p-2 rounded border border-[var(--border)] select-all">
            {project.id}
          </p>
        </div>
        <div className="space-y-1">
          <span className="text-[var(--muted-foreground)] uppercase tracking-wider text-[10px]">
            Checkout Location
          </span>
          <p className="font-mono bg-[#121316] p-2 rounded border border-[var(--border)] truncate select-all">
            {project.checkout_path}
          </p>
        </div>
        <div className="space-y-1">
          <span className="text-[var(--muted-foreground)] uppercase tracking-wider text-[10px]">
            Enrolled On
          </span>
          <p className="font-mono bg-[#121316] p-2 rounded border border-[var(--border)]">
            {project.created_at}
          </p>
        </div>
        <div className="space-y-1">
          <span className="text-[var(--muted-foreground)] uppercase tracking-wider text-[10px]">
            Last Metadata Update
          </span>
          <p className="font-mono bg-[#121316] p-2 rounded border border-[var(--border)]">
            {project.updated_at}
          </p>
        </div>
      </div>

      {project.status_reason && (
        <div className="rounded p-2.5 bg-amber-950/20 border border-amber-900/40 text-xs text-amber-300">
          <span className="font-semibold block mb-0.5">Status Advisory:</span>
          {project.status_reason}
        </div>
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(`bun run loop --project ${project.id}`);
          }}
        >
          <Terminal className="h-3.5 w-3.5 mr-1" />
          Copy CLI Execution Command
        </Button>
      </div>
    </div>
  );
}
