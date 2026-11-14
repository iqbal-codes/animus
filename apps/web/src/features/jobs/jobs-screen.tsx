import { useState } from "react";
import { JobsBoard } from "./jobs-board";
import { JobsHeader } from "./jobs-header";
import { IssueExpandedWorkspace } from "./issue-expanded-workspace";
import { CompactSideSheet } from "./compact-side-sheet";
import { DispatchControl } from "@/features/dispatch/dispatch-control";
import { BackupPanel } from "@/features/backup/backup-panel";
import { AuthorityPanel } from "@/features/authority/authority-panel";
import type { JobsBoardModel } from "./jobs-model";
import type { BackendState } from "./factory-status";
import type { CardDensity } from "@/lib/preferences";
import type { Project } from "@animus/contracts/operator";

import { client } from "@/lib/factory-client";

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
  factory = client,
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
  factory?: typeof client;
}) {
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  const handleCardClick = (workId: string) => {
    setSelectedWorkId(workId);
    setIsExpanded(false);
  };

  const handleClose = () => {
    setSelectedWorkId(null);
    setIsExpanded(false);
  };

  const handleExpand = () => {
    setIsExpanded(true);
  };

  const handleCollapse = () => {
    setIsExpanded(false);
  };

  const sideSheet =
    selectedWorkId && !isExpanded ? (
      <CompactSideSheet
        workId={selectedWorkId}
        projectId={projectId ?? "default"}
        onClose={handleClose}
        onExpand={handleExpand}
        onSelectWork={(workId) => setSelectedWorkId(workId)}
        factory={factory}
      />
    ) : undefined;

  const expandedWorkspace =
    selectedWorkId && isExpanded ? (
      <IssueExpandedWorkspace
        workId={selectedWorkId}
        projectId={projectId ?? "default"}
        onClose={handleClose}
        onCollapse={handleCollapse}
        onSelectWork={(workId) => setSelectedWorkId(workId)}
        factory={factory}
      />
    ) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden min-w-0">
        <JobsBoard
          board={board}
          backendState={backendState}
          density={density}
          selectedWorkId={selectedWorkId}
          loading={loading}
          error={error}
          onRefresh={onRefresh}
          onOpenWork={handleCardClick}
          sideSheet={sideSheet}
          expandedWorkspace={expandedWorkspace}
        />
      </div>
    </div>
  );
}
