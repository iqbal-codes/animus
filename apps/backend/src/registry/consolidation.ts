import type { Migration } from "./migrations";

/**
 * Version 18 removes schema duplication introduced by the per-ticket lanes.
 *
 * - `final_deliveries` was 1:1 with `deliveries`; its mutable coordination state
 *   now lives on the delivery row.
 * - `publication_summaries` was 1:1 with `publication_targets`; it is now a
 *   column pair on the target.
 * - `child_integrations` and `delivery_merge_verifications` were the same fact
 *   (a verified remote merge) split by gate profile; both now append to
 *   `delivery_merges`.
 * - `child_integration_events` and `final_delivery_events` were two append-only
 *   transition logs; both now append to `delivery_events`.
 *
 * Existing rows are copied before the old tables are dropped. `defer_foreign_keys`
 * keeps the rebuild safe inside the one transaction the migration runner owns.
 */
export const CONSOLIDATION_MIGRATIONS: Migration[] = [
  {
    version: 18,
    name: "consolidate_delivery_state_and_merge_audit",
    up(db) {
      db.exec("PRAGMA defer_foreign_keys = ON;");

      // Publication summary: 1:1 target -> column pair.
      db.exec("ALTER TABLE publication_targets ADD COLUMN summary_body TEXT;");
      db.exec("ALTER TABLE publication_targets ADD COLUMN summary_updated_at INTEGER;");
      db.exec(`
        UPDATE publication_targets
        SET summary_body = (
              SELECT body FROM publication_summaries s WHERE s.target_id = publication_targets.id
            ),
            summary_updated_at = (
              SELECT updated_at FROM publication_summaries s WHERE s.target_id = publication_targets.id
            );
      `);
      db.exec("DROP TABLE publication_summaries;");

      // Final-spec coordination: 1:1 delivery -> columns on the delivery row.
      db.exec(`
        ALTER TABLE deliveries ADD COLUMN final_status TEXT
        CHECK(final_status IS NULL OR final_status IN (
          'waiting_children','blocked','verifying','needs_owner',
          'awaiting_manual_merge','awaiting_merge_verification','remote_unavailable','delivered'
        ));
      `);
      db.exec("ALTER TABLE deliveries ADD COLUMN candidate_head_sha TEXT;");
      db.exec("ALTER TABLE deliveries ADD COLUMN final_run_id TEXT;");
      db.exec(
        "ALTER TABLE deliveries ADD COLUMN required_count INTEGER NOT NULL DEFAULT 0 CHECK(required_count >= 0);",
      );
      db.exec(
        "ALTER TABLE deliveries ADD COLUMN integrated_count INTEGER NOT NULL DEFAULT 0 CHECK(integrated_count >= 0);",
      );
      db.exec("ALTER TABLE deliveries ADD COLUMN pull_request_number INTEGER;");
      db.exec("ALTER TABLE deliveries ADD COLUMN pull_request_url TEXT;");
      db.exec("ALTER TABLE deliveries ADD COLUMN halt_reason TEXT;");
      db.exec("ALTER TABLE deliveries ADD COLUMN lease_owner TEXT;");
      db.exec("ALTER TABLE deliveries ADD COLUMN lease_expires_at INTEGER;");
      db.exec(`
        UPDATE deliveries
        SET final_status = (
              SELECT status FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ),
            candidate_head_sha = (
              SELECT candidate_head_sha FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ),
            final_run_id = (
              SELECT final_run_id FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ),
            required_count = COALESCE((
              SELECT required_count FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ), 0),
            integrated_count = COALESCE((
              SELECT integrated_count FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ), 0),
            pull_request_number = (
              SELECT pull_request_number FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ),
            pull_request_url = (
              SELECT pull_request_url FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ),
            halt_reason = (
              SELECT halt_reason FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ),
            lease_owner = (
              SELECT lease_owner FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ),
            lease_expires_at = (
              SELECT lease_expires_at FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ),
            updated_at = MAX(updated_at, COALESCE((
              SELECT updated_at FROM final_deliveries f
              WHERE f.delivery_id = deliveries.id AND f.project_id = deliveries.project_id
            ), updated_at));
      `);
      db.exec("DROP TABLE final_deliveries;");

      // Verified merges: one row per work/target, whatever the gate profile.
      db.exec(`
        CREATE TABLE delivery_merges (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('child', 'standalone', 'final')),
          issue_number INTEGER NOT NULL CHECK(issue_number > 0),
          target_id TEXT REFERENCES publication_targets(id),
          pull_request_id TEXT REFERENCES publication_pull_requests(id),
          repository TEXT,
          pr_number INTEGER NOT NULL CHECK(pr_number > 0),
          pr_url TEXT,
          source_branch TEXT NOT NULL CHECK(length(source_branch) > 0),
          target_branch TEXT NOT NULL CHECK(length(target_branch) > 0),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          base_sha TEXT,
          target_tip_before_sha TEXT,
          target_tip_after_sha TEXT NOT NULL CHECK(length(target_tip_after_sha) > 0),
          remote_head_ref_oid TEXT,
          merge_sha TEXT,
          evidence_identity TEXT,
          verified_at INTEGER NOT NULL,
          verified_by TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id),
          FOREIGN KEY(run_id, project_id) REFERENCES dispatch_runs(id, project_id)
        );
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_delivery_merges_child
        ON delivery_merges(project_id, delivery_id, work_id, target_branch)
        WHERE gate_profile = 'child';
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_delivery_merges_run_candidate
        ON delivery_merges(project_id, run_id, candidate_head_sha)
        WHERE gate_profile != 'child';
      `);
      db.exec(`
        CREATE INDEX idx_delivery_merges_project
        ON delivery_merges(project_id, verified_at DESC);
      `);
      db.exec(`
        CREATE INDEX idx_delivery_merges_delivery
        ON delivery_merges(delivery_id, target_branch);
      `);

      db.exec(`
        INSERT INTO delivery_merges
          (id, project_id, delivery_id, plan_id, work_id, run_id, gate_profile, issue_number,
           target_id, pull_request_id, repository, pr_number, pr_url, source_branch,
           target_branch, candidate_head_sha, base_sha, target_tip_before_sha,
           target_tip_after_sha, remote_head_ref_oid, merge_sha, evidence_identity,
           verified_at, verified_by, created_at)
        SELECT id, project_id, delivery_id, plan_id, work_id, run_id, 'child', issue_number,
               NULL, NULL, NULL, remote_pull_request_number, remote_pull_request_url,
               source_branch, target_branch, candidate_head_sha, base_sha,
               target_tip_before_sha, target_tip_after_sha, NULL, merge_sha,
               evidence_identity, integrated_at, NULL, integrated_at
        FROM child_integrations;
      `);
      db.exec(`
        INSERT INTO delivery_merges
          (id, project_id, delivery_id, plan_id, work_id, run_id, gate_profile, issue_number,
           target_id, pull_request_id, repository, pr_number, pr_url, source_branch,
           target_branch, candidate_head_sha, base_sha, target_tip_before_sha,
           target_tip_after_sha, remote_head_ref_oid, merge_sha, evidence_identity,
           verified_at, verified_by, created_at)
        SELECT v.id, v.project_id, v.delivery_id, v.plan_id, v.work_id, v.run_id,
               v.gate_profile, w.issue_number, v.target_id, v.pull_request_id, v.repository,
               v.pr_number, NULL, v.source_branch, v.target_branch, v.candidate_head_sha,
               NULL, NULL, v.remote_target_tip_sha, v.remote_head_ref_oid,
               v.merge_commit_sha, NULL, v.verified_at, v.verified_by, v.verified_at
        FROM delivery_merge_verifications v
        JOIN work_items w ON w.id = v.work_id AND w.project_id = v.project_id;
      `);
      db.exec("DROP TABLE child_integrations;");
      db.exec("DROP TABLE delivery_merge_verifications;");

      // Internal transition audit: one append-only log for child and final lanes.
      db.exec(`
        CREATE TABLE delivery_events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT,
          work_id TEXT,
          run_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN (
            'blocked','merged','reconciled','waiting','ready','final_run','verification',
            'correction','repair_merged','published','needs_owner','delivered','error'
          )),
          candidate_head_sha TEXT,
          target_tip_sha TEXT,
          merge_sha TEXT,
          reasons TEXT NOT NULL,
          detail TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_delivery_events_run
        ON delivery_events(project_id, run_id, created_at ASC);
      `);
      db.exec(`
        CREATE INDEX idx_delivery_events_delivery
        ON delivery_events(project_id, delivery_id, created_at ASC);
      `);
      db.exec(`
        INSERT INTO delivery_events
          (id, project_id, delivery_id, plan_id, work_id, run_id, kind, candidate_head_sha,
           target_tip_sha, merge_sha, reasons, detail, created_at)
        SELECT id, project_id, delivery_id, NULL, work_id, run_id, kind, candidate_head_sha,
               target_tip_sha, merge_sha, reasons, NULL, created_at
        FROM child_integration_events;
      `);
      db.exec(`
        INSERT INTO delivery_events
          (id, project_id, delivery_id, plan_id, work_id, run_id, kind, candidate_head_sha,
           target_tip_sha, merge_sha, reasons, detail, created_at)
        SELECT id, project_id, delivery_id, plan_id, NULL, run_id, kind, candidate_head_sha,
               NULL, NULL, reasons, detail, created_at
        FROM final_delivery_events;
      `);
      db.exec("DROP TABLE child_integration_events;");
      db.exec("DROP TABLE final_delivery_events;");

      for (const table of ["delivery_merges", "delivery_events"]) {
        db.exec(`
          CREATE TRIGGER ${table}_immutable_update
          BEFORE UPDATE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table}_immutable');
          END;
        `);
        db.exec(`
          CREATE TRIGGER ${table}_immutable_delete
          BEFORE DELETE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table}_immutable');
          END;
        `);
      }
    },
  },
  {
    version: 19,
    name: "child_merge_without_pull_request",
    up(db) {
      // A child ticket integrates into the integration branch with no pull request
      // of its own, so a verified merge has no PR identity. Everything else about
      // the record (targets, lineage, merge sha) is unchanged.
      db.exec("PRAGMA defer_foreign_keys = ON;");
      db.exec(`
        CREATE TABLE delivery_merges_v19 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('child', 'standalone', 'final')),
          issue_number INTEGER NOT NULL CHECK(issue_number > 0),
          target_id TEXT REFERENCES publication_targets(id),
          pull_request_id TEXT REFERENCES publication_pull_requests(id),
          repository TEXT,
          pr_number INTEGER CHECK(pr_number IS NULL OR pr_number > 0),
          pr_url TEXT,
          source_branch TEXT NOT NULL CHECK(length(source_branch) > 0),
          target_branch TEXT NOT NULL CHECK(length(target_branch) > 0),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          base_sha TEXT,
          target_tip_before_sha TEXT,
          target_tip_after_sha TEXT NOT NULL CHECK(length(target_tip_after_sha) > 0),
          remote_head_ref_oid TEXT,
          merge_sha TEXT,
          evidence_identity TEXT,
          verified_at INTEGER NOT NULL,
          verified_by TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(id, project_id),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id),
          FOREIGN KEY(run_id, project_id) REFERENCES dispatch_runs(id, project_id)
        );
      `);
      db.exec("INSERT INTO delivery_merges_v19 SELECT * FROM delivery_merges;");
      db.exec("DROP TABLE delivery_merges;");
      db.exec("ALTER TABLE delivery_merges_v19 RENAME TO delivery_merges;");
      db.exec(`
        CREATE UNIQUE INDEX uq_delivery_merges_child
        ON delivery_merges(project_id, delivery_id, work_id, target_branch)
        WHERE gate_profile = 'child';
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_delivery_merges_run_candidate
        ON delivery_merges(project_id, run_id, candidate_head_sha)
        WHERE gate_profile != 'child';
      `);
      db.exec(`
        CREATE INDEX idx_delivery_merges_project
        ON delivery_merges(project_id, verified_at DESC);
      `);
      db.exec(`
        CREATE INDEX idx_delivery_merges_delivery
        ON delivery_merges(delivery_id, target_branch);
      `);
      for (const table of ["delivery_merges"]) {
        db.exec(`
          CREATE TRIGGER ${table}_immutable_update
          BEFORE UPDATE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table}_immutable');
          END;
        `);
        db.exec(`
          CREATE TRIGGER ${table}_immutable_delete
          BEFORE DELETE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table}_immutable');
          END;
        `);
      }
    },
  },
];
