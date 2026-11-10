import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock,
  Cpu,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Layers,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wallet,
  X,
} from "lucide-react";
import type { OperatorWorkDetail } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatTokens,
  mapHarnessMetrics,
  mapTimelineMilestones,
  type IssueHarnessMetrics,
  type IssueTimelineMilestone,
} from "./jobs-model";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; detail: OperatorWorkDetail };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Canonical 2-column Expanded Issue Workspace corresponding to `vDp5q`
 * (Animus / Issue detail / Expanded / Agent merged).
 *
 * Left column: Issue Inspector (`Zpf6P`) with metadata, contract scope, AC checklist, evidence.
 * Right column: Factory Execution (`mLa98`) with milestones stepper, harness & token metrics, activity stream.
 */
export function IssueExpandedWorkspace({
  workId,
  projectId,
  onClose,
  factory = client,
}: {
  workId: string;
  projectId: string;
  onClose: () => void;
  factory?: typeof client;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [checkedAc, setCheckedAc] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const detail = await factory.forProject(projectId).workDetail(workId);
      setState({ phase: "ready", detail });
    } catch (error) {
      setState({ phase: "error", message: messageOf(error) });
    }
  }, [factory, projectId, workId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Handle escape key to close workspace
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (state.phase === "loading") {
    return (
      <div
        data-testid="expanded-workspace-loading"
        className="flex min-h-0 flex-1 flex-col px-7 py-5"
      >
        <div className="flex items-center gap-3 pb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            aria-label="Back to Kanban"
            className="gap-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Kanban</span>
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center rounded-[10px] border border-[var(--border-subtle)] bg-[var(--background)] p-12">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--text-secondary)]" />
            <p className="text-xs text-[var(--text-secondary)]">
              Loading issue workspace from canonical factory state…
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div
        data-testid="expanded-workspace-error"
        className="flex min-h-0 flex-1 flex-col px-7 py-5"
      >
        <div className="flex items-center gap-3 pb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            aria-label="Back to Kanban"
            className="gap-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Kanban</span>
          </Button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--background)] p-12">
          <p role="alert" className="text-xs text-[var(--error)]">
            Issue detail unavailable: {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            <span>Retry</span>
          </Button>
        </div>
      </div>
    );
  }

  const detail = state.detail;
  const milestones: IssueTimelineMilestone[] = mapTimelineMilestones(detail);
  const metrics: IssueHarnessMetrics = mapHarnessMetrics(detail);

  const issueNum = detail.work.issue_number ?? detail.contract.sourceUrl.split("/").pop();
  const repoName =
    detail.work.repo_name || detail.work.revision.provenance.repo_name || "Repository";
  const pr = detail.publication?.pullRequests[0] ?? null;
  const headSha =
    detail.latestRun?.run.head_sha?.slice(0, 7) ?? detail.contract.contentHash.slice(0, 7);
  const targetBranch =
    detail.latestRun?.run.target_branch ?? detail.plan?.delivery_branch ?? "main";
  const activeBranch =
    detail.latestRun?.run.branch ?? detail.retained?.branch ?? `factory/issue-${issueNum}`;

  const criteria =
    detail.plan?.acceptance_criteria ??
    detail.latestRun?.acceptanceCriteria.map((c) => ({
      id: c.acKey,
      ac_key: c.acKey,
      text: c.text,
    })) ??
    [];

  // Checks and findings from evidence observations
  const observations = detail.evidence?.observations ?? [];
  const checks = observations.flatMap((obs) => obs.checks);
  const findings = detail.evidence?.findings ?? [];
  const passedChecksCount = checks.filter((c) => c.result === "PASS").length;

  return (
    <div
      data-testid="expanded-issue-workspace"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 py-5"
    >
      <div className="flex flex-col gap-6 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--background)] p-5 sm:p-6 shadow-sm">
        {/* Top Header Toolbar (`zJM6O`) */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              aria-label="Back to Kanban"
              className="gap-2"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back to Kanban</span>
            </Button>
            <span className="font-mono text-xs text-[var(--text-muted)]">
              #{issueNum} · {repoName}
            </span>
            <Badge
              variant={
                detail.lane === "merged"
                  ? "success"
                  : detail.lane === "failed" || detail.lane === "needs-owner"
                    ? "error"
                    : detail.lane === "working"
                      ? "accent"
                      : "default"
              }
            >
              {detail.stageLabel}
            </Badge>
            {detail.parent && (
              <span className="text-[11px] text-[var(--text-secondary)]">
                Part of #{detail.parent.issueNumber}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              aria-label="Refresh workspace"
              className="gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              aria-label="Close workspace"
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* 2-Column Responsive Workspace (`riKjp`) */}
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
          {/* LEFT COLUMN: Issue Inspector Pane (`Zpf6P`) - 60% (7 cols) */}
          <section
            aria-label="Issue Inspector"
            className="flex flex-col gap-6 min-w-0 lg:col-span-7"
          >
            {/* Title & Metadata Card */}
            <div className="rounded-[8px] border border-[var(--border-subtle)] bg-[var(--card)] p-5">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <span className="font-mono font-semibold text-foreground">#{issueNum}</span>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="h-3 w-3" />
                    {activeBranch}
                  </span>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1 font-mono">
                    <GitCommit className="h-3 w-3" />
                    {headSha}
                  </span>
                </div>

                <h1 className="text-lg font-semibold tracking-tight text-foreground">
                  {detail.contract.title}
                </h1>

                {/* PR & Branch Badges */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {pr ? (
                    <a
                      href={pr.url ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-secondary px-3 py-1 text-xs text-secondary-foreground transition-colors hover:bg-secondary/80"
                    >
                      {pr.state === "merged" ? (
                        <GitMerge className="h-3.5 w-3.5 text-[var(--success)]" />
                      ) : (
                        <GitPullRequest className="h-3.5 w-3.5 text-[var(--warning)]" />
                      )}
                      <span>PR #{pr.number ?? issueNum}</span>
                      <span className="capitalize text-[var(--text-muted)]">({pr.state})</span>
                      <ExternalLink className="h-3 w-3 text-[var(--text-muted)]" />
                    </a>
                  ) : (
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-secondary px-3 py-1 text-xs text-secondary-foreground">
                      <GitPullRequest className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                      <span>PR pending</span>
                    </div>
                  )}

                  <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] px-2.5 py-1 text-xs text-[var(--text-secondary)]">
                    Target: <span className="font-mono text-foreground">{targetBranch}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Contract Body & Scope */}
            <div className="flex flex-col gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--card)] p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold tracking-wide uppercase text-[var(--text-secondary)]">
                  Scope & Contract
                </h2>
                <span className="font-mono text-[10px] text-[var(--text-muted)]">
                  rev {detail.contract.revisionNumber} · {detail.contract.state}
                </span>
              </div>

              {detail.contract.labels.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {detail.contract.labels.map((label) => (
                    <Badge key={label} variant="outline" className="text-[10px]">
                      {label}
                    </Badge>
                  ))}
                </div>
              )}

              <div
                role="region"
                aria-label="Contract body"
                tabIndex={0}
                className="mt-2 max-h-64 overflow-y-auto rounded-[6px] bg-[var(--background)] p-3 text-xs leading-relaxed text-foreground"
              >
                <p className="whitespace-pre-wrap break-words">{detail.contract.body}</p>
              </div>
            </div>

            {/* Acceptance Criteria Checklist */}
            <div className="flex flex-col gap-3 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--card)] p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold tracking-wide uppercase text-[var(--text-secondary)]">
                  Acceptance Criteria
                </h2>
                <span className="text-[11px] text-[var(--text-muted)]">
                  {criteria.length} criteria defined
                </span>
              </div>

              {criteria.length === 0 ? (
                <p className="text-xs text-[var(--text-secondary)]">
                  No explicit acceptance criteria recorded for this work item.
                </p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {criteria.map((criterion) => {
                    const isChecked = checkedAc[criterion.id] ?? true;
                    return (
                      <li
                        key={criterion.id}
                        className="flex items-start gap-3 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--background)] p-3"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setCheckedAc((prev) => ({
                              ...prev,
                              [criterion.id]: !isChecked,
                            }))
                          }
                          aria-label={`Toggle criteria ${criterion.ac_key}`}
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                            isChecked
                              ? "border-[var(--success)] bg-[var(--success-bg)] text-[var(--success)]"
                              : "border-[var(--border-subtle)] bg-transparent text-transparent"
                          }`}
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="font-mono text-[11px] font-semibold text-foreground">
                            {criterion.ac_key}
                          </span>
                          <span className="text-xs text-[var(--text-secondary)]">
                            {criterion.text}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Evidence & Verification Summary */}
            <div className="flex flex-col gap-3 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--card)] p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-[var(--success)]" />
                  <h2 className="text-xs font-semibold tracking-wide uppercase text-[var(--text-secondary)]">
                    Evidence & Gate Verification
                  </h2>
                </div>
                {checks.length > 0 && (
                  <span className="text-[11px] font-medium text-[var(--success)]">
                    {passedChecksCount} / {checks.length} checks passed
                  </span>
                )}
              </div>

              {checks.length === 0 ? (
                <p className="text-xs text-[var(--text-secondary)]">
                  No automated gate checks or evidence recorded yet.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {checks.map((check) => (
                    <div
                      key={check.id}
                      className="flex items-center justify-between gap-3 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle2
                          className={`h-3.5 w-3.5 shrink-0 ${
                            check.result === "PASS"
                              ? "text-[var(--success)]"
                              : "text-[var(--error)]"
                          }`}
                        />
                        <span className="font-medium text-foreground">{check.name}</span>
                        {check.command && (
                          <span className="font-mono text-[10px] text-[var(--text-muted)]">
                            ${check.command}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {check.durationMs && (
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {(check.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                        <Badge
                          variant={check.result === "PASS" ? "success" : "error"}
                          className="text-[10px]"
                        >
                          {check.result}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {findings.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5 border-t border-[var(--border-subtle)] pt-3">
                  <h3 className="text-[11px] font-semibold text-[var(--warning)]">
                    Open Findings ({findings.length})
                  </h3>
                  {findings.map((f) => (
                    <div
                      key={f.id}
                      className="rounded-[6px] border border-[var(--warning-bg)] bg-[var(--warning-bg)]/20 p-2.5 text-xs text-foreground"
                    >
                      <div className="flex items-center gap-1 font-mono text-[10px] text-[var(--warning)]">
                        <span>{f.severity}</span>
                        {f.acKey && <span>· {f.acKey}</span>}
                        {f.fileContext && <span>· {f.fileContext}</span>}
                      </div>
                      <p className="mt-0.5 text-xs">{f.summary}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Spec Child Tickets (if applicable) */}
            {detail.specProgress && (
              <div className="flex flex-col gap-3 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--card)] p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-[var(--accent)]" />
                    <h2 className="text-xs font-semibold tracking-wide uppercase text-[var(--text-secondary)]">
                      Child Spec Tickets
                    </h2>
                  </div>
                  <span className="text-[11px] font-medium text-foreground">
                    {detail.specProgress.integrated}/{detail.specProgress.required} integrated
                  </span>
                </div>

                {detail.plan?.members && detail.plan.members.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {detail.plan.members
                      .filter((m) => m.role === "ticket")
                      .map((member) => (
                        <li
                          key={member.work_id}
                          className="flex items-center justify-between rounded-[6px] border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-medium text-foreground">
                              #{member.issue_number}
                            </span>
                            <span className="text-[var(--text-secondary)]">{member.title}</span>
                          </div>
                          <Badge variant="outline" className="text-[10px]">
                            {member.gate_profile}
                          </Badge>
                        </li>
                      ))}
                  </ul>
                ) : null}
              </div>
            )}
          </section>

          {/* RIGHT COLUMN: Factory Execution Pane (`mLa98`) - 40% (5 cols) */}
          <section
            aria-label="Factory Execution"
            className="flex flex-col gap-6 min-w-0 lg:col-span-5"
          >
            {/* Factory Milestones Timeline (`LUpL1`) */}
            <div className="flex flex-col gap-4 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--card)] p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold tracking-wide uppercase text-[var(--text-secondary)]">
                  Factory Timeline
                </h2>
                <span className="text-[11px] text-[var(--text-muted)]">Lifecycle Stepper</span>
              </div>

              <div className="flex flex-col gap-3">
                {milestones.map((milestone, idx) => {
                  const isLast = idx === milestones.length - 1;
                  return (
                    <div key={milestone.id} className="relative flex items-start gap-3">
                      {!isLast && (
                        <div
                          className="absolute left-2.25 top-4.5 h-[calc(100%+6px)] w-0.5 bg-[var(--border-subtle)]"
                          aria-hidden="true"
                        />
                      )}
                      <div className="relative z-10 flex h-4.5 w-4.5 shrink-0 items-center justify-center">
                        {milestone.status === "completed" ? (
                          <div className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--success-bg)] text-[var(--success)]">
                            <Check className="h-2.5 w-2.5" />
                          </div>
                        ) : milestone.status === "active" ? (
                          <div className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--accent-bg)] text-[var(--accent)]">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          </div>
                        ) : milestone.status === "failed" ? (
                          <div className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--error-bg)] text-[var(--error)]">
                            <CircleAlert className="h-2.5 w-2.5" />
                          </div>
                        ) : (
                          <div className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border-subtle)] text-[var(--text-muted)]">
                            <Circle className="h-1.5 w-1.5 fill-current" />
                          </div>
                        )}
                      </div>

                      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                        <span
                          className={`text-xs font-medium ${
                            milestone.status === "completed"
                              ? "text-foreground"
                              : milestone.status === "active"
                                ? "font-semibold text-[var(--accent)]"
                                : milestone.status === "failed"
                                  ? "text-[var(--error)]"
                                  : "text-[var(--text-muted)]"
                          }`}
                        >
                          {milestone.label}
                        </span>
                        {milestone.time && (
                          <span className="font-mono text-[10px] text-[var(--text-muted)]">
                            {milestone.time}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Harness & Resource Metrics Card (`MEpIh`) */}
            <div className="flex flex-col gap-4 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--card)] p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-[var(--accent)]" />
                  <h2 className="text-xs font-semibold tracking-wide uppercase text-[var(--text-secondary)]">
                    Harness & Resource Metrics
                  </h2>
                </div>
                <Badge variant="accent" className="text-[10px]">
                  {metrics.provider}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                  <span className="text-[10px] text-[var(--text-muted)]">Engine / Provider</span>
                  <span className="text-xs font-semibold text-foreground">{metrics.provider}</span>
                </div>

                <div className="flex flex-col gap-1 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                  <span className="text-[10px] text-[var(--text-muted)]">Model & Tier</span>
                  <span className="text-xs font-semibold text-foreground">
                    {metrics.model}{" "}
                    {metrics.tier && (
                      <span className="font-normal text-[var(--text-secondary)]">
                        · {metrics.tier}
                      </span>
                    )}
                  </span>
                </div>

                <div className="flex flex-col gap-1 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                  <span className="text-[10px] text-[var(--text-muted)]">Tokens Breakdown</span>
                  <div className="flex flex-col gap-0.5 text-[11px] font-mono text-foreground">
                    <span>
                      In: {metrics.tokensIn !== undefined ? formatTokens(metrics.tokensIn) : "—"}
                    </span>
                    <span>
                      Out: {metrics.tokensOut !== undefined ? formatTokens(metrics.tokensOut) : "—"}
                    </span>
                    {metrics.cacheReadTokens !== undefined && (
                      <span className="text-[10px] text-[var(--text-secondary)]">
                        Cache: {formatTokens(metrics.cacheReadTokens)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-1 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                  <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <Wallet className="h-3 w-3" />
                    Total Spend
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    {metrics.costFormatted ?? "Cost not recorded"}
                  </span>
                </div>
              </div>
            </div>

            {/* Activity & Verification Stream (`D2PiZl` / `cN6pS`) */}
            <div className="flex flex-col gap-3 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--card)] p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-[var(--text-secondary)]" />
                  <h2 className="text-xs font-semibold tracking-wide uppercase text-[var(--text-secondary)]">
                    Activity & Checks Stream
                  </h2>
                </div>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {checks.length + observations.length} events
                </span>
              </div>

              <div
                role="region"
                aria-label="Activity logs"
                tabIndex={0}
                className="max-h-80 overflow-y-auto rounded-[6px] bg-[var(--background)] p-3 font-mono text-xs"
              >
                {checks.length === 0 && observations.length === 0 ? (
                  <p className="text-[11px] text-[var(--text-muted)]">
                    No activity logs recorded for this session yet.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {checks.map((check) => (
                      <div
                        key={check.id}
                        className="flex items-start gap-2 border-b border-[var(--border-subtle)] pb-2 last:border-0 last:pb-0"
                      >
                        <Clock className="mt-0.5 h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div className="flex items-center justify-between gap-1 text-[10px]">
                            <span className="font-semibold text-foreground">{check.name}</span>
                            <span
                              className={
                                check.result === "PASS"
                                  ? "text-[var(--success)]"
                                  : "text-[var(--error)]"
                              }
                            >
                              {check.result}
                            </span>
                          </div>
                          {check.command && (
                            <span className="break-all text-[10px] text-[var(--text-muted)]">
                              ${check.command}
                            </span>
                          )}
                          {check.detail && (
                            <span className="text-[10px] text-[var(--text-secondary)]">
                              {check.detail}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
