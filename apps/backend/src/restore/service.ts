import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BackupCreateResult,
  BackupSnapshotRecord,
  BackupStatus,
  InstallationHold,
  OperatorErrorCode,
  RestoreCreateResult,
  RestoreOperationRecord,
  RestoreStatusResult,
} from "@animus/contracts/operator";
import { resolveAnimusHome, resolveAnimusStateDir } from "@animus/contracts/paths";
import { CommandLedger } from "../command/ledger";
import { normalizeArtifactRelativePath } from "../evidence/artifact-path";
import { initializeDatabase } from "../registry/db";
import type { ForgeAdapter } from "../registry/forge";
import { InstallationHeldError, readInstallationHold } from "@animus/contracts/installation-hold";
import {
  RestoreReleaseError,
  enumerateRestoreUnresolved,
  settleRestoreRelease,
  verifyRestoreRelease,
  type ReleaseDispositions,
} from "./release";
import {
  BACKUP_DATABASE_FILE,
  BACKUP_MANIFEST_FILE,
  BACKUP_MANIFEST_HASH_FILE,
  BACKUP_MANIFEST_VERSION,
  artifactBundleRelativePath,
  backupManifestSchema,
  canonicalJson,
  manifestHash,
  sha256Bytes,
  sha256File,
  type BackupArtifactEntry,
  type BackupManifest,
} from "./manifest";

export class BackupRestoreError extends Error {
  constructor(
    public readonly code: OperatorErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BackupRestoreError";
  }
}

export interface BackupRestoreServiceOptions {
  /** State directory owning the live database; defaults to the resolved Animus state dir. */
  stateDir?: string;
  /** Explicit live database file. A file-backed database is required for snapshots. */
  databasePath?: string;
  /** Live finalized artifact root; defaults to `<resolved state>/artifacts`. */
  artifactRoot?: string;
  /** Live Animus home used to recognise home-local paths. */
  home?: string;
  /** Read-only forge transport used to verify pending external intents. */
  forge?: ForgeAdapter;
  now?: () => number;
  ledger?: CommandLedger;
  /** How long the drain lock waits for live writers before failing closed. */
  busyTimeoutMs?: number;
}

const CREDENTIAL_NOTICE = {
  included: false as const,
  reconfigurationRequired: [
    "Operator and host authentication tokens (FACTORY_HOST_TOKEN, FACTORY_OPERATOR_TOKEN)",
    "GitHub webhook secret (GITHUB_WEBHOOK_SECRET)",
    "Session secret (<animus state>/session.secret is regenerated, never copied)",
    "Model provider credentials configured outside console.db",
    "Trusted producer credentials are persisted only as SHA-256 hashes; plaintext is unrecoverable",
  ],
  note: "The backup contains only console.db and finalized referenced artifacts. Reconfigure every external credential in the restored home before enabling dispatch or publication.",
};

const SAME_DISK_WARNING =
  "A backup written to the same disk or filesystem as the live Animus home is lost with that disk. Copy validated bundles to separate durable storage; same-disk copies are not disaster protection.";

const LIMITATIONS = [
  "Live builder processes are not snapshotted or resumed; active runs are recorded as interrupted.",
  "Uncommitted worktree edits are not captured by the database snapshot and are never claimed as restorable.",
  "Pending remote publication intents stay queued/unknown for explicit reconciliation; no external effect is replayed automatically.",
  "Budget consumption and grants are preserved exactly; restore never resets an attempt allowance.",
];

const COUNTED_TABLES = [
  "work_items",
  "work_revisions",
  "plans",
  "plan_members",
  "plan_decisions",
  "deliveries",
  "dispatch_runs",
  "execution_budget_scopes",
  "execution_budget_grants",
  "execution_controls",
  "execution_observations",
  "execution_checks",
  "factory_findings",
  "factory_finding_events",
  "execution_artifacts",
  "publication_targets",
  "publication_pull_requests",
  "publication_events",
  "publication_intents",
  "publication_summaries",
  "commands",
] as const;

interface ArtifactRow {
  project_id: string;
  owner_type: string;
  owner_id: string;
  relative_path: string;
  size_bytes: number;
  digest_sha256: string;
}

interface SnapshotInput {
  id: string;
  destinationPath: string;
  manifestVersion: number;
  manifestHash: string;
  databaseSha256: string;
  databaseSizeBytes: number;
  artifactCount: number;
  schemaVersion: number;
  status: "complete" | "failed";
  createdBy: string;
  error: string | null;
  verifiedAt: number | null;
  createdAt: number;
  finishedAt: number;
}

interface SnapshotRow {
  id: string;
  destination_path: string;
  manifest_version: number;
  manifest_hash: string;
  database_sha256: string;
  database_size_bytes: number;
  artifact_count: number;
  schema_version: number;
  status: "complete" | "failed";
  created_by: string;
  error: string | null;
  verified_at: number | null;
  created_at: number;
  finished_at: number;
}

interface RestoreRow {
  id: string;
  source_path: string;
  target_state_dir: string;
  manifest_hash: string;
  status: "completed" | "failed";
  report: string;
  created_at: number;
  finished_at: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function assertContained(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + sep)) {
    throw new BackupRestoreError(
      "restore_validation_failed",
      `${label} escapes its root: ${candidate}`,
    );
  }
  return resolvedCandidate;
}

function isEffectivelyEmpty(dirPath: string): boolean {
  if (!existsSync(dirPath)) return true;
  const stats = lstatSync(dirPath);
  if (!stats.isDirectory()) return false;
  return readdirSync(dirPath).length === 0;
}

function normalizeForCompare(path: string): string {
  return resolve(path);
}

function isWithin(child: string, parent: string): boolean {
  const normalizedChild = normalizeForCompare(child);
  const normalizedParent = normalizeForCompare(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + sep);
}

