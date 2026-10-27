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
} from "@labq/contracts/operator";

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
      const endpoint = new URL("/api/v1/laps", options.baseUrl).href;
      let response: Response;
      try {
        response = await transport(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
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
        throw new FactoryClientError(
          error.success ? error.data.error : "invalid_operator_response",
        );
      }
      const result = launchAckSchema.safeParse(body);
      if (!result.success) throw new FactoryClientError("invalid_operator_response");
      return result.data;
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
      const endpoint = new URL("/api/v1/controls", options.baseUrl).href;
      let response: Response;
      try {
        response = await transport(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
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
        throw new FactoryClientError(
          error.success ? error.data.error : "invalid_operator_response",
        );
      }
      const result = controlStateSchema.safeParse(body);
      if (!result.success) throw new FactoryClientError("invalid_operator_response");
      return result.data;
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
      const endpoint = new URL("/api/v1/promotion/prepare", options.baseUrl).href;
      let response: Response;
      try {
        response = await transport(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
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
        throw new FactoryClientError(
          error.success ? error.data.error : "invalid_operator_response",
        );
      }
      const result = promotionResultSchema.safeParse(body);
      if (!result.success) throw new FactoryClientError("invalid_operator_response");
      return result.data;
    },
  };
}
