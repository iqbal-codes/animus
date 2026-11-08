import { existsSync } from "node:fs";
import { join } from "node:path";
import { readExecutionAuthority } from "@animus/contracts/execution-authority";
import { readInstallationHold } from "@animus/contracts/installation-hold";
import { resolveAnimusStateDir } from "@animus/contracts/paths";
import { inventoryInstallation } from "../../../apps/backend/src/cutover/inventory";
import {
  openReadOnlyDatabase,
  type DatabasePragmaSnapshot,
} from "../../../apps/backend/src/registry/db";
import {
  createRegistrationClient,
  type FactoryConnectionOptions,
} from "./onboarding-registration";

interface LocalAuthoritySnapshot {
  authority: "legacy" | "migrating" | "local";
  phase: string | null;
  cutoverId: string | null;
  inventorySha256: string | null;
  backupManifestSha256: string | null;
  markerError: string | null;
  schemaVersion: number;
  installationHeld: boolean;
  heldCount: number;
  held: Array<{ entity: string; identity: string; reason: string }>;
  tableCount: number;
  totalRows: number;
  artifactCount: number;
  legacyState: { digest: string; runs: number; locks: number; worktrees: number; files: number } | null;
  pragmas: DatabasePragmaSnapshot | null;
  databasePath: string;
}

