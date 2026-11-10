import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, ChevronDown, Clock, Pause, Zap } from "lucide-react";
import { client } from "@/lib/factory-client";

export function PlatformAutomationSection({
  currentProjectId,
}: {
  currentProjectId?: string | null;
}) {
  const [parallelJobs, setParallelJobs] = useState("2");
  const [maxLaps, setMaxLaps] = useState("3");
  const [pollInterval, setPollInterval] = useState("300");
  const [continuations, setContinuations] = useState("1");
  const [limitWorkWindow, setLimitWorkWindow] = useState(true);
  const [startTime, setStartTime] = useState("20:00");
  const [endTime, setEndTime] = useState("05:00");
  const [timezone, setTimezone] = useState("Asia/Jakarta (UTC+7)");
  const [schedulePaused, setSchedulePaused] = useState(false);
  const [globalBrake, setGlobalBrake] = useState(false);

  useEffect(() => {
    fetch("/api/v1/settings/platform")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.automation) return;
        const auto = data.automation;
        if (auto.parallelJobs !== undefined) setParallelJobs(String(auto.parallelJobs));
        if (auto.maxLaps !== undefined) setMaxLaps(String(auto.maxLaps));
        if (auto.pollInterval !== undefined) setPollInterval(String(auto.pollInterval));
        if (auto.continuations !== undefined) setContinuations(String(auto.continuations));
        if (typeof auto.limitWorkWindow === "boolean") setLimitWorkWindow(auto.limitWorkWindow);
        if (auto.startTime) setStartTime(auto.startTime);
        if (auto.endTime) setEndTime(auto.endTime);
        if (auto.timezone) setTimezone(auto.timezone);
      })
      .catch(() => {});

    client
      .brakes()
      .then((b) => {
        if (b && typeof b.global_launch_brake === "boolean") {
          setGlobalBrake(b.global_launch_brake);
        }
      })
      .catch(() => {});

    if (currentProjectId) {
      client
        .forProject(currentProjectId)
        .brakes()
        .then((pb) => {
          if (pb && typeof pb.schedule_pause === "boolean") {
            setSchedulePaused(pb.schedule_pause);
          }
        })
        .catch(() => {});
    }
  }, [currentProjectId]);

  const saveAutomation = (updates: Record<string, unknown>) => {
    fetch("/api/v1/settings/platform", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        automation: {
          parallelJobs: Number(updates.parallelJobs ?? parallelJobs),
          maxLaps: Number(updates.maxLaps ?? maxLaps),
          pollInterval: Number(updates.pollInterval ?? pollInterval),
          continuations: Number(updates.continuations ?? continuations),
          limitWorkWindow:
            updates.limitWorkWindow !== undefined ? updates.limitWorkWindow : limitWorkWindow,
          startTime: updates.startTime ?? startTime,
          endTime: updates.endTime ?? endTime,
          timezone: updates.timezone ?? timezone,
        },
      }),
    }).catch(() => {});
  };

  const handleToggleGlobalBrake = async (checked: boolean) => {
    setGlobalBrake(checked);
    await client
      .setBrake({
        brake: "global_launch",
        active: checked,
        reason: "Console operator action",
      })
      .catch(() => {});
  };

  const handleToggleSchedulePause = async (checked: boolean) => {
    setSchedulePaused(checked);
    if (currentProjectId) {
      await client
        .forProject(currentProjectId)
        .setBrake({
          brake: "schedule_pause",
          active: checked,
          reason: "Console operator action",
        })
        .catch(() => {});
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Capacity Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Capacity</h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Parallel jobs */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Parallel jobs
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Maximum jobs running at once across this installation.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-parallel-jobs"
                value={parallelJobs}
                onChange={(e) => {
                  setParallelJobs(e.target.value);
                  saveAutomation({ parallelJobs: e.target.value });
                }}
                className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value="1">1 parallel lap</option>
                <option value="2">2 parallel laps</option>
                <option value="4">4 parallel laps</option>
                <option value="8">8 parallel laps</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>

          {/* Laps per issue */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Laps per issue
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Repair attempts allowed per issue, across all projects.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-max-laps"
                value={maxLaps}
                onChange={(e) => {
                  setMaxLaps(e.target.value);
                  saveAutomation({ maxLaps: e.target.value });
                }}
                className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value="1">1 lap</option>
                <option value="2">2 laps</option>
                <option value="3">3 laps</option>
                <option value="5">5 laps</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>

          {/* Poll interval */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Poll interval
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Time between backlog and triage checks across projects.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-poll-interval"
                value={pollInterval}
                onChange={(e) => {
                  setPollInterval(e.target.value);
                  saveAutomation({ pollInterval: e.target.value });
                }}
                className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value="60">60 seconds (1m)</option>
                <option value="300">300 seconds (5m)</option>
                <option value="600">600 seconds (10m)</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>

          {/* Role continuations */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Role continuations
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Extra attempts after a role reaches its soft timeout.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-continuations"
                value={continuations}
                onChange={(e) => {
                  setContinuations(e.target.value);
                  saveAutomation({ continuations: e.target.value });
                }}
                className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value="0">None</option>
                <option value="1">1 continuation</option>
                <option value="2">2 continuations</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Work Window Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Work window</h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Limit scheduled launches
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Launch scheduled jobs only within these hours, across all projects.
              </span>
            </div>
            <Switch checked={limitWorkWindow} onCheckedChange={setLimitWorkWindow} />
          </div>

          {limitWorkWindow && (
            <div className="flex items-center justify-between gap-8 py-3.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium leading-[1.4] text-foreground">
                  Hours and timezone
                </span>
                <span className="text-[13px] leading-[1.45] text-text-secondary">
                  Local execution window for automated task processing.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="h-[38px] w-20 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-2.5 text-center text-sm text-foreground outline-none focus-visible:border-[var(--ring)]"
                />
                <span className="text-xs text-text-secondary">to</span>
                <input
                  type="text"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="h-[38px] w-20 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-2.5 text-center text-sm text-foreground outline-none focus-visible:border-[var(--ring)]"
                />
                <input
                  type="text"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="h-[38px] w-48 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] px-3 text-sm text-foreground outline-none focus-visible:border-[var(--ring)]"
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Execution Brakes Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Pause className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Project pause</h3>
        </div>
        <div className="flex flex-col rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Pause this schedule
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Pause background dispatch. Manual launches remain available.
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant={schedulePaused ? "warning" : "outline"} className="text-xs">
                {schedulePaused ? "Paused" : "Off"}
              </Badge>
              <Switch checked={schedulePaused} onCheckedChange={handleToggleSchedulePause} />
            </div>
          </div>
        </div>
      </section>

      {/* Platform Launch Controls */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Launch controls</h3>
        </div>
        <div className="flex flex-col rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Stop all launches
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Block new manual and scheduled launches across every project. Running jobs continue.
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant={globalBrake ? "error" : "outline"} className="text-xs">
                {globalBrake ? "Brake Active" : "Off"}
              </Badge>
              <Switch checked={globalBrake} onCheckedChange={handleToggleGlobalBrake} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
