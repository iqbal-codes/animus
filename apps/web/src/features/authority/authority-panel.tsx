import { useCallback, useEffect, useState } from "react";
import type { CutoverStatus } from "@animus/contracts/cutover";
import { client } from "@/lib/factory-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";

function authorityTone(authority: CutoverStatus["authority"]): string {
  if (authority === "local") return "border-[var(--success)] text-[var(--success)]";
  if (authority === "migrating") return "border-[var(--warning)] text-[var(--warning)]";
  return "border-[var(--border-subtle)] text-text-secondary";
}

function authorityLabel(authority: CutoverStatus["authority"]): string {
  if (authority === "local") return "Local authority active";
  if (authority === "migrating") return "Cutover fenced";
  return "Legacy authority";
}

function shortSha(value: string | null | undefined): string {
  if (!value) return "none";
  return value.length > 16 ? `${value.slice(0, 12)}…` : value;
}

export function AuthorityPanel() {
  const [status, setStatus] = useState<CutoverStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"stage" | "activate" | "abort" | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.authorityStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: "stage" | "activate" | "abort") => {
      setBusy(action);
      setMessage(null);
      try {
        if (action === "stage") {
          const result = await client.stageAuthorityCutover({ actor: "operator" });
          setMessage(
            `Staged ${result.inventory.totalRows} rows; isolated restore is held at ${result.restore.targetStateDir}.`,
          );
        } else if (action === "activate") {
          const operation = status?.operation;
          if (!operation?.inventorySha256 || !operation.backupManifestSha256) {
            throw new Error("No staged cutover evidence is available to activate");
          }
          const result = await client.activateAuthorityCutover({
            actor: "operator",
            cutoverId: operation.id,
            inventorySha256: operation.inventorySha256,
            backupManifestSha256: operation.backupManifestSha256,
          });
          setMessage(`Execution authority is ${result.status.authority}.`);
        } else {
          const operation = status?.operation;
          if (!operation) throw new Error("No cutover operation is available to abort");
          await client.abortAuthorityCutover({
            actor: "operator",
            reason: "Operator aborted the staged cutover before activation",
            cutoverId: operation.id,
          });
          setMessage("Cutover aborted; legacy authority is restored.");
        }
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh, status],
  );

  const operation = status?.operation ?? null;
  const blocked = (status?.blockingReasons.length ?? 0) > 0;

  return (
    <section
      aria-label="Execution authority"
      className="mx-4 mt-3 rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--surface-2)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {status?.authority === "local" ? (
            <ShieldCheck className="h-4 w-4 text-[var(--success)]" aria-hidden="true" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-[var(--warning)]" aria-hidden="true" />
          )}
          <h2 className="text-sm font-medium text-foreground">Execution authority</h2>
          {status && (
            <Badge variant="outline" className={authorityTone(status.authority)}>
              {authorityLabel(status.authority)}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11"
            onClick={() => void refresh()}
            aria-label="Refresh execution authority status"
          >
            <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
          {status?.authority === "legacy" && (
            <Button
              type="button"
              size="sm"
              className="h-11"
              disabled={busy !== null}
              onClick={() => void run("stage")}
            >
              {busy === "stage" ? "Staging…" : "Stage validated cutover"}
            </Button>
          )}
          {status?.authority === "migrating" && operation && (
            <>
              <Button
                type="button"
                size="sm"
                className="h-11"
                disabled={busy !== null || blocked}
                onClick={() => void run("activate")}
              >
                {busy === "activate" ? "Activating…" : "Activate local authority"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11"
                disabled={busy !== null}
                onClick={() => void run("abort")}
              >
                {busy === "abort" ? "Aborting…" : "Abort cutover"}
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--destructive)]">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-2 text-xs text-text-secondary">
          {message}
        </p>
      )}

      {status && status.authority === "local" && !status.authorityConsistent && (
        <p role="alert" className="mt-2 text-xs text-[var(--destructive)]">
          The local marker is not backed by an activated cutover row. External writers stay fenced;
          re-run activation to reconcile or restore a validated snapshot.
        </p>
      )}

      {status && status.held.length > 0 && (
        <div className="mt-3 rounded-[var(--radius-news)] border border-[var(--warning)] p-3">
          <h3 className="text-xs font-medium text-foreground">Held writers and ambiguous state</h3>
          <ul className="mt-1 space-y-1 text-xs text-text-secondary">
            {status.held.map((fact) => (
              <li key={`${fact.entity}:${fact.identity}`}>
                <span className="font-medium text-foreground">{fact.entity}</span>{" "}
                <span className="font-mono">{fact.identity}</span> — {fact.reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-secondary">
            Quiesce the listed processes or repair the ambiguous files, then refresh. Activation
            stays disabled until every held item clears.
          </p>
        </div>
      )}

      {status && (
        <div className="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <dl className="space-y-1">
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Cutover</dt>
              <dd className="font-mono text-foreground">{operation?.id ?? "none"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Phase</dt>
              <dd className="text-foreground">
                {status.markerPhase ?? operation?.status ?? "none"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Schema</dt>
              <dd className="text-foreground">v{status.schemaVersion}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Inventory SHA-256</dt>
              <dd className="font-mono text-foreground">
                {shortSha(operation?.inventorySha256 ?? status.cutoverId)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Restored installation held</dt>
              <dd className="text-foreground">{status.isolatedRestore?.held ? "yes" : "no"}</dd>
            </div>
          </dl>
          <dl className="space-y-1">
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Tables / rows</dt>
              <dd className="text-foreground">
                {status.tables.length} / {operation?.totalRows ?? 0}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Finalized artifacts</dt>
              <dd className="text-foreground">{status.artifacts.count}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Legacy runs / locks / worktrees</dt>
              <dd className="text-foreground">
                {status.legacyState.runs} / {status.legacyState.locks} /{" "}
                {status.legacyState.worktrees}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Backup restorable</dt>
              <dd className="text-foreground">{status.backup?.restorable ? "yes" : "no"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Identity mappings</dt>
              <dd className="text-foreground">{status.mappingSummary.total}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Held records</dt>
              <dd className="text-foreground">{status.held.length}</dd>
            </div>
          </dl>
        </div>
      )}

      {status && status.blockingReasons.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-medium text-foreground">Blocking checks</h3>
          <ul className="mt-1 space-y-1 text-xs text-text-secondary">
            {status.blockingReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {status && status.nextActions.length > 0 && (
        <p className="mt-3 text-xs text-text-secondary">{status.nextActions.join(" · ")}</p>
      )}
    </section>
  );
}
