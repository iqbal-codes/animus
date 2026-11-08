import type { Migration } from "../registry/migrations";

export const DRAFT_MIGRATIONS: Migration[] = [
  {
    version: 3,
    name: "project_work_drafts_and_decisions",
    up(db) {
      db.exec(`
        CREATE TABLE work_drafts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          work_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'needs_clarification', 'needs_review', 'approved', 'rejected', 'changes_requested'
          )),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(work_id),
          UNIQUE(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_work_drafts_project ON work_drafts(project_id, created_at);
      `);
      db.exec(`
        CREATE TABLE work_draft_revisions (
          id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          revision_number INTEGER NOT NULL CHECK(revision_number > 0),
          source_work_revision_id TEXT NOT NULL REFERENCES work_revisions(id),
          source_content_hash TEXT NOT NULL CHECK(length(source_content_hash) = 64),
          kind TEXT NOT NULL CHECK(kind IN ('clarification', 'standalone', 'spec')),
          plan_json TEXT NOT NULL,
          plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
          questions_json TEXT NOT NULL,
          answers_json TEXT NOT NULL,
          instructions TEXT,
          planner_metadata TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(draft_id, revision_number),
          UNIQUE(id, project_id),
          FOREIGN KEY(draft_id, project_id) REFERENCES work_drafts(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_work_draft_revisions_draft
        ON work_draft_revisions(draft_id, revision_number DESC);
      `);
      db.exec(`
        CREATE TRIGGER work_draft_revisions_immutable_update
        BEFORE UPDATE ON work_draft_revisions
        BEGIN
          SELECT RAISE(ABORT, 'work_draft_revision_immutable');
        END;
      `);
      db.exec(`
        CREATE TRIGGER work_draft_revisions_immutable_delete
        BEFORE DELETE ON work_draft_revisions
        BEGIN
          SELECT RAISE(ABORT, 'work_draft_revision_immutable');
        END;
      `);
      db.exec(`
        CREATE TABLE work_draft_decisions (
          id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          decision_number INTEGER NOT NULL CHECK(decision_number > 0),
          revision_id TEXT NOT NULL REFERENCES work_draft_revisions(id),
          revision_number INTEGER NOT NULL CHECK(revision_number > 0),
          decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject', 'revise')),
          reason TEXT NOT NULL CHECK(length(reason) > 0),
          instructions TEXT,
          actor TEXT,
          decided_at INTEGER NOT NULL,
          UNIQUE(draft_id, decision_number),
          UNIQUE(id, project_id),
          FOREIGN KEY(draft_id, project_id) REFERENCES work_drafts(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_work_draft_decisions_draft
        ON work_draft_decisions(draft_id, decision_number DESC);
      `);
      db.exec(`
        CREATE TRIGGER work_draft_decisions_immutable_update
        BEFORE UPDATE ON work_draft_decisions
        BEGIN
          SELECT RAISE(ABORT, 'work_draft_decision_immutable');
        END;
      `);
      db.exec(`
        CREATE TRIGGER work_draft_decisions_immutable_delete
        BEFORE DELETE ON work_draft_decisions
        BEGIN
          SELECT RAISE(ABORT, 'work_draft_decision_immutable');
        END;
      `);
    },
  },
];
