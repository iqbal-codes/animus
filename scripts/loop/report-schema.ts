import { z } from "zod";

// ============================================================================
// Host-Bound Identities
// ============================================================================

export const hostBoundIdentitiesSchema = z.object({
  targetBaseTip: z.string().min(1, "Target-base tip SHA is required"),
  mergeBase: z.string().min(1, "Merge-base SHA is required"),
  prHead: z.string().min(1, "PR head SHA is required"),
  testedHead: z.string().min(1, "Tested integration SHA is required"),
  environment: z
    .union([
      z.string(),
      z.object({
        os: z.string().optional(),
        runtime: z.string().optional(),
        browser: z.string().optional(),
        details: z.string().optional(),
      }),
    ])
    .optional(),
});
export type HostBoundIdentities = z.infer<typeof hostBoundIdentitiesSchema>;

// ============================================================================
// Capture Records (Before / After Evidence)
// ============================================================================

export const captureApplicabilitySchema = z.enum([
  "applicable",
  "na_new_feature",
  "na_nonvisual",
]);
export type CaptureApplicability = z.infer<typeof captureApplicabilitySchema>;

export const captureStatusSchema = z.enum(["captured", "unavailable", "na"]);
export type CaptureStatus = z.infer<typeof captureStatusSchema>;

export const hostedUrlStatusSchema = z.enum([
  "unbound",
  "supplied_unverified",
  "confirmed_access",
  "inaccessible",
]);
export type HostedUrlStatus = z.infer<typeof hostedUrlStatusSchema>;

export const captureRecordSchema = z.object({
  id: z.string().min(1, "Evidence ID is required"),
  scenario: z.string().min(1, "Scenario description is required"),
  route: z.string().min(1, "Route/entrypoint is required"),
  viewport: z.string().optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  browser: z.string().optional(),
  baselineIdentity: z.string().optional(),
  candidateIdentity: z.string().min(1, "Candidate identity is required"),
  applicability: captureApplicabilitySchema.default("applicable"),
  beforeStatus: captureStatusSchema.default("captured"),
  beforeArtifact: z.string().optional(),
  beforeReason: z.string().optional(),
  afterStatus: captureStatusSchema.default("captured"),
  afterArtifact: z.string().optional(),
  afterReason: z.string().optional(),
  beforeHostedUrl: z.url().optional(),
  afterHostedUrl: z.url().optional(),
  hostedUrlStatus: hostedUrlStatusSchema.default("unbound"),
});
export type CaptureRecord = z.infer<typeof captureRecordSchema>;

// ============================================================================
// Black-Box QA Report
// ============================================================================

export const qaVerdictSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT RUN"]);
export type QaVerdict = z.infer<typeof qaVerdictSchema>;

export const qaCriterionLineSchema = z.object({
  id: z.string().min(1, "Criterion/line ID is required"),
  kind: z.enum(["criterion", "probe", "defect", "holdout"]).default("criterion"),
  verdict: z.string().transform((v) => {
    const norm = v.trim().toUpperCase();
    if (norm === "OK") return "PASS";
    return norm;
  }).pipe(qaVerdictSchema),
  text: z.string().default(""),
  expected: z.string().optional(),
  observed: z.string().optional(),
  command: z.string().optional(),
  scenario: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  pre_existing: z.string().optional(),
  defect: z.string().optional(),
  carried_from: z.string().optional(),
});
export type QaCriterionLine = z.infer<typeof qaCriterionLineSchema>;

export const qaReportSchema = z.object({
  role: z.literal("qa").optional(),
  pr: z.string().optional(),
  head: z.string().min(1, "Tested head SHA is required"),
  merged_with: z.string().optional(),
  overall: z.string().transform((v) => {
    const norm = v.trim().toUpperCase();
    if (norm === "OK") return "PASS";
    return norm;
  }).pipe(z.enum(["PASS", "FAIL", "BLOCKED", "NOT RUN", "NO PR"])),
  summary: z.string().default(""),
  lines: z.array(qaCriterionLineSchema),
  noticed: z.array(z.string()).default([]),
  captures: z.array(captureRecordSchema).default([]),
});
export type QaReport = z.infer<typeof qaReportSchema>;

// ============================================================================
// Review Findings & Dispositions
// ============================================================================

export const reviewFindingAxisSchema = z.enum(["standards", "spec"]);
export type ReviewFindingAxis = z.infer<typeof reviewFindingAxisSchema>;

export const reviewFindingClassificationSchema = z.enum(["defect", "gap", "judgment"]);
export type ReviewFindingClassification = z.infer<typeof reviewFindingClassificationSchema>;

export const reviewFindingStatusSchema = z.enum([
  "open",
  "remediated",
  "rechecked_resolved",
  "accepted_risk",
]);
export type ReviewFindingStatus = z.infer<typeof reviewFindingStatusSchema>;

