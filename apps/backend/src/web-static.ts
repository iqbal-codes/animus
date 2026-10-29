import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

export async function handleStaticWebRoute(
  request: Request,
  webDir?: string,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  // Never intercept API, health, build-id, or websocket paths
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/internal/") ||
    pathname === "/health" ||
    pathname === "/build-id" ||
    pathname === "/ws"
  ) {
    return null;
  }

  if (!webDir || !existsSync(webDir)) {
    return null;
  }

  // Resolve target file
  let normalized = pathname === "/" ? "/index.html" : pathname;
  const resolvedTarget = resolve(webDir, "." + normalized);

  // Directory traversal defense
  if (!resolvedTarget.startsWith(resolve(webDir))) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Serve file if exists
  if (existsSync(resolvedTarget) && statSync(resolvedTarget).isFile()) {
    const ext = extname(resolvedTarget).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const body = request.method === "HEAD" ? null : readFileSync(resolvedTarget);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  }

  // Single Page Application (SPA) fallback to index.html for client-side navigation
  const isSpaRoute =
    pathname === "/" ||
    pathname.startsWith("/projects") ||
    pathname.startsWith("/specs") ||
    pathname.startsWith("/laps") ||
    pathname.startsWith("/settings") ||
    request.headers.get("Accept")?.includes("text/html");

  const indexPath = join(webDir, "index.html");
  if (isSpaRoute && !extname(pathname) && existsSync(indexPath) && statSync(indexPath).isFile()) {
    const body = request.method === "HEAD" ? null : readFileSync(indexPath);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }

  return null;
}
