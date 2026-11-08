import type { Migration } from "../registry/migrations";

/**
 * Approved-draft issue publication (#162) owns version 10.
 *
 * Versions 8 (#158 gates) and 9 (#159 final delivery) are reserved ahead of this
 * lane, so this module appends the next version instead of reusing version 7.
 * The durable outgoing intent ledger from #157 is extended rather than duplicated:
 * issue publication writes typed intents into the same `publication_intents`
 * table, now safely discriminated by resource kind and optional draft-publication
 * scope. Existing PR intents are preserved verbatim.
 */
export const DRAFT_PUBLICATION_MIGRATIONS: Migration[] = [
  {
    version: 10,
    name: "approved_draft_issue_publication",
    up(db) {
      db.exec(`
        CREATE TABLE draft_publications (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          draft_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          revision_number INTEGER NOT NULL CHECK(revision_number > 0),
          plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
          kind TEXT NOT NULL CHECK(kind IN ('standalone', 'spec')),
          state TEXT NOT NULL CHECK(state IN (
            'pending', 'publishing', 'published', 'admitted', 'failed', 'unknown'
          )),
          source_issue_number INTEGER NOT NULL CHECK(source_issue_number > 0),
          spec_issue_number INTEGER CHECK(spec_issue_number IS NULL OR spec_issue_number > 0),
          integration_branch TEXT,
          delivery_branch TEXT NOT NULL CHECK(length(delivery_branch) > 0),
          plan_id TEXT REFERENCES plans(id),
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(draft_id, revision_id),
          UNIQUE(id, project_id),
          UNIQUE(project_id, spec_issue_number),
          FOREIGN KEY(draft_id, project_id) REFERENCES work_drafts(id, project_id),
          FOREIGN KEY(revision_id) REFERENCES work_draft_revisions(id),
          FOREIGN KEY(plan_id) REFERENCES plans(id)
        );
      `);
      db.exec(`
        CREATE INDEX idx_draft_publications_project
        ON draft_publications(project_id, created_at DESC);
      `);

      // One durable row per planned spec/ticket node. The node key is derived from
      // the approved draft graph, so replaying a publication can never invent a
      // second node for the same approved operation.
      db.exec(`
        CREATE TABLE draft_publication_members (
          id TEXT PRIMARY KEY,
          publication_id TEXT NOT NULL REFERENCES draft_publications(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          node_key TEXT NOT NULL CHECK(length(node_key) > 0),
          role TEXT NOT NULL CHECK(role IN ('spec', 'ticket')),
          ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
          title TEXT NOT NULL CHECK(length(title) > 0),
          body TEXT NOT NULL,
          labels_json TEXT NOT NULL,
          issue_number INTEGER CHECK(issue_number IS NULL OR issue_number > 0),
          work_id TEXT REFERENCES work_items(id),
          state TEXT NOT NULL CHECK(state IN ('pending', 'created', 'verified', 'failed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(publication_id, node_key),
          UNIQUE(publication_id, issue_number)
        );
      `);
      db.exec(`
        CREATE INDEX idx_draft_publication_members_publication
        ON draft_publication_members(publication_id, ordinal ASC);
      `);

      db.exec(`
        CREATE TABLE draft_publication_relationships (
          id TEXT PRIMARY KEY,
          publication_id TEXT NOT NULL REFERENCES draft_publications(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          kind TEXT NOT NULL CHECK(kind IN ('parent_child', 'dependency')),
          from_node_key TEXT NOT NULL CHECK(length(from_node_key) > 0),
          to_node_key TEXT NOT NULL CHECK(length(to_node_key) > 0),
          from_issue_number INTEGER CHECK(from_issue_number IS NULL OR from_issue_number > 0),
          to_issue_number INTEGER CHECK(to_issue_number IS NULL OR to_issue_number > 0),
          source TEXT NOT NULL CHECK(source IN ('textual', 'native', 'textual+native')),
          state TEXT NOT NULL CHECK(state IN (
            'pending', 'verified', 'fallback_textual', 'unknown', 'failed'
          )),
          detail TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(publication_id, kind, from_node_key, to_node_key)
        );
      `);
      db.exec(`
        CREATE INDEX idx_draft_publication_relationships_publication
        ON draft_publication_relationships(publication_id);
      `);

      // Re-key the shared intent ledger so issue operations live beside PR
      // operations. Nothing references this table, so the rebuild only preserves
      // rows and widens the typed operation/resource vocabulary.
      db.exec(`
        CREATE TABLE publication_intents_v10 (
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
          state TEXT NOT NULL CHECK(state IN ('queued', 'attempting', 'accepted', 'failed', 'unknown')),
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
        INSERT INTO publication_intents_v10
          (id, target_id, project_id, draft_publication_id, operation_key, kind,
           resource_kind, state, request_json, attempts, remote_object_id, remote_url,
           last_error, created_at, updated_at)
        SELECT id, target_id, project_id, NULL, operation_key, kind,
               'pull_request', state, request_json, attempts, remote_object_id, remote_url,
               last_error, created_at, updated_at
          FROM publication_intents;
      `);
      db.exec(`DROP TABLE publication_intents;`);
      db.exec(`ALTER TABLE publication_intents_v10 RENAME TO publication_intents;`);
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
