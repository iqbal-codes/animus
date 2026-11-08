import type { Migration } from "../registry/migrations";

/**
 * Workspace backup/restore (#164) owns version 11 in the one ordered registry.
 * Child gate integration (#158) owns 8, standalone full-delivery (#159) owns 9,
 * and approved-draft issue publication (#162) owns 10. Version 12 stays reserved
 * for final spec coordination (#160); this module's durable terminal intent state
 * appends version 13 rather than claiming another lane's number.
 */
export const RESTORE_MIGRATIONS: Migration[] = [
  {
    version: 11,
    name: "workspace_backup_restore",
    up(db) {
      // Durable record of every backup attempt. Only `complete` rows that still
      // verify on disk are advertised as restorable.
      db.exec(`
        CREATE TABLE backup_snapshots (
          id TEXT PRIMARY KEY,
          destination_path TEXT NOT NULL CHECK(length(destination_path) > 0),
          manifest_version INTEGER NOT NULL CHECK(manifest_version > 0),
          manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
          database_sha256 TEXT NOT NULL CHECK(length(database_sha256) = 64),
          database_size_bytes INTEGER NOT NULL CHECK(database_size_bytes >= 0),
          artifact_count INTEGER NOT NULL CHECK(artifact_count >= 0),
          schema_version INTEGER NOT NULL CHECK(schema_version > 0),
          status TEXT NOT NULL CHECK(status IN ('complete', 'failed')),
          created_by TEXT NOT NULL CHECK(length(created_by) > 0),
          error TEXT,
          verified_at INTEGER,
          created_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL,
          UNIQUE(destination_path)
        );
      `);
      db.exec(`
        CREATE INDEX idx_backup_snapshots_status
        ON backup_snapshots(status, created_at DESC);
      `);

      // Restore attempts performed by this installation. The report is a validated
      // JSON object so a failed restore keeps an actionable diagnosis without a
      // partial target installation.
      db.exec(`
        CREATE TABLE restore_operations (
          id TEXT PRIMARY KEY,
          source_path TEXT NOT NULL CHECK(length(source_path) > 0),
          target_state_dir TEXT NOT NULL CHECK(length(target_state_dir) > 0),
          manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
          status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
          report TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL
        );
      `);
      db.exec(`
        CREATE INDEX idx_restore_operations_created
        ON restore_operations(created_at DESC);
      `);

      // A restored installation is held until an operator explicitly reconciles
      // process ownership and pending external effects. The singleton row applies
      // installation-wide; dispatch and publication fail closed while status=held.
      db.exec(`
        CREATE TABLE installation_holds (
          id TEXT PRIMARY KEY CHECK(id = 'installation'),
          status TEXT NOT NULL CHECK(status IN ('held', 'reconciled')),
          reason TEXT NOT NULL CHECK(length(reason) > 0),
          source_restore_id TEXT,
          restored_at INTEGER NOT NULL,
          reconciled_at INTEGER,
          reconciled_by TEXT,
          reconciliation_report TEXT
        );
      `);
    },
  },
  {
    version: 13,
    name: "restore_terminal_intent_disposition",
    up(db) {
      // A restored installation may durably abandon an outgoing external intent
      // whose original effect is absent or unverifiable offline. `abandoned` is a
      // terminal state: publication and issue reconciliation never replay it, so
      // releasing the hold cannot duplicate the original remote effect. Existing
      // rows and the full typed intent payload are preserved verbatim.
      db.exec(`
        CREATE TABLE publication_intents_v13 (
          id TEXT PRIMARY KEY,
          target_id TEXT REFERENCES publication_targets(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          draft_publication_id TEXT REFERENCES draft_publications(id),
          operation_key TEXT NOT NULL CHECK(length(operation_key) > 0),
          kind TEXT NOT NULL CHECK(kind IN (
            'create_pr', 'publish_event', 'update_summary', 'create_review',
            'create_issue', 'create_issue_relationship', 'link_source_issue'
          )),
          resource_kind TEXT NOT NULL CHECK(resource_kind IN (
            'pull_request', 'issue', 'relationship'
          )),
          state TEXT NOT NULL CHECK(state IN (
            'queued', 'attempting', 'accepted', 'failed', 'unknown', 'abandoned'
          )),
          request_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          remote_object_id TEXT,
          remote_url TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.exec(`
        INSERT INTO publication_intents_v13
          (id, target_id, project_id, draft_publication_id, operation_key, kind,
           resource_kind, state, request_json, attempts, remote_object_id, remote_url,
           last_error, created_at, updated_at)
        SELECT id, target_id, project_id, draft_publication_id, operation_key, kind,
               resource_kind, state, request_json, attempts, remote_object_id, remote_url,
               last_error, created_at, updated_at
          FROM publication_intents;
      `);
      db.exec(`DROP TABLE publication_intents;`);
      db.exec(`ALTER TABLE publication_intents_v13 RENAME TO publication_intents;`);
      db.exec(`
        CREATE UNIQUE INDEX uq_publication_intents_target
        ON publication_intents(target_id, operation_key)
        WHERE target_id IS NOT NULL;
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_publication_intents_draft_publication
        ON publication_intents(draft_publication_id, operation_key)
        WHERE draft_publication_id IS NOT NULL;
      `);
      db.exec(`
        CREATE INDEX idx_publication_intents_target
        ON publication_intents(target_id, created_at ASC);
      `);
      db.exec(`
        CREATE INDEX idx_publication_intents_draft_publication
        ON publication_intents(draft_publication_id, created_at ASC);
      `);
    },
  },
];
