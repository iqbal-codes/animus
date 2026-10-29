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
    "command_not_found",
    "brake_active",
    "schedule_paused",
    "brake_state_unknown",
    "storage_failed",
    "backup_failed",
    "target_drift",
    "admission_rejected",
    "spec_parse_error",
    "method_not_allowed",
    "plan_not_found",
    "child_not_in_plan",
    "child_already_integrated",
    "spec_not_found",
    "project_not_active",
    "prerequisites_not_satisfied",
    "coordination_pipeline_halted",
    "coordination_failed",
    "integration_conflict",
    "integration_drift",
    "integration_branch_unresolvable",
    "worktree_lock_conflict",
    "starting_sha_mismatch",
    "starting_sha_unresolvable",
    "branch_cleanliness_check_failed",
    "worktree_dirty",
    "unintegrated_children_remain",
    "invalid_primitive",
    "invalid_targeted_submission",
    "contract_digest_mismatch",
    "final_pr_failed",
    "dispatch_failed",
    "invalid_spec_number",
    "dependency_cycle_detected",
    "dependency_resolution_stuck",
    "git_command_failed",
    "git_ref_error",
    "checkout_failed",
    "rev_parse_failed",
    "landing_guard_blocked",
    "candidate_drift",
    "base_drift",
    "evidence_missing",
    "verification_failed",
    "builder_self_approval_rejected",
    "freshness_check_failed",
    "confirmation_required",
    "action_drift_detected",
    "prerequisite_drift_detected",
    "unauthorized_control",
    "operation_unsupported",
    "run_not_cancellable",
    "process_tree_termination_failed",
    "gate_not_found",
    "stale_candidate_drift",
    "unverified_candidate_blocked",
    "release_policy_incomplete",
    "verification_not_found",
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
  body: z.string().nullable().optional(),
  integrated_to_branch: z.string().nullable().optional(),
  recommended_label: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  complexity: z.number().nullable().optional(),
  probabilities: z.record(z.string(), z.number()).nullable().optional(),
  jev_evaluation: jevEvaluationSchema.nullable().optional(),
});
export type EvaluatedIssue = z.infer<typeof evaluatedIssueSchema>;

export const labelEffectsSchema = z.object({
  current_labels: z.array(z.string()),
  proposed_labels: z.array(z.string()),
  added_labels: z.array(z.string()),
  removed_labels: z.array(z.string()),
});
export type LabelEffects = z.infer<typeof labelEffectsSchema>;

export const admissionPreviewSchema = z.object({
  status: z.enum(["admitted", "held", "excluded"]),
  reason: z.string(),
  dependencies: z.array(z.number().int()),
  unsatisfied_dependencies: z.array(z.number().int()),
  blocking_labels: z.array(z.string()),
  exclusion_labels: z.array(z.string()),
  active_claim: z.boolean(),
});
export type AdmissionPreview = z.infer<typeof admissionPreviewSchema>;

export const intakePreviewSubmissionSchema = z.object({
  issue_number: z.number().int().positive().optional(),
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string()).optional(),
});
export type IntakePreviewSubmission = z.infer<typeof intakePreviewSubmissionSchema>;

export const intakePreviewResultSchema = z.object({
  target_repo: z.string(),
  target_issue_number: z.number().int().positive().nullable().optional(),
  title: z.string(),
  title_diff: z.string().nullable(),
  body: z.string(),
  body_diff: z.string().nullable(),
  label_effects: labelEffectsSchema,
  admission_preview: admissionPreviewSchema,
});
export type IntakePreviewResult = z.infer<typeof intakePreviewResultSchema>;

export const intakePublishSubmissionSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string()).optional(),
});
export type IntakePublishSubmission = z.infer<typeof intakePublishSubmissionSchema>;

export const intakePublishResultSchema = z.object({
  repo: z.string(),
  issue: evaluatedIssueSchema,
  created_at: z.string(),
});
export type IntakePublishResult = z.infer<typeof intakePublishResultSchema>;

export const intakeUpdateSubmissionSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  state: z.enum(["open", "closed", "OPEN", "CLOSED"]).optional(),
});
export type IntakeUpdateSubmission = z.infer<typeof intakeUpdateSubmissionSchema>;

