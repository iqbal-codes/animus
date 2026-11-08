import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  CutoverArtifactSummary,
  CutoverDisposition,
  CutoverHeldFact,
  CutoverInventoryEvidence,
  CutoverMapping,
  CutoverTableGroup,
  CutoverTableSummary,
} from "@animus/contracts/cutover";
import { resolveAnimusStateDir } from "@animus/contracts/paths";

/**
 * Deterministic inventory of the real durable installation.
 *
 * It reads every non-internal SQLite table plus the finalized artifact files and
 * produces stable digests over (a) full row content and (b) primary-key identity.
 * Identity digest survives the restore step, which intentionally mutates active
 * run/control/hold rows; content digest is compared against the backup snapshot
 * taken before restore. No table is rewritten or re-imported here.
 */

const SELF_TABLES = new Set(["authority_cutover_operations", "authority_cutover_mappings"]);

/** Operational ledger tables that legitimately change between snapshot and live. */
const STATE_DIGEST_EXCLUDED = new Set([
  "backup_snapshots",
  "restore_operations",
  "installation_holds",
  ...SELF_TABLES,
]);

const GROUP_BY_TABLE: Record<string, CutoverTableGroup> = {
  projects: "projects",
  project_runs: "projects",
  project_issue_integrations: "integration",
  commands: "commands",
  brakes: "commands",
  run_processes: "runs",
  candidate_verifications: "evidence",
  gate_approvals: "evidence",
  candidate_landings: "evidence",
  execution_producers: "evidence",
  execution_observations: "evidence",
  execution_checks: "evidence",
  factory_findings: "evidence",
  factory_finding_events: "evidence",
  execution_artifacts: "evidence",
  project_spec_coordinations: "coordination",
  child_integrations: "integration",
  child_integration_events: "integration",
  work_items: "plans",
  work_revisions: "plans",
  plans: "plans",
  plan_members: "plans",
  plan_acceptance_criteria: "plans",
  plan_dependencies: "plans",
  plan_coverage: "plans",
  plan_holds: "plans",
  plan_manifests: "plans",
  plan_decisions: "plans",
  deliveries: "delivery",
  dispatch_runs: "runs",
  delivery_merge_verifications: "delivery",
  execution_budget_scopes: "delivery",
  execution_budget_grants: "delivery",
  execution_controls: "delivery",
  final_deliveries: "delivery",
  final_delivery_events: "delivery",
  publication_targets: "publication",
  publication_pull_requests: "publication",
  publication_events: "publication",
  publication_intents: "publication",
  publication_evidence_bindings: "publication",
  publication_summaries: "publication",
  work_drafts: "drafts",
  work_draft_revisions: "drafts",
  work_draft_decisions: "drafts",
  draft_publications: "drafts",
  draft_publication_members: "drafts",
  draft_publication_relationships: "drafts",
  backup_snapshots: "backup",
  restore_operations: "backup",
  installation_holds: "backup",
  schema_migrations: "schema",
};

/** Tables whose rows are durable legacy audit, not an executable authorization. */
const LEGACY_HISTORY_TABLES = new Set([
  "project_issue_integrations",
  "candidate_verifications",
  "gate_approvals",
  "candidate_landings",
  "project_spec_coordinations",
  "child_integrations",
  "child_integration_events",
]);

export interface CutoverInventoryOptions {
  stateDir?: string;
  artifactRoot?: string;
  now?: () => number;
}

export interface CutoverInventory extends CutoverInventoryEvidence {
  /** Content digest over every table except the excluded operational ledgers. */
  stateDigest: string;
  /** Stable primary-key identity digest across every table. */
  identityDigest: string;
}

interface ColumnInfo {
  name: string;
  pk: number;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name).filter((name) => !SELF_TABLES.has(name));
}

function columns(db: DatabaseSync, table: string): ColumnInfo[] {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all() as unknown as ColumnInfo[];
}

function primaryKeyColumns(db: DatabaseSync, table: string): string[] {
  return columns(db, table)
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
}

function identityValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return canonicalJson(value);
}

export function rowIdentity(
  pkColumns: readonly string[],
  row: Record<string, unknown>,
  rowHash: string,
): string {
  if (pkColumns.length === 0) return rowHash;
  return pkColumns.map((column) => identityValue(row[column])).join("\u0000");
}

function groupFor(table: string): CutoverTableGroup {
  return GROUP_BY_TABLE[table] ?? "other";
}

