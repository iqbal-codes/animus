import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BackupStatus,
  RestoreStatusResult,
  RestoreCreateResult,
} from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HardDriveDownload, HardDriveUpload, RefreshCw } from "lucide-react";

function formatTimestamp(value: number | null | undefined): string {
  if (!value) return "never";
  return new Date(value)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

function ReportSummary({ report }: { report: Record<string, unknown> }) {
  const number = (key: string) => {
    const value = report[key];
    return typeof value === "number" ? value : 0;
  };
  return (
    <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
      <div>
        <dt className="text-text-secondary">Interrupted runs</dt>
        <dd className="text-foreground">{number("interruptedRunCount")}</dd>
      </div>
      <div>
        <dt className="text-text-secondary">Held controls</dt>
        <dd className="text-foreground">{number("heldControlCount")}</dd>
      </div>
      <div>
        <dt className="text-text-secondary">Pending publications</dt>
        <dd className="text-foreground">{number("pendingPublicationIntentCount")}</dd>
      </div>
      <div>
        <dt className="text-text-secondary">Rewritten home-local paths</dt>
        <dd className="text-foreground">{number("rewrittenPathCount")}</dd>
      </div>
    </dl>
  );
}

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

/** Truthful resolved/abandoned dispositions recorded when the hold was released. */
function ReconciliationSummary({ reconciliation }: { reconciliation: Record<string, unknown> }) {
  const runs = asRecords(reconciliation.runs);
  const intents = asRecords(reconciliation.intents);
  if (runs.length === 0 && intents.length === 0) return null;
  return (
    <div
      data-testid="restore-reconciliation"
      className="space-y-2 rounded-[var(--radius-news)] border border-[var(--border-subtle)] p-3"
    >
      <h3 className="text-sm font-medium text-foreground">Reconciliation dispositions</h3>
      <p className="text-xs text-text-secondary">
        Released after copied ownership was cleared and every pending external effect was either
        verified resolved or durably abandoned. Abandoned effects are never replayed.
      </p>
      {runs.length > 0 && (
        <ul
          aria-label="Released run dispositions"
          className="space-y-1 text-xs text-text-secondary"
        >
          {runs.map((run) => (
            <li key={String(run.runId)} className="break-all">
              run {String(run.runId)} · {asText(run.state) || "unknown"} ·{" "}
              <span className="text-foreground">{String(run.disposition)}</span>
            </li>
          ))}
        </ul>
      )}
      {intents.length > 0 && (
        <ul
          aria-label="Released intent dispositions"
          className="space-y-1 text-xs text-text-secondary"
        >
          {intents.map((intent) => (
            <li key={String(intent.intentId)} className="break-all">
              {String(intent.kind)} · {String(intent.intentId)} ·{" "}
              <span className="text-foreground">{String(intent.disposition)}</span>
              {intent.remoteObjectId ? ` → ${asText(intent.remoteObjectId)}` : ""}
              {intent.disposition === "abandoned" ? " (terminal, not replayed)" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Installation-level backup and restore controls. Backups are verified bundles
 * of a consistent SQLite snapshot plus finalized referenced artifacts; a restore
 * lands in an isolated home and stays held until an operator reconciles it.
 */
export function BackupPanel({ factory = client }: { factory?: typeof client }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [restore, setRestore] = useState<RestoreStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [targetStateDir, setTargetStateDir] = useState("");
  const [targetHome, setTargetHome] = useState("");
  const [lastRestore, setLastRestore] = useState<RestoreCreateResult | null>(null);
  const [reconcileReason, setReconcileReason] = useState("");
  const [runDispositions, setRunDispositions] = useState<Record<string, "resolved" | "abandoned">>(
    {},
  );
  const [intentDispositions, setIntentDispositions] = useState<
    Record<string, "resolved" | "abandoned">
  >({});
  const targetStateRef = useRef(targetStateDir);
  targetStateRef.current = targetStateDir;

  const load = useCallback(
    async (inspectStateDir?: string) => {
      setLoading(true);
      setError(null);
      try {
        const [nextStatus, nextRestore] = await Promise.all([
          factory.backupStatus(),
          factory.restoreStatus(inspectStateDir).catch(() => null),
        ]);
        setStatus(nextStatus);
        setRestore(nextRestore);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [factory],
  );

  useEffect(() => {
    if (expanded) void load(targetStateRef.current.trim() || undefined);
  }, [expanded, load]);

  async function createBackup() {
    if (!destination.trim()) {
      setError("Enter a destination path for the verified backup bundle.");
      return;
    }
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const result = await factory.createWorkspaceBackup({
        destinationPath: destination.trim(),
        actor: "operator",
      });
      setNotice(
        `Verified backup written to ${result.destinationPath} (${result.artifactCount} artifact(s), schema v${result.schemaVersion}).`,
      );
      setDestination("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function restoreWorkspace() {
    if (!sourcePath.trim() || !targetStateDir.trim()) {
      setError("Enter both the backup source and an isolated target state directory.");
      return;
    }
    setBusy("restore");
    setError(null);
    setNotice(null);
    try {
      const result = await factory.restoreWorkspace({
        sourcePath: sourcePath.trim(),
        targetStateDir: targetStateDir.trim(),
        ...(targetHome.trim() ? { targetHome: targetHome.trim() } : {}),
        actor: "operator",
      });
      setLastRestore(result);
      setNotice(
        "Restore completed into an isolated home. Dispatch and publication stay disabled until reconciliation.",
      );
      await load();
      setRestore(await factory.restoreStatus(targetStateDir.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function reconcile() {
    setBusy("reconcile");
    setError(null);
    setNotice(null);
    try {
      const unresolved = restore?.unresolved;
      const snapshot = restore?.installation;
      if (!unresolved || !snapshot?.sourceRestoreId || snapshot.restoredAt === null) {
        throw new Error("Read the held installation status before releasing it.");
      }
      const runs = unresolved.runs
        .filter((run) => runDispositions[run.runId])
        .map((run) => ({ runId: run.runId, disposition: runDispositions[run.runId]! }));
      const intents = unresolved.intents
        .filter((intent) => intentDispositions[intent.intentId])
        .map((intent) => ({
          intentId: intent.intentId,
          disposition: intentDispositions[intent.intentId]!,
        }));
      if (runs.length !== unresolved.runs.length || intents.length !== unresolved.intents.length) {
        throw new Error(
          "Choose resolved or abandoned for every interrupted run and pending publication intent.",
        );
      }
      if (!reconcileReason.trim()) {
        throw new Error(
          "Record why the restored ownership and external effects are verified safe.",
        );
      }
      const result = await factory.reconcileRestore(
        {
          actor: "operator",
          reason: reconcileReason.trim(),
          snapshot: {
            sourceRestoreId: snapshot.sourceRestoreId,
            restoredAt: snapshot.restoredAt,
          },
          runs,
          intents,
        },
        targetStateDir.trim() || undefined,
      );
      setRestore(result);
      setRunDispositions({});
      setIntentDispositions({});
      setReconcileReason("");
      setNotice("Restored installation released after verified reconciliation.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const held = restore?.installation.held ?? false;

  return (
    <section
      aria-labelledby="backup-panel-title"
      className="border-b border-[var(--border-subtle)] bg-[var(--background)] px-4 py-2 sm:px-6"
      data-testid="backup-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="backup-panel-title" className="text-sm font-medium text-foreground">
          Workspace backup &amp; restore
        </h2>
        {status?.restorable ? (
          <Badge variant="success">last backup verified</Badge>
        ) : (
          <Badge variant="warning">no verified backup</Badge>
        )}
        {held && <Badge variant="error">restored installation held</Badge>}
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-8"
          aria-expanded={expanded}
          aria-controls="backup-panel-body"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide" : "Open"} backup controls
        </Button>
      </div>

      {expanded && (
        <div id="backup-panel-body" className="mt-3 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span>
              Last verified: {formatTimestamp(status?.lastBackup?.verifiedAt ?? null)}
              {status?.lastBackup ? ` · schema v${status.lastBackup.schemaVersion}` : ""}
            </span>
            <span>
              Restorable: {status?.restorable ? "yes" : "no"}
              {status && status.reasons.length > 0 ? ` (${status.reasons.join(", ")})` : ""}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => void load(targetStateDir.trim() || undefined)}
              disabled={loading}
              aria-label="Refresh backup status"
            >
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
              <span>Refresh</span>
            </Button>
          </div>

          {status?.credentials && (
            <p className="text-xs leading-relaxed text-text-secondary">
              Credentials are never included. {status.credentials.note} Same-disk copies are not
              disaster protection: {status.sameDiskWarning}
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-[var(--radius-news)] border border-[var(--border-subtle)] p-3">
              <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                <HardDriveDownload aria-hidden="true" className="size-4" />
                Create verified backup
              </h3>
              <label htmlFor="backup-destination" className="block text-xs text-text-secondary">
                Destination bundle directory
              </label>
              <input
                id="backup-destination"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="/secure-storage/animus-backup"
                className="min-h-11 w-full rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-transparent px-3 text-sm text-foreground sm:min-h-8"
              />
              <Button
                size="sm"
                className="min-h-11 sm:min-h-8"
                onClick={() => void createBackup()}
                disabled={busy === "create"}
              >
                {busy === "create" ? "Backing up…" : "Create backup"}
              </Button>
            </div>

            <div className="space-y-2 rounded-[var(--radius-news)] border border-[var(--border-subtle)] p-3">
              <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                <HardDriveUpload aria-hidden="true" className="size-4" />
                Restore into isolated home
              </h3>
              <label htmlFor="backup-source" className="block text-xs text-text-secondary">
                Backup bundle source
              </label>
              <input
                id="backup-source"
                value={sourcePath}
                onChange={(event) => setSourcePath(event.target.value)}
                placeholder="/secure-storage/animus-backup"
                className="min-h-11 w-full rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-transparent px-3 text-sm text-foreground sm:min-h-8"
              />
              <label htmlFor="backup-target-state" className="block text-xs text-text-secondary">
                Target state directory
              </label>
              <input
                id="backup-target-state"
                value={targetStateDir}
                onChange={(event) => setTargetStateDir(event.target.value)}
                placeholder="/tmp/restored-home/state"
                className="min-h-11 w-full rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-transparent px-3 text-sm text-foreground sm:min-h-8"
              />
              <label htmlFor="backup-target-home" className="block text-xs text-text-secondary">
                Target home (optional)
              </label>
              <input
                id="backup-target-home"
                value={targetHome}
                onChange={(event) => setTargetHome(event.target.value)}
                placeholder="/tmp/restored-home"
                className="min-h-11 w-full rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-transparent px-3 text-sm text-foreground sm:min-h-8"
              />
              <Button
                size="sm"
                className="min-h-11 sm:min-h-8"
                onClick={() => void restoreWorkspace()}
                disabled={busy === "restore"}
              >
                {busy === "restore" ? "Restoring…" : "Restore workspace"}
              </Button>
            </div>
          </div>

          {restore?.installation.held && (
            <div className="space-y-3 rounded-[var(--radius-news)] border border-[var(--border-subtle)] p-3">
              <p className="text-sm font-medium text-foreground">
                Restored installation held since {formatTimestamp(restore.installation.restoredAt)}
              </p>
              <p className="text-xs text-text-secondary">
                Dispatch and publication are disabled. {restore.heldRunCount} interrupted run(s) and{" "}
                {restore.pendingPublicationIntentCount} pending publication intent(s) require
                explicit reconciliation. Live processes and uncommitted worktree edits are not
                resumed, and copied owner tokens are not authority.
              </p>

              {restore.unresolved.runs.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-foreground">Interrupted runs</legend>
                  {restore.unresolved.runs.map((run, index) => (
                    <div key={run.runId} className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      <label
                        htmlFor={`restore-run-${run.runId}`}
                        className="text-xs text-text-secondary"
                      >
                        {run.runId} · {run.state} · owner cleared{" "}
                        {run.ownerPidCleared && run.leaseCleared ? "yes" : "NO"} · worktree present{" "}
                        {run.worktreePresent ? "yes" : "no"}
                      </label>
                      <select
                        id={`restore-run-${run.runId}`}
                        aria-label={`Disposition for interrupted run ${index + 1}`}
                        value={runDispositions[run.runId] ?? ""}
                        onChange={(event) =>
                          setRunDispositions((current) => ({
                            ...current,
                            [run.runId]: event.target.value as "resolved" | "abandoned",
                          }))
                        }
                        className="min-h-11 rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-transparent px-3 text-sm text-foreground sm:min-h-8"
                      >
                        <option value="">Choose disposition</option>
                        <option value="resolved">resolved</option>
                        <option value="abandoned">abandoned</option>
                      </select>
                    </div>
                  ))}
                </fieldset>
              )}

              {restore.unresolved.intents.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-foreground">
                    Pending external intents
                  </legend>
                  <p className="text-xs text-text-secondary">
                    `resolved` is accepted only with a positive remote readback; use `abandoned` for
                    an intent whose effect is verifiably absent or ambiguous.
                  </p>
                  {restore.unresolved.intents.map((intent, index) => (
                    <div key={intent.intentId} className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      <label
                        htmlFor={`restore-intent-${intent.intentId}`}
                        className="text-xs text-text-secondary"
                      >
                        {intent.intentId} · {intent.kind} · {intent.state} · {intent.attempts}{" "}
                        attempt(s)
                      </label>
                      <select
                        id={`restore-intent-${intent.intentId}`}
                        aria-label={`Disposition for pending publication intent ${index + 1}`}
                        value={intentDispositions[intent.intentId] ?? ""}
                        onChange={(event) =>
                          setIntentDispositions((current) => ({
                            ...current,
                            [intent.intentId]: event.target.value as "resolved" | "abandoned",
                          }))
                        }
                        className="min-h-11 rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-transparent px-3 text-sm text-foreground sm:min-h-8"
                      >
                        <option value="">Choose disposition</option>
                        <option value="resolved">resolved</option>
                        <option value="abandoned">abandoned</option>
                      </select>
                    </div>
                  ))}
                </fieldset>
              )}

              <label
                htmlFor="restore-reconcile-reason"
                className="block text-xs text-text-secondary"
              >
                Reconciliation reason
              </label>
              <input
                id="restore-reconcile-reason"
                value={reconcileReason}
                onChange={(event) => setReconcileReason(event.target.value)}
                placeholder="Explain how ownership and remote effects were verified"
                className="min-h-11 w-full rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-transparent px-3 text-sm text-foreground sm:min-h-8"
              />
              <Button
                size="sm"
                className="min-h-11 sm:min-h-8"
                onClick={() => void reconcile()}
                disabled={busy === "reconcile"}
              >
                {busy === "reconcile" ? "Verifying…" : "Verify and release"}
              </Button>
            </div>
          )}

          {!held && restore?.installation.reconciliation ? (
            <ReconciliationSummary reconciliation={restore.installation.reconciliation} />
          ) : null}

          {lastRestore && (
            <div className="rounded-[var(--radius-news)] border border-[var(--border-subtle)] p-3">
              <h3 className="mb-2 text-sm font-medium text-foreground">Restore report</h3>
              <ReportSummary report={lastRestore.operation.report} />
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-[var(--destructive)]">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-xs text-[var(--success,var(--foreground))]">
              {notice}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
