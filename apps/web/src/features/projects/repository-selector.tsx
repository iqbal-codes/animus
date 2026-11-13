import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FolderGit2, Layers, Plus, Search } from "lucide-react";
import type { Project } from "@animus/contracts/operator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ALL_PROJECTS_ID } from "@/features/jobs/jobs-model";
import { AddRepositoryModal } from "./add-repository-modal";

/** GitHub mark for repository selector trigger */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export interface RepositorySelectorProps {
  currentRepository: string;
  currentProjectId?: string | null;
  projects: Project[];
  allowAll?: boolean;
  onSelectProject: (projectId: string) => void;
  onProjectAdded?: (project: Project) => void;
}

export function RepositorySelector({
  currentRepository,
  currentProjectId,
  projects,
  allowAll = true,
  onSelectProject,
  onProjectAdded,
}: RepositorySelectorProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const isAllSelected = currentProjectId === ALL_PROJECTS_ID;

  const activeProject = useMemo(
    () =>
      isAllSelected
        ? null
        : (projects.find(
            (p) =>
              p.id === currentProjectId ||
              p.repo_name.toLowerCase() === currentRepository.toLowerCase(),
          ) ?? null),
    [projects, currentProjectId, currentRepository, isAllSelected],
  );

  const filteredProjects = useMemo(() => {
    if (!search.trim()) return projects;
    const lower = search.toLowerCase();
    return projects.filter(
      (p) =>
        p.repo_name.toLowerCase().includes(lower) ||
        p.name.toLowerCase().includes(lower) ||
        p.checkout_path.toLowerCase().includes(lower),
    );
  }, [projects, search]);

  useEffect(() => {
    if (!popoverOpen) {
      setSearch("");
      return;
    }
    const timer = setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [popoverOpen]);

  const handleSelect = (projectId: string) => {
    onSelectProject(projectId);
    setPopoverOpen(false);
  };

  const handleProjectSuccess = (project: Project) => {
    if (onProjectAdded) onProjectAdded(project);
    onSelectProject(project.id);
  };

  const triggerLabel = isAllSelected
    ? "All repositories"
    : activeProject?.repo_name || currentRepository || "Select repository";
  const isLocalOnlyActive = activeProject ? activeProject.repo_id === 0 : false;
  const showAllOption =
    allowAll &&
    projects.length > 0 &&
    (!search.trim() || "all repositories".includes(search.trim().toLowerCase()));

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger
          aria-label={triggerLabel}
          className="flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-[9px] transition-colors outline-none hover:border-[var(--elevation-edge)] hover:bg-[var(--white-04)]"
        >
          {isAllSelected ? (
            <Layers className="size-4 shrink-0 text-foreground" aria-hidden="true" />
          ) : isLocalOnlyActive ? (
            <FolderGit2 className="size-4 shrink-0 text-foreground" aria-hidden="true" />
          ) : (
            <GithubMark className="size-4 shrink-0 text-foreground" />
          )}
          <span className="max-w-[220px] truncate text-xs leading-[1.4] font-medium text-foreground">
            {triggerLabel}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 shrink-0 text-[var(--text-secondary)] transition-transform ${
              popoverOpen ? "rotate-180" : ""
            }`}
          />
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[360px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--surface)] p-0 text-foreground shadow-[var(--shadow-elevation-3)] ring-0"
        >
          {/* Search bar */}
          <div
            data-focus-ring="container"
            className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3.5 py-2.5"
          >
            <Search className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search repositories"
              placeholder="Search repositories..."
              className="flex-1 bg-transparent text-xs leading-[1.45] text-foreground placeholder:text-[var(--text-muted)] outline-none"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)] hover:bg-[var(--white-04)] hover:text-foreground"
              >
                Clear
              </button>
            ) : (
              <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--elevation-2-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                ⌘ K
              </kbd>
            )}
          </div>

          {/* Section Label */}
          <div className="px-3.5 pt-2.5 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
            Repositories
          </div>

          {/* Repository List */}
          <div className="max-h-[260px] overflow-y-auto px-1.5 py-1">
            {showAllOption && (
              <button
                type="button"
                onClick={() => handleSelect(ALL_PROJECTS_ID)}
                className={`mb-1 flex w-full items-center justify-between gap-2.5 rounded-[var(--radius-news)] px-2.5 py-2 text-left text-xs transition-colors ${
                  isAllSelected
                    ? "bg-[var(--elevation-3-surface)] font-medium text-foreground"
                    : "text-foreground/90 hover:bg-[var(--white-04)] hover:text-foreground"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Layers className="size-4 shrink-0 text-[var(--text-secondary)]" />
                  <div className="min-w-0">
                    <div className="truncate">All repositories</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">
                    {projects.length}
                  </span>
                  {isAllSelected && (
                    <Check className="size-3.5 shrink-0 text-foreground" aria-hidden="true" />
                  )}
                </div>
              </button>
            )}
            {filteredProjects.length === 0 && !showAllOption ? (
              <div className="px-3 py-6 text-center text-xs text-[var(--text-secondary)]">
                {projects.length === 0 ? (
                  <span>No repositories enrolled yet.</span>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <span>No repositories match &ldquo;{search}&rdquo;.</span>
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="text-xs font-medium text-foreground underline underline-offset-2 hover:opacity-80"
                    >
                      Clear search
                    </button>
                  </div>
                )}
              </div>
            ) : (
              filteredProjects.map((p) => {
                const isActive =
                  !isAllSelected &&
                  (p.id === currentProjectId ||
                    p.repo_name.toLowerCase() === currentRepository.toLowerCase());
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelect(p.id)}
                    className={`flex w-full items-center justify-between gap-2.5 rounded-[var(--radius-news)] px-2.5 py-2 text-left text-xs transition-colors ${
                      isActive
                        ? "bg-[var(--elevation-3-surface)] font-medium text-foreground"
                        : "text-foreground/90 hover:bg-[var(--white-04)] hover:text-foreground"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      {p.repo_id === 0 ? (
                        <FolderGit2 className="size-4 shrink-0 text-[var(--text-secondary)]" />
                      ) : (
                        <GithubMark className="size-4 shrink-0 text-[var(--text-secondary)]" />
                      )}
                      <div className="min-w-0">
                        <div className="truncate">{p.repo_name}</div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {p.status === "held" && (
                        <span className="rounded-full bg-[var(--warning-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--warning)]">
                          Held
                        </span>
                      )}
                      {isActive && (
                        <Check className="size-3.5 shrink-0 text-foreground" aria-hidden="true" />
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Persistent Footer: + Add Repository */}
          <div className="border-t border-[var(--border-subtle)] bg-[var(--overlay)] p-2">
            <button
              type="button"
              onClick={() => {
                setPopoverOpen(false);
                setModalOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-[var(--radius-news)] px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-[var(--white-04)]"
            >
              <Plus className="size-4 shrink-0 text-[var(--text-secondary)]" />
              <span>Add Repository</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <AddRepositoryModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSuccess={handleProjectSuccess}
      />
    </>
  );
}
