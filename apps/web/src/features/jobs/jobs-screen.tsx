import { useState } from "react";
import { JobsBoard } from "./jobs-board";
import { JobsHeader } from "./jobs-header";
import { WorkDetailDialog } from "./work-detail-dialog";
import { DispatchControl } from "@/features/dispatch/dispatch-control";
import { BackupPanel } from "@/features/backup/backup-panel";
import type { JobsBoardModel } from "./jobs-model";
import type { BackendState } from "./factory-status";
import type { CardDensity } from "@/lib/preferences";

/** The whole `TAufE` frame below the shell rail: 76 px header + board content. */
export function JobsScreen({
  board,
  backendState,
  density,
  projectId = null,
  loading = false,
  error = null,
  onRefresh,
}: {
  board: JobsBoardModel;
  backendState: BackendState;
  density?: CardDensity;
  projectId?: string | null;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}) {
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <JobsHeader board={board} />
      <DispatchControl />
      <DispatchControl />
      <BackupPanel />
      <JobsBoard
        board={board}
        backendState={backendState}
        density={density}
        loading={loading}
        error={error}
        onRefresh={onRefresh}
        onOpenWork={setSelectedWorkId}
      />
      {selectedWorkId && projectId && (
        <WorkDetailDialog
          workId={selectedWorkId}
          projectId={projectId}
          onClose={() => setSelectedWorkId(null)}
        />
      )}
    </div>
  );
}
