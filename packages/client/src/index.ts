import {
  healthSchema,
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
};

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
      };
    },
  };
}
