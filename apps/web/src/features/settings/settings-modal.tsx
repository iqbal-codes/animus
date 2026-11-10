import { useRef, useState } from "react";
import {
  Boxes,
  Brain,
  Check,
  ChevronDown,
  Cpu,
  FileCheck,
  FolderGit2,
  GitBranch,
  RefreshCw,
  Server,
  Shield,
  SlidersHorizontal,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { cn } from "cn";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Preferences } from "@/lib/preferences";
import type { Scope, SectionId, SettingsModalProps } from "./settings-types";
import { PersonalPreferencesSection } from "./sections/personal-preferences";
import { PlatformSystemSection } from "./sections/platform-system";
import { PlatformProvidersSection } from "./sections/platform-providers";
import { PlatformAutomationSection } from "./sections/platform-automation";
import { PlatformGitHubSection } from "./sections/platform-github";
import { ProjectModelsSection } from "./sections/project-models";
import { ProjectChecksSection } from "./sections/project-checks";
import { ProjectMemorySection } from "./sections/project-memory";
import { ProjectReleasesSection } from "./sections/project-releases";

/** GitHub Mark SVG Icon */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

interface ScopeItemConfig {
  id: Scope;
  label: string;
  icon: typeof UserRound;
  reach: string;
  boundary: string;
  defaultSection: SectionId;
  sections: { id: SectionId; label: string; icon: React.ComponentType<{ className?: string }> }[];
}

const SCOPES_CONFIG: ScopeItemConfig[] = [
  {
    id: "personal",
    label: "Personal",
    icon: UserRound,
    reach: "Only your experience",
    boundary: "Does not change how jobs run.",
    defaultSection: "preferences",
    sections: [{ id: "preferences", label: "Preferences", icon: SlidersHorizontal }],
  },
  {
    id: "platform",
    label: "Platform",
    icon: Server,
    reach: "This installation · all projects",
    boundary: "Shared by every project.",
    defaultSection: "system",
    sections: [
      { id: "providers", label: "Providers", icon: Cpu },
      { id: "automation", label: "Automation", icon: Zap },
      { id: "github", label: "GitHub", icon: GithubMark },
      { id: "system", label: "System", icon: Shield },
    ],
  },
  {
    id: "project",
    label: "Project",
    icon: FolderGit2,
    reach: "Changes stay in this project.",
    boundary: "Changes stay in this project.",
    defaultSection: "models",
    sections: [
      { id: "models", label: "Models", icon: Boxes },
      { id: "checks", label: "Checks", icon: FileCheck },
      { id: "memory", label: "Memory", icon: Brain },
      { id: "releases", label: "Releases", icon: GitBranch },
    ],
  },
];

const SECTION_HEADERS: Record<
  SectionId,
  {
    title: string;
    quickAction: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  preferences: { title: "Preferences", quickAction: "Refresh status", icon: SlidersHorizontal },
  providers: { title: "Providers", quickAction: "Rescan providers", icon: Cpu },
  automation: { title: "Automation", quickAction: "Reset defaults", icon: Zap },
  github: { title: "GitHub", quickAction: "Test connection", icon: GithubMark },
  system: { title: "System", quickAction: "Refresh status", icon: Shield },
  models: { title: "Models", quickAction: "Reset defaults", icon: Boxes },
  checks: { title: "Checks", quickAction: "Run audit", icon: FileCheck },
  memory: { title: "Memory", quickAction: "Audit memory", icon: Brain },
  releases: { title: "Releases", quickAction: "Reset defaults", icon: GitBranch },
};