export const targetBindingSubmissionSchema = z.object({
  expected_state: z.string().default("OPEN"),
  expected_labels: z.array(z.string()),
  expected_admission_status: z.enum(["admitted", "held", "excluded"]).default("admitted"),
});
export type TargetBindingSubmission = z.infer<typeof targetBindingSubmissionSchema>;

export const targetBindingResultSchema = z.object({
  bound: z.boolean(),
  project_id: z.string(),
  repo_name: z.string(),
  issue_number: z.number().int().positive(),
  state: z.string(),
  labels: z.array(z.string()),
  admission_status: z.enum(["admitted", "held", "excluded"]),
  bound_at: z.string(),
});
export type TargetBindingResult = z.infer<typeof targetBindingResultSchema>;

export const branchIntegrationSubmissionSchema = z.object({
  branch: z.string().min(1),
  commit_sha: z.string().optional(),
});
export type BranchIntegrationSubmission = z.infer<typeof branchIntegrationSubmissionSchema>;

export const branchIntegrationResultSchema = z.object({
  project_id: z.string(),
  issue_number: z.number().int().positive(),
  branch: z.string(),
  commit_sha: z.string().nullable().optional(),
  integrated_at: z.string(),
});
export type BranchIntegrationResult = z.infer<typeof branchIntegrationResultSchema>;

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

export const commandStateSchema = z.enum([
  "rejected",
  "dispatched",
  "acknowledged",
  "running",
  "succeeded",
  "failed",
  "partial",
  "unknown",
]);
export type CommandState = z.infer<typeof commandStateSchema>;

export const commandProvenanceSchema = z.object({
  source: z.string(),
  timestamp: z.string(),
  actor: z.string().optional(),
  details: z.string().optional(),
});
export type CommandProvenance = z.infer<typeof commandProvenanceSchema>;

export const commandOutcomeSchema = z.object({
  state: commandStateSchema,
  provenance: commandProvenanceSchema,
  error: z.string().nullable().optional(),
  result: z.unknown().optional(),
});
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;

export const commandRecordSchema = z.object({
  requestId: z.string().min(1),
  actor: z.string().min(1),
  projectId: z.string().nullable().optional(),
  action: z.string().min(1),
  target: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
  state: commandStateSchema,
  outcome: commandOutcomeSchema.nullable().optional(),
  evidenceLinks: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  reconciledAt: z.string().nullable().optional(),
});
export type CommandRecord = z.infer<typeof commandRecordSchema>;

export const commandListSchema = z.array(commandRecordSchema);
export type CommandList = z.infer<typeof commandListSchema>;

export const commandSubmissionSchema = z.object({
  requestId: z.string().min(1).optional(),
  actor: z.string().min(1).default("operator"),
  projectId: z.string().nullable().optional(),
  action: z.string().min(1),
  target: z.record(z.string(), z.unknown()),
});
export type CommandSubmission = z.infer<typeof commandSubmissionSchema>;

export const commandReconciliationResultSchema = z.object({
  reconciledCount: z.number().int().nonnegative(),
  commands: z.array(commandRecordSchema),
  timestamp: z.string(),
});
export type CommandReconciliationResult = z.infer<typeof commandReconciliationResultSchema>;

export const globalBrakeStateSchema = z.object({
  global_launch_brake: z.boolean(),
  schedule_pause: z.boolean(),
  updated_at: z.string(),
});
export type GlobalBrakeState = z.infer<typeof globalBrakeStateSchema>;

export const projectBrakeStateSchema = z.object({
  project_id: z.string(),
  launch_brake: z.boolean(),
  schedule_pause: z.boolean(),
  effective_launch_brake: z.boolean(),
  effective_schedule_pause: z.boolean(),
  updated_at: z.string(),
});
export type ProjectBrakeState = z.infer<typeof projectBrakeStateSchema>;

export const brakeSubmissionSchema = z.object({
  brake: z.enum(["global_launch", "project_launch", "schedule_pause"]),
  active: z.boolean(),
  reason: z.string().optional(),
  actor: z.string().optional(),
});
export type BrakeSubmission = z.infer<typeof brakeSubmissionSchema>;

export const projectBrakeSubmissionSchema = z.object({
  brake: z.enum(["launch_brake", "schedule_pause"]),
  active: z.boolean(),
  reason: z.string().optional(),
  actor: z.string().optional(),
});
export type ProjectBrakeSubmission = z.infer<typeof projectBrakeSubmissionSchema>;