function readLocalSnapshot(stateDirOption?: string): LocalAuthoritySnapshot {
  const stateDir = resolveAnimusStateDir(stateDirOption);
  const marker = readExecutionAuthority(stateDir);
  const databasePath = join(stateDir, "console.db");
  let schemaVersion = 0;
  let held: LocalAuthoritySnapshot["held"] = [];
  let tableCount = 0;
  let totalRows = 0;
  let artifactCount = 0;
  let installationHeld = false;
  let legacyState: LocalAuthoritySnapshot["legacyState"] = null;
  let pragmas: DatabasePragmaSnapshot | null = null;

  if (existsSync(databasePath)) {
    // Read-only and truthful: the connection-scoped PRAGMAs are configured here
    // explicitly. WAL is a persistent database property that is observed, not
    // written. This is not an `initializeDatabase` call.
    const opened = openReadOnlyDatabase(databasePath);
    const db = opened.db;
    pragmas = opened.pragmas;
    try {
      const hasMigrations = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get() as { name: string } | undefined;
      if (hasMigrations) {
        const inventory = inventoryInstallation(db, { stateDir });
        schemaVersion = inventory.schemaVersion;
        held = inventory.held;
        tableCount = inventory.tables.length;
        totalRows = inventory.totalRows;
        artifactCount = inventory.artifacts.count;
        installationHeld = readInstallationHold(db).held;
        legacyState = {
          digest: inventory.legacyState.digest,
          runs: inventory.legacyState.runs,
          locks: inventory.legacyState.locks,
          worktrees: inventory.legacyState.worktrees,
          files: inventory.legacyState.files,
        };
      }
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  return {
    authority: marker.authority,
    phase: marker.phase,
    cutoverId: marker.cutover_id,
    inventorySha256: marker.inventory_sha256,
    backupManifestSha256: marker.backup_manifest_sha256,
    markerError: marker.error ?? null,
    schemaVersion,
    installationHeld,
    heldCount: held.length,
    held,
    tableCount,
    totalRows,
    artifactCount,
    legacyState,
    pragmas,
    databasePath,
  };
}

export interface AuthorityCommandOptions extends FactoryConnectionOptions {
  subcommand?: string;
  positionals: string[];
  repoRoot: string;
  stateDir?: string;
  cutoverId?: string;
  inventorySha256?: string;
  backupManifestSha256?: string;
  actor?: string;
  reason?: string;
  destination?: string;
  targetStateDir?: string;
  json?: boolean;
}

export async function runAuthorityCommand(opts: AuthorityCommandOptions): Promise<number> {
  const sub = opts.subcommand ?? "status";
  try {
    if (sub === "status") {
      const snapshot = readLocalSnapshot(opts.stateDir);
      if (opts.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return 0;
      }
      console.log(`Execution authority: ${snapshot.authority}`);
      console.log(`  Marker phase:      ${snapshot.phase ?? "none"}`);
      console.log(`  Cutover:           ${snapshot.cutoverId ?? "none"}`);
      console.log(`  Schema version:    ${snapshot.schemaVersion}`);
      console.log(`  Installation held: ${snapshot.installationHeld ? "yes" : "no"}`);
      console.log(`  Live writers held: ${snapshot.heldCount}`);
      console.log(`  Tables / rows:     ${snapshot.tableCount} / ${snapshot.totalRows}`);
      console.log(`  Artifacts:         ${snapshot.artifactCount}`);
      if (snapshot.pragmas) {
        console.log(
          `  SQLite pragmas:    journal=${snapshot.pragmas.journalMode} synchronous=${snapshot.pragmas.synchronous} foreign_keys=${snapshot.pragmas.foreignKeys} busy_timeout=${snapshot.pragmas.busyTimeout}`,
        );
      }
      if (snapshot.markerError) console.log(`  Marker error:      ${snapshot.markerError}`);
      if (snapshot.heldCount > 0) {
        for (const fact of snapshot.held) {
          console.log(`  - ${fact.entity} ${fact.identity}: ${fact.reason}`);
        }
      }
      return 0;
    }

    const client = createRegistrationClient(opts);

    if (sub === "stage") {
      const result = await client.stageAuthorityCutover({
        ...(opts.actor ? { actor: opts.actor } : {}),
        ...(opts.destination ? { backupDestination: opts.destination } : {}),
        ...(opts.targetStateDir ? { restoreTargetStateDir: opts.targetStateDir } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Cutover ${result.operation.id} staged (${result.operation.status}).`);
        console.log(`  Backup:        ${result.snapshot.destinationPath}`);
        console.log(`  Manifest:      ${result.snapshot.manifestHash}`);
        console.log(`  Isolated held restore: ${result.restore.targetStateDir}`);
        console.log(`  Inventory:     ${result.inventory.totalRows} rows, ${result.inventory.held.length} held`);
        console.log("  Activation is refused while any held writer remains.");
      }
      return 0;
    }

    if (sub === "activate") {
      const current = await client.authorityStatus();
      const cutoverId = opts.cutoverId ?? current.operation?.id;
      const inventorySha256 = opts.inventorySha256 ?? current.operation?.inventorySha256;
      const backupManifestSha256 =
        opts.backupManifestSha256 ?? current.operation?.backupManifestSha256;
      if (!cutoverId || !inventorySha256 || !backupManifestSha256) {
        throw new Error(
          "Usage: animus authority activate [--cutover-id <id>] [--inventory-sha256 <sha>] [--backup-manifest-sha256 <sha>] [--actor <name>]",
        );
      }
      const result = await client.activateAuthorityCutover({
        actor: opts.actor ?? "operator",
        cutoverId,
        inventorySha256,
        backupManifestSha256,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Execution authority: ${result.status.authority}`);
        console.log(`  Cutover ${result.operation.id} is ${result.operation.status}.`);
        for (const reason of result.status.blockingReasons) console.log(`  Held: ${reason}`);
      }
      return 0;
    }

    if (sub === "abort") {
      const current = await client.authorityStatus();
      const cutoverId = opts.cutoverId ?? current.operation?.id;
      if (!cutoverId) throw new Error("Usage: animus authority abort --cutover-id <id>");
      const result = await client.abortAuthorityCutover({
        actor: opts.actor ?? "operator",
        reason: opts.reason ?? "Operator aborted the staged cutover before activation",
        cutoverId,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Cutover ${result.operation.id} ${result.operation.status}.`);
        console.log(`Execution authority: ${result.status.authority}`);
      }
      return 0;
    }

    if (sub === "mappings") {
      const cutoverId = opts.cutoverId ?? (await client.authorityStatus()).operation?.id;
      if (!cutoverId) throw new Error("Usage: animus authority mappings --cutover-id <id>");
      const result = await client.authorityMappings(cutoverId);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Identity mappings for ${cutoverId}: ${result.mappings.length}`);
        for (const mapping of result.mappings.slice(0, 50)) {
          console.log(
            `  ${mapping.entity} ${mapping.legacyId} -> ${mapping.newId} (${mapping.disposition})`,
          );
        }
        if (result.mappings.length > 50) {
          console.log(`  ... ${result.mappings.length - 50} more`);
        }
      }
      return 0;
    }

    throw new Error(
      `Unknown authority subcommand: ${sub}. Expected status, stage, activate, abort, or mappings.`,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}
