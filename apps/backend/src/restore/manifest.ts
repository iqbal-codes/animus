import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import { normalizeArtifactRelativePath } from "../evidence/artifact-path";

export const BACKUP_MANIFEST_VERSION = 1;
export const BACKUP_MANIFEST_FILE = "manifest.json";
export const BACKUP_MANIFEST_HASH_FILE = "manifest.sha256";
export const BACKUP_DATABASE_FILE = "console.db";
export const BACKUP_ARTIFACT_DIR = "artifacts";

export const backupArtifactEntrySchema = z
  .object({
    projectId: z.string().min(1),
    relativePath: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type BackupArtifactEntry = z.infer<typeof backupArtifactEntrySchema>;

export const backupManifestSchema = z
  .object({
    manifestVersion: z.number().int().positive(),
    kind: z.literal("animus-workspace-backup"),
    createdAt: z.number().int().nonnegative(),
    source: z
      .object({
        home: z.string().min(1),
        stateDir: z.string().min(1),
        worktreesDir: z.string().min(1),
        artifactRoot: z.string().min(1),
      })
      .strict(),
    build: z
      .object({
        schemaVersion: z.number().int().positive(),
      })
      .strict(),
    database: z
      .object({
        relativePath: z.literal(BACKUP_DATABASE_FILE),
        sizeBytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    artifacts: z.array(backupArtifactEntrySchema),
    completeness: z
      .object({
        integrityCheck: z.literal("ok"),
        foreignKeyViolations: z.literal(0),
        tables: z.record(z.string(), z.number().int().nonnegative()),
        artifactRows: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function manifestHash(manifest: BackupManifest): string {
  return sha256Bytes(Buffer.from(canonicalJson(manifest), "utf8"));
}

/** Bundle-relative POSIX path for one finalized artifact. */
export function artifactBundleRelativePath(projectId: string, relativePath: string): string {
  return posix.join(
    BACKUP_ARTIFACT_DIR,
    encodeSegment(projectId),
    normalizeArtifactRelativePath(relativePath),
  );
}

function encodeSegment(segment: string): string {
  if (segment === "" || segment === "." || segment === ".." || segment.includes("/")) {
    throw new Error(`Unsafe artifact project identifier: ${segment}`);
  }
  return segment;
}
