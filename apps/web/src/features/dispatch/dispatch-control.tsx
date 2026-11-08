import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeliveryGateStatus,
  DispatchRunDetail,
  FinalDeliveryStatus,
  IntegrationStatus,
  PlanDispatchRun,
  PlanDispatchRunList,
  PlanList,
  Project,
  PublicationStatus,
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

function createGrantIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `grant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  const [auditExpanded, setAuditExpanded] = useState<Record<string, boolean>>({});
  const [audit, setAudit] = useState<Record<string, PublicationStatus>>({});
  const [auditLoading, setAuditLoading] = useState<string | null>(null);
  const [auditError, setAuditError] = useState<Record<string, string>>({});
  const [publishing, setPublishing] = useState<string | null>(null);
  const [gateExpanded, setGateExpanded] = useState<Record<string, boolean>>({});
  const [gates, setGates] = useState<Record<string, DeliveryGateStatus>>({});
  const [gateLoading, setGateLoading] = useState<string | null>(null);
  const [gateError, setGateError] = useState<Record<string, string>>({});
  const [gateBusy, setGateBusy] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DispatchRunDetail>>({});
  const [detailExpanded, setDetailExpanded] = useState<Record<string, boolean>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<Record<string, string>>({});
  const [integrationExpanded, setIntegrationExpanded] = useState<Record<string, boolean>>({});
  const [integration, setIntegration] = useState<Record<string, IntegrationStatus>>({});
  const [integrationLoading, setIntegrationLoading] = useState<string | null>(null);
  const [integrationError, setIntegrationError] = useState<Record<string, string>>({});
  const [landing, setLanding] = useState<string | null>(null);
  const [finalExpanded, setFinalExpanded] = useState<Record<string, boolean>>({});
  const [finalStatus, setFinalStatus] = useState<Record<string, FinalDeliveryStatus>>({});
  const [finalLoading, setFinalLoading] = useState<string | null>(null);
  const [finalError, setFinalError] = useState<Record<string, string>>({});
  const [finalBusy, setFinalBusy] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [controlNotice, setControlNotice] = useState<Record<string, string>>({});
  const [grantAmount, setGrantAmount] = useState<Record<string, string>>({});
  const [grantReason, setGrantReason] = useState<Record<string, string>>({});
  const grantKeys = useRef<Record<string, string>>({});
  const detailInFlight = useRef<Set<string>>(new Set());

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
    // Retry durability detail after an earlier read failure so Dispatch is not
    // stranded in the fail-closed unknown state until a full page reload.
    setDetails({});
    setDetailError({});
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

  const toggleAudit = async (runId: string) => {
    const next = !auditExpanded[runId];
    setAuditExpanded((current) => ({ ...current, [runId]: next }));
    if (!next || audit[runId] || auditLoading === runId) return;
    setAuditLoading(runId);
    setAuditError((current) => {
      const copy = { ...current };
      delete copy[runId];
      return copy;
    });
    try {
      const status = await factory.forProject(projectId).publication(runId);
      setAudit((current) => ({ ...current, [runId]: status }));
    } catch (err) {
      setAuditError((current) => ({
        ...current,
        [runId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setAuditLoading(null);
    }
  };

  const publishAudit = async (runId: string) => {
    setPublishing(runId);
    setAuditError((current) => {
      const copy = { ...current };
      delete copy[runId];
      return copy;
    });
    try {
      const status = await factory.forProject(projectId).publishPublication(runId);
      setAudit((current) => ({ ...current, [runId]: status }));
    } catch (err) {
      setAuditError((current) => ({
        ...current,
        [runId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setPublishing(null);
    }
  };

  const loadGate = useCallback(
    async (runId: string) => {
      const scoped = factory.forProject(projectId);
      if (typeof scoped.deliveryGate !== "function") return;
      setGateLoading(runId);
      setGateError((current) => {
        const copy = { ...current };
        delete copy[runId];
        return copy;
      });
      try {
        const status = await scoped.deliveryGate(runId);
        setGates((current) => ({ ...current, [runId]: status }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setGateError((current) => ({ ...current, [runId]: message }));
      } finally {
        setGateLoading((current) => (current === runId ? null : current));
      }
    },
    [factory, projectId],
  );

  const toggleGate = async (runId: string) => {
    const next = !gateExpanded[runId];
    setGateExpanded((current) => ({ ...current, [runId]: next }));
    // The remote PR state changes outside this process, so reopening the panel
    // always re-reads the gate instead of trusting a stale cached projection.
    if (next) await loadGate(runId);
  };

  const verifyMerge = async (runId: string) => {
    const scoped = factory.forProject(projectId);
    if (typeof scoped.verifyDeliveryMerge !== "function") return;
    setGateBusy(runId);
    setGateError((current) => {
      const copy = { ...current };
      delete copy[runId];
      return copy;
    });
    try {
      const status = await scoped.verifyDeliveryMerge(runId, "operator");
      setGates((current) => ({ ...current, [runId]: status }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setGateError((current) => ({ ...current, [runId]: message }));
    } finally {
      setGateBusy(null);
    }
  };

  const toggleIntegration = async (runId: string) => {
    const next = !integrationExpanded[runId];
    setIntegrationExpanded((current) => ({ ...current, [runId]: next }));
    if (!next || integration[runId] || integrationLoading === runId) return;
    setIntegrationLoading(runId);
    setIntegrationError((current) => {
      const copy = { ...current };
      delete copy[runId];
      return copy;
    });
    try {
      const status = await factory.forProject(projectId).integrationStatus(runId);
      setIntegration((current) => ({ ...current, [runId]: status }));
    } catch (err) {
      setIntegrationError((current) => ({
        ...current,
        [runId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setIntegrationLoading(null);
    }
  };

  const landChild = async (runId: string) => {
    setLanding(runId);
    setIntegrationError((current) => {
      const copy = { ...current };
      delete copy[runId];
      return copy;
    });
    try {
      const status = await factory.forProject(projectId).landChild(runId, {
        actor: "operator",
      });
      setIntegration((current) => ({ ...current, [runId]: status }));
      setControlNotice((current) => ({
        ...current,
        [runId]:
          status.state === "integrated"
            ? `Integrated into ${status.targetBranch}.`
            : `Integration held: ${status.blockers.map((item) => item.code).join(", ")}`,
      }));
      await loadProject(projectId);
    } catch (err) {
      setIntegrationError((current) => ({
        ...current,
        [runId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setLanding(null);
    }
  };

  const loadDetail = useCallback(
    async (runId: string) => {
      if (detailInFlight.current.has(runId)) return;
      const scoped = factory.forProject(projectId);
      if (typeof scoped.dispatchRunDetail !== "function") return;
      detailInFlight.current.add(runId);
      setDetailLoading(runId);
      setDetailError((current) => {
        const copy = { ...current };
        delete copy[runId];
        return copy;
      });
      try {
        const detail = await scoped.dispatchRunDetail(runId);
        setDetails((current) => ({ ...current, [runId]: detail }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setDetailError((current) => ({ ...current, [runId]: message }));
      } finally {
        detailInFlight.current.delete(runId);
        setDetailLoading((current) => (current === runId ? null : current));
      }
    },
    [factory, projectId],
  );

  const toggleDetail = async (runId: string) => {
    const next = !detailExpanded[runId];
    setDetailExpanded((current) => ({ ...current, [runId]: next }));
    if (next && !details[runId]) await loadDetail(runId);
  };

  // Load the selected run's durable budget/control state before the operator opens
  // the panel, so Dispatch is never falsely enabled for exhausted or held work.
  useEffect(() => {
    if (!projectId) return;
    const grouped = runsByPlan(runs);
    for (const plan of plans) {
      if (plan.authority !== "admitted") continue;
      const planRuns = grouped.get(plan.id) ?? [];
      const selected = selectedRuns[plan.id] ?? planRuns[0]?.id;
      if (!selected) continue;
      if (details[selected] || detailError[selected]) continue;
      if (detailInFlight.current.has(selected)) continue;
      void loadDetail(selected);
    }
  }, [projectId, plans, runs, selectedRuns, details, detailError, loadDetail]);

  const runControl = async (runId: string, action: "hold" | "resume" | "stop" | "takeover") => {
    setControlBusy(runId);
    setControlNotice((current) => {
      const copy = { ...current };
      delete copy[runId];
      return copy;
    });
    setError(null);
    try {
      const result = await factory.forProject(projectId).controlDispatchRun(runId, {
        action,
        actor: "operator",
        reason: `operator ${action}`,
      });
      setControlNotice((current) => ({
        ...current,
        [runId]: `${action}: ${result.control.status} (${result.detail})`,
      }));
      await loadProject(projectId);
      await loadDetail(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setControlBusy(null);
    }
  };

  const grantAttempt = async (runId: string) => {
    const amount = Number(grantAmount[runId] ?? "1");
    const reason = (grantReason[runId] ?? "").trim();
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setError("Grant amount must be a positive integer");
      return;
    }
    if (!reason) {
      setError("A budget grant requires a reason");
      return;
    }
    // One stable key per submission: a retry after an ambiguous response replays the
    // same grant instead of adding allowance twice.
    const idempotencyKey = grantKeys.current[runId] ?? createGrantIdempotencyKey();
    grantKeys.current[runId] = idempotencyKey;
    setControlBusy(runId);
    setControlNotice((current) => {
      const copy = { ...current };
      delete copy[runId];
      return copy;
    });
    setError(null);
    try {
      const result = await factory.forProject(projectId).grantDispatchBudget(runId, {
        amount,
        reason,
        actor: "operator",
        idempotency_key: idempotencyKey,
      });
      delete grantKeys.current[runId];
      setControlNotice((current) => ({
        ...current,
        [runId]: `grant +${result.grant.amount}${result.replayed ? " (replayed)" : ""} · ${result.budget.status}`,
      }));
      setGrantReason((current) => ({ ...current, [runId]: "" }));
      await loadProject(projectId);
      await loadDetail(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setControlBusy(null);
    }
  };

  const toggleFinal = async (planId: string) => {
    const next = !finalExpanded[planId];
    setFinalExpanded((current) => ({ ...current, [planId]: next }));
    if (!next || finalStatus[planId] || finalLoading === planId) return;
    setFinalLoading(planId);
    setFinalError((current) => {
      const copy = { ...current };
      delete copy[planId];
      return copy;
    });
    try {
      const status = await factory.forProject(projectId).finalDelivery(planId);
      setFinalStatus((current) => ({ ...current, [planId]: status }));
    } catch (err) {
      setFinalError((current) => ({
        ...current,
        [planId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setFinalLoading(null);
    }
  };

  const advanceFinal = async (planId: string) => {
    setFinalBusy(planId);
    setFinalError((current) => {
      const copy = { ...current };
      delete copy[planId];
      return copy;
    });
    try {
      const status = await factory
        .forProject(projectId)
        .advanceFinalDelivery(planId, { actor: "operator" });
      setFinalStatus((current) => ({ ...current, [planId]: status }));
    } catch (err) {
      setFinalError((current) => ({
        ...current,
        [planId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setFinalBusy(null);
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
            const selectedDetail = run ? details[run.id] : undefined;
            const blockedByBudget = selectedDetail?.budget?.status === "exhausted";
            const blockedByControl =
              selectedDetail?.control !== null &&
              selectedDetail?.control !== undefined &&
              selectedDetail.control.status !== "active";
            // An unknown budget/control state is not proof of eligibility: fail closed
            // until the selected run's durable detail is available.
            const detailUnknown = Boolean(run) && !selectedDetail;
            const dispatchDisabled =
              busy || plan.hold_count > 0 || blockedByBudget || blockedByControl || detailUnknown;
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
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-expanded={Boolean(auditExpanded[run.id])}
                      aria-controls={`run-audit-${run.id}`}
                      onClick={() => void toggleAudit(run.id)}
                    >
                      {auditExpanded[run.id] ? "Hide audit" : "View audit"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-expanded={Boolean(gateExpanded[run.id])}
                      aria-controls={`run-gate-${run.id}`}
                      onClick={() => void toggleGate(run.id)}
                    >
                      {gateExpanded[run.id] ? "Hide gate" : "Delivery gate"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-expanded={Boolean(detailExpanded[run.id])}
                      aria-controls={`run-budget-${run.id}`}
                      onClick={() => void toggleDetail(run.id)}
                    >
                      {detailExpanded[run.id] ? "Hide budget" : "Budget & controls"}
                    </Button>
                    {run.gate_profile === "child" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11 sm:min-h-8"
                        aria-expanded={Boolean(integrationExpanded[run.id])}
                        aria-controls={`run-integration-${run.id}`}
                        onClick={() => void toggleIntegration(run.id)}
                      >
                        {integrationExpanded[run.id] ? "Hide integration" : "Integration"}
                      </Button>
                    )}
                    {details[run.id]?.budget?.status === "exhausted" && (
                      <Badge variant="error">Needs owner</Badge>
                    )}
                  </>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => void dispatch(plan.id)}
                  disabled={dispatchDisabled}
                  title={
                    detailUnknown
                      ? detailError[run?.id ?? ""]
                        ? "Attempt budget and control detail is unavailable; refresh before dispatching"
                        : "Checking attempt budget and operator controls…"
                      : blockedByBudget
                        ? "Ticket budget is exhausted; grant an explicit additional attempt"
                        : blockedByControl
                          ? "Work is held or stopping; resume it before dispatching"
                          : plan.hold_count > 0
                            ? "Plan has holds; resolve them before dispatching"
                            : "Dispatch this frozen plan"
                  }
                >
                  {busy ? "Dispatching…" : "Dispatch"}
                </Button>
                {plan.kind === "spec" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-8"
                    aria-expanded={Boolean(finalExpanded[plan.id])}
                    aria-controls={`plan-final-${plan.id}`}
                    onClick={() => void toggleFinal(plan.id)}
                  >
                    {finalExpanded[plan.id] ? "Hide final" : "Final delivery"}
                  </Button>
                )}
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
                {run && auditExpanded[run.id] && (
                  <div
                    id={`run-audit-${run.id}`}
                    data-testid={`run-audit-${run.id}`}
                    className="w-full"
                  >
                    {auditLoading === run.id ? (
                      <p role="status" className="text-xs text-text-secondary">
                        Loading publication audit…
                      </p>
                    ) : auditError[run.id] ? (
                      <p role="alert" className="text-xs text-[var(--destructive)]">
                        Publication audit unavailable: {auditError[run.id]}
                      </p>
                    ) : audit[run.id] ? (
                      <PublicationAuditPanel
                        status={audit[run.id]!}
                        publishing={publishing === run.id}
                        onRetry={() => void publishAudit(run.id)}
                      />
                    ) : null}
                  </div>
                )}
                {run && gateExpanded[run.id] && (
                  <div
                    id={`run-gate-${run.id}`}
                    data-testid={`run-gate-${run.id}`}
                    className="w-full"
                  >
                    {gateLoading === run.id ? (
                      <p role="status" className="text-xs text-text-secondary">
                        Loading delivery gate…
                      </p>
                    ) : gateError[run.id] ? (
                      <p role="alert" className="text-xs text-[var(--destructive)]">
                        Delivery gate unavailable: {gateError[run.id]}
                      </p>
                    ) : gates[run.id] ? (
                      <DeliveryGatePanel
                        status={gates[run.id]!}
                        verifying={gateBusy === run.id}
                        onVerify={() => void verifyMerge(run.id)}
                      />
                    ) : null}
                  </div>
                )}
                {run && detailExpanded[run.id] && (
                  <div
                    id={`run-budget-${run.id}`}
                    data-testid={`run-budget-${run.id}`}
                    className="w-full"
                  >
                    {detailLoading === run.id ? (
                      <p role="status" className="text-xs text-text-secondary">
                        Loading attempt budget and process state…
                      </p>
                    ) : detailError[run.id] ? (
                      <p role="alert" className="text-xs text-[var(--destructive)]">
                        Budget unavailable: {detailError[run.id]}
                      </p>
                    ) : details[run.id] ? (
                      <RunBudgetPanel
                        detail={details[run.id]!}
                        busy={controlBusy === run.id}
                        notice={controlNotice[run.id] ?? null}
                        amount={grantAmount[run.id] ?? "1"}
                        reason={grantReason[run.id] ?? ""}
                        onAmount={(value) => {
                          delete grantKeys.current[run.id];
                          setGrantAmount((current) => ({ ...current, [run.id]: value }));
                        }}
                        onReason={(value) => {
                          delete grantKeys.current[run.id];
                          setGrantReason((current) => ({ ...current, [run.id]: value }));
                        }}
                        onControl={(action) => void runControl(run.id, action)}
                        onGrant={() => void grantAttempt(run.id)}
                      />
                    ) : null}
                  </div>
                )}
                {run && run.gate_profile === "child" && integrationExpanded[run.id] && (
                  <div
                    id={`run-integration-${run.id}`}
                    data-testid={`run-integration-${run.id}`}
                    className="w-full"
                  >
                    {integrationLoading === run.id ? (
                      <p role="status" className="text-xs text-text-secondary">
                        Loading child integration status…
                      </p>
                    ) : integrationError[run.id] ? (
                      <p role="alert" className="text-xs text-[var(--destructive)]">
                        Integration unavailable: {integrationError[run.id]}
                      </p>
                    ) : integration[run.id] ? (
                      <ChildIntegrationPanel
                        status={integration[run.id]!}
                        landing={landing === run.id}
                        notice={controlNotice[run.id] ?? null}
                        onLand={() => void landChild(run.id)}
                      />
                    ) : null}
                  </div>
                )}
                {plan.kind === "spec" && finalExpanded[plan.id] && (
                  <div
                    id={`plan-final-${plan.id}`}
                    data-testid={`plan-final-${plan.id}`}
                    className="w-full"
                  >
                    {finalLoading === plan.id ? (
                      <p role="status" className="text-xs text-text-secondary">
                        Loading final delivery progress…
                      </p>
                    ) : finalError[plan.id] ? (
                      <p role="alert" className="text-xs text-[var(--destructive)]">
                        Final delivery unavailable: {finalError[plan.id]}
                      </p>
                    ) : finalStatus[plan.id] ? (
                      <FinalDeliveryPanel
                        status={finalStatus[plan.id]!}
                        busy={finalBusy === plan.id}
                        onAdvance={() => void advanceFinal(plan.id)}
                      />
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

/** Selected-run publication state: active PR, queued/failed intents and audit history. */
function PublicationAuditPanel({
  status,
  publishing,
  onRetry,
}: {
  status: PublicationStatus;
  publishing: boolean;
  onRetry: () => void;
}) {
  const { target } = status;
  const active = status.pullRequests.find((pr) => pr.active);
  const pending = status.intents.filter((intent) => intent.state !== "accepted");
  const abandonedCount = status.intents.filter((intent) => intent.state === "abandoned").length;
  return (
    <section
      aria-label="Publication audit and outgoing intents"
      className="mt-2 min-w-0 space-y-2 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-background/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-foreground">Publication audit</h3>
        <Badge variant={status.auditComplete ? "success" : "warning"}>
          {status.auditComplete ? "Audit published" : "Audit incomplete"}
        </Badge>
        <Badge
          variant={target.state === "failed" || target.state === "unknown" ? "error" : "default"}
        >
          {target.state}
        </Badge>
        {active ? (
          <a
            href={active.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="break-all text-[11px] text-accent underline"
          >
            PR #{active.number} ({active.draft ? "draft" : "ready"})
          </a>
        ) : (
          <span className="text-[11px] text-text-secondary">No PR yet</span>
        )}
        {!status.auditComplete && (
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={onRetry}
            disabled={publishing}
          >
            {publishing ? "Retrying…" : "Retry publication"}
          </Button>
        )}
      </div>

      <p className="break-all font-mono text-[10px] text-text-secondary">
        source {target.sourceBranch} → {target.targetBranch} · candidate {target.candidateHeadSha}
      </p>

      {target.state === "no_candidate" ? (
        <p data-testid="publication-no-candidate" className="text-[11px] text-text-secondary">
          No committed candidate change; no draft PR was created and audit events stay queued.
        </p>
      ) : null}

      <p className="text-[11px] text-text-secondary">
        {status.publishedEventCount} published · {status.queuedEventCount} queued ·{" "}
        {status.failedIntentCount} failed · {status.unknownIntentCount} unknown
        {abandonedCount > 0 ? ` · ${abandonedCount} abandoned` : ""}
      </p>
      {status.remoteStale && (
        <p role="alert" className="text-[11px] text-[var(--warning)]">
          The remote PR head/base no longer matches this candidate; evidence is stale.
        </p>
      )}
      {target.lastError && (
        <p className="break-words text-[11px] text-[var(--destructive)]">{target.lastError}</p>
      )}

      {pending.length > 0 && (
        <ul aria-label="Outgoing publication intents" className="min-w-0 space-y-0.5">
          {pending.map((intent) => (
            <li key={intent.id} className="break-all font-mono text-[10px] text-text-secondary">
              {intent.kind} · {intent.state} · attempts {intent.attempts} · {intent.operationKey}
              {intent.lastError ? ` — ${intent.lastError}` : ""}
            </li>
          ))}
        </ul>
      )}

      {status.events.length > 0 && (
        <ul aria-label="Publication audit history" className="min-w-0 space-y-0.5">
          {status.events.map((event) => {
            const intent = status.intents.find((item) => item.operationKey === `event:${event.id}`);
            return (
              <li
                key={event.id}
                data-testid={`publication-event-${event.id}`}
                className="break-words text-[10px] text-text-secondary"
              >
                {event.sequence}. {event.kind} · {event.severity} · lap {event.lap ?? "-"} ·{" "}
                {event.candidateHeadSha.slice(0, 8)} · {intent?.state ?? "queued"} · {event.title}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

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

const DELIVERY_GATE_TONE: Record<
  DeliveryGateStatus["state"],
  "default" | "success" | "warning" | "error" | "accent"
> = {
  blocked: "warning",
  correction_required: "error",
  awaiting_publication: "warning",
  ready_for_operator_review: "accent",
  awaiting_manual_merge: "accent",
  awaiting_merge_verification: "warning",
  closed_unmerged: "error",
  invalidated: "error",
  remote_unavailable: "error",
  delivered: "success",
};

const DELIVERY_STAGE_TONE: Record<
  DeliveryGateStatus["stages"][number]["status"],
  "default" | "success" | "warning" | "error" | "accent"
> = {
  passed: "success",
  failed: "error",
  inconclusive: "warning",
  running: "accent",
  missing: "warning",
  stale: "error",
  not_applicable: "default",
};

/** Full-delivery gate plus verified remote merge state for standalone tickets. */
function DeliveryGatePanel({
  status,
  verifying,
  onVerify,
}: {
  status: DeliveryGateStatus;
  verifying: boolean;
  onVerify: () => void;
}) {
  const canVerify =
    status.merge.state === "unverified" || status.state === "awaiting_merge_verification";
  return (
    <section
      aria-label="Full delivery gate and merge verification"
      className="mt-2 min-w-0 space-y-2 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-background/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-foreground">Delivery gate</h3>
        <Badge variant={DELIVERY_GATE_TONE[status.state]}>{status.state}</Badge>
        <Badge variant={status.manualMergeRequired ? "warning" : "default"}>
          merge {status.mergePolicy}
        </Badge>
        <span className="break-all font-mono text-[10px] text-text-secondary">
          {status.gateProfile} v{status.gateProfileVersion} · {status.sourceBranch} →{" "}
          {status.targetBranch} · candidate {status.candidateHeadSha ?? "none"}
        </span>
      </div>

      <p className="break-all font-mono text-[10px] text-text-secondary">
        publication {status.publication.state ?? "none"} · audit{" "}
        {status.publication.auditComplete ? "complete" : "incomplete"}
        {status.publication.prNumber
          ? ` · PR #${status.publication.prNumber} ${status.publication.remoteState ?? "unknown"}${status.publication.draft ? " draft" : ""}`
          : " · no PR"}
      </p>
      <p className="break-all font-mono text-[10px] text-text-secondary">
        merge {status.merge.state}
        {status.merge.verification ? ` · verified ${status.merge.verification.verifiedAt}` : ""}
        {status.merge.remoteTargetTipSha ? ` · target-tip ${status.merge.remoteTargetTipSha}` : ""}
      </p>
      {status.merge.detail && (
        <p className="text-[11px] text-text-secondary">{status.merge.detail}</p>
      )}

      {status.state === "ready_for_operator_review" || status.state === "awaiting_manual_merge" ? (
        <p className="text-[11px] text-text-secondary">
          Operator review required: merge PR #{status.publication.prNumber ?? "?"} manually in
          GitHub. This gate never merges to the delivery branch.
        </p>
      ) : null}

      {canVerify && (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-8"
          disabled={verifying}
          onClick={onVerify}
        >
          {verifying ? "Verifying…" : "Verify merge"}
        </Button>
      )}

      {status.reasons.length > 0 && (
        <ul
          aria-label="Delivery gate blockers"
          className="list-disc pl-5 text-[11px] text-[var(--error)]"
        >
          {status.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <ul aria-label="Delivery gate stages" className="min-w-0 space-y-1">
        {status.stages.map((stage) => (
          <li
            key={stage.name}
            data-testid={`delivery-stage-${stage.name}`}
            className="flex min-w-0 flex-wrap items-center gap-2"
          >
            <Badge variant={DELIVERY_STAGE_TONE[stage.status]}>{stage.status}</Badge>
            <span className="text-[11px] text-foreground">{stage.name}</span>
            <span className="break-all text-[10px] text-text-secondary">{stage.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const CONTROL_ACTIONS = ["hold", "resume", "stop", "takeover"] as const;

/** Durable attempt budget, grant history, retained workspace and process state. */
function RunBudgetPanel({
  detail,
  busy,
  notice,
  amount,
  reason,
  onAmount,
  onReason,
  onControl,
  onGrant,
}: {
  detail: DispatchRunDetail;
  busy: boolean;
  notice: string | null;
  amount: string;
  reason: string;
  onAmount: (value: string) => void;
  onReason: (value: string) => void;
  onControl: (action: (typeof CONTROL_ACTIONS)[number]) => void;
  onGrant: () => void;
}) {
  const { run, budget, control, grants, attempts, process, acceptanceCriteria, openFindings } =
    detail;
  return (
    <section
      aria-label="Attempt budget and operator controls"
      className="mt-2 min-w-0 space-y-2 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-background/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-foreground">Attempt budget</h3>
        {budget ? (
          <Badge variant={budget.status === "exhausted" ? "error" : "success"}>
            {budget.status === "exhausted" ? "Needs owner" : "Active"}
          </Badge>
        ) : (
          <Badge variant="default">Not allocated</Badge>
        )}
        <span className="break-all font-mono text-[10px] text-text-secondary">
          #{run.issue_number} lap {run.lap} ·{" "}
          {budget
            ? `${budget.consumedAttempts}/${budget.allowedAttempts} used · ${budget.remainingAttempts} remaining`
            : "no budget"}
        </span>
      </div>

      {budget?.status === "exhausted" && (
        <p role="alert" className="text-[11px] text-[var(--error)]">
          Needs owner: {budget.lastRejection ?? "budget exhausted"}. Grant an explicit additional
          attempt before dispatching again.
        </p>
      )}

      {budget && (
        <ul aria-label="Budget details" className="space-y-0.5 text-[11px] text-text-secondary">
          <li>
            base {budget.baseLimit} · granted {budget.grantedAttempts} · consumed{" "}
            {budget.consumedAttempts}
          </li>
          {budget.retainedWorktreePath && (
            <li className="break-all">
              retained worktree {budget.retainedWorktreePath} · branch {budget.retainedBranch}
            </li>
          )}
          {control && (
            <li>
              control {control.status}
              {control.reason ? ` · ${control.reason}` : ""}
            </li>
          )}
          <li>
            process owner {process.ownerPid ?? "none"} {process.ownerAlive ? "alive" : "dead"} ·
            worker {process.workerPid ?? "none"} {process.workerAlive ? "alive" : "dead"} · lock{" "}
            {process.worktreeLockPid ?? "none"} {process.worktreeLockAlive ? "alive" : "dead"}
          </li>
        </ul>
      )}

      <div role="group" aria-label="Run controls" className="flex flex-wrap gap-2">
        {CONTROL_ACTIONS.map((action) => (
          <Button
            key={action}
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={busy}
            onClick={() => onControl(action)}
          >
            {action[0]!.toUpperCase() + action.slice(1)}
          </Button>
        ))}
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onGrant();
        }}
      >
        <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
          <span>Attempts</span>
          <input
            aria-label="Additional attempts"
            type="number"
            min={1}
            step={1}
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
            className="h-11 w-20 rounded-full border border-[var(--border)] bg-background px-3 text-xs text-foreground sm:h-8"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-text-secondary">
          <span>Grant reason</span>
          <input
            aria-label="Grant reason"
            type="text"
            value={reason}
            onChange={(event) => onReason(event.target.value)}
            placeholder="Why the operator allows another attempt"
            className="h-11 min-w-0 rounded-full border border-[var(--border)] bg-background px-3 text-xs text-foreground sm:h-8"
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="min-h-11 sm:min-h-8"
          disabled={busy}
        >
          {busy ? "Applying…" : "Grant attempt"}
        </Button>
      </form>

      {notice && (
        <p role="status" className="text-[11px] text-text-secondary">
          {notice}
        </p>
      )}

      {attempts.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-foreground">Prior attempts</h4>
          <ol aria-label="Prior attempts" className="mt-1 space-y-0.5">
            {attempts.map((attempt) => (
              <li key={attempt.runId} className="break-all text-[10px] text-text-secondary">
                lap {attempt.lap} · {attempt.state} · #{attempt.issueNumber} · gen{" "}
                {attempt.ownershipGeneration} · head {attempt.headSha ?? "none"}
                {attempt.error ? ` · ${attempt.error}` : ""}
              </li>
            ))}
          </ol>
        </div>
      )}

      {acceptanceCriteria.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-foreground">
            Unresolved acceptance criteria
          </h4>
          <ul aria-label="Acceptance criteria" className="mt-1 space-y-0.5">
            {acceptanceCriteria.map((criterion) => (
              <li key={criterion.acKey} className="break-all text-[10px] text-text-secondary">
                {criterion.acKey}
                {criterion.openFindingIds.length > 0
                  ? ` · open findings ${criterion.openFindingIds.length}`
                  : ""}{" "}
                · {criterion.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {openFindings.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-foreground">Open findings</h4>
          <ul aria-label="Open findings" className="mt-1 space-y-0.5">
            {openFindings.map((finding) => (
              <li key={finding.id} className="break-all text-[10px] text-text-secondary">
                {finding.severity} · {finding.acKey ?? "no AC"} · {finding.summary}
              </li>
            ))}
          </ul>
        </div>
      )}

      {grants.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-foreground">Grant history</h4>
          <ul aria-label="Grant history" className="mt-1 space-y-0.5">
            {grants.map((grant) => (
              <li key={grant.id} className="break-all text-[10px] text-text-secondary">
                +{grant.amount} by {grant.actor} · {grant.reason} · {grant.idempotencyKey}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const INTEGRATION_TONE: Record<
  IntegrationStatus["state"],
  "default" | "success" | "warning" | "error" | "accent"
> = {
  not_ready: "default",
  blocked: "error",
  ready: "accent",
  integrating: "accent",
  integrated: "success",
  unknown: "warning",
};

function ChildIntegrationPanel({
  status,
  landing,
  notice,
  onLand,
}: {
  status: IntegrationStatus;
  landing: boolean;
  notice: string | null;
  onLand: () => void;
}) {
  const active = status.publication?.pullRequests.find((pr) => pr.active) ?? null;
  const canLand = status.state === "ready" || status.state === "blocked";
  const blockers = status.blockers;
  const checks = status.requiredChecks;
  const integration = status.integration;
  const acceptanceReasons = status.acceptance.authorized ? [] : status.acceptance.reasons;
  return (
    <section
      aria-label="Child integration"
      data-testid="child-integration"
      className="mt-2 space-y-2 rounded-[10px] border border-[var(--border-subtle)] p-3"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
          Integration to {status.targetBranch}
        </h4>
        <Badge variant={INTEGRATION_TONE[status.state]}>{status.state}</Badge>
        <span className="text-[10px] text-text-secondary">merge policy: {status.mergePolicy}</span>
        <span className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          className="min-h-11 sm:min-h-8"
          onClick={onLand}
          disabled={landing || !canLand}
          title={
            status.state === "integrated"
              ? "Candidate is already verified on the integration branch"
              : status.state === "not_ready"
                ? "The child must finish successfully before integration"
                : "Merge the verified child pull request into the integration branch"
          }
        >
          {landing ? "Merging…" : "Merge to integration"}
        </Button>
      </header>

      {notice && (
        <p role="status" className="text-[10px] text-text-secondary">
          {notice}
        </p>
      )}

      <p className="break-all text-[10px] text-text-secondary">
        Candidate {status.acceptance.candidateHeadSha?.slice(0, 12) ?? "none"} · target tip{" "}
        {status.acceptance.targetTipSha?.slice(0, 12) ?? "unresolved"} · evidence{" "}
        {status.acceptance.authorized ? "authorized" : "blocked"}
      </p>

      {acceptanceReasons.length > 0 && (
        <div>
          <h5 className="text-[11px] font-medium text-foreground">Acceptance reasons</h5>
          <ul aria-label="Acceptance reasons" className="mt-1 space-y-0.5">
            {acceptanceReasons.map((reason) => (
              <li key={reason} className="break-all text-[10px] text-text-secondary">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {blockers.length > 0 && (
        <div>
          <h5 className="text-[11px] font-medium text-foreground">Integration blockers</h5>
          <ul aria-label="Integration blockers" className="mt-1 space-y-0.5">
            {blockers.map((blocker) => (
              <li
                key={`${blocker.code}:${blocker.message}`}
                className="break-all text-[10px] text-text-secondary"
              >
                <span className="font-mono">{blocker.code}</span> · {blocker.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {checks.length > 0 && (
        <div>
          <h5 className="text-[11px] font-medium text-foreground">Required remote checks</h5>
          <ul aria-label="Required remote checks" className="mt-1 space-y-0.5">
            {checks.map((check) => (
              <li key={check.name} className="break-all text-[10px] text-text-secondary">
                {check.name} · {check.status}
                {check.conclusion ? `/${check.conclusion}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h5 className="text-[11px] font-medium text-foreground">Child pull request</h5>
        <p className="break-all text-[10px] text-text-secondary">
          {active
            ? `#${active.number ?? "?"} ${active.url ?? ""} (${active.state}${active.draft ? ", draft" : ""})`
            : "No active pull request"}
        </p>
      </div>

      {integration && (
        <div>
          <h5 className="text-[11px] font-medium text-foreground">Verified integration</h5>
          <p className="break-all text-[10px] text-text-secondary">
            merge {integration.mergeSha.slice(0, 12)} ·{" "}
            {integration.targetTipBeforeSha.slice(0, 12)} →{" "}
            {integration.targetTipAfterSha.slice(0, 12)} · evidence {integration.evidenceIdentity}
          </p>
        </div>
      )}

      {status.events.length > 0 && (
        <div>
          <h5 className="text-[11px] font-medium text-foreground">Integration attempts</h5>
          <ul aria-label="Integration attempts" className="mt-1 space-y-0.5">
            {status.events.map((event) => (
              <li key={event.id} className="break-all text-[10px] text-text-secondary">
                {event.kind} · {event.reasons.join("; ") || "no reasons"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const FINAL_DELIVERY_TONE: Record<
  FinalDeliveryStatus["state"],
  "default" | "success" | "warning" | "error" | "accent"
> = {
  waiting_children: "warning",
  blocked: "error",
  verifying: "accent",
  needs_owner: "error",
  awaiting_manual_merge: "warning",
  awaiting_merge_verification: "accent",
  remote_unavailable: "warning",
  delivered: "success",
};

/** Manifest-bound final-spec progress, combined candidate, gates and manual merge. */
function FinalDeliveryPanel({
  status,
  busy,
  onAdvance,
}: {
  status: FinalDeliveryStatus;
  busy: boolean;
  onAdvance: () => void;
}) {
  const manualReady =
    status.state === "awaiting_manual_merge" || status.state === "awaiting_merge_verification";
  return (
    <section
      aria-label="Final delivery"
      data-testid="final-delivery"
      className="mt-2 min-w-0 space-y-2 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-background/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-foreground">Final delivery</h3>
        <Badge variant={FINAL_DELIVERY_TONE[status.state]}>{status.state}</Badge>
        <Badge variant={status.delivered ? "success" : "default"}>
          {status.delivered ? "delivered" : "not delivered"}
        </Badge>
        <span className="text-[10px] text-text-secondary">
          {status.integratedCount}/{status.requiredCount} children integrated
        </span>
        <span className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          className="min-h-11 sm:min-h-8"
          onClick={onAdvance}
          disabled={busy || status.delivered}
          title={
            status.delivered
              ? "The verified final merge is already recorded"
              : "Run final validation, bounded repair and publication for the combined candidate"
          }
        >
          {busy ? "Advancing…" : "Advance final"}
        </Button>
      </div>

      <p className="break-all font-mono text-[10px] text-text-secondary">
        {status.integrationBranch} → {status.deliveryBranch} · candidate{" "}
        {status.candidateHeadSha ?? "none"} · tested target {status.targetTipSha ?? "unresolved"}
      </p>

      {status.pullRequest && (
        <p className="break-all font-mono text-[10px] text-text-secondary">
          PR #{status.pullRequest.number} {status.pullRequest.url ? status.pullRequest.url : ""} ·{" "}
          {status.pullRequest.state}
          {status.pullRequest.draft ? " draft" : ""} · {status.pullRequest.headBranch} →{" "}
          {status.pullRequest.baseBranch}
        </p>
      )}

      {status.merge && (
        <p className="break-all font-mono text-[10px] text-text-secondary">
          merge {status.merge.state}
          {status.merge.verified ? " · verified" : ""}
          {status.merge.remoteTargetTipSha
            ? ` · target-tip ${status.merge.remoteTargetTipSha}`
            : ""}
        </p>
      )}

      {status.budget && (
        <p className="text-[10px] text-text-secondary">
          Final budget {status.budget.consumedAttempts}/{status.budget.allowedAttempts} attempts ·{" "}
          {status.budget.status}
          {status.grants.length > 0 ? ` · ${status.grants.length} grant(s)` : ""}
        </p>
      )}

      {status.reasons.length > 0 && (
        <ul
          aria-label="Final delivery reasons"
          className="list-disc pl-5 text-[11px] text-[var(--error)]"
        >
          {status.reasons.map((reason) => (
            <li key={reason} className="break-all">
              {reason}
            </li>
          ))}
        </ul>
      )}

      {status.haltReason && (
        <p className="break-all text-[11px] text-[var(--destructive)]">
          Needs owner: {status.haltReason}
        </p>
      )}

      {manualReady && (
        <p className="text-[11px] text-text-secondary">
          Operator merge required: merge the final PR manually in GitHub. Final delivery remains
          unverified until the configured delivery branch is read back.
        </p>
      )}

      <div>
        <h4 className="text-[11px] font-medium text-foreground">Required children</h4>
        <ul aria-label="Final delivery children" className="mt-1 space-y-0.5">
          {status.children.map((child) => (
            <li
              key={child.workId}
              data-testid={`final-child-${child.issueNumber}`}
              className="break-all text-[10px] text-text-secondary"
            >
              #{child.issueNumber} · {child.integrated ? "integrated" : "pending"}
              {child.candidateHeadSha ? ` · ${child.candidateHeadSha.slice(0, 8)}` : ""}
              {child.mergeSha ? ` → ${child.mergeSha.slice(0, 8)}` : ""}
              {child.pullRequestNumber ? ` · PR #${child.pullRequestNumber}` : ""}
              {child.reasons.length > 0 ? ` · ${child.reasons.join(", ")}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
