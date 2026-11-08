import { z } from "zod";

/**
 * Shared contracts for the #165 authority cutover. They describe the durable
 * inventory, the staged migration evidence and the operator status surface. No
 * path or process helper lives here so the web app and client can import them.
 */

export const cutoverOperationStatusSchema = z.enum([
  "staging",
  "staged",
  "activating",
  "activated",
  "aborted",
  "failed",
]);
export type CutoverOperationStatus = z.infer<typeof cutoverOperationStatusSchema>;

export const cutoverTableGroupSchema = z.enum([
  "projects",
  "commands",
  "runs",
  "evidence",
  "coordination",
  "integration",
  "plans",
  "delivery",
  "publication",
  "drafts",
  "backup",
  "schema",
  "other",
]);
export type CutoverTableGroup = z.infer<typeof cutoverTableGroupSchema>;

export const cutoverTableSummarySchema = z.object({
  table: z.string().min(1),
  group: cutoverTableGroupSchema,
  count: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Digest over stable identities only, so restore-mutated rows still compare. */
  identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CutoverTableSummary = z.infer<typeof cutoverTableSummarySchema>;

export const cutoverArtifactSummarySchema = z.object({
  root: z.string().min(1),
  count: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CutoverArtifactSummary = z.infer<typeof cutoverArtifactSummarySchema>;

export const cutoverHeldFactSchema = z.object({
  entity: z.string().min(1),
  identity: z.string().min(1),
  reason: z.string().min(1),
});
export type CutoverHeldFact = z.infer<typeof cutoverHeldFactSchema>;

export const cutoverDispositionSchema = z.enum([
  "preserved",
  "preserved_history",
  "adopted",
  "held",
]);
export type CutoverDisposition = z.infer<typeof cutoverDispositionSchema>;

export const cutoverMappingSchema = z.object({
  entity: z.string().min(1),
  legacyId: z.string().min(1),
  newId: z.string().min(1),
  legacyHash: z.string().regex(/^[a-f0-9]{64}$/),
  newHash: z.string().regex(/^[a-f0-9]{64}$/),
  disposition: cutoverDispositionSchema,
  reason: z.string().nullable(),
});
export type CutoverMapping = z.infer<typeof cutoverMappingSchema>;

export const cutoverMappingSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  preserved: z.number().int().nonnegative(),
  preservedHistory: z.number().int().nonnegative(),
  adopted: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
});
export type CutoverMappingSummary = z.infer<typeof cutoverMappingSummarySchema>;

export const cutoverSnapshotEvidenceSchema = z.object({
  destinationPath: z.string().min(1),
  snapshotId: z.string().min(1),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  schemaVersion: z.number().int().positive(),
  artifactCount: z.number().int().nonnegative(),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CutoverSnapshotEvidence = z.infer<typeof cutoverSnapshotEvidenceSchema>;

export const cutoverRestoreEvidenceSchema = z.object({
  operationId: z.string().min(1),
  targetStateDir: z.string().min(1),
  held: z.boolean(),
  sourceRestoreId: z.string().nullable(),
  schemaVersion: z.number().int().positive(),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  artifactCount: z.number().int().nonnegative(),
});
export type CutoverRestoreEvidence = z.infer<typeof cutoverRestoreEvidenceSchema>;

export const cutoverInventoryEvidenceSchema = z.object({
  generatedAt: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  totalRows: z.number().int().nonnegative(),
  tables: z.array(cutoverTableSummarySchema),
  artifacts: cutoverArtifactSummarySchema,
  held: z.array(cutoverHeldFactSchema),
  mappings: z.array(cutoverMappingSchema),
});
export type CutoverInventoryEvidence = z.infer<typeof cutoverInventoryEvidenceSchema>;

export const cutoverOperationSchema = z.object({
  id: z.string().min(1),
  status: cutoverOperationStatusSchema,
  actor: z.string().min(1),
  inventorySha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  backupSnapshotId: z.string().nullable(),
  backupPath: z.string().nullable(),
  backupManifestSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  restoreOperationId: z.string().nullable(),
  restoreTargetStateDir: z.string().nullable(),
  heldCount: z.number().int().nonnegative(),
  totalRows: z.number().int().nonnegative(),
  report: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  activatedAt: z.number().int().nonnegative().nullable(),
});
export type CutoverOperation = z.infer<typeof cutoverOperationSchema>;

export const cutoverBackupStatusSchema = z.object({
  restorable: z.boolean(),
  reasons: z.array(z.string()),
  manifestHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  databaseSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  artifactCount: z.number().int().nonnegative(),
});
export type CutoverBackupStatus = z.infer<typeof cutoverBackupStatusSchema>;

export const cutoverStatusSchema = z.object({
  authority: z.enum(["legacy", "migrating", "local"]),
  markerPhase: z.enum(["staging", "staged", "activating", "active"]).nullable(),
  markerError: z.string().nullable(),
  cutoverId: z.string().nullable(),
  schemaVersion: z.number().int().nonnegative(),
  operation: cutoverOperationSchema.nullable(),
  tables: z.array(cutoverTableSummarySchema),
  artifacts: cutoverArtifactSummarySchema,
  held: z.array(cutoverHeldFactSchema),
  mappingSummary: cutoverMappingSummarySchema,
  backup: cutoverBackupStatusSchema.nullable(),
  isolatedRestore: cutoverRestoreEvidenceSchema.nullable(),
  installationHeld: z.boolean(),
  blockingReasons: z.array(z.string()),
  nextActions: z.array(z.string().min(1)),
});
export type CutoverStatus = z.infer<typeof cutoverStatusSchema>;

export const cutoverStageSubmissionSchema = z.object({
  actor: z.string().min(1).max(200).optional(),
  /** Optional explicit backup destination; must be outside the live state dir. */
  backupDestination: z.string().min(1).max(4096).optional(),
  /** Optional explicit isolated restore state dir; must not be the live state dir. */
  restoreTargetStateDir: z.string().min(1).max(4096).optional(),
});
export type CutoverStageSubmission = z.infer<typeof cutoverStageSubmissionSchema>;

export const cutoverStageResultSchema = z.object({
  operation: cutoverOperationSchema,
  status: cutoverStatusSchema,
  inventory: cutoverInventoryEvidenceSchema,
  snapshot: cutoverSnapshotEvidenceSchema,
  restore: cutoverRestoreEvidenceSchema,
});
export type CutoverStageResult = z.infer<typeof cutoverStageResultSchema>;

export const cutoverActivateSubmissionSchema = z.object({
  actor: z.string().min(1).max(200),
  cutoverId: z.string().min(1),
  inventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
  backupManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CutoverActivateSubmission = z.infer<typeof cutoverActivateSubmissionSchema>;

export const cutoverActivateResultSchema = z.object({
  operation: cutoverOperationSchema,
  status: cutoverStatusSchema,
});
export type CutoverActivateResult = z.infer<typeof cutoverActivateResultSchema>;

export const cutoverAbortSubmissionSchema = z.object({
  actor: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
  cutoverId: z.string().min(1),
});
export type CutoverAbortSubmission = z.infer<typeof cutoverAbortSubmissionSchema>;

export const cutoverAbortResultSchema = z.object({
  operation: cutoverOperationSchema,
  status: cutoverStatusSchema,
});
export type CutoverAbortResult = z.infer<typeof cutoverAbortResultSchema>;

export const cutoverMappingsResultSchema = z.object({
  cutoverId: z.string().min(1),
  mappings: z.array(cutoverMappingSchema),
});
export type CutoverMappingsResult = z.infer<typeof cutoverMappingsResultSchema>;
