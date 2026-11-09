import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { OperatorWorkDetail } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  ChildIntegrationPanel,
  DeliveryGatePanel,
  FinalDeliveryPanel,
  RunBudgetPanel,
  RunEvidencePanel,
  createGrantIdempotencyKey,
} from "@/features/dispatch/dispatch-control";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; detail: OperatorWorkDetail };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-2 border-t border-[var(--border-subtle)] pt-3">
      <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Coherent parent/ticket detail over the canonical projection. It reuses the
 * existing dispatch, evidence, gate, integration and final-delivery panels, so
 * operator controls remain the same canonical commands.
 */
export function WorkDetailDialog({
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
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => createGrantIdempotencyKey());

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

  const runAction = async (label: string, operation: () => Promise<void>) => {
    setBusy(label);
    setActionError(null);
    setNotice(null);
    try {
      await operation();
      await load();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusy(null);
    }
  };

  const detail = state.phase === "ready" ? state.detail : null;
  const runId = detail?.latestRun?.run.id ?? null;

  const control = (action: "hold" | "resume" | "stop" | "takeover") => {
    if (!runId) return;
    void runAction(`control:${action}`, async () => {
      const result = await factory.forProject(projectId).controlDispatchRun(runId, {
        action,
        actor: "operator",
        reason: `operator ${action}`,
      });
      setNotice(`${action}: ${result.control.status} (${result.detail})`);
    });
  };

  const grant = () => {
    if (!runId) return;
    const parsed = Number(amount);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      setActionError("Grant amount must be a positive integer");
      return;
    }
    if (!reason.trim()) {
      setActionError("A budget grant requires a reason");
      return;
    }
    void runAction("grant", async () => {
      const result = await factory.forProject(projectId).grantDispatchBudget(runId, {
        amount: parsed,
        reason: reason.trim(),
        actor: "operator",
        idempotency_key: idempotencyKey,
      });
      setIdempotencyKey(createGrantIdempotencyKey());
      setReason("");
      setNotice(
        `grant +${result.grant.amount}${result.replayed ? " (replayed)" : ""} · ${result.budget.status}`,
      );
    });
  };

  const verify = () => {
    if (!runId) return;
    void runAction("verify", async () => {
      const status = await factory.forProject(projectId).verifyDeliveryMerge(runId, "operator");
      setNotice(`merge ${status.merge.state}`);
    });
  };

  const land = () => {
    if (!runId) return;
    void runAction("land", async () => {
      const status = await factory.forProject(projectId).landChild(runId, { actor: "operator" });
      setNotice(
        status.state === "integrated"
          ? `Integrated into ${status.targetBranch}.`
          : `Integration held: ${status.blockers.map((blocker) => blocker.code).join(", ")}`,
      );
    });
  };

  const advance = () => {
    if (!detail?.planId) return;
    void runAction("advance", async () => {
      const status = await factory
        .forProject(projectId)
        .advanceFinalDelivery(detail.planId!, { actor: "operator" });
      setNotice(`final ${status.state} · ${status.integratedCount}/${status.requiredCount}`);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        data-testid="work-detail-dialog"
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[920px] grid-rows-none flex-col gap-3 overflow-hidden p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-center gap-2 pr-10">
          {detail ? (
            <>
              <DialogTitle className="min-w-0 break-words text-lg">
                <span className="font-mono text-[13px] text-text-secondary">
                  {detail.work.issue_number ? `#${detail.work.issue_number}` : ""}
                </span>{" "}
                {detail.contract.title}
              </DialogTitle>
              <Badge variant="outline">{detail.kind}</Badge>
              <Badge
                variant={
                  detail.lane === "failed" || detail.lane === "needs-owner" ? "error" : "default"
                }
              >
                {detail.stageLabel}
              </Badge>
              {detail.parent && (
                <span className="text-[11px] text-text-secondary">
                  Part of #{detail.parent.issueNumber}
                </span>
              )}
            </>
          ) : (
            <DialogTitle className="text-lg">Work detail</DialogTitle>
          )}
          <span className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={() => void load()}
            disabled={state.phase === "loading"}
          >
            <RefreshCw
              className={state.phase === "loading" ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
            />
            <span>Refresh</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Close work detail"
            className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </Button>
        </div>
        <DialogDescription className="text-[11px] text-text-secondary">
          Canonical factory state for this work item. Parent delivery is only complete after a
          verified merge into the delivery branch; child integration is separate.
        </DialogDescription>

        {actionError && (
          <p role="alert" className="break-words text-[11px] text-[var(--error)]">
            {actionError}
          </p>
        )}
        {notice && (
          <p role="status" className="break-words text-[11px] text-text-secondary">
            {notice}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {state.phase === "loading" ? (
            <p
              role="status"
              data-testid="work-detail-loading"
              className="text-xs text-text-secondary"
            >
              Loading work detail from canonical factory state…
            </p>
          ) : state.phase === "error" ? (
            <p
              role="alert"
              data-testid="work-detail-error"
              className="break-words text-xs text-[var(--error)]"
            >
              Work detail unavailable: {state.message}
            </p>
          ) : detail ? (
            <div className="space-y-4">
              <Section title="Placement">
                <p className="break-words text-[11px] text-text-secondary">{detail.detail}</p>
                <ul aria-label="Placement precedence" className="space-y-0.5">
                  {detail.precedence.map((item) => (
                    <li
                      key={item}
                      className="break-words font-mono text-[10px] text-text-secondary"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
                {detail.specProgress && (
                  <p data-testid="work-spec-progress" className="text-[11px] text-foreground">
                    {detail.specProgress.integrated}/{detail.specProgress.required} tickets
                    integrated
                    {detail.specProgress.delivered ? " · delivered" : " · not delivered"}
                    {detail.specProgress.finalState
                      ? ` · final ${detail.specProgress.finalState}`
                      : ""}
                  </p>
                )}
              </Section>

              <Section title="Contract">
                <p className="break-words font-mono text-[10px] text-text-secondary">
                  revision {detail.contract.revisionNumber} · {detail.contract.state} · sha256{" "}
                  {detail.contract.contentHash}
                </p>
                <p className="break-all text-[10px] text-text-secondary">
                  {detail.contract.sourceUrl}
                </p>
                {detail.contract.labels.length > 0 && (
                  <p className="break-words text-[11px] text-text-secondary">
                    labels: {detail.contract.labels.join(", ")}
                  </p>
                )}
                <div
                  role="region"
                  tabIndex={0}
                  aria-label="Contract body"
                  className="max-h-48 overflow-y-auto rounded-[6px] text-[11px] leading-[1.5] text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                >
                  <p className="whitespace-pre-wrap break-words">{detail.contract.body}</p>
                </div>
              </Section>

              {detail.plan && (
                <Section title="Approved plan">
                  <p className="break-words font-mono text-[10px] text-text-secondary">
                    {detail.plan.kind} · {detail.plan.authority} · dispatchable{" "}
                    {detail.plan.dispatchable ? "yes" : "no"} · integration{" "}
                    {detail.plan.integration_branch ?? "none"} → delivery{" "}
                    {detail.plan.delivery_branch}
                    {detail.plan.accepted_revision
                      ? ` · accepted revision ${detail.plan.accepted_revision.revision_number}`
                      : ""}
                  </p>
                  {detail.plan.holds.length > 0 && (
                    <ul aria-label="Plan holds" className="space-y-0.5">
                      {detail.plan.holds.map((hold) => (
                        <li
                          key={`${hold.code}:${hold.detail}`}
                          className="break-words text-[10px] text-[var(--warning)]"
                        >
                          {hold.severity} · {hold.code} · {hold.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                  <h4 className="text-[11px] font-medium text-foreground">Acceptance criteria</h4>
                  {detail.plan.acceptance_criteria.length === 0 ? (
                    <p className="text-[10px] text-text-secondary">
                      No acceptance criteria recorded.
                    </p>
                  ) : (
                    <ul aria-label="Plan acceptance criteria" className="space-y-0.5">
                      {detail.plan.acceptance_criteria.map((criterion) => (
                        <li
                          key={criterion.id}
                          className="break-words text-[10px] text-text-secondary"
                        >
                          <span className="font-mono">{criterion.ac_key}</span> · {criterion.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  <h4 className="text-[11px] font-medium text-foreground">Dependencies</h4>
                  {detail.plan.dependencies.length === 0 ? (
                    <p className="text-[10px] text-text-secondary">No dependencies recorded.</p>
                  ) : (
                    <ul aria-label="Plan dependencies" className="space-y-0.5">
                      {detail.plan.dependencies.map((dependency) => (
                        <li
                          key={dependency.id}
                          className="break-words text-[10px] text-text-secondary"
                        >
                          #{dependency.target_issue_number} · {dependency.target_role} ·{" "}
                          {dependency.source}
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.plan.members.filter((member) => member.role === "ticket").length > 0 && (
                    <>
                      <h4 className="text-[11px] font-medium text-foreground">
                        Executable tickets
                      </h4>
                      <ul aria-label="Plan tickets" className="space-y-0.5">
                        {detail.plan.members
                          .filter((member) => member.role === "ticket")
                          .map((member) => (
                            <li
                              key={member.work_id}
                              className="break-words text-[10px] text-text-secondary"
                            >
                              #{member.issue_number} · {member.title} · {member.gate_profile}
                            </li>
                          ))}
                      </ul>
                    </>
                  )}
                </Section>
              )}

              {detail.final && (
                <Section title="Parent delivery">
                  <FinalDeliveryPanel
                    status={detail.final}
                    busy={busy === "advance"}
                    onAdvance={advance}
                  />
                </Section>
              )}

              <Section title="Runs and laps">
                {detail.runs.length === 0 ? (
                  <p data-testid="work-runs-empty" className="text-[11px] text-text-secondary">
                    No builder runs recorded for this work item.
                  </p>
                ) : (
                  <ul aria-label="Run history" className="space-y-0.5">
                    {detail.runs.map((run) => (
                      <li
                        key={run.id}
                        data-testid={`work-run-${run.id}`}
                        className="break-all text-[10px] text-text-secondary"
                      >
                        lap {run.lap} · {run.state} · {run.gate_profile} · candidate{" "}
                        {run.head_sha ?? "none"} · {run.branch}
                        {run.error ? ` · ${run.error}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {detail.retained && (
                  <p
                    data-testid="work-retained"
                    className="break-all text-[10px] text-text-secondary"
                  >
                    retained workspace {detail.retained.worktreePath} · branch{" "}
                    {detail.retained.branch} · head {detail.retained.headSha ?? "none"}
                  </p>
                )}
              </Section>

              {detail.process && (
                <Section title="Worker and usage">
                  <p
                    data-testid="work-process"
                    className="break-all text-[10px] text-text-secondary"
                  >
                    owner {detail.process.ownerPid ?? "none"} (
                    {detail.process.ownerAlive ? "alive" : "dead"}) · worker{" "}
                    {detail.process.workerPid ?? "none"} (
                    {detail.process.workerAlive ? "alive" : "dead"}) · lock{" "}
                    {detail.process.worktreeLockPid ?? "none"} (
                    {detail.process.worktreeLockAlive ? "alive" : "dead"})
                  </p>
                  <p
                    data-testid="work-usage"
                    className="break-words text-[10px] text-text-secondary"
                  >
                    {detail.usage.available
                      ? `tokens in ${detail.usage.tokensIn}, out ${detail.usage.tokensOut}, cache ${detail.usage.cacheReadTokens}, cost ${detail.usage.costMicros} micros`
                      : `Token and cost usage unavailable: ${detail.usage.detail}`}
                  </p>
                </Section>
              )}

              {detail.publication && (
                <Section title="Publication audit">
                  <p className="break-words font-mono text-[10px] text-text-secondary">
                    target {detail.publication.target.state} · audit{" "}
                    {detail.publication.auditComplete ? "complete" : "incomplete"} · queued{" "}
                    {detail.publication.queuedEventCount} · published{" "}
                    {detail.publication.publishedEventCount} · failed{" "}
                    {detail.publication.failedIntentCount} · unknown{" "}
                    {detail.publication.unknownIntentCount}
                    {detail.publication.remoteStale ? " · remote stale" : ""}
                  </p>
                  <ul aria-label="Publication pull requests" className="space-y-0.5">
                    {detail.publication.pullRequests.map((pr) => (
                      <li key={pr.id} className="break-all text-[10px] text-text-secondary">
                        PR #{pr.number ?? "?"} · {pr.state} · {pr.draft ? "draft" : "ready"} ·{" "}
                        {pr.url ?? "no url"}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {detail.latestRun && (
                <Section title="Operator controls">
                  <RunBudgetPanel
                    detail={detail.latestRun}
                    busy={busy !== null}
                    notice={null}
                    amount={amount}
                    reason={reason}
                    onAmount={(value) => {
                      setIdempotencyKey(createGrantIdempotencyKey());
                      setAmount(value);
                    }}
                    onReason={(value) => {
                      setIdempotencyKey(createGrantIdempotencyKey());
                      setReason(value);
                    }}
                    onControl={control}
                    onGrant={grant}
                  />
                </Section>
              )}

              {detail.gate && (
                <Section title="Delivery gate">
                  <DeliveryGatePanel
                    status={detail.gate}
                    verifying={busy === "verify"}
                    onVerify={verify}
                  />
                </Section>
              )}

              {detail.integration && (
                <Section title="Child integration">
                  <ChildIntegrationPanel
                    status={detail.integration}
                    landing={busy === "land"}
                    notice={null}
                    onLand={land}
                  />
                </Section>
              )}

              {detail.evidence && (
                <Section title="Checks, findings and evidence">
                  <RunEvidencePanel report={detail.evidence} />
                </Section>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
