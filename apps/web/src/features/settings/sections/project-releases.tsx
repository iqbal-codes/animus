import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, GitBranch, Rocket } from "lucide-react";

export function ProjectReleasesSection({
  currentProjectId,
}: {
  currentProjectId?: string | null;
} = {}) {
  const [completionMode, setCompletionMode] = useState<"wait" | "auto">("wait");
  const [mergeMethod, setMergeMethod] = useState<"squash" | "rebase" | "merge">("squash");
  const [independentReviewer, setIndependentReviewer] = useState(true);
  const [holdSensitive, setHoldSensitive] = useState(true);

  useEffect(() => {
    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.releases) return;
        if (data.releases.completionMode) setCompletionMode(data.releases.completionMode);
        if (data.releases.mergeMethod) setMergeMethod(data.releases.mergeMethod);
        if (typeof data.releases.independentReviewer === "boolean") {
          setIndependentReviewer(data.releases.independentReviewer);
        }
        if (typeof data.releases.holdSensitive === "boolean") {
          setHoldSensitive(data.releases.holdSensitive);
        }
      })
      .catch(() => {});
  }, [currentProjectId]);

  const saveReleases = (updates: {
    completionMode?: "wait" | "auto";
    mergeMethod?: "squash" | "rebase" | "merge";
    independentReviewer?: boolean;
    holdSensitive?: boolean;
  }) => {
    const url = currentProjectId
      ? `/api/v1/settings/project?projectId=${encodeURIComponent(currentProjectId)}`
      : "/api/v1/settings/project";

    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        releases: {
          completionMode: updates.completionMode ?? completionMode,
          mergeMethod: updates.mergeMethod ?? mergeMethod,
          independentReviewer: updates.independentReviewer ?? independentReviewer,
          holdSensitive: updates.holdSensitive ?? holdSensitive,
        },
      }),
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Landing Guard & Merge Policy Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Merge policy</h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* After verification */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                After verification
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Choose what happens after checks and independent review pass.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-completion-mode"
                value={completionMode}
                onChange={(e) => {
                  const val = e.target.value as "wait" | "auto";
                  setCompletionMode(val);
                  saveReleases({ completionMode: val });
                }}
                className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value="wait">Wait for approval</option>
                <option value="auto">Auto-merge</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>

          {/* Merge method */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Merge method
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                How verified pull requests land on the target branch.
              </span>
            </div>
            <div className="relative shrink-0">
              <select
                id="settings-merge-method"
                value={mergeMethod}
                onChange={(e) => {
                  const val = e.target.value as "squash" | "rebase" | "merge";
                  setMergeMethod(val);
                  saveReleases({ mergeMethod: val });
                }}
                className="h-[38px] w-[200px] appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--card)] pr-9 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:border-[var(--ring)]"
              >
                <option value="squash">squash</option>
                <option value="rebase">rebase</option>
                <option value="merge">merge</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-secondary"
              />
            </div>
          </div>

          {/* Require independent reviewer */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Require an independent reviewer
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                The builder agent cannot approve its own work.
              </span>
            </div>
            <Switch
              id="settings-independent-reviewer"
              data-testid="settings-independent-reviewer"
              checked={independentReviewer}
              onCheckedChange={(val) => {
                setIndependentReviewer(val);
                saveReleases({ independentReviewer: val });
              }}
            />
          </div>

          {/* Hold sensitive changes */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Hold sensitive changes
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Require human review for auth, schema, security, and governance changes.
              </span>
            </div>
            <Switch
              id="settings-hold-sensitive"
              data-testid="settings-hold-sensitive"
              checked={holdSensitive}
              onCheckedChange={(val) => {
                setHoldSensitive(val);
                saveReleases({ holdSensitive: val });
              }}
            />
          </div>
        </div>
      </section>

      {/* Promotion & Tiered Actions Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Rocket className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Promotion</h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Branch pipeline */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Branch pipeline
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Promote verified work from the base branch to the release branch.
              </span>
            </div>
            <Badge variant="outline" className="font-mono text-xs text-foreground">
              develop -&gt; main
            </Badge>
          </div>

          {/* Recheck before consequential actions */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Recheck before consequential actions
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Verify the commit and prerequisites before launch, cancel, merge, or promotion.
              </span>
            </div>
            <Badge variant="success" className="font-medium">
              Required
            </Badge>
          </div>

          {/* PR CI Polling Wait */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                CI wait time
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Wait for GitHub checks before starting the reviewer.
              </span>
            </div>
            <Badge variant="outline" className="font-mono text-xs text-text-secondary">
              15 seconds
            </Badge>
          </div>
        </div>
      </section>
    </div>
  );
}
