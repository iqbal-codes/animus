import { useCallback, useEffect, useState } from "react";
import type {
  PlanDispatchRun,
  PlanDispatchRunList,
  PlanList,
  Project,
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

export function latestRunByPlan(runs: PlanDispatchRunList): Map<string, PlanDispatchRun> {
  const latest = new Map<string, PlanDispatchRun>();
  for (const run of runs) {
    const current = latest.get(run.plan_id);
    if (!current || run.created_at > current.created_at) latest.set(run.plan_id, run);
  }
  return latest;
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
    } finally {
      setBusyPlanId(null);
    }
  };

  const admitted = plans.filter((plan) => plan.authority === "admitted");
  const latest = latestRunByPlan(runs);

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
            className="h-8 rounded-full border border-[var(--border)] bg-background px-3 text-xs text-foreground"
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
          <p className="text-xs text-text-muted">Loading admitted plans…</p>
        ) : admitted.length === 0 ? (
          <p data-testid="dispatch-empty" className="text-xs text-text-muted">
            No admitted plans for this project. Import and approve a plan before dispatching.
          </p>
        ) : (
          admitted.map((plan) => {
            const run = latest.get(plan.id);
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
                <span className="text-[11px] text-text-muted">
                  {plan.kind} · tickets {plan.ticket_count} · holds {plan.hold_count}
                </span>
                <span className="flex-1" />
                {run && <Badge variant={RUN_TONE[run.state]}>{run.state}</Badge>}
                <Button
                  variant="secondary"
                  size="sm"
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
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
