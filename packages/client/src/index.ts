import {
  healthSchema,
  monitoringStatusSchema,
  type MonitoringStatus,
  diagnosticsSchema,
  workflowCatalogSchema,
  lapListSchema,
  lapDetailSchema,
  launchSubmissionSchema,
  launchAckSchema,
  intakeResultSchema,
  evaluatedIssueSchema,
  controlStateSchema,
  controlSubmissionSchema,
  lapEvidenceSchema,
  promotionStatusSchema,
  promotionSubmissionSchema,
  promotionResultSchema,
  operatorErrorSchema,
  projectSchema,
  projectListSchema,
  projectRegistrationSchema,
  projectRetargetSchema,
  deregisterResultSchema,
  commandStateSchema,
  commandProvenanceSchema,
  commandOutcomeSchema,
  commandRecordSchema,
  commandListSchema,
  commandSubmissionSchema,
  commandReconciliationResultSchema,
  globalBrakeStateSchema,
  projectBrakeStateSchema,
  brakeSubmissionSchema,
  projectBrakeSubmissionSchema,
  backupSubmissionSchema,
  backupResultSchema,
  labelEffectsSchema,
  admissionPreviewSchema,
  intakePreviewSubmissionSchema,
  intakePreviewResultSchema,
  intakePublishSubmissionSchema,
  intakePublishResultSchema,
  intakeUpdateSubmissionSchema,
  targetBindingSubmissionSchema,
  targetBindingResultSchema,
  branchIntegrationSubmissionSchema,
  branchIntegrationResultSchema,
  specCoordinationPlanSchema,
  targetedImplementResultSchema,
  coordinationFinalPrResultSchema,
  coordinationFinalPrSubmissionSchema,
  candidateVerificationRecordSchema,
  candidateVerificationSubmissionSchema,
  landingGuardResultSchema,
  landingSubmissionSchema,
  landingExecutionResultSchema,
  consequentialActionTypeSchema,
  type ConsequentialActionType,
  tieredActionSubmissionSchema,
  tieredActionResultSchema,
  runCancellationSubmissionSchema,
  runCancellationResultSchema,
  gateApprovalSubmissionSchema,
  gateApprovalRecordSchema,
  releaseReadinessResultSchema,
  sanitizedReportSchema,
  wsSubscriptionMessageSchema,
  wsEventTypeSchema,
  wsEventSchema,
  type WsSubscriptionMessage,
  type WsEventType,
  type WsEvent,
  type CandidateVerificationRecord,
  type CandidateVerificationSubmission,
  type LandingGuardResult,
  type LandingSubmission,
  type LandingExecutionResult,
  type TieredActionSubmission,
  type TieredActionResult,
  type RunCancellationSubmission,
  type RunCancellationResult,
  type GateApprovalSubmission,
  type GateApprovalRecord,
  type ReleaseReadinessResult,
  type SanitizedReport,
  type SpecCoordinationPlan,
  type TargetedImplementResult,
  type CoordinationFinalPrResult,
  type CoordinationFinalPrSubmission,
  type Health,
  type Diagnostics,
  type WorkflowCatalog,
  type LapList,
  type LapDetail,
  type LapEvidence,
  type PromotionStatus,
  type PromotionSubmission,
  type PromotionResult,
  type LaunchSubmission,
  type LaunchAck,
  type IntakeResult,
  type EvaluatedIssue,
  type ControlState,
  type ControlAction,
  type OperatorErrorCode,
  type Project,
  type ProjectList,
  type ProjectRegistration,
  type ProjectRetarget,
  type DeregisterResult,
  type ProjectStatus,
  type CommandState,
  type CommandProvenance,
  type CommandOutcome,
  type CommandRecord,
  type CommandList,
  type CommandSubmission,
  type CommandReconciliationResult,
  type GlobalBrakeState,
  type ProjectBrakeState,
  type BrakeSubmission,
  type ProjectBrakeSubmission,
  type BackupSubmission,
  type BackupResult,
  type LabelEffects,
  type AdmissionPreview,
  type IntakePreviewSubmission,
  type IntakePreviewResult,
  type IntakePublishSubmission,
  type IntakePublishResult,
  type IntakeUpdateSubmission,
  type TargetBindingSubmission,
  type TargetBindingResult,
  type BranchIntegrationSubmission,
  type BranchIntegrationResult,
} from "@labq/contracts/operator";

