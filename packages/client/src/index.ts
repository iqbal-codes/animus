import {
  healthSchema,
  operatorErrorSchema,
  type Health,
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
  const endpoint = new URL("/api/v1/health", options.baseUrl).href;
  return {
    async health(): Promise<Health> {
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
        throw new FactoryClientError(
          error.success ? error.data.error : "invalid_operator_response",
        );
      }
      const result = healthSchema.safeParse(body);
      if (!result.success) throw new FactoryClientError("invalid_operator_response");
      return result.data;
    },
  };
}
