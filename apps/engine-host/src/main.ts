import { createHash, timingSafeEqual } from "node:crypto";
import { hostHealthSchema } from "@labq/contracts/host";
import { configuration } from "./config";
import { readDiagnostics, readCatalog, readLaps, readLapDetail } from "./native";

try {
  const config = configuration();
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${config.token}`);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch(request) {
      if (!timingSafeEqual(expected, digest(request.headers.get("authorization") ?? "")))
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const path = new URL(request.url).pathname;

      if (request.method !== "GET")
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );

      if (path === "/build-id")
        return new Response(config.buildId, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      if (path === "/health") return Response.json({ status: "healthy" });
      if (path === "/internal/v1/health")
        return Response.json(
          hostHealthSchema.parse({ status: "healthy", buildId: config.buildId }),
        );

      if (path === "/internal/v1/diagnostics") {
        try {
          return Response.json(readDiagnostics(config.repoRoot));
        } catch (err: any) {
          return Response.json(
            { error: err.message || "native_source_unavailable" },
            { status: 503 },
          );
        }
      }

      if (path === "/internal/v1/catalog") {
        try {
          return Response.json(readCatalog(config.repoRoot));
        } catch (err: any) {
          return Response.json(
            { error: err.message || "native_source_unavailable" },
            { status: 503 },
          );
        }
      }

      if (path === "/internal/v1/laps") {
        try {
          return Response.json(readLaps(config.repoRoot));
        } catch (err: any) {
          return Response.json(
            { error: err.message || "native_state_unavailable" },
            { status: 503 },
          );
        }
      }

      if (path.startsWith("/internal/v1/laps/")) {
        const lapId = path.slice("/internal/v1/laps/".length);
        try {
          return Response.json(readLapDetail(config.repoRoot, lapId));
        } catch (err: any) {
          const status = err.message === "lap_not_found" ? 404 : 503;
          return Response.json({ error: err.message || "native_state_unavailable" }, { status });
        }
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
    "Engine host startup failed: check --host, --port, FACTORY_HOST_TOKEN and candidate identity",
  );
  process.exit(1);
}
