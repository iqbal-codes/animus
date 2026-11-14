import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  CircleDashed,
  LoaderCircle,
} from "lucide-react";
import { cn } from "cn";
import type {
  OperatorExecutionStep,
  OperatorRealtimeLogLine,
  OperatorWorkDetail,
} from "@animus/contracts/operator";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTokens, mapHarnessMetrics, type IssueHarnessMetrics } from "./jobs-model";
import { Mono, StatusPill, TONE_TEXT, type DetailTone } from "./issue-detail-parts";

function stepTone(status: OperatorExecutionStep["status"]): DetailTone {
  switch (status) {
    case "completed":
      return "success";
    case "active":
      return "accent";
    case "failed":
      return "error";
    default:
      return "muted";
  }
}

function stepIcon(status: OperatorExecutionStep["status"]) {
  switch (status) {
    case "completed":
      return CircleCheck;
    case "active":
      return LoaderCircle;
    case "failed":
      return CircleX;
    default:
      return CircleDashed;
  }
}

function elapsedOf(start: number | null | undefined, end: number | null | undefined): string {
  if (!start) return "";
  const seconds = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Unified Factory execution rail for `Animus / Issue detail / Expanded`
 * (`ITMzl`, `qNjDd`, `drpVe`, `En4yq`): timeline, token usage, harness logs —
 * three flat hairline-divided sections in a fixed order.
 */
export function FactoryRail({
  detail,
  metrics: providedMetrics,
}: {
  detail: OperatorWorkDetail;
  metrics?: IssueHarnessMetrics;
}) {
  const metrics = providedMetrics ?? mapHarnessMetrics(detail);
  const steps: OperatorExecutionStep[] = detail.executionSteps ?? [];
  const run = detail.latestRun?.run ?? null;
  const budget = detail.latestRun?.budget ?? null;

  const activeStep = steps.find((step) => step.status === "active");
  const initialOpen =
    activeStep?.id ?? [...steps].reverse().find((step) => step.status !== "pending")?.id ?? null;
  const [openStepId, setOpenStepId] = useState<string | null>(initialOpen);

  const logs: OperatorRealtimeLogLine[] = detail.realtimeLogs ?? [];
  const visibleLogs = logs.slice(0, 100);

  const tokensIn = metrics.tokensIn ?? 0;
  const tokensOut = metrics.tokensOut ?? 0;
  const totalTokens = tokensIn + tokensOut;
  const tokensAvailable = detail.usage.available;
  const budgetTokens =
    (budget?.allowedAttempts ?? 3) * 300_000 + (budget?.grantedAttempts ?? 0) * 300_000;

  const duration =
    elapsedOf(run?.launched_at, run?.finished_at) ||
    (run?.created_at ? elapsedOf(run.created_at, run.finished_at) : "");

  const statusLabel =
    detail.lane === "working"
      ? "Active"
      : detail.lane === "approval"
        ? "Approval"
        : detail.lane === "merged"
          ? "Merged"
          : detail.lane === "needs-owner"
            ? "Needs owner"
            : detail.lane === "failed"
              ? "Failed"
              : detail.lane === "parked"
                ? "Paused"
                : detail.stageLabel;

  const statusTone: DetailTone =
    detail.lane === "working"
      ? "accent"
      : detail.lane === "merged" || detail.lane === "approval"
        ? "success"
        : detail.lane === "needs-owner" || detail.lane === "failed"
          ? "error"
          : "muted";

  const isLive = run?.state === "running" || activeStep !== undefined;

  /**
   * Per-stage consumption, grouped the way the rail presents work: Triage,
   * Implement, Verification & review, Merge & wrap. A row only exists when at
   * least one step in that stage reported a token count — no empty placeholders.
   */
  const STAGE_GROUPS: Array<{ label: string; match: RegExp }> = [
    { label: "Triage", match: /^triage/i },
    { label: "Implement", match: /^implement/i },
    { label: "Verification & review", match: /^(verification|review|integrated)/i },
    { label: "Merge & wrap", match: /^merged/i },
  ];

  const stageTokenRows: Array<{ label: string; value: string; active: boolean }> = STAGE_GROUPS.map(
    (group) => {
      const groupSteps = steps.filter((step) => group.match.test(step.label));
      const recorded = groupSteps.filter((step) => step.tokens !== undefined);
      if (recorded.length === 0) return null;
      const total = recorded.reduce((sum, step) => sum + (step.tokens ?? 0), 0);
      const running = groupSteps.some((step) => step.status === "active");
      return {
        label: group.label,
        value: `${formatTokens(total)}${running ? " · running" : ""}`,
        active: running,
      };
    },
  ).filter((row): row is { label: string; value: string; active: boolean } => row !== null);

  const aggregateRows = [
    { label: "Input tokens", value: formatTokens(tokensIn), active: false },
    { label: "Output tokens", value: formatTokens(tokensOut), active: false },
    {
      label: "Cache read",
      value: formatTokens(metrics.cacheReadTokens ?? 0),
      active: false,
    },
  ];

  const tokenRows = stageTokenRows.length > 0 ? stageTokenRows : aggregateRows;

  return (
    <div data-testid="factory-rail" className="flex min-h-full flex-col px-4 pb-4 sm:px-5">
      {/* SECTION 1 — Factory timeline */}
      <section
        aria-label="Factory Timeline"
        className="flex flex-col gap-3 border-b border-[var(--border-subtle)] py-[18px]"
      >
        <div className="flex items-center gap-[10px]">
          <h2 className="text-[13px] leading-[1.5] font-medium text-foreground">
            Factory timeline
          </h2>
          <span className="flex-1" />
          <span className={cn("font-mono text-[11px] leading-[1.5]", TONE_TEXT[statusTone])}>
            {duration && statusTone === "accent" ? duration : isLive ? "Running" : statusLabel}
          </span>
        </div>

        <div className="flex items-center gap-[10px]">
          <span className="text-[11px] leading-[1.5] text-[var(--text-secondary)]">
            {activeStep?.label ?? detail.stageLabel}
          </span>
          <span className="flex-1" />
          <Mono className="text-[10px]">{steps.length} steps</Mono>
        </div>

        <div className="flex flex-col gap-1.5">
          {steps.map((step) => {
            const Icon = stepIcon(step.status);
            const tone = stepTone(step.status);
            const isOpen = openStepId === step.id;
            const meta =
              step.status === "active"
                ? "running"
                : step.duration
                  ? step.duration
                  : (step.time ?? "");

            return (
              <div key={step.id} className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => setOpenStepId(isOpen ? null : step.id)}
                  aria-expanded={isOpen}
                  className={cn(
                    "flex w-full items-center gap-[10px] rounded-full px-2 py-1.5 text-left transition-colors hover:bg-[var(--white-04)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
                    isOpen && "bg-[var(--white-04)]",
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      "size-[13px] shrink-0",
                      TONE_TEXT[tone],
                      step.status === "active" && "animate-spin motion-reduce:animate-none",
                    )}
                  />
                  <span className="truncate text-xs leading-[1.5] text-foreground">
                    {step.label}
                  </span>
                  <span className="flex-1" />
                  {meta && <Mono className="shrink-0 text-[10px]">{meta}</Mono>}
                  {isOpen ? (
                    <ChevronDown
                      aria-hidden="true"
                      className="size-3 shrink-0 text-[var(--text-secondary)]"
                    />
                  ) : (
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3 shrink-0 text-[var(--text-secondary)]"
                    />
                  )}
                </button>

                {isOpen && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex max-h-[132px] min-h-[38px] w-full flex-col gap-2 overflow-hidden rounded-[6px] border border-[var(--border-subtle)] bg-[var(--background)] px-2.5 py-2">
                      {step.logs.length > 0 ? (
                        <ScrollArea className="max-h-[114px]">
                          <div className="flex flex-col gap-[3px]">
                            {step.logs.map((entry, index) => (
                              <div
                                key={`${step.id}-log-${index}`}
                                className="flex items-start gap-2 font-mono text-[10px] leading-[1.4]"
                              >
                                <span className="shrink-0 text-[var(--text-muted)]">
                                  {entry.timestamp}
                                </span>
                                <span className="shrink-0 text-[var(--text-secondary)]">
                                  {entry.event}
                                </span>
                                <span className="min-w-0 break-words text-[var(--text-secondary)]">
                                  {entry.message}
                                </span>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      ) : (
                        <span className="text-[10.5px] leading-[1.5] text-[var(--text-muted)]">
                          No log entries recorded for this step yet.
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] leading-[1.5] text-[var(--text-muted)] tabular-nums">
                        {step.logs.length} {step.logs.length === 1 ? "entry" : "entries"}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5">
          <ChevronDown
            aria-hidden="true"
            className="size-[11px] shrink-0 text-[var(--text-muted)]"
          />
          <span className="text-[10.5px] leading-[1.5] text-[var(--text-muted)]">
            One step open at a time · steps appear as they run
          </span>
        </div>
      </section>

      {/* SECTION 2 — Token usage (recorded figures only, no placeholders) */}
      <section
        aria-label="Token Usage"
        className="flex flex-col gap-3 border-b border-[var(--border-subtle)] py-[18px]"
      >
        <div className="flex items-center gap-[10px]">
          <h2 className="text-[13px] leading-[1.5] font-medium text-foreground">Token usage</h2>
          <span className="flex-1" />
          <span
            className={cn(
              "font-mono text-[11px] leading-[1.5]",
              tokensAvailable ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
            )}
          >
            {tokensAvailable ? formatTokens(totalTokens) : "Not recorded"}
          </span>
        </div>

        {tokensAvailable ? (
          <>
            <div className="flex items-center gap-[10px]">
              <span className="text-[24px] leading-[1.5] font-medium text-foreground">
                {formatTokens(totalTokens)}
              </span>
              <span className="text-xs leading-[1.5] text-[var(--text-secondary)]">
                {`${metrics.costFormatted} so far`}
              </span>
              <span className="flex-1" />
              {budgetTokens > 0 && (
                <Mono className="text-[10px]">{`of ${formatTokens(budgetTokens)} budget`}</Mono>
              )}
            </div>

            {budgetTokens > 0 && (
              <Progress
                value={Math.min(100, Math.max(3, (totalTokens / budgetTokens) * 100))}
                className="h-1.5 w-full"
              />
            )}

            <div className="flex flex-col gap-[7px]">
              {tokenRows.map((row) => (
                <div key={row.label} className="flex items-center gap-[10px]">
                  <span className="text-[11px] leading-[1.5] text-[var(--text-secondary)]">
                    {row.label}
                  </span>
                  <span className="flex-1" />
                  <Mono className={cn("text-[10px]", row.active && "text-[var(--accent)]")}>
                    {row.value}
                  </Mono>
                </div>
              ))}
            </div>
          </>
        ) : detail.lane === "triage" && !run ? null : (
          <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">
            {detail.usage.detail}
          </span>
        )}
      </section>

      {/* SECTION 3 — Harness logs */}
      <section aria-label="Harness Logs" className="flex min-h-0 flex-1 flex-col gap-3 pt-[18px]">
        <div className="flex items-center gap-[10px]">
          <h2 className="text-[13px] leading-[1.5] font-medium text-foreground">Harness logs</h2>
          <span className="flex-1" />
          <StatusPill
            label={isLive ? "Live" : logs.length > 0 ? "Retained" : "Empty"}
            tone={isLive ? "accent" : "muted"}
            soft={isLive}
          />
        </div>

        <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">
          Entire session · All workers · {metrics.provider} · Newest first
        </span>

        <div className="flex w-full items-center gap-3 border-y border-[var(--border-subtle)] px-0 py-2">
          <span className="w-14 shrink-0 font-mono text-[10px] tracking-[0.4px] text-[var(--text-muted)] uppercase sm:w-16">
            TIME
          </span>
          <span className="w-[72px] shrink-0 font-mono text-[10px] tracking-[0.4px] text-[var(--text-muted)] uppercase sm:w-[88px]">
            TOOL / EVENT
          </span>
          <span className="flex-1 font-mono text-[10px] tracking-[0.4px] text-[var(--text-muted)] uppercase">
            MESSAGE
          </span>
        </div>

        <ScrollArea className="min-h-0 flex-1" data-testid="realtime-logs-stream">
          <div className="flex flex-col">
            {visibleLogs.length > 0 ? (
              visibleLogs.map((line) => (
                <div
                  key={line.id}
                  className="flex w-full items-start gap-3 border-b border-[var(--border-subtle)] px-0 py-[5px]"
                >
                  <span className="w-14 shrink-0 font-mono text-[11px] leading-[1.5] text-[var(--text-muted)] sm:w-16">
                    {line.timestamp}
                  </span>
                  <span
                    className={cn(
                      "w-[72px] shrink-0 truncate font-mono text-[11px] leading-[1.5] sm:w-[88px]",
                      line.event === "PASS" || line.event === "merged"
                        ? "text-[var(--success)]"
                        : line.event === "FAIL" || line.event === "failed"
                          ? "text-[var(--error)]"
                          : "text-[var(--info)]",
                    )}
                  >
                    {line.event}
                  </span>
                  <span className="min-w-0 flex-1 break-words font-mono text-xs leading-[1.5] text-[var(--text-secondary)]">
                    {line.message}
                  </span>
                </div>
              ))
            ) : (
              <div className="flex flex-col gap-1 py-6">
                <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">
                  No harness events recorded yet.
                </span>
                <span className="text-[10.5px] leading-[1.5] text-[var(--text-muted)]">
                  Starts the moment a worker picks up the ticket.
                </span>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-1.5">
          <span className="text-[10px] leading-[1.5] text-[var(--text-muted)]">
            {visibleLogs.length} visible · {logs.length} total
          </span>
          <span className="text-[10px] leading-[1.5] text-[var(--text-muted)]">
            Older entries below ↓
          </span>
        </div>
      </section>
    </div>
  );
}