export function SettingsModal({
  preferences,
  projects = [],
  currentProjectId,
  initialScope = "personal",
  initialSection = "preferences",
  onSelectProject,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [activeScope, setActiveScope] = useState<Scope>(initialScope);
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection);
  const [draft, setDraft] = useState<Preferences>(preferences);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const closeRef = useRef<HTMLButtonElement>(null);

  // Selected project details
  const activeProject = projects.find((p) => p.id === currentProjectId) || projects[0];
  const projectName = activeProject?.repo_name || activeProject?.name || "animus-core";

  const dirty =
    draft.cardDensity !== preferences.cardDensity ||
    draft.startupView !== preferences.startupView ||
    draft.notifyNeedsAttention !== preferences.notifyNeedsAttention ||
    draft.notifyFailedJobs !== preferences.notifyFailedJobs;

  const dismiss = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const handleSelectScope = (scope: Scope) => {
    setActiveScope(scope);
    const config = SCOPES_CONFIG.find((s) => s.id === scope);
    if (config) {
      setActiveSection(config.defaultSection);
    }
  };

  const currentScopeConfig = SCOPES_CONFIG.find((s) => s.id === activeScope)!;
  const currentSectionMeta = SECTION_HEADERS[activeSection];

  const handleQuickAction = () => {
    setActionNotice(`Executing ${currentSectionMeta.quickAction}…`);
    setTimeout(() => {
      setActionNotice(null);
    }, 2000);
  };

  const getScopeBadgeText = () => {
    if (activeScope === "personal") return "Personal settings / Only you";
    if (activeScope === "platform") return "Platform settings / This installation";
    return `Project settings / ${projectName}`;
  };

  const getFooterNote = () => {
    if (activeScope === "personal") return "Only your preferences will change";
    if (activeScope === "platform") return "Platform status · Maintenance actions run immediately";
    return `Only ${projectName} will change`;
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={closeRef}
        finalFocus={() => document.querySelector<HTMLElement>("[data-settings-trigger]") ?? true}
        overlayClassName="bg-black/75 backdrop-blur-sm"
        className="flex h-[920px] max-h-[calc(100dvh-2rem)] w-[1120px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[#0e0e10] p-0 text-foreground opacity-100 shadow-[0_12px_32px_#0000008c] ring-0 sm:max-w-[calc(100vw-2rem)]"
      >
        {/* Left Navigation Rail (240px wide) */}
        <nav
          aria-label="Settings navigation rail"
          className="flex w-[240px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-[var(--border-subtle)] bg-[#111214] px-4 py-6"
        >
          <p className="text-xl font-medium leading-[1.4] text-foreground">Settings</p>

          {/* Scope Selector */}
          <div className="flex flex-col gap-1">
            {SCOPES_CONFIG.map((scope) => {
              const active = scope.id === activeScope;
              const Icon = scope.icon;
              return (
                <button
                  key={scope.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleSelectScope(scope.id)}
                  className={cn(
                    "flex h-10 items-center gap-2.5 rounded-[var(--radius-news)] px-3 text-left text-sm transition-colors",
                    active
                      ? "bg-[#24262b] font-medium text-foreground"
                      : "text-text-secondary hover:bg-[#1a1d21] hover:text-foreground",
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-foreground" : "text-text-secondary",
                    )}
                  />
                  <span className="flex-1">{scope.label}</span>
                  {active && (
                    <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Project Picker (Visible when Project scope is active) */}
          {activeScope === "project" && (
            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-xs font-medium text-text-secondary">Project</span>
              <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
                <PopoverTrigger
                  type="button"
                  className="flex h-10 w-full items-center justify-between gap-2 rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#181a1d] px-3 text-left text-sm text-foreground transition-colors hover:bg-[#202327]"
                >
                  <div className="flex items-center gap-2 truncate">
                    <FolderGit2 className="size-3.5 text-text-secondary" />
                    <span className="truncate font-medium">{projectName}</span>
                  </div>
                  <ChevronDown className="size-3.5 shrink-0 text-text-secondary" />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[208px] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#181a1d] p-1 shadow-lg"
                >
                  {projects.length > 0 ? (
                    projects.map((p) => {
                      const isSelected = p.id === activeProject?.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            if (onSelectProject) onSelectProject(p.id);
                            setProjectPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                            isSelected
                              ? "bg-[#24262b] font-medium text-foreground"
                              : "text-text-secondary hover:bg-[#202327] hover:text-foreground",
                          )}
                        >
                          <span className="truncate">{p.repo_name || p.name}</span>
                          {isSelected && <Check className="size-3.5 shrink-0 text-foreground" />}
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-2.5 py-2 text-xs text-text-secondary">
                      No other projects registered
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          )}

          {/* Scope Reach Explanation */}
          <p className="text-xs leading-[1.5] text-text-secondary">{currentScopeConfig.reach}</p>

          {/* Scope-specific sections navigation list */}
          <div className="flex flex-col gap-1">
            {currentScopeConfig.sections.map((section) => {
              const active = section.id === activeSection;
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    "flex h-10 items-center gap-2.5 rounded-[var(--radius-news)] px-3 text-left text-sm transition-colors",
                    active
                      ? "bg-[#24262b] font-medium text-foreground"
                      : "text-text-secondary hover:bg-[#1a1d21] hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-foreground" : "text-text-secondary",
                    )}
                  />
                  <span>{section.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex-1" />

          {/* Scope boundary reminder at bottom */}
          <p className="text-xs leading-[1.5] text-text-secondary">{currentScopeConfig.boundary}</p>
        </nav>

        {/* Content Pane (Right side, 880px) */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header Bar (92px height) */}
          <header className="flex h-[92px] shrink-0 items-center justify-between gap-6 border-b border-[var(--border-subtle)] px-8">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[12px] text-text-secondary">
                <span className="inline-flex items-center gap-1.5 rounded bg-white/5 px-2 py-0.5 font-medium">
                  {getScopeBadgeText()}
                </span>
                <span>Settings</span>
                <span>/</span>
                <span className="text-foreground">{currentSectionMeta.title}</span>
              </div>
              <DialogTitle className="text-[26px] font-medium leading-[1.2] text-foreground">
                {currentSectionMeta.title}
              </DialogTitle>
            </div>

            <div className="flex items-center gap-3">
              {/* Quick Action Button */}
              <button
                type="button"
                onClick={handleQuickAction}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--card)] px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-[var(--secondary)]"
              >
                <RefreshCw className="size-3.5 text-text-secondary" />
                <span>{actionNotice || currentSectionMeta.quickAction}</span>
              </button>

              {/* Close Button */}
              <DialogClose
                ref={closeRef}
                aria-label="Close settings"
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-[#202327] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              >
                <X aria-hidden="true" className="size-5" />
              </DialogClose>
            </div>
          </header>

          {/* Body Scroll Area */}
          <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-8 py-7">
            {activeSection === "preferences" && (
              <PersonalPreferencesSection draft={draft} onChange={setDraft} />
            )}
            {activeSection === "system" && <PlatformSystemSection />}
            {activeSection === "providers" && <PlatformProvidersSection />}
            {activeSection === "automation" && (
              <PlatformAutomationSection currentProjectId={currentProjectId} />
            )}
            {activeSection === "github" && <PlatformGitHubSection />}
            {activeSection === "models" && (
              <ProjectModelsSection currentProjectId={currentProjectId} />
            )}
            {activeSection === "checks" && (
              <ProjectChecksSection currentProjectId={currentProjectId} />
            )}
            {activeSection === "memory" && <ProjectMemorySection />}
            {activeSection === "releases" && (
              <ProjectReleasesSection currentProjectId={currentProjectId} />
            )}
          </div>

          {/* Footer Actions (64px height) */}
          <footer className="flex h-16 shrink-0 items-center gap-3 border-t border-[var(--border-subtle)] px-8">
            <p className="flex-1 text-xs leading-[1.4] text-text-secondary">
              {confirmDiscard ? "Discard unsaved changes?" : getFooterNote()}
            </p>
            {confirmDiscard ? (
              <>
                <ActionButton tone="secondary" onClick={onClose}>
                  Discard
                </ActionButton>
                <ActionButton tone="primary" onClick={() => setConfirmDiscard(false)}>
                  Keep editing
                </ActionButton>
              </>
            ) : (
              <>
                <ActionButton tone="secondary" onClick={dismiss}>
                  Cancel
                </ActionButton>
                <ActionButton
                  tone="primary"
                  onClick={() => {
                    onSave(draft);
                    onClose();
                  }}
                >
                  Save changes
                </ActionButton>
              </>
            )}
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ActionButton({
  tone,
  onClick,
  children,
}: {
  tone: "primary" | "secondary";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-[14px] py-[9px] text-[13px] font-medium leading-[1.4] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        tone === "primary"
          ? "border-[#eeeeee] bg-[#eeeeee] text-[#111111] hover:bg-white"
          : "border-[var(--border-subtle)] bg-[var(--card)] text-[#eeeeee] hover:bg-[var(--secondary)]",
      )}
    >
      {children}
    </button>
  );
}
