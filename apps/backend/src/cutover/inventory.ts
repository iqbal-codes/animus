import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  CutoverArtifactSummary,
  CutoverDisposition,
  CutoverHeldFact,
  CutoverInventoryEvidence,
  CutoverLegacyStateSummary,
  CutoverMapping,
  CutoverTableGroup,
  CutoverTableSummary,
} from "@animus/contracts/cutover";
import {
  isPidAlive,
  resolveAnimusHome,
  resolveAnimusStateDir,
  resolveProjectWorkspace,
} from "@animus/contracts/paths";

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
  delivery_role_claims: "delivery",
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
  /** Explicit Animus home used to derive per-project canonical state roots. */
  home?: string;
  /** Override the derived legacy roots (tests and callers with their own layout). */
  legacyRoots?: LegacyStateRoots;
  /** Disable legacy filesystem scanning (backup snapshot / isolated restore). */
  includeLegacyState?: boolean;
  now?: () => number;
}

/** Canonical filesystem roots derived only from registered project checkouts. */
export interface LegacyStateRoots {
  runsDirs: string[];
  locksDirs: string[];
  dossiersDirs: string[];
  worktreesDirs: string[];
  roots: string[];
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const normalized = sep === "/" ? path : path.split(sep).join("/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(path);
  }
  return out;
}

/**
 * Derives canonical legacy execution-state roots from the registered project
 * table only. There is no arbitrary filesystem walk: every directory inspected is
 * `<project stateRoot>/{runs,dossiers,locks,worktrees}` for a registered checkout.
 */
export function resolveLegacyStateRoots(
  db: DatabaseSync,
  options: { stateDir?: string; home?: string } = {},
): LegacyStateRoots {
  const stateDir = resolveAnimusStateDir(options.stateDir);
  const home = resolveAnimusHome(options.home);
  let projects: Array<{ checkout_path: string }> = [];
  try {
    projects = db
      .prepare("SELECT checkout_path FROM projects ORDER BY checkout_path ASC")
      .all() as Array<{ checkout_path: string }>;
  } catch {
    projects = [];
  }
  const stateRoots = new Set<string>();
  const runsDirs = new Set<string>();
  for (const project of projects) {
    if (typeof project.checkout_path !== "string" || project.checkout_path.trim() === "") {
      continue;
    }
    let workspace;
    try {
      workspace = resolveProjectWorkspace(project.checkout_path, {
        customHome: options.home,
        customStateDir: stateDir,
      });
    } catch {
      continue;
    }
    stateRoots.add(workspace.stateRoot);
    stateRoots.add(join(workspace.canonicalGitCommon, "factory-local-loop"));
    stateRoots.add(join(workspace.primaryRoot, ".factory-local-loop"));
    stateRoots.add(join(home, "projects", workspace.projectSlug));
    runsDirs.add(workspace.runsDir);
    for (const fallback of workspace.fallbackRunsDirs) runsDirs.add(fallback);
  }
  const roots = [...stateRoots];
  for (const root of roots) runsDirs.add(join(root, "runs"));
  return {
    roots,
    runsDirs: uniquePaths([...runsDirs]),
    locksDirs: uniquePaths(roots.map((root) => join(root, "locks"))),
    dossiersDirs: uniquePaths(roots.map((root) => join(root, "dossiers"))),
    worktreesDirs: uniquePaths(roots.map((root) => join(root, "worktrees"))),
  };
}

const LIVE_RUN_STATUSES = new Set([
  "preparing",
  "building",
  "checking",
  "qa",
  "reviewing",
  "reflecting",
]);

interface LegacyFileEntry {
  kind: string;
  identity: string;
  path: string;
  digest: string;
  bytes: number;
}

interface LegacyScanResult {
  summary: CutoverLegacyStateSummary;
  held: CutoverHeldFact[];
}

