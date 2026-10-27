import { defineConfig, type Plugin, type ProxyOptions } from "vite-plus";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseArgs } from "node:util";

function backendOrigin() {
  const value = process.env.FACTORY_BACKEND_URL;
  if (!value || !/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\/?$/.test(value))
    throw new Error("Invalid FACTORY_BACKEND_URL");
  try {
    const url = new URL(value);
    if (Number(url.port || 80) < 1) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Invalid FACTORY_BACKEND_URL");
  }
}

export default defineConfig(({ command, isPreview }) => {
  if (command === "serve" || isPreview) {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: false,
      allowPositionals: true,
      options: {
        port: { type: "string", multiple: true },
        host: { type: "string", multiple: true },
      },
    });
    if (
      !values.port?.length ||
      values.port.some(
        (port) =>
          typeof port !== "string" ||
          !/^\d+$/.test(port) ||
          Number(port) < 1 ||
          Number(port) > 65535,
      )
    )
      throw new Error("Explicit valid --port required");
    if (
      values.host?.some((host) => typeof host !== "string" || !["127.0.0.1", "::1"].includes(host))
    )
      throw new Error("Loopback --host required");
  }
  const buildId =
    process.env.FACTORY_RUNTIME_CANDIDATE ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
    }).trim();
  const health: Plugin = {
    name: "factory-local-health",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const path = request.url?.split("?")[0];
    if (
      path?.startsWith("/internal/") ||
      (path?.startsWith("/api/") && path !== "/api/v1/health")
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (path !== "/health" && path !== "/build-id") {
      next();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end();
      return;
    }
    response.setHeader(
      "Content-Type",
      path === "/health" ? "application/json" : "text/plain; charset=utf-8",
    );
    response.end(path === "/health" ? JSON.stringify({ status: "healthy" }) : buildId);
  };
  const proxy: Record<string, ProxyOptions> =
    command === "serve" || isPreview ? { "^/api/v1(?:/|$)": { target: backendOrigin() } } : {};
  return {
    plugins: [health],
    server: { host: "127.0.0.1", strictPort: true, proxy },
    preview: { host: "127.0.0.1", strictPort: true, proxy },
  };
});
