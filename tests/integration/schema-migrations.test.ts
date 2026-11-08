import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyMigrations,
  MigrationError,
  type Migration,
} from "../../apps/backend/src/registry/migrations";
import { initializeDatabase, SCHEMA_MIGRATIONS } from "../../apps/backend/src/registry";

const WORK_V1 = "project_work_identity_and_revisions";
const PLAN_V2 = "prepared_plan_admission";
const DRAFT_V3 = "project_work_drafts_and_decisions";

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

describe("coherent schema migration registry", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "animus-migrations-"));
    path = join(root, "console.db");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("AC-migration: a fresh database applies every migration exactly once in ascending order", () => {
    const db = initializeDatabase(path);
    try {
      expect(
        db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1, name: WORK_V1 },
        { version: 2, name: PLAN_V2 },
        { version: 3, name: DRAFT_V3 },
      ]);
      // Every lane's tables exist after one pass; no runner silently skipped another.
      for (const table of ["work_items", "work_revisions", "plans", "plan_members"]) {
        expect(tableExists(db, table)).toBe(true);
      }
      for (const table of ["work_drafts", "work_draft_revisions", "work_draft_decisions"]) {
        expect(tableExists(db, table)).toBe(true);
      }
    } finally {
      db.close();
    }

    // Re-initialising is idempotent and does not duplicate or rename rows.
    const reopened = initializeDatabase(path);
    try {
      expect(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: 3,
      });
    } finally {
      reopened.close();
    }
  });

  test("AC-migration: upgrading from a version-1-only database applies versions 2 and 3", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    // Apply only version 1 the way an older build would have.
    applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, 1));
    expect(tableExists(legacy, "plans")).toBe(false);
    expect(tableExists(legacy, "work_drafts")).toBe(false);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1, name: WORK_V1 },
        { version: 2, name: PLAN_V2 },
        { version: 3, name: DRAFT_V3 },
      ]);
      for (const table of ["plans", "work_drafts", "work_draft_revisions"]) {
        expect(tableExists(upgraded, table)).toBe(true);
      }
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: upgrading from version 1 plus a partial version 2 keeps the applied lane and adds the rest", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, 2));
    expect(tableExists(legacy, "plans")).toBe(true);
    expect(tableExists(legacy, "work_drafts")).toBe(false);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1, name: WORK_V1 },
        { version: 2, name: PLAN_V2 },
        { version: 3, name: DRAFT_V3 },
      ]);
      // The pre-existing plan data lane is untouched, and the draft lane now exists.
      expect(tableExists(upgraded, "plans")).toBe(true);
      expect(tableExists(upgraded, "work_drafts")).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: a recorded version 2 with the draft name fails closed instead of silently skipping a migration", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, 1));
    // Simulate the historical collision: version 2 recorded as the draft lane.
    legacy
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(2, DRAFT_V3, Date.now());
    legacy.close();

    expect(() => initializeDatabase(path)).toThrow(MigrationError);
  });

  test("AC-migration: registry rejects duplicate versions, duplicate names and unknown applied versions", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const up = () => {};
      const duplicateVersion: Migration[] = [
        { version: 1, name: "a", up },
        { version: 1, name: "b", up },
      ];
      expect(() => applyMigrations(db, duplicateVersion)).toThrow(
        expect.objectContaining({ code: "migration_duplicate_version" }),
      );

      const duplicateName: Migration[] = [
        { version: 1, name: "same", up },
        { version: 2, name: "same", up },
      ];
      expect(() => applyMigrations(db, duplicateName)).toThrow(
        expect.objectContaining({ code: "migration_duplicate_name" }),
      );

      expect(() =>
        applyMigrations(db, [
          { version: 2, name: "later", up },
          { version: 1, name: "earlier", up },
        ]),
      ).toThrow(expect.objectContaining({ code: "migration_out_of_order" }));
    } finally {
      db.close();
    }
  });

  test("AC-migration: an applied version unknown to this build fails closed", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, [{ version: 1, name: "a", up: () => {} }]);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        2,
        "future_migration",
        Date.now(),
      );
      expect(() => applyMigrations(db, [{ version: 1, name: "a", up: () => {} }])).toThrow(
        expect.objectContaining({ code: "migration_version_conflict" }),
      );
    } finally {
      db.close();
    }
  });
});