function readJsonFile(
  path: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: "state file is not a JSON object" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function recordLegacyFile(
  entries: LegacyFileEntry[],
  kind: string,
  identity: string,
  path: string,
): string | null {
  try {
    const bytes = readFileSync(path);
    entries.push({
      kind,
      identity,
      path,
      digest: sha256Bytes(bytes),
      bytes: bytes.length,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Scans the derived legacy roots for live legacy writers and malformed/ambiguous
 * ownership. Only a proven-dead pid is treated as stale; a missing owner identity
 * is held because it cannot be proven safe.
 */
export function scanLegacyState(roots: LegacyStateRoots): LegacyScanResult {
  const entries: LegacyFileEntry[] = [];
  const held: CutoverHeldFact[] = [];
  let runs = 0;
  let dossiers = 0;
  let locks = 0;
  let worktrees = 0;
  let malformed = 0;

  const holdAmbiguous = (entity: string, identity: string, reason: string) => {
    malformed += 1;
    held.push({ entity, identity, reason });
  };

  for (const runsDir of roots.runsDirs) {
    if (!existsSync(runsDir)) continue;
    let runEntries: string[];
    try {
      runEntries = readdirSync(runsDir).sort();
    } catch {
      continue;
    }
    for (const runEntry of runEntries) {
      const runDir = join(runsDir, runEntry);
      let isDirectory = false;
      try {
        isDirectory = lstatSync(runDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      const statePath = join(runDir, "state.json");
      if (!existsSync(statePath)) continue;
      runs += 1;
      const issuePath = join(runDir, "issue.json");
      if (existsSync(issuePath)) {
        recordLegacyFile(
          entries,
          "legacy_run_contract",
          `run:${relative(runsDir, issuePath)}`,
          issuePath,
        );
      }
      const recordError = recordLegacyFile(
        entries,
        "legacy_run_state",
        `run:${relative(runsDir, statePath)}`,
        statePath,
      );
      const identity = `run:${runEntry}`;
      if (recordError) {
        holdAmbiguous("legacy_run", identity, `legacy run state is unreadable: ${recordError}`);
        continue;
      }
      const parsed = readJsonFile(statePath);
      if (!parsed.ok) {
        holdAmbiguous("legacy_run", identity, `legacy run state is malformed: ${parsed.reason}`);
        continue;
      }
      const status = typeof parsed.value.status === "string" ? parsed.value.status : "";
      const pid = parsed.value.pid;
      if (LIVE_RUN_STATUSES.has(status)) {
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
          holdAmbiguous(
            "legacy_run",
            identity,
            `legacy run '${status}' has no usable process identity; ownership is ambiguous`,
          );
        } else if (isPidAlive(pid)) {
          held.push({
            entity: "legacy_run",
            identity,
            reason: `legacy run '${status}' is live under pid ${pid}; quiesce it before cutover`,
          });
        }
      } else if (status === "") {
        holdAmbiguous(
          "legacy_run",
          identity,
          "legacy run state has no status; ownership is ambiguous",
        );
      }
    }
  }

  for (const dossiersDir of roots.dossiersDirs) {
    if (!existsSync(dossiersDir)) continue;
    let files: string[];
    try {
      files = readdirSync(dossiersDir).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(dossiersDir, file);
      dossiers += 1;
      const recordError = recordLegacyFile(entries, "legacy_dossier", `dossier:${file}`, path);
      if (recordError) {
        holdAmbiguous(
          "legacy_dossier",
          `dossier:${file}`,
          `legacy dossier is unreadable: ${recordError}`,
        );
        continue;
      }
      const parsed = readJsonFile(path);
      if (!parsed.ok) {
        holdAmbiguous(
          "legacy_dossier",
          `dossier:${file}`,
          `legacy dossier is malformed: ${parsed.reason}`,
        );
      }
    }
  }

  for (const locksDir of roots.locksDirs) {
    if (!existsSync(locksDir)) continue;
    let lockEntries: string[];
    try {
      lockEntries = readdirSync(locksDir).sort();
    } catch {
      continue;
    }
    for (const lockEntry of lockEntries) {
      const lockPath = join(locksDir, lockEntry);
      let stats;
      try {
        stats = lstatSync(lockPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        const ownerPath = join(lockPath, "owner.json");
        locks += 1;
        if (!existsSync(ownerPath)) {
          holdAmbiguous(
            "legacy_lock",
            `lock:${lockEntry}`,
            "legacy issue lock has no owner identity; ownership is ambiguous",
          );
          continue;
        }
        const recordError = recordLegacyFile(
          entries,
          "legacy_lock",
          `lock:${lockEntry}`,
          ownerPath,
        );
        if (recordError) {
          holdAmbiguous(
            "legacy_lock",
            `lock:${lockEntry}`,
            `legacy lock owner is unreadable: ${recordError}`,
          );
          continue;
        }
        const parsed = readJsonFile(ownerPath);
        if (!parsed.ok) {
          holdAmbiguous(
            "legacy_lock",
            `lock:${lockEntry}`,
            `legacy lock owner is malformed: ${parsed.reason}`,
          );
          continue;
        }
        const pid = parsed.value.pid;
        const token = parsed.value.ownerToken;
        if (
          typeof pid !== "number" ||
          !Number.isSafeInteger(pid) ||
          pid <= 0 ||
          typeof token !== "string" ||
          token.trim() === ""
        ) {
          holdAmbiguous(
            "legacy_lock",
            `lock:${lockEntry}`,
            "legacy lock owner is missing a usable pid/token identity",
          );
        } else if (isPidAlive(pid)) {
          held.push({
            entity: "legacy_lock",
            identity: `lock:${lockEntry}`,
            reason: `legacy issue lock is live under pid ${pid}; quiesce it before cutover`,
          });
        }
        continue;
      }
      if (!stats.isFile()) continue;
      if (!lockEntry.endsWith(".lock")) continue;
      locks += 1;
      const recordError = recordLegacyFile(entries, "legacy_lock", `lock:${lockEntry}`, lockPath);
      if (recordError) {
        holdAmbiguous(
          "legacy_lock",
          `lock:${lockEntry}`,
          `legacy lock is unreadable: ${recordError}`,
        );
        continue;
      }
      const parsed = readJsonFile(lockPath);
      if (!parsed.ok) {
        holdAmbiguous(
          "legacy_lock",
          `lock:${lockEntry}`,
          `legacy lock is malformed: ${parsed.reason}`,
        );
        continue;
      }
      const pid = parsed.value.pid;
      const token = parsed.value.ownerToken;
      if (
        typeof pid !== "number" ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        typeof token !== "string" ||
        token.trim() === ""
      ) {
        holdAmbiguous(
          "legacy_lock",
          `lock:${lockEntry}`,
          "legacy lock owner is missing a usable pid/token identity",
        );
      } else if (isPidAlive(pid)) {
        held.push({
          entity: "legacy_lock",
          identity: `lock:${lockEntry}`,
          reason: `legacy issue lock is live under pid ${pid}; quiesce it before cutover`,
        });
      }
    }
  }

  for (const worktreesDir of roots.worktreesDirs) {
    if (!existsSync(worktreesDir)) continue;
    let worktreeEntries: string[];
    try {
      worktreeEntries = readdirSync(worktreesDir).sort();
    } catch {
      continue;
    }
    for (const worktreeEntry of worktreeEntries) {
      const worktreeDir = join(worktreesDir, worktreeEntry);
      const lockPath = join(worktreeDir, ".worktree.lock");
      if (!existsSync(lockPath)) continue;
      worktrees += 1;
      const recordError = recordLegacyFile(
        entries,
        "legacy_worktree",
        `worktree:${worktreeEntry}`,
        lockPath,
      );
      if (recordError) {
        holdAmbiguous(
          "legacy_worktree",
          `worktree:${worktreeEntry}`,
          `legacy worktree lock is unreadable: ${recordError}`,
        );
        continue;
      }
      const parsed = readJsonFile(lockPath);
      if (!parsed.ok) {
        holdAmbiguous(
          "legacy_worktree",
          `worktree:${worktreeEntry}`,
          `legacy worktree lock is malformed: ${parsed.reason}`,
        );
        continue;
      }
      const pid = parsed.value.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
        holdAmbiguous(
          "legacy_worktree",
          `worktree:${worktreeEntry}`,
          "legacy worktree lock has no usable process identity",
        );
      } else if (isPidAlive(pid)) {
        held.push({
          entity: "legacy_worktree",
          identity: `worktree:${worktreeEntry}`,
          reason: `legacy worktree is locked by live pid ${pid}; quiesce it before cutover`,
        });
      }
    }
  }

  entries.sort((left, right) =>
    `${left.kind}\u0000${left.identity}`.localeCompare(`${right.kind}\u0000${right.identity}`),
  );
  const digest = sha256Text(
    entries.map((entry) => `${entry.kind}\u0000${entry.identity}\u0000${entry.digest}`).join("\n"),
  );
  return {
    summary: {
      digest,
      roots: uniquePaths(roots.roots).sort(),
      runs,
      dossiers,
      locks,
      worktrees,
      files: entries.length,
      malformed,
    },
    held,
  };
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
  if (table === "delivery_role_claims") {
    // Only an active role writer blocks quiescence. A completed/failed claim
    // legitimately retains historical owner identity and is never authority.
    if (status === "running") return true;
    if (status === "interrupted") {
      return (
        typeof row.owner_pid === "number" ||
        typeof row.owner_process_start === "string" ||
        typeof row.role_pid === "number" ||
        typeof row.role_pgid === "number" ||
        typeof row.role_process_start === "string"
      );
    }
    return false;
  }
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

  let legacyState: CutoverLegacyStateSummary = {
    digest: sha256Text(""),
    roots: [],
    runs: 0,
    dossiers: 0,
    locks: 0,
    worktrees: 0,
    files: 0,
    malformed: 0,
  };
  if (options.includeLegacyState !== false) {
    const legacyRoots =
      options.legacyRoots ?? resolveLegacyStateRoots(db, { stateDir, home: options.home });
    const scan = scanLegacyState(legacyRoots);
    legacyState = scan.summary;
    for (const fact of scan.held) held.push(fact);
  }

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
    legacyState,
    held,
    mappings,
  };
}
