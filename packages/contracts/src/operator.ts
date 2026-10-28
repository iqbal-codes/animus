import { z } from "zod";
import { serviceHealthSchema } from "./health";

export const healthSchema = serviceHealthSchema
  .extend({ host: serviceHealthSchema })
  .refine((value) => value.buildId === value.host.buildId);
export type Health = z.infer<typeof healthSchema>;

export const operatorErrorSchema = z.object({
  error: z.enum([
    "host_unavailable",
    "host_unauthorized",
    "invalid_host_response",
    "candidate_mismatch",
    "native_source_unavailable",
    "native_state_unavailable",
    "lap_not_found",
    "scope_mismatch",
    "launch_brake_set",
    "native_launch_failed",
    "invalid_payload",
    "intake_unavailable",
    "issue_not_found",
    "control_failed",
    "report_not_found",
    "evidence_unavailable",
    "no_unpromoted_commits",
    "promotion_pr_already_open",
    "promotion_failed",
    "partial_promotion_effect",
    "project_not_found",
    "project_already_exists",
    "project_checkout_invalid",
    "project_has_active_runs",
    "partial_registration_effect",
    "retarget_rejected",
  ]),
});
export type OperatorErrorCode = z.infer<typeof operatorErrorSchema>["error"];

export const controlActionSchema = z.enum(["halt", "unhalt", "pause", "unpause"]);
export type ControlAction = z.infer<typeof controlActionSchema>;

export const controlSubmissionSchema = z
  .object({
    action: controlActionSchema,
  })
  .strict();
export type ControlSubmission = z.infer<typeof controlSubmissionSchema>;

export const controlStateSchema = z.object({
  halted: z.boolean(),
  paused: z.boolean(),
  active_brake: z.enum(["none", "stop", "pause", "both"]),
  updated_at: z.string(),
});
export type ControlState = z.infer<typeof controlStateSchema>;

export const jevEvaluationSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  is_actionable: z.number().optional(),
  choice: z.string().optional(),
  confidence: z.number().optional(),
  complexity: z.number().nullable().optional(),
  probabilities: z.record(z.string(), z.number()).nullable().optional(),
  recommendation_reason: z.string().optional(),
});
export type JevEvaluation = z.infer<typeof jevEvaluationSchema>;

export const evaluatedIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  admission_status: z.enum(["admitted", "held", "excluded"]),
  reason: z.string(),
  labels: z.array(z.string()),
  dependencies: z.array(z.number().int()),
  unsatisfied_dependencies: z.array(z.number().int()),
  recommended_label: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  complexity: z.number().nullable().optional(),
  probabilities: z.record(z.string(), z.number()).nullable().optional(),
  jev_evaluation: jevEvaluationSchema.nullable().optional(),
});
export type EvaluatedIssue = z.infer<typeof evaluatedIssueSchema>;

export const intakeResultSchema = z.object({
  repo: z.string(),
  as_of: z.string(),
  cached: z.boolean(),
  total_count: z.number().int().nonnegative(),
  admitted_count: z.number().int().nonnegative(),
  held_count: z.number().int().nonnegative(),
  excluded_count: z.number().int().nonnegative(),
  issues: z.array(evaluatedIssueSchema),
});
export type IntakeResult = z.infer<typeof intakeResultSchema>;

export const launchSubmissionSchema = z
  .object({
    specification: z.string().min(1),
  })
  .strict();
export type LaunchSubmission = z.infer<typeof launchSubmissionSchema>;

export const launchAckSchema = z.object({
  id: z.string(),
  status: z.string(),
});
export type LaunchAck = z.infer<typeof launchAckSchema>;

export const diagnosticsSchema = z.object({
  status: z.enum(["healthy", "degraded", "unavailable"]),
  revision_required: z.string(),
  digest: z.string(),
  captured_at: z.string().nullable(),
  source_directory: z.string(),
  file_count: z.number().int().nonnegative(),
  default_workflows_loaded: z.boolean(),
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

export const workflowCatalogItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  default_inputs: z.record(z.string(), z.string()).optional(),
});
export const workflowCatalogSchema = z.object({
  workflows: z.array(workflowCatalogItemSchema),
});
export type WorkflowCatalog = z.infer<typeof workflowCatalogSchema>;

export const lapTransitionSchema = z.object({
  id: z.string().nullable().optional(),
  event_type: z.string().nullable().optional(),
  step_name: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  event_order: z.number().int().optional(),
});
export type LapTransition = z.infer<typeof lapTransitionSchema>;

export const lapSessionAgentSchema = z.object({
  node_name: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
});