export {
  projectSchema,
  projectListSchema,
  projectRegistrationSchema,
  projectRetargetSchema,
  deregisterResultSchema,
  commandStateSchema,
  commandProvenanceSchema,
  commandOutcomeSchema,
  commandRecordSchema,
  commandListSchema,
  commandSubmissionSchema,
  commandReconciliationResultSchema,
  globalBrakeStateSchema,
  projectBrakeStateSchema,
  brakeSubmissionSchema,
  projectBrakeSubmissionSchema,
  backupSubmissionSchema,
  backupResultSchema,
  labelEffectsSchema,
  admissionPreviewSchema,
  intakePreviewSubmissionSchema,
  intakePreviewResultSchema,
  intakePublishSubmissionSchema,
  intakePublishResultSchema,
  intakeUpdateSubmissionSchema,
  targetBindingSubmissionSchema,
  targetBindingResultSchema,
  branchIntegrationSubmissionSchema,
  branchIntegrationResultSchema,
  type Project,
  type ProjectList,
  type ProjectRegistration,
  type ProjectRetarget,
  type DeregisterResult,
  type ProjectStatus,
  type CommandState,
  type CommandProvenance,
  type CommandOutcome,
  type CommandRecord,
  type CommandList,
  type CommandSubmission,
  type CommandReconciliationResult,
  type GlobalBrakeState,
  type ProjectBrakeState,
  type BrakeSubmission,
  type ProjectBrakeSubmission,
  type BackupSubmission,
  type BackupResult,
  type LabelEffects,
  type AdmissionPreview,
  type IntakePreviewSubmission,
  type IntakePreviewResult,
  type IntakePublishSubmission,
  type IntakePublishResult,
  type IntakeUpdateSubmission,
  type TargetBindingSubmission,
  type TargetBindingResult,
  type BranchIntegrationSubmission,
  type BranchIntegrationResult,
  consequentialActionTypeSchema,
  type ConsequentialActionType,
  type EvaluatedIssue,
  type SpecCoordinationPlan,
  type TieredActionSubmission,
  type TieredActionResult,
  wsSubscriptionMessageSchema,
  wsEventTypeSchema,
  wsEventSchema,
  type WsSubscriptionMessage,
  type WsEventType,
  type WsEvent,
};

export {
  BoundedRingBuffer,
  WebSocketConnectionManager,
  createWebSocketManager,
  type ConnectionStatus,
  type WebSocketLike,
  type WebSocketManagerOptions,
} from "./ws";

export type FactoryErrorCode =
  | OperatorErrorCode
  | "transport_unavailable"
  | "invalid_operator_response";

export class FactoryClientError extends Error {
  constructor(public readonly code: FactoryErrorCode) {
    super(code);
    this.name = "FactoryClientError";
  }
}

