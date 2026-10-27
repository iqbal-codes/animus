import { hostHealthSchema } from "@labq/contracts/host";
import { healthSchema, type OperatorErrorCode } from "@labq/contracts/operator";
import { configuration, hostOrigin } from "./config";

try {
  const config = configuration();
  const origin = hostOrigin();
  const failure = (error: OperatorErrorCode, status = 503) => Response.json({ error }, { status });
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!["/health", "/build-id", "/api/v1/health"].includes(path))
        return Response.json({ error: "not_found" }, { status: 404 });
      if (request.method !== "GET")
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      if (path === "/health") return Response.json({ status: "healthy" });
      if (path === "/build-id")
        return new Response(config.buildId, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
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
