import type { Preferences } from "@/lib/preferences";
import { ChevronDown } from "lucide-react";

export function PersonalPreferencesSection({
  draft,
  onChange,
}: {
  draft: Preferences;
  onChange: (updater: (prev: Preferences) => Preferences) => void;
}) {
  return (
    <div className="flex flex-col gap-8">
      <PreferenceGroup title="Appearance">
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
                onChange((current) => ({
                  ...current,
                  cardDensity: value === "compact" ? "compact" : "comfortable",
                }))
              }
            />
          }
        />
      </PreferenceGroup>

      <PreferenceGroup title="Navigation">
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
                onChange((current) => ({
                  ...current,
                  startupView: value === "jobs" ? "jobs" : "inbox",
                }))
              }
            />
          }
        />
      </PreferenceGroup>

      <PreferenceGroup title="Notifications">
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
                onChange((current) => ({
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
                onChange((current) => ({
                  ...current,
                  notifyFailedJobs: value === "on",
                }))
              }
            />
          }
        />
      </PreferenceGroup>
    </div>
  );
}

function PreferenceGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-base leading-[1.4] font-medium text-foreground">{title}</h3>
      <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
        {children}
      </div>
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
    <div className="flex items-center justify-between gap-8 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium leading-[1.4] text-foreground">{label}</span>
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
        className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)] disabled:cursor-default disabled:opacity-60"
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
