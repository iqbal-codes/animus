import { createHash, timingSafeEqual } from "node:crypto";
import {
  hostHealthSchema,
  hostLaunchSubmissionSchema,
  hostControlSubmissionSchema,
  hostPromotionSubmissionSchema,
} from "@labq/contracts/host";
import { configuration } from "./config";
import {
  readDiagnostics,
  readCatalog,
  readLaps,
  readLapDetail,
  readLapEvidence,
  readLapReport,
  launchNativeLap,
  readControlState,
  applyControlAction,
} from "./native";
import { PromotionService } from "./promotion";

try {
  const config = configuration();
  const promotionService = new PromotionService(config.repoRoot);
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${config.token}`);
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(request) {
      if (!timingSafeEqual(expected, digest(request.headers.get("authorization") ?? "")))
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const path = new URL(request.url).pathname;

      if (request.method !== "GET" && request.method !== "POST")
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET, POST" } },
        );

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
      if (path === "/health") {
        if (request.method !== "GET")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        return Response.json({ status: "healthy" });
      }
      if (path === "/internal/v1/health") {
        if (request.method !== "GET")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        return Response.json(
          hostHealthSchema.parse({ status: "healthy", buildId: config.buildId }),
        );
      }

      if (request.method === "POST") {
        if (path === "/internal/v1/laps") {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const parsed = hostLaunchSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          try {
            return Response.json(launchNativeLap(config.repoRoot, parsed.data.specification));
          } catch (err: any) {
            const errCode = err.message || "native_launch_failed";
            const status = errCode === "launch_brake_set" ? 409 : 503;
            return Response.json({ error: errCode }, { status });
          }
        }

        if (path === "/internal/v1/controls") {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const parsed = hostControlSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          try {
            return Response.json(applyControlAction(config.repoRoot, parsed.data.action));
          } catch (err: any) {
            return Response.json({ error: err.message || "control_failed" }, { status: 500 });
          }
        }

        if (path === "/internal/v1/promotion/prepare") {
          let body: unknown = {};
          try {
            const text = await request.text();
            if (text.trim().length > 0) body = JSON.parse(text);
          } catch {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const parsed = hostPromotionSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          try {
            const res = promotionService.preparePromotion(parsed.data);
            return Response.json(res, { status: 201 });
          } catch (err: any) {
            const code = err.message || "promotion_failed";
            const status =
              code === "no_unpromoted_commits" || code === "promotion_pr_already_open" ? 409 : 500;
            return Response.json({ error: code }, { status });
          }
        }

        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (path === "/internal/v1/promotion/status") {
        try {
          return Response.json(promotionService.getStatus());
        } catch (err: any) {
          return Response.json(
            { error: err.message || "native_state_unavailable" },
            { status: 500 },
          );
        }
      }

      if (path === "/internal/v1/controls") {
        try {
          return Response.json(readControlState(config.repoRoot));
        } catch (err: any) {
          return Response.json({ error: err.message || "control_failed" }, { status: 500 });
        }
      }

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
        const sub = path.slice("/internal/v1/laps/".length);
        if (sub.endsWith("/evidence/report")) {
          const lapId = sub.slice(0, -"/evidence/report".length);
          try {
            const report = readLapReport(config.repoRoot, lapId);
            return new Response(report, {
              headers: { "Content-Type": "text/markdown; charset=utf-8" },
            });
          } catch (err: any) {
            const status = err.message === "lap_not_found" ? 404 : 503;
            return Response.json({ error: err.message || "report_not_found" }, { status });
          }
        }
        if (sub.endsWith("/evidence")) {
          const lapId = sub.slice(0, -"/evidence".length);
          try {
            return Response.json(readLapEvidence(config.repoRoot, lapId));
          } catch (err: any) {
            const status = err.message === "lap_not_found" ? 404 : 503;
            return Response.json({ error: err.message || "native_state_unavailable" }, { status });
          }
        }
        const lapId = sub;
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