export function createFactoryClient(options: {
  baseUrl: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}) {
  const transport = options.fetch ?? globalThis.fetch;

  async function getJson<T>(
    path: string,
    schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } },
  ): Promise<T> {
    const endpoint = new URL(path, options.baseUrl).href;
    let response: Response;
    try {
      response = await transport(endpoint, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new FactoryClientError("transport_unavailable");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FactoryClientError("invalid_operator_response");
    }

    if (!response.ok) {
      const error = operatorErrorSchema.safeParse(body);
      throw new FactoryClientError(error.success ? error.data.error : "invalid_operator_response");
    }

    const result = schema.safeParse(body);
    if (!result.success) throw new FactoryClientError("invalid_operator_response");
    return result.data;
  }

  async function postJson<T>(
    path: string,
    payload: unknown,
    schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } },
  ): Promise<T> {
    const endpoint = new URL(path, options.baseUrl).href;
    let response: Response;
    try {
      response = await transport(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new FactoryClientError("transport_unavailable");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FactoryClientError("invalid_operator_response");
    }

    if (!response.ok) {
      const error = operatorErrorSchema.safeParse(body);
      throw new FactoryClientError(error.success ? error.data.error : "invalid_operator_response");
    }

    const result = schema.safeParse(body);
    if (!result.success) throw new FactoryClientError("invalid_operator_response");
    return result.data;
  }

  async function deleteJson<T>(
    path: string,
    schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } },
  ): Promise<T> {
    const endpoint = new URL(path, options.baseUrl).href;
    let response: Response;
    try {
      response = await transport(endpoint, {
        method: "DELETE",
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new FactoryClientError("transport_unavailable");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FactoryClientError("invalid_operator_response");
    }

    if (!response.ok) {
      const error = operatorErrorSchema.safeParse(body);
      throw new FactoryClientError(error.success ? error.data.error : "invalid_operator_response");
    }

    const result = schema.safeParse(body);
    if (!result.success) throw new FactoryClientError("invalid_operator_response");
    return result.data;
  }

  return {
    async health(): Promise<Health> {
      return getJson("/api/v1/health", healthSchema);
    },
    async diagnostics(): Promise<Diagnostics> {
      return getJson("/api/v1/diagnostics", diagnosticsSchema);
    },
    async catalog(): Promise<WorkflowCatalog> {
      return getJson("/api/v1/catalog", workflowCatalogSchema);
    },
    async laps(): Promise<LapList> {
      return getJson("/api/v1/laps", lapListSchema);
    },
    async lap(id: string): Promise<LapDetail> {
      return getJson(`/api/v1/laps/${encodeURIComponent(id)}`, lapDetailSchema);
    },
    async launch(submission: LaunchSubmission): Promise<LaunchAck> {
      const parsed = launchSubmissionSchema.safeParse(submission);
      if (!parsed.success) throw new FactoryClientError("invalid_payload");
      return postJson("/api/v1/laps", parsed.data, launchAckSchema);
    },
    async intake(options?: { refresh?: boolean }): Promise<IntakeResult> {
      const path = options?.refresh ? "/api/v1/intake?refresh=true" : "/api/v1/intake";
      return getJson(path, intakeResultSchema);
    },
    async issue(number: number): Promise<EvaluatedIssue> {
      return getJson(`/api/v1/intake/${encodeURIComponent(number)}`, evaluatedIssueSchema);
    },
    async controlState(): Promise<ControlState> {
      return getJson("/api/v1/controls", controlStateSchema);
    },
    async control(action: ControlAction): Promise<ControlState> {
      const parsed = controlSubmissionSchema.safeParse({ action });
      if (!parsed.success) throw new FactoryClientError("invalid_payload");
      return postJson("/api/v1/controls", parsed.data, controlStateSchema);
    },
    async evidence(lapId: string): Promise<LapEvidence> {
      return getJson(`/api/v1/laps/${encodeURIComponent(lapId)}/evidence`, lapEvidenceSchema);
    },
    async report(lapId: string): Promise<string> {
      const endpoint = new URL(
        `/api/v1/laps/${encodeURIComponent(lapId)}/evidence/report`,
        options.baseUrl,
      ).href;
      let response: Response;
      try {
        response = await transport(endpoint, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
        });
      } catch {
        throw new FactoryClientError("transport_unavailable");
      }
      if (!response.ok) {
        let errCode: OperatorErrorCode = "report_not_found";
        try {
          const body: any = await response.json();
          if (body && typeof body.error === "string") errCode = body.error;
        } catch {}
        throw new FactoryClientError(errCode);
      }
      return response.text();
    },
    async promotionStatus(): Promise<PromotionStatus> {
      return getJson("/api/v1/promotion/status", promotionStatusSchema);
    },
    async preparePromotion(submission?: PromotionSubmission): Promise<PromotionResult> {
      const parsed = promotionSubmissionSchema.safeParse(submission ?? {});
      if (!parsed.success) throw new FactoryClientError("invalid_payload");
      return postJson("/api/v1/promotion/prepare", parsed.data, promotionResultSchema);
    },
    async monitoring(): Promise<MonitoringStatus> {
      return getJson("/api/v1/monitoring", monitoringStatusSchema);
    },
    async projects(): Promise<ProjectList> {
      return getJson("/api/v1/projects", projectListSchema);
    },
    async project(id: string): Promise<Project> {
      return getJson(`/api/v1/projects/${encodeURIComponent(id)}`, projectSchema);
    },
    async registerProject(submission: ProjectRegistration): Promise<Project> {
      const parsed = projectRegistrationSchema.safeParse(submission);
      if (!parsed.success) throw new FactoryClientError("invalid_payload");
      return postJson("/api/v1/projects", parsed.data, projectSchema);
    },
    async retargetProject(id: string, submission: ProjectRetarget): Promise<Project> {
      const parsed = projectRetargetSchema.safeParse(submission);
      if (!parsed.success) throw new FactoryClientError("invalid_payload");
      return postJson(
        `/api/v1/projects/${encodeURIComponent(id)}/retarget`,
        parsed.data,
        projectSchema,
      );
    },
    async deregisterProject(id: string): Promise<DeregisterResult> {
      return deleteJson(`/api/v1/projects/${encodeURIComponent(id)}`, deregisterResultSchema);
    },
    async commands(opts?: {
      projectId?: string;
      state?: CommandState;
      limit?: number;
    }): Promise<CommandList> {
      const params = new URLSearchParams();
      if (opts?.projectId) params.set("projectId", opts.projectId);
      if (opts?.state) params.set("state", opts.state);
      if (opts?.limit) params.set("limit", String(opts.limit));
      const qs = params.toString();
      const path = qs ? `/api/v1/commands?${qs}` : "/api/v1/commands";
      return getJson(path, commandListSchema);
    },
    async command(requestId: string): Promise<CommandRecord> {
      return getJson(`/api/v1/commands/${encodeURIComponent(requestId)}`, commandRecordSchema);
    },
    async dispatchCommand(submission: CommandSubmission): Promise<CommandRecord> {
      const parsed = commandSubmissionSchema.safeParse(submission);
      if (!parsed.success) throw new FactoryClientError("invalid_payload");
      return postJson("/api/v1/commands", parsed.data, commandRecordSchema);
    },
    async reconcileCommands(): Promise<CommandReconciliationResult> {
      return postJson("/api/v1/commands/reconcile", {}, commandReconciliationResultSchema);
    },
    async brakes(): Promise<GlobalBrakeState> {
      return getJson("/api/v1/brakes", globalBrakeStateSchema);
    },
    async setBrake(submission: BrakeSubmission): Promise<GlobalBrakeState> {
      const parsed = brakeSubmissionSchema.safeParse(submission);
      if (!parsed.success) throw new FactoryClientError("invalid_payload");
      return postJson("/api/v1/brakes", parsed.data, globalBrakeStateSchema);
    },
    async backupLedger(destinationPath: string): Promise<BackupResult> {
      const parsed = backupSubmissionSchema.safeParse({ destinationPath });
      if (!parsed.success) throw new FactoryClientError("invalid_payload");
      return postJson("/api/v1/commands/backup", parsed.data, backupResultSchema);
    },
    forProject(projectId: string) {
      const encId = encodeURIComponent(projectId);
      const scopedBase = `/api/v1/projects/${encId}`;
      return {
        async project(): Promise<Project> {
          return getJson(scopedBase, projectSchema);
        },
        async retarget(submission: ProjectRetarget): Promise<Project> {
          const parsed = projectRetargetSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(`${scopedBase}/retarget`, parsed.data, projectSchema);
        },
        async deregister(): Promise<DeregisterResult> {
          return deleteJson(scopedBase, deregisterResultSchema);
        },
        async commands(opts?: { state?: CommandState; limit?: number }): Promise<CommandList> {
          const params = new URLSearchParams();
          if (opts?.state) params.set("state", opts.state);
          if (opts?.limit) params.set("limit", String(opts.limit));
          const qs = params.toString();
          const path = qs ? `${scopedBase}/commands?${qs}` : `${scopedBase}/commands`;
          return getJson(path, commandListSchema);
        },
        async command(requestId: string): Promise<CommandRecord> {
          return getJson(
            `${scopedBase}/commands/${encodeURIComponent(requestId)}`,
            commandRecordSchema,
          );
        },
        async dispatchCommand(
          submission: Omit<CommandSubmission, "projectId">,
        ): Promise<CommandRecord> {
          const payload = { ...submission, projectId };
          const parsed = commandSubmissionSchema.safeParse(payload);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(`${scopedBase}/commands`, parsed.data, commandRecordSchema);
        },
        async brakes(): Promise<ProjectBrakeState> {
          return getJson(`${scopedBase}/brakes`, projectBrakeStateSchema);
        },
        async setBrake(submission: ProjectBrakeSubmission): Promise<ProjectBrakeState> {
          const parsed = projectBrakeSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(`${scopedBase}/brakes`, parsed.data, projectBrakeStateSchema);
        },
        async intake(opts?: { refresh?: boolean }): Promise<IntakeResult> {
          const path = opts?.refresh ? `${scopedBase}/intake?refresh=true` : `${scopedBase}/intake`;
          return getJson(path, intakeResultSchema);
        },
        async issue(number: number): Promise<EvaluatedIssue> {
          return getJson(
            `${scopedBase}/intake/${encodeURIComponent(number)}`,
            evaluatedIssueSchema,
          );
        },
        async previewIntake(submission: IntakePreviewSubmission): Promise<IntakePreviewResult> {
          const parsed = intakePreviewSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(`${scopedBase}/intake/preview`, parsed.data, intakePreviewResultSchema);
        },
        async publishTicket(submission: IntakePublishSubmission): Promise<IntakePublishResult> {
          const parsed = intakePublishSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(`${scopedBase}/intake/publish`, parsed.data, intakePublishResultSchema);
        },
        async updateTicket(
          number: number,
          submission: IntakeUpdateSubmission,
        ): Promise<EvaluatedIssue> {
          const parsed = intakeUpdateSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/intake/${encodeURIComponent(number)}/update`,
            parsed.data,
            evaluatedIssueSchema,
          );
        },
        async bindTarget(
          number: number,
          submission: TargetBindingSubmission,
        ): Promise<TargetBindingResult> {
          const parsed = targetBindingSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/intake/${encodeURIComponent(number)}/bind`,
            parsed.data,
            targetBindingResultSchema,
          );
        },
        async recordBranchIntegration(
          number: number,
          submission: BranchIntegrationSubmission,
        ): Promise<BranchIntegrationResult> {
          const parsed = branchIntegrationSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/intake/${encodeURIComponent(number)}/integrate`,
            parsed.data,
            branchIntegrationResultSchema,
          );
        },
        async getBranchIntegration(number: number): Promise<BranchIntegrationResult> {
          return getJson(
            `${scopedBase}/intake/${encodeURIComponent(number)}/integration`,
            branchIntegrationResultSchema,
          );
        },
        async laps(): Promise<LapList> {
          return getJson(`${scopedBase}/laps`, lapListSchema);
        },
        async lap(id: string): Promise<LapDetail> {
          return getJson(`${scopedBase}/laps/${encodeURIComponent(id)}`, lapDetailSchema);
        },
        async launch(submission: LaunchSubmission): Promise<LaunchAck> {
          const parsed = launchSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(`${scopedBase}/laps`, parsed.data, launchAckSchema);
        },
        async controlState(): Promise<ControlState> {
          return getJson(`${scopedBase}/controls`, controlStateSchema);
        },
        async control(action: ControlAction): Promise<ControlState> {
          const parsed = controlSubmissionSchema.safeParse({ action });
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(`${scopedBase}/controls`, parsed.data, controlStateSchema);
        },
        async evidence(lapId: string): Promise<LapEvidence> {
          return getJson(
            `${scopedBase}/laps/${encodeURIComponent(lapId)}/evidence`,
            lapEvidenceSchema,
          );
        },
        async report(lapId: string): Promise<string> {
          const endpoint = new URL(
            `${scopedBase}/laps/${encodeURIComponent(lapId)}/evidence/report`,
            options.baseUrl,
          ).href;
          let response: Response;
          try {
            response = await transport(endpoint, {
              method: "GET",
              redirect: "error",
              cache: "no-store",
            });
          } catch {
            throw new FactoryClientError("transport_unavailable");
          }
          if (!response.ok) {
            let errCode: OperatorErrorCode = "report_not_found";
            try {
              const body: any = await response.json();
              if (body && typeof body.error === "string") errCode = body.error;
            } catch {}
            throw new FactoryClientError(errCode);
          }
          return response.text();
        },
        async promotionStatus(): Promise<PromotionStatus> {
          return getJson(`${scopedBase}/promotion/status`, promotionStatusSchema);
        },
        async preparePromotion(submission?: PromotionSubmission): Promise<PromotionResult> {
          const parsed = promotionSubmissionSchema.safeParse(submission ?? {});
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(`${scopedBase}/promotion/prepare`, parsed.data, promotionResultSchema);
        },
        async planSpecCoordination(
          specIssueNumber: number,
          options?: { baseBranch?: string },
        ): Promise<SpecCoordinationPlan> {
          return postJson(
            `${scopedBase}/coordination/plan`,
            { specIssueNumber, baseBranch: options?.baseBranch },
            specCoordinationPlanSchema,
          );
        },
        async getSpecCoordinationPlan(specIssueNumber: number): Promise<SpecCoordinationPlan> {
          return getJson(
            `${scopedBase}/coordination/plan/${encodeURIComponent(specIssueNumber)}`,
            specCoordinationPlanSchema,
          );
        },
        async dispatchSubticket(
          specIssueNumber: number,
          childIssueNumber: number,
          options?: { actor?: string },
        ): Promise<TargetedImplementResult> {
          return postJson(
            `${scopedBase}/coordination/dispatch`,
            { specIssueNumber, childIssueNumber, actor: options?.actor },
            targetedImplementResultSchema,
          );
        },
        async createFinalPullRequest(
          submission: CoordinationFinalPrSubmission,
        ): Promise<CoordinationFinalPrResult> {
          const parsed = coordinationFinalPrSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/coordination/final-pr`,
            parsed.data,
            coordinationFinalPrResultSchema,
          );
        },
        async recordCandidateVerification(
          submission: CandidateVerificationSubmission,
        ): Promise<CandidateVerificationRecord> {
          const parsed = candidateVerificationSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/evidence/verification`,
            parsed.data,
            candidateVerificationRecordSchema,
          );
        },
        async getCandidateVerification(prNumber: number): Promise<CandidateVerificationRecord> {
          return getJson(
            `${scopedBase}/evidence/verification/${encodeURIComponent(prNumber)}`,
            candidateVerificationRecordSchema,
          );
        },
        async listCandidateVerifications(): Promise<CandidateVerificationRecord[]> {
          return getJson(
            `${scopedBase}/evidence/verification`,
            candidateVerificationRecordSchema.array(),
          );
        },
        async evaluateLandingGuard(
          prNumber: number,
          opts?: { headSha?: string; baseSha?: string },
        ): Promise<LandingGuardResult> {
          const params = new URLSearchParams();
          if (opts?.headSha) params.set("headSha", opts.headSha);
          if (opts?.baseSha) params.set("baseSha", opts.baseSha);
          const qs = params.toString();
          const path = `${scopedBase}/evidence/landing-guard/${encodeURIComponent(prNumber)}${qs ? `?${qs}` : ""}`;
          return getJson(path, landingGuardResultSchema);
        },
        async executeLanding(submission: LandingSubmission): Promise<LandingExecutionResult> {
          const parsed = landingSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/evidence/landing`,
            parsed.data,
            landingExecutionResultSchema,
          );
        },
        async executeTieredAction(submission: TieredActionSubmission): Promise<TieredActionResult> {
          const parsed = tieredActionSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/evidence/tiered-action`,
            parsed.data,
            tieredActionResultSchema,
          );
        },
        async cancelRun(submission: RunCancellationSubmission): Promise<RunCancellationResult> {
          const parsed = runCancellationSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/evidence/cancel-run`,
            parsed.data,
            runCancellationResultSchema,
          );
        },
        async approveGate(submission: GateApprovalSubmission): Promise<GateApprovalRecord> {
          const parsed = gateApprovalSubmissionSchema.safeParse(submission);
          if (!parsed.success) throw new FactoryClientError("invalid_payload");
          return postJson(
            `${scopedBase}/evidence/gate-approval`,
            parsed.data,
            gateApprovalRecordSchema,
          );
        },
        async getReleaseReadiness(candidateSha: string): Promise<ReleaseReadinessResult> {
          return getJson(
            `${scopedBase}/evidence/release-readiness/${encodeURIComponent(candidateSha)}`,
            releaseReadinessResultSchema,
          );
        },
        async getSanitizedReport(prNumber: number): Promise<SanitizedReport> {
          return getJson(
            `${scopedBase}/evidence/report/${encodeURIComponent(prNumber)}/sanitized`,
            sanitizedReportSchema,
          );
        },
      };
    },
  };
}