export const reviewFindingSchema = z.object({
  id: z.string().min(1, "Finding ID is required"),
  axis: reviewFindingAxisSchema.default("standards"),
  classification: reviewFindingClassificationSchema.default("defect"),
  blocking: z.boolean().default(true),
  title: z.string().min(1, "Finding title is required"),
  description: z.string().default(""),
  location: z
    .object({
      file: z.string(),
      line: z.number().int().positive().optional(),
    })
    .optional(),
  evidence: z.string().optional(),
  status: reviewFindingStatusSchema.default("open"),
  lapIntroduced: z.number().int().nonnegative().default(0),
  lapResolved: z.number().int().nonnegative().optional(),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewDispositionActionSchema = z.enum([
  "blocks",
  "rechecked",
  "pre-existing",
  "accepted",
  "issue",
]);
export type ReviewDispositionAction = z.infer<typeof reviewDispositionActionSchema>;

export const reviewDispositionSchema = z.object({
  line: z.string().min(1, "Target line/finding reference is required"),
  action: reviewDispositionActionSchema,
  reason: z.string().default(""),
  file: z.string().optional(),
  issue: z.string().optional(),
});
export type ReviewDisposition = z.infer<typeof reviewDispositionSchema>;

export const remediationRecheckRecordSchema = z.object({
  findingId: z.string().min(1, "Finding ID is required"),
  authorRemediation: z
    .object({
      commit: z.string(),
      summary: z.string(),
      changes: z.array(z.string()).default([]),
    })
    .optional(),
  recheck: z.object({
    recheckStatus: z.enum(["resolved", "unresolved", "partially_resolved"]),
    recheckEvidence: z.string().optional(),
    recheckCandidate: z.string(),
    recheckRole: z.enum(["reviewer", "qa"]).default("reviewer"),
    notes: z.string().optional(),
  }),
});
export type RemediationRecheckRecord = z.infer<typeof remediationRecheckRecordSchema>;

export const reviewOutcomeSchema = z.enum([
  "approved",
  "sent-back",
  "needs-owner",
  "merge",
  "nothing",
]);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

export const reviewerReportSchema = z.object({
  sha: z.string().min(1, "Candidate SHA is required"),
  pr: z.string().optional(),
  outcome: reviewOutcomeSchema,
  reason: z.string().optional(),
  delivers: z.enum(["all", "part", "none"]).default("all"),
  axes: z
    .object({
      standards: z.object({
        status: z.enum(["pass", "fail", "incomplete"]),
        summary: z.string().optional(),
      }),
      spec: z.object({
        status: z.enum(["pass", "fail", "incomplete"]),
        summary: z.string().optional(),
      }),
    })
    .optional(),
  findings: z
    .array(z.union([reviewFindingSchema, z.string()]))
    .default([]),
  dispositions: z.array(reviewDispositionSchema).default([]),
  rechecks: z.array(remediationRecheckRecordSchema).default([]),
  judge_changes: z.array(z.string()).default([]),
});
export type ReviewerReport = z.infer<typeof reviewerReportSchema>;

// ============================================================================
// Builder Report
// ============================================================================

export const builderCheckSchema = z.object({
  criterion: z.string().min(1, "Criterion is required"),
  result: z.enum(["pass", "fail", "blocked", "not_run"]),
  evidence: z.string().optional(),
  command: z.string().optional(),
});
export type BuilderCheck = z.infer<typeof builderCheckSchema>;

export const builderReportSchema = z.object({
  candidate: z.string().min(1, "Candidate SHA is required"),
  verdict: z.enum(["pass", "fail", "interrupted"]),
  summary: z.string().default(""),
  outcome: z.string().optional(),
  invariants: z.array(z.string()).optional(),
  reviewGuidance: z.array(z.string()).optional(),
  risk: z.string().optional(),
  changedSeams: z
    .array(
      z.union([
        z.object({
          seam: z.string(),
          impact: z.string(),
        }),
        z.string(),
      ]),
    )
    .optional(),
  changes: z.array(z.string()).optional(),
  checks: z.array(builderCheckSchema).optional(),
  captures: z.array(captureRecordSchema).optional(),
});
export type BuilderReport = z.infer<typeof builderReportSchema>;

// ============================================================================
// Evidence URL Mapping (Operator Upload Binding)
// ============================================================================

export const evidenceUrlMappingEntrySchema = z.object({
  beforeUrl: z.url().optional(),
  afterUrl: z.url().optional(),
  submitter: z.string().optional(),
  recordedAt: z.string().optional(),
});

export const evidenceUrlMappingSchema = z.object({
  candidate: z.string().min(1, "Candidate SHA is required"),
  mappings: z.record(z.string(), evidenceUrlMappingEntrySchema),
});
export type EvidenceUrlMapping = z.infer<typeof evidenceUrlMappingSchema>;
