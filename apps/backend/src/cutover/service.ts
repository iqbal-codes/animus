import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CutoverAbortResult,
  CutoverAbortSubmission,
  CutoverActivateResult,
  CutoverActivateSubmission,
  CutoverBackupStatus,
  CutoverMapping,
  CutoverMappingSummary,
  CutoverMappingsResult,
  CutoverOperation,
  CutoverOperationStatus,
  CutoverRestoreEvidence,
  CutoverSnapshotEvidence,
  CutoverStageResult,
  CutoverStageSubmission,
  CutoverStatus,
} from "@animus/contracts/cutover";
import { readInstallationHold } from "@animus/contracts/installation-hold";
import { resolveAnimusHome, resolveAnimusStateDir } from "@animus/contracts/paths";
import {
  ExecutionAuthorityConflictError,
  readExecutionAuthority,
  resolveExecutionAuthorityPath,
  writeExecutionAuthority,
  type ExecutionAuthority,
} from "@animus/contracts/execution-authority";
import type { BackupRestoreService } from "../restore/service";
import { inventoryInstallation, type CutoverInventory } from "./inventory";
import { withCutoverLock } from "./lock";

export type AuthorityCutoverErrorCode =
  | "cutover_already_active"
  | "cutover_not_staged"
  | "cutover_writers_active"
  | "cutover_state_changed"
  | "cutover_backup_invalid"
  | "cutover_restore_invalid"
  | "cutover_inconsistent"
  | "cutover_expected_mismatch"
  | "cutover_not_abortable"
  | "cutover_failed";

export class AuthorityCutoverError extends Error {
  constructor(
    public readonly code: AuthorityCutoverErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthorityCutoverError";
  }
}

export interface AuthorityCutoverServiceOptions {
  stateDir?: string;
  home?: string;
  /** Explicit live database file; defaults to `<stateDir>/console.db`. */
  databasePath?: string;
  backup: BackupRestoreService;
  now?: () => number;
}

interface OperationRow {
  id: string;
  status: CutoverOperationStatus;
  actor: string;
  inventory_sha256: string | null;
  backup_snapshot_id: string | null;
  backup_path: string | null;
  backup_manifest_sha256: string | null;
  restore_operation_id: string | null;
  restore_target_state_dir: string | null;
  held_count: number;
  total_rows: number;
  report: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  activated_at: number | null;
}

interface RestoredInspection {
  operationId: string;
  targetStateDir: string;
  held: boolean;
  sourceRestoreId: string | null;
  manifestHash: string | null;
  schemaVersion: number;
  inventory: CutoverInventory;
}

function parseReport(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { raw };
  }
}

function mapOperation(row: OperationRow): CutoverOperation {
  return {
    id: row.id,
    status: row.status,
    actor: row.actor,
    inventorySha256: row.inventory_sha256,
    backupSnapshotId: row.backup_snapshot_id,
    backupPath: row.backup_path,
    backupManifestSha256: row.backup_manifest_sha256,
    restoreOperationId: row.restore_operation_id,
    restoreTargetStateDir: row.restore_target_state_dir,
    heldCount: Number(row.held_count),
    totalRows: Number(row.total_rows),
    report: parseReport(row.report),
    error: row.error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    activatedAt: row.activated_at === null ? null : Number(row.activated_at),
  };
}

function summarizeMappings(mappings: readonly CutoverMapping[]): CutoverMappingSummary {
  return mappings.reduce<CutoverMappingSummary>(
    (summary, mapping) => {
      summary.total += 1;
      if (mapping.disposition === "preserved") summary.preserved += 1;
      if (mapping.disposition === "preserved_history") summary.preservedHistory += 1;
      if (mapping.disposition === "adopted") summary.adopted += 1;
      if (mapping.disposition === "held") summary.held += 1;
      return summary;
    },
    { total: 0, preserved: 0, preservedHistory: 0, adopted: 0, held: 0 },
  );
}

function mergeMappings(
  snapshot: readonly CutoverMapping[],
  restored: readonly CutoverMapping[],
): CutoverMapping[] {
  const restoredByKey = new Map(
    restored.map((mapping) => [`${mapping.entity}\u0000${mapping.legacyId}`, mapping]),
  );
  return snapshot.map((mapping) => {
    const target = restoredByKey.get(`${mapping.entity}\u0000${mapping.legacyId}`);
    if (!target) {
      return {
        ...mapping,
        disposition: "held",
        reason: "identity missing from the isolated restore; cutover cannot prove preservation",
      };
    }
    if (mapping.disposition === "held") {
      return { ...mapping, newId: target.newId, newHash: target.newHash };
    }
    if (target.newHash !== mapping.legacyHash) {
      return {
        ...mapping,
        newId: target.newId,
        newHash: target.newHash,
        disposition: "adopted",
        reason: "restore terminalised in-flight ownership; stable identity preserved",
      };
    }
    return { ...mapping, newId: target.newId, newHash: target.newHash };
  });
}