function mapSnapshot(row: SnapshotRow): BackupSnapshotRecord {
  return {
    id: row.id,
    destinationPath: row.destination_path,
    manifestVersion: row.manifest_version,
    manifestHash: row.manifest_hash,
    databaseSha256: row.database_sha256,
    databaseSizeBytes: row.database_size_bytes,
    artifactCount: row.artifact_count,
    schemaVersion: row.schema_version,
    status: row.status,
    createdBy: row.created_by,
    error: row.error,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function mapRestore(row: RestoreRow): RestoreOperationRecord {
  let report: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.report);
    report = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    report = { raw: row.report };
  }
  return {
    id: row.id,
    sourcePath: row.source_path,
    targetStateDir: row.target_state_dir,
    manifestHash: row.manifest_hash,
    status: row.status,
    report,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Consistent, artifact-complete workspace snapshots and isolated verified restores.
 *
 * The database snapshot is produced by SQLite `VACUUM INTO` while a second
 * connection holds a write transaction, so other connections and processes are
 * drained by SQLite's own locking rather than an in-memory flag. Finalized
 * artifacts are immutable and copied by hash; a snapshot becomes visible only
 * after the whole bundle has been verified and atomically renamed into place.
 */
export class BackupRestoreService {
  private readonly databasePath: string;
  private readonly stateDir: string;
  private readonly artifactRoot: string;
  private readonly home: string;
  private readonly forge?: ForgeAdapter;
  private readonly now: () => number;
  private readonly ledger?: CommandLedger;
  private readonly busyTimeoutMs: number;

  constructor(
    private readonly db: DatabaseSync,
    options: BackupRestoreServiceOptions = {},
  ) {
    this.stateDir = resolve(options.stateDir ?? resolveAnimusStateDir());
    this.databasePath = resolve(options.databasePath ?? join(this.stateDir, BACKUP_DATABASE_FILE));
    this.artifactRoot = resolve(options.artifactRoot ?? join(this.stateDir, "artifacts"));
    this.home = resolve(options.home ?? resolveAnimusHome());
    this.forge = options.forge;
    this.now = options.now ?? (() => Date.now());
    this.ledger = options.ledger;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  }

  // ------------------------------------------------------------------
  // Backup
  // ------------------------------------------------------------------

  createBackup(destinationPath: string, actor = "operator"): BackupCreateResult {
    const destination = resolve(destinationPath);
    const startedAt = this.now();
    const id = `bkp_${randomUUID()}`;

    if (isWithin(destination, this.stateDir) || isWithin(destination, this.artifactRoot)) {
      throw new BackupRestoreError(
        "backup_failed",
        "Backup destination must not be inside the live Animus state or artifact root",
      );
    }
    if (!isEffectivelyEmpty(destination)) {
      throw new BackupRestoreError(
        "backup_failed",
        `Backup destination already exists and is not empty: ${destination}`,
      );
    }

    const temp = `${destination}.partial-${randomUUID()}`;
    let snapshot: BackupManifest | null = null;
    let databaseSha256 = "";
    let databaseSizeBytes = 0;

    try {
      this.assertFileBackedDatabase();
      mkdirSync(dirname(destination), { recursive: true });
      mkdirSync(temp, { recursive: true });

      const snapshotDbPath = join(temp, BACKUP_DATABASE_FILE);
      this.captureConsistentDatabase(snapshotDbPath);

      snapshot = this.buildManifest(snapshotDbPath, temp, startedAt);
      databaseSha256 = snapshot.database.sha256;
      databaseSizeBytes = snapshot.database.sizeBytes;

      writeFileSync(join(temp, BACKUP_MANIFEST_FILE), canonicalJson(snapshot), { mode: 0o600 });
      writeFileSync(join(temp, BACKUP_MANIFEST_HASH_FILE), `${manifestHash(snapshot)}\n`, {
        mode: 0o600,
      });

      const verification = this.verifyBundle(temp, snapshot, databaseSha256);
      if (verification.reasons.length > 0) {
        throw new BackupRestoreError(
          "backup_incomplete",
          `Backup bundle failed final verification: ${verification.reasons.join(", ")}`,
          { reasons: verification.reasons },
        );
      }

      if (existsSync(destination)) rmdirSync(destination);
      renameSync(temp, destination);

      const finishedAt = this.now();
      this.recordSnapshot({
        id,
        destinationPath: destination,
        manifestVersion: snapshot.manifestVersion,
        manifestHash: manifestHash(snapshot),
        databaseSha256,
        databaseSizeBytes,
        artifactCount: snapshot.artifacts.length,
        schemaVersion: snapshot.build.schemaVersion,
        status: "complete",
        createdBy: actor,
        error: null,
        verifiedAt: finishedAt,
        createdAt: startedAt,
        finishedAt,
      });

      return {
        snapshot: this.getSnapshotById(id)!,
        manifestHash: manifestHash(snapshot),
        databaseSha256,
        artifactCount: snapshot.artifacts.length,
        schemaVersion: snapshot.build.schemaVersion,
        destinationPath: destination,
        createdAt: finishedAt,
      };
    } catch (error) {
      try {
        rmSync(temp, { recursive: true, force: true });
      } catch {}
      const message = error instanceof Error ? error.message : String(error);
      const code: OperatorErrorCode =
        error instanceof BackupRestoreError ? error.code : "backup_failed";
      this.recordFailedSnapshot({
        id,
        destinationPath: destination,
        manifestVersion: snapshot?.manifestVersion ?? BACKUP_MANIFEST_VERSION,
        manifestHash: snapshot ? manifestHash(snapshot) : "0".repeat(64),
        databaseSha256: databaseSha256 || "0".repeat(64),
        databaseSizeBytes,
        artifactCount: snapshot?.artifacts.length ?? 0,
        schemaVersion: snapshot?.build.schemaVersion ?? 1,
        status: "failed",
        createdBy: actor,
        error: message,
        verifiedAt: null,
        createdAt: startedAt,
        finishedAt: this.now(),
      });
      if (error instanceof BackupRestoreError) throw error;
      throw new BackupRestoreError(code, message);
    }
  }

  backupStatus(): BackupStatus {
    const row = this.db
      .prepare(
        "SELECT * FROM backup_snapshots WHERE status = 'complete' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get() as SnapshotRow | undefined;
    if (!row) {
      return {
        lastBackup: null,
        restorable: false,
        reasons: ["no_complete_backup"],
        artifactCount: 0,
        credentials: CREDENTIAL_NOTICE,
        sameDiskWarning: SAME_DISK_WARNING,
      };
    }

    const lastBackup = mapSnapshot(row);
    const reasons: string[] = [];
    let artifactCount = 0;
    try {
      const manifest = this.readBundleManifest(row.destination_path);
      const verification = this.verifyBundle(row.destination_path, manifest, row.database_sha256);
      reasons.push(...verification.reasons);
      artifactCount = manifest.artifacts.length;
      if (verification.reasons.length === 0) {
        this.db
          .prepare("UPDATE backup_snapshots SET verified_at = ? WHERE id = ?")
          .run(this.now(), row.id);
        lastBackup.verifiedAt = this.now();
      }
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }

    return {
      lastBackup,
      restorable: reasons.length === 0,
      reasons,
      artifactCount,
      credentials: CREDENTIAL_NOTICE,
      sameDiskWarning: SAME_DISK_WARNING,
    };
  }

  private assertFileBackedDatabase(): void {
    if (this.databasePath === ":memory:" || !existsSync(this.databasePath)) {
      throw new BackupRestoreError(
        "backup_failed",
        "A durable backup requires a file-backed console.db; this installation is in-memory",
      );
    }
  }

  private captureConsistentDatabase(targetPath: string): void {
    // A dedicated connection opens a write transaction, which makes every other
    // connection/process wait at SQLite's own lock boundary. A second connection
    // then reads a consistent committed snapshot with VACUUM INTO. No artifact or
    // database row can change while the snapshot is captured.
    const lock = new DatabaseSync(this.databasePath);
    lock.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
    const reader = new DatabaseSync(this.databasePath);
    reader.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
    try {
      lock.exec("BEGIN IMMEDIATE;");
      reader.exec(`VACUUM INTO '${escapeSqlLiteral(targetPath)}';`);
    } catch (error) {
      if (error instanceof Error && /database is locked|busy/i.test(error.message)) {
        throw new BackupRestoreError(
          "backup_failed",
          "Could not drain database writers for a consistent snapshot; retry when active writers finish",
          { cause: error.message },
        );
      }
      throw error;
    } finally {
      try {
        lock.exec("COMMIT;");
      } catch {}
      try {
        lock.close();
      } catch {}
      try {
        reader.close();
      } catch {}
    }
  }

  private buildManifest(
    snapshotDbPath: string,
    tempRoot: string,
    createdAt: number,
  ): BackupManifest {
    const snap = new DatabaseSync(snapshotDbPath, { readOnly: true });
    try {
      const integrity = snap.prepare("PRAGMA integrity_check;").get() as
        | { integrity_check?: string }
        | undefined;
      if (integrity?.integrity_check !== "ok") {
        throw new BackupRestoreError(
          "backup_incomplete",
          `Snapshot database integrity check failed: ${integrity?.integrity_check ?? "unknown"}`,
        );
      }
      const violations = snap.prepare("PRAGMA foreign_key_check;").all();
      if (violations.length > 0) {
        throw new BackupRestoreError(
          "backup_incomplete",
          `Snapshot has ${violations.length} foreign-key violation(s)`,
          { violations: violations.length },
        );
      }

      const schemaRow = snap
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number | null } | undefined;
      const schemaVersion = Number(schemaRow?.version ?? 0);
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
        throw new BackupRestoreError(
          "backup_incomplete",
          "Snapshot has no recorded schema migration version",
        );
      }

      const tables: Record<string, number> = {};
      for (const table of COUNTED_TABLES) {
        const count = snap.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
          | { count: number }
          | undefined;
        tables[table] = Number(count?.count ?? 0);
      }

      // Two owners may legitimately reference the same finalized file (for
      // example one check log per observation lap). Bundle identity is the
      // physical project-relative path, so identical references collapse into
      // one entry while conflicting bytes fail closed.
      const artifactRows = snap
        .prepare(
          `SELECT project_id, owner_type, owner_id, relative_path, size_bytes, digest_sha256
             FROM execution_artifacts
            ORDER BY project_id ASC, relative_path ASC, owner_type ASC, owner_id ASC`,
        )
        .all() as unknown as ArtifactRow[];

      const artifactsByKey = new Map<string, BackupArtifactEntry>();
      for (const row of artifactRows) {
        const key = `${row.project_id}\u0000${row.relative_path}`;
        const existing = artifactsByKey.get(key);
        if (existing) {
          if (existing.sizeBytes !== row.size_bytes || existing.sha256 !== row.digest_sha256) {
            throw new BackupRestoreError(
              "backup_incomplete",
              `Artifact rows disagree on finalized bytes for ${row.project_id}/${row.relative_path}`,
            );
          }
          continue;
        }
        artifactsByKey.set(key, this.copyArtifactToBundle(tempRoot, row));
      }
      const artifacts = [...artifactsByKey.values()];

      const size = lstatSync(snapshotDbPath).size;
      return {
        manifestVersion: BACKUP_MANIFEST_VERSION,
        kind: "animus-workspace-backup",
        createdAt,
        source: {
          home: this.home,
          stateDir: this.stateDir,
          worktreesDir: join(this.home, "worktrees"),
          artifactRoot: this.artifactRoot,
        },
        build: { schemaVersion },
        database: {
          relativePath: BACKUP_DATABASE_FILE,
          sizeBytes: size,
          sha256: sha256File(snapshotDbPath),
        },
        artifacts,
        completeness: {
          integrityCheck: "ok",
          foreignKeyViolations: 0,
          tables,
          artifactRows: artifactRows.length,
        },
      };
    } finally {
      snap.close();
    }
  }

  private copyArtifactToBundle(tempRoot: string, row: ArtifactRow): BackupArtifactEntry {
    const relativePath = normalizeArtifactRelativePath(row.relative_path);
    const liveRoot = resolve(this.artifactRoot);
    const source = assertContained(
      liveRoot,
      join(liveRoot, row.project_id, relativePath),
      "Live artifact path",
    );
    const stats = lstatSync(source);
    if (!stats.isFile()) {
      throw new BackupRestoreError(
        "backup_incomplete",
        `Referenced artifact is not a regular finalized file: ${row.project_id}/${relativePath}`,
      );
    }
    const realSource = realpathSync(source);
    const realRoot = realpathSync(liveRoot);
    if (!isWithin(realSource, realRoot)) {
      throw new BackupRestoreError(
        "backup_incomplete",
        `Referenced artifact resolves outside the live artifact root: ${relativePath}`,
      );
    }
    const bytes = readFileSync(realSource);
    const digest = sha256Bytes(bytes);
    if (bytes.byteLength !== row.size_bytes || digest !== row.digest_sha256) {
      throw new BackupRestoreError(
        "backup_incomplete",
        `Referenced artifact changed or is corrupt: ${row.project_id}/${relativePath}`,
      );
    }

    const bundleRelative = artifactBundleRelativePath(row.project_id, relativePath);
    const target = assertContained(
      tempRoot,
      join(tempRoot, bundleRelative),
      "Bundle artifact path",
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
    return {
      projectId: row.project_id,
      relativePath,
      sizeBytes: bytes.byteLength,
      sha256: digest,
    };
  }

  private verifyBundle(
    bundleRoot: string,
    manifest: BackupManifest,
    expectedDatabaseSha: string,
  ): { reasons: string[]; databaseSizeBytes: number } {
    const reasons: string[] = [];
    const dbPath = join(bundleRoot, BACKUP_DATABASE_FILE);
    if (!existsSync(dbPath)) {
      reasons.push("database_missing");
    } else {
      const stats = lstatSync(dbPath);
      if (!stats.isFile()) reasons.push("database_not_regular_file");
      if (stats.size !== manifest.database.sizeBytes) reasons.push("database_size_mismatch");
      const digest = sha256File(dbPath);
      if (digest !== manifest.database.sha256) reasons.push("database_digest_mismatch");
      if (expectedDatabaseSha && digest !== expectedDatabaseSha) {
        reasons.push("database_recorded_digest_mismatch");
      }
    }

    const seen = new Set<string>();
    for (const artifact of manifest.artifacts) {
      const key = `${artifact.projectId}\u0000${artifact.relativePath}`;
      if (seen.has(key)) {
        reasons.push(`duplicate_artifact:${artifact.relativePath}`);
        continue;
      }
      seen.add(key);
      let relative: string;
      try {
        relative = artifactBundleRelativePath(artifact.projectId, artifact.relativePath);
      } catch {
        reasons.push(`unsafe_artifact_path:${artifact.relativePath}`);
        continue;
      }
      const target = join(bundleRoot, relative);
      if (!isWithin(target, join(bundleRoot, "artifacts"))) {
        reasons.push(`unsafe_artifact_path:${artifact.relativePath}`);
        continue;
      }
      if (!existsSync(target)) {
        reasons.push(`artifact_missing:${artifact.projectId}/${artifact.relativePath}`);
        continue;
      }
      const stats = lstatSync(target);
      if (!stats.isFile()) {
        reasons.push(`artifact_not_regular_file:${artifact.relativePath}`);
        continue;
      }
      const digest = sha256File(target);
      if (stats.size !== artifact.sizeBytes) {
        reasons.push(`artifact_size_mismatch:${artifact.relativePath}`);
      }
      if (digest !== artifact.sha256) {
        reasons.push(`artifact_digest_mismatch:${artifact.relativePath}`);
      }
    }

    return { reasons, databaseSizeBytes: manifest.database.sizeBytes };
  }

  private readBundleManifest(bundleRoot: string): BackupManifest {
    const manifestPath = join(bundleRoot, BACKUP_MANIFEST_FILE);
    const hashPath = join(bundleRoot, BACKUP_MANIFEST_HASH_FILE);
    if (!existsSync(manifestPath) || !existsSync(hashPath)) {
      throw new BackupRestoreError(
        "restore_validation_failed",
        "Backup manifest or manifest hash is missing",
      );
    }
    const raw = readFileSync(manifestPath, "utf8");
    const expected = readFileSync(hashPath, "utf8").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BackupRestoreError(
        "restore_validation_failed",
        "Backup manifest is not valid JSON",
      );
    }
    const result = backupManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new BackupRestoreError(
        "restore_validation_failed",
        `Backup manifest is invalid: ${result.error.issues[0]?.message ?? "schema mismatch"}`,
      );
    }
    const manifest = result.data;
    const actual = sha256Bytes(Buffer.from(raw, "utf8"));
    if (actual !== expected || actual !== manifestHash(manifest)) {
      throw new BackupRestoreError(
        "restore_validation_failed",
        "Backup manifest hash does not match its recorded digest",
      );
    }
    if (manifest.manifestVersion !== BACKUP_MANIFEST_VERSION) {
      throw new BackupRestoreError(
        "restore_validation_failed",
        `Unsupported backup manifest version ${manifest.manifestVersion}; this build supports ${BACKUP_MANIFEST_VERSION}`,
      );
    }
    return manifest;
  }

  private recordSnapshot(row: SnapshotInput): void {
    this.insertSnapshot(this.db, row);
  }

  /**
   * Failure audit must not block behind the same writers that prevented the
   * snapshot. Use a bounded independent connection and swallow a failed audit
   * write: a failed backup is never advertised as restorable either way.
   */
  private recordFailedSnapshot(row: SnapshotInput): void {
    let conn: DatabaseSync | null = null;
    try {
      conn = new DatabaseSync(this.databasePath);
      conn.exec(`PRAGMA busy_timeout = 250;`);
      this.insertSnapshot(conn, row);
    } catch {
    } finally {
      try {
        conn?.close();
      } catch {}
    }
  }

  private insertSnapshot(db: DatabaseSync, row: SnapshotInput): void {
    db.prepare(
      `INSERT INTO backup_snapshots
           (id, destination_path, manifest_version, manifest_hash, database_sha256,
            database_size_bytes, artifact_count, schema_version, status, created_by, error,
            verified_at, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(destination_path) DO UPDATE SET
           manifest_version = excluded.manifest_version,
           manifest_hash = excluded.manifest_hash,
           database_sha256 = excluded.database_sha256,
           database_size_bytes = excluded.database_size_bytes,
           artifact_count = excluded.artifact_count,
           schema_version = excluded.schema_version,
           status = excluded.status,
           created_by = excluded.created_by,
           error = excluded.error,
           verified_at = excluded.verified_at,
           created_at = excluded.created_at,
           finished_at = excluded.finished_at`,
    ).run(
      row.id,
      row.destinationPath,
      row.manifestVersion,
      row.manifestHash,
      row.databaseSha256,
      row.databaseSizeBytes,
      row.artifactCount,
      row.schemaVersion,
      row.status,
      row.createdBy,
      row.error,
      row.verifiedAt,
      row.createdAt,
      row.finishedAt,
    );
  }

  private getSnapshotById(id: string): BackupSnapshotRecord | null {
    const row = this.db.prepare("SELECT * FROM backup_snapshots WHERE id = ?").get(id) as
      | SnapshotRow
      | undefined;
    return row ? mapSnapshot(row) : null;
  }

  // ------------------------------------------------------------------
  // Restore
  // ------------------------------------------------------------------

  restoreBackup(input: {
    sourcePath: string;
    targetStateDir: string;
    targetHome?: string;
    actor?: string;
  }): RestoreCreateResult {
    const source = resolve(input.sourcePath);
    const target = resolve(input.targetStateDir);
    const targetHome = resolve(
      input.targetHome ?? (basename(target) === "state" ? dirname(target) : target),
    );
    const startedAt = this.now();
    const id = `restore_${randomUUID()}`;
    const temp = `${target}.restore-${randomUUID()}`;
    let manifestHashValue = "0".repeat(64);
    let stage = "validate_target";

    const fail = (error: unknown): never => {
      try {
        rmSync(temp, { recursive: true, force: true });
      } catch {}
      const message = error instanceof Error ? error.message : String(error);
      const code: OperatorErrorCode =
        error instanceof BackupRestoreError
          ? error.code
          : error instanceof InstallationHeldError
            ? "installation_held"
            : "restore_failed";
      const report = {
        ok: false,
        stage,
        code,
        error: message,
        sourcePath: source,
        targetStateDir: target,
        manifestHash: manifestHashValue,
        partialActivation: false,
      };
      this.recordRestore({
        id,
        sourcePath: source,
        targetStateDir: target,
        manifestHash: manifestHashValue,
        status: "failed",
        report,
        createdAt: startedAt,
        finishedAt: this.now(),
      });
      if (error instanceof BackupRestoreError) throw error;
      throw new BackupRestoreError(code, message, { stage });
    };

    try {
      if (isWithin(target, this.stateDir) || isWithin(this.stateDir, target)) {
        throw new BackupRestoreError(
          "restore_target_unavailable",
          "Restore target must be an isolated state directory, not the live Animus state directory",
        );
      }
      if (isWithin(target, source) || isWithin(source, target)) {
        throw new BackupRestoreError(
          "restore_target_unavailable",
          "Restore target must not overlap the backup bundle",
        );
      }
      assertNoSymlinkedComponents(target);
      if (!existingDirectoryIsEmptyOrAbsent(target)) {
        throw new BackupRestoreError(
          "restore_target_unavailable",
          `Restore target already exists and is not empty: ${target}`,
        );
      }

      stage = "read_manifest";
      const manifest = this.readBundleManifest(source);
      manifestHashValue = manifestHash(manifest);

      stage = "verify_bundle";
      const verification = this.verifyBundle(source, manifest, manifest.database.sha256);
      if (verification.reasons.length > 0) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          `Backup bundle is incomplete or corrupt: ${verification.reasons.join(", ")}`,
          { reasons: verification.reasons },
        );
      }

      stage = "stage_database";
      mkdirSync(temp, { recursive: true });
      const stagedDbPath = join(temp, BACKUP_DATABASE_FILE);
      copyFileSync(join(source, BACKUP_DATABASE_FILE), stagedDbPath);
      const stagedDigest = sha256File(stagedDbPath);
      if (stagedDigest !== manifest.database.sha256) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          "Staged database digest differs from the verified backup manifest",
        );
      }

      stage = "copy_artifacts";
      this.copyArtifactsFromBundle(source, join(temp, "artifacts"), manifest);

      stage = "apply_schema";
      let restoredDb: DatabaseSync;
      try {
        restoredDb = initializeDatabase(stagedDbPath);
      } catch (error) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          `Snapshot schema is incompatible with this build: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let report: Record<string, unknown>;
      try {
        stage = "validate_state";
        this.validateRestoredDatabase(restoredDb, manifest);

        stage = "hold_installation";
        report = this.holdRestoredInstallation(restoredDb, {
          manifest,
          source,
          target,
          targetHome,
          // Final, post-rename artifact root: a staged temp path would disappear.
          targetArtifactRoot: join(target, "artifacts"),
          restoreId: id,
          now: this.now(),
        });
      } finally {
        try {
          restoredDb.close();
        } catch {}
      }

      stage = "verify_restored_database";
      const finalCheck = new DatabaseSync(stagedDbPath, { readOnly: true });
      try {
        const integrity = finalCheck.prepare("PRAGMA integrity_check;").get() as
          | { integrity_check?: string }
          | undefined;
        if (integrity?.integrity_check !== "ok") {
          throw new BackupRestoreError(
            "restore_validation_failed",
            `Restored database integrity check failed: ${integrity?.integrity_check ?? "unknown"}`,
          );
        }
        if (finalCheck.prepare("PRAGMA foreign_key_check;").all().length > 0) {
          throw new BackupRestoreError(
            "restore_validation_failed",
            "Restored database has foreign-key violations",
          );
        }
      } finally {
        finalCheck.close();
      }

      stage = "finalize";
      if (existsSync(target)) rmdirSync(target);
      renameSync(temp, target);

      const finishedAt = this.now();
      const record = {
        id,
        sourcePath: source,
        targetStateDir: target,
        manifestHash: manifestHashValue,
        status: "completed" as const,
        report: { ...report, ok: true },
        createdAt: startedAt,
        finishedAt,
      };
      const operation = this.recordRestore(record);

      // The restored installation owns its own restore history, so its status and
      // UI report the operation that produced it instead of an empty ledger.
      const restoredWrite = initializeDatabase(join(target, BACKUP_DATABASE_FILE));
      try {
        this.writeRestoreRecord(restoredWrite, record);
      } finally {
        try {
          restoredWrite.close();
        } catch {}
      }

      const restored = new DatabaseSync(join(target, BACKUP_DATABASE_FILE), { readOnly: true });
      let installation: InstallationHold;
      try {
        installation = readInstallationHold(restored);
      } finally {
        restored.close();
      }

      return { operation, installation };
    } catch (error) {
      return fail(error);
    }
  }

  restoreStatus(stateDir?: string): RestoreStatusResult {
    const targetState = resolve(stateDir ?? this.stateDir);
    const targetDbPath = join(targetState, BACKUP_DATABASE_FILE);
    const isLive = targetState === this.stateDir;
    if (!isLive && !existsSync(targetDbPath)) {
      throw new BackupRestoreError(
        "restore_target_unavailable",
        `No restored installation at ${targetDbPath}`,
      );
    }
    const db = isLive ? this.db : initializeDatabase(targetDbPath);
    try {
      const installation = readInstallationHold(db);
      const lastRestoreRow = db
        .prepare("SELECT * FROM restore_operations ORDER BY created_at DESC, id DESC LIMIT 1")
        .get() as RestoreRow | undefined;
      const heldRunCount = Number(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM dispatch_runs WHERE state = 'interrupted'")
            .get() as { count: number } | undefined
        )?.count ?? 0,
      );
      const pendingPublicationIntentCount = Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM publication_intents WHERE state IN ('queued', 'attempting', 'failed', 'unknown')",
            )
            .get() as { count: number } | undefined
        )?.count ?? 0,
      );
      return {
        installation,
        lastRestore: lastRestoreRow ? mapRestore(lastRestoreRow) : null,
        heldRunCount,
        pendingPublicationIntentCount,
        unresolved: enumerateRestoreUnresolved(db),
      };
    } finally {
      if (!isLive) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  /**
   * Verified release of a restored installation.
   *
   * A free-text reason cannot clear the hold: the caller must enumerate every
   * interrupted run and every pending/unknown external intent, and the server
   * independently verifies copied owner identity was cleared and reads the remote
   * outcome (read-only) before accepting each disposition. Budgets, laps and
   * history are never touched here.
   */
  async reconcileRestore(
    input: {
      actor: string;
      reason: string;
      snapshot: { sourceRestoreId: string; restoredAt: number };
      runs: ReleaseDispositions["runs"];
      intents: ReleaseDispositions["intents"];
    },
    stateDir?: string,
  ): Promise<InstallationHold> {
    const targetState = resolve(stateDir ?? this.stateDir);
    const targetDbPath = join(targetState, BACKUP_DATABASE_FILE);
    const isLive = targetState === this.stateDir;
    const db = isLive ? this.db : initializeDatabase(targetDbPath);
    try {
      const hold = readInstallationHold(db);
      if (!hold.held) {
        throw new BackupRestoreError(
          "restore_target_unavailable",
          "This installation is not held by a restore; nothing to reconcile",
        );
      }
      if (
        hold.sourceRestoreId !== input.snapshot.sourceRestoreId ||
        hold.restoredAt !== input.snapshot.restoredAt
      ) {
        throw new BackupRestoreError(
          "restore_reconcile_conflict",
          "The held installation changed since it was inspected; re-read the restored snapshot and retry",
        );
      }

      const now = this.now();
      let verification: Awaited<ReturnType<typeof verifyRestoreRelease>>;
      try {
        verification = await verifyRestoreRelease({
          db,
          forge: this.forge,
          dispositions: { runs: input.runs, intents: input.intents },
          now,
        });
      } catch (error) {
        if (error instanceof RestoreReleaseError) {
          throw new BackupRestoreError(error.code, error.message, error.details);
        }
        throw error;
      }

      const reconciliation = {
        releasedAt: now,
        actor: input.actor,
        reason: input.reason,
        snapshot: input.snapshot,
        runs: verification.report.runs,
        intents: verification.report.intents,
        unresolvedRunCount: verification.report.unresolvedRunCount,
        unresolvedIntentCount: verification.report.unresolvedIntentCount,
      };

      const ledger = isLive && this.ledger ? this.ledger : new CommandLedger(db);
      const requestId = `cmd_restore_release_${hold.sourceRestoreId ?? "unknown"}_${now}`;
      let released: InstallationHold;
      try {
        settleRestoreRelease({
          db,
          verification,
          dispositions: { runs: input.runs, intents: input.intents },
          expected: input.snapshot,
          actor: input.actor,
          now,
          reconciliation,
          ledger,
          requestId,
        });
        released = readInstallationHold(db);
      } catch (error) {
        if (error instanceof RestoreReleaseError) {
          throw new BackupRestoreError(error.code, error.message, error.details);
        }
        throw error;
      }

      return released;
    } finally {
      if (!isLive) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  private copyArtifactsFromBundle(
    bundleRoot: string,
    targetArtifactRoot: string,
    manifest: BackupManifest,
  ): void {
    mkdirSync(targetArtifactRoot, { recursive: true });
    for (const artifact of manifest.artifacts) {
      const relative = artifactBundleRelativePath(artifact.projectId, artifact.relativePath);
      const source = assertContained(
        bundleRoot,
        join(bundleRoot, relative),
        "Bundle artifact path",
      );
      const stats = lstatSync(source);
      if (!stats.isFile()) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          `Bundle artifact is not a regular file: ${artifact.relativePath}`,
        );
      }
      const bytes = readFileSync(source);
      if (bytes.byteLength !== artifact.sizeBytes || sha256Bytes(bytes) !== artifact.sha256) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          `Bundle artifact digest changed during restore: ${artifact.relativePath}`,
        );
      }
      const destination = assertContained(
        targetArtifactRoot,
        join(targetArtifactRoot, artifact.projectId, artifact.relativePath),
        "Restored artifact path",
      );
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { mode: 0o600 });
    }
  }

  private validateRestoredDatabase(db: DatabaseSync, manifest: BackupManifest): void {
    const integrity = db.prepare("PRAGMA integrity_check;").get() as
      | { integrity_check?: string }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new BackupRestoreError(
        "restore_validation_failed",
        `Restored database integrity check failed: ${integrity?.integrity_check ?? "unknown"}`,
      );
    }
    const violations = db.prepare("PRAGMA foreign_key_check;").all();
    if (violations.length > 0) {
      throw new BackupRestoreError(
        "restore_validation_failed",
        `Restored database has ${violations.length} foreign-key violation(s)`,
        { violations: violations.length },
      );
    }

    // Manifest completeness counts must match the restored database, not just
    // the DB digest; an older bundle must never claim tables it did not capture.
    for (const table of COUNTED_TABLES) {
      const expected = manifest.completeness.tables[table];
      if (expected === undefined) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          `Backup manifest has no completeness count for ${table}`,
        );
      }
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
        | { count: number }
        | undefined;
      const actual = Number(count?.count ?? 0);
      if (actual !== expected) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          `Restored ${table} has ${actual} row(s) but the manifest recorded ${expected}`,
        );
      }
    }

    const rows = db
      .prepare(
        `SELECT project_id, owner_type, owner_id, relative_path, size_bytes, digest_sha256
           FROM execution_artifacts
          ORDER BY project_id ASC, relative_path ASC, owner_type ASC, owner_id ASC`,
      )
      .all() as unknown as ArtifactRow[];
    if (rows.length !== manifest.completeness.artifactRows) {
      throw new BackupRestoreError(
        "restore_validation_failed",
        `Artifact completeness mismatch: database has ${rows.length} row(s), manifest recorded ${manifest.completeness.artifactRows}`,
      );
    }
    const byKey = new Map(
      manifest.artifacts.map((artifact) => [
        `${artifact.projectId}\u0000${artifact.relativePath}`,
        artifact,
      ]),
    );
    const referenced = new Set<string>();
    for (const row of rows) {
      const key = `${row.project_id}\u0000${row.relative_path}`;
      const expected = byKey.get(key);
      if (!expected) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          `Artifact row is missing from the backup manifest: ${row.project_id}/${row.relative_path}`,
        );
      }
      referenced.add(key);
      if (expected.sizeBytes !== row.size_bytes || expected.sha256 !== row.digest_sha256) {
        throw new BackupRestoreError(
          "restore_validation_failed",
          `Artifact row disagrees with the backup manifest: ${row.project_id}/${row.relative_path}`,
        );
      }
    }
    if (referenced.size !== manifest.artifacts.length) {
      throw new BackupRestoreError(
        "restore_validation_failed",
        "Backup manifest lists finalized artifacts that no restored row references",
      );
    }
  }

  private holdRestoredInstallation(
    db: DatabaseSync,
    input: {
      manifest: BackupManifest;
      source: string;
      target: string;
      targetHome: string;
      targetArtifactRoot: string;
      restoreId: string;
      now: number;
    },
  ): Record<string, unknown> {
    const worktreeRewrites = this.rewriteHomeLocalPaths(db, {
      source: input.manifest.source,
      targetStateDir: input.target,
      targetArtifactRoot: input.targetArtifactRoot,
      targetHome: input.targetHome,
    });

    const interrupted = db
      .prepare(
        `UPDATE dispatch_runs
            SET state = 'interrupted', updated_at = ?
          WHERE state IN ('claimed', 'dispatched', 'running')`,
      )
      .run(input.now);

    // A restored installation must never inherit a live owner identity. PIDs and
    // leases belong to the old OS process tree; a reused PID is not authority and
    // is never signalled. Rotating the fencing token also means the copied token
    // cannot claim ownership here. Historical attribution is retained separately
    // as hashes in the restore report.
    const priorOwners = db
      .prepare(
        `SELECT id, owner_pid, owner_token, lease_expires_at
           FROM dispatch_runs
          WHERE state IN ('claimed', 'dispatched', 'running', 'interrupted')
          ORDER BY id ASC`,
      )
      .all() as unknown as Array<{
      id: string;
      owner_pid: number | null;
      owner_token: string;
      lease_expires_at: number | null;
    }>;
    const clearOwner = db.prepare(
      `UPDATE dispatch_runs
          SET state = 'interrupted',
              owner_pid = NULL,
              lease_expires_at = NULL,
              owner_token = ?,
              ownership_generation = ownership_generation + 1,
              updated_at = ?
        WHERE id = ?`,
    );
    const clearedOwners: Array<{
      runId: string;
      priorOwnerPid: number | null;
      priorLeaseExpiresAt: number | null;
      priorOwnerTokenSha256: string;
    }> = [];
    for (const row of priorOwners) {
      clearOwner.run(randomUUID(), input.now, row.id);
      clearedOwners.push({
        runId: row.id,
        priorOwnerPid: row.owner_pid,
        priorLeaseExpiresAt: row.lease_expires_at,
        priorOwnerTokenSha256: sha256Bytes(Buffer.from(row.owner_token, "utf8")),
      });
    }

    const heldControls = db
      .prepare(
        `UPDATE execution_controls
            SET status = 'held', reason = ?, updated_at = ?
          WHERE status IN ('active', 'stopping')`,
      )
      .run(
        "Restored installation is held pending ownership and external reconciliation",
        input.now,
      );

    const pendingIntents = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM publication_intents WHERE state IN ('queued', 'attempting', 'failed', 'unknown')",
          )
          .get() as { count: number } | undefined
      )?.count ?? 0,
    );
    const activeRuns = db
      .prepare(
        "SELECT id, worktree_path, branch, state FROM dispatch_runs WHERE state IN ('interrupted', 'claimed', 'dispatched', 'running') ORDER BY id ASC",
      )
      .all() as unknown as Array<{
      id: string;
      worktree_path: string;
      branch: string;
      state: string;
    }>;

    db.prepare(
      `INSERT INTO installation_holds
         (id, status, reason, source_restore_id, restored_at, reconciled_at, reconciled_by)
       VALUES ('installation', 'held', ?, ?, ?, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         status = 'held',
         reason = excluded.reason,
         source_restore_id = excluded.source_restore_id,
         restored_at = excluded.restored_at,
         reconciled_at = NULL,
         reconciled_by = NULL`,
    ).run(
      "Restored installation is held pending ownership and external reconciliation; dispatch and publication are disabled",
      input.restoreId,
      input.now,
    );

    return {
      sourcePath: input.source,
      targetStateDir: input.target,
      targetHome: input.targetHome,
      manifestHash: manifestHash(input.manifest),
      schemaVersion: input.manifest.build.schemaVersion,
      artifactCount: input.manifest.artifacts.length,
      interruptedRunCount: Number(interrupted.changes ?? 0),
      heldControlCount: Number(heldControls.changes ?? 0),
      pendingPublicationIntentCount: pendingIntents,
      rewrittenPathCount: worktreeRewrites.rewritten,
      clearedOwnerCount: clearedOwners.length,
      clearedOwners,
      projectCheckouts: worktreeRewrites.projectCheckouts,
      worktreePathsNotResurrected: activeRuns.map((run) => ({
        run_id: run.id,
        branch: run.branch,
        state: run.state,
        worktree_path: run.worktree_path,
      })),
      dispatchEnabled: false,
      publicationEnabled: false,
      credentials: CREDENTIAL_NOTICE,
      limitations: LIMITATIONS,
    };
  }

  private rewriteHomeLocalPaths(
    db: DatabaseSync,
    input: {
      source: BackupManifest["source"];
      targetStateDir: string;
      targetArtifactRoot: string;
      targetHome: string;
    },
  ): {
    rewritten: number;
    projectCheckouts: Array<{
      projectId: string;
      checkoutPath: string;
      rewritten: boolean;
      present: boolean;
      rehomeRequired: boolean;
    }>;
  } {
    const pairs = (
      [
        [resolve(input.source.artifactRoot), resolve(input.targetArtifactRoot)],
        [resolve(input.source.stateDir), resolve(input.targetStateDir)],
        [resolve(input.source.home), resolve(input.targetHome)],
        [resolve(input.source.worktreesDir), resolve(join(input.targetHome, "worktrees"))],
      ] as Array<[string, string]>
    )
      .filter(([from, to]) => from !== to)
      .sort((left, right) => right[0].length - left[0].length);

    const rewrite = (value: string): string => {
      for (const [from, to] of pairs) {
        if (value === from) return to;
        if (value.startsWith(from + sep)) return to + value.slice(from.length);
      }
      return value;
    };

    let rewritten = 0;
    const runs = db
      .prepare("SELECT id, worktree_path FROM dispatch_runs")
      .all() as unknown as Array<{ id: string; worktree_path: string }>;
    const updateRun = db.prepare("UPDATE dispatch_runs SET worktree_path = ? WHERE id = ?");
    for (const run of runs) {
      const next = rewrite(run.worktree_path);
      if (next !== run.worktree_path) {
        updateRun.run(next, run.id);
        rewritten += 1;
      }
    }

    const scopes = db
      .prepare(
        "SELECT id, retained_worktree_path FROM execution_budget_scopes WHERE retained_worktree_path IS NOT NULL",
      )
      .all() as unknown as Array<{ id: string; retained_worktree_path: string }>;
    const updateScope = db.prepare(
      "UPDATE execution_budget_scopes SET retained_worktree_path = ? WHERE id = ?",
    );
    for (const scope of scopes) {
      const next = rewrite(scope.retained_worktree_path);
      if (next !== scope.retained_worktree_path) {
        updateScope.run(next, scope.id);
        rewritten += 1;
      }
    }

    // Project checkouts are absolute and may live outside the Animus home. Rehome
    // only genuine home-local roots; otherwise report the surviving path and
    // whether it is still readable so a restored home never silently pretends a
    // deleted checkout exists.
    const projectCheckouts: Array<{
      projectId: string;
      checkoutPath: string;
      rewritten: boolean;
      present: boolean;
      rehomeRequired: boolean;
    }> = [];
    const projects = db
      .prepare("SELECT id, checkout_path FROM projects ORDER BY id ASC")
      .all() as unknown as Array<{ id: string; checkout_path: string }>;
    const updateProject = db.prepare("UPDATE projects SET checkout_path = ? WHERE id = ?");
    for (const project of projects) {
      const next = rewrite(project.checkout_path);
      const changed = next !== project.checkout_path;
      if (changed) {
        updateProject.run(next, project.id);
        rewritten += 1;
      }
      const present = existsSync(next);
      projectCheckouts.push({
        projectId: project.id,
        checkoutPath: next,
        rewritten: changed,
        present,
        rehomeRequired: !changed && !present,
      });
    }

    return { rewritten, projectCheckouts };
  }

  private recordRestore(row: RestoreRecordInput): RestoreOperationRecord {
    this.writeRestoreRecord(this.db, row);
    return {
      id: row.id,
      sourcePath: row.sourcePath,
      targetStateDir: row.targetStateDir,
      manifestHash: row.manifestHash,
      status: row.status,
      report: row.report,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    };
  }

  private writeRestoreRecord(db: DatabaseSync, row: RestoreRecordInput): void {
    db.prepare(
      `INSERT INTO restore_operations
           (id, source_path, target_state_dir, manifest_hash, status, report, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, report = excluded.report, finished_at = excluded.finished_at`,
    ).run(
      row.id,
      row.sourcePath,
      row.targetStateDir,
      row.manifestHash,
      row.status,
      JSON.stringify(row.report),
      row.createdAt,
      row.finishedAt,
    );
  }
}

interface RestoreRecordInput {
  id: string;
  sourcePath: string;
  targetStateDir: string;
  manifestHash: string;
  status: "completed" | "failed";
  report: Record<string, unknown>;
  createdAt: number;
  finishedAt: number;
}

/**
 * A restore never writes through a symlink planted at the target itself or at a
 * path component the operator created. Ancestor symlinks that already exist
 * (for example macOS `/var -> /private/var`) are resolved by the operating
 * system and are not a destination escape; the target is created by this
 * service, so the final component is the only new path segment that can be
 * redirected.
 */
function assertNoSymlinkedComponents(target: string): void {
  const resolved = resolve(target);
  const parent = dirname(resolved);
  for (const [label, candidate] of [
    ["target", resolved],
    ["target parent", parent],
  ] as const) {
    if (!existsSync(candidate)) continue;
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) {
      throw new BackupRestoreError(
        "restore_target_unavailable",
        `Restore ${label} is a symbolic link and cannot be used as a destination: ${candidate}`,
      );
    }
  }
}

function existingDirectoryIsEmptyOrAbsent(dirPath: string): boolean {
  if (!existsSync(dirPath)) return true;
  const stats = lstatSync(dirPath);
  if (!stats.isDirectory()) return false;
  return readdirSync(dirPath).length === 0;
}
