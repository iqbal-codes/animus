import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  draftDecisionSchema,
  draftPlanSchema,
  draftPlannerMetadataSchema,
  draftRecordSchema,
  type DraftAnswerInput,
  type DraftDecisionSubmission,
  type DraftList,
  type DraftPlan,
  type DraftPlannerMetadata,
  type DraftQuestion,
  type DraftRecord,
  type DraftRefineSubmission,
  type DraftRevisionSubmission,
  type WorkRecord,
} from "@animus/contracts/operator";
import { WorkService } from "../work";
import { DraftError, storageFailure } from "./errors";
import type { DraftPlanner, DraftPlanningRequest } from "./types";
import {
  assertApprovablePlan,
  computePlanHash,
  resolveAnswers,
  validateDraftPlan,
} from "./validate";

interface DraftRow {
  id: string;
  project_id: string;
  work_id: string;
  status: "needs_clarification" | "needs_review" | "approved" | "rejected" | "changes_requested";
  created_at: number;
  updated_at: number;
}

interface RevisionRow {
  id: string;
  draft_id: string;
  project_id: string;
  work_id: string;
  revision_number: number;
  source_work_revision_id: string;
  source_content_hash: string;
  kind: "clarification" | "standalone" | "spec";
  plan_json: string;
  plan_hash: string;
  questions_json: string;
  answers_json: string;
  instructions: string | null;
  planner_metadata: string;
  created_at: number;
}

interface DecisionRow {
  id: string;
  draft_id: string;
  project_id: string;
  decision_number: number;
  revision_id: string;
  revision_number: number;
  decision: "approve" | "reject" | "revise";
  reason: string;
  instructions: string | null;
  actor: string | null;
  decided_at: number;
}

export interface DraftServiceOptions {
  planner?: DraftPlanner;
  stateRoot?: string;
  now?: () => number;
}

function parsePlan(value: unknown): DraftPlan {
  const parsed = draftPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new DraftError("draft_invalid_plan", parsed.error.message);
  }
  return parsed.data;
}

function parseMetadata(value: unknown): DraftPlannerMetadata {
  const parsed = draftPlannerMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new DraftError("draft_invalid_plan", parsed.error.message);
  }
  return parsed.data;
}

