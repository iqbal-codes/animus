import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { OperatorWorkDetail } from "@animus/contracts/operator";
import { client } from "@/lib/factory-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { mapHarnessMetrics, type IssueHarnessMetrics } from "./jobs-model";
import { IssueInspector } from "./issue-inspector";
import { FactoryRail } from "./factory-rail";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; detail: OperatorWorkDetail };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Expanded issue workspace (`ITMzl`, `qNjDd`, `drpVe`, `En4yq`, `vDp5q`, `iceQ7`).
 *
 * A single 1320 px stage (`rounded-[10px]`, hairline border, `elevation-stage`)
 * split into two 660 px columns separated by a vertical hairline. There is no
 * workspace-level toolbar: the pinned issue header belongs to the left column
 * and the factory rail starts directly with its timeline section.
 */
export function IssueExpandedWorkspace({
  workId,
  projectId,
  onClose,
  onCollapse,
  factory = client,
}: {
  workId: string;
  projectId: string;
  onClose: () => void;
  onCollapse?: () => void;
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

  if (state.phase === "loading") {
    return (
      <div
        data-testid="expanded-workspace-loading"
        className="flex min-h-[420px] flex-1 items-center justify-center rounded-[10px] border border-[var(--border-subtle)] bg-[var(--elevation-stage)] p-12"
      >
        <div className="flex flex-col items-center gap-3">
          <Spinner className="size-5 text-[var(--text-secondary)]" />
          <p className="text-[11px] leading-[1.5] text-[var(--text-muted)]">
            Loading issue workspace from canonical factory state…
          </p>
        </div>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div
        data-testid="expanded-workspace-error"
        className="flex min-h-[420px] flex-1 flex-col items-center justify-center gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--elevation-stage)] p-12"
      >
        <Alert variant="destructive" className="max-w-md py-2.5 text-left">
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
    );
  }

  const detail = state.detail;
  const metrics: IssueHarnessMetrics = mapHarnessMetrics(detail);

  return (
    <div
      data-testid="expanded-issue-workspace"
      className="flex min-h-0 flex-1 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-[var(--elevation-stage)]"
    >
      <div className="grid h-full min-h-0 w-full grid-cols-1 lg:grid-cols-2">
        <section
          aria-label="Issue Inspector"
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          <ScrollArea className="min-h-0 flex-1" data-testid="issue-inspector-scroll">
            <IssueInspector
              detail={detail}
              projectId={projectId}
              onRefresh={load}
              isCompact={false}
              onClose={onClose}
              onCollapse={onCollapse}
              factory={factory}
            />
          </ScrollArea>
        </section>

        <section
          aria-label="Factory Rail"
          className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-[var(--border-subtle)] lg:border-t-0 lg:border-l"
        >
          <ScrollArea className="min-h-0 flex-1" data-testid="factory-rail-scroll">
            <FactoryRail detail={detail} metrics={metrics} />
          </ScrollArea>
        </section>
      </div>
    </div>
  );
}
