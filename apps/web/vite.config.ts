import { defineConfig, type Plugin, type ProxyOptions } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

function getBackendOrigin(): string | undefined {
  const value = process.env.FACTORY_BACKEND_URL;
  if (!value) return undefined;
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\/?$/.test(value)) {
    throw new Error("Invalid FACTORY_BACKEND_URL: loopback HTTP required");
  }
  try {
    const url = new URL(value);
    if (Number(url.port || 80) < 1) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Invalid FACTORY_BACKEND_URL");
  }
}

export default defineConfig(({ command, isPreview }) => {
  const buildId =
    process.env.FACTORY_RUNTIME_CANDIDATE ??
    (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          encoding: "utf8",
        }).trim();
      } catch {
        return "dev";
      }
    })();

  const healthPlugin: Plugin = {
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
      (path?.startsWith("/api/") && !path?.startsWith("/api/v1/"))
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

  const backend = getBackendOrigin();
  const proxy: Record<string, ProxyOptions> =
    (command === "serve" || isPreview) && backend
      ? {
          "^/api/v1(?:/|$)": { target: backend, ws: true },
          "^/ws(?:/|$)": { target: backend, ws: true },
        }
      : {};

  return {
    plugins: [tailwindcss(), healthPlugin],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: { host: "127.0.0.1", strictPort: true, proxy },
    preview: { host: "127.0.0.1", strictPort: true, proxy },
  };
});