function statusOf(row: Record<string, unknown>): string {
  const value = row.status ?? row.state;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isRunLikeActive(table: string, row: Record<string, unknown>): boolean {
  const status = statusOf(row);
  if (table === "project_runs") {
    return ["active", "running", "claimed", "dispatched", "pending"].includes(status);
  }
  if (table === "run_processes") return status === "running";
  if (table === "dispatch_runs") return ["claimed", "dispatched", "running"].includes(status);
  if (table === "execution_controls") return ["active", "stopping"].includes(status);
  if (table === "project_spec_coordinations") return status === "active";
  if (table === "final_deliveries") return ["active", "running", "repairing"].includes(status);
  if (table === "publication_intents") return ["attempting", "unknown"].includes(status);
  return false;
}

function heldReason(table: string, row: Record<string, unknown>): string | null {
  if (table === "installation_holds") {
    return row.status === "held" ? "restored installation is held pending reconciliation" : null;
  }
  if (isRunLikeActive(table, row)) {
    return "A live writer still owns this record; quiesce it before cutover";
  }
  return null;
}

function walkArtifacts(
  root: string,
  current: string,
  out: Array<{ relativePath: string; size: number; digest: string }>,
  held: CutoverHeldFact[],
): void {
  const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      walkArtifacts(root, absolute, out, held);
      continue;
    }
    const relativePath = relative(root, absolute).split(sep).join("/");
    if (!entry.isFile()) {
      held.push({
        entity: "artifact",
        identity: relativePath,
        reason: "finalized artifact path is not a regular file",
      });
      continue;
    }
    const stats = lstatSync(absolute);
    const bytes = readFileSync(absolute);
    out.push({
      relativePath,
      size: stats.size,
      digest: sha256Bytes(bytes),
    });
  }
}

export function inventoryInstallation(
  db: DatabaseSync,
  options: CutoverInventoryOptions = {},
): CutoverInventory {
  const stateDir = resolveAnimusStateDir(options.stateDir);
  const artifactRoot = options.artifactRoot ?? join(stateDir, "artifacts");
  const tables: CutoverTableSummary[] = [];
  const mappings: CutoverMapping[] = [];
  const held: CutoverHeldFact[] = [];
  let totalRows = 0;

  for (const table of listTables(db)) {
    const pkColumns = primaryKeyColumns(db, table);
    const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as unknown as Array<
      Record<string, unknown>
    >;
    const hashed = rows.map((row) => {
      const hash = sha256Text(canonicalJson(row));
      return { row, hash, identity: rowIdentity(pkColumns, row, hash) };
    });
    hashed.sort((left, right) => left.identity.localeCompare(right.identity));

    const digest = sha256Text(
      hashed.map((entry) => `${entry.identity}\u0000${entry.hash}`).join("\n"),
    );
    const identityDigest = sha256Text(hashed.map((entry) => entry.identity).join("\n"));
    totalRows += hashed.length;
    tables.push({ table, group: groupFor(table), count: hashed.length, digest, identityDigest });

    const legacyMapping = LEGACY_HISTORY_TABLES.has(table) || GROUP_BY_TABLE[table] !== undefined;
    if (!legacyMapping) continue;
    if (
      table === "backup_snapshots" ||
      table === "restore_operations" ||
      table === "schema_migrations"
    ) {
      continue;
    }

    for (const entry of hashed) {
      const reason = heldReason(table, entry.row);
      if (reason) {
        held.push({ entity: table, identity: entry.identity, reason });
      }
      const disposition: CutoverDisposition = reason
        ? "held"
        : LEGACY_HISTORY_TABLES.has(table)
          ? "preserved_history"
          : "preserved";
      mappings.push({
        entity: table,
        legacyId: entry.identity,
        newId: entry.identity,
        legacyHash: entry.hash,
        newHash: entry.hash,
        disposition,
        reason,
      });
    }
  }

  const artifactFiles: Array<{ relativePath: string; size: number; digest: string }> = [];
  if (existsSync(artifactRoot)) {
    walkArtifacts(artifactRoot, artifactRoot, artifactFiles, held);
  }
  artifactFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const artifacts: CutoverArtifactSummary = {
    root: artifactRoot,
    count: artifactFiles.length,
    totalBytes: artifactFiles.reduce((sum, file) => sum + file.size, 0),
    digest: sha256Text(
      artifactFiles
        .map((file) => `${file.relativePath}\u0000${file.size}\u0000${file.digest}`)
        .join("\n"),
    ),
  };

  const stateTables = tables.filter((entry) => !STATE_DIGEST_EXCLUDED.has(entry.table));
  const stateDigest = sha256Text(
    canonicalJson(stateTables.map(({ table, count, digest }) => ({ table, count, digest }))),
  );
  const identityDigest = sha256Text(
    canonicalJson(stateTables.map(({ table, identityDigest: value }) => ({ table, value }))),
  );

  const schemaVersion = Number(
    (
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        | { version: number | null }
        | undefined
    )?.version ?? 0,
  );

  return {
    generatedAt: (options.now ?? (() => Date.now()))(),
    schemaVersion,
    stateDigest,
    identityDigest,
    totalRows,
    tables,
    artifacts,
    held,
    mappings,
  };
}
