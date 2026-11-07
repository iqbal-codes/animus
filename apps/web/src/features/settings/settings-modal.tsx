import { useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FolderGit2,
  Server,
  SlidersHorizontal,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "cn";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { Preferences } from "@/lib/preferences";

type Scope = "personal" | "platform" | "project";

const SCOPES: { id: Scope; label: string; icon: typeof UserRound; implemented: boolean }[] = [
  { id: "personal", label: "Personal", icon: UserRound, implemented: true },
  { id: "platform", label: "Platform", icon: Server, implemented: false },
  { id: "project", label: "Project", icon: FolderGit2, implemented: false },
];

/**
 * Settings modal (`R5yIDY`, "Animus / Settings / Personal / Preferences"):
 * 1120 × 920 over an inert background, 240 px scope rail, 880 px content pane.
 * Escape and the backdrop close it, Tab cannot leave it, and unsaved edits are
 * guarded before the modal is dismissed.
 */
export function SettingsModal({
  preferences,
  onSave,
  onClose,
}: {
  preferences: Preferences;
  onSave: (next: Preferences) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Preferences>(preferences);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const dirty =
    draft.cardDensity !== preferences.cardDensity ||
    draft.startupView !== preferences.startupView ||
    draft.notifyNeedsAttention !== preferences.notifyNeedsAttention ||
    draft.notifyFailedJobs !== preferences.notifyFailedJobs;

  const dismiss = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
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
        overlayClassName="bg-black/65 supports-backdrop-filter:backdrop-blur-none"
        className="flex h-[920px] max-h-[calc(100dvh-2rem)] w-[1120px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[#0e0e10] p-0 text-foreground shadow-[0_12px_32px_#0000008c] ring-0 sm:max-w-[calc(100vw-2rem)]"
      >
        <nav
          aria-label="Settings scope"
          className="flex w-[240px] shrink-0 flex-col gap-6 overflow-y-auto border-r border-[var(--border-subtle)] bg-[#111214] px-4 py-6"
        >
          <p className="text-xl leading-[1.4] font-medium text-foreground">Settings</p>

          <div className="flex flex-col gap-1">
            {SCOPES.map((scope) => {
              const active = scope.id === "personal";
              const Icon = scope.icon;
              return (
                <button
                  key={scope.id}
                  type="button"
                  aria-pressed={active}
                  disabled={!scope.implemented}
                  title={
                    scope.implemented
                      ? undefined
                      : `${scope.label} settings are not implemented yet`
                  }
                  className={cn(
                    "flex h-10 items-center gap-2.5 rounded-[var(--radius-news)] px-3 text-left text-sm transition-colors disabled:cursor-default disabled:opacity-50",
                    active
                      ? "bg-[#24262b] font-medium text-foreground"
                      : "text-foreground hover:bg-[#1a1d21]",
                  )}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
                  <span className="flex-1">{scope.label}</span>
                  {active && <Check aria-hidden="true" className="size-4 shrink-0" />}
                </button>
              );
            })}
          </div>

          <p className="text-xs leading-[1.5] text-text-secondary">Only your experience</p>

          <div className="flex flex-col gap-1">
            <button
              type="button"
              aria-current="true"
              className="flex h-10 items-center gap-2.5 rounded-[var(--radius-news)] bg-[#24262b] px-3 text-left text-sm text-foreground"
            >
              <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0" />
              Preferences
            </button>
          </div>

          <div className="flex-1" />

          <p className="text-xs leading-[1.5] text-text-secondary">Does not change how jobs run.</p>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[92px] shrink-0 items-center justify-between gap-6 border-b border-[var(--border-subtle)] px-8">
            <div className="flex flex-col gap-2">
              <p className="text-[13px] leading-[1.4] text-text-secondary">
                Personal settings / Only you
              </p>
              <DialogTitle className="text-[26px] leading-[1.2] font-medium text-foreground">
                Preferences
              </DialogTitle>
            </div>
            <DialogClose
              ref={closeRef}
              aria-label="Close settings"
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              <X aria-hidden="true" className="size-5" />
            </DialogClose>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-8 py-7">
            <PreferenceSection title="Appearance">
              <PreferenceRow
                label="Theme"
                helper="Choose how the console looks."
                control={
                  <NativeSelect
                    id="settings-theme"
                    value="dark"
                    disabled
                    title="Only the dark theme ships in this build"
                    options={[{ value: "dark", label: "Dark" }]}
                    onChange={() => undefined}
                  />
                }
              />
              <PreferenceRow
                label="Card density"
                helper="Adjust the amount of detail in job cards."
                control={
                  <NativeSelect
                    id="settings-density"
                    value={draft.cardDensity}
                    options={[
                      { value: "comfortable", label: "Comfortable" },
                      { value: "compact", label: "Compact" },
                    ]}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        cardDensity: value === "compact" ? "compact" : "comfortable",
                      }))
                    }
                  />
                }
              />
            </PreferenceSection>

            <PreferenceSection title="Navigation">
              <PreferenceRow
                label="Startup view"
                helper="Choose where the console opens."
                control={
                  <NativeSelect
                    id="settings-startup"
                    value={draft.startupView}
                    options={[
                      { value: "inbox", label: "Inbox" },
                      { value: "jobs", label: "Jobs" },
                    ]}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        startupView: value === "jobs" ? "jobs" : "inbox",
                      }))
                    }
                  />
                }
              />
            </PreferenceSection>

            <PreferenceSection title="Notifications">
              <PreferenceRow
                label="Needs attention"
                helper="Notify you when a job needs approval or an owner."
                control={
                  <NativeSelect
                    id="settings-notify-attention"
                    value={draft.notifyNeedsAttention ? "on" : "off"}
                    options={[
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        notifyNeedsAttention: value === "on",
                      }))
                    }
                  />
                }
              />
              <PreferenceRow
                label="Failed jobs"
                helper="Notify you when a job fails."
                control={
                  <NativeSelect
                    id="settings-notify-failed"
                    value={draft.notifyFailedJobs ? "on" : "off"}
                    options={[
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                    onChange={(value) =>
                      setDraft((current) => ({ ...current, notifyFailedJobs: value === "on" }))
                    }
                  />
                }
              />
            </PreferenceSection>
          </div>

          <footer className="flex h-16 shrink-0 items-center gap-3 border-t border-[var(--border-subtle)] px-8">
            <p className="flex-1 text-xs leading-[1.4] text-text-secondary">
              {confirmDiscard ? "Discard unsaved changes?" : "Only your preferences will change"}
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

function PreferenceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <h3 className="text-base leading-[1.4] font-medium text-foreground">{title}</h3>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}

function PreferenceRow({
  label,
  helper,
  control,
}: {
  label: string;
  helper: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-8">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-sm leading-[1.4] text-foreground">{label}</span>
        <span className="text-[13px] leading-[1.45] text-text-secondary">{helper}</span>
      </div>
      {control}
    </div>
  );
}

function NativeSelect({
  id,
  value,
  options,
  onChange,
  disabled,
  title,
}: {
  id: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="relative shrink-0">
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        title={title}
        className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none focus-visible:border-[var(--ring)] disabled:cursor-default disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
      />
    </div>
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
        "rounded-full border px-[14px] py-[9px] text-[13px] leading-[1.4] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        tone === "primary"
          ? "border-[#eeeeee] bg-[#eeeeee] text-[#111111] hover:bg-white"
          : "border-[var(--border-subtle)] bg-[var(--card)] text-[#eeeeee] hover:bg-[var(--secondary)]",
      )}
    >
      {children}
    </button>
  );
}
