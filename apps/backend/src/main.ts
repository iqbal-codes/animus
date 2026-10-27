import { hostHealthSchema } from "@labq/contracts/host";
import {
  healthSchema,
  diagnosticsSchema,
  workflowCatalogSchema,
  lapListSchema,
  lapDetailSchema,
  launchAckSchema,
  launchSubmissionSchema,
  intakeResultSchema,
  evaluatedIssueSchema,
  controlStateSchema,
  controlSubmissionSchema,
  type OperatorErrorCode,
} from "@labq/contracts/operator";
import { configuration, hostOrigin } from "./config";
import { IntakeService } from "./intake";

try {
  const config = configuration();
  const origin = hostOrigin();
  const intakeService = new IntakeService();
  // Bun 1.4.2 still resolves ambient proxies with fetch({ proxy: "" }).
  process.env.NO_PROXY = process.env.no_proxy = new URL(origin).hostname;
  const failure = (error: OperatorErrorCode, status = 503) => Response.json({ error }, { status });

  async function forwardToHost(internalPath: string, schema?: any, init?: RequestInit) {
    const deadline = AbortSignal.timeout(3000);
    let response: Response;
    const requestHeaders = new Headers(init?.headers);
    requestHeaders.set("Authorization", `Bearer ${config.token}`);
    try {
      response = await fetch(`${origin}${internalPath}`, {
        headers: requestHeaders,
        method: init?.method ?? "GET",
        body: init?.body,
        redirect: "manual",
        signal: deadline,
      });
    } catch {
      return failure("host_unavailable");
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return failure("host_unauthorized");
    }

    let body: any;
    try {
      body = await response.json();
    } catch {
      return failure("invalid_host_response", 502);
    }

    if (!response.ok) {
      const errCode = body?.error || "host_unavailable";
      return Response.json({ error: errCode }, { status: response.status });
    }

    if (schema) {
      const parsed = schema.safeParse(body);
      if (!parsed.success) return failure("invalid_host_response", 502);
      return Response.json(parsed.data);
    }

    return Response.json(body);
  }

  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(request) {
      const path = new URL(request.url).pathname;

      if (request.method !== "GET" && request.method !== "POST")
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET, POST" } },
        );

      if (path === "/health") {
        if (request.method !== "GET")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        return Response.json({ status: "healthy" });
      }
      if (path === "/build-id") {
        if (request.method !== "GET")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        return new Response(config.buildId, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (path === "/api/v1/health") {
        if (request.method !== "GET")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        let response: Response;
        const deadline = AbortSignal.timeout(2000);
        try {
          response = await fetch(`${origin}/internal/v1/health`, {
            headers: { Authorization: `Bearer ${config.token}` },
            redirect: "manual",
            signal: deadline,
          });
        } catch {
          return failure("host_unavailable");
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          return failure("host_unauthorized");
        }
        if (!response.ok) {
          await response.body?.cancel();
          return failure("host_unavailable");
        }
        try {
          const host = hostHealthSchema.safeParse(await response.json());
          if (!host.success) return failure("invalid_host_response", 502);
          if (host.data.buildId !== config.buildId) return failure("candidate_mismatch");
          return Response.json(
            healthSchema.parse({ status: "healthy", buildId: config.buildId, host: host.data }),
          );
        } catch {
          return deadline.aborted
            ? failure("host_unavailable")
            : failure("invalid_host_response", 502);
        }
      }

      if (path === "/api/v1/diagnostics") {
        return forwardToHost("/internal/v1/diagnostics", diagnosticsSchema);
      }

      if (path === "/api/v1/catalog") {
        return forwardToHost("/internal/v1/catalog", workflowCatalogSchema);
      }

      if (path === "/api/v1/laps") {
        if (request.method === "POST") {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const parsed = launchSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          return forwardToHost("/internal/v1/laps", launchAckSchema, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed.data),
          });
        }
        return forwardToHost("/internal/v1/laps", lapListSchema);
      }

      if (path.startsWith("/api/v1/laps/")) {
        const lapId = path.slice("/api/v1/laps/".length);
        return forwardToHost(`/internal/v1/laps/${encodeURIComponent(lapId)}`, lapDetailSchema);
      }

      if (path === "/api/v1/intake") {
        if (request.method !== "GET")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        const url = new URL(request.url);
        const forceRefresh = url.searchParams.get("refresh") === "true";
        try {
          const backlog = await intakeService.evaluateBacklog(forceRefresh);
          const parsed = intakeResultSchema.safeParse(backlog);
          if (!parsed.success)
            return Response.json({ error: "invalid_operator_response" }, { status: 502 });
          return Response.json(parsed.data);
        } catch {
          return Response.json({ error: "intake_unavailable" }, { status: 503 });
        }
      }

      if (path.startsWith("/api/v1/intake/")) {
        if (request.method !== "GET")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        const rawNum = path.slice("/api/v1/intake/".length);
        const issueNum = parseInt(rawNum, 10);
        if (Number.isNaN(issueNum) || issueNum <= 0) {
          return Response.json({ error: "issue_not_found" }, { status: 404 });
        }
        try {
          const backlog = await intakeService.evaluateBacklog(false);
          const found = backlog.issues.find((i) => i.number === issueNum);
          if (!found) {
            return Response.json({ error: "issue_not_found" }, { status: 404 });
          }
          const parsed = evaluatedIssueSchema.safeParse(found);
          if (!parsed.success)
            return Response.json({ error: "invalid_operator_response" }, { status: 502 });
          return Response.json(parsed.data);
        } catch {
          return Response.json({ error: "intake_unavailable" }, { status: 503 });
        }
      }

      if (path === "/api/v1/controls") {
        if (request.method === "POST") {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const parsed = controlSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          return forwardToHost("/internal/v1/controls", controlStateSchema, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed.data),
          });
        }
        return forwardToHost("/internal/v1/controls", controlStateSchema);
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });

  console.log(JSON.stringify({ url: server.url.origin, runtime: `Bun ${Bun.version}` }));
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      void server.stop(true).then(() => process.exit(0));
    });
} catch {
  console.error(
    "Backend startup failed: check --host, --port, FACTORY_HOST_URL, FACTORY_HOST_TOKEN and candidate identity",
  );
  process.exit(1);
}
