import {
  healthSchema,
  diagnosticsSchema,
  workflowCatalogSchema,
  lapListSchema,
  lapDetailSchema,
  operatorErrorSchema,
  type Health,
  type Diagnostics,
  type WorkflowCatalog,
  type LapList,
  type LapDetail,
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
  };
}