export const backupSubmissionSchema = z.object({
  destinationPath: z.string().min(1),
});
export type BackupSubmission = z.infer<typeof backupSubmissionSchema>;

export const backupResultSchema = z.object({
  success: z.boolean(),
  destinationPath: z.string(),
  timestamp: z.string(),
});
export type BackupResult = z.infer<typeof backupResultSchema>;

// Coordination schemas (Issue #62)
export const childTicketStatusSchema = z.enum([
  "pending",
  "dispatched",
  "running",
  "integrated_to_branch",
  "failed",
]);
export type ChildTicketStatus = z.infer<typeof childTicketStatusSchema>;

export const frozenContractSchema = z.object({
  sourceAndProblem: z.string().optional(),
  outcome: z.string().optional(),
  invariants: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  boundary: z.string().optional(),
  rawBody: z.string(),
  digest: z.string(),
});
export type FrozenContract = z.infer<typeof frozenContractSchema>;

export const coordinatedChildTicketSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  dependencies: z.array(z.number().int().positive()),
  status: childTicketStatusSchema,
  contract: frozenContractSchema,
  worktreePath: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type CoordinatedChildTicket = z.infer<typeof coordinatedChildTicketSchema>;

export const finalPullRequestInfoSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  head: z.string(),
  base: z.string(),
});
export type FinalPullRequestInfo = z.infer<typeof finalPullRequestInfoSchema>;

export const haltAttributionSchema = z.object({
  childIssueNumber: z.number().int().positive().optional(),
  stage: z.string(),
  error: z.string(),
  worktreePath: z.string().optional(),
  preservedSha: z.string().optional(),
});
export type HaltAttribution = z.infer<typeof haltAttributionSchema>;

export const specCoordinationPlanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  specIssueNumber: z.number().int().positive(),
  isStandalone: z.boolean(),
  integrationBranch: z.string(),
  baseBranch: z.string(),
  baseSha: z.string(),
  currentIntegrationSha: z.string(),
  status: z.enum(["planning", "active", "halted", "completed"]),
  dag: z.record(z.string(), z.array(z.number().int().positive())),
  children: z.array(coordinatedChildTicketSchema),
  snapshotTimestamp: z.string(),
  finalPullRequest: finalPullRequestInfoSchema.nullable().optional(),
  haltReason: z.string().nullable().optional(),
  haltAttribution: haltAttributionSchema.nullable().optional(),
});
export type SpecCoordinationPlan = z.infer<typeof specCoordinationPlanSchema>;

export const planSubmissionSchema = z.object({
  specIssueNumber: z.number().int().positive(),
  baseBranch: z.string().optional(),
});
export type PlanSubmission = z.infer<typeof planSubmissionSchema>;

export const dispatchSubmissionSchema = z.object({
  specIssueNumber: z.number().int().positive(),
  childIssueNumber: z.number().int().positive(),
  actor: z.string().optional(),
});
export type DispatchSubmission = z.infer<typeof dispatchSubmissionSchema>;

export const targetedImplementSubmissionSchema = z.object({
  specIssueNumber: z.number().int().positive(),
  childIssueNumber: z.number().int().positive(),
  worktreePath: z.string(),
  branch: z.string(),
  startSha: z.string(),
  contract: frozenContractSchema,
  primitive: z.literal("archon-implement"),
});
export type TargetedImplementSubmission = z.infer<typeof targetedImplementSubmissionSchema>;

export const targetedImplementResultSchema = z.object({
  success: z.boolean(),
  childIssueNumber: z.number().int().positive(),
  headSha: z.string().optional(),
  commitMessage: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().int().optional(),
});
export type TargetedImplementResult = z.infer<typeof targetedImplementResultSchema>;

export const coordinationFinalPrSubmissionSchema = z.object({
  specIssueNumber: z.number().int().positive(),
  baseBranch: z.string().default("main"),
  title: z.string().optional(),
  body: z.string().optional(),
});
export type CoordinationFinalPrSubmission = z.infer<typeof coordinationFinalPrSubmissionSchema>;

export const coordinationFinalPrResultSchema = z.object({
  prNumber: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  head: z.string(),
  base: z.string(),
  integratedChildren: z.array(z.number().int().positive()),
});
export type CoordinationFinalPrResult = z.infer<typeof coordinationFinalPrResultSchema>;

