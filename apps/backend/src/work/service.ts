import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  workRecordSchema,
  type WorkProvenance,
  type WorkRecord,
  type WorkSourceComment,
  type WorkSourceSnapshot,
} from "@animus/contracts/operator";

export type WorkPersistenceCode =
  | "work_invalid_source"
  | "work_project_mismatch"
  | "work_identity_conflict"
  | "work_not_found"
  | "work_storage_failed";

export class WorkPersistenceError extends Error {
  constructor(
    public readonly code: WorkPersistenceCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WorkPersistenceError";
  }
}

export interface WorkProjectScope {
  id: string;
  repo_id: number;
  repo_name: string;
}

export interface WorkIssueSource {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  body?: unknown;
  labels?: unknown;
  comments?: unknown;
}

interface ProjectRow {
  id: string;
  repo_id: number;
  repo_name: string;
  status: string;
}

interface PreparedWork {
  source: WorkSourceSnapshot;
  provenance: WorkProvenance;
  contentHash: string;
}

interface WorkJoinRow {
  id: string;
  project_id: string;
  repo_id: number;
  repo_name: string;
  issue_number: number;
  created_at: number;
  updated_at: number;
  revision_id: string;
  revision_number: number;
  content_hash: string;
  source_title: string;
  source_body: string;
  source_state: "OPEN" | "CLOSED";
  source_labels: string;
  source_comments: string;
  source_url: string;
  provenance: string;
  imported_at: number;
}

function invalidSource(detail: string): never {
  throw new WorkPersistenceError("work_invalid_source", detail);
}

function storageFailure(error: unknown): WorkPersistenceError {
  return new WorkPersistenceError(
    "work_storage_failed",
    error instanceof Error ? error.message : String(error),
  );
}

function normalizeLabels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidSource("Issue labels are not an array");
  return value.map((label) => {
    const name =
      typeof label === "string"
        ? label
        : label && typeof label === "object" && "name" in label
          ? (label as { name?: unknown }).name
          : undefined;
    if (typeof name !== "string" || name.trim() === "") invalidSource("Issue label is malformed");
    return name.trim();
  });
}

function normalizeComments(value: unknown): WorkSourceComment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidSource("Issue comments are not an array");
  return value.map((comment) => {
    if (!comment || typeof comment !== "object") invalidSource("Issue comment is malformed");
    const entry = comment as { id?: unknown; author?: unknown; body?: unknown };
    if (typeof entry.body !== "string") invalidSource("Issue comment body is missing");
    if (entry.id !== undefined && typeof entry.id !== "string")
      invalidSource("Issue comment id is malformed");
    if (entry.author !== undefined && typeof entry.author !== "string")
      invalidSource("Issue comment author is malformed");
    return {
      id: entry.id ?? null,
      author: entry.author ?? null,
      body: entry.body,
    };
  });
}

export class WorkService {
  constructor(private readonly db: DatabaseSync) {}

