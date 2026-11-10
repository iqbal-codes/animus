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
const DISPATCH_V4 = "delivery_dispatch_ownership";
const EVIDENCE_V5 = "execution_observations_findings_artifacts";
const BUDGET_V6 = "execution_budgets_and_controls";
const PUBLICATION_V7 = "publication_audit_outgoing_intents";
const INTEGRATION_V8 = "child_gate_integration";
const DELIVERY_V9 = "standalone_delivery_gate_and_merge_verification";
const DRAFT_PUBLICATION_V10 = "approved_draft_issue_publication";
const RESTORE_V11 = "workspace_backup_restore";
const FINAL_V12 = "final_spec_delivery_coordination";
const RESTORE_V13 = "restore_terminal_intent_disposition";
const CUTOVER_V15 = "authority_cutover";
const DELIVERY_CLAIM_V16 = "delivery_role_claims";
const DELIVERY_CLAIM_AUDIT_V17 = "delivery_role_claim_reconcile_audit";
const CONSOLIDATION_V18 = "consolidate_delivery_state_and_merge_audit";

const ALL_MIGRATIONS = [
  { version: 1, name: WORK_V1 },
  { version: 2, name: PLAN_V2 },
  { version: 3, name: DRAFT_V3 },
  { version: 4, name: DISPATCH_V4 },
  { version: 5, name: EVIDENCE_V5 },
  { version: 6, name: BUDGET_V6 },
  { version: 7, name: PUBLICATION_V7 },
  { version: 8, name: INTEGRATION_V8 },
  { version: 9, name: DELIVERY_V9 },
  { version: 10, name: DRAFT_PUBLICATION_V10 },
  { version: 11, name: RESTORE_V11 },
  { version: 12, name: FINAL_V12 },
  { version: 13, name: RESTORE_V13 },
  { version: 15, name: CUTOVER_V15 },
  { version: 16, name: DELIVERY_CLAIM_V16 },
  { version: 17, name: DELIVERY_CLAIM_AUDIT_V17 },
  { version: 18, name: CONSOLIDATION_V18 },
];

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

function createLegacyMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function seedProject(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_id INTEGER NOT NULL,
      repo_name TEXT NOT NULL,
      checkout_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'held', 'tombstone')),
      status_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO projects
       (id, name, repo_id, repo_name, checkout_path, status, status_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("proj_1", "Product", 501, "owner/repo", "/tmp/checkout", "active", null, 1, 1);
}

