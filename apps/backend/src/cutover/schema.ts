import type { Migration } from "../registry/migrations";

/**
 * Authority cutover (#165) owns version 15 in the one ordered registry. Version
 * 14 stays unused because #163 is a pure read-only projection, and an unused
 * number is never fabricated into a schema change.
 *
 * The tables record the inventory/staging evidence and the stable legacy-to-new
 * identity mapping. The single authority itself stays in
 * `execution-authority.json`; no second authority marker or workflow database is
 * introduced here.
 */
export const CUTOVER_MIGRATIONS: Migration[] = [
  {
    version: 15,
    name: "authority_cutover",
    up(db) {
      db.exec(`
        CREATE TABLE authority_cutover_operations (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK(status IN (
            'staging', 'staged', 'activating', 'activated', 'aborted', 'failed'
          )),
          actor TEXT NOT NULL CHECK(length(actor) > 0),
          inventory_sha256 TEXT,
          backup_snapshot_id TEXT,
          backup_path TEXT,
          backup_manifest_sha256 TEXT,
          restore_operation_id TEXT,
          restore_target_state_dir TEXT,
          held_count INTEGER NOT NULL DEFAULT 0 CHECK(held_count >= 0),
          total_rows INTEGER NOT NULL DEFAULT 0 CHECK(total_rows >= 0),
          report TEXT NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          activated_at INTEGER
        );
      `);
      // At most one in-flight cutover and at most one activated cutover. A crash
      // is resumed through the same row instead of creating a second authority.
      db.exec(`
        CREATE UNIQUE INDEX uq_authority_cutover_open
        ON authority_cutover_operations(status)
        WHERE status IN ('staging', 'staged', 'activating');
      `);
      db.exec(`
        CREATE UNIQUE INDEX uq_authority_cutover_activated
        ON authority_cutover_operations(status)
        WHERE status = 'activated';
      `);
      db.exec(`
        CREATE INDEX idx_authority_cutover_created
        ON authority_cutover_operations(created_at DESC);
      `);

      db.exec(`
        CREATE TABLE authority_cutover_mappings (
          cutover_id TEXT NOT NULL REFERENCES authority_cutover_operations(id),
          entity TEXT NOT NULL CHECK(length(entity) > 0),
          legacy_id TEXT NOT NULL CHECK(length(legacy_id) > 0),
          new_id TEXT NOT NULL CHECK(length(new_id) > 0),
          legacy_hash TEXT NOT NULL CHECK(length(legacy_hash) = 64),
          new_hash TEXT NOT NULL CHECK(length(new_hash) = 64),
          disposition TEXT NOT NULL CHECK(disposition IN (
            'preserved', 'preserved_history', 'adopted', 'held'
          )),
          reason TEXT,
          PRIMARY KEY (cutover_id, entity, legacy_id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_authority_cutover_mappings_entity
        ON authority_cutover_mappings(cutover_id, entity);
      `);
    },
  },
];
