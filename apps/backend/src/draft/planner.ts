import type { DraftPlan, DraftPlannerMetadata } from "@animus/contracts/operator";
import type { DraftPlanner, DraftPlanningRequest } from "./types";

interface DraftModule {
  planDraft: (
    input: {
      root: string;
      repo: string;
      stateRoot: string;
      workId: string;
      source: unknown;
      sourceRevisionId: string;
      sourceContentHash: string;
      provenance: { issue_number: number; source_url: string };
      prior: unknown;
    },
    options?: unknown,
  ) => Promise<{ plan: DraftPlan; metadata: DraftPlannerMetadata }>;
}

async function loadDraftModule(): Promise<DraftModule> {
  const factory = new URL("../../../../", import.meta.url);
  const module = (await import(new URL("scripts/loop/draft.ts", factory).href)) as DraftModule;
  return module;
}

export async function defaultDraftPlanner(
  request: DraftPlanningRequest,
): Promise<{ plan: DraftPlan; metadata: DraftPlannerMetadata }> {
  const { planDraft } = await loadDraftModule();
  const result = await planDraft({
    root: request.checkout_path,
    repo: request.repo_name,
    stateRoot: request.state_root,
    workId: request.work_id,
    source: request.work.revision.source,
    sourceRevisionId: request.work.revision.id,
    sourceContentHash: request.work.revision.content_hash,
    provenance: {
      issue_number: request.work.revision.provenance.issue_number,
      source_url: request.work.revision.provenance.source_url,
    },
    prior: request.prior
      ? {
          questions: request.prior.revision.questions,
          answers: request.prior.revision.answers,
          instructions: request.prior.instructions,
          kind: request.prior.revision.kind,
        }
      : null,
  });
  return { plan: result.plan, metadata: result.metadata };
}

export const defaultDraftPlannerAdapter: DraftPlanner = defaultDraftPlanner;