/**
 * Durable, restartable cutover from mixed legacy control to the single local
 * execution authority.
 *
 * Staging writes the `migrating` fence first, drains writers at SQLite's lock
 * boundary by taking a verified backup, proves an isolated held restore, and
 * records deterministic old/new identity mappings. Activation re-inventories the
 * live installation, re-verifies the exact backup and held restore, then writes
 * the single `local` marker with fsync + compare-and-swap. Every crash boundary
 * is resumed through the same operation row.
 */
export class AuthorityCutoverService {
  private readonly stateDir: string;
  private readonly home: string;
  private readonly databasePath: string;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: AuthorityCutoverServiceOptions,
  ) {
    this.stateDir = resolve(options.stateDir ?? resolveAnimusStateDir());
    this.home = resolve(options.home ?? resolveAnimusHome());
    this.databasePath = options.databasePath ?? join(this.stateDir, "console.db");
    this.now = options.now ?? (() => Date.now());
  }

  private get backup(): BackupRestoreService {
    return this.options.backup;
  }

  private inventoryLive(): CutoverInventory {
    return inventoryInstallation(this.db, {
      stateDir: this.stateDir,
      home: this.home,
      now: this.now,
    });
  }

  private inventoryRestored(targetStateDir: string): CutoverInventory {
    const db = new DatabaseSync(join(targetStateDir, "console.db"), { readOnly: true });
    try {
      return inventoryInstallation(db, {
        stateDir: targetStateDir,
        home: this.home,
        artifactRoot: join(targetStateDir, "artifacts"),
        includeLegacyState: false,
        now: this.now,
      });
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  private inspectRestoreTarget(
    targetStateDir: string,
    expectedManifestHash: string | null,
  ): RestoredInspection {
    const db = new DatabaseSync(join(targetStateDir, "console.db"), { readOnly: true });
    try {
      const hold = readInstallationHold(db);
      const lastRestore = db
        .prepare(
          "SELECT id, manifest_hash FROM restore_operations ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .get() as { id: string; manifest_hash: string } | undefined;
      if (!lastRestore) {
        throw new AuthorityCutoverError(
          "cutover_restore_invalid",
          `Isolated restore at ${targetStateDir} has no restore operation record`,
        );
      }
      if (expectedManifestHash && lastRestore.manifest_hash !== expectedManifestHash) {
        throw new AuthorityCutoverError(
          "cutover_restore_invalid",
          "Isolated restore was produced from a different backup manifest",
          { expected: expectedManifestHash, actual: lastRestore.manifest_hash },
        );
      }
      const schemaVersion = Number(
        (
          db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
            | { version: number | null }
            | undefined
        )?.version ?? 0,
      );
      return {
        operationId: lastRestore.id,
        targetStateDir,
        held: hold.held,
        sourceRestoreId: hold.sourceRestoreId,
        manifestHash: lastRestore.manifest_hash,
        schemaVersion,
        inventory: this.inventoryRestored(targetStateDir),
      };
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  private mappingRows(cutoverId: string): CutoverMapping[] {
    const rows = this.db
      .prepare(
        `SELECT entity, legacy_id, new_id, legacy_hash, new_hash, disposition, reason
           FROM authority_cutover_mappings
          WHERE cutover_id = ?
          ORDER BY entity ASC, legacy_id ASC`,
      )
      .all(cutoverId) as unknown as Array<{
      entity: string;
      legacy_id: string;
      new_id: string;
      legacy_hash: string;
      new_hash: string;
      disposition: CutoverMapping["disposition"];
      reason: string | null;
    }>;
    return rows.map((row) => ({
      entity: row.entity,
      legacyId: row.legacy_id,
      newId: row.new_id,
      legacyHash: row.legacy_hash,
      newHash: row.new_hash,
      disposition: row.disposition,
      reason: row.reason,
    }));
  }

  mappings(cutoverId: string): CutoverMappingsResult {
    const operation = this.getOperation(cutoverId);
    if (!operation) {
      throw new AuthorityCutoverError("cutover_not_staged", `Unknown cutover ${cutoverId}`);
    }
    return { cutoverId, mappings: this.mappingRows(cutoverId) };
  }

  private getOperation(id: string): OperationRow | undefined {
    return this.db.prepare("SELECT * FROM authority_cutover_operations WHERE id = ?").get(id) as
      | OperationRow
      | undefined;
  }

  private openOperation(): OperationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM authority_cutover_operations
          WHERE status IN ('staging', 'staged', 'activating')
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as OperationRow | undefined;
  }

  private latestOperation(): OperationRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM authority_cutover_operations ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get() as OperationRow | undefined;
  }

  private createOperation(actor: string): OperationRow {
    const id = `cutover_${randomId()}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO authority_cutover_operations
           (id, status, actor, report, created_at, updated_at)
         VALUES (?, 'staging', ?, '{}', ?, ?)`,
      )
      .run(id, actor, now, now);
    return this.getOperation(id)!;
  }

  private updateOperation(
    id: string,
    patch: Partial<
      Pick<
        OperationRow,
        | "status"
        | "actor"
        | "inventory_sha256"
        | "backup_snapshot_id"
        | "backup_path"
        | "backup_manifest_sha256"
        | "restore_operation_id"
        | "restore_target_state_dir"
        | "held_count"
        | "total_rows"
        | "report"
        | "error"
        | "activated_at"
      >
    >,
    expectedStatus?: readonly CutoverOperationStatus[],
  ): OperationRow {
    const mapping: Record<keyof typeof patch, string> = {
      status: "status",
      actor: "actor",
      inventory_sha256: "inventory_sha256",
      backup_snapshot_id: "backup_snapshot_id",
      backup_path: "backup_path",
      backup_manifest_sha256: "backup_manifest_sha256",
      restore_operation_id: "restore_operation_id",
      restore_target_state_dir: "restore_target_state_dir",
      held_count: "held_count",
      total_rows: "total_rows",
      report: "report",
      error: "error",
      activated_at: "activated_at",
    };
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    const assignments = entries.map(([key]) => `${mapping[key as keyof typeof mapping]} = ?`);
    const values = entries.map(([, value]) => value as string | number | null);
    assignments.push("updated_at = ?");
    values.push(this.now());
    const where = ["id = ?"];
    values.push(id);
    if (expectedStatus && expectedStatus.length > 0) {
      where.push(`status IN (${expectedStatus.map(() => "?").join(", ")})`);
      values.push(...expectedStatus);
    }
    const result = this.db
      .prepare(
        `UPDATE authority_cutover_operations SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`,
      )
      .run(...(values as never[]));
    if (Number(result.changes ?? 0) === 0) {
      throw new AuthorityCutoverError(
        "cutover_inconsistent",
        "Cutover operation changed while updating; re-read the status and retry",
      );
    }
    return this.getOperation(id)!;
  }

  private replaceMappings(cutoverId: string, mappings: readonly CutoverMapping[]): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare("DELETE FROM authority_cutover_mappings WHERE cutover_id = ?").run(cutoverId);
      const insert = this.db.prepare(
        `INSERT INTO authority_cutover_mappings
           (cutover_id, entity, legacy_id, new_id, legacy_hash, new_hash, disposition, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const mapping of mappings) {
        insert.run(
          cutoverId,
          mapping.entity,
          mapping.legacyId,
          mapping.newId,
          mapping.legacyHash,
          mapping.newHash,
          mapping.disposition,
          mapping.reason,
        );
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }

  private requireBackupRestorable(operation: OperationRow): CutoverBackupStatus {
    if (!operation.backup_path) {
      throw new AuthorityCutoverError(
        "cutover_backup_invalid",
        "Cutover has no staged backup bundle",
      );
    }
    const verification = this.backup.verifySnapshotAt(operation.backup_path);
    if (
      !verification.restorable ||
      !verification.manifestHash ||
      verification.manifestHash !== operation.backup_manifest_sha256
    ) {
      throw new AuthorityCutoverError(
        "cutover_backup_invalid",
        `Staged backup is no longer valid: ${verification.reasons.join(", ") || "manifest changed"}`,
        { reasons: verification.reasons },
      );
    }
    return {
      restorable: verification.restorable,
      reasons: verification.reasons,
      manifestHash: verification.manifestHash,
      databaseSha256: verification.databaseSha256,
      artifactCount: verification.artifactCount,
    };
  }

  private requireRestoreHeld(operation: OperationRow): RestoredInspection {
    if (!operation.restore_target_state_dir) {
      throw new AuthorityCutoverError(
        "cutover_restore_invalid",
        "Cutover has no isolated restore target",
      );
    }
    if (!existsSync(join(operation.restore_target_state_dir, "console.db"))) {
      throw new AuthorityCutoverError(
        "cutover_restore_invalid",
        "Isolated restore target no longer exists",
      );
    }
    const inspection = this.inspectRestoreTarget(
      operation.restore_target_state_dir,
      operation.backup_manifest_sha256,
    );
    if (!inspection.held) {
      throw new AuthorityCutoverError(
        "cutover_restore_invalid",
        "Isolated restore is not held; a released restore cannot prove cutover safety",
      );
    }
    return inspection;
  }

  status(): CutoverStatus {
    const marker = readExecutionAuthority(this.stateDir);
    const operation = this.openOperation() ?? this.latestOperation();
    const live = this.inventoryLive();
    const installationHeld = readInstallationHold(this.db).held;
    const mappings = operation ? this.mappingRows(operation.id) : [];
    const report = operation ? parseReport(operation.report) : {};
    const restoreEvidence =
      report.restore && typeof report.restore === "object"
        ? (report.restore as CutoverRestoreEvidence)
        : null;
    const backup = operation?.backup_path
      ? this.backup.verifySnapshotAt(operation.backup_path)
      : this.backup.backupStatus();
    const backupStatus: CutoverBackupStatus | null =
      "manifestHash" in backup
        ? {
            restorable: backup.restorable,
            reasons: backup.reasons,
            manifestHash: backup.manifestHash,
            databaseSha256: backup.databaseSha256,
            artifactCount: backup.artifactCount,
          }
        : backup.lastBackup
          ? {
              restorable: backup.restorable,
              reasons: backup.reasons,
              manifestHash: backup.lastBackup.manifestHash,
              databaseSha256: backup.lastBackup.databaseSha256,
              artifactCount: backup.artifactCount,
            }
          : null;

    const blockingReasons: string[] = [];
    if (marker.error) blockingReasons.push(`authority_marker_unreadable:${marker.error}`);
    if (marker.authority === "local") {
      if (!operation || operation.status !== "activated" || !marker.cutover_id) {
        blockingReasons.push("authority_marker_without_activated_cutover");
      } else if (marker.cutover_id !== operation.id) {
        blockingReasons.push("authority_marker_cutover_mismatch");
      }
    }
    if (marker.authority === "migrating" && !operation) {
      blockingReasons.push("authority_fenced_without_operation");
    }
    if (installationHeld) blockingReasons.push("installation_held");
    if (operation && ["staging", "staged", "activating"].includes(operation.status)) {
      for (const fact of live.held) {
        blockingReasons.push(`live_writer:${fact.entity}:${fact.identity}:${fact.reason}`);
      }
      const stagedLegacyState = this.stagedLegacyState(operation);
      if (stagedLegacyState && live.legacyState.digest !== stagedLegacyState.digest) {
        blockingReasons.push("legacy_state_changed_since_staging");
      }
      if (operation.inventory_sha256 && live.stateDigest !== operation.inventory_sha256) {
        blockingReasons.push("installation_changed_since_staging");
      }
      if (operation.backup_path) {
        const verification = this.backup.verifySnapshotAt(operation.backup_path);
        if (!verification.restorable) {
          blockingReasons.push(
            `staged_backup_invalid:${verification.reasons.join(",") || "unknown"}`,
          );
        }
      }
      if (operation.restore_target_state_dir) {
        try {
          const inspection = this.inspectRestoreTarget(
            operation.restore_target_state_dir,
            operation.backup_manifest_sha256,
          );
          if (!inspection.held) blockingReasons.push("isolated_restore_not_held");
        } catch (error) {
          blockingReasons.push(
            `isolated_restore_invalid:${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const authorityConsistent =
      marker.authority === "local"
        ? Boolean(
            operation &&
            operation.status === "activated" &&
            Boolean(marker.cutover_id) &&
            marker.cutover_id === operation.id,
          )
        : !marker.error;

    const nextActions: string[] = [];
    if (marker.authority === "legacy") {
      nextActions.push(
        operation?.status === "staging"
          ? "resume stage (verify writers are quiesced)"
          : "stage the validated cutover",
      );
    } else if (marker.authority === "migrating") {
      nextActions.push("quiesce any live writers and re-run stage");
      if (operation && ["staging", "staged", "activating"].includes(operation.status)) {
        nextActions.push("activate when blockingReasons is empty");
      }
      nextActions.push("abort before activation to return to legacy control");
    } else if (marker.authority === "local") {
      nextActions.push("local execution authority is active");
    }

    return {
      authority: marker.authority,
      markerPhase: marker.phase,
      markerError: marker.error ?? null,
      cutoverId: marker.cutover_id ?? operation?.id ?? null,
      schemaVersion: live.schemaVersion,
      operation: operation ? mapOperation(operation) : null,
      tables: live.tables,
      artifacts: live.artifacts,
      legacyState: live.legacyState,
      held: live.held,
      mappingSummary: summarizeMappings(mappings),
      backup: backupStatus,
      isolatedRestore: restoreEvidence,
      installationHeld,
      authorityConsistent,
      blockingReasons,
      nextActions,
    };
  }

  private stagedLegacyState(operation: OperationRow): { digest: string } | null {
    const report = parseReport(operation.report);
    const legacyState = report.legacyState;
    if (!legacyState || typeof legacyState !== "object") return null;
    const digest = (legacyState as Record<string, unknown>).digest;
    return typeof digest === "string" ? { digest } : null;
  }

  async stage(input: CutoverStageSubmission = {}): Promise<CutoverStageResult> {
    return withCutoverLock(this.stateDir, () => this.stageLocked(input));
  }

  private async stageLocked(input: CutoverStageSubmission = {}): Promise<CutoverStageResult> {
    const actor = input.actor ?? "operator";
    const marker = readExecutionAuthority(this.stateDir);
    if (marker.error) {
      throw new AuthorityCutoverError(
        "cutover_inconsistent",
        `Execution authority marker is unreadable: ${marker.error}`,
      );
    }
    if (marker.authority === "local") {
      throw new AuthorityCutoverError(
        "cutover_already_active",
        "Local execution authority is already activated",
      );
    }

    let operation = this.openOperation();
    if (marker.authority === "migrating" && !operation) {
      throw new AuthorityCutoverError(
        "cutover_inconsistent",
        "Installation is fenced as migrating but no cutover operation exists",
      );
    }
    if (!operation) {
      operation = this.createOperation(actor);
    } else if (marker.authority === "legacy") {
      operation = this.updateOperation(operation.id, { status: "staging", actor });
    }
    if (
      marker.authority === "migrating" &&
      marker.cutover_id &&
      marker.cutover_id !== operation.id
    ) {
      throw new AuthorityCutoverError(
        "cutover_inconsistent",
        `Marker belongs to cutover ${marker.cutover_id}, not ${operation.id}`,
      );
    }

    try {
      if (marker.authority !== "migrating") {
        writeExecutionAuthority("migrating", {
          stateDir: this.stateDir,
          expected: marker.authority as ExecutionAuthority,
          cutoverId: operation.id,
          phase: "staging",
        });
      }
      operation = this.updateOperation(operation.id, {
        status: "staging",
        actor,
        error: null,
      });

      const pre = this.inventoryLive();
      if (pre.held.length > 0) {
        throw new AuthorityCutoverError(
          "cutover_writers_active",
          "Live writers still own execution records; quiesce them before staging",
          { held: pre.held },
        );
      }

      const backupPath =
        input.backupDestination ??
        resolve(join(this.home, "backups", "authority-cutover", operation.id));
      const existingSnapshot = this.db
        .prepare(
          `SELECT id, manifest_hash, database_sha256, artifact_count, schema_version
             FROM backup_snapshots WHERE destination_path = ? AND status = 'complete'`,
        )
        .get(backupPath) as
        | {
            id: string;
            manifest_hash: string;
            database_sha256: string;
            artifact_count: number;
            schema_version: number;
          }
        | undefined;

      let snapshotId: string;
      let manifestHash: string;
      let databaseSha256: string;
      if (existingSnapshot) {
        const verification = this.backup.verifySnapshotAt(backupPath);
        if (!verification.restorable || !verification.manifestHash) {
          throw new AuthorityCutoverError(
            "cutover_backup_invalid",
            `Existing staged backup is invalid: ${verification.reasons.join(", ")}`,
            { reasons: verification.reasons },
          );
        }
        if (verification.manifestHash !== existingSnapshot.manifest_hash) {
          throw new AuthorityCutoverError(
            "cutover_backup_invalid",
            "Existing backup row and bundle manifest disagree",
          );
        }
        snapshotId = existingSnapshot.id;
        manifestHash = verification.manifestHash;
        databaseSha256 = verification.databaseSha256 ?? existingSnapshot.database_sha256;
      } else {
        const created = this.backup.createBackup(backupPath, actor);
        snapshotId = created.snapshot.id;
        manifestHash = created.manifestHash;
        databaseSha256 = created.databaseSha256;
      }

      const restoreTarget = resolve(
        input.restoreTargetStateDir ??
          join(this.home, "restores", "authority-cutover", operation.id, "state"),
      );
      if (restoreTarget === this.stateDir) {
        throw new AuthorityCutoverError(
          "cutover_restore_invalid",
          "Isolated restore target must not be the live state directory",
        );
      }

      let restoreOperationId: string;
      if (existsSync(join(restoreTarget, "console.db"))) {
        const inspection = this.inspectRestoreTarget(restoreTarget, manifestHash);
        if (!inspection.held) {
          throw new AuthorityCutoverError(
            "cutover_restore_invalid",
            "Existing isolated restore is not held",
          );
        }
        restoreOperationId = inspection.operationId;
      } else {
        const restored = this.backup.restoreBackup({
          sourcePath: backupPath,
          targetStateDir: restoreTarget,
          targetHome: dirname(restoreTarget),
          actor,
        });
        if (!restored.installation.held) {
          throw new AuthorityCutoverError(
            "cutover_restore_invalid",
            "Restore did not produce a held installation",
          );
        }
        restoreOperationId = restored.operation.id;
      }

      const snapshotDb = new DatabaseSync(join(backupPath, "console.db"), { readOnly: true });
      let snapshotInventory: CutoverInventory;
      try {
        snapshotInventory = inventoryInstallation(snapshotDb, {
          stateDir: this.stateDir,
          home: this.home,
          artifactRoot: join(backupPath, "artifacts"),
          now: this.now,
        });
      } finally {
        try {
          snapshotDb.close();
        } catch {}
      }

      const live = this.inventoryLive();
      if (live.held.length > 0) {
        throw new AuthorityCutoverError(
          "cutover_writers_active",
          "Live writers changed execution records during staging",
          { held: live.held },
        );
      }
      if (live.stateDigest !== snapshotInventory.stateDigest) {
        throw new AuthorityCutoverError(
          "cutover_state_changed",
          "Installation changed between the backup snapshot and the live inventory; quiesce writers and retry",
          { expected: snapshotInventory.stateDigest, actual: live.stateDigest },
        );
      }
      if (live.artifacts.digest !== snapshotInventory.artifacts.digest) {
        throw new AuthorityCutoverError(
          "cutover_state_changed",
          "Finalized artifacts changed between the backup and the live inventory",
        );
      }
      if (live.legacyState.digest !== snapshotInventory.legacyState.digest) {
        throw new AuthorityCutoverError(
          "cutover_state_changed",
          "Legacy filesystem execution state changed during staging; quiesce legacy writers and retry",
          {
            expected: snapshotInventory.legacyState.digest,
            actual: live.legacyState.digest,
          },
        );
      }

      const restoredInspection = this.inspectRestoreTarget(restoreTarget, manifestHash);
      if (!restoredInspection.held) {
        throw new AuthorityCutoverError(
          "cutover_restore_invalid",
          "Isolated restore is not held after staging",
        );
      }
      if (restoredInspection.inventory.identityDigest !== snapshotInventory.identityDigest) {
        throw new AuthorityCutoverError(
          "cutover_restore_invalid",
          "Isolated restore did not preserve the deterministic identity inventory",
          {
            expected: snapshotInventory.identityDigest,
            actual: restoredInspection.inventory.identityDigest,
          },
        );
      }
      if (restoredInspection.inventory.artifacts.digest !== snapshotInventory.artifacts.digest) {
        throw new AuthorityCutoverError(
          "cutover_restore_invalid",
          "Isolated restore did not preserve finalized artifact digests",
        );
      }

      const mappings = mergeMappings(
        snapshotInventory.mappings,
        restoredInspection.inventory.mappings,
      );
      this.replaceMappings(operation.id, mappings);

      const snapshotEvidence: CutoverSnapshotEvidence = {
        destinationPath: backupPath,
        snapshotId,
        manifestHash,
        databaseSha256,
        schemaVersion: snapshotInventory.schemaVersion,
        artifactCount: snapshotInventory.artifacts.count,
        stateDigest: snapshotInventory.stateDigest,
      };
      const restoreEvidence: CutoverRestoreEvidence = {
        operationId: restoreOperationId,
        targetStateDir: restoreTarget,
        held: restoredInspection.held,
        sourceRestoreId: restoredInspection.sourceRestoreId,
        schemaVersion: restoredInspection.schemaVersion,
        stateDigest: restoredInspection.inventory.stateDigest,
        identityDigest: restoredInspection.inventory.identityDigest,
        artifactCount: restoredInspection.inventory.artifacts.count,
      };

      const markerAtStage = readExecutionAuthority(this.stateDir);
      const report = {
        stagedAt: this.now(),
        stagedBy: actor,
        authorityMarker: {
          path: resolveExecutionAuthorityPath(this.stateDir),
          authority: markerAtStage.authority,
          cutoverId: markerAtStage.cutover_id,
          phase: markerAtStage.phase,
        },
        inventoryScope: {
          tables: snapshotInventory.tables.length,
          artifacts: snapshotInventory.artifacts.count,
          legacyReadersWriters: [
            "apps/backend/src/monitor/service.ts",
            "apps/backend/src/dispatch/service.ts",
            "apps/backend/src/main.ts",
            "apps/engine-host/src/native.ts",
            "scripts/scheduler.ts",
            "scripts/loop.ts",
            "scripts/cli/commands/loop.ts",
            "apps/backend/src/webhooks/github.ts",
            "apps/backend/src/coordination/service.ts",
          ],
        },
        inventory: {
          generatedAt: snapshotInventory.generatedAt,
          schemaVersion: snapshotInventory.schemaVersion,
          stateDigest: snapshotInventory.stateDigest,
          identityDigest: snapshotInventory.identityDigest,
          totalRows: snapshotInventory.totalRows,
          tables: snapshotInventory.tables,
          artifacts: snapshotInventory.artifacts,
          legacyState: snapshotInventory.legacyState,
          held: snapshotInventory.held,
        },
        snapshot: snapshotEvidence,
        restore: restoreEvidence,
        legacyState: snapshotInventory.legacyState,
        mappingSummary: summarizeMappings(mappings),
        consumerCapability: {
          requiredSchemaVersion: snapshotInventory.schemaVersion,
          actualSchemaVersion: live.schemaVersion,
          supported: live.schemaVersion === snapshotInventory.schemaVersion,
        },
        limitations: [
          "Live builder processes are not resumed; the isolated restore records interrupted ownership.",
          "The isolated restore stays held; cutover never releases it automatically.",
          "Original user data is preserved; cutover does not delete legacy rows or artifacts.",
        ],
      };

      const staged = this.updateOperation(
        operation.id,
        {
          status: "staged",
          inventory_sha256: snapshotInventory.stateDigest,
          backup_snapshot_id: snapshotId,
          backup_path: backupPath,
          backup_manifest_sha256: manifestHash,
          restore_operation_id: restoreOperationId,
          restore_target_state_dir: restoreTarget,
          held_count: snapshotInventory.held.length,
          total_rows: snapshotInventory.totalRows,
          report: JSON.stringify(report),
          error: null,
        },
        ["staging"],
      );

      // Reflect the explicit fenced-staged phase in the durable marker while
      // keeping the authority at `migrating` until activation.
      try {
        writeExecutionAuthority("migrating", {
          stateDir: this.stateDir,
          expected: "migrating",
          cutoverId: operation.id,
          inventorySha256: snapshotInventory.stateDigest,
          backupManifestSha256: manifestHash,
          phase: "staged",
        });
      } catch (error) {
        throw new AuthorityCutoverError(
          "cutover_inconsistent",
          error instanceof Error
            ? error.message
            : "Execution authority changed while recording the staged phase",
        );
      }

      return {
        operation: mapOperation(staged),
        status: this.status(),
        inventory: snapshotInventory,
        snapshot: snapshotEvidence,
        restore: restoreEvidence,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Keep the operation resumable under the explicit migrating fence; never
      // silently return to legacy while a backup/restore artifact may exist.
      try {
        this.updateOperation(operation.id, {
          status: "staging",
          error: message,
          report: JSON.stringify({
            ...parseReport(operation.report),
            lastStageError: message,
            failedAt: this.now(),
          }),
        });
      } catch {}
      if (error instanceof AuthorityCutoverError) throw error;
      throw new AuthorityCutoverError("cutover_failed", message, {
        cause: error instanceof Error ? error.name : String(error),
      });
    }
  }

  async activate(input: CutoverActivateSubmission): Promise<CutoverActivateResult> {
    return withCutoverLock(this.stateDir, () => this.activateLocked(input));
  }

  private async activateLocked(input: CutoverActivateSubmission): Promise<CutoverActivateResult> {
    let operation = this.getOperation(input.cutoverId);
    if (!operation) {
      throw new AuthorityCutoverError(
        "cutover_not_staged",
        `Unknown cutover operation ${input.cutoverId}`,
      );
    }
    if (
      !operation.inventory_sha256 ||
      input.inventorySha256 !== operation.inventory_sha256 ||
      !operation.backup_manifest_sha256 ||
      input.backupManifestSha256 !== operation.backup_manifest_sha256
    ) {
      throw new AuthorityCutoverError(
        "cutover_expected_mismatch",
        "Activation evidence does not match the staged cutover",
      );
    }

    const marker = readExecutionAuthority(this.stateDir);

    // A `local` marker is only reconciled when the exact staged evidence can be
    // re-proven. This covers a marker written before the database commit (old
    // crash window or tamper) without ever trusting the marker alone.
    if (marker.authority === "local") {
      if (marker.cutover_id && marker.cutover_id !== operation.id) {
        throw new AuthorityCutoverError(
          "cutover_inconsistent",
          "A different cutover already activated local authority",
        );
      }
      if (operation.status === "activated") {
        return { operation: mapOperation(operation), status: this.status() };
      }
      this.requireBackupRestorable(operation);
      this.requireRestoreHeld(operation);
      this.assertLiveMatchesStaged(operation);
      operation = this.markActivated(operation, input.actor);
      return { operation: mapOperation(operation), status: this.status() };
    }
    if (marker.authority !== "migrating") {
      throw new AuthorityCutoverError(
        "cutover_not_staged",
        "No staged cutover is fenced for activation",
      );
    }
    if (marker.cutover_id && marker.cutover_id !== operation.id) {
      throw new AuthorityCutoverError(
        "cutover_inconsistent",
        "Execution authority marker belongs to a different cutover",
      );
    }

    this.requireBackupRestorable(operation);
    this.requireRestoreHeld(operation);

    // A crash after the database committed `activated` but before the marker
    // write leaves `migrating` (writers stay fenced). Re-verify and finalize the
    // marker; never authorize from the incomplete row alone.
    if (operation.status === "activated") {
      this.assertLiveMatchesStaged(operation);
      this.writeLocalMarker(operation);
      return { operation: mapOperation(operation), status: this.status() };
    }
    if (operation.status !== "staged" && operation.status !== "activating") {
      throw new AuthorityCutoverError(
        "cutover_not_staged",
        `Cutover ${operation.id} is ${operation.status}, not staged`,
      );
    }

    // Take a real database-wide exclusive lock so an in-flight writer cannot
    // commit between the final inventory and the status transition. This is a
    // SQLite connection/process boundary, not an in-memory boolean.
    const lock = this.databasePath === ":memory:" ? null : new DatabaseSync(this.databasePath);
    if (lock) lock.exec("PRAGMA busy_timeout = 5000;");
    if (lock) lock.exec("BEGIN EXCLUSIVE;");
    try {
      this.assertLiveMatchesStaged(operation, lock ?? undefined);
      if (operation.status !== "activating") {
        if (lock) {
          const result = lock
            .prepare(
              "UPDATE authority_cutover_operations SET status = 'activating', actor = ?, updated_at = ? WHERE id = ? AND status = 'staged'",
            )
            .run(input.actor, this.now(), operation.id);
          if (Number(result.changes ?? 0) === 0) {
            throw new AuthorityCutoverError(
              "cutover_inconsistent",
              "Cutover operation changed while activating; re-read status and retry",
            );
          }
        } else {
          operation = this.updateOperation(
            operation.id,
            { status: "activating", actor: input.actor },
            ["staged"],
          );
        }
      }
      if (lock) lock.exec("COMMIT;");
    } catch (error) {
      if (lock) {
        try {
          lock.exec("ROLLBACK;");
        } catch {}
      }
      throw error;
    } finally {
      if (lock) {
        try {
          lock.close();
        } catch {}
      }
    }

    // Persist `activated` *before* the marker. A crash in between leaves the
    // migrating fence so neither legacy nor local writers can start; the next
    // activate/status reconciles the verified row into the local marker.
    const current = this.getOperation(operation.id) ?? operation;
    operation = this.markActivated(current, input.actor);
    this.writeLocalMarker(operation);
    return { operation: mapOperation(operation), status: this.status() };
  }

  /** Re-proves the live installation still matches the staged evidence. */
  private assertLiveMatchesStaged(
    operation: OperationRow,
    connection?: DatabaseSync,
  ): CutoverInventory {
    const live = connection
      ? inventoryInstallation(connection, {
          stateDir: this.stateDir,
          home: this.home,
          now: this.now,
        })
      : this.inventoryLive();
    if (live.held.length > 0) {
      throw new AuthorityCutoverError(
        "cutover_writers_active",
        "Live writers appeared after staging; activation is refused",
        { held: live.held },
      );
    }
    if (live.stateDigest !== operation.inventory_sha256) {
      throw new AuthorityCutoverError(
        "cutover_state_changed",
        "Installation changed since staging; re-run stage before activating",
        { expected: operation.inventory_sha256, actual: live.stateDigest },
      );
    }
    const stagedLegacyState = this.stagedLegacyState(operation);
    if (stagedLegacyState && live.legacyState.digest !== stagedLegacyState.digest) {
      throw new AuthorityCutoverError(
        "cutover_state_changed",
        "Legacy filesystem execution state changed since staging; quiesce writers and re-run stage",
        { expected: stagedLegacyState.digest, actual: live.legacyState.digest },
      );
    }
    return live;
  }

  private writeLocalMarker(operation: OperationRow): void {
    try {
      writeExecutionAuthority("local", {
        stateDir: this.stateDir,
        expected: "migrating",
        cutoverId: operation.id,
        inventorySha256: operation.inventory_sha256,
        backupManifestSha256: operation.backup_manifest_sha256,
        phase: "active",
      });
    } catch (error) {
      if (error instanceof ExecutionAuthorityConflictError) {
        const current = readExecutionAuthority(this.stateDir);
        if (current.authority === "local" && current.cutover_id === operation.id) return;
        throw new AuthorityCutoverError("cutover_inconsistent", error.message);
      }
      throw new AuthorityCutoverError(
        "cutover_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private markActivated(operation: OperationRow, actor: string): OperationRow {
    if (operation.status === "activated") return operation;
    const now = this.now();
    return this.updateOperation(operation.id, {
      status: "activated",
      inventory_sha256: operation.inventory_sha256,
      backup_snapshot_id: operation.backup_snapshot_id,
      backup_path: operation.backup_path,
      backup_manifest_sha256: operation.backup_manifest_sha256,
      restore_operation_id: operation.restore_operation_id,
      restore_target_state_dir: operation.restore_target_state_dir,
      held_count: operation.held_count,
      total_rows: operation.total_rows,
      report: JSON.stringify({
        ...parseReport(operation.report),
        activatedAt: now,
        activatedBy: actor,
      }),
      activated_at: now,
      error: null,
    });
  }

  async abort(input: CutoverAbortSubmission): Promise<CutoverAbortResult> {
    return withCutoverLock(this.stateDir, () => this.abortLocked(input));
  }

  private async abortLocked(input: CutoverAbortSubmission): Promise<CutoverAbortResult> {
    const operation = this.getOperation(input.cutoverId);
    if (!operation) {
      throw new AuthorityCutoverError(
        "cutover_not_staged",
        `Unknown cutover operation ${input.cutoverId}`,
      );
    }
    const marker = readExecutionAuthority(this.stateDir);
    if (marker.authority === "local") {
      throw new AuthorityCutoverError(
        "cutover_already_active",
        "Local authority is active; rollback requires a validated restored snapshot, not an abort",
      );
    }
    if (!["staging", "staged", "activating", "aborted"].includes(operation.status)) {
      throw new AuthorityCutoverError(
        "cutover_not_abortable",
        `Cutover ${operation.id} is ${operation.status} and cannot be aborted`,
      );
    }
    if (marker.authority === "migrating") {
      if (marker.cutover_id && marker.cutover_id !== operation.id) {
        throw new AuthorityCutoverError(
          "cutover_inconsistent",
          "Execution authority marker belongs to a different cutover",
        );
      }
      writeExecutionAuthority("legacy", {
        stateDir: this.stateDir,
        expected: "migrating",
        cutoverId: operation.id,
        phase: null,
      });
    }
    const aborted = this.updateOperation(operation.id, {
      status: "aborted",
      report: JSON.stringify({
        ...parseReport(operation.report),
        abortedAt: this.now(),
        abortedBy: input.actor,
        abortReason: input.reason,
      }),
      error: null,
    });
    return { operation: mapOperation(aborted), status: this.status() };
  }
}

function randomId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}
