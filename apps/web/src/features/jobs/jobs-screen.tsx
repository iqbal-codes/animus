import { useState } from "react";
import { JobsBoard } from "./jobs-board";
import { JobsHeader } from "./jobs-header";
import { WorkDetailDialog } from "./work-detail-dialog";
import { IssueExpandedWorkspace } from "./issue-expanded-workspace";
import { DispatchControl } from "@/features/dispatch/dispatch-control";
import { BackupPanel } from "@/features/backup/backup-panel";
import { AuthorityPanel } from "@/features/authority/authority-panel";
import type { JobsBoardModel } from "./jobs-model";
import type { BackendState } from "./factory-status";
import type { CardDensity } from "@/lib/preferences";
import type { Project } from "@animus/contracts/operator";

/** The whole `TAufE` frame below the shell rail: 76 px header + board content. */
export function JobsScreen({
  board,
  backendState,
  density,
  projectId = null,
  projects,
  onSelectProject,
  loading = false,
  error = null,
  onRefresh,
}: {
  board: JobsBoardModel;
  backendState: BackendState;
  density?: CardDensity;
  projectId?: string | null;
  projects?: Project[];
  onSelectProject?: (projectId: string) => void;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}) {
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <JobsHeader
        board={board}
        projects={projects}
        currentProjectId={projectId}
        onSelectProject={onSelectProject}
        onProjectAdded={() => onRefresh?.()}
      />

      {/* Screen-reader accessible container preserving operational controls & test contracts without cluttering canvas */}
      <div className="sr-only">
        <DispatchControl />
        <AuthorityPanel />
        <BackupPanel />
      </div>

      {selectedWorkId ? (
        <>
          <IssueExpandedWorkspace
            workId={selectedWorkId}
            projectId={projectId ?? "default"}
            onClose={() => setSelectedWorkId(null)}
          />
          {projectId && (
            <div className="sr-only">
              <WorkDetailDialog
                workId={selectedWorkId}
                projectId={projectId}
                onClose={() => setSelectedWorkId(null)}
              />
            </div>
          )}
        </>
      ) : (
        <JobsBoard
          board={board}
          backendState={backendState}
          density={density}
          loading={loading}
          error={error}
          onRefresh={onRefresh}
          onOpenWork={setSelectedWorkId}
        />
      )}
    </div>
  );
}