export class DraftService {
  private readonly planner?: DraftPlanner;
  private readonly stateRoot: string;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    options: DraftServiceOptions = {},
  ) {
    this.planner = options.planner;
    this.stateRoot = options.stateRoot ?? process.cwd();
    this.now = options.now ?? Date.now;
  }

  async refine(projectId: string, submission: DraftRefineSubmission): Promise<DraftRecord> {
    try {
      const work = this.loadWork(projectId, submission.work_id);
      const existingDraft = this.findDraftByWork(projectId, work.id);
      const priorRevision = existingDraft ? this.latestRevision(existingDraft.id, projectId) : null;
      const priorDecision = existingDraft ? this.latestDecision(existingDraft.id, projectId) : null;

      if (!this.planner) {
        throw new DraftError(
          "draft_planning_unavailable",
          "Draft planning transport is not configured",
        );
      }

      const answers = resolveAnswers(
        priorRevision ? this.questionsOf(priorRevision) : [],
        submission.answers ?? [],
      );
      const instructions =
        submission.instructions ??
        (priorDecision?.decision === "revise" &&
        priorRevision &&
        priorDecision.revision_id === priorRevision.id
          ? (priorDecision.instructions ?? undefined)
          : undefined);

      const planningRequest: DraftPlanningRequest = {
        project_id: projectId,
        work_id: work.id,
        repo_name: work.repo_name,
        checkout_path: this.checkoutPath(work.project_id),
        state_root: this.stateRoot,
        work,
        prior: priorRevision
          ? {
              revision: this.mapRevision(priorRevision),
              answers,
              ...(instructions ? { instructions } : {}),
            }
          : null,
      };

      const result = await this.runPlanner(planningRequest);
      const plan = parsePlan(result.plan);
      validateDraftPlan(plan);
      const metadata = parseMetadata(result.metadata);

      return this.persistRevision({
        projectId,
        work,
        existingDraft,
        expectedPriorRevisionId: priorRevision?.id ?? null,
        plan,
        answers,
        instructions: instructions ?? null,
        metadata,
      });
    } catch (error) {
      throw this.normalize(error);
    }
  }

  async revise(
    projectId: string,
    draftId: string,
    submission: DraftRevisionSubmission,
  ): Promise<DraftRecord> {
    try {
      const draft = this.loadDraft(projectId, draftId);
      const work = this.loadWork(projectId, draft.work_id);
      const priorRevision = this.latestRevision(draft.id, projectId);
      if (!priorRevision) throw storageFailure(new Error("Draft has no revision"));
      const priorDecision = this.latestDecision(draft.id, projectId);

      if (!this.planner) {
        throw new DraftError(
          "draft_planning_unavailable",
          "Draft planning transport is not configured",
        );
      }

      const answers = resolveAnswers(this.questionsOf(priorRevision), submission.answers ?? []);
      const instructions =
        submission.instructions ??
        (priorDecision?.decision === "revise" && priorDecision.revision_id === priorRevision.id
          ? (priorDecision.instructions ?? undefined)
          : undefined);

      const result = await this.runPlanner({
        project_id: projectId,
        work_id: work.id,
        repo_name: work.repo_name,
        checkout_path: this.checkoutPath(work.project_id),
        state_root: this.stateRoot,
        work,
        prior: {
          revision: this.mapRevision(priorRevision),
          answers,
          ...(instructions ? { instructions } : {}),
        },
      });
      const plan = parsePlan(result.plan);
      validateDraftPlan(plan);
      const metadata = parseMetadata(result.metadata);

      return this.persistRevision({
        projectId,
        work,
        existingDraft: draft,
        expectedPriorRevisionId: priorRevision.id,
        plan,
        answers,
        instructions: instructions ?? null,
        metadata,
      });
    } catch (error) {
      throw this.normalize(error);
    }
  }

  decide(projectId: string, draftId: string, submission: DraftDecisionSubmission): DraftRecord {
    try {
      const draft = this.loadDraft(projectId, draftId);
      const revision = this.latestRevision(draft.id, projectId);
      if (!revision) throw storageFailure(new Error("Draft has no revision"));

      if (submission.revision_id === undefined && submission.revision_number === undefined) {
        throw new DraftError(
          "draft_stale_revision",
          "A draft decision must target an exact revision",
        );
      }

      const targetMatchesId =
        submission.revision_id === undefined || submission.revision_id === revision.id;
      const targetMatchesNumber =
        submission.revision_number === undefined ||
        submission.revision_number === revision.revision_number;
      if (!targetMatchesId || !targetMatchesNumber) {
        throw new DraftError(
          "draft_stale_revision",
          "The decision targets a superseded draft revision; inspect the latest revision before deciding",
        );
      }

      const plan = this.planOf(revision);
      if (submission.decision === "approve") {
        assertApprovablePlan(plan);
        validateDraftPlan(plan);
      }
      if (submission.decision === "revise" && !submission.instructions) {
        throw new DraftError(
          "draft_invalid_plan",
          "A revise decision requires operator instructions for the next draft revision",
        );
      }

      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const latest = this.latestRevision(draft.id, projectId);
        if (!latest || latest.id !== revision.id) {
          throw new DraftError(
            "draft_concurrent_update",
            "The draft changed while the decision was being recorded",
          );
        }
        const numberRow = this.db
          .prepare(
            "SELECT COALESCE(MAX(decision_number), 0) + 1 AS next FROM work_draft_decisions WHERE draft_id = ?",
          )
          .get(draft.id) as { next: number };
        this.db
          .prepare(
            `INSERT INTO work_draft_decisions
               (id, draft_id, project_id, decision_number, revision_id, revision_number,
                decision, reason, instructions, actor, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `ddecision_${randomUUID()}`,
            draft.id,
            projectId,
            numberRow.next,
            revision.id,
            revision.revision_number,
            submission.decision,
            submission.reason,
            submission.instructions ?? null,
            submission.actor ?? null,
            this.now(),
          );

        const status =
          submission.decision === "approve"
            ? "approved"
            : submission.decision === "reject"
              ? "rejected"
              : "changes_requested";
        this.db
          .prepare(
            "UPDATE work_drafts SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?",
          )
          .run(status, this.now(), draft.id, projectId);
        this.db.exec("COMMIT;");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {}
        throw error;
      }

      return this.readRecord(projectId, draft.id);
    } catch (error) {
      throw this.normalize(error);
    }
  }

  list(projectId: string): DraftList {
    try {
      const rows = this.db
        .prepare("SELECT id FROM work_drafts WHERE project_id = ? ORDER BY created_at ASC, id ASC")
        .all(projectId) as Array<{ id: string }>;
      return rows.map((row) => this.readRecord(projectId, row.id));
    } catch (error) {
      throw this.normalize(error);
    }
  }

  get(projectId: string, draftId: string): DraftRecord {
    return this.readRecord(projectId, draftId);
  }

  getByWork(projectId: string, workId: string): DraftRecord | null {
    try {
      const row = this.findDraftByWork(projectId, workId);
      return row ? this.readRecord(projectId, row.id) : null;
    } catch (error) {
      throw this.normalize(error);
    }
  }

  private async runPlanner(request: DraftPlanningRequest) {
    if (!this.planner) {
      throw new DraftError(
        "draft_planning_unavailable",
        "Draft planning transport is not configured",
      );
    }
    try {
      return await this.planner(request);
    } catch (error) {
      if (error instanceof DraftError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("DRAFT PREPARED WORK:")) {
        throw new DraftError(
          "draft_prepared_work",
          message.replace(/^DRAFT PREPARED WORK:\s*/, ""),
        );
      }
      const invalid = /Invalid draft planning output|not canonical|missing a non-empty/i.test(
        message,
      );
      throw new DraftError(invalid ? "draft_invalid_plan" : "draft_planning_failed", message);
    }
  }

  private persistRevision(input: {
    projectId: string;
    work: WorkRecord;
    existingDraft: DraftRow | null;
    expectedPriorRevisionId: string | null;
    plan: DraftPlan;
    answers: DraftAnswerInput[];
    instructions: string | null;
    metadata: ReturnType<typeof draftPlannerMetadataSchema.parse>;
  }): DraftRecord {
    const {
      projectId,
      work,
      existingDraft,
      expectedPriorRevisionId,
      plan,
      answers,
      instructions,
      metadata,
    } = input;
    const now = this.now();
    const questions: DraftQuestion[] = plan.kind === "clarification" ? plan.questions : [];
    const status = plan.kind === "clarification" ? "needs_clarification" : "needs_review";
    const planHash = computePlanHash(plan);

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const currentDraft = this.findDraftByWork(projectId, work.id);
      if (existingDraft) {
        if (!currentDraft || currentDraft.id !== existingDraft.id) {
          throw new DraftError(
            "draft_concurrent_update",
            "The draft changed while a new revision was being planned",
          );
        }
        const currentRevision = this.latestRevision(currentDraft.id, projectId);
        if ((currentRevision?.id ?? null) !== expectedPriorRevisionId) {
          throw new DraftError(
            "draft_concurrent_update",
            "The draft revision changed while a new revision was being planned",
          );
        }
      } else if (currentDraft) {
        throw new DraftError(
          "draft_concurrent_update",
          "Another draft revision was created concurrently for this work item",
        );
      }

      const draftId = currentDraft?.id ?? `draft_${randomUUID()}`;
      if (!currentDraft) {
        this.db
          .prepare(
            `INSERT INTO work_drafts (id, project_id, work_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(draftId, projectId, work.id, status, now, now);
      }

      const numberRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM work_draft_revisions WHERE draft_id = ?",
        )
        .get(draftId) as { next: number };

      this.db
        .prepare(
          `INSERT INTO work_draft_revisions
             (id, draft_id, project_id, work_id, revision_number, source_work_revision_id,
              source_content_hash, kind, plan_json, plan_hash, questions_json, answers_json,
              instructions, planner_metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `drev_${randomUUID()}`,
          draftId,
          projectId,
          work.id,
          numberRow.next,
          work.revision.id,
          work.revision.content_hash,
          plan.kind,
          JSON.stringify(plan),
          planHash,
          JSON.stringify(questions),
          JSON.stringify(answers),
          instructions,
          JSON.stringify(metadata),
          now,
        );

      this.db
        .prepare(
          "UPDATE work_drafts SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?",
        )
        .run(status, now, draftId, projectId);
      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }

    return this.readRecord(projectId, this.findDraftByWork(projectId, work.id)?.id ?? "");
  }

  private readRecord(projectId: string, draftId: string): DraftRecord {
    try {
      const draft = this.db
        .prepare("SELECT * FROM work_drafts WHERE id = ? AND project_id = ?")
        .get(draftId, projectId) as DraftRow | undefined;
      if (!draft) {
        throw new DraftError("draft_not_found", `Draft ${draftId} not found`);
      }
      const revision = this.latestRevision(draft.id, projectId);
      if (!revision) throw storageFailure(new Error("Draft has no revision"));
      const decision = this.latestDecision(draft.id, projectId);
      const work = this.loadWork(projectId, draft.work_id);
      const latestDecision = decision ? this.mapDecision(decision) : null;
      const approved =
        latestDecision?.decision === "approve" && latestDecision.revision_id === revision.id;

      return draftRecordSchema.parse({
        id: draft.id,
        project_id: draft.project_id,
        work_id: draft.work_id,
        status: draft.status,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        source: work.revision.source,
        source_provenance: work.revision.provenance,
        source_work_revision_id: revision.source_work_revision_id,
        source_content_hash: revision.source_content_hash,
        latest_revision: this.mapRevision(revision),
        latest_decision: latestDecision,
        authorization: {
          approved,
          approved_revision_id: approved ? revision.id : null,
          can_publish: approved,
        },
      });
    } catch (error) {
      throw this.normalize(error);
    }
  }

  private loadWork(projectId: string, workId: string): WorkRecord {
    const work = new WorkService(this.db);
    try {
      return work.getWorkById(projectId, workId);
    } catch {
      throw new DraftError(
        "draft_work_not_found",
        `Imported work ${workId} was not found for project ${projectId}`,
      );
    }
  }

  private checkoutPath(projectId: string): string {
    const row = this.db
      .prepare("SELECT checkout_path FROM projects WHERE id = ?")
      .get(projectId) as { checkout_path: string } | undefined;
    if (!row) throw new DraftError("draft_work_not_found", "Project checkout is unavailable");
    return row.checkout_path;
  }

  private loadDraft(projectId: string, draftId: string): DraftRow {
    const row = this.db
      .prepare("SELECT * FROM work_drafts WHERE id = ? AND project_id = ?")
      .get(draftId, projectId) as DraftRow | undefined;
    if (!row) throw new DraftError("draft_not_found", `Draft ${draftId} not found`);
    return row;
  }

  private findDraftByWork(projectId: string, workId: string): DraftRow | null {
    const row = this.db
      .prepare("SELECT * FROM work_drafts WHERE project_id = ? AND work_id = ?")
      .get(projectId, workId) as DraftRow | undefined;
    return row ?? null;
  }

  private latestRevision(draftId: string, projectId: string): RevisionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM work_draft_revisions
         WHERE draft_id = ? AND project_id = ?
         ORDER BY revision_number DESC LIMIT 1`,
      )
      .get(draftId, projectId) as RevisionRow | undefined;
    return row ?? null;
  }

  private latestDecision(draftId: string, projectId: string): DecisionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM work_draft_decisions
         WHERE draft_id = ? AND project_id = ?
         ORDER BY decision_number DESC LIMIT 1`,
      )
      .get(draftId, projectId) as DecisionRow | undefined;
    return row ?? null;
  }

  private questionsOf(revision: RevisionRow): DraftQuestion[] {
    return JSON.parse(revision.questions_json) as DraftQuestion[];
  }

  private planOf(revision: RevisionRow): DraftPlan {
    return parsePlan(JSON.parse(revision.plan_json));
  }

  private mapRevision(row: RevisionRow) {
    return {
      id: row.id,
      draft_id: row.draft_id,
      project_id: row.project_id,
      work_id: row.work_id,
      revision_number: row.revision_number,
      source_work_revision_id: row.source_work_revision_id,
      source_content_hash: row.source_content_hash,
      kind: row.kind,
      plan: this.planOf(row),
      plan_hash: row.plan_hash,
      questions: this.questionsOf(row),
      answers: JSON.parse(row.answers_json),
      instructions: row.instructions,
      planner_metadata: parseMetadata(JSON.parse(row.planner_metadata)),
      created_at: row.created_at,
    };
  }

  private mapDecision(row: DecisionRow) {
    return draftDecisionSchema.parse({
      id: row.id,
      draft_id: row.draft_id,
      project_id: row.project_id,
      revision_id: row.revision_id,
      revision_number: row.revision_number,
      decision: row.decision,
      reason: row.reason,
      instructions: row.instructions,
      actor: row.actor,
      decided_at: row.decided_at,
    });
  }

  private normalize(error: unknown): DraftError {
    if (error instanceof DraftError) return error;
    return storageFailure(error);
  }
}
