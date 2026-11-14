import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { OperatorWorkDetail } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { IssueInspector } from "./issue-inspector";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; detail: OperatorWorkDetail };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compact issue inspector (`JLixj` / `wg1Pv`): 500 px docked panel with a left
 * hairline only — no card radius, no second toolbar. The pinned header lives
 * inside the inspector so the anatomy matches the source exactly.
 */
export function CompactSideSheet({
  workId,
  projectId,
  onClose,
  onExpand,
  onSelectWork,
  factory = client,
}: {
  workId: string;
  projectId: string;
  onClose: () => void;
  onExpand: () => void;
  onSelectWork?: (workId: string) => void;
  factory?: typeof client;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <aside
      data-testid="compact-side-sheet"
      aria-label="Compact Issue Inspector"
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--elevation-stage)]"
    >
      {state.phase === "loading" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10">
          <Spinner className="size-5 text-[var(--text-secondary)]" />
          <p className="text-[11px] leading-[1.5] text-[var(--text-muted)]">
            Loading issue from canonical factory state…
          </p>
        </div>
      ) : state.phase === "error" ? (
        <div className="flex flex-1 flex-col items-start gap-3 px-4 py-6 sm:px-[22px]">
          <Alert variant="destructive" className="py-2.5">
            <AlertTitle className="text-xs font-semibold">Issue unavailable</AlertTitle>
            <AlertDescription role="alert" className="text-xs">
              {state.message}
            </AlertDescription>
          </Alert>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            <span>Retry</span>
          </Button>
        </div>
      ) : (
        <ScrollArea
          className="min-h-0 flex-1 overscroll-contain"
          data-testid="compact-side-sheet-scroll"
        >
          <IssueInspector
            detail={state.detail}
            projectId={projectId}
            onRefresh={load}
            onSelectWork={onSelectWork}
            isCompact
            onClose={onClose}
            onExpand={onExpand}
            factory={factory}
          />
        </ScrollArea>
      )}
    </aside>
  );
}
