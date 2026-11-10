import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { BellRing, Check } from "lucide-react";

/** GitHub Mark SVG Icon */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function PlatformGitHubSection() {
  const [readyEvent, setReadyEvent] = useState(true);
  const [changeEvent, setChangeEvent] = useState(true);
  const [reviewEvent, setReviewEvent] = useState(true);

  useEffect(() => {
    fetch("/api/v1/settings/platform")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.github) return;
        if (typeof data.github.readyEvent === "boolean") setReadyEvent(data.github.readyEvent);
        if (typeof data.github.changeEvent === "boolean") setChangeEvent(data.github.changeEvent);
        if (typeof data.github.reviewEvent === "boolean") setReviewEvent(data.github.reviewEvent);
      })
      .catch(() => {});
  }, []);

  const saveGithub = (updates: {
    readyEvent?: boolean;
    changeEvent?: boolean;
    reviewEvent?: boolean;
  }) => {
    fetch("/api/v1/settings/platform", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        github: {
          readyEvent: updates.readyEvent ?? readyEvent,
          changeEvent: updates.changeEvent ?? changeEvent,
          reviewEvent: updates.reviewEvent ?? reviewEvent,
        },
      }),
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-8">
      {/* GitHub Webhook Receiver Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <GithubMark className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Connection</h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* GitHub CLI */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">GitHub CLI</span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Used for backlog sync, cloning, pull requests, and status checks.
              </span>
            </div>
            <Badge variant="success" className="gap-1.5 font-medium">
              <Check className="size-3.5" />
              Authenticated · gh 2.65.0
            </Badge>
          </div>

          {/* Webhook Endpoint */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Webhook endpoint
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Wake the monitor as soon as a GitHub event arrives.
              </span>
            </div>
            <span className="rounded bg-white/5 px-2.5 py-1 font-mono text-xs text-foreground">
              127.0.0.1:4310/api/v1/webhooks/github
            </span>
          </div>

          {/* Webhook Secret */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Webhook secret
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Verify incoming webhook requests with an HMAC signature.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm tracking-widest text-text-secondary">
                ••••••••••••••••
              </span>
              <Badge variant="outline" className="text-[11px] text-text-secondary">
                Configured
              </Badge>
            </div>
          </div>

          {/* Deduplication Window */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Deduplication window
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Ignore repeated webhook delivery IDs within this period.
              </span>
            </div>
            <Badge variant="outline" className="text-xs text-text-secondary">
              120 seconds
            </Badge>
          </div>
        </div>
      </section>

      {/* Eligible Wake Events Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <BellRing className="size-4 text-text-secondary" />
          <h3 className="text-base font-medium leading-[1.4] text-foreground">Wake events</h3>
        </div>
        <div className="flex flex-col divide-y divide-[var(--border-subtle)] rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[#141518] px-4 py-1">
          {/* Issue ready */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Issue ready for an agent
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Check admission and launch when capacity is available.
              </span>
            </div>
            <Switch
              id="settings-github-ready-event"
              checked={readyEvent}
              onCheckedChange={(val) => {
                setReadyEvent(val);
                saveGithub({ readyEvent: val });
              }}
            />
          </div>

          {/* Issue changes */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Issue changes
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Re-evaluate triage when issues are opened, reopened, edited, or unlabeled.
              </span>
            </div>
            <Switch
              id="settings-github-change-event"
              checked={changeEvent}
              onCheckedChange={(val) => {
                setChangeEvent(val);
                saveGithub({ changeEvent: val });
              }}
            />
          </div>

          {/* Reviews and checks */}
          <div className="flex items-center justify-between gap-8 py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium leading-[1.4] text-foreground">
                Reviews and checks
              </span>
              <span className="text-[13px] leading-[1.45] text-text-secondary">
                Wake coordination when reviews arrive or CI checks finish.
              </span>
            </div>
            <Switch
              id="settings-github-review-event"
              data-testid="settings-github-review-event"
              checked={reviewEvent}
              onCheckedChange={(val) => {
                setReviewEvent(val);
                saveGithub({ reviewEvent: val });
              }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
