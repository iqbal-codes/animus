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
    "backup_incomplete",
    "restore_failed",
    "restore_validation_failed",
    "restore_target_unavailable",
    "restore_reconcile_unresolved",
    "restore_reconcile_conflict",
    "restore_reconcile_unverified",
    "installation_held",
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
    "invalid_signature",
    "work_not_found",
    "draft_work_not_found",
    "draft_not_found",
    "draft_invalid_plan",
    "draft_answers_required",
    "draft_answer_mismatch",
    "draft_stale_revision",
    "draft_concurrent_update",
    "draft_not_approvable",
    "draft_prepared_work",
    "draft_planning_unavailable",
    "draft_planning_failed",
    "draft_storage_failed",
    "draft_publication_not_found",
    "draft_publication_project_not_found",
    "draft_publication_not_approved",
    "draft_publication_not_publishable",
    "draft_publication_stale_revision",
    "draft_publication_draft_changed",
    "draft_publication_transport_unsupported",
    "draft_publication_invalid_plan",
    "draft_publication_source_missing",
    "draft_publication_failed",
    "plan_import_failed",
    "observation_not_found",
    "finding_not_found",
    "artifact_not_found",
    "artifact_corrupt",
    "artifact_unsafe_path",
    "forged_ownership",
    "self_certification_rejected",
    "stale_candidate_evidence",
    "acceptance_blocked",
    "invalid_stage_producer",
    "unauthorized_producer",
    "producer_exists",
    "stage_writer_restricted",
    "builder_claim_mismatch",
    "run_not_found",
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

export const workSourceCommentSchema = z.object({
  id: z.string().nullable(),
  author: z.string().nullable(),
  body: z.string(),
});
export type WorkSourceComment = z.infer<typeof workSourceCommentSchema>;

export const workSourceSnapshotSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  labels: z.array(z.string()),
  comments: z.array(workSourceCommentSchema),
});
export type WorkSourceSnapshot = z.infer<typeof workSourceSnapshotSchema>;

export const workProvenanceSchema = z.object({
  repo_id: z.number().int().positive(),
  repo_name: z.string().min(1),
  issue_number: z.number().int().positive(),
  source_url: z.string().min(1),
  captured_at: z.number().int().nonnegative(),
});
export type WorkProvenance = z.infer<typeof workProvenanceSchema>;

export const workRevisionSchema = z.object({
  id: z.string().min(1),
  work_id: z.string().min(1),
  project_id: z.string().min(1),
  revision_number: z.number().int().positive(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source: workSourceSnapshotSchema,
  provenance: workProvenanceSchema,
  imported_at: z.number().int().nonnegative(),
});
export type WorkRevision = z.infer<typeof workRevisionSchema>;

export const workRecordSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  repo_id: z.number().int().positive(),
  repo_name: z.string().min(1),
  issue_number: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  revision: workRevisionSchema,
});
export type WorkRecord = z.infer<typeof workRecordSchema>;

export const workListSchema = z.array(workRecordSchema);
export type WorkList = z.infer<typeof workListSchema>;

export const draftKindSchema = z.enum(["clarification", "standalone", "spec"]);
export type DraftKind = z.infer<typeof draftKindSchema>;

export const draftStatusSchema = z.enum([
  "needs_clarification",
  "needs_review",
  "approved",
  "rejected",
  "changes_requested",
]);
export type DraftStatus = z.infer<typeof draftStatusSchema>;

export const draftDecisionKindSchema = z.enum(["approve", "reject", "revise"]);
export type DraftDecisionKind = z.infer<typeof draftDecisionKindSchema>;

export const draftQuestionSchema = z.strictObject({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1),
});
export type DraftQuestion = z.infer<typeof draftQuestionSchema>;

export const draftAnswerInputSchema = z.strictObject({
  question_id: z.string().min(1),
  answer: z.string().min(1),
});
export type DraftAnswerInput = z.infer<typeof draftAnswerInputSchema>;

export const draftAnswerSchema = z.strictObject({
  question_id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
});
export type DraftAnswer = z.infer<typeof draftAnswerSchema>;

export const draftAcceptanceCriterionSchema = z.strictObject({
  id: z.string().regex(/^AC[1-9][0-9]*$/),
  description: z.string().min(1),
  verification: z.string().min(1),
});
export type DraftAcceptanceCriterion = z.infer<typeof draftAcceptanceCriterionSchema>;

export const draftBoundarySchema = z.strictObject({
  touchpoints: z.string().min(1),
  known_callers: z.string().min(1),
  test_seam: z.string().min(1),
  exclusions: z.string().min(1),
});
export type DraftBoundary = z.infer<typeof draftBoundarySchema>;

const draftPlanFields = {
  scope: z.string().min(1),
  outcome: z.string().min(1),
  invariants: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(draftAcceptanceCriterionSchema).min(1),
  verification_requirements: z.array(z.string().min(1)).min(1),
  boundary: draftBoundarySchema,
  depends_on: z.array(z.number().int().positive()).default([]),
  body: z.string().min(1),
};

export const draftChildPlanSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  ...draftPlanFields,
  depends_on_indices: z.array(z.number().int().nonnegative()).default([]),
  covers_parent_ac_ids: z.array(z.string().min(1)).min(1),
});
export type DraftChildPlan = z.infer<typeof draftChildPlanSchema>;

export const draftClarificationPlanSchema = z.strictObject({
  kind: z.literal("clarification"),
  questions: z.array(draftQuestionSchema).min(1),
  reason: z.string().min(1),
});
export type DraftClarificationPlan = z.infer<typeof draftClarificationPlanSchema>;

export const draftStandalonePlanSchema = z.strictObject({
  kind: z.literal("standalone"),
  title: z.string().min(1),
  ...draftPlanFields,
  prepared: z.boolean().default(false),
});
export type DraftStandalonePlan = z.infer<typeof draftStandalonePlanSchema>;

export const draftSpecPlanSchema = z.strictObject({
  kind: z.literal("spec"),
  title: z.string().min(1),
  ...draftPlanFields,
  children: z.array(draftChildPlanSchema).min(2),
});
export type DraftSpecPlan = z.infer<typeof draftSpecPlanSchema>;

