import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export type MigrationFailureCode =
  | "migration_duplicate_version"
  | "migration_duplicate_name"
  | "migration_out_of_order"
  | "migration_version_conflict"
  | "migration_name_conflict";

export class MigrationError extends Error {
  constructor(
    public readonly code: MigrationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

interface AppliedMigration {
  version: number;
  name: string;
}

function assertRegistryConsistency(migrations: readonly Migration[]): void {
  const byVersion = new Map<number, Migration>();
  const byName = new Map<string, Migration>();
  let previous = 0;

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new MigrationError(
        "migration_out_of_order",
        `Migration '${migration.name}' declares invalid version ${migration.version}`,
      );
    }

    const versionOwner = byVersion.get(migration.version);
    if (versionOwner) {
      throw new MigrationError(
        "migration_duplicate_version",
        `Two migrations claim version ${migration.version}: '${versionOwner.name}' and '${migration.name}'`,
      );
    }
    byVersion.set(migration.version, migration);

    const nameOwner = byName.get(migration.name);
    if (nameOwner) {
      throw new MigrationError(
        "migration_duplicate_name",
        `Migration name '${migration.name}' is claimed by versions ${nameOwner.version} and ${migration.version}`,
      );
    }
    byName.set(migration.name, migration);

    if (migration.version <= previous) {
      throw new MigrationError(
        "migration_out_of_order",
        `Migration registry is not strictly ascending: ${migration.version} ('${migration.name}') follows ${previous}`,
      );
    }
    previous = migration.version;
  }
}

function assertAppliedConsistency(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): void {
  const expectedByVersion = new Map<number, Migration>();
  const expectedByName = new Map<string, Migration>();
  for (const migration of migrations) {
    expectedByVersion.set(migration.version, migration);
    expectedByName.set(migration.name, migration);
  }

  for (const row of applied) {
    const expected = expectedByVersion.get(row.version);
    if (expected && expected.name !== row.name) {
      throw new MigrationError(
        "migration_version_conflict",
        `Applied migration version ${row.version} is recorded as '${row.name}' but this build expects '${expected.name}'. Refusing to rename an applied migration or skip schema creation; reconcile the database explicitly.`,
      );
    }
    if (!expected) {
      throw new MigrationError(
        "migration_version_conflict",
        `Applied migration version ${row.version} ('${row.name}') is not present in this build's migration registry. Refusing to continue with an unknown schema lineage.`,
      );
    }
    const nameOwner = expectedByName.get(row.name);
    if (nameOwner && nameOwner.version !== row.version) {
      throw new MigrationError(
        "migration_name_conflict",
        `Applied migration '${row.name}' is recorded at version ${row.version} but the registry assigns it version ${nameOwner.version}. Refusing to rename an applied migration.`,
      );
    }
  }
}

/**
 * Applies every migration across the whole schema in one ordered registry.
 *
 * Migration versions are owned by the registry, not by individual modules, so
 * two features can never silently claim the same version. A recorded version or
 * name that disagrees with this build fails closed instead of skipping a
 * migration (which would leave missing tables) or renaming an applied row.
 */
export function applyMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  assertRegistryConsistency(migrations);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = db
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as unknown as AppliedMigration[];
  assertAppliedConsistency(applied, migrations);

  const appliedVersions = new Set(applied.map((row) => row.version));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      const present = db
        .prepare("SELECT name FROM schema_migrations WHERE version = ?")
        .get(migration.version) as { name: string } | undefined;
      if (present) {
        if (present.name !== migration.name) {
          throw new MigrationError(
            "migration_version_conflict",
            `Migration version ${migration.version} was recorded as '${present.name}' while applying '${migration.name}'`,
          );
        }
      } else {
        migration.up(db);
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, Date.now());
      }
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }
}
