import { createHash, timingSafeEqual } from "node:crypto";
import { hostHealthSchema } from "@labq/contracts/host";
import { configuration } from "./config";

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
      if (!["/health", "/build-id", "/internal/v1/health"].includes(path))
        return Response.json({ error: "not_found" }, { status: 404 });
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
      return Response.json(hostHealthSchema.parse({ status: "healthy", buildId: config.buildId }));
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
