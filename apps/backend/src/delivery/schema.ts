import type { Migration } from "../registry/migrations";

/**
 * Standalone/final full-delivery gate (#159) owns version 9. Version 8 stays
 * reserved for child gate profiles (#158), so this lane appends to the single
 * ordered registry rather than claiming a version inside feature code.
 */
export const DELIVERY_MIGRATIONS: Migration[] = [
  {
    version: 9,
    name: "standalone_delivery_gate_and_merge_verification",
    up(db) {
      // Typed execution checks let the full-delivery gate distinguish black-box
      // acceptance criteria, regression, remote CI and independent code review
      // without inventing a second evidence store. Existing checks remain contract
      // checks through the column default.
      db.exec(`
        ALTER TABLE execution_checks
        ADD COLUMN kind TEXT NOT NULL DEFAULT 'contract'
        CHECK(kind IN ('contract', 'acceptance', 'review', 'regression', 'remote_ci'));
      `);
      db.exec(`
        ALTER TABLE execution_checks
        ADD COLUMN criterion_key TEXT;
      `);

      // A verified merge is an immutable local completion fact. It is written only
      // after the remote PR reports MERGED into the exact configured target and the
      // candidate is proven to be included in the remote target lineage.
      db.exec(`
        CREATE TABLE delivery_merge_verifications (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          delivery_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          gate_profile TEXT NOT NULL CHECK(gate_profile IN ('standalone', 'final')),
          target_id TEXT NOT NULL REFERENCES publication_targets(id),
          pull_request_id TEXT NOT NULL REFERENCES publication_pull_requests(id),
          repository TEXT NOT NULL CHECK(length(repository) > 0),
          pr_number INTEGER NOT NULL CHECK(pr_number > 0),
          source_branch TEXT NOT NULL CHECK(length(source_branch) > 0),
          target_branch TEXT NOT NULL CHECK(length(target_branch) > 0),
          candidate_head_sha TEXT NOT NULL CHECK(length(candidate_head_sha) > 0),
          remote_head_ref_oid TEXT NOT NULL CHECK(length(remote_head_ref_oid) > 0),
          remote_target_tip_sha TEXT NOT NULL CHECK(length(remote_target_tip_sha) > 0),
          merge_commit_sha TEXT,
          verified_at INTEGER NOT NULL,
          verified_by TEXT NOT NULL CHECK(length(verified_by) > 0),
          UNIQUE(id, project_id),
          UNIQUE(project_id, run_id, candidate_head_sha),
          FOREIGN KEY(delivery_id, project_id) REFERENCES deliveries(id, project_id),
          FOREIGN KEY(plan_id, project_id) REFERENCES plans(id, project_id),
          FOREIGN KEY(work_id, project_id) REFERENCES work_items(id, project_id),
          FOREIGN KEY(run_id, project_id) REFERENCES dispatch_runs(id, project_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_delivery_merge_project
        ON delivery_merge_verifications(project_id, delivery_id, verified_at DESC);
      `);
      db.exec(`
        CREATE TRIGGER delivery_merge_verifications_immutable_update
        BEFORE UPDATE ON delivery_merge_verifications
        BEGIN
          SELECT RAISE(ABORT, 'delivery_merge_verification_immutable');
        END;
      `);
      db.exec(`
        CREATE TRIGGER delivery_merge_verifications_immutable_delete
        BEFORE DELETE ON delivery_merge_verifications
        BEGIN
          SELECT RAISE(ABORT, 'delivery_merge_verification_immutable');
        END;
      `);
    },
  },
];
