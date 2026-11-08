import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  FileText,
  GitBranch,
  Loader2,
  RefreshCw,
  Send,
  Undo2,
  X,
} from "lucide-react";
import type {
  DraftDecisionKind,
  DraftList,
  DraftRecord,
  Project,
} from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "cn";
import {
  buildAnswerSubmission,
  DRAFT_STATUS_LABEL,
  draftActionsOf,
  emptyAnswers,
  planContentOf,
  selectActiveProjects,
  summarizeDraft,
  TONE_BADGE_CLASS,
} from "./drafts-model";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; projects: Project[]; drafts: DraftList };

type Decision = Exclude<DraftDecisionKind, "revise">;

const DECISION_LABEL: Record<Decision, string> = {
  approve: "Approve for publication",
  reject: "Reject",
};

/**
 * Operator draft review. Reads imported work and draft revisions from the same
 * backend command/query API the CLI uses; there is no local fixture store. Every
 * panel below renders real persisted state, including empty, loading and error
 * states, so the operator never sees a fabricated draft.
 */
export function DraftsScreen() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [record, setRecord] = useState<DraftRecord | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const projects = selectActiveProjects(await client.projects());
      const nextProjectId = projectId ?? projects[0]?.id ?? null;
      setProjectId(nextProjectId);
      if (!nextProjectId) {
        setState({ phase: "ready", projects: [], drafts: [] });
        return;
      }
      const drafts = await client.forProject(nextProjectId).drafts();
      setState({ phase: "ready", projects, drafts });
    } catch (error) {
      setState({ phase: "error", message: messageOf(error) });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    // Run once on mount; project switches reload explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeProjects = state.phase === "ready" ? state.projects : [];
  const drafts = state.phase === "ready" ? state.drafts : [];

  const selected = useMemo(
    () => drafts.find((draft) => draft.id === selectedDraftId) ?? null,
    [drafts, selectedDraftId],
  );

  const loadRecord = useCallback(async (targetProjectId: string, draftId: string) => {
    setRecordError(null);
    setRecord(null);
    try {
      setRecord(await client.forProject(targetProjectId).draft(draftId));
    } catch (error) {
      setRecordError(messageOf(error));
    }
  }, []);

  const selectDraft = useCallback(
    (draftId: string) => {
      setSelectedDraftId(draftId);
      setNotice(null);
      setActionError(null);
      if (projectId) void loadRecord(projectId, draftId);
    },
    [projectId, loadRecord],
  );

  const switchProject = useCallback(
    async (nextProjectId: string) => {
      setProjectId(nextProjectId);
      setSelectedDraftId(null);
      setRecord(null);
      setNotice(null);
      setActionError(null);
      setState({ phase: "loading" });
      try {
        const projectDrafts = await client.forProject(nextProjectId).drafts();
        setState({ phase: "ready", projects: activeProjects, drafts: projectDrafts });
      } catch (error) {
        setState({ phase: "error", message: messageOf(error) });
      }
    },
    [activeProjects],
  );

  const refresh = useCallback(async () => {
    if (!projectId) {
      await load();
      return;
    }
    setBusy("refresh");
    setActionError(null);
    try {
      const projectDrafts = await client.forProject(projectId).drafts();
      setState({ phase: "ready", projects: activeProjects, drafts: projectDrafts });
      if (selectedDraftId) await loadRecord(projectId, selectedDraftId);
    } catch (error) {
      setState({ phase: "error", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }, [projectId, activeProjects, selectedDraftId, loadRecord, load]);

  const submitAnswers = useCallback(
    async (answers: Record<string, string>) => {
      if (!projectId || !selected) return;
      const submission = buildAnswerSubmission(selected, answers);
      if (!submission) return;
      setBusy("answers");
      setActionError(null);
      setNotice(null);
      try {
        const next = await client.forProject(projectId).reviseDraft(selected.id, {
          answers: submission,
        });
        setRecord(next);
        await refresh();
        setNotice(`Saved revision ${next.latest_revision.revision_number}.`);
      } catch (error) {
        setActionError(messageOf(error));
      } finally {
        setBusy(null);
      }
    },
    [projectId, selected, refresh],
  );

  const submitDecision = useCallback(
    async (decision: Decision, reason: string, instructions?: string) => {
      if (!projectId || !selected) return;
      setBusy(decision);
      setActionError(null);
      setNotice(null);
      try {
        const next = await client.forProject(projectId).decideDraft(selected.id, {
          revision_id: selected.latest_revision.id,
          decision,
          reason,
          ...(instructions ? { instructions } : {}),
        });
        setRecord(next);
        await refresh();
        setNotice(
          decision === "approve"
            ? `Approved revision ${next.latest_revision.revision_number}.`
            : `Rejected revision ${next.latest_revision.revision_number}.`,
        );
      } catch (error) {
        setActionError(messageOf(error));
      } finally {
        setBusy(null);
      }
    },
    [projectId, selected, refresh],
  );

  const requestChanges = useCallback(
    async (reason: string, instructions: string) => {
      if (!projectId || !selected) return;
      setBusy("revise");
      setActionError(null);
      setNotice(null);
      try {
        const next = await client.forProject(projectId).decideDraft(selected.id, {
          revision_id: selected.latest_revision.id,
          decision: "revise",
          reason,
          instructions,
        });
        setRecord(next);
        await refresh();
        setNotice(`Requested changes on revision ${next.latest_revision.revision_number}.`);
      } catch (error) {
        setActionError(messageOf(error));
      } finally {
        setBusy(null);
      }
    },
    [projectId, selected, refresh],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-[76px] shrink-0 flex-wrap items-center gap-4 border-b border-[var(--border-subtle)] px-4 py-4 sm:px-7">
        <h1 className="text-[20px] leading-[1.4] font-medium text-foreground">Drafts</h1>
        {activeProjects.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <span className="sr-only">Project</span>
            <select
              aria-label="Project"
              value={projectId ?? ""}
              onChange={(event) => void switchProject(event.target.value)}
              className="h-9 max-w-[16rem] rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--surface)] px-3 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {activeProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={busy !== null}
          aria-label="Refresh drafts"
        >
          <RefreshCw className={cn("size-3.5", busy === "refresh" && "animate-spin")} />
          <span>Refresh</span>
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pt-5 pb-5 sm:px-7 lg:flex-row lg:gap-6">
        <section aria-label="Draft queue" className="flex min-h-0 shrink-0 flex-col lg:w-[380px]">
          {state.phase === "loading" && <QueueLoading />}
          {state.phase === "error" && (
            <QueueError message={state.message} onRetry={() => void load()} />
          )}
          {state.phase === "ready" && state.projects.length === 0 && (
            <QueueEmpty
              title="No active projects"
              detail="Register and activate a repository before drafting imported work."
            />
          )}
          {state.phase === "ready" && state.projects.length > 0 && drafts.length === 0 && (
            <QueueEmpty
              title="No drafts yet"
              detail="Run `animus draft refine <work-id> --project <id>` to draft an imported request, then it appears here."
            />
          )}
          {state.phase === "ready" && drafts.length > 0 && (
            <div
              role="listbox"
              aria-label="Drafts"
              tabIndex={0}
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-[var(--radius-code)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              {drafts.map((draft) => {
                const summary = summarizeDraft(draft);
                const active = draft.id === selectedDraftId;
                return (
                  <button
                    key={draft.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => selectDraft(draft.id)}
                    className={cn(
                      "flex w-full flex-col gap-1.5 rounded-[var(--radius-code)] border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
                      active
                        ? "border-[var(--ring)] bg-card"
                        : "border-[var(--border-subtle)] bg-transparent hover:bg-[var(--white-04)]",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-text-secondary">
                        #{summary.issueNumber}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] leading-[1.4] font-medium",
                          TONE_BADGE_CLASS[summary.tone],
                        )}
                      >
                        {summary.statusLabel}
                      </span>
                      <span className="flex-1" />
                      <span className="text-[11px] leading-[1.4] text-text-muted">
                        rev {summary.revisionNumber}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-sm leading-[1.4] text-foreground">
                      {summary.title}
                    </span>
                    <span className="text-[11px] leading-[1.4] text-text-muted">
                      {summary.repoName} · {summary.kind}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section
          aria-label="Draft detail"
          aria-live="polite"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-4"
        >
          {notice && (
            <p className="rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--success-bg)] px-3 py-2 text-xs text-success">
              {notice}
            </p>
          )}
          {actionError && (
            <p
              role="alert"
              className="rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--error-bg)] px-3 py-2 text-xs text-error"
            >
              {actionError}
            </p>
          )}
          {!selectedDraftId && (
            <DetailPlaceholder
              title="Select a draft"
              detail="Choose a draft from the queue to review its scope, questions and decisions."
            />
          )}
          {selectedDraftId && recordError && (
            <DetailPlaceholder
              tone="error"
              title="Could not load this draft"
              detail={recordError}
            />
          )}
          {selectedDraftId && !recordError && !record && <DetailLoading />}
          {record && (
            <DraftDetail
              key={`${record.id}:${record.latest_revision.id}`}
              record={record}
              busy={busy}
              onSubmitAnswers={submitAnswers}
              onDecision={submitDecision}
              onRequestChanges={requestChanges}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function DraftDetail({
  record,
  busy,
  onSubmitAnswers,
  onDecision,
  onRequestChanges,
}: {
  record: DraftRecord;
  busy: string | null;
  onSubmitAnswers: (answers: Record<string, string>) => Promise<void>;
  onDecision: (decision: Decision, reason: string, instructions?: string) => Promise<void>;
  onRequestChanges: (reason: string, instructions: string) => Promise<void>;
}) {
  const content = planContentOf(record);
  const plan = record.latest_revision.plan;
  const actions = draftActionsOf(record);
  const [answers, setAnswers] = useState<Record<string, string>>(() => emptyAnswers(record));
  const [decisionReason, setDecisionReason] = useState("");
  const [instructions, setInstructions] = useState("");

  const answerSubmission = buildAnswerSubmission(record, answers);
  const reasonReady = decisionReason.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-text-secondary">
            {record.source_provenance.repo_name}#{record.source_provenance.issue_number}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] leading-[1.4] font-medium",
              TONE_BADGE_CLASS[summarizeDraft(record).tone],
            )}
          >
            {DRAFT_STATUS_LABEL[record.status]}
          </span>
          <span className="text-[11px] leading-[1.4] text-text-muted">
            revision {record.latest_revision.revision_number} · {record.latest_revision.kind}
          </span>
        </div>
        <h2 className="text-xl leading-[1.4] font-medium text-foreground break-words">
          {content.title ?? record.source.title}
        </h2>
        <p className="text-xs leading-[1.5] text-text-secondary break-words">
          Original request: {record.source.body.trim() || "(no description)"}
        </p>
        <p className="text-[11px] leading-[1.4] text-text-muted">
          Source {record.source_provenance.source_url} · hash{" "}
          {record.source_content_hash.slice(0, 12)}…
        </p>
      </header>

      {plan.kind === "clarification" && (
        <section aria-label="Draft questions" className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-foreground">Questions for you</h3>
          <p className="text-xs leading-[1.5] text-text-secondary">{plan.reason}</p>
          {plan.questions.map((question) => (
            <label key={question.id} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">{question.question}</span>
              <span className="text-[11px] leading-[1.4] text-text-muted">{question.reason}</span>
              <Textarea
                aria-label={question.question}
                value={answers[question.id] ?? ""}
                onChange={(event) =>
                  setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                }
                className="min-h-24 text-sm"
                placeholder="Your answer"
              />
            </label>
          ))}
          <div>
            <Button
              size="sm"
              onClick={() => void onSubmitAnswers(answers)}
              disabled={busy !== null || answerSubmission === null}
            >
              {busy === "answers" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              <span>Save answers</span>
            </Button>
            {answerSubmission === null && (
              <p className="mt-2 text-[11px] leading-[1.4] text-text-muted">
                Answer every question to create a reviewable revision.
              </p>
            )}
          </div>
        </section>
      )}

      {plan.kind !== "clarification" && (
        <>
          <section aria-label="Draft scope" className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Scope" value={content.scope ?? ""} />
              <Field label="Outcome" value={content.outcome ?? ""} />
            </div>
            <ListBlock title="Invariants" items={content.invariants} />
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">Acceptance criteria</h3>
              <ol className="flex flex-col gap-2">
                {content.acceptanceCriteria.map((criterion) => (
                  <li
                    key={criterion.id}
                    className="rounded-[var(--radius-news)] border border-[var(--border-subtle)] p-2.5"
                  >
                    <p className="text-xs text-foreground">
                      <span className="font-mono text-[11px] text-text-secondary">
                        {criterion.id}
                      </span>{" "}
                      {criterion.description}
                    </p>
                    <p className="mt-1 text-[11px] leading-[1.4] text-text-muted">
                      {criterion.verification}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
            <ListBlock title="Verification requirements" items={content.verificationRequirements} />
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">Boundary</h3>
              <dl className="grid gap-2 sm:grid-cols-2">
                {content.boundary.map((entry) => (
                  <div key={entry.label} className="text-xs">
                    <dt className="text-[11px] text-text-muted">{entry.label}</dt>
                    <dd className="break-words text-text-secondary">{entry.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            {content.children.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-foreground">
                  Child tickets ({content.children.length})
                </h3>
                <ul className="flex flex-col gap-2">
                  {content.children.map((child) => (
                    <li
                      key={child.id}
                      className="rounded-[var(--radius-news)] border border-[var(--border-subtle)] p-2.5"
                    >
                      <p className="text-xs text-foreground">
                        <span className="font-mono text-[11px] text-text-secondary">
                          {child.id}
                        </span>{" "}
                        {child.title}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-3 text-[11px] leading-[1.4] text-text-muted">
                        <span className="inline-flex items-center gap-1">
                          <GitBranch aria-hidden="true" className="size-3" />
                          {child.dependsOn.length > 0
                            ? `Depends on ${child.dependsOn.join(", ")}`
                            : "No dependencies"}
                        </span>
                        <span>Covers {child.covers.join(", ")}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section aria-label="Draft decision" className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-foreground">Decision</h3>
            <p className="text-[11px] leading-[1.4] text-text-muted">{actions.reason}</p>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-text-secondary">Reason</span>
              <Textarea
                aria-label="Decision reason"
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                className="min-h-20 text-sm"
                placeholder="Why is this the right scope?"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-text-secondary">
                Change instructions (required to request changes)
              </span>
              <Textarea
                aria-label="Change instructions"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                className="min-h-20 text-sm"
                placeholder="What should the next revision change?"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => void onDecision("approve", decisionReason.trim())}
                disabled={busy !== null || !actions.canApprove || !reasonReady}
              >
                {busy === "approve" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                <span>{DECISION_LABEL.approve}</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onRequestChanges(decisionReason.trim(), instructions.trim())}
                disabled={
                  busy !== null ||
                  !actions.canRequestChanges ||
                  !reasonReady ||
                  instructions.trim().length === 0
                }
              >
                {busy === "revise" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Undo2 className="size-3.5" />
                )}
                <span>Request changes</span>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void onDecision("reject", decisionReason.trim())}
                disabled={busy !== null || !actions.canReject || !reasonReady}
              >
                {busy === "reject" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <X className="size-3.5" />
                )}
                <span>{DECISION_LABEL.reject}</span>
              </Button>
            </div>
            {!reasonReady && (
              <p className="text-[11px] leading-[1.4] text-text-muted">
                A reason is required before any decision is recorded.
              </p>
            )}
          </section>
        </>
      )}

      {record.latest_decision && (
        <section aria-label="Latest decision" className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">Latest decision</h3>
          <p className="text-xs text-text-secondary">
            {record.latest_decision.decision} on revision {record.latest_decision.revision_number} ·{" "}
            {record.latest_decision.reason}
          </p>
          {record.latest_decision.instructions && (
            <p className="text-[11px] leading-[1.4] text-text-muted">
              Instructions: {record.latest_decision.instructions}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-text-muted">{label}</span>
      <p className="text-xs leading-[1.5] text-text-secondary break-words">{value}</p>
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <ul className="list-disc pl-5 text-xs leading-[1.5] text-text-secondary">
        {items.map((item) => (
          <li key={item} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function QueueLoading() {
  return (
    <div role="status" className="flex items-center gap-2 px-1 py-4 text-xs text-text-secondary">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>Loading drafts…</span>
    </div>
  );
}

function QueueError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-[var(--radius-code)] border border-[var(--border-subtle)] bg-[var(--error-bg)] p-4"
    >
      <span className="flex items-center gap-2 text-xs text-error">
        <AlertCircle aria-hidden="true" className="size-4" />
        {message}
      </span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="size-3.5" />
        <span>Retry</span>
      </Button>
    </div>
  );
}

function QueueEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[var(--radius-code)] border border-[var(--border-subtle)] p-4">
      <span className="flex items-center gap-2 text-xs text-foreground">
        <FileText aria-hidden="true" className="size-4 text-text-muted" />
        {title}
      </span>
      <p className="text-[11px] leading-[1.5] text-text-muted">{detail}</p>
    </div>
  );
}

function DetailPlaceholder({
  title,
  detail,
  tone = "neutral",
}: {
  title: string;
  detail: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-[var(--radius-code)] border border-[var(--border-subtle)] p-6 text-center">
      <p className={cn("text-sm font-medium", tone === "error" ? "text-error" : "text-foreground")}>
        {title}
      </p>
      <p className="max-w-md text-xs leading-[1.5] text-text-muted">{detail}</p>
    </div>
  );
}

function DetailLoading() {
  return (
    <div role="status" className="flex items-center gap-2 px-1 py-4 text-xs text-text-secondary">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>Loading draft…</span>
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