  importIssue(scope: WorkProjectScope, issue: WorkIssueSource): WorkRecord {
    let prepared: PreparedWork;
    try {
      this.verifyProject(scope);
      prepared = this.prepareSource(scope, issue);
    } catch (error) {
      if (error instanceof WorkPersistenceError) throw error;
      throw storageFailure(error);
    }

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (error) {
      throw storageFailure(error);
    }

    try {
      const existing = (
        scope.repo_id > 0
          ? this.db
              .prepare(
                "SELECT id, project_id FROM work_items WHERE repo_id = ? AND issue_number = ?",
              )
              .get(scope.repo_id, prepared.provenance.issue_number)
          : this.db
              .prepare(
                "SELECT id, project_id FROM work_items WHERE project_id = ? AND issue_number = ?",
              )
              .get(scope.id, prepared.provenance.issue_number)
      ) as { id: string; project_id: string } | undefined;
      if (existing) {
        if (existing.project_id !== scope.id) {
          throw new WorkPersistenceError(
            "work_identity_conflict",
            "GitHub issue identity already belongs to another project",
          );
        }
        const record = this.readRecord(existing.id, scope.id);
        if (!record) throw storageFailure(new Error("Existing work revision is missing"));
        this.db.exec("COMMIT;");
        return record;
      }

      const now = Date.now();
      const workId = `work_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO work_items
             (id, project_id, repo_id, repo_name, issue_number, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workId,
          scope.id,
          prepared.provenance.repo_id,
          prepared.provenance.repo_name,
          prepared.provenance.issue_number,
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO work_revisions
             (id, work_id, project_id, revision_number, content_hash, source_title,
              source_body, source_state, source_labels, source_comments, source_url,
              provenance, imported_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `wrev_${randomUUID()}`,
          workId,
          scope.id,
          prepared.contentHash,
          prepared.source.title,
          prepared.source.body,
          prepared.source.state,
          JSON.stringify(prepared.source.labels),
          JSON.stringify(prepared.source.comments),
          prepared.provenance.source_url,
          JSON.stringify(prepared.provenance),
          prepared.provenance.captured_at,
        );

      const record = this.readRecord(workId, scope.id);
      if (!record) throw storageFailure(new Error("Inserted work revision is unreadable"));
      this.db.exec("COMMIT;");
      return record;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      if (error instanceof WorkPersistenceError) throw error;
      throw storageFailure(error);
    }
  }

  listWork(projectId: string): WorkRecord[] {
    try {
      const rows = this.db
        .prepare(
          `${this.selectWorkSql()}
           WHERE w.project_id = ?
           ORDER BY w.issue_number ASC`,
        )
        .all(projectId) as unknown as WorkJoinRow[];
      return rows.map((row) => this.mapRecord(row));
    } catch (error) {
      if (error instanceof WorkPersistenceError) throw error;
      throw storageFailure(error);
    }
  }

  getWorkById(projectId: string, workId: string): WorkRecord {
    const record = this.readRecord(workId, projectId);
    if (!record) throw new WorkPersistenceError("work_not_found", `Work ${workId} not found`);
    return record;
  }

  getWorkByIssue(projectId: string, issueNumber: number): WorkRecord | null {
    try {
      const row = this.db
        .prepare("SELECT id FROM work_items WHERE project_id = ? AND issue_number = ?")
        .get(projectId, issueNumber) as { id: string } | undefined;
      return row ? this.readRecord(row.id, projectId) : null;
    } catch (error) {
      if (error instanceof WorkPersistenceError) throw error;
      throw storageFailure(error);
    }
  }

  private verifyProject(scope: WorkProjectScope): void {
    if (
      typeof scope.id !== "string" ||
      !Number.isSafeInteger(scope.repo_id) ||
      scope.repo_id < 0 ||
      typeof scope.repo_name !== "string"
    ) {
      throw new WorkPersistenceError("work_project_mismatch", "Invalid project scope");
    }
    const row = this.db
      .prepare("SELECT id, repo_id, repo_name, status FROM projects WHERE id = ?")
      .get(scope.id) as ProjectRow | undefined;
    if (!row || row.status === "tombstone") {
      throw new WorkPersistenceError("work_project_mismatch", "Project is not active");
    }
    if (
      row.repo_id !== scope.repo_id ||
      row.repo_name.toLowerCase() !== scope.repo_name.toLowerCase()
    ) {
      throw new WorkPersistenceError(
        "work_project_mismatch",
        "Issue repository does not match the project repository",
      );
    }
  }

  private prepareSource(scope: WorkProjectScope, issue: WorkIssueSource): PreparedWork {
    if (!issue || typeof issue !== "object") invalidSource("Issue payload is missing");
    if (
      typeof issue.number !== "number" ||
      !Number.isSafeInteger(issue.number) ||
      issue.number <= 0
    )
      invalidSource("Issue number is invalid");
    if (typeof issue.title !== "string" || issue.title.trim() === "")
      invalidSource("Issue title is missing");
    if (typeof issue.body !== "string") invalidSource("Issue body is missing");
    if (issue.state !== "OPEN" && issue.state !== "CLOSED") invalidSource("Issue state is invalid");

    const source: WorkSourceSnapshot = {
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: normalizeLabels(issue.labels),
      comments: normalizeComments(issue.comments),
    };
    const provenance: WorkProvenance = {
      repo_id: scope.repo_id,
      repo_name: scope.repo_name,
      issue_number: issue.number,
      source_url:
        scope.repo_id > 0
          ? `https://github.com/${scope.repo_name}/issues/${issue.number}`
          : `local://${scope.id}/issues/${issue.number}`,
      captured_at: Date.now(),
    };
    const contentHash = createHash("sha256")
      .update(
        JSON.stringify({
          repo_id: provenance.repo_id,
          repo_name: provenance.repo_name,
          issue_number: provenance.issue_number,
          title: source.title,
          body: source.body,
          state: source.state,
          labels: source.labels,
          comments: source.comments,
        }),
      )
      .digest("hex");
    return { source, provenance, contentHash };
  }

  private selectWorkSql(): string {
    return `SELECT w.id, w.project_id, w.repo_id, w.repo_name, w.issue_number,
                   w.created_at, w.updated_at,
                   r.id AS revision_id, r.revision_number, r.content_hash,
                   r.source_title, r.source_body, r.source_state, r.source_labels,
                   r.source_comments, r.source_url, r.provenance, r.imported_at
            FROM work_items w
            JOIN work_revisions r
              ON r.work_id = w.id
             AND r.revision_number = (
               SELECT MAX(revision_number) FROM work_revisions WHERE work_id = w.id
             )`;
  }

  private readRecord(workId: string, projectId: string): WorkRecord | null {
    try {
      const row = this.db
        .prepare(`${this.selectWorkSql()} WHERE w.id = ? AND w.project_id = ?`)
        .get(workId, projectId) as unknown as WorkJoinRow | undefined;
      return row ? this.mapRecord(row) : null;
    } catch (error) {
      if (error instanceof WorkPersistenceError) throw error;
      throw storageFailure(error);
    }
  }

  private mapRecord(row: WorkJoinRow): WorkRecord {
    try {
      return workRecordSchema.parse({
        id: row.id,
        project_id: row.project_id,
        repo_id: row.repo_id,
        repo_name: row.repo_name,
        issue_number: row.issue_number,
        created_at: row.created_at,
        updated_at: row.updated_at,
        revision: {
          id: row.revision_id,
          work_id: row.id,
          project_id: row.project_id,
          revision_number: row.revision_number,
          content_hash: row.content_hash,
          source: {
            title: row.source_title,
            body: row.source_body,
            state: row.source_state,
            labels: JSON.parse(row.source_labels),
            comments: JSON.parse(row.source_comments),
          },
          provenance: JSON.parse(row.provenance),
          imported_at: row.imported_at,
        },
      });
    } catch (error) {
      throw storageFailure(error);
    }
  }
}
