import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import { initializeDatabase } from "../../../apps/backend/src/registry/db";
import { resolveStateDirForDatabase } from "../../../apps/backend/src/authority/guard";

const DEFAULT_DIGEST = "0".repeat(64);

export interface SeedActivatedAuthorityOptions {
  /** Marker directory. Defaults to the directory that owns `db`. */
  stateDir?: string;
  cutoverId?: string;
  inventorySha256?: string;
  backupManifestSha256?: string;
  activatedAt?: string;
  actor?: string;
}

export interface SeededAuthority {
  cutoverId: string;
  stateDir: string;
  inventorySha256: string;
  backupManifestSha256: string;
}

/**
 * TEST-ONLY fixture seam. Seeds the exact post-cutover state that fixtures need:
 * one `activated` `authority_cutover_operations` row plus the matching `local`
 * marker that names it. This is not a production carve-out: production only ever
 * reaches `local` through `stage()` -> `activate()`, and the shared gate rejects
 * a marker that is not backed by the operation row it claims.
 *
 * Tests that exercise cutover semantics must drive the public `stage()` ->
 * `activate()` seam instead of calling this helper. Feature fixtures that only
 * need an already-migrated installation use this to stay coherent.
 */
export function seedActivatedAuthority(
  db: DatabaseSync,
  options: SeedActivatedAuthorityOptions = {},
): SeededAuthority {
  const stateDir = options.stateDir ?? resolveStateDirForDatabase(db);
  const inventorySha256 = options.inventorySha256 ?? DEFAULT_DIGEST;
  const backupManifestSha256 = options.backupManifestSha256 ?? DEFAULT_DIGEST;
  const existing = db
    .prepare("SELECT id FROM authority_cutover_operations WHERE status = 'activated'")
    .get() as { id: string } | undefined;
  const cutoverId =
    existing?.id ?? options.cutoverId ?? `cutover_${randomUUID().replaceAll("-", "")}`;
  if (!existing) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO authority_cutover_operations
         (id, status, actor, inventory_sha256, backup_manifest_sha256, held_count, total_rows, report, created_at, updated_at, activated_at)
       VALUES (?, 'activated', ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    ).run(
      cutoverId,
      options.actor ?? "test-helper",
      inventorySha256,
      backupManifestSha256,
      JSON.stringify({ seededBy: "activated-authority-test-helper" }),
      now,
      now,
      now,
    );
  }
  writeExecutionAuthority("local", {
    stateDir,
    cutoverId,
    inventorySha256,
    backupManifestSha256,
    activatedAt: options.activatedAt,
    phase: "active",
  });
  return { cutoverId, stateDir, inventorySha256, backupManifestSha256 };
}

/**
 * Convenience for fixtures that must seed before the backend app is constructed.
 * Creates the canonical database at `<stateDir>/console.db`, seeds the activated
 * authority, and closes the connection; the app later opens the same file.
 */
export function seedActivatedAuthorityAt(
  stateDir: string,
  options: SeedActivatedAuthorityOptions = {},
): SeededAuthority {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db = initializeDatabase(join(stateDir, "console.db"));
  try {
    return seedActivatedAuthority(db, { ...options, stateDir });
  } finally {
    db.close();
  }
}
