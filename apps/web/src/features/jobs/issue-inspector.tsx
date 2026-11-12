import { useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Ellipsis,
  GitBranch,
  GitPullRequest,
  Layers,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Target,
  X,
} from "lucide-react";
import type { OperatorWorkDetail } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { mapHarnessMetrics } from "./jobs-model";
import {
  BodyText,
  ComparisonTable,
  DetailButton,
  DetailButtonShell,
  DetailPrimaryButton,
  DetailSecondaryButton,
  DisclosureRow,
  FieldLabel,
  KeyValueRow,
  Mono,
  StatusPill,
  TONE_TEXT,
  type DetailTone,
} from "./issue-detail-parts";
import { cn } from "cn";

/** GitHub mark: lucide dropped brand glyphs, so the source icon is inlined. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function createGrantIdempotencyKey(): string {
  return `grant-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clockOf(epoch: number | null | undefined): string {
  if (!epoch || !Number.isFinite(epoch)) return "";
  const date = new Date(epoch);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function elapsedOf(start: number | null | undefined, end: number | null | undefined): string {
  if (!start) return "";
  const finished = end ?? Date.now();
  const seconds = Math.max(0, Math.floor((finished - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

type Phase =
  | "triage"
  | "ready"
  | "implementing"
  | "verifying"
  | "retrying"
  | "approval"
  | "merged"
  | "blocked"
  | "failed"
  | "parked";

function phaseOf(detail: OperatorWorkDetail): Phase {
  const run = detail.latestRun?.run ?? null;
  const checks = detail.evidence?.observations.flatMap((observation) => observation.checks) ?? [];
  if (detail.lane === "triage") return "triage";
  if (detail.lane === "ready") return "ready";
  if (detail.lane === "parked") return "parked";
  if (detail.lane === "needs-owner") return "blocked";
  if (detail.lane === "failed") return "failed";
  if (detail.lane === "merged") return "merged";
  if (detail.lane === "approval") return "approval";
  if (run && run.state === "running" && checks.length === 0) {
    return (run.lap ?? 1) > 1 ? "retrying" : "implementing";
  }
  if (checks.length > 0) return "verifying";
  return (run?.lap ?? 1) > 1 ? "retrying" : "implementing";
}

const PHASE_HEADING: Record<Phase, string> = {
  triage: "Triage",
  ready: "Queue",
  implementing: "Current execution",
  verifying: "Current execution",
  retrying: "Loop in progress",
  approval: "Your decision",
  merged: "Outcome",
  blocked: "Blocking condition",
  failed: "Failure",
  parked: "Paused",
};

const PHASE_TONE: Record<Phase, DetailTone> = {
  triage: "accent",
  ready: "muted",
  implementing: "accent",
  verifying: "accent",
  retrying: "warning",
  approval: "success",
  merged: "success",
  blocked: "error",
  failed: "error",
  parked: "muted",
};

const PHASE_ICON: Record<Phase, typeof CircleDashed> = {
  triage: LoaderCircle,
  ready: CircleDashed,
  implementing: LoaderCircle,
  verifying: LoaderCircle,
  retrying: LoaderCircle,
  approval: CircleCheck,
  merged: CircleCheck,
  blocked: CircleX,
  failed: CircleX,
  parked: CircleDashed,
};

function checkSummaryOf(detail: OperatorWorkDetail): string {
  const checks = detail.evidence?.observations.flatMap((observation) => observation.checks) ?? [];
  if (checks.length === 0) return "No checks ran";
  const passed = checks.filter((check) => check.result === "PASS").length;
  return `${passed} / ${checks.length} checks passed`;
}

function checkRevisionOf(detail: OperatorWorkDetail): string {
  const checks = detail.evidence?.observations.flatMap((observation) => observation.checks) ?? [];
  if (checks.length === 0) return "not verified";
  const head = detail.latestRun?.run.head_sha;
  return head ? `${head.slice(0, 7)} · run head` : "run head";
}

/**
 * Pinned issue inspector for `Animus / Issue detail / Expanded`:
 * `ITMzl` (implementing), `qNjDd` (awaiting approval), `drpVe` (retrying),
 * `En4yq` (needs owner).
 */
