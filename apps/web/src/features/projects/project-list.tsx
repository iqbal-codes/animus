import React from "react";
import type { Project } from "@animus/contracts/operator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FolderGit2, AlertTriangle, RefreshCw } from "lucide-react";

interface ProjectListProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function ProjectList({
  projects,
  selectedProjectId,
  onSelectProject,
  isLoading,
  error,
  onRefresh,
}: ProjectListProps) {
  if (isLoading && projects.length === 0) {
    return (
      <div
        data-testid="projects-loading"
        className="flex flex-col items-center justify-center p-12 rounded-lg border border-[var(--border)] bg-[var(--container)] text-center text-sm text-[var(--muted-foreground)]"
      >
        <RefreshCw className="h-5 w-5 animate-spin mb-3 text-[var(--accent)]" />
        <p>Loading registered repositories from console database...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="projects-error"
        className="flex flex-col items-center justify-center p-8 rounded-lg border border-red-900/50 bg-red-950/20 text-center"
      >
        <AlertTriangle className="h-6 w-6 text-red-400 mb-2" />
        <h3 className="text-sm font-medium text-red-200">Unable to load project registry</h3>
        <p className="text-xs text-red-400/80 mt-1 mb-4">{error}</p>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          Retry Connection
        </Button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div
        data-testid="projects-empty"
        className="flex flex-col items-center justify-center p-12 rounded-lg border border-[var(--border)] bg-[var(--container)] text-center"
      >
        <FolderGit2 className="h-8 w-8 text-[var(--muted-foreground)] mb-3 opacity-60" />
        <h3 className="text-base font-medium text-[var(--foreground)]">No repositories enrolled</h3>
        <p className="text-xs text-[var(--muted-foreground)] max-w-md mt-1 mb-4">
          The registry contains no active repositories. Enroll a project using the CLI command:
          <code className="block mt-2 font-mono text-[var(--accent)] bg-[#0A0A0A] p-2 rounded border border-[var(--border)]">
            animus setup
          </code>
        </p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Refresh Registry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            Registered Repositories
          </h2>
          <p className="text-xs text-[var(--muted-foreground)]">
            {projects.length} repository {projects.length === 1 ? "entry" : "entries"} active in the
            local installation
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          aria-label="Refresh project list"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          <span>Refresh</span>
        </Button>
      </div>

      <Table data-testid="projects-table">
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Repository</TableHead>
            <TableHead>Checkout Path</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((proj) => {
            const isSelected = proj.id === selectedProjectId;
            return (
              <TableRow
                key={proj.id}
                className={isSelected ? "bg-[#22262E]/70" : undefined}
                data-testid={`project-row-${proj.id}`}
              >
                <TableCell className="font-medium text-[var(--foreground)]">
                  <div className="flex flex-col">
                    <span className="font-semibold">{proj.name}</span>
                    <span className="font-mono text-[11px] text-[var(--muted-foreground)]">
                      {proj.id}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      proj.status === "active"
                        ? "active"
                        : proj.status === "held"
                          ? "held"
                          : "tombstone"
                    }
                  >
                    {proj.status}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs text-[var(--muted-foreground)]">
                  {proj.repo_name}
                </TableCell>
                <TableCell className="font-mono text-xs text-[var(--muted-foreground)] max-w-xs truncate">
                  {proj.checkout_path}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant={isSelected ? "default" : "secondary"}
                    size="sm"
                    onClick={() => onSelectProject(proj.id)}
                    aria-label={`View project ${proj.name}`}
                  >
                    {isSelected ? "Active" : "Inspect"}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
