import { JobsBoard } from "./jobs-board";
import { JobsHeader } from "./jobs-header";
import type { JobsBoardModel } from "./jobs-model";
import type { BackendState } from "./factory-status";
import type { CardDensity } from "@/lib/preferences";

/** The whole `TAufE` frame below the shell rail: 76 px header + board content. */
export function JobsScreen({
  board,
  backendState,
  density,
}: {
  board: JobsBoardModel;
  backendState: BackendState;
  density?: CardDensity;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <JobsHeader board={board} />
      <JobsBoard board={board} backendState={backendState} density={density} />
    </div>
  );
}
