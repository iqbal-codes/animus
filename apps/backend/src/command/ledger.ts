import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CommandRecord,
  CommandState,
  CommandOutcome,
  CommandProvenance,
} from "@animus/contracts/operator";

export class CommandStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandStorageError";
  }
}

interface CommandRow {
  request_id: string;
  actor: string;
  project_id: string | null;
  action: string;
  target: string;
  timestamp: string;
  state: CommandState;
  outcome: string | null;
  evidence_links: string;
  created_at: string;
  updated_at: string;
  reconciled_at: string | null;
}

export class CommandLedger {
  constructor(private db: DatabaseSync) {}

  private mapRow(row: CommandRow): CommandRecord {
    let parsedTarget: Record<string, unknown> = {};
    try {
      parsedTarget = JSON.parse(row.target);
    } catch {
      parsedTarget = { raw: row.target };
    }

    let parsedOutcome: CommandOutcome | null = null;
    if (row.outcome) {
      try {
        parsedOutcome = JSON.parse(row.outcome);
      } catch {}
    }

    let parsedEvidenceLinks: string[] = [];
    if (row.evidence_links) {
      try {
        parsedEvidenceLinks = JSON.parse(row.evidence_links);
      } catch {}
    }

    return {
      requestId: row.request_id,
      actor: row.actor,
      projectId: row.project_id,
      action: row.action,
      target: parsedTarget,
      timestamp: row.timestamp,
      state: row.state,
      outcome: parsedOutcome,
      evidenceLinks: parsedEvidenceLinks,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reconciledAt: row.reconciled_at,
    };
  }

