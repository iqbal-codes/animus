import type {
  DraftAnswerInput,
  DraftPlan,
  DraftPlannerMetadata,
  DraftRevision,
  WorkRecord,
} from "@animus/contracts/operator";

export interface DraftPlanningRequest {
  project_id: string;
  work_id: string;
  repo_name: string;
  checkout_path: string;
  state_root: string;
  work: WorkRecord;
  prior: {
    revision: DraftRevision;
    answers: DraftAnswerInput[];
    instructions?: string;
  } | null;
}

export interface DraftPlanningResult {
  plan: DraftPlan;
  metadata: DraftPlannerMetadata;
}

export type DraftPlanner = (request: DraftPlanningRequest) => Promise<DraftPlanningResult>;
