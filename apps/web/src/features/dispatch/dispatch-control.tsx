import { useCallback, useEffect, useState } from "react";
import type {
  PlanDispatchRun,
  PlanDispatchRunList,
  PlanList,
  Project,
  RunEvidenceReport,
} from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, Rocket } from "lucide-react";

const RUN_TONE: Record<
  PlanDispatchRun["state"],
  "default" | "success" | "warning" | "error" | "accent"
> = {
  claimed: "warning",
  dispatched: "accent",
  running: "accent",
  succeeded: "success",
  failed: "error",
  interrupted: "warning",
  reconciled: "default",
};

export function runsByPlan(runs: PlanDispatchRunList): Map<string, PlanDispatchRun[]> {
  const grouped = new Map<string, PlanDispatchRun[]>();
  for (const run of runs) {
    const list = grouped.get(run.plan_id) ?? [];
    list.push(run);
    grouped.set(run.plan_id, list);
  }
  for (const list of grouped.values()) {
    list.sort(
      (left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id),
    );
  }
  return grouped;
}

/**
 * Operator launch path for locally admitted plans. It uses the same backend
 * client and frozen-plan dispatch route as the CLI; it never reads GitHub.
 */
export function DispatchControl({ factory = client }: { factory?: typeof client }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [plans, setPlans] = useState<PlanList>([]);
  const [runs, setRuns] = useState<PlanDispatchRunList>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [evidence, setEvidence] = useState<Record<string, RunEvidenceReport>>({});
  const [evidenceLoading, setEvidenceLoading] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<Record<string, string>>({});
  const [selectedRuns, setSelectedRuns] = useState<Record<string, string>>({});

  const loadProject = useCallback(
    async (id: string) => {
      if (!id) {
        setPlans([]);
        setRuns([]);
        return;
      }
      const scoped = factory.forProject(id);
      const [nextPlans, nextRuns] = await Promise.all([scoped.plans(), scoped.dispatchRuns()]);
      setPlans(nextPlans);
      setRuns(nextRuns);
    },
    [factory],
  );

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextProjects = await factory.projects();
      setProjects(nextProjects);
      setProjectId((current) => {
        if (nextProjects.some((project) => project.id === current)) return current;
        return (
          nextProjects.find((project) => project.status === "active")?.id ??
          nextProjects[0]?.id ??
          ""
        );
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [factory]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!projectId) {
      setPlans([]);
      setRuns([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await loadProject(projectId);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loadProject]);

  const refresh = async () => {
    await loadProjects();
    if (projectId) await loadProject(projectId);
  };

  const dispatch = async (planId: string) => {
    setBusyPlanId(planId);
    setNotice(null);
    setError(null);
    try {
      const run = await factory.forProject(projectId).dispatchPlan({
        plan_id: planId,
        actor: "operator",
      });
      setNotice(`Run ${run.id} started for #${run.issue_number}: ${run.state}.`);
      await loadProject(projectId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      try {
        await loadProject(projectId);
      } catch (refreshError) {
        setError(
          `${message}; run refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
        );
      }
    } finally {
      setBusyPlanId(null);
    }
  };

  const toggleEvidence = async (runId: string) => {
    const next = !expanded[runId];
    setExpanded((current) => ({ ...current, [runId]: next }));
    if (!next || evidence[runId] || evidenceLoading === runId) return;
    setEvidenceLoading(runId);
    setEvidenceError((current) => {
      const copy = { ...current };
      delete copy[runId];
      return copy;
    });
    try {
      const report = await factory.forProject(projectId).runEvidence(runId);
      setEvidence((current) => ({ ...current, [runId]: report }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEvidenceError((current) => ({ ...current, [runId]: message }));
    } finally {
      setEvidenceLoading(null);
    }
  };

  const admitted = plans.filter((plan) => plan.authority === "admitted");
  const grouped = runsByPlan(runs);

  return (
    <section
      data-testid="dispatch-control"
      aria-label="Dispatch admitted plan"
      className="mx-7 mb-4 rounded-[12px] border border-[var(--border-subtle)] bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Rocket aria-hidden="true" className="size-4 shrink-0 text-accent" />
        <h2 className="text-sm font-medium text-foreground">Run admitted plan</h2>

        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="sr-only">Project</span>
          <select
            aria-label="Project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="h-11 rounded-full border border-[var(--border)] bg-background px-3 text-xs text-foreground sm:h-8"
          >
            {projects.length === 0 && <option value="">No active projects</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        <span className="flex-1" />

        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-8"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh admitted plans"
        >
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          <span>Refresh</span>
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--destructive)]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-xs text-text-secondary">
          {notice}
        </p>
      )}

      <div className="mt-3 space-y-2">
        {loading && admitted.length === 0 ? (
          <p className="text-xs text-text-secondary">Loading admitted plans…</p>
        ) : admitted.length === 0 ? (
          <p data-testid="dispatch-empty" className="text-xs text-text-secondary">
            No admitted plans for this project. Import and approve a plan before dispatching.
          </p>
        ) : (
          admitted.map((plan) => {
            const planRuns = grouped.get(plan.id) ?? [];
            const selectedRunId = selectedRuns[plan.id] ?? planRuns[0]?.id;
            const run = planRuns.find((candidate) => candidate.id === selectedRunId) ?? planRuns[0];
            const busy = busyPlanId === plan.id;
            return (
              <div
                key={plan.id}
                data-testid={`dispatch-plan-${plan.id}`}
                className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[var(--border-subtle)] px-3 py-2"
              >
                <span className="font-mono text-[11px] text-text-secondary">
                  #{plan.root_issue_number}
                </span>
                <span className="text-xs text-foreground">{plan.root_title || plan.id}</span>
                <span className="text-[11px] text-text-secondary">
                  {plan.kind} · tickets {plan.ticket_count} · holds {plan.hold_count}
                </span>
                <span className="flex-1" />
                {planRuns.length > 0 && run && (
                  <label className="flex min-w-0 items-center gap-2 text-[11px] text-text-secondary">
                    <span className="sr-only">
                      Run history for #{plan.root_issue_number}: ticket, lap and candidate
                    </span>
                    <select
                      aria-label={`Run history for #${plan.root_issue_number}`}
                      value={run.id}
                      onChange={(event) => {
                        const id = event.target.value;
                        setSelectedRuns((current) => ({ ...current, [plan.id]: id }));
                      }}
                      className="h-11 max-w-full rounded-full border border-[var(--border)] bg-background px-3 text-xs text-foreground sm:h-8"
                    >
                      {planRuns.map((item) => (
                        <option key={item.id} value={item.id}>
                          #{item.issue_number} · lap {item.lap} · candidate{" "}
                          {item.head_sha ? item.head_sha.slice(0, 7) : "none"} · {item.state}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {run && (
                  <>
                    <span className="break-words text-xs text-text-secondary">
                      Profile: {run.gate_profile} · Merge: {run.merge_policy} · Target:{" "}
                      {run.target_branch}
                    </span>
                    <Badge variant={RUN_TONE[run.state]}>{run.state}</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-expanded={Boolean(expanded[run.id])}
                      aria-controls={`run-evidence-${run.id}`}
                      onClick={() => void toggleEvidence(run.id)}
                    >
                      {expanded[run.id] ? "Hide evidence" : "View evidence"}
                    </Button>
                  </>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => void dispatch(plan.id)}
                  disabled={busy || plan.hold_count > 0}
                  title={
                    plan.hold_count > 0
                      ? "Plan has holds; resolve them before dispatching"
                      : "Dispatch this frozen plan"
                  }
                >
                  {busy ? "Dispatching…" : "Dispatch"}
                </Button>
                {run && expanded[run.id] && (
                  <div
                    id={`run-evidence-${run.id}`}
                    data-testid={`run-evidence-${run.id}`}
                    className="w-full"
                  >
                    {evidenceLoading === run.id ? (
                      <p role="status" className="text-xs text-text-secondary">
                        Loading checks and findings…
                      </p>
                    ) : evidenceError[run.id] ? (
                      <p role="alert" className="text-xs text-[var(--destructive)]">
                        Evidence unavailable: {evidenceError[run.id]}
                      </p>
                    ) : evidence[run.id] ? (
                      <RunEvidencePanel report={evidence[run.id]!} />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

const OBSERVATION_STATUS_TONE: Record<
  RunEvidenceReport["observations"][number]["status"],
  "default" | "success" | "warning" | "error" | "accent"
> = {
  running: "accent",
  passed: "success",
  failed: "error",
  inconclusive: "warning",
  interrupted: "warning",
};

const CHECK_RESULT_TONE: Record<
  RunEvidenceReport["observations"][number]["checks"][number]["result"],
  "default" | "success" | "warning" | "error"
> = {
  PASS: "success",
  FAIL: "error",
  BLOCKED: "warning",
  NOT_RUN: "default",
};

/** Selected-run detail: durable checks, findings, artifacts and acceptance state. */
function RunEvidencePanel({ report }: { report: RunEvidenceReport }) {
  const { acceptance, observations, findings } = report;
  return (
    <section
      aria-label="Run checks, findings and acceptance"
      className="mt-2 min-w-0 space-y-2 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-background/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-foreground">Checks &amp; findings</h3>
        <Badge variant={acceptance.authorized ? "success" : "error"}>
          {acceptance.authorized ? "Acceptance authorized" : "Acceptance blocked"}
        </Badge>
        <span className="break-all font-mono text-[10px] text-text-secondary">
          candidate {acceptance.candidateHeadSha ?? "none"} · target{" "}
          {acceptance.targetTipSha ?? "none"}
        </span>
      </div>

      {acceptance.reasons.length > 0 && (
        <ul
          aria-label="Acceptance blockers"
          className="list-disc pl-5 text-[11px] text-[var(--error)]"
        >
          {acceptance.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {observations.length === 0 ? (
        <p data-testid="run-evidence-empty" className="text-[11px] text-text-secondary">
          No stage observations recorded for this run.
        </p>
      ) : (
        <ul className="min-w-0 space-y-2">
          {observations.map((observation) => (
            <li
              key={observation.id}
              data-testid={`observation-${observation.id}`}
              className="min-w-0 rounded-[8px] border border-[var(--border-subtle)] px-2 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-foreground">{observation.stage}</span>
                <Badge variant={OBSERVATION_STATUS_TONE[observation.status]}>
                  {observation.status}
                </Badge>
                <span className="break-all font-mono text-[10px] text-text-secondary">
                  lap {observation.lap} · {observation.producer.id} ({observation.producer.role}) ·
                  profile {observation.gateProfile} v{observation.gateProfileVersion}
                </span>
              </div>
              {observation.checks.length > 0 && (
                <ul aria-label="Stage checks" className="mt-1 min-w-0 space-y-0.5">
                  {observation.checks.map((check) => (
                    <li
                      key={check.id}
                      className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]"
                    >
                      <Badge variant={CHECK_RESULT_TONE[check.result]}>{check.result}</Badge>
                      <span className="text-foreground">{check.name}</span>
                      <span className="break-all font-mono text-[10px] text-text-secondary">
                        {check.command}
                      </span>
                      {check.detail && (
                        <span className="break-all text-text-secondary">{check.detail}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {observation.artifacts.length > 0 && (
                <ul aria-label="Finalized artifacts" className="mt-1 min-w-0 space-y-0.5">
                  {observation.artifacts.map((artifact) => (
                    <li
                      key={artifact.id}
                      className="break-all font-mono text-[10px] text-text-secondary"
                    >
                      {artifact.ownerType}: {artifact.relativePath} · {artifact.sizeBytes}B · sha256{" "}
                      {artifact.digestSha256}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {findings.length > 0 && (
        <ul aria-label="Factory findings" className="min-w-0 space-y-2">
          {findings.map((finding) => (
            <li
              key={finding.id}
              data-testid={`finding-${finding.id}`}
              className="min-w-0 rounded-[8px] border border-[var(--border-subtle)] px-2 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={finding.severity === "blocking" ? "error" : "warning"}>
                  {finding.severity}
                </Badge>
                <Badge variant={finding.status === "resolved" ? "success" : "warning"}>
                  {finding.status}
                </Badge>
                <span className="break-all text-[11px] text-foreground">
                  #{finding.issueNumber}
                  {finding.acKey ? ` ${finding.acKey}` : ""} {finding.fileContext}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-text-secondary">{finding.summary}</p>
              <ol className="mt-1 space-y-0.5">
                {finding.events.map((event) => (
                  <li key={event.id} className="text-[10px] text-text-secondary">
                    {event.sequence}. {event.action} by {event.actor} ({event.actorRole})
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