  private runInTransaction<T>(action: () => T, errorMessage: string): T {
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      const result = action();
      this.db.exec("COMMIT;");
      return result;
    } catch (err: any) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw new CommandStorageError(`${errorMessage}: ${err?.message ?? String(err)}`);
    }
  }

  recordBeforeDispatch(params: {
    requestId?: string;
    actor: string;
    projectId?: string | null;
    action: string;
    target: Record<string, unknown>;
    timestamp?: string;
  }): CommandRecord {
    const requestId = params.requestId ?? randomUUID();
    const now = new Date().toISOString();
    const timestamp = params.timestamp ?? now;
    const targetJson = JSON.stringify(params.target);
    const projectId = params.projectId ?? null;

    this.runInTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO commands (
          request_id, actor, project_id, action, target, timestamp, state, outcome, evidence_links, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'dispatched', NULL, '[]', ?, ?)
      `);
      stmt.run(requestId, params.actor, projectId, params.action, targetJson, timestamp, now, now);
    }, "Failed to durably record command before dispatch");

    const row = this.db
      .prepare("SELECT * FROM commands WHERE request_id = ?")
      .get(requestId) as unknown as CommandRow | undefined;
    if (!row) {
      throw new CommandStorageError("Command was committed but could not be retrieved");
    }
    return this.mapRow(row);
  }

  recordRejection(params: {
    requestId?: string;
    actor: string;
    projectId?: string | null;
    action: string;
    target: Record<string, unknown>;
    reason: string;
    provenance?: CommandProvenance;
  }): CommandRecord {
    const requestId = params.requestId ?? randomUUID();
    const now = new Date().toISOString();
    const targetJson = JSON.stringify(params.target);
    const projectId = params.projectId ?? null;
    const provenance: CommandProvenance = params.provenance ?? {
      source: "backend",
      timestamp: now,
      actor: params.actor,
      details: params.reason,
    };
    const outcome: CommandOutcome = {
      state: "rejected",
      provenance,
      error: params.reason,
    };
    const outcomeJson = JSON.stringify(outcome);

    this.runInTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO commands (
          request_id, actor, project_id, action, target, timestamp, state, outcome, evidence_links, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?, '[]', ?, ?)
      `);
      stmt.run(
        requestId,
        params.actor,
        projectId,
        params.action,
        targetJson,
        now,
        outcomeJson,
        now,
        now,
      );
    }, "Failed to record command rejection");

    const row = this.db
      .prepare("SELECT * FROM commands WHERE request_id = ?")
      .get(requestId) as unknown as CommandRow | undefined;
    if (!row) {
      throw new CommandStorageError("Rejected command record could not be retrieved");
    }
    return this.mapRow(row);
  }

  updateOutcome(
    requestId: string,
    outcome: CommandOutcome,
    evidenceLinks?: string[],
  ): CommandRecord {
    const now = new Date().toISOString();
    const existing = this.getCommand(requestId);
    if (!existing) {
      throw new CommandStorageError(`Command not found: ${requestId}`);
    }

    const mergedLinks = Array.from(
      new Set([...(existing.evidenceLinks ?? []), ...(evidenceLinks ?? [])]),
    );

    this.runInTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE commands
        SET state = ?, outcome = ?, evidence_links = ?, updated_at = ?
        WHERE request_id = ?
      `);
      stmt.run(outcome.state, JSON.stringify(outcome), JSON.stringify(mergedLinks), now, requestId);
    }, "Failed to update command outcome");

    const updated = this.getCommand(requestId);
    if (!updated) {
      throw new CommandStorageError(`Failed to fetch updated command: ${requestId}`);
    }
    return updated;
  }

  addEvidenceLink(requestId: string, link: string): void {
    const existing = this.getCommand(requestId);
    if (!existing) {
      throw new CommandStorageError(`Command not found: ${requestId}`);
    }
    if (!existing.evidenceLinks.includes(link)) {
      const updatedLinks = [...existing.evidenceLinks, link];
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE commands SET evidence_links = ?, updated_at = ? WHERE request_id = ?")
        .run(JSON.stringify(updatedLinks), now, requestId);
    }
  }

  markReconciled(
    requestId: string,
    outcome: CommandOutcome,
    evidenceLinks?: string[],
  ): CommandRecord {
    const now = new Date().toISOString();
    const existing = this.getCommand(requestId);
    if (!existing) {
      throw new CommandStorageError(`Command not found: ${requestId}`);
    }

    const mergedLinks = Array.from(
      new Set([...(existing.evidenceLinks ?? []), ...(evidenceLinks ?? [])]),
    );

    this.runInTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE commands
        SET state = ?, outcome = ?, evidence_links = ?, reconciled_at = ?, updated_at = ?
        WHERE request_id = ?
      `);
      stmt.run(
        outcome.state,
        JSON.stringify(outcome),
        JSON.stringify(mergedLinks),
        now,
        now,
        requestId,
      );
    }, "Failed to mark command as reconciled");

    const updated = this.getCommand(requestId);
    if (!updated) {
      throw new CommandStorageError(`Failed to retrieve reconciled command: ${requestId}`);
    }
    return updated;
  }

  getCommand(requestId: string): CommandRecord | null {
    const row = this.db
      .prepare("SELECT * FROM commands WHERE request_id = ?")
      .get(requestId) as unknown as CommandRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listCommands(opts?: {
    projectId?: string | null;
    state?: CommandState;
    limit?: number;
  }): CommandRecord[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts?.projectId !== undefined) {
      if (opts.projectId === null) {
        conditions.push("project_id IS NULL");
      } else {
        conditions.push("project_id = ?");
        params.push(opts.projectId);
      }
    }

    if (opts?.state) {
      conditions.push("state = ?");
      params.push(opts.state);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = opts?.limit && opts.limit > 0 ? `LIMIT ${opts.limit}` : "";

    const sql = `SELECT * FROM commands ${whereClause} ORDER BY created_at DESC ${limitClause}`;
    const rows = this.db.prepare(sql).all(...params) as unknown as CommandRow[];
    return rows.map((r) => this.mapRow(r));
  }

  getActiveOrDispatchedCommands(): CommandRecord[] {
    const sql = `
      SELECT * FROM commands
      WHERE state IN ('dispatched', 'acknowledged', 'running', 'unknown', 'partial')
      ORDER BY created_at ASC
    `;
    const rows = this.db.prepare(sql).all() as unknown as CommandRow[];
    return rows.map((r) => this.mapRow(r));
  }

  backup(destinationPath: string): void {
    const dir = dirname(destinationPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (existsSync(destinationPath)) {
      unlinkSync(destinationPath);
    }
    // VACUUM INTO produces a consistent snapshot of SQLite WAL database
    // Escape single quotes if any in the path
    const sanitized = destinationPath.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${sanitized}';`);
  }
}