export const lapSummarySchema = z.object({
  id: z.string(),
  workflow_name: z.string(),
  native_status: z.string(),
  product_status: z.string(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  last_activity_at: z.string().nullable().optional(),
  candidate_head: z.string().nullable().optional(),
  work_item: z.string().nullable().optional(),
  pull_request: z.string().nullable().optional(),
  transitions: z.array(lapTransitionSchema).optional(),
});
export const lapListSchema = z.array(lapSummarySchema);
export type LapSummary = z.infer<typeof lapSummarySchema>;
export type LapList = z.infer<typeof lapListSchema>;

export const lapDetailSchema = lapSummarySchema.extend({
  source: z.record(z.string(), z.string().nullable()).optional(),
  source_commit: z.string().nullable().optional(),
  session: z
    .object({
      conversation_id: z.string().nullable().optional(),
      working_path: z.string().nullable().optional(),
      agents: z.array(lapSessionAgentSchema).optional(),
    })
    .optional(),
  approval_evidence: z.record(z.string(), z.any()).nullable().optional(),
  tokens: z
    .object({
      in: z.number().int().default(0),
      out: z.number().int().default(0),
      cache_read: z.number().int().default(0),
      cost_usd: z.number().default(0.0),
    })
    .optional(),
});
export type LapDetail = z.infer<typeof lapDetailSchema>;

export const lapEvidenceSchema = z.object({
  id: z.string(),
  workflow_name: z.string().nullable().optional(),
  candidate_head: z.string().nullable().optional(),
  runtime_verification: z.object({
    status: z.enum(["verified", "failed", "inconclusive", "absent"]),
    verdict: z.string().nullable().optional(),
    lines: z.array(z.record(z.string(), z.any())).optional(),
    holdout: z
      .object({
        verdict: z.string().nullable().optional(),
        lines: z.array(z.record(z.string(), z.any())).optional(),
      })
      .optional(),
  }),
  peer_review: z.object({
    status: z.enum(["ready", "failed", "stale", "not_ready", "absent"]),
    sha: z.string().nullable().optional(),
    outcome: z.string().nullable().optional(),
    independent: z.boolean(),
    reviewer_session: z.string().nullable().optional(),
    blocking_findings: z.number().int().nonnegative(),
    report: z.object({
      available: z.boolean(),
      path: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    }),
  }),
});
export type LapEvidence = z.infer<typeof lapEvidenceSchema>;

export const promotionStatusSchema = z.object({
  main_branch: z.string(),
  develop_branch: z.string(),
  unpromoted_count: z.number().int().nonnegative(),
  delivered_tickets: z.array(z.number().int()),
  candidate_freeze: z.boolean(),
  existing_pr: z
    .object({
      number: z.number().int().positive(),
      url: z.string(),
      title: z.string(),
    })
    .nullable(),
  ready_to_promote: z.boolean(),
});
export type PromotionStatus = z.infer<typeof promotionStatusSchema>;

export const promotionSubmissionSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().optional(),
});
export type PromotionSubmission = z.infer<typeof promotionSubmissionSchema>;

export const promotionResultSchema = z.object({
  pr_number: z.number().int().positive(),
  pr_url: z.string(),
  title: z.string(),
  unpromoted_count: z.number().int().nonnegative(),
  candidate_freeze: z.boolean(),
  partial_effect: z.boolean().default(false),
  local_effect_error: z.string().nullable().optional(),
});
export type PromotionResult = z.infer<typeof promotionResultSchema>;

export const projectStatusSchema = z.enum(["active", "held", "tombstone"]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  repo_id: z.number().int().positive(),
  repo_name: z.string().min(1),
  checkout_path: z.string().min(1),
  status: projectStatusSchema,
  status_reason: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.array(projectSchema);
export type ProjectList = z.infer<typeof projectListSchema>;

export const projectRegistrationLocalCheckoutSchema = z.object({
  method: z.literal("local_checkout"),
  name: z.string().min(1),
  checkout_path: z.string().min(1),
});
export type ProjectRegistrationLocalCheckout = z.infer<
  typeof projectRegistrationLocalCheckoutSchema
>;

export const projectRegistrationGithubCloneSchema = z.object({
  method: z.literal("github_clone"),
  name: z.string().min(1),
  repo: z.string().min(1),
  target_path: z.string().min(1),
});
export type ProjectRegistrationGithubClone = z.infer<typeof projectRegistrationGithubCloneSchema>;

export const projectRegistrationGithubCreateSchema = z.object({
  method: z.literal("github_create"),
  name: z.string().min(1),
  repo: z.string().min(1),
  target_path: z.string().min(1),
  private: z.boolean().optional(),
});
export type ProjectRegistrationGithubCreate = z.infer<typeof projectRegistrationGithubCreateSchema>;

export const projectRegistrationSchema = z.discriminatedUnion("method", [
  projectRegistrationLocalCheckoutSchema,
  projectRegistrationGithubCloneSchema,
  projectRegistrationGithubCreateSchema,
]);
export type ProjectRegistration = z.infer<typeof projectRegistrationSchema>;

export const projectRetargetSchema = z
  .object({
    checkout_path: z.string().min(1),
  })
  .strict();
export type ProjectRetarget = z.infer<typeof projectRetargetSchema>;

export const deregisterResultSchema = z.object({
  status: z.literal("tombstone"),
  id: z.string(),
});
export type DeregisterResult = z.infer<typeof deregisterResultSchema>;