// Evidence, Candidate Verification & Landing Guard Schemas (AC1, AC2)
export const checkResultSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]);
export type CheckResult = z.infer<typeof checkResultSchema>;

export const verificationCheckItemSchema = z.object({
  name: z.string(),
  command: z.string(),
  result: checkResultSchema,
  durationMs: z.number().optional(),
  artifactPath: z.string().optional(),
  details: z.string().optional(),
});
export type VerificationCheckItem = z.infer<typeof verificationCheckItemSchema>;

export const producerRoleSchema = z.enum([
  "independent_evaluator",
  "peer_reviewer",
  "automated_gate",
  "builder",
]);
export type ProducerRole = z.infer<typeof producerRoleSchema>;

export const producerIdentitySchema = z.object({
  id: z.string(),
  role: producerRoleSchema,
  name: z.string().optional(),
});
export type ProducerIdentity = z.infer<typeof producerIdentitySchema>;

export const independentReviewSchema = z.object({
  reviewerId: z.string(),
  role: z.enum(["peer_reviewer", "independent_evaluator"]),
  status: z.enum(["passed", "failed"]),
  summary: z.string(),
  standardsFindingCount: z.number().int().nonnegative(),
  specFindingCount: z.number().int().nonnegative(),
  reviewedAt: z.string(),
});
export type IndependentReview = z.infer<typeof independentReviewSchema>;

export const candidateVerificationStatusSchema = z.enum(["passed", "failed", "unverified"]);
export type CandidateVerificationStatus = z.infer<typeof candidateVerificationStatusSchema>;

export const candidateVerificationRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  specIssueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive(),
  candidateHeadSha: z.string(),
  mergeBaseSha: z.string(),
  runtimeEnvironment: z.object({
    runtime: z.string(),
    os: z.string(),
    digest: z.string().optional(),
  }),
  producerIdentity: producerIdentitySchema,
  verificationStatus: candidateVerificationStatusSchema,
  checks: z.array(verificationCheckItemSchema),
  review: independentReviewSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CandidateVerificationRecord = z.infer<typeof candidateVerificationRecordSchema>;

export const candidateVerificationSubmissionSchema = z.object({
  specIssueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive(),
  candidateHeadSha: z.string(),
  mergeBaseSha: z.string(),
  runtimeEnvironment: z.object({
    runtime: z.string(),
    os: z.string(),
    digest: z.string().optional(),
  }),
  producerIdentity: producerIdentitySchema,
  verificationStatus: candidateVerificationStatusSchema,
  checks: z.array(verificationCheckItemSchema),
  review: independentReviewSchema.optional(),
});
export type CandidateVerificationSubmission = z.infer<typeof candidateVerificationSubmissionSchema>;

export const landingGuardDecisionSchema = z.enum(["allowed", "blocked"]);
export type LandingGuardDecision = z.infer<typeof landingGuardDecisionSchema>;

export const landingGuardResultSchema = z.object({
  decision: landingGuardDecisionSchema,
  allowed: z.boolean(),
  prNumber: z.number().int().positive(),
  candidateHeadSha: z.string(),
  mergeBaseSha: z.string(),
  evidenceId: z.string().optional(),
  blockReason: z.string().optional(),
  blockDetails: z.record(z.string(), z.unknown()).optional(),
});
export type LandingGuardResult = z.infer<typeof landingGuardResultSchema>;

export const landingSubmissionSchema = z.object({
  prNumber: z.number().int().positive(),
  expectedHeadSha: z.string(),
  expectedBaseSha: z.string(),
  actor: z.string().optional().default("operator"),
});
export type LandingSubmission = z.input<typeof landingSubmissionSchema>;

export const landingExecutionResultSchema = z.object({
  success: z.boolean(),
  prNumber: z.number().int().positive(),
  merged: z.boolean(),
  mergeSha: z.string().optional(),
  candidateHeadSha: z.string(),
  mergeBaseSha: z.string(),
});
export type LandingExecutionResult = z.infer<typeof landingExecutionResultSchema>;

// Tiered Action Matrix Schemas (AC3)
export const actionTierSchema = z.enum(["read_only", "reversible_control", "consequential"]);
export type ActionTier = z.infer<typeof actionTierSchema>;

export const consequentialActionTypeSchema = z.enum([
  "launch",
  "cancel",
  "gate_approval",
  "promotion_pr",
  "merge",
  "deploy",
]);
export type ConsequentialActionType = z.infer<typeof consequentialActionTypeSchema>;

