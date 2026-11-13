import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workRecordSchema } from "@animus/contracts/operator";
import { IntakeService } from "../../apps/backend/src/intake";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { WorkPersistenceError, WorkService } from "../../apps/backend/src/work";

const REPO = "owner/repo";

function checkout(root: string, name: string, repo = REPO): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", `https://github.com/${repo}.git`]);
  return path;
}

describe("project work identity and immutable revisions", () => {
  let root: string;
  let dbPath: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let projectId: string;
  let work: WorkService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-work-"));
    dbPath = join(root, "state", "console.db");
    db = initializeDatabase(dbPath);
    forge = new SyntheticForgeAdapter({ [REPO]: 501 });
    registry = new ProjectRegistryService(db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkout(root, "checkout-a"),
    });
    projectId = project.id;
    work = new WorkService(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  function addIssue(
    number = 7,
    overrides: Partial<{
      title: string;
      body: string | null;
      state: string;
      labels: Array<{ name: string }>;
      comments: Array<{ id?: string; author?: string; body: string }>;
    }> = {},
  ) {
    return forge.addIssue(REPO, {
      number,
      title: "Original request",
      body: "Original body",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [{ id: "c1", author: "reporter", body: "Original comment" }],
      ...overrides,
    });
  }

  test("AC1: complete discovery creates a project-owned work identity, provenance and hashed immutable revision", async () => {
    addIssue();
    const intake = new IntakeService(db, forge);
    const result = await intake.evaluateProjectBacklog(projectId, true);
    const evaluated = result.issues.find((issue) => issue.number === 7);

    expect(evaluated?.admission_status).toBe("admitted");
    const record = evaluated?.work;
    expect(record).toBeDefined();
    expect(workRecordSchema.parse(record)).toEqual(record);
    expect(record!.id).toMatch(/^work_[0-9a-f-]{36}$/);
    expect(record!.project_id).toBe(projectId);
    expect(record!.repo_id).toBe(501);
    expect(record!.repo_name).toBe(REPO);
    expect(record!.issue_number).toBe(7);
    expect(record!.revision.id).toMatch(/^wrev_[0-9a-f-]{36}$/);
    expect(record!.revision.work_id).toBe(record!.id);
    expect(record!.revision.project_id).toBe(projectId);
    expect(record!.revision.revision_number).toBe(1);
    expect(record!.revision.content_hash).toBe(
      "d1758b686075f33dc067de470fb30cc5c0cba7c0b62812ca4b191b2967f6ac31",
    );
    expect(record!.revision.source).toEqual({
      title: "Original request",
      body: "Original body",
      state: "OPEN",
      labels: ["ready-for-agent"],
      comments: [{ id: "c1", author: "reporter", body: "Original comment" }],
    });
    expect(record!.revision.provenance).toMatchObject({
      repo_id: 501,
      repo_name: REPO,
      issue_number: 7,
      source_url: `https://github.com/${REPO}/issues/7`,
    });
    expect(record!.revision.provenance.captured_at).toEqual(expect.any(Number));

    const listed = work.listWork(projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(record);
    expect(work.getWorkById(projectId, record!.id)).toEqual(record);
    expect(work.getWorkByIssue(projectId, 7)).toEqual(record);
    const targeted = await intake.getProjectIssue(projectId, 7);
    expect(targeted.work).toEqual(record);
  });

  test("AC2: repeat discovery and post-import source changes preserve one identity and the accepted snapshot", async () => {
    addIssue();
    const intake = new IntakeService(db, forge);
    const first = (await intake.evaluateProjectBacklog(projectId, true)).issues[0]!.work!;

    addIssue(7, {
      title: "Rewritten title",
      body: "Rewritten body",
      labels: [{ name: "needs-info" }],
      comments: [{ id: "c9", author: "someone", body: "Later comment" }],
    });
    const second = (await intake.evaluateProjectBacklog(projectId, true)).issues[0]!.work!;

    expect(second.id).toBe(first.id);
    expect(second.revision.id).toBe(first.revision.id);
    expect(second.revision.content_hash).toBe(first.revision.content_hash);
    expect(second.revision.source).toEqual(first.revision.source);
    expect(work.listWork(projectId)).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM work_revisions").get() as { count: number },
    ).toEqual({ count: 1 });

    addIssue(7, { state: "CLOSED" });
    const afterClosure = await intake.evaluateProjectBacklog(projectId, true);
    expect(afterClosure.issues.find((issue) => issue.number === 7)).toBeUndefined();
    expect(work.getWorkById(projectId, first.id)?.revision.source.body).toBe("Original body");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_runs").get() as { count: number },
    ).toEqual({ count: 0 });
  });

  test("AC2: factory-published work is rediscovered without a second identity", async () => {
    const intake = new IntakeService(db, forge);
    const published = await intake.publishProjectTicket(projectId, {
      title: "Published request",
      body: "Published body",
      labels: ["ready-for-agent"],
    });
    expect(published.issue.work).toBeDefined();
    const first = published.issue.work!;

    forge.addIssue(REPO, {
      number: published.issue.number,
      title: "Changed after publication",
      body: "Changed body",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    const rediscovered = await intake.evaluateProjectBacklog(projectId, true);
    const again = rediscovered.issues.find(
      (issue) => issue.number === published.issue.number,
    )!.work!;
    expect(again.id).toBe(first.id);
    expect(again.revision.id).toBe(first.revision.id);
    expect(again.revision.source.title).toBe("Published request");
    expect(work.listWork(projectId)).toHaveLength(1);
  });

  test("AC2: concurrent duplicate imports converge on one identity and revision", async () => {
    addIssue();
    const intakeA = new IntakeService(db, forge);
    const intakeB = new IntakeService(db, forge);
    const [a, b] = await Promise.all([
      intakeA.evaluateProjectBacklog(projectId, true),
      intakeB.evaluateProjectBacklog(projectId, true),
    ]);
    expect(a.issues[0]!.work!.id).toBe(b.issues[0]!.work!.id);
    expect(a.issues[0]!.work!.revision.id).toBe(b.issues[0]!.work!.revision.id);

    const otherConnection = initializeDatabase(dbPath);
    try {
      const concurrent = new WorkService(otherConnection);
      const record = concurrent.importIssue(
        { id: projectId, repo_id: 501, repo_name: REPO },
        {
          number: 7,
          title: "Concurrent rewrite",
          body: "Concurrent body",
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
          comments: [],
        },
      );
      expect(record.id).toBe(a.issues[0]!.work!.id);
      expect(record.revision.source.body).toBe("Original body");
    } finally {
      otherConnection.close();
    }
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM work_items").get() as { count: number },
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM work_revisions").get() as { count: number },
    ).toEqual({ count: 1 });
  });

  test("AC3: incomplete or malformed source holds admission without persisting partial work", async () => {
    addIssue(8, { title: "" });
    addIssue(9, { body: null });
    addIssue(10);
    const intake = new IntakeService(db, forge);
    const result = await intake.evaluateProjectBacklog(projectId, true);

    for (const number of [8, 9]) {
      const held = result.issues.find((issue) => issue.number === number)!;
      expect(held.admission_status).toBe("held");
      expect(held.reason).toMatch(/^work_import_held:work_invalid_source:/);
      expect(held.work).toBeUndefined();
    }
    expect(result.issues.find((issue) => issue.number === 10)?.work?.issue_number).toBe(10);
    expect(work.listWork(projectId).map((record) => record.issue_number)).toEqual([10]);

    try {
      work.importIssue(
        { id: projectId, repo_id: 501, repo_name: REPO },
        { number: 11, title: "", body: "body", state: "OPEN", labels: [], comments: [] },
      );
      throw new Error("expected work_invalid_source");
    } catch (error) {
      expect(error).toMatchObject({ code: "work_invalid_source" });
    }
    try {
      work.importIssue(
        { id: projectId, repo_id: 501, repo_name: REPO },
        { number: 12, title: "Missing body", state: "OPEN", labels: [], comments: [] },
      );
      throw new Error("expected work_invalid_source for missing body");
    } catch (error) {
      expect(error).toMatchObject({ code: "work_invalid_source" });
    }
    expect(work.getWorkByIssue(projectId, 11)).toBeNull();
    expect(work.getWorkByIssue(projectId, 12)).toBeNull();
  });

  test("AC3: wrong project/repository ownership and GitHub identity duplicates fail closed", async () => {
    forge = new SyntheticForgeAdapter({ [REPO]: 501, "owner/other": 502 });
    registry = new ProjectRegistryService(db, forge);
    const other = await registry.registerProject({
      method: "local_checkout",
      name: "Other",
      checkout_path: checkout(root, "checkout-other", "owner/other"),
    });

    addIssue();
    const intake = new IntakeService(db, forge);
    const record = (await intake.evaluateProjectBacklog(projectId, true)).issues[0]!.work!;

    try {
      work.importIssue(
        { id: projectId, repo_id: other.repo_id, repo_name: other.repo_name },
        { number: 7, title: "x", body: "", state: "OPEN", labels: [], comments: [] },
      );
      throw new Error("expected work_project_mismatch");
    } catch (error) {
      expect(error).toMatchObject({ code: "work_project_mismatch" });
    }

    expect(() =>
      db
        .prepare(
          `INSERT INTO work_items (id, project_id, repo_id, repo_name, issue_number, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(`work_${randomUUID()}`, other.id, 501, REPO, 7, Date.now(), Date.now()),
    ).toThrow(/UNIQUE/i);

    expect(() =>
      db
        .prepare(
          `INSERT INTO work_revisions
             (id, work_id, project_id, revision_number, content_hash, source_title,
              source_body, source_state, source_labels, source_comments, source_url,
              provenance, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `wrev_${randomUUID()}`,
          record.id,
          other.id,
          2,
          "a".repeat(64),
          "t",
          "b",
          "OPEN",
          "[]",
          "[]",
          "https://github.com/owner/repo/issues/7",
          "{}",
          Date.now(),
        ),
    ).toThrow(/FOREIGN KEY/i);

    expect(() =>
      db
        .prepare("UPDATE work_revisions SET source_body = ? WHERE id = ?")
        .run("tampered", record.revision.id),
    ).toThrow(/work_revision_immutable/);
    expect(() =>
      db.prepare("DELETE FROM work_revisions WHERE id = ?").run(record.revision.id),
    ).toThrow(/work_revision_immutable/);
    try {
      work.getWorkById(other.id, record.id);
      throw new Error("expected work_not_found");
    } catch (error) {
      expect(error).toMatchObject({ code: "work_not_found" });
    }
  });

  test("AC3: a failed revision write rolls back the work identity instead of returning success", () => {
    addIssue(12);
    db.exec(`
      CREATE TRIGGER fail_revision_insert
      BEFORE INSERT ON work_revisions
      BEGIN SELECT RAISE(ABORT, 'forced_revision_failure'); END;
    `);

    expect(() =>
      work.importIssue(
        { id: projectId, repo_id: 501, repo_name: REPO },
        {
          number: 12,
          title: "Will fail",
          body: "body",
          state: "OPEN",
          labels: [],
          comments: [],
        },
      ),
    ).toThrow(WorkPersistenceError);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM work_items").get() as { count: number },
    ).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM work_revisions").get() as { count: number },
    ).toEqual({ count: 0 });
  });

  test("AC4: canonical database uses WAL, FULL synchronization, foreign keys and versioned migrations", () => {
    expect(db.prepare("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA synchronous;").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys;").get()).toEqual({ foreign_keys: 1 });
    expect(
      db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1, name: "project_work_identity_and_revisions" },
      { version: 2, name: "prepared_plan_admission" },
      { version: 3, name: "project_work_drafts_and_decisions" },
      { version: 4, name: "delivery_dispatch_ownership" },
      { version: 5, name: "execution_observations_findings_artifacts" },
      { version: 6, name: "execution_budgets_and_controls" },
      { version: 7, name: "publication_audit_outgoing_intents" },
      { version: 8, name: "child_gate_integration" },
      { version: 9, name: "standalone_delivery_gate_and_merge_verification" },
      { version: 10, name: "approved_draft_issue_publication" },
      { version: 11, name: "workspace_backup_restore" },
      { version: 12, name: "final_spec_delivery_coordination" },
      { version: 13, name: "restore_terminal_intent_disposition" },
      { version: 15, name: "authority_cutover" },
      { version: 16, name: "delivery_role_claims" },
      { version: 17, name: "delivery_role_claim_reconcile_audit" },
      { version: 18, name: "consolidate_delivery_state_and_merge_audit" },
      { version: 19, name: "child_merge_without_pull_request" },
      { version: 20, name: "local_only_repositories_and_projects_indexes" },
    ]);
    db.close();
    db = initializeDatabase(dbPath);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 19,
    });
  });

  test("AC5: work and revisions survive restart with the same identity and hash", async () => {
    addIssue();
    const intake = new IntakeService(db, forge);
    const first = (await intake.evaluateProjectBacklog(projectId, true)).issues[0]!.work!;
    db.close();

    db = initializeDatabase(dbPath);
    work = new WorkService(db);
    const reopened = work.getWorkById(projectId, first.id);
    expect(reopened).toEqual(first);
  });

  test("AC4: retargeting the repository checkout preserves work identity and revision", async () => {
    addIssue();
    const intake = new IntakeService(db, forge);
    const first = (await intake.evaluateProjectBacklog(projectId, true)).issues[0]!.work!;

    const moved = await registry.retargetProject(projectId, {
      checkout_path: checkout(root, "checkout-b"),
    });
    expect(moved.id).toBe(projectId);
    expect(work.getWorkById(projectId, first.id)).toEqual(first);
    expect(work.listWork(projectId)).toHaveLength(1);
  });

  test("AC4: default database lives under canonical Animus home state", () => {
    const saved = {
      HOME: process.env.HOME,
      ANIMUS_HOME: process.env.ANIMUS_HOME,
      ANIMUS_STATE_DIR: process.env.ANIMUS_STATE_DIR,
      FACTORY_STATE_DIR: process.env.FACTORY_STATE_DIR,
      FACTORY_HOME: process.env.FACTORY_HOME,
    };
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.ANIMUS_HOME = join(home, "animus-home");
    delete process.env.ANIMUS_STATE_DIR;
    delete process.env.FACTORY_STATE_DIR;
    delete process.env.FACTORY_HOME;
    try {
      const canonical = initializeDatabase();
      canonical.close();
      expect(existsSync(join(home, "animus-home", "state", "console.db"))).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