export const draftPlanSchema = z
  .discriminatedUnion("kind", [
    draftClarificationPlanSchema,
    draftStandalonePlanSchema,
    draftSpecPlanSchema,
  ])
  .superRefine((plan, ctx) => {
    if (plan.kind !== "spec") return;

    const parentAcIds = new Set<string>();
    for (const [index, ac] of plan.acceptance_criteria.entries()) {
      if (parentAcIds.has(ac.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate parent acceptance criterion id '${ac.id}'`,
          path: ["acceptance_criteria", index, "id"],
        });
      }
      parentAcIds.add(ac.id);
    }

    const childIds = new Set<string>();
    for (const [index, child] of plan.children.entries()) {
      if (childIds.has(child.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate child draft id '${child.id}'`,
          path: ["children", index, "id"],
        });
      }
      childIds.add(child.id);

      const seenDependencies = new Set<number>();
      for (const dependency of child.depends_on_indices) {
        if (seenDependencies.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Child '${child.id}' repeats dependency index ${dependency}`,
            path: ["children", index, "depends_on_indices"],
          });
        }
        seenDependencies.add(dependency);
        if (dependency >= index) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Child '${child.id}' dependency index ${dependency} must precede the child in topological order`,
            path: ["children", index, "depends_on_indices"],
          });
        }
      }

      const covered = new Set<string>();
      for (const acId of child.covers_parent_ac_ids) {
        if (covered.has(acId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Child '${child.id}' repeats parent acceptance criterion '${acId}'`,
            path: ["children", index, "covers_parent_ac_ids"],
          });
        }
        covered.add(acId);
        if (!parentAcIds.has(acId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Child '${child.id}' covers unknown parent acceptance criterion '${acId}'`,
            path: ["children", index, "covers_parent_ac_ids"],
          });
        }
      }
    }

    for (const [index, ac] of plan.acceptance_criteria.entries()) {
      const covered = plan.children.some((child) => child.covers_parent_ac_ids.includes(ac.id));
      if (!covered) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Parent acceptance criterion '${ac.id}' is not covered by any child draft`,
          path: ["acceptance_criteria", index, "id"],
        });
      }
    }
  });
export type DraftPlan = z.infer<typeof draftPlanSchema>;

export const draftPlannerMetadataSchema = z.strictObject({
  transport: z.enum(["agent", "prepared"]),
  prompt: z.string().min(1),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  effort: z.string().min(1).nullable(),
  accepted_ref: z.string().min(1).nullable(),
});
export type DraftPlannerMetadata = z.infer<typeof draftPlannerMetadataSchema>;

export const draftRevisionSchema = z.object({
  id: z.string().min(1),
  draft_id: z.string().min(1),
  project_id: z.string().min(1),
  work_id: z.string().min(1),
  revision_number: z.number().int().positive(),
  source_work_revision_id: z.string().min(1),
  source_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: draftKindSchema,
  plan: draftPlanSchema,
  plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
  questions: z.array(draftQuestionSchema),
  answers: z.array(draftAnswerSchema),
  instructions: z.string().nullable(),
  planner_metadata: draftPlannerMetadataSchema,
  created_at: z.number().int().nonnegative(),
});
export type DraftRevision = z.infer<typeof draftRevisionSchema>;

export const draftDecisionSchema = z.object({
  id: z.string().min(1),
  draft_id: z.string().min(1),
  project_id: z.string().min(1),
  revision_id: z.string().min(1),
  revision_number: z.number().int().positive(),
  decision: draftDecisionKindSchema,
  reason: z.string().min(1),
  instructions: z.string().nullable(),
  actor: z.string().nullable(),
  decided_at: z.number().int().nonnegative(),
});
export type DraftDecision = z.infer<typeof draftDecisionSchema>;

/**
 * Publication authorization for an operator-approved draft revision.
 *
 * This deliberately carries no dispatch or execution authority. Approval here
 * only permits publication; execution is admitted later by the publication and
 * read-back flow (#162) and by the execution authority cutover (#165).
 */
export const draftAuthorizationSchema = z.object({
  approved: z.boolean(),
  approved_revision_id: z.string().nullable(),
  can_publish: z.boolean(),
});
export type DraftAuthorization = z.infer<typeof draftAuthorizationSchema>;

export const draftRecordSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  work_id: z.string().min(1),
  status: draftStatusSchema,
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  source: workSourceSnapshotSchema,
  source_provenance: workProvenanceSchema,
  source_work_revision_id: z.string().min(1),
  source_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  latest_revision: draftRevisionSchema,
  latest_decision: draftDecisionSchema.nullable(),
  authorization: draftAuthorizationSchema,
});
export type DraftRecord = z.infer<typeof draftRecordSchema>;

export const draftListSchema = z.array(draftRecordSchema);
export type DraftList = z.infer<typeof draftListSchema>;

export const draftRefineSubmissionSchema = z.strictObject({
  work_id: z.string().min(1),
  answers: z.array(draftAnswerInputSchema).default([]),
  instructions: z.string().min(1).optional(),
});
export type DraftRefineSubmission = z.infer<typeof draftRefineSubmissionSchema>;

export const draftRevisionSubmissionSchema = z.strictObject({
  answers: z.array(draftAnswerInputSchema).default([]),
  instructions: z.string().min(1).optional(),
});
export type DraftRevisionSubmission = z.infer<typeof draftRevisionSubmissionSchema>;

export const draftDecisionSubmissionSchema = z
  .strictObject({
    revision_id: z.string().min(1).optional(),
    revision_number: z.number().int().positive().optional(),
    decision: draftDecisionKindSchema,
    reason: z.string().min(1),
    instructions: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
  })
  .superRefine((submission, ctx) => {
    if (submission.revision_id === undefined && submission.revision_number === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A revision_id or revision_number is required",
        path: ["revision_id"],
      });
    }
  });
export type DraftDecisionSubmission = z.infer<typeof draftDecisionSubmissionSchema>;

export const planKindSchema = z.enum(["standalone", "spec"]);
export type PlanKind = z.infer<typeof planKindSchema>;

export const planAuthoritySchema = z.enum(["admitted", "held", "revoked"]);
export type PlanAuthority = z.infer<typeof planAuthoritySchema>;

export const planMemberRoleSchema = z.enum(["spec", "ticket"]);
export type PlanMemberRole = z.infer<typeof planMemberRoleSchema>;

export const planGateProfileSchema = z.enum(["child", "standalone", "final"]);
export type PlanGateProfile = z.infer<typeof planGateProfileSchema>;

export const planHoldSeveritySchema = z.enum(["blocking", "conditional"]);
export type PlanHoldSeverity = z.infer<typeof planHoldSeveritySchema>;

export const planDecisionActionSchema = z.enum(["import", "approve", "revoke"]);
export type PlanDecisionAction = z.infer<typeof planDecisionActionSchema>;

export const planDecisionOutcomeSchema = z.enum(["admitted", "held", "revoked"]);
export type PlanDecisionOutcome = z.infer<typeof planDecisionOutcomeSchema>;

export const planDecisionSourceSchema = z.enum(["import_authorization", "operator"]);
export type PlanDecisionSource = z.infer<typeof planDecisionSourceSchema>;

export const planDependencySourceSchema = z.enum(["textual", "native", "textual+native"]);
export type PlanDependencySource = z.infer<typeof planDependencySourceSchema>;

export const planDependencyTargetSchema = z.enum(["internal", "external", "unresolved"]);
export type PlanDependencyTarget = z.infer<typeof planDependencyTargetSchema>;

export const planAcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  work_id: z.string().min(1),
  revision_id: z.string().min(1),
  ac_key: z.string().min(1),
  ordinal: z.number().int().positive(),
  text: z.string(),
});
export type PlanAcceptanceCriterion = z.infer<typeof planAcceptanceCriterionSchema>;

export const planDependencySchema = z.object({
  id: z.string().min(1),
  work_id: z.string().min(1),
  revision_id: z.string().min(1),
  target_issue_number: z.number().int().positive(),
  source: planDependencySourceSchema,
  target_role: planDependencyTargetSchema,
  target_work_id: z.string().min(1).nullable(),
  target_revision_id: z.string().min(1).nullable(),
});
export type PlanDependency = z.infer<typeof planDependencySchema>;

export const planCoverageSchema = z.object({
  parent_ac_key: z.string().min(1),
  child_work_id: z.string().min(1),
  note: z.string().nullable(),
});
export type PlanCoverage = z.infer<typeof planCoverageSchema>;

export const planHoldSchema = z.object({
  code: z.string().min(1),
  severity: planHoldSeveritySchema,
  member_work_id: z.string().min(1).nullable(),
  issue_number: z.number().int().positive().nullable(),
  detail: z.string(),
});
export type PlanHold = z.infer<typeof planHoldSchema>;

export const planMemberSchema = z.object({
  work_id: z.string().min(1),
  revision_id: z.string().min(1),
  revision_number: z.number().int().positive(),
  issue_number: z.number().int().positive(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(),
  source_state: z.enum(["OPEN", "CLOSED"]),
  role: planMemberRoleSchema,
  gate_profile: planGateProfileSchema,
});
export type PlanMember = z.infer<typeof planMemberSchema>;

export const planDecisionSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  action: planDecisionActionSchema,
  outcome: planDecisionOutcomeSchema,
  actor: z.string().min(1),
  source: planDecisionSourceSchema,
  reason: z.string().nullable(),
  manifest_id: z.string().min(1).nullable(),
  recorded_at: z.number().int().nonnegative(),
  holds: z.array(planHoldSchema),
});
export type PlanDecision = z.infer<typeof planDecisionSchema>;

export const planManifestSchema = z.object({
  version: z.literal(1),
  plan_id: z.string().min(1),
  project_id: z.string().min(1),
  kind: planKindSchema,
  graph_hash: z.string().regex(/^[a-f0-9]{64}$/),
  root: z.object({
    work_id: z.string().min(1),
    revision_id: z.string().min(1),
    revision_number: z.number().int().positive(),
    issue_number: z.number().int().positive(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  members: z.array(
    z.object({
      work_id: z.string().min(1),
      revision_id: z.string().min(1),
      revision_number: z.number().int().positive(),
      issue_number: z.number().int().positive(),
      content_hash: z.string().regex(/^[a-f0-9]{64}$/),
      role: planMemberRoleSchema,
      gate_profile: planGateProfileSchema,
    }),
  ),
  acceptance_criteria: z.array(
    z.object({
      work_id: z.string().min(1),
      ac_key: z.string().min(1),
      text: z.string(),
    }),
  ),
  ac_coverage: z.array(
    z.object({
      parent_ac_key: z.string().min(1),
      child_work_ids: z.array(z.string().min(1)),
    }),
  ),
  dependencies: z.array(
    z.object({
      work_id: z.string().min(1),
      target_issue_number: z.number().int().positive(),
      source: planDependencySourceSchema,
      target_work_id: z.string().min(1).nullable(),
      internal: z.boolean(),
    }),
  ),
  targets: z.object({
    delivery_branch: z.string().min(1),
    integration_branch: z.string().min(1).nullable(),
    final_pr_base: z.string().min(1),
  }),
  gate_profiles: z.array(
    z.object({
      work_id: z.string().min(1),
      gate_profile: planGateProfileSchema,
    }),
  ),
  merge_policy: z.object({
    child: z.literal("auto_after_gates"),
    standalone: z.literal("manual"),
    final: z.literal("manual"),
  }),
  budgets: z.object({
    child_max_laps: z.number().int().positive(),
    final_max_laps: z.number().int().positive(),
  }),
  frozen_at: z.number().int().nonnegative(),
});
export type PlanManifest = z.infer<typeof planManifestSchema>;

export const planAcceptedRevisionSchema = z.object({
  work_id: z.string().min(1),
  revision_id: z.string().min(1),
  revision_number: z.number().int().positive(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PlanAcceptedRevision = z.infer<typeof planAcceptedRevisionSchema>;

export const planRecordSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  kind: planKindSchema,
  root_work_id: z.string().min(1),
  root_revision_id: z.string().min(1),
  graph_hash: z.string().regex(/^[a-f0-9]{64}$/),
  delivery_branch: z.string().min(1),
  integration_branch: z.string().min(1).nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  members: z.array(planMemberSchema),
  acceptance_criteria: z.array(planAcceptanceCriterionSchema),
  dependencies: z.array(planDependencySchema),
  coverage: z.array(planCoverageSchema),
  decisions: z.array(planDecisionSchema),
  authority: planAuthoritySchema,
  holds: z.array(planHoldSchema),
  dispatchable: z.boolean(),
  accepted_revision: planAcceptedRevisionSchema.nullable(),
  manifest: planManifestSchema.nullable(),
});
export type PlanRecord = z.infer<typeof planRecordSchema>;

export const planSummarySchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  kind: planKindSchema,
  root_work_id: z.string().min(1),
  root_issue_number: z.number().int().positive(),
  root_title: z.string(),
  graph_hash: z.string().regex(/^[a-f0-9]{64}$/),
  authority: planAuthoritySchema,
  member_count: z.number().int().nonnegative(),
  ticket_count: z.number().int().nonnegative(),
  hold_count: z.number().int().nonnegative(),
  accepted_revision_id: z.string().min(1).nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type PlanSummary = z.infer<typeof planSummarySchema>;
export const planListSchema = z.array(planSummarySchema);
export type PlanList = z.infer<typeof planListSchema>;

export const planImportSubmissionSchema = z
  .object({
    work_id: z.string().min(1).optional(),
    issue_number: z.number().int().positive().optional(),
    kind: planKindSchema,
    delivery_branch: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.work_id) !== Boolean(value.issue_number), {
    message: "Provide exactly one of work_id or issue_number",
  });
export type PlanImportSubmission = z.infer<typeof planImportSubmissionSchema>;

export const planDecisionSubmissionSchema = z
  .object({
    actor: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(2000).optional(),
    expected_sequence: z.number().int().positive().optional(),
  })
  .strict();
export type PlanDecisionSubmission = z.infer<typeof planDecisionSubmissionSchema>;

export const dispatchRunStateSchema = z.enum([
  "claimed",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "reconciled",
]);
export type DispatchRunState = z.infer<typeof dispatchRunStateSchema>;

export const dispatchMergePolicySchema = z.enum(["auto_after_gates", "manual"]);
export type DispatchMergePolicy = z.infer<typeof dispatchMergePolicySchema>;

export const planDispatchRunSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  delivery_id: z.string().min(1),
  plan_id: z.string().min(1),
  work_id: z.string().min(1),
  revision_id: z.string().min(1),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  issue_number: z.number().int().positive(),
  role: planMemberRoleSchema,
  gate_profile: planGateProfileSchema,
  merge_policy: dispatchMergePolicySchema,
  target_branch: z.string().min(1),
  ownership_generation: z.number().int().positive(),
  lap: z.number().int().positive(),
  state: dispatchRunStateSchema,
  actor: z.string().min(1),
  command_request_id: z.string().min(1),
  branch: z.string().min(1),
  worktree_path: z.string().min(1),
  base_sha: z.string().min(1),
  owner_pid: z.number().int().positive().nullable(),
  owner_token: z.string().min(1),
  lease_expires_at: z.number().int().nonnegative().nullable(),
  head_sha: z.string().nullable(),
  error: z.string().nullable(),
  launched_at: z.number().int().nonnegative().nullable(),
  finished_at: z.number().int().nonnegative().nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type PlanDispatchRun = z.infer<typeof planDispatchRunSchema>;
export const planDispatchRunListSchema = z.array(planDispatchRunSchema);
export type PlanDispatchRunList = z.infer<typeof planDispatchRunListSchema>;

export const planDispatchSubmissionSchema = z
  .object({
    plan_id: z.string().min(1),
    work_id: z.string().min(1).optional(),
    issue_number: z.number().int().positive().optional(),
    actor: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => !(value.work_id && value.issue_number), {
    message: "Provide at most one of work_id or issue_number",
  });
export type PlanDispatchSubmission = z.infer<typeof planDispatchSubmissionSchema>;

export const planDispatchReconcileSubmissionSchema = z
  .object({
    actor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type PlanDispatchReconcileSubmission = z.infer<typeof planDispatchReconcileSubmissionSchema>;

export const planDispatchReconciliationSchema = z.object({
  reconciled: z.array(planDispatchRunSchema),
  retained: z.array(planDispatchRunSchema),
  timestamp: z.string(),
});
export type PlanDispatchReconciliation = z.infer<typeof planDispatchReconciliationSchema>;

export const executionBudgetStatusSchema = z.object({
  scopeId: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  planId: z.string().min(1),
  workId: z.string().min(1),
  gateProfile: planGateProfileSchema,
  baseLimit: z.number().int().positive(),
  grantedAttempts: z.number().int().nonnegative(),
  consumedAttempts: z.number().int().nonnegative(),
  allowedAttempts: z.number().int().positive(),
  remainingAttempts: z.number().int().nonnegative(),
  status: z.enum(["active", "exhausted"]),
  exhaustedAt: z.number().int().nonnegative().nullable(),
  lastRejection: z.string().nullable(),
  retainedWorktreePath: z.string().min(1).nullable(),
  retainedBranch: z.string().min(1).nullable(),
  retainedRunId: z.string().min(1).nullable(),
  retainedHeadSha: z.string().min(1).nullable(),
});
export type ExecutionBudgetStatus = z.infer<typeof executionBudgetStatusSchema>;

export const budgetGrantRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  scopeId: z.string().min(1),
  deliveryId: z.string().min(1),
  workId: z.string().min(1),
  gateProfile: planGateProfileSchema,
  amount: z.number().int().positive(),
  reason: z.string().min(1),
  actor: z.string().min(1),
  commandRequestId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type BudgetGrantRecord = z.infer<typeof budgetGrantRecordSchema>;
export const budgetGrantListSchema = z.array(budgetGrantRecordSchema);
export type BudgetGrantList = z.infer<typeof budgetGrantListSchema>;

export const budgetGrantSubmissionSchema = z
  .object({
    amount: z.number().int().positive().max(1000),
    reason: z.string().min(1).max(2000),
    actor: z.string().min(1).max(200),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .strict();
export type BudgetGrantSubmission = z.infer<typeof budgetGrantSubmissionSchema>;

export const budgetGrantResultSchema = z.object({
  grant: budgetGrantRecordSchema,
  budget: executionBudgetStatusSchema,
  replayed: z.boolean(),
  commandRequestId: z.string().min(1),
});
export type BudgetGrantResult = z.infer<typeof budgetGrantResultSchema>;

export const executionControlActionSchema = z.enum(["hold", "resume", "stop", "takeover"]);
export type ExecutionControlAction = z.infer<typeof executionControlActionSchema>;

export const executionControlStatusSchema = z.enum(["active", "held", "stopping", "stopped"]);
export type ExecutionControlStatus = z.infer<typeof executionControlStatusSchema>;

export const executionControlSubmissionSchema = z
  .object({
    action: executionControlActionSchema,
    actor: z.string().min(1).max(200),
    reason: z.string().min(1).max(2000).optional(),
    signal: z.enum(["SIGTERM", "SIGKILL"]).optional(),
    expected_ownership_generation: z.number().int().positive().optional(),
  })
  .strict();
export type ExecutionControlSubmission = z.infer<typeof executionControlSubmissionSchema>;

export const executionControlStateSchema = z.object({
  status: executionControlStatusSchema,
  reason: z.string().nullable(),
  actor: z.string().nullable(),
  commandRequestId: z.string().nullable(),
  stopSignal: z.string().nullable(),
  stopRequestedAt: z.number().int().nonnegative().nullable(),
  stoppedAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type ExecutionControlState = z.infer<typeof executionControlStateSchema>;

export const executionProcessStateSchema = z.object({
  ownerPid: z.number().int().positive().nullable(),
  ownerAlive: z.boolean(),
  workerPid: z.number().int().positive().nullable(),
  workerPgid: z.number().int().positive().nullable(),
  workerAlive: z.boolean(),
  worktreeLockPid: z.number().int().positive().nullable(),
  worktreeLockAlive: z.boolean(),
});
export type ExecutionProcessState = z.infer<typeof executionProcessStateSchema>;

export const executionControlResultSchema = z.object({
  run: planDispatchRunSchema,
  control: executionControlStateSchema,
  budget: executionBudgetStatusSchema.nullable(),
  confirmed: z.boolean(),
  commandRequestId: z.string().min(1),
  detail: z.string(),
});
export type ExecutionControlResult = z.infer<typeof executionControlResultSchema>;

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
  work: workRecordSchema.nullable().optional(),
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

export const projectMonitorStatusSchema = z.object({
  project_id: z.string().min(1),
  state: z.enum(["idle", "running", "held", "skipped", "completed", "error"]),
  reason: z.string(),
  checked_at: z.string().nullable(),
  next_check_at: z.string().nullable(),
  pending_wake: z.boolean().optional(),
  run_id: z.string().optional(),
  run_status: z.string().optional(),
  error: z.string().optional(),
  tick: z
    .object({
      action: z.enum(["launched", "skipped"]),
      reason: z.string(),
      targetIssueNumber: z.number().int().positive().optional(),
      runId: z.string().optional(),
      activeLapsCount: z.number().int().nonnegative(),
      admittedIssuesCount: z.number().int().nonnegative().optional(),
      detail: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  triage: z
    .object({
      state: z.enum(["idle", "running", "completed", "skipped", "error"]),
      reason: z.string().optional(),
      checked_at: z.string().nullable().optional(),
      processed_count: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    })
    .optional(),
});
export type ProjectTriageStatus = NonNullable<ProjectMonitorStatus["triage"]>;
export type ProjectMonitorStatus = z.infer<typeof projectMonitorStatusSchema>;

export const monitoringStatusSchema = z.object({
  enabled: z.boolean(),
  stopping: z.boolean(),
  interval_ms: z.number().int().positive(),
  error: z.string().nullable(),
  projects: z.array(projectMonitorStatusSchema),
});
export type MonitoringStatus = z.infer<typeof monitoringStatusSchema>;

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
  target_path: z.string().min(1).optional(),
});
export type ProjectRegistrationGithubClone = z.infer<typeof projectRegistrationGithubCloneSchema>;

export const projectRegistrationGithubCreateSchema = z.object({
  method: z.literal("github_create"),
  name: z.string().min(1),
  repo: z.string().min(1),
  target_path: z.string().min(1).optional(),
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

// Workspace backup/restore (#164)
export const backupSnapshotStatusSchema = z.enum(["complete", "failed"]);
export type BackupSnapshotStatus = z.infer<typeof backupSnapshotStatusSchema>;

export const backupSnapshotRecordSchema = z.object({
  id: z.string().min(1),
  destinationPath: z.string().min(1),
  manifestVersion: z.number().int().positive(),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  databaseSizeBytes: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  status: backupSnapshotStatusSchema,
  createdBy: z.string().min(1),
  error: z.string().nullable(),
  verifiedAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
});
export type BackupSnapshotRecord = z.infer<typeof backupSnapshotRecordSchema>;

export const backupCreateSubmissionSchema = z.object({
  destinationPath: z.string().min(1).max(4096),
  actor: z.string().min(1).max(200).optional(),
});
export type BackupCreateSubmission = z.infer<typeof backupCreateSubmissionSchema>;

export const backupCreateResultSchema = z.object({
  snapshot: backupSnapshotRecordSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactCount: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  destinationPath: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type BackupCreateResult = z.infer<typeof backupCreateResultSchema>;

export const backupCredentialNoticeSchema = z.object({
  included: z.literal(false),
  reconfigurationRequired: z.array(z.string().min(1)),
  note: z.string().min(1),
});
export type BackupCredentialNotice = z.infer<typeof backupCredentialNoticeSchema>;

export const backupStatusSchema = z.object({
  lastBackup: backupSnapshotRecordSchema.nullable(),
  restorable: z.boolean(),
  reasons: z.array(z.string()),
  artifactCount: z.number().int().nonnegative(),
  credentials: backupCredentialNoticeSchema,
  sameDiskWarning: z.string().min(1),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const restoreCreateSubmissionSchema = z.object({
  sourcePath: z.string().min(1).max(4096),
  targetStateDir: z.string().min(1).max(4096),
  targetHome: z.string().min(1).max(4096).optional(),
  actor: z.string().min(1).max(200).optional(),
});
export type RestoreCreateSubmission = z.infer<typeof restoreCreateSubmissionSchema>;

export const restoreStatusSchema = z.enum(["completed", "failed"]);
export type RestoreStatus = z.infer<typeof restoreStatusSchema>;

export const restoreOperationRecordSchema = z.object({
  id: z.string().min(1),
  sourcePath: z.string().min(1),
  targetStateDir: z.string().min(1),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: restoreStatusSchema,
  report: z.record(z.string(), z.unknown()),
  createdAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
});
export type RestoreOperationRecord = z.infer<typeof restoreOperationRecordSchema>;

export const installationHoldSchema = z.object({
  held: z.boolean(),
  status: z.enum(["held", "reconciled"]).nullable(),
  reason: z.string().nullable(),
  sourceRestoreId: z.string().nullable(),
  restoredAt: z.number().int().nonnegative().nullable(),
  reconciledAt: z.number().int().nonnegative().nullable(),
  /** Verified release record; null until a hold is released through reconciliation. */
  reconciliation: z.record(z.string(), z.unknown()).nullable(),
});
export type InstallationHold = z.infer<typeof installationHoldSchema>;

export const restoreRunFactSchema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  issueNumber: z.number().int().positive().nullable(),
  state: z.string().min(1),
  branch: z.string(),
  worktreePath: z.string(),
  worktreePresent: z.boolean(),
  ownerPidCleared: z.boolean(),
  leaseCleared: z.boolean(),
});
export type RestoreRunFact = z.infer<typeof restoreRunFactSchema>;

export const restoreIntentFactSchema = z.object({
  intentId: z.string().min(1),
  projectId: z.string().min(1),
  kind: z.string().min(1),
  operationKey: z.string().min(1),
  state: z.enum(["queued", "attempting", "failed", "unknown"]),
  attempts: z.number().int().nonnegative(),
  /** Read-only remote observation; never inferred from intent state alone. */
  remoteObservation: z.enum(["present", "absent", "unreadable", "unverified"]),
  remoteDetail: z.string().nullable(),
});
export type RestoreIntentFact = z.infer<typeof restoreIntentFactSchema>;

export const restoreUnresolvedSchema = z.object({
  runs: z.array(restoreRunFactSchema),
  intents: z.array(restoreIntentFactSchema),
});
export type RestoreUnresolved = z.infer<typeof restoreUnresolvedSchema>;

export const restoreReleaseDispositionSchema = z.enum(["resolved", "abandoned"]);
export type RestoreReleaseDisposition = z.infer<typeof restoreReleaseDispositionSchema>;

const restoreRunDispositionSchema = z.object({
  runId: z.string().min(1),
  disposition: restoreReleaseDispositionSchema,
  note: z.string().min(1).max(1000).optional(),
});

const restoreIntentDispositionSchema = z.object({
  intentId: z.string().min(1),
  disposition: restoreReleaseDispositionSchema,
  note: z.string().min(1).max(1000).optional(),
});

export const restoreCreateResultSchema = z.object({
  operation: restoreOperationRecordSchema,
  installation: installationHoldSchema,
});
export type RestoreCreateResult = z.infer<typeof restoreCreateResultSchema>;

export const restoreStatusResultSchema = z.object({
  installation: installationHoldSchema,
  lastRestore: restoreOperationRecordSchema.nullable(),
  heldRunCount: z.number().int().nonnegative(),
  pendingPublicationIntentCount: z.number().int().nonnegative(),
  /** Exact interrupted runs and pending/unknown external intents that block release. */
  unresolved: restoreUnresolvedSchema,
});
export type RestoreStatusResult = z.infer<typeof restoreStatusResultSchema>;

export const restoreReconcileSubmissionSchema = z.object({
  actor: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
  /** Fence to the exact held installation snapshot; a newer restore invalidates this. */
  snapshot: z.object({
    sourceRestoreId: z.string().min(1),
    restoredAt: z.number().int().nonnegative(),
  }),
  runs: z.array(restoreRunDispositionSchema),
  intents: z.array(restoreIntentDispositionSchema),
});
export type RestoreReconcileSubmission = z.infer<typeof restoreReconcileSubmissionSchema>;

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
  primitive: z.literal("animus-implement"),
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

// ---------------------------------------------------------------------------
// Candidate-bound execution observations, findings and finalized artifacts
// ---------------------------------------------------------------------------

/** Bumped whenever the gate-profile definition changes; older observations stop authorizing acceptance. */
export const GATE_PROFILE_VERSION = 2;

export const executionStageSchema = z.enum([
  "builder_execution",
  "technical_checks",
  "independent_review",
  "final_acceptance",
]);
export type ExecutionStage = z.infer<typeof executionStageSchema>;

export const executionObservationStatusSchema = z.enum([
  "running",
  "passed",
  "failed",
  "inconclusive",
  "interrupted",
]);
export type ExecutionObservationStatus = z.infer<typeof executionObservationStatusSchema>;

export const executionCheckKindSchema = z.enum([
  "contract",
  "acceptance",
  "review",
  "regression",
  "remote_ci",
]);
export type ExecutionCheckKind = z.infer<typeof executionCheckKindSchema>;

export const executionCheckSubmissionSchema = z.object({
  name: z.string().min(1).max(200),
  command: z.string().max(4000),
  result: checkResultSchema,
  kind: executionCheckKindSchema.default("contract"),
  criterionKey: z.string().min(1).max(200).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  detail: z.string().max(8000).optional(),
  artifactPath: z.string().min(1).max(1000).optional(),
});
export type ExecutionCheckSubmission = z.infer<typeof executionCheckSubmissionSchema>;

export const findingSeveritySchema = z.enum(["blocking", "conditional"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const findingSubmissionSchema = z.object({
  severity: findingSeveritySchema,
  acKey: z.string().min(1).max(200).optional(),
  fileContext: z.string().min(1).max(4000),
  summary: z.string().min(1).max(8000),
  workId: z.string().min(1).optional(),
});
export type FindingSubmission = z.infer<typeof findingSubmissionSchema>;

export const artifactOwnerTypeSchema = z.enum(["observation", "finding"]);
export type ArtifactOwnerType = z.infer<typeof artifactOwnerTypeSchema>;

export const artifactSubmissionSchema = z.object({
  ownerType: artifactOwnerTypeSchema,
  /** Index into this submission's findings when ownerType is "finding". */
  ownerFindingIndex: z.number().int().nonnegative().optional(),
  name: z.string().min(1).max(200),
  relativePath: z.string().min(1).max(1000),
  mediaType: z.string().min(1).max(200),
});
export type ArtifactSubmission = z.infer<typeof artifactSubmissionSchema>;

export const executionObservationSubmissionSchema = z.object({
  stage: executionStageSchema,
  status: executionObservationStatusSchema,
  producer: producerIdentitySchema,
  checks: z.array(executionCheckSubmissionSchema).default([]),
  findings: z.array(findingSubmissionSchema).default([]),
  artifacts: z.array(artifactSubmissionSchema).default([]),
});
export type ExecutionObservationSubmission = z.infer<typeof executionObservationSubmissionSchema>;
export type ExecutionObservationSubmissionInput = z.input<
  typeof executionObservationSubmissionSchema
>;

// Public HTTP writer: identity is proven by a durable credential minted by the
// trusted backend boundary, never by caller-supplied producer strings.
export const executionObservationRequestSchema = z
  .object({
    run_id: z.string().min(1),
    producer_credential: z.string().min(1).max(500),
    stage: executionStageSchema,
    status: executionObservationStatusSchema,
    checks: z.array(executionCheckSubmissionSchema).default([]),
    findings: z.array(findingSubmissionSchema).default([]),
    artifacts: z.array(artifactSubmissionSchema).default([]),
  })
  .strict();
export type ExecutionObservationRequest = z.infer<typeof executionObservationRequestSchema>;
export type ExecutionObservationRequestInput = z.input<typeof executionObservationRequestSchema>;

export const findingEventActionSchema = z.enum([
  "opened",
  "fix_submitted",
  "recheck_passed",
  "recheck_failed",
  "recheck_inconclusive",
]);
export type FindingEventAction = z.infer<typeof findingEventActionSchema>;

export const executionCheckRecordSchema = z.object({
  id: z.string().min(1),
  observationId: z.string().min(1),
  name: z.string().min(1),
  command: z.string(),
  result: checkResultSchema,
  kind: executionCheckKindSchema,
  criterionKey: z.string().min(1).max(200).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  detail: z.string().nullable(),
  artifactPath: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type ExecutionCheckRecord = z.infer<typeof executionCheckRecordSchema>;

export const executionArtifactRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  observationId: z.string().min(1),
  ownerType: artifactOwnerTypeSchema,
  ownerId: z.string().min(1),
  name: z.string().min(1),
  relativePath: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  digestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
});
export type ExecutionArtifactRecord = z.infer<typeof executionArtifactRecordSchema>;

export const findingEventRecordSchema = z.object({
  id: z.string().min(1),
  findingId: z.string().min(1),
  sequence: z.number().int().positive(),
  action: findingEventActionSchema,
  actor: z.string().min(1),
  actorRole: producerRoleSchema,
  observationId: z.string().min(1).nullable(),
  detail: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type FindingEventRecord = z.infer<typeof findingEventRecordSchema>;

export const factoryFindingRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  runId: z.string().min(1),
  workId: z.string().min(1).nullable(),
  issueNumber: z.number().int().positive(),
  acKey: z.string().min(1).nullable(),
  severity: findingSeveritySchema,
  fileContext: z.string().min(1),
  summary: z.string().min(1),
  originObservationId: z.string().min(1),
  status: z.enum(["open", "resolved"]),
  createdAt: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nonnegative().nullable(),
  events: z.array(findingEventRecordSchema),
});
export type FactoryFindingRecord = z.infer<typeof factoryFindingRecordSchema>;

export const executionObservationRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  runId: z.string().min(1),
  lap: z.number().int().positive(),
  attemptKey: z.string().min(1),
  stage: executionStageSchema,
  status: executionObservationStatusSchema,
  candidateHeadSha: z.string().min(1),
  targetTipSha: z.string().min(1),
  mergeBaseSha: z.string().min(1),
  testedIdentity: z.string().min(1),
  integrationLineage: z.string().min(1),
  producer: producerIdentitySchema,
  gateProfile: planGateProfileSchema,
  gateProfileVersion: z.number().int().positive(),
  error: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  checks: z.array(executionCheckRecordSchema),
  artifacts: z.array(executionArtifactRecordSchema),
});
export type ExecutionObservationRecord = z.infer<typeof executionObservationRecordSchema>;

export const acceptanceDecisionSchema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  gateProfile: planGateProfileSchema,
  candidateHeadSha: z.string().nullable(),
  targetTipSha: z.string().nullable(),
  mergeBaseSha: z.string().nullable(),
  integrationLineage: z.string(),
  authorized: z.boolean(),
  reasons: z.array(z.string()),
  builderObservationId: z.string().min(1).nullable(),
  independentObservationId: z.string().min(1).nullable(),
  openBlockingFindingIds: z.array(z.string().min(1)),
  verifiedArtifactIds: z.array(z.string().min(1)),
});
export type AcceptanceDecision = z.infer<typeof acceptanceDecisionSchema>;

export const runEvidenceReportSchema = z.object({
  observations: z.array(executionObservationRecordSchema),
  findings: z.array(factoryFindingRecordSchema),
  acceptance: acceptanceDecisionSchema,
});
export type RunEvidenceReport = z.infer<typeof runEvidenceReportSchema>;

// ---------------------------------------------------------------------------
// Full-delivery gate and verified remote merge (standalone/final profiles)
// ---------------------------------------------------------------------------

export const deliveryGateStateSchema = z.enum([
  "blocked",
  "correction_required",
  "awaiting_publication",
  "ready_for_operator_review",
  "awaiting_manual_merge",
  "awaiting_merge_verification",
  "closed_unmerged",
  "invalidated",
  "remote_unavailable",
  "delivered",
]);
export type DeliveryGateState = z.infer<typeof deliveryGateStateSchema>;

export const deliveryGateStageStatusSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
  "running",
  "missing",
  "stale",
  "not_applicable",
]);
export type DeliveryGateStageStatus = z.infer<typeof deliveryGateStageStatusSchema>;

export const deliveryGateStageSchema = z.object({
  name: z.string().min(1),
  status: deliveryGateStageStatusSchema,
  detail: z.string(),
  observationId: z.string().min(1).nullable(),
});
export type DeliveryGateStage = z.infer<typeof deliveryGateStageSchema>;

export const deliveryMergeStateSchema = z.enum([
  "not_merged",
  "closed_unmerged",
  "unverified",
  "verified",
  "remote_unavailable",
]);
export type DeliveryMergeState = z.infer<typeof deliveryMergeStateSchema>;

export const deliveryMergeVerificationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  planId: z.string().min(1),
  workId: z.string().min(1),
  runId: z.string().min(1),
  gateProfile: z.enum(["standalone", "final"]),
  targetId: z.string().min(1),
  pullRequestId: z.string().min(1),
  repository: z.string().min(1),
  prNumber: z.number().int().positive(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  candidateHeadSha: z.string().min(1),
  remoteHeadRefOid: z.string().min(1),
  remoteTargetTipSha: z.string().min(1),
  mergeCommitSha: z.string().min(1).nullable(),
  verifiedAt: z.number().int().nonnegative(),
  verifiedBy: z.string().min(1),
});
export type DeliveryMergeVerification = z.infer<typeof deliveryMergeVerificationSchema>;

export const deliveryGatePublicationSchema = z.object({
  targetId: z.string().min(1).nullable(),
  state: z
    .enum(["no_candidate", "ready", "publishing", "published", "failed", "unknown"])
    .nullable(),
  auditComplete: z.boolean(),
  pullRequestId: z.string().min(1).nullable(),
  prNumber: z.number().int().positive().nullable(),
  url: z.string().min(1).nullable(),
  headBranch: z.string().min(1).nullable(),
  baseBranch: z.string().min(1).nullable(),
  remoteState: z.enum(["open", "closed", "merged", "unknown"]).nullable(),
  draft: z.boolean().nullable(),
  headRefOid: z.string().min(1).nullable(),
  mergeCommitOid: z.string().min(1).nullable(),
});
export type DeliveryGatePublication = z.infer<typeof deliveryGatePublicationSchema>;

export const deliveryGateMergeSchema = z.object({
  state: deliveryMergeStateSchema,
  verified: z.boolean(),
  verification: deliveryMergeVerificationSchema.nullable(),
  remoteTargetTipSha: z.string().min(1).nullable(),
  detail: z.string().nullable(),
});
export type DeliveryGateMerge = z.infer<typeof deliveryGateMergeSchema>;

export const deliveryGateStatusSchema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  planId: z.string().min(1),
  workId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  gateProfile: planGateProfileSchema,
  mergePolicy: dispatchMergePolicySchema,
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  candidateHeadSha: z.string().min(1).nullable(),
  targetTipSha: z.string().min(1).nullable(),
  mergeBaseSha: z.string().min(1).nullable(),
  integrationLineage: z.string().min(1),
  gateProfileVersion: z.number().int().positive(),
  state: deliveryGateStateSchema,
  reasons: z.array(z.string()),
  stages: z.array(deliveryGateStageSchema),
  acceptance: acceptanceDecisionSchema,
  publication: deliveryGatePublicationSchema,
  merge: deliveryGateMergeSchema,
  manualMergeRequired: z.boolean(),
});
export type DeliveryGateStatus = z.infer<typeof deliveryGateStatusSchema>;

// ---------------------------------------------------------------------------
// Durable PR publication, per-lap audit and outgoing publication intents
// ---------------------------------------------------------------------------

export const publicationTargetStateSchema = z.enum([
  "no_candidate",
  "ready",
  "publishing",
  "published",
  "failed",
  "unknown",
]);
export type PublicationTargetState = z.infer<typeof publicationTargetStateSchema>;

export const publicationPullRequestStateSchema = z.enum(["open", "closed", "merged", "superseded"]);
export type PublicationPullRequestState = z.infer<typeof publicationPullRequestStateSchema>;

export const publicationEventKindSchema = z.enum([
  "verification_failure",
  "finding",
  "fix_submitted",
  "recheck_passed",
  "recheck_failed",
  "recheck_inconclusive",
  "verdict",
  "escalation",
]);
export type PublicationEventKind = z.infer<typeof publicationEventKindSchema>;

export const publicationEventSeveritySchema = z.enum(["blocking", "conditional", "info"]);
export type PublicationEventSeverity = z.infer<typeof publicationEventSeveritySchema>;

export const publicationIntentKindSchema = z.enum([
  "create_pr",
  "publish_event",
  "update_summary",
  "create_review",
]);
export type PublicationIntentKind = z.infer<typeof publicationIntentKindSchema>;

export const publicationIntentStateSchema = z.enum([
  "queued",
  "attempting",
  "accepted",
  "failed",
  "unknown",
  "abandoned",
]);
export type PublicationIntentState = z.infer<typeof publicationIntentStateSchema>;

export const publicationTargetSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  planId: z.string().min(1),
  workId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  gateProfile: planGateProfileSchema,
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  candidateHeadSha: z.string().min(1),
  baseSha: z.string().min(1),
  remoteSourceRef: z.string().min(1).nullable().optional(),
  remoteSourceSha: z.string().min(1).nullable().optional(),
  remoteVerifiedAt: z.number().int().nonnegative().nullable().optional(),
  state: publicationTargetStateSchema,
  activePullRequestId: z.string().min(1).nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type PublicationTarget = z.infer<typeof publicationTargetSchema>;

export const publicationPullRequestSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  projectId: z.string().min(1),
  repository: z.string().min(1).nullable().optional(),
  number: z.number().int().positive().nullable(),
  url: z.string().min(1).nullable(),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  candidateHeadSha: z.string().min(1),
  headRefOid: z.string().min(1).nullable(),
  draft: z.boolean(),
  state: publicationPullRequestStateSchema,
  active: z.boolean(),
  createdByIntent: z.string().min(1).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type PublicationPullRequest = z.infer<typeof publicationPullRequestSchema>;

export const publicationEventRecordSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  projectId: z.string().min(1),
  sequence: z.number().int().positive(),
  workId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  lap: z.number().int().positive().nullable(),
  candidateHeadSha: z.string().min(1),
  observationId: z.string().min(1).nullable(),
  findingId: z.string().min(1).nullable(),
  kind: publicationEventKindSchema,
  severity: publicationEventSeveritySchema,
  title: z.string().min(1),
  body: z.string(),
  occurredAt: z.number().int().nonnegative(),
});
export type PublicationEventRecord = z.infer<typeof publicationEventRecordSchema>;

export const publicationIntentRecordSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  projectId: z.string().min(1),
  operationKey: z.string().min(1),
  kind: publicationIntentKindSchema,
  state: publicationIntentStateSchema,
  attempts: z.number().int().nonnegative(),
  remoteObjectId: z.string().min(1).nullable(),
  remoteUrl: z.string().min(1).nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type PublicationIntentRecord = z.infer<typeof publicationIntentRecordSchema>;

export const publicationEvidenceBindingSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  projectId: z.string().min(1),
  artifactId: z.string().min(1),
  status: z.enum(["pending", "supplied_unverified"]),
  hostedUrl: z.string().min(1).nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type PublicationEvidenceBinding = z.infer<typeof publicationEvidenceBindingSchema>;

export const publicationStatusSchema = z.object({
  target: publicationTargetSchema,
  pullRequests: z.array(publicationPullRequestSchema),
  events: z.array(publicationEventRecordSchema),
  intents: z.array(publicationIntentRecordSchema),
  evidence: z.array(publicationEvidenceBindingSchema),
  summary: z.string().nullable(),
  queuedEventCount: z.number().int().nonnegative(),
  publishedEventCount: z.number().int().nonnegative(),
  failedIntentCount: z.number().int().nonnegative(),
  unknownIntentCount: z.number().int().nonnegative(),
  auditComplete: z.boolean(),
  remoteObservedAt: z.number().int().nonnegative().nullable(),
  remoteStale: z.boolean(),
});
export type PublicationStatus = z.infer<typeof publicationStatusSchema>;
export const publicationStatusListSchema = z.array(publicationStatusSchema);
export type PublicationStatusList = z.infer<typeof publicationStatusListSchema>;

/**
 * Approved draft revision publication into real GitHub spec/ticket issues.
 *
 * This is deliberately separate from delivery PR publication: it publishes the
 * operator-approved contract graph, then hands the confirmed issue identities to
 * the same frozen plan admission as skill-prepared work. It never dispatches a
 * builder and never mutates the original report.
 */
export const draftPublicationStateSchema = z.enum([
  "pending",
  "publishing",
  "published",
  "admitted",
  "failed",
  "unknown",
]);
export type DraftPublicationState = z.infer<typeof draftPublicationStateSchema>;

export const draftPublicationMemberStateSchema = z.enum([
  "pending",
  "created",
  "verified",
  "failed",
]);
export type DraftPublicationMemberState = z.infer<typeof draftPublicationMemberStateSchema>;

export const draftPublicationRelationshipStateSchema = z.enum([
  "pending",
  "verified",
  "fallback_textual",
  "unknown",
  "failed",
]);
export type DraftPublicationRelationshipState = z.infer<
  typeof draftPublicationRelationshipStateSchema
>;

export const draftPublicationIntentKindSchema = z.enum([
  "create_issue",
  "create_issue_relationship",
  "link_source_issue",
]);
export type DraftPublicationIntentKind = z.infer<typeof draftPublicationIntentKindSchema>;

export const draftPublicationResourceKindSchema = z.enum(["issue", "relationship"]);
export type DraftPublicationResourceKind = z.infer<typeof draftPublicationResourceKindSchema>;

export const draftPublicationMemberSchema = z.object({
  id: z.string().min(1),
  publicationId: z.string().min(1),
  nodeKey: z.string().min(1),
  role: planMemberRoleSchema,
  ordinal: z.number().int().nonnegative(),
  title: z.string().min(1),
  labels: z.array(z.string()),
  issueNumber: z.number().int().positive().nullable(),
  workId: z.string().min(1).nullable(),
  state: draftPublicationMemberStateSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DraftPublicationMember = z.infer<typeof draftPublicationMemberSchema>;

export const draftPublicationRelationshipSchema = z.object({
  id: z.string().min(1),
  publicationId: z.string().min(1),
  kind: z.enum(["parent_child", "dependency"]),
  fromNodeKey: z.string().min(1),
  toNodeKey: z.string().min(1),
  fromIssueNumber: z.number().int().positive().nullable(),
  toIssueNumber: z.number().int().positive().nullable(),
  source: planDependencySourceSchema,
  state: draftPublicationRelationshipStateSchema,
  detail: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DraftPublicationRelationship = z.infer<typeof draftPublicationRelationshipSchema>;

export const draftPublicationIntentSchema = z.object({
  id: z.string().min(1),
  publicationId: z.string().min(1),
  projectId: z.string().min(1),
  operationKey: z.string().min(1),
  kind: draftPublicationIntentKindSchema,
  resourceKind: draftPublicationResourceKindSchema,
  state: publicationIntentStateSchema,
  attempts: z.number().int().nonnegative(),
  remoteObjectId: z.string().min(1).nullable(),
  remoteUrl: z.string().min(1).nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DraftPublicationIntent = z.infer<typeof draftPublicationIntentSchema>;

export const draftPublicationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  draftId: z.string().min(1),
  revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: planKindSchema,
  state: draftPublicationStateSchema,
  sourceIssueNumber: z.number().int().positive(),
  specIssueNumber: z.number().int().positive().nullable(),
  integrationBranch: z.string().min(1).nullable(),
  deliveryBranch: z.string().min(1),
  planId: z.string().min(1).nullable(),
  planAuthority: planAuthoritySchema.nullable(),
  holds: z.array(planHoldSchema),
  lastError: z.string().nullable(),
  members: z.array(draftPublicationMemberSchema),
  relationships: z.array(draftPublicationRelationshipSchema),
  intents: z.array(draftPublicationIntentSchema),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DraftPublication = z.infer<typeof draftPublicationSchema>;
export const draftPublicationListSchema = z.array(draftPublicationSchema);
export type DraftPublicationList = z.infer<typeof draftPublicationListSchema>;

export const draftPublicationSubmissionSchema = z
  .object({
    draft_id: z.string().min(1),
  })
  .strict();
export type DraftPublicationSubmission = z.infer<typeof draftPublicationSubmissionSchema>;

export const publicationEvidenceBindingRequestSchema = z
  .object({
    hosted_url: z.string().min(1).max(2000),
  })
  .strict();
export type PublicationEvidenceBindingRequest = z.infer<
  typeof publicationEvidenceBindingRequestSchema
>;

// ---------------------------------------------------------------------------
// Child gate integration: serialized auto-merge into the spec integration branch
// ---------------------------------------------------------------------------

export const integrationStateSchema = z.enum([
  "not_ready",
  "blocked",
  "ready",
  "integrating",
  "integrated",
  "unknown",
]);
export type IntegrationState = z.infer<typeof integrationStateSchema>;

export const integrationBlockReasonSchema = z.enum([
  "integration_profile_invalid",
  "integration_merge_policy_manual",
  "integration_run_not_succeeded",
  "integration_candidate_missing",
  "integration_acceptance_blocked",
  "integration_publication_missing",
  "integration_publication_incomplete",
  "integration_remote_unreadable",
  "integration_remote_binding_mismatch",
  "integration_pull_request_closed",
  "integration_ci_missing",
  "integration_ci_pending",
  "integration_ci_failed",
  "integration_target_missing",
  "integration_target_drift",
  "integration_conflict",
  "integration_merge_rejected",
  "integration_merge_unknown",
  "integration_lineage_unverified",
]);
export type IntegrationBlockReason = z.infer<typeof integrationBlockReasonSchema>;

export const integrationBlockerSchema = z.object({
  code: z.union([integrationBlockReasonSchema, z.string().min(1)]),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type IntegrationBlocker = z.infer<typeof integrationBlockerSchema>;

export const requiredCheckSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  status: z.string().min(1),
  conclusion: z.string().min(1).nullable(),
});
export type RequiredCheck = z.infer<typeof requiredCheckSchema>;

export const childIntegrationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  planId: z.string().min(1),
  workId: z.string().min(1),
  runId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  candidateHeadSha: z.string().min(1),
  baseSha: z.string().min(1),
  targetTipBeforeSha: z.string().min(1),
  targetTipAfterSha: z.string().min(1),
  mergeSha: z.string().min(1),
  remotePullRequestNumber: z.number().int().positive(),
  remotePullRequestUrl: z.string().min(1).nullable(),
  evidenceIdentity: z.string().min(1),
  integratedAt: z.number().int().nonnegative(),
});
export type ChildIntegration = z.infer<typeof childIntegrationSchema>;

export const integrationEventKindSchema = z.enum(["blocked", "merged", "reconciled"]);
export type IntegrationEventKind = z.infer<typeof integrationEventKindSchema>;

export const integrationEventSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  kind: integrationEventKindSchema,
  candidateHeadSha: z.string().min(1),
  targetTipSha: z.string().min(1),
  mergeSha: z.string().min(1).nullable(),
  reasons: z.array(z.string()),
  createdAt: z.number().int().nonnegative(),
});
export type IntegrationEvent = z.infer<typeof integrationEventSchema>;

export const integrationStatusSchema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  deliveryId: z.string().min(1),
  planId: z.string().min(1),
  workId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  gateProfile: planGateProfileSchema,
  mergePolicy: dispatchMergePolicySchema,
  targetBranch: z.string().min(1),
  state: integrationStateSchema,
  blockers: z.array(integrationBlockerSchema),
  acceptance: acceptanceDecisionSchema,
  publication: publicationStatusSchema.nullable(),
  requiredChecks: z.array(requiredCheckSchema),
  integration: childIntegrationSchema.nullable(),
  events: z.array(integrationEventSchema),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
export const integrationStatusListSchema = z.array(integrationStatusSchema);
export type IntegrationStatusList = z.infer<typeof integrationStatusListSchema>;

export const integrationLandSubmissionSchema = z
  .object({
    actor: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type IntegrationLandSubmission = z.infer<typeof integrationLandSubmissionSchema>;

export const dispatchAttemptSchema = z.object({
  runId: z.string().min(1),
  lap: z.number().int().positive(),
  ownershipGeneration: z.number().int().positive(),
  state: dispatchRunStateSchema,
  issueNumber: z.number().int().positive(),
  headSha: z.string().min(1).nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
});
export type DispatchAttempt = z.infer<typeof dispatchAttemptSchema>;

export const dispatchAcceptanceCriterionSchema = z.object({
  acKey: z.string().min(1),
  text: z.string(),
  openFindingIds: z.array(z.string().min(1)),
});
export type DispatchAcceptanceCriterion = z.infer<typeof dispatchAcceptanceCriterionSchema>;

export const dispatchRunDetailSchema = z.object({
  run: planDispatchRunSchema,
  budget: executionBudgetStatusSchema.nullable(),
  control: executionControlStateSchema.nullable(),
  grants: budgetGrantListSchema,
  attempts: z.array(dispatchAttemptSchema),
  process: executionProcessStateSchema,
  acceptanceCriteria: z.array(dispatchAcceptanceCriterionSchema),
  openFindings: z.array(factoryFindingRecordSchema),
  acceptance: acceptanceDecisionSchema,
});
export type DispatchRunDetail = z.infer<typeof dispatchRunDetailSchema>;

export const findingFixSubmissionSchema = z
  .object({
    actor: z.string().min(1).max(200),
    detail: z.string().max(8000).optional(),
  })
  .strict();
export type FindingFixSubmission = z.infer<typeof findingFixSubmissionSchema>;

export const findingFixRequestSchema = z
  .object({
    producer_credential: z.string().min(1).max(500),
    detail: z.string().max(8000).optional(),
  })
  .strict();
export type FindingFixRequest = z.infer<typeof findingFixRequestSchema>;

export const findingRecheckSubmissionSchema = z
  .object({
    producer: producerIdentitySchema,
    status: z.enum(["passed", "failed", "inconclusive"]),
    stage: executionStageSchema.optional(),
    runId: z.string().min(1).optional(),
    checks: z.array(executionCheckSubmissionSchema).default([]),
    artifacts: z.array(artifactSubmissionSchema).default([]),
    detail: z.string().max(8000).optional(),
  })
  .strict();
export type FindingRecheckSubmission = z.infer<typeof findingRecheckSubmissionSchema>;
export type FindingRecheckSubmissionInput = z.input<typeof findingRecheckSubmissionSchema>;

export const findingRecheckRequestSchema = z
  .object({
    producer_credential: z.string().min(1).max(500),
    status: z.enum(["passed", "failed", "inconclusive"]),
    stage: executionStageSchema.optional(),
    runId: z.string().min(1).optional(),
    checks: z.array(executionCheckSubmissionSchema).default([]),
    artifacts: z.array(artifactSubmissionSchema).default([]),
    detail: z.string().max(8000).optional(),
  })
  .strict();
export type FindingRecheckRequest = z.infer<typeof findingRecheckRequestSchema>;
export type FindingRecheckRequestInput = z.input<typeof findingRecheckRequestSchema>;

export const observationListSchema = z.array(executionObservationRecordSchema);
export const findingListSchema = z.array(factoryFindingRecordSchema);

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

// Post-Loop Self-Improving Harness Schemas
export const harnessLessonSchema = z.object({
  id: z.string(),
  topic: z.string(),
  trigger_patterns: z.array(z.string()),
  rule: z.string(),
  evidence: z.string(),
  vetoed: z.boolean().default(false),
  occurrence_count: z.number().int().positive().optional().default(1),
  created_at: z.string(),
});
export type HarnessLesson = z.infer<typeof harnessLessonSchema>;

export const harnessLessonsResponseSchema = z.object({
  safe_mode: z.boolean(),
  lessons: z.array(harnessLessonSchema),
});
export type HarnessLessonsResponse = z.infer<typeof harnessLessonsResponseSchema>;

export const harnessToolsResponseSchema = z.object({
  tools: z.record(z.string(), z.string()),
});
export type HarnessToolsResponse = z.infer<typeof harnessToolsResponseSchema>;

export const harnessVetoSubmissionSchema = z.object({
  id: z.string().min(1),
});
export type HarnessVetoSubmission = z.infer<typeof harnessVetoSubmissionSchema>;

export const harnessVetoResultSchema = z.object({
  ok: z.boolean(),
  id: z.string(),
  vetoed: z.boolean(),
});
export type HarnessVetoResult = z.infer<typeof harnessVetoResultSchema>;

export const webhookDeliveryStatusSchema = z.enum(["accepted", "ignored"]);
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;

export const webhookAckSchema = z.object({
  status: webhookDeliveryStatusSchema,
  delivery: z.string(),
  reason: z.string().optional(),
  project_id: z.string().optional(),
  pending_wake: z.boolean().optional(),
});
export type WebhookAck = z.infer<typeof webhookAckSchema>;

// ---------------------------------------------------------------------------
// Final-spec delivery coordination (one manifest-bound final integration PR)
// ---------------------------------------------------------------------------

export const finalDeliveryStateSchema = z.enum([
  "waiting_children",
  "blocked",
  "verifying",
  "needs_owner",
  "awaiting_manual_merge",
  "awaiting_merge_verification",
  "remote_unavailable",
  "delivered",
]);
export type FinalDeliveryState = z.infer<typeof finalDeliveryStateSchema>;

export const finalDeliveryChildSchema = z.object({
  workId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  title: z.string(),
  gateProfile: planGateProfileSchema,
  integrated: z.boolean(),
  candidateHeadSha: z.string().min(1).nullable(),
  mergeSha: z.string().min(1).nullable(),
  targetBranch: z.string().min(1).nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  pullRequestUrl: z.string().min(1).nullable(),
  reasons: z.array(z.string()),
});
export type FinalDeliveryChild = z.infer<typeof finalDeliveryChildSchema>;

export const finalDeliveryPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1).nullable(),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  headRefOid: z.string().min(1).nullable(),
  state: z.enum(["open", "closed", "merged", "superseded"]),
  draft: z.boolean(),
  mergeCommitOid: z.string().min(1).nullable(),
});
export type FinalDeliveryPullRequest = z.infer<typeof finalDeliveryPullRequestSchema>;

export const finalDeliveryStatusSchema = z.object({
  projectId: z.string().min(1),
  planId: z.string().min(1),
  deliveryId: z.string().min(1).nullable(),
  kind: z.literal("spec"),
  graphHash: z.string().min(1),
  manifestId: z.string().min(1).nullable(),
  integrationBranch: z.string().min(1),
  deliveryBranch: z.string().min(1),
  state: finalDeliveryStateSchema,
  requiredCount: z.number().int().nonnegative(),
  integratedCount: z.number().int().nonnegative(),
  delivered: z.boolean(),
  candidateHeadSha: z.string().min(1).nullable(),
  targetTipSha: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  reasons: z.array(z.string()),
  children: z.array(finalDeliveryChildSchema),
  gate: deliveryGateStatusSchema.nullable(),
  budget: executionBudgetStatusSchema.nullable(),
  grants: budgetGrantListSchema,
  pullRequest: finalDeliveryPullRequestSchema.nullable(),
  merge: deliveryGateMergeSchema.nullable(),
  haltReason: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
});
export type FinalDeliveryStatus = z.infer<typeof finalDeliveryStatusSchema>;
export const finalDeliveryStatusListSchema = z.array(finalDeliveryStatusSchema);
export type FinalDeliveryStatusList = z.infer<typeof finalDeliveryStatusListSchema>;

export const finalDeliveryAdvanceSubmissionSchema = z
  .object({
    actor: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type FinalDeliveryAdvanceSubmission = z.infer<typeof finalDeliveryAdvanceSubmissionSchema>;

export const finalDeliveryVerifySubmissionSchema = z
  .object({
    actor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type FinalDeliveryVerifySubmission = z.infer<typeof finalDeliveryVerifySubmissionSchema>;

// ---------------------------------------------------------------------------
// Operator board projection over existing kanban columns
// ---------------------------------------------------------------------------

/**
 * Canonical lane ids for the existing operator board. The projection never adds
 * columns; placement is derived from planning/dispatch/gate/landing facts with
 * the precedence order returned alongside the board.
 */
export const operatorBoardLaneIdSchema = z.enum([
  "triage",
  "ready",
  "working",
  "approval",
  "needs-owner",
  "parked",
  "merged",
  "failed",
]);
export type OperatorBoardLaneId = z.infer<typeof operatorBoardLaneIdSchema>;

export const operatorCardKindSchema = z.enum(["spec", "ticket", "unplanned"]);
export type OperatorCardKind = z.infer<typeof operatorCardKindSchema>;

export const operatorSpecProgressSchema = z.object({
  integrated: z.number().int().nonnegative(),
  required: z.number().int().nonnegative(),
  delivered: z.boolean(),
  finalState: finalDeliveryStateSchema.nullable(),
});
export type OperatorSpecProgress = z.infer<typeof operatorSpecProgressSchema>;

/**
 * Token/cost usage is only recorded when a canonical store has it. Local plan
 * dispatches record none, so `available: false` carries an honest reason rather
 * than fabricated zeros.
 */
export const operatorWorkerUsageSchema = z.object({
  available: z.boolean(),
  tokensIn: z.number().int().nonnegative().nullable(),
  tokensOut: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  costMicros: z.number().int().nonnegative().nullable(),
  detail: z.string().min(1),
});
export type OperatorWorkerUsage = z.infer<typeof operatorWorkerUsageSchema>;

export const operatorBoardProcessSchema = z.object({
  ownerPid: z.number().int().positive().nullable(),
  ownerAlive: z.boolean(),
  workerPid: z.number().int().positive().nullable(),
  workerAlive: z.boolean(),
  worktreeLockPid: z.number().int().positive().nullable(),
  worktreeLockAlive: z.boolean(),
});
export type OperatorBoardProcess = z.infer<typeof operatorBoardProcessSchema>;

export const operatorBoardParentSchema = z.object({
  workId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  title: z.string().min(1),
});
export type OperatorBoardParent = z.infer<typeof operatorBoardParentSchema>;

export const operatorBoardRunSchema = z.object({
  id: z.string().min(1),
  lap: z.number().int().positive(),
  state: dispatchRunStateSchema,
  headSha: z.string().min(1).nullable(),
  error: z.string().nullable(),
});
export type OperatorBoardRun = z.infer<typeof operatorBoardRunSchema>;

export const operatorBoardPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1).nullable(),
  state: publicationPullRequestStateSchema,
  draft: z.boolean(),
});
export type OperatorBoardPullRequest = z.infer<typeof operatorBoardPullRequestSchema>;

export const operatorBoardCardSchema = z.object({
  id: z.string().min(1),
  kind: operatorCardKindSchema,
  lane: operatorBoardLaneIdSchema,
  workId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  title: z.string().min(1),
  ref: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
  role: planMemberRoleSchema.nullable(),
  gateProfile: planGateProfileSchema.nullable(),
  planId: z.string().min(1).nullable(),
  planKind: planKindSchema.nullable(),
  parent: operatorBoardParentSchema.nullable(),
  stageLabel: z.string().min(1),
  detail: z.string(),
  precedence: z.array(z.string().min(1)),
  specProgress: operatorSpecProgressSchema.nullable(),
  latestRun: operatorBoardRunSchema.nullable(),
  budgetStatus: z.enum(["active", "exhausted"]).nullable(),
  controlStatus: executionControlStatusSchema.nullable(),
  integrationState: integrationStateSchema.nullable(),
  gateState: deliveryGateStateSchema.nullable(),
  finalState: finalDeliveryStateSchema.nullable(),
  pullRequest: operatorBoardPullRequestSchema.nullable(),
  process: operatorBoardProcessSchema.nullable(),
  usage: operatorWorkerUsageSchema,
});
export type OperatorBoardCard = z.infer<typeof operatorBoardCardSchema>;

export const operatorBoardCountsSchema = z.object({
  /** Parent specifications. */
  specs: z.number().int().nonnegative(),
  /** Executable planned tickets (child tickets plus standalone tickets). */
  tickets: z.number().int().nonnegative(),
  /** Imported work that is not part of any approved plan. */
  unplanned: z.number().int().nonnegative(),
  /** Distinct active workers with a live owner/worker process. */
  workers: z.number().int().nonnegative(),
  /** Configured parallel capacity. */
  capacity: z.number().int().positive(),
});
export type OperatorBoardCounts = z.infer<typeof operatorBoardCountsSchema>;

export const operatorBoardLaneSchema = z.object({
  id: operatorBoardLaneIdSchema,
  count: z.number().int().nonnegative(),
  cards: z.array(operatorBoardCardSchema),
});
export type OperatorBoardLane = z.infer<typeof operatorBoardLaneSchema>;

export const operatorBoardSchema = z.object({
  projectId: z.string().min(1),
  repository: z.string().min(1),
  generatedAt: z.number().int().nonnegative(),
  precedence: z.array(z.string().min(1)),
  counts: operatorBoardCountsSchema,
  lanes: z.array(operatorBoardLaneSchema),
  usage: operatorWorkerUsageSchema,
});
export type OperatorBoard = z.infer<typeof operatorBoardSchema>;

export const operatorWorkDetailSchema = z.object({
  projectId: z.string().min(1),
  generatedAt: z.number().int().nonnegative(),
  work: workRecordSchema,
  kind: operatorCardKindSchema,
  lane: operatorBoardLaneIdSchema,
  stageLabel: z.string().min(1),
  detail: z.string(),
  precedence: z.array(z.string().min(1)),
  role: planMemberRoleSchema.nullable(),
  planId: z.string().min(1).nullable(),
  planKind: planKindSchema.nullable(),
  parent: operatorBoardParentSchema.nullable(),
  specProgress: operatorSpecProgressSchema.nullable(),
  contract: z.object({
    title: z.string().min(1),
    body: z.string(),
    labels: z.array(z.string()),
    state: z.enum(["OPEN", "CLOSED"]),
    revisionNumber: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceUrl: z.string().min(1),
  }),
  plan: planRecordSchema.nullable(),
  final: finalDeliveryStatusSchema.nullable(),
  runs: z.array(planDispatchRunSchema),
  latestRun: dispatchRunDetailSchema.nullable(),
  evidence: runEvidenceReportSchema.nullable(),
  integration: integrationStatusSchema.nullable(),
  gate: deliveryGateStatusSchema.nullable(),
  publication: publicationStatusSchema.nullable(),
  retained: z
    .object({
      worktreePath: z.string().min(1),
      branch: z.string().min(1),
      runId: z.string().min(1).nullable(),
      headSha: z.string().min(1).nullable(),
    })
    .nullable(),
  process: operatorBoardProcessSchema.nullable(),
  usage: operatorWorkerUsageSchema,
});
export type OperatorWorkDetail = z.infer<typeof operatorWorkDetailSchema>;