export const tieredActionSubmissionSchema = z.object({
  action: consequentialActionTypeSchema,
  targetBranch: z.string(),
  expectedBranchSha: z.string(),
  issueNumbers: z.array(z.number().int().positive()),
  prerequisiteStates: z.record(z.string(), z.string()).optional(),
  confirmed: z.boolean().default(false),
  actor: z.string().optional().default("operator"),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type TieredActionSubmission = z.input<typeof tieredActionSubmissionSchema>;

export const tieredActionResultSchema = z.object({
  success: z.boolean(),
  action: consequentialActionTypeSchema,
  freshnessVerified: z.boolean(),
  freshnessDurationMs: z.number(),
  targetBranch: z.string(),
  branchSha: z.string(),
  executedAt: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type TieredActionResult = z.infer<typeof tieredActionResultSchema>;

// Per-Run Controls Schemas (AC4)
export const runCancellationSubmissionSchema = z.object({
  runId: z.string(),
  actor: z.string().optional().default("operator"),
  reason: z.string().optional(),
  signal: z.enum(["SIGTERM", "SIGKILL"]).optional().default("SIGTERM"),
});
export type RunCancellationSubmission = z.input<typeof runCancellationSubmissionSchema>;

export const runCancellationResultSchema = z.object({
  success: z.boolean(),
  runId: z.string(),
  status: z.enum(["cancelled", "terminated", "unsupported", "failed"]),
  cleanupVerified: z.boolean(),
  killedPids: z.array(z.number().int()),
  error: z.string().optional(),
});
export type RunCancellationResult = z.infer<typeof runCancellationResultSchema>;

// Gate Approval & Policy-Required Stages Schemas (AC5)
export const gateApprovalSubmissionSchema = z.object({
  gateId: z.string(),
  candidateSha: z.string(),
  decision: z.enum(["approved", "rejected"]),
  actor: z.string().optional().default("operator"),
  comment: z.string().optional(),
});
export type GateApprovalSubmission = z.input<typeof gateApprovalSubmissionSchema>;

export const gateApprovalRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  gateId: z.string(),
  candidateSha: z.string(),
  decision: z.enum(["approved", "rejected"]),
  actor: z.string(),
  comment: z.string().optional(),
  createdAt: z.string(),
});
export type GateApprovalRecord = z.infer<typeof gateApprovalRecordSchema>;

export const releasePolicyStageSchema = z.object({
  stage: z.string(),
  passed: z.boolean(),
  status: z.enum(["passed", "failed", "pending"]),
  details: z.string().optional(),
});
export type ReleasePolicyStage = z.infer<typeof releasePolicyStageSchema>;

export const releaseReadinessResultSchema = z.object({
  projectId: z.string(),
  candidateSha: z.string(),
  releaseComplete: z.boolean(),
  stages: z.array(releasePolicyStageSchema),
  pendingStages: z.array(z.string()),
});
export type ReleaseReadinessResult = z.infer<typeof releaseReadinessResultSchema>;

// Sanitized Report Schemas (AC6)
export const sanitizedReportSchema = z.object({
  report: z.string(),
  sanitized: z.boolean(),
  redactedTokensCount: z.number().int().nonnegative(),
  scrubbedHoldoutsCount: z.number().int().nonnegative(),
});
export type SanitizedReport = z.infer<typeof sanitizedReportSchema>;

// WebSocket Live Observation & Recovery Schemas (AC2 / Issue #64)
export const wsSubscriptionMessageSchema = z.object({
  action: z.enum(["subscribe", "unsubscribe", "ping", "request_snapshot"]),
  projectId: z.string().optional(),
  lapId: z.string().optional(),
  scope: z.string().optional(),
});
export type WsSubscriptionMessage = z.infer<typeof wsSubscriptionMessageSchema>;

export const wsEventTypeSchema = z.enum([
  "log",
  "lifecycle",
  "invalidation",
  "gap",
  "heartbeat",
  "pong",
]);
export type WsEventType = z.infer<typeof wsEventTypeSchema>;

export const wsEventSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  type: wsEventTypeSchema,
  projectId: z.string().optional(),
  lapId: z.string().optional(),
  timestamp: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type WsEvent = z.infer<typeof wsEventSchema>;