function seedDelivery(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO deliveries
       (id, project_id, plan_id, kind, delivery_branch, integration_branch, final_pr_base,
        merge_policy_child, merge_policy_standalone, merge_policy_final, manifest_id, graph_hash,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "delivery_1",
    "proj_1",
    "plan_1",
    "standalone",
    "delivery/branch",
    "factory/spec-151-integration",
    "main",
    "manual",
    "manual",
    "manual",
    "manifest_1",
    "a".repeat(64),
    1,
    1,
  );
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
      ).toEqual(ALL_MIGRATIONS);
      // Every lane's tables exist after one pass; no runner silently skipped another.
      for (const table of ["work_items", "work_revisions", "plans", "plan_members"]) {
        expect(tableExists(db, table)).toBe(true);
      }
      for (const table of ["work_drafts", "work_draft_revisions", "work_draft_decisions"]) {
        expect(tableExists(db, table)).toBe(true);
      }
      for (const table of ["deliveries", "dispatch_runs"]) {
        expect(tableExists(db, table)).toBe(true);
      }
      for (const table of [
        "execution_producers",
        "execution_observations",
        "execution_checks",
        "factory_findings",
        "factory_finding_events",
        "execution_artifacts",
      ]) {
        expect(tableExists(db, table)).toBe(true);
      }
      for (const table of [
        "execution_budget_scopes",
        "execution_budget_grants",
        "execution_controls",
        "publication_targets",
        "publication_pull_requests",
        "publication_events",
        "publication_intents",
        "publication_evidence_bindings",
        "delivery_merges",
        "delivery_events",
        "draft_publications",
        "draft_publication_members",
        "draft_publication_relationships",
      ]) {
        expect(tableExists(db, table)).toBe(true);
      }
      for (const dropped of [
        "publication_summaries",
        "child_integrations",
        "child_integration_events",
        "delivery_merge_verifications",
        "final_deliveries",
        "final_delivery_events",
      ]) {
        expect(tableExists(db, dropped)).toBe(false);
      }
      const targetColumns = db.prepare("PRAGMA table_info(publication_targets)").all() as Array<{
        name: string;
      }>;
      expect(targetColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["summary_body", "summary_updated_at"]),
      );
      const deliveryColumns = db.prepare("PRAGMA table_info(deliveries)").all() as Array<{
        name: string;
      }>;
      expect(deliveryColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["final_status", "final_run_id", "lease_owner"]),
      );
      const checkColumns = db.prepare("PRAGMA table_info(execution_checks)").all() as Array<{
        name: string;
      }>;
      expect(checkColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["kind", "criterion_key"]),
      );
    } finally {
      db.close();
    }

    // Re-initialising is idempotent and does not duplicate or rename rows.
    const reopened = initializeDatabase(path);
    try {
      expect(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: ALL_MIGRATIONS.length,
      });
    } finally {
      reopened.close();
    }
  });

  test("AC-migration: upgrading from a version-1-only database applies the remaining versions", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    createLegacyMigrationTable(legacy);
    // Apply only version 1 the way an older build would have.
    applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, 1));
    expect(tableExists(legacy, "plans")).toBe(false);
    expect(tableExists(legacy, "work_drafts")).toBe(false);
    expect(tableExists(legacy, "deliveries")).toBe(false);
    expect(tableExists(legacy, "execution_observations")).toBe(false);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual(ALL_MIGRATIONS);
      for (const table of [
        "plans",
        "work_drafts",
        "work_draft_revisions",
        "deliveries",
        "execution_observations",
      ]) {
        expect(tableExists(upgraded, table)).toBe(true);
      }
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: upgrading from version 1 plus a partial version 2 keeps the applied lane and adds the rest", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    createLegacyMigrationTable(legacy);
    applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, 2));
    expect(tableExists(legacy, "plans")).toBe(true);
    expect(tableExists(legacy, "work_drafts")).toBe(false);
    expect(tableExists(legacy, "deliveries")).toBe(false);
    expect(tableExists(legacy, "execution_observations")).toBe(false);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual(ALL_MIGRATIONS);
      // The pre-existing plan data lane is untouched, and the later lanes now exist.
      expect(tableExists(upgraded, "plans")).toBe(true);
      expect(tableExists(upgraded, "work_drafts")).toBe(true);
      expect(tableExists(upgraded, "deliveries")).toBe(true);
      expect(tableExists(upgraded, "execution_observations")).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: upgrading from version 3 applies dispatch v4, evidence v5 and publication v7", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    createLegacyMigrationTable(legacy);
    applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, 3));
    expect(tableExists(legacy, "work_drafts")).toBe(true);
    expect(tableExists(legacy, "deliveries")).toBe(false);
    expect(tableExists(legacy, "execution_observations")).toBe(false);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual(ALL_MIGRATIONS);
      expect(tableExists(upgraded, "deliveries")).toBe(true);
      expect(tableExists(upgraded, "dispatch_runs")).toBe(true);
      expect(tableExists(upgraded, "execution_observations")).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: upgrading from an already-applied v5 database applies budget v6 and preserves v5 data", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    createLegacyMigrationTable(legacy);
    applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, 5));
    seedProject(legacy);
    seedDelivery(legacy);
    legacy
      .prepare(
        `INSERT INTO execution_producers
           (project_id, producer_id, role, producer_name, credential_hash, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("proj_1", "producer_v5", "automated_gate", "Gate", "c".repeat(64), 1, null);
    legacy
      .prepare(
        `INSERT INTO execution_observations
           (id, project_id, delivery_id, run_id, lap, attempt_key, stage, status,
            candidate_head_sha, target_tip_sha, merge_base_sha, tested_identity,
            integration_lineage, producer_id, producer_role, producer_name, gate_profile,
            gate_profile_version, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "obs_v5",
        "proj_1",
        "delivery_1",
        "run_1",
        1,
        "stage:technical_checks",
        "technical_checks",
        "passed",
        "d".repeat(40),
        "e".repeat(40),
        "e".repeat(40),
        "d".repeat(40),
        "lineage",
        "producer_v5",
        "automated_gate",
        "Gate",
        "standalone",
        1,
        null,
        1,
      );
    expect(tableExists(legacy, "execution_observations")).toBe(true);
    expect(tableExists(legacy, "execution_budget_scopes")).toBe(false);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual(ALL_MIGRATIONS);
      // Existing delivery and evidence identities survive the v6 schema install.
      expect(upgraded.prepare("SELECT id FROM deliveries").all()).toEqual([{ id: "delivery_1" }]);
      expect(upgraded.prepare("SELECT id FROM execution_observations").all()).toEqual([
        { id: "obs_v5" },
      ]);
      for (const table of [
        "execution_budget_scopes",
        "execution_budget_grants",
        "execution_controls",
      ]) {
        expect(tableExists(upgraded, table)).toBe(true);
      }
      expect(
        upgraded.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6").get(),
      ).toEqual({ count: 1 });
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: upgrading from version 4 applies evidence v5 and publication v7", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    createLegacyMigrationTable(legacy);
    applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, 4));
    expect(tableExists(legacy, "deliveries")).toBe(true);
    expect(tableExists(legacy, "execution_observations")).toBe(false);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual(ALL_MIGRATIONS);
      expect(tableExists(upgraded, "execution_observations")).toBe(true);
      expect(tableExists(upgraded, "execution_producers")).toBe(true);
      expect(tableExists(upgraded, "publication_targets")).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: an already-applied v4 database accepts the added v3 draft migration instead of rejecting or skipping v4", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    createLegacyMigrationTable(legacy);
    // Simulate the pre-reconciliation #154 lineage: v1, v2 and v4 applied, no v3.
    applyMigrations(legacy, [SCHEMA_MIGRATIONS[0]!, SCHEMA_MIGRATIONS[1]!, SCHEMA_MIGRATIONS[3]!]);
    seedProject(legacy);
    seedDelivery(legacy);
    expect(tableExists(legacy, "deliveries")).toBe(true);
    expect(tableExists(legacy, "work_drafts")).toBe(false);
    expect(
      legacy.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1, name: WORK_V1 },
      { version: 2, name: PLAN_V2 },
      { version: 4, name: DISPATCH_V4 },
    ]);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual(ALL_MIGRATIONS);
      // v4 was already applied: its data and tables stay, and v3/v5 install correctly.
      expect(upgraded.prepare("SELECT id FROM deliveries").all()).toEqual([{ id: "delivery_1" }]);
      expect(tableExists(upgraded, "dispatch_runs")).toBe(true);
      expect(tableExists(upgraded, "work_drafts")).toBe(true);
      expect(tableExists(upgraded, "execution_observations")).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: an already-applied v5 database accepts the added v3 draft migration and preserves v5 data", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    createLegacyMigrationTable(legacy);
    // Simulate the #155 lineage: v1, v2, v4 and v5 applied, no reserved v3.
    applyMigrations(legacy, [
      SCHEMA_MIGRATIONS[0]!,
      SCHEMA_MIGRATIONS[1]!,
      SCHEMA_MIGRATIONS[3]!,
      SCHEMA_MIGRATIONS[4]!,
    ]);
    seedProject(legacy);
    legacy
      .prepare(
        `INSERT INTO execution_producers
           (project_id, producer_id, role, producer_name, credential_hash, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("proj_1", "producer_1", "automated_gate", "Gate", "b".repeat(64), 1, null);
    expect(tableExists(legacy, "execution_producers")).toBe(true);
    expect(tableExists(legacy, "work_drafts")).toBe(false);
    expect(
      legacy.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1, name: WORK_V1 },
      { version: 2, name: PLAN_V2 },
      { version: 4, name: DISPATCH_V4 },
      { version: 5, name: EVIDENCE_V5 },
    ]);
    legacy.close();

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual(ALL_MIGRATIONS);
      // v5 data survives the later v3 install; nothing is dropped or recreated.
      expect(upgraded.prepare("SELECT producer_id FROM execution_producers").all()).toEqual([
        { producer_id: "producer_1" },
      ]);
      expect(tableExists(upgraded, "work_drafts")).toBe(true);
      expect(tableExists(upgraded, "work_draft_revisions")).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: a recorded version 2 with the draft name fails closed instead of silently skipping a migration", () => {
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON;");
    createLegacyMigrationTable(legacy);
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

  test("AC-migration: a populated v15 database upgrades to v16 and preserves project/delivery identity", () => {
    // Build a real current database, then rewind exactly the v16 lane to model a
    // populated v15 installation. The base tables (projects, integrations) already
    // exist, so this is the same upgrade path a real v15 state takes.
    const legacy = initializeDatabase(path);
    try {
      legacy.exec("DROP INDEX IF EXISTS idx_delivery_role_claim_audit_claim;");
      legacy.exec("DROP TABLE IF EXISTS delivery_role_claim_audit;");
      legacy.exec("DROP INDEX IF EXISTS idx_delivery_role_claims_run;");
      legacy.exec("DROP TABLE delivery_role_claims;");
      legacy.prepare("DELETE FROM schema_migrations WHERE version IN (16, 17)").run();
      seedProject(legacy);
      seedDelivery(legacy);
      legacy
        .prepare(
          `INSERT INTO project_issue_integrations
             (project_id, issue_number, branch, commit_sha, integrated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("proj_1", 501, "factory/legacy", "a".repeat(40), "1");
      expect(tableExists(legacy, "delivery_role_claims")).toBe(false);
    } finally {
      legacy.close();
    }

    const upgraded = initializeDatabase(path);
    try {
      expect(
        upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toEqual(ALL_MIGRATIONS);
      expect(tableExists(upgraded, "delivery_role_claims")).toBe(true);
      expect(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_delivery_role_claims_run'",
          )
          .get(),
      ).toEqual({ name: "idx_delivery_role_claims_run" });
      // Existing rows survive the v16 install.
      expect(upgraded.prepare("SELECT id FROM projects").all()).toEqual([{ id: "proj_1" }]);
      expect(upgraded.prepare("SELECT id FROM deliveries").all()).toEqual([{ id: "delivery_1" }]);
      expect(
        upgraded
          .prepare(
            "SELECT issue_number, branch FROM project_issue_integrations ORDER BY issue_number",
          )
          .all(),
      ).toEqual([{ issue_number: 501, branch: "factory/legacy" }]);
      // The new table's foreign keys stay enforced after the upgrade.
      expect(() =>
        upgraded
          .prepare(
            `INSERT INTO delivery_role_claims
               (id, project_id, delivery_id, run_id, lap, stage, candidate_head_sha, attempt_key,
                claim_token, claim_generation, lease_expires_at, heartbeat_at, state, created_at, updated_at)
             VALUES ('claim_dangling', 'proj_1', 'delivery_1', 'run_missing', 1,
                     'independent_review', ?, 'attempt', 'token', 1, 1, 1, 'running', 1, 1)`,
          )
          .run("a".repeat(40)),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      upgraded.close();
    }
  });

  test("AC-migration: v18 backfills consolidated delivery, merge and event state from a v17 database", () => {
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec("PRAGMA foreign_keys = OFF;");
      createLegacyMigrationTable(legacy);
      applyMigrations(legacy, SCHEMA_MIGRATIONS.slice(0, -1));
      seedProject(legacy);
      seedDelivery(legacy);
      const sha = (char: string) => char.repeat(40);
      legacy
        .prepare(
          `INSERT INTO work_items
             (id, project_id, repo_id, repo_name, issue_number, created_at, updated_at)
           VALUES ('work_1', 'proj_1', 501, 'owner/repo', 701, 1, 1)`,
        )
        .run();
      legacy
        .prepare(
          `INSERT INTO publication_targets
             (id, project_id, delivery_id, plan_id, work_id, issue_number, gate_profile,
              source_branch, target_branch, candidate_head_sha, base_sha, state, created_at, updated_at)
           VALUES ('target_1', 'proj_1', 'delivery_1', 'plan_1', 'work_1', 701, 'child',
                   'factory/issue-701', 'factory/spec-151-integration', ?, ?, 'published', 1, 1)`,
        )
        .run(sha("a"), sha("b"));
      legacy
        .prepare(
          `INSERT INTO publication_pull_requests
             (id, target_id, project_id, repository, number, url, head_branch, base_branch,
              candidate_head_sha, head_ref_oid, draft, state, active, remote_retired,
              created_by_intent, created_at, updated_at)
           VALUES ('pr_1', 'target_1', 'proj_1', 'owner/repo', 77,
                   'https://github.com/owner/repo/pull/77', 'factory/issue-701',
                   'factory/spec-151-integration', ?, ?, 0, 'open', 1, 0, NULL, 1, 1)`,
        )
        .run(sha("a"), sha("a"));
      legacy
        .prepare(
          `INSERT INTO publication_summaries (target_id, project_id, body, updated_at)
           VALUES ('target_1', 'proj_1', 'Consolidated summary', 2)`,
        )
        .run();
      legacy
        .prepare(
          `INSERT INTO final_deliveries
             (id, project_id, delivery_id, plan_id, manifest_id, graph_hash, integration_branch,
              delivery_branch, status, candidate_head_sha, final_run_id, required_count,
              integrated_count, pull_request_number, pull_request_url, halt_reason, lease_owner,
              lease_expires_at, created_at, updated_at)
           VALUES ('final_1', 'proj_1', 'delivery_1', 'plan_1', 'manifest_1', ?, 
                   'factory/spec-151-integration', 'delivery/branch', 'delivered', ?, 'run_final',
                   2, 2, 42, 'https://github.com/owner/repo/pull/42', NULL, NULL, NULL, 1, 3)`,
        )
        .run("a".repeat(64), sha("c"));
      legacy
        .prepare(
          `INSERT INTO child_integrations
             (id, project_id, delivery_id, plan_id, work_id, run_id, issue_number, gate_profile,
              source_branch, target_branch, candidate_head_sha, base_sha, target_tip_before_sha,
              target_tip_after_sha, merge_sha, remote_pull_request_number, remote_pull_request_url,
              evidence_identity, integrated_at)
           VALUES ('ci_1', 'proj_1', 'delivery_1', 'plan_1', 'work_1', 'run_child', 701, 'child',
                   'factory/issue-701', 'factory/spec-151-integration', ?, ?, ?, ?, ?, 77,
                   'https://github.com/owner/repo/pull/77', 'lineage#a#lap1', 5)`,
        )
        .run(sha("a"), sha("b"), sha("d"), sha("e"), sha("e"));
      legacy
        .prepare(
          `INSERT INTO delivery_merge_verifications
             (id, project_id, delivery_id, plan_id, work_id, run_id, gate_profile, target_id,
              pull_request_id, repository, pr_number, source_branch, target_branch,
              candidate_head_sha, remote_head_ref_oid, remote_target_tip_sha, merge_commit_sha,
              verified_at, verified_by)
           VALUES ('dmv_1', 'proj_1', 'delivery_1', 'plan_1', 'work_1', 'run_final', 'final',
                   'target_1', 'pr_1', 'owner/repo', 42, 'delivery/branch', 'main', ?, ?, ?, ?, 6,
                   'operator')`,
        )
        .run(sha("c"), sha("c"), sha("f"), sha("f"));
      legacy
        .prepare(
          `INSERT INTO child_integration_events
             (id, project_id, delivery_id, work_id, run_id, candidate_head_sha, target_tip_sha,
              kind, merge_sha, reasons, created_at)
           VALUES ('cie_1', 'proj_1', 'delivery_1', 'work_1', 'run_child', ?, ?, 'merged', ?,
                   '["merged"]', 7)`,
        )
        .run(sha("a"), sha("e"), sha("e"));
      legacy
        .prepare(
          `INSERT INTO final_delivery_events
             (id, project_id, delivery_id, plan_id, run_id, kind, candidate_head_sha, reasons,
              detail, created_at)
           VALUES ('fde_1', 'proj_1', 'delivery_1', 'plan_1', 'run_final', 'delivered', ?,
                   '["final_merge_verified"]', 'Verified final merge', 8)`,
        )
        .run(sha("c"));

      applyMigrations(legacy, SCHEMA_MIGRATIONS);

      expect(
        legacy
          .prepare("SELECT summary_body, summary_updated_at FROM publication_targets WHERE id = ?")
          .get("target_1"),
      ).toEqual({ summary_body: "Consolidated summary", summary_updated_at: 2 });
      expect(
        legacy
          .prepare(
            `SELECT final_status, candidate_head_sha, final_run_id, required_count,
                    integrated_count, pull_request_number, updated_at
             FROM deliveries WHERE id = ?`,
          )
          .get("delivery_1"),
      ).toEqual({
        final_status: "delivered",
        candidate_head_sha: sha("c"),
        final_run_id: "run_final",
        required_count: 2,
        integrated_count: 2,
        pull_request_number: 42,
        updated_at: 3,
      });
      expect(
        legacy
          .prepare(
            `SELECT gate_profile, issue_number, pr_number, target_id, pull_request_id
             FROM delivery_merges ORDER BY gate_profile`,
          )
          .all(),
      ).toEqual([
        {
          gate_profile: "child",
          issue_number: 701,
          pr_number: 77,
          target_id: null,
          pull_request_id: null,
        },
        {
          gate_profile: "final",
          issue_number: 701,
          pr_number: 42,
          target_id: "target_1",
          pull_request_id: "pr_1",
        },
      ]);
      expect(legacy.prepare("SELECT kind FROM delivery_events ORDER BY created_at").all()).toEqual([
        { kind: "merged" },
        { kind: "delivered" },
      ]);
      for (const dropped of [
        "publication_summaries",
        "child_integrations",
        "child_integration_events",
        "delivery_merge_verifications",
        "final_deliveries",
        "final_delivery_events",
      ]) {
        expect(tableExists(legacy, dropped)).toBe(false);
      }
    } finally {
      legacy.close();
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