export function IssueInspector({
  detail,
  projectId,
  onRefresh,
  onSelectWork,
  isCompact = false,
  onClose,
  onExpand,
  onCollapse,
  factory = client,
}: {
  detail: OperatorWorkDetail;
  projectId: string;
  onRefresh?: () => void;
  onSelectWork?: (workId: string) => void;
  isCompact?: boolean;
  onClose?: () => void;
  onExpand?: () => void;
  onCollapse?: () => void;
  factory?: typeof client;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clarificationAnswer, setClarificationAnswer] = useState("");

  const runAction = async (label: string, operation: () => Promise<void>) => {
    setBusy(label);
    setActionError(null);
    setNotice(null);
    try {
      await operation();
      onRefresh?.();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusy(null);
    }
  };

  const metrics = mapHarnessMetrics(detail);
  const draft = detail.draft ?? null;
  const run = detail.latestRun?.run ?? null;
  const budget = detail.latestRun?.budget ?? null;
  const runId = run?.id ?? null;
  const planId = detail.planId ?? null;
  const issueNum = detail.work.issue_number ?? detail.contract.sourceUrl.split("/").pop();
  const repoName = detail.work.repo_name || detail.work.revision.provenance.repo_name || "animus";
  const pr = detail.publication?.pullRequests[0] ?? null;
  const branch =
    run?.branch ??
    detail.retained?.branch ??
    detail.latestRun?.run.target_branch ??
    `issue-${issueNum}`;
  const targetBranch = run?.target_branch ?? detail.plan?.delivery_branch ?? "main";
  const headSha = run?.head_sha?.slice(0, 7) ?? detail.contract.contentHash.slice(0, 7);
  const phase = phaseOf(detail);
  const questions = draft?.latest_revision.questions ?? [];
  const needsClarification = phase === "triage" && questions.length > 0;

  const criteria =
    detail.latestRun?.acceptanceCriteria.map((criterion) => ({
      id: criterion.acKey,
      text: criterion.text,
    })) ??
    detail.plan?.acceptance_criteria?.map((criterion) => ({
      id: criterion.ac_key,
      text: criterion.text,
    })) ??
    [];

  const checks = detail.evidence?.observations.flatMap((observation) => observation.checks) ?? [];
  const metCriteria = criteria.filter((criterion) =>
    checks.some((check) => check.criterionKey === criterion.id && check.result === "PASS"),
  ).length;

  const allowedAttempts = budget?.allowedAttempts ?? 3;
  const consumedAttempts = budget?.consumedAttempts ?? run?.lap ?? 0;
  const lap = run?.lap ?? Math.max(1, consumedAttempts);
  const remainingAttempts = Math.max(0, allowedAttempts - consumedAttempts);

  const duration =
    elapsedOf(run?.launched_at, run?.finished_at) ||
    (run?.created_at ? elapsedOf(run.created_at, run.finished_at) : "");

  const outcome = (() => {
    switch (phase) {
      case "implementing":
        return `Implementing · lap ${lap} of ${allowedAttempts}`;
      case "verifying":
        return `Verifying · lap ${lap} of ${allowedAttempts}`;
      case "retrying":
        return `Retrying · lap ${lap} of ${allowedAttempts}`;
      case "approval":
        return "Ready to merge";
      case "merged":
        return "Merged and verified";
      case "blocked":
        return detail.stageLabel === "Needs owner" ? "Blocked" : detail.stageLabel;
      case "failed":
        return `Stopped at lap ${lap}`;
      case "parked":
        return detail.stageLabel;
      case "ready":
        return "Waiting for a worker";
      default:
        return detail.stageLabel;
    }
  })();

  const commitLine =
    phase === "merged"
      ? `Merged as ${headSha} into ${targetBranch}.`
      : phase === "approval"
        ? `PR ${pr ? `#${pr.number}` : "candidate"} · ${headSha} · ${checks.length} checks · ${criteria.length} criteria`
        : run?.error && phase !== "implementing"
          ? run.error
          : `Branch ${branch} → ${targetBranch} · head ${headSha}`;

  const lapRows = (detail.executionSteps ?? [])
    .filter((step) => step.status !== "pending")
    .slice(-4)
    .map((step) => ({
      label: step.label,
      state:
        step.status === "active"
          ? `running · ${step.time ?? "now"}`
          : step.status === "failed"
            ? `failed · ${step.time ?? ""}`.trim()
            : step.status === "completed"
              ? (step.time ?? "done")
              : "pending",
    }));

  const blockingEvidence =
    detail.evidence?.findings
      .filter((finding) => finding.status === "open")
      .map((finding) => `${finding.summary} (${finding.fileContext})`) ?? [];

  const riskLine =
    blockingEvidence.length > 0
      ? blockingEvidence.join(" · ")
      : detail.detail || `${detail.stageLabel} · ${detail.lane} lane`;

  const confidence = (() => {
    switch (phase) {
      case "merged":
        return {
          tone: "success" as DetailTone,
          text: `Verified · delivery target merge confirmed`,
        };
      case "approval":
        return { tone: "success" as DetailTone, text: `Verified · checks green at ${headSha}` };
      case "blocked":
        return {
          tone: "error" as DetailTone,
          text: `Stopped · ${consumedAttempts} of ${allowedAttempts} laps used`,
        };
      case "failed":
        return {
          tone: "error" as DetailTone,
          text: `Stopped · ${consumedAttempts} of ${allowedAttempts} laps used`,
        };
      case "retrying":
        return {
          tone: remainingAttempts <= 1 ? ("error" as DetailTone) : ("warning" as DetailTone),
          text:
            remainingAttempts <= 1
              ? "At risk · this is the last lap"
              : `${remainingAttempts} laps left after this one`,
        };
      case "triage":
        return { tone: "muted" as DetailTone, text: "Not started · triage reads before code" };
      case "ready":
        return { tone: "muted" as DetailTone, text: `Queued · ${remainingAttempts} laps reserved` };
      default:
        return {
          tone: "accent" as DetailTone,
          text: `On track · ${metCriteria} of ${criteria.length} acceptance criteria met`,
        };
    }
  })();

  const handleDecide = (decision: "approve" | "reject" | "revise") => {
    if (!draft) return;
    void runAction(`decide-${decision}`, async () => {
      await factory.forProject(projectId).decideDraft(draft.id, {
        decision,
        actor: "operator",
        reason: `Operator ${decision} from issue detail`,
        revision_id: draft.latest_revision.id,
      });
      setNotice(
        `Draft ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "returned for revision"}`,
      );
    });
  };

  const handlePublish = () => {
    if (!draft) return;
    void runAction("publish-draft", async () => {
      await factory.forProject(projectId).publishDraft(draft.id);
      setNotice("Draft published to the factory plan");
    });
  };

  const handleClarify = () => {
    if (!draft || !clarificationAnswer.trim()) return;
    void runAction("clarify", async () => {
      const firstQuestion = draft.latest_revision.questions[0];
      await factory.forProject(projectId).refineDraft({
        work_id: detail.work.id,
        instructions: clarificationAnswer,
        answers: firstQuestion
          ? [{ question_id: firstQuestion.id, answer: clarificationAnswer }]
          : [],
      });
      setClarificationAnswer("");
      setNotice("Clarification sent to the planner");
    });
  };

  const handleControl = (action: "hold" | "resume" | "stop" | "takeover") => {
    if (!runId) return;
    void runAction(`control-${action}`, async () => {
      await factory.forProject(projectId).controlDispatchRun(runId, {
        action,
        actor: "operator",
        reason: `Operator ${action}`,
      });
      setNotice(`Run ${action} recorded`);
    });
  };

  const handleGrant = () => {
    if (!runId) return;
    void runAction("grant", async () => {
      await factory.forProject(projectId).grantDispatchBudget(runId, {
        amount: 2,
        actor: "operator",
        reason: "Operator lap grant",
        idempotency_key: createGrantIdempotencyKey(),
      });
      setNotice("2 additional laps granted");
    });
  };

  const handleVerify = () => {
    if (runId) {
      void runAction("verify-merge", async () => {
        await factory.forProject(projectId).verifyDeliveryMerge(runId, "operator");
        setNotice("Merge verified against the delivery gate");
      });
      return;
    }
    if (planId) {
      void runAction("verify-final-merge", async () => {
        await factory.forProject(projectId).verifyFinalMerge(planId, "operator");
        setNotice("Final delivery merge verified");
      });
    }
  };

  const handleResumeOrRetry = () => {
    if (runId) {
      handleControl("resume");
      return;
    }
    if (planId) {
      void runAction("redispatch", async () => {
        await factory.forProject(projectId).dispatchPlan({ plan_id: planId, actor: "operator" });
        setNotice("Plan re-dispatched");
      });
    }
  };

  const rationale = detail.detail || riskLine;

  const detailLabels: Record<Phase, { list: string; note: string; useWorkers: boolean }> = {
    triage: { list: "What triage read", note: "Open question", useWorkers: false },
    ready: { list: "Scope", note: "Verification plan", useWorkers: false },
    implementing: { list: "What it is doing", note: "Workers", useWorkers: true },
    verifying: { list: "What it is doing", note: "Workers", useWorkers: true },
    retrying: { list: "Lap history", note: "Blocking evidence", useWorkers: false },
    approval: { list: "What changed", note: "Risk", useWorkers: false },
    merged: { list: "What shipped", note: "Verification", useWorkers: false },
    blocked: { list: "What it tried", note: "Why it stopped", useWorkers: false },
    failed: { list: "What needs attention", note: "Evidence", useWorkers: false },
    parked: { list: "Preserved state", note: "Reason", useWorkers: false },
  };
  const phaseLabels = detailLabels[phase];
  const noteValue = phaseLabels.useWorkers
    ? `${metrics.provider} · ${metrics.model}`
    : phase === "merged"
      ? checkSummaryOf(detail)
      : phase === "triage"
        ? (draft?.latest_revision.questions[0]?.question ?? riskLine)
        : riskLine;
  const listValue =
    phase === "triage" && draft
      ? draft.latest_revision.plan.kind === "clarification"
        ? detail.detail
        : draft.latest_revision.plan.body
      : phase === "approval" && checks.length > 0
        ? checks
            .slice(0, 3)
            .map((check) => `• ${check.name} — ${check.result.toLowerCase()}`)
            .join("\n")
        : lapRows.map((row) => `• ${row.label} — ${row.state}`).join("\n");

  const PhaseIcon = PHASE_ICON[phase];
  const phaseTone = PHASE_TONE[phase];

  const triageActions = (
    <>
      {questions.length > 0 ? (
        <DetailPrimaryButton
          label="Provide context"
          icon={CircleCheck}
          onClick={handleClarify}
          disabled={busy !== null || !clarificationAnswer.trim()}
        />
      ) : (
        <DetailPrimaryButton
          label="Approve & queue"
          icon={CircleCheck}
          onClick={() => handleDecide("approve")}
          disabled={busy !== null || !draft}
        />
      )}
      <DetailSecondaryButton
        label="Request changes"
        onClick={() => handleDecide("revise")}
        disabled={busy !== null || !draft}
      />
      <DetailSecondaryButton
        label="Reject"
        onClick={() => handleDecide("reject")}
        disabled={busy !== null || !draft}
      />
      {draft && (
        <DetailSecondaryButton
          label="Publish plan"
          onClick={handlePublish}
          disabled={busy !== null}
        />
      )}
    </>
  );

  return (
    <div data-testid="issue-inspector-pane" className="flex flex-col">
      <header className="sticky top-0 z-10 flex flex-col gap-3 border-b border-[var(--border-subtle)] bg-[var(--elevation-stage)] px-[22px] py-4">
        <div className="flex items-center gap-[10px]">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-[1.5] text-[var(--text-muted)]">
            #{issueNum}
            <span className="px-1.5">/</span>
            {branch}
          </span>
          {isCompact ? (
            onExpand && (
              <DetailButton
                label="Expand"
                icon={Maximize2}
                onClick={onExpand}
                ariaLabel="Expand to full workspace"
              />
            )
          ) : (
            <DetailButton
              label="Collapse"
              icon={Minimize2}
              onClick={onCollapse ?? onClose}
              ariaLabel="Back to Kanban"
            />
          )}
          {onClose && (
            <DetailButton
              label="Close"
              icon={X}
              onClick={onClose}
              ariaLabel={isCompact ? "Close side-sheet" : "Close workspace"}
            />
          )}
        </div>

        <h1 className="text-[20px] leading-[1.5] font-medium tracking-[-0.4px] text-foreground">
          {detail.contract.title}
        </h1>

        <div className="flex items-center gap-[10px]">
          <StatusPill label={detail.stageLabel} tone={phaseTone} soft />
          <StatusPill
            label={
              needsClarification
                ? "Needs clarification"
                : run?.state
                  ? run.state
                  : detail.contract.state === "OPEN"
                    ? "Open"
                    : "Closed"
            }
            tone={needsClarification ? "warning" : phaseTone === "muted" ? "muted" : phaseTone}
          />
          <span className="inline-flex min-w-0 max-w-[260px] shrink items-center gap-[7px] overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)] px-[11px] py-[7px]">
            <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-[var(--accent)]" />
            <span className="truncate text-xs leading-[1.5] text-[var(--accent)]">
              {pr ? `PR #${pr.number} · ${pr.state}` : `Branch · ${branch}`}
            </span>
          </span>
          <span className="flex-1" />
          <a
            href={detail.contract.sourceUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open source issue on GitHub"
            className="inline-flex shrink-0 items-center gap-[7px] rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-[11px] py-[7px] transition-colors hover:bg-[var(--white-04)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
          >
            <GithubMark className="size-3.5 shrink-0 text-[var(--text-secondary)]" />
            <span className="text-xs leading-[1.5] text-foreground">Github</span>
          </a>
          <DetailButtonShell label="More" icon={Ellipsis} />
        </div>

        <div className="flex items-center gap-[10px]">
          <span className="min-w-0 flex-1 truncate text-[11px] leading-[1.5] text-[var(--text-secondary)]">
            {repoName}
          </span>
          <span className="shrink-0 text-[11px] leading-[1.5] text-[var(--text-secondary)]">
            {metrics.provider} · {metrics.costFormatted ?? "cost not recorded"}
          </span>
        </div>
      </header>

      {(actionError || notice) && (
        <div className="px-[22px] pt-4">
          {actionError ? (
            <Alert variant="destructive" className="py-2.5">
              <AlertTitle className="text-xs font-semibold">Action failed</AlertTitle>
              <AlertDescription role="alert" className="text-xs">
                {actionError}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="success" className="py-2.5">
              <AlertTitle className="text-xs font-semibold">Recorded</AlertTitle>
              <AlertDescription role="status" className="text-xs">
                {notice}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <div className="flex flex-col px-[22px] pb-5">
        {detail.specProgress && (
          <section
            aria-label="Spec Coordination & Progress"
            className="flex flex-col gap-2 border-b border-[var(--border-subtle)] py-3.5"
          >
            <div className="flex items-center gap-[10px]">
              <Layers aria-hidden="true" className="size-3.5 shrink-0 text-[var(--accent)]" />
              <h2 className="text-[13px] leading-[1.5] font-medium text-foreground">
                Spec coordination
              </h2>
              <span className="flex-1" />
              <StatusPill
                label={`${detail.specProgress.integrated} / ${detail.specProgress.required} integrated`}
                tone="muted"
              />
            </div>
            <Progress
              value={
                (detail.specProgress.integrated / Math.max(1, detail.specProgress.required)) * 100
              }
              className="h-1.5 w-full"
            />
            <span className="text-right text-[11px] leading-[1.5] text-[var(--text-muted)]">
              {Math.round(
                (detail.specProgress.integrated / Math.max(1, detail.specProgress.required)) * 100,
              )}
              % completed
            </span>
          </section>
        )}

        <section
          aria-label={PHASE_HEADING[phase]}
          className="flex flex-col gap-1.5 border-b border-[var(--border-subtle)] py-3.5"
        >
          <h2 className="text-[13px] leading-[1.5] font-medium text-foreground">
            {PHASE_HEADING[phase]}
          </h2>

          <div className="flex items-center gap-[10px]">
            <PhaseIcon
              aria-hidden="true"
              className={cn(
                "size-[17px] shrink-0",
                TONE_TEXT[phaseTone],
                (phase === "implementing" || phase === "verifying" || phase === "retrying") &&
                  "animate-spin motion-reduce:animate-none",
              )}
            />
            <span className={cn("text-[15px] leading-[1.5] font-medium", TONE_TEXT[phaseTone])}>
              {outcome}
            </span>
            <span className="flex-1" />
            <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">
              {duration || clockOf(run?.created_at) || "—"}
            </span>
          </div>

          <BodyText>{commitLine}</BodyText>
          {rationale !== commitLine && <BodyText>{rationale}</BodyText>}

          {listValue.length > 0 && (
            <>
              <FieldLabel>{phaseLabels.list}</FieldLabel>
              <BodyText>{listValue}</BodyText>
            </>
          )}

          <FieldLabel>{phaseLabels.note}</FieldLabel>
          <BodyText>{noteValue}</BodyText>

          <div className="flex items-center gap-[10px]">
            <Target
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", TONE_TEXT[confidence.tone])}
            />
            <span className="text-xs leading-[1.5] text-foreground">{confidence.text}</span>
          </div>

          {phase === "triage" && draft?.latest_revision.questions.length ? (
            <div className="mt-1 flex flex-col gap-2">
              {draft.latest_revision.questions.map((question) => (
                <div key={question.id} className="flex flex-col gap-1">
                  <span className="text-xs leading-[1.5] text-foreground">{question.question}</span>
                  <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">
                    {question.reason}
                  </span>
                </div>
              ))}
              <Textarea
                rows={2}
                value={clarificationAnswer}
                onChange={(event) => setClarificationAnswer(event.target.value)}
                placeholder="Provide the missing context…"
                className="min-h-[72px] text-xs"
              />
            </div>
          ) : null}

          <div className="mt-1.5 flex flex-wrap items-center gap-[10px]">
            {phase === "triage" && (
              <div className="mt-1.5 flex flex-wrap items-center gap-[10px]">{triageActions}</div>
            )}

            {(phase === "ready" || phase === "implementing" || phase === "verifying") && (
              <>
                <DetailSecondaryButton
                  label="Pause"
                  onClick={() => handleControl("hold")}
                  disabled={busy !== null || !runId}
                />
                <DetailSecondaryButton
                  label="Extend a lap"
                  onClick={handleGrant}
                  disabled={busy !== null || !runId}
                />
                <DetailSecondaryButton
                  label="Stop for good"
                  onClick={() => handleControl("stop")}
                  disabled={busy !== null || !runId}
                />
              </>
            )}

            {phase === "parked" && (
              <>
                <DetailPrimaryButton
                  label="Resume"
                  icon={CircleCheck}
                  onClick={handleResumeOrRetry}
                  disabled={busy !== null}
                />
                <DetailSecondaryButton
                  label="Stop for good"
                  onClick={() => handleControl("stop")}
                  disabled={busy !== null || !runId}
                />
              </>
            )}

            {phase === "retrying" && (
              <>
                <DetailPrimaryButton
                  label="Grant 2 more laps"
                  icon={Clock}
                  onClick={handleGrant}
                  disabled={busy !== null || !runId}
                />
                <DetailSecondaryButton
                  label="Stop for good"
                  onClick={() => handleControl("stop")}
                  disabled={busy !== null || !runId}
                />
              </>
            )}

            {phase === "approval" && (
              <>
                <DetailPrimaryButton
                  label="Approve & merge"
                  icon={CircleCheck}
                  onClick={handleVerify}
                  disabled={busy !== null}
                />
                <DetailSecondaryButton
                  label="Request changes"
                  onClick={handleResumeOrRetry}
                  disabled={busy !== null}
                />
              </>
            )}

            {phase === "blocked" && (
              <>
                <DetailPrimaryButton
                  label="Grant access"
                  icon={CircleCheck}
                  onClick={handleResumeOrRetry}
                  disabled={busy !== null}
                />
                <DetailSecondaryButton
                  label="Keep blocked"
                  onClick={() => handleControl("hold")}
                  disabled={busy !== null || !runId}
                />
              </>
            )}

            {phase === "failed" && (
              <>
                <DetailPrimaryButton
                  label="Retry run"
                  icon={CircleCheck}
                  onClick={handleResumeOrRetry}
                  disabled={busy !== null}
                />
                <DetailSecondaryButton
                  label="Take over"
                  onClick={() => handleControl("takeover")}
                  disabled={busy !== null || !runId}
                />
                <DetailSecondaryButton
                  label="Stop for good"
                  onClick={() => handleControl("stop")}
                  disabled={busy !== null || !runId}
                />
              </>
            )}

            {phase === "merged" && (
              <DetailSecondaryButton
                label="Open full history"
                onClick={onRefresh}
                disabled={busy !== null}
              />
            )}

            {busy && <Spinner className="size-3.5 text-[var(--text-secondary)]" />}
          </div>
        </section>

        <section
          aria-label="Evidence"
          className="flex flex-col gap-[5px] border-b border-[var(--border-subtle)] py-3.5"
        >
          <h2 className="text-[13px] leading-[1.5] font-medium text-foreground">Evidence</h2>

          <div className="flex items-center gap-[10px]">
            {checks.length > 0 && checks.every((check) => check.result === "PASS") ? (
              <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-[var(--success)]" />
            ) : (
              <CircleDashed
                aria-hidden="true"
                className="size-4 shrink-0 text-[var(--text-muted)]"
              />
            )}
            <span className="text-[13px] leading-[1.5] text-[var(--text-secondary)]">
              {checkSummaryOf(detail)}
            </span>
            <span className="flex-1" />
            <Mono>{checkRevisionOf(detail)}</Mono>
          </div>

          {(checks.length > 0 ? checks : []).map((check) => (
            <div key={check.id} className="flex h-[29px] items-center gap-[10px]">
              {check.result === "PASS" ? (
                <CircleCheck
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-[var(--success)]"
                />
              ) : check.result === "FAIL" ? (
                <CircleX aria-hidden="true" className="size-3.5 shrink-0 text-[var(--error)]" />
              ) : check.result === "BLOCKED" ? (
                <CircleAlert
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-[var(--warning)]"
                />
              ) : (
                <CircleDashed
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-[var(--text-muted)]"
                />
              )}
              <span className="text-xs leading-[1.5] text-foreground">{check.name}</span>
              <span className="font-mono text-[11px] leading-[1.5] text-[var(--text-muted)]">
                {check.command}
              </span>
              <span className="flex-1" />
              <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">
                {check.result === "PASS"
                  ? check.durationMs != null
                    ? `passed · ${Math.round(check.durationMs / 1000)}s`
                    : "passed"
                  : check.result === "FAIL"
                    ? "failed"
                    : check.result === "BLOCKED"
                      ? "blocked"
                      : "not run"}
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-[13px] shrink-0 text-[var(--text-secondary)]"
              />
            </div>
          ))}

          {checks.length === 0 && (
            <p className="pt-1 text-[11px] leading-[1.5] text-[var(--text-muted)]">
              No gate has reported on this candidate yet.
            </p>
          )}

          <div className="pt-2">
            <ComparisonTable
              title={`Verified behavior · ${detail.contract.labels[0] ?? "candidate"}`}
              rows={checks.slice(0, 3).map((check) => ({
                label: check.criterionKey ?? check.name,
                before: "Not run",
                after:
                  check.result === "PASS"
                    ? (check.detail ?? "passed")
                    : (check.detail ?? check.result.toLowerCase()),
              }))}
            />
          </div>
        </section>

        {phase === "blocked" && (
          <section
            aria-label="Unblock"
            className="flex flex-col gap-[10px] border-b border-[var(--border-subtle)] py-3.5"
          >
            <h2 className="text-[13px] leading-[1.5] font-medium text-foreground">Unblock</h2>
            <BodyText>
              {detail.detail ||
                "Resolve the blocking condition, then resume. The branch, lap work and spend are preserved."}
            </BodyText>
            <div className="flex flex-wrap items-center gap-[10px]">
              <DetailPrimaryButton
                label="Grant access"
                icon={CircleCheck}
                onClick={handleResumeOrRetry}
                disabled={busy !== null}
              />
              <DetailSecondaryButton
                label="Keep blocked"
                onClick={() => handleControl("hold")}
                disabled={busy !== null || !runId}
              />
            </div>
          </section>
        )}

        {phase === "blocked" && (
          <section
            aria-label="Job context"
            className="flex flex-col gap-[10px] border-b border-[var(--border-subtle)] py-3.5"
          >
            <h2 className="text-[13px] leading-[1.5] font-medium text-foreground">Job context</h2>
            <KeyValueRow label="Repository" value={repoName} />
            <KeyValueRow label="Branch" value={branch} />
            <KeyValueRow label="Laps used" value={`${consumedAttempts} of ${allowedAttempts}`} />
            <KeyValueRow label="Spend so far" value={metrics.costFormatted ?? "Not recorded"} />
          </section>
        )}

        <div className="flex flex-col">
          <DisclosureRow
            label="Refined ticket & original issue"
            summary={`${criteria.length} acceptance criteria`}
          />
          <DisclosureRow
            label="Audit log"
            summary={
              detail.precedence[0]
                ? `${detail.precedence[0]} · ${detail.stageLabel}`
                : detail.stageLabel
            }
            divided={false}
          />
        </div>

        {detail.parent && (
          <button
            type="button"
            onClick={() => onSelectWork?.(detail.parent?.workId ?? "")}
            className="mt-2 flex items-center gap-[10px] text-left text-[11px] leading-[1.5] text-[var(--text-secondary)] hover:underline"
          >
            Part of #{detail.parent.issueNumber} · {detail.parent.title}
          </button>
        )}

        {pr && (
          <a
            href={pr.url ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-[7px] self-start rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-[11px] py-[7px] text-xs leading-[1.5] text-foreground hover:bg-[var(--white-04)]"
          >
            <GitPullRequest
              aria-hidden="true"
              className="size-3.5 shrink-0 text-[var(--success)]"
            />
            <span>Pull request #{pr.number}</span>
          </a>
        )}
      </div>
    </div>
  );
}
