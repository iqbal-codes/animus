import React, { useState, useMemo } from "react";
import { Check, ChevronDown, FolderGit2, Plus, Search } from "lucide-react";
import type { Project } from "@animus/contracts/operator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  onSelectProject: (projectId: string) => void;
  onProjectAdded?: (project: Project) => void;
}

export function RepositorySelector({
  currentRepository,
  currentProjectId,
  projects,
  onSelectProject,
  onProjectAdded,
}: RepositorySelectorProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredProjects = useMemo(() => {
    if (!search.trim()) return projects;
    const lower = search.toLowerCase();
    return projects.filter(
      (p) =>
        p.repo_name.toLowerCase().includes(lower) ||
        (p.name && p.name.toLowerCase().includes(lower)),
    );
  }, [projects, search]);

  const handleSelect = (projectId: string) => {
    onSelectProject(projectId);
    setPopoverOpen(false);
  };

  const handleProjectSuccess = (project: Project) => {
    if (onProjectAdded) onProjectAdded(project);
    onSelectProject(project.id);
  };

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger className="flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-[9px] hover:border-[rgba(255,255,255,0.2)] hover:bg-muted/40 transition-colors cursor-pointer outline-none">
          <GithubMark className="size-4 shrink-0 text-foreground" />
          <span className="text-xs leading-[1.4] text-foreground font-medium">
            {currentRepository || "Select repository"}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 shrink-0 text-text-secondary transition-transform ${
              popoverOpen ? "rotate-180" : ""
            }`}
          />
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[360px] p-0 overflow-hidden rounded-xl bg-[#1A1A1A] border-[rgba(255,255,255,0.12)] text-foreground shadow-2xl"
        >
          {/* Search bar */}
          <div className="flex items-center gap-2 px-3.5 py-3 border-b border-[rgba(255,255,255,0.08)]">
            <Search className="size-3.5 shrink-0 text-[#777777]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repositories..."
              className="flex-1 bg-transparent text-xs text-[#EDEDED] placeholder-[#777777] outline-none"
            />
            <kbd className="rounded border border-[rgba(255,255,255,0.08)] bg-[#242424] px-1.5 py-0.5 text-[10px] text-[#777777] font-mono">
              ⌘ K
            </kbd>
          </div>

          {/* Section Label */}
          <div className="px-3.5 pt-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-[#777777]">
            Repositories
          </div>

          {/* Repository List */}
          <div className="max-h-[240px] overflow-y-auto px-1.5 py-1">
            {filteredProjects.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-[#888888]">
                {projects.length === 0
                  ? "No repositories enrolled yet."
                  : "No repositories match your search."}
              </div>
            ) : (
              filteredProjects.map((p) => {
                const isActive =
                  p.id === currentProjectId ||
                  p.repo_name.toLowerCase() === currentRepository.toLowerCase();
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelect(p.id)}
                    className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                      isActive
                        ? "bg-[#262626] text-white font-medium"
                        : "text-[#EDEDED] hover:bg-[#222222] hover:text-white"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <FolderGit2 className="size-4 shrink-0 text-[#888888]" />
                      <span className="truncate">{p.repo_name}</span>
                    </div>
                    {isActive && <Check className="size-3.5 shrink-0 text-[#FF6308] font-bold" />}
                  </button>
                );
              })
            )}
          </div>

          {/* Persistent Footer: + Add Repository */}
          <div className="border-t border-[rgba(255,255,255,0.08)] bg-[#161616] p-2">
            <button
              type="button"
              onClick={() => {
                setPopoverOpen(false);
                setModalOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-[#FF6308] hover:bg-[#202020] transition-colors cursor-pointer"
            >
              <Plus className="size-4 shrink-0" />
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
