import { hostHealthSchema } from "@animus/contracts/host";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { ServerWebSocket } from "bun";
import {
  healthSchema,
  diagnosticsSchema,
  workflowCatalogSchema,
  lapListSchema,
  lapDetailSchema,
  intakeResultSchema,
  evaluatedIssueSchema,
  projectSchema,
  projectListSchema,
  monitoringStatusSchema,
  projectRegistrationSchema,
  projectRetargetSchema,
  deregisterResultSchema,
  type OperatorErrorCode,
} from "@animus/contracts/operator";
import { configuration, hostOrigin, type Configuration } from "./config";
import { readExecutionAuthority } from "@animus/contracts/execution-authority";
import { IntakeService, handleProjectIntakeRoute } from "./intake";
import { WorkService, handleProjectWorkRoute } from "./work";
import { PlanService, handleProjectPlanRoute } from "./plans";
import {
  DispatchService,
  handleProjectDispatchRoute,
  runLocalDispatchTick,
  type DispatchServiceOptions,
} from "./dispatch";
import {
  initializeDatabase,
  ProjectRegistryService,
  ProjectRegistryError,
  type ForgeAdapter,
} from "./registry";
import { CommandService } from "./command";
import { ProjectOnboardingService } from "./registry/onboarding";
import { RegisteredProjectMonitor } from "./monitor/service";
import { loadMonitorRuntime, type MonitorRuntime } from "./monitor/runtime";
import { SpecCoordinatorService, handleProjectCoordinationRoute } from "./coordination";
import { EvidenceService, handleProjectEvidenceRoute } from "./evidence";
import { PublicationService, handleProjectPublicationRoute } from "./publication";
import { HarnessService, handleHarnessRoute } from "./harness";
import {
  validateCsrfProtection,
  authenticateOperatorRequest,
  validateBindAddress,
} from "./security";
import { handleStaticWebRoute } from "./web-static";
import { GitHubWebhookService } from "./webhooks";
import {
  handleLapsRoute,
  handleControlsRoute,
  handlePromotionRoute,
  handleBrakesRoute,
  handleCommandsRoute,
  type RouteContext,
} from "./routes";

export interface WsClientData {
  projectId?: string;
  lapId?: string;
  subscribedProjects: Set<string>;
  subscribedLaps: Set<string>;
}

export interface BackendAppOptions {
  db?: DatabaseSync;
  config?: Partial<Configuration>;
  stateDir?: string;
  token?: string;
  origin?: string;
  webDir?: string;
  startMonitor?: boolean;
  monitorIntervalMs?: number;
  monitorRuntime?: MonitorRuntime;
  forge?: ForgeAdapter;
  dispatch?: Omit<DispatchServiceOptions, "plans" | "ledger" | "brakes">;
}

export interface BackendApp {
  fetch(request: Request, server?: any): Promise<Response>;
  websocket: {
    open(ws: ServerWebSocket<WsClientData>): void;
    message(ws: ServerWebSocket<WsClientData>, raw: unknown): void;
    close(ws: ServerWebSocket<WsClientData>): void;
  };
  monitor: RegisteredProjectMonitor;
  db: DatabaseSync;
  publication: PublicationService;
  stop(): Promise<void>;
}

export async function createBackendApp(options?: BackendAppOptions): Promise<BackendApp> {
  const remoteAccess =
    options?.config?.remoteAccess ?? process.env.FACTORY_REMOTE_ACCESS === "true";
  const hostname = options?.config?.hostname ?? "127.0.0.1";
  const port = options?.config?.port ?? 0;
  validateBindAddress(hostname, remoteAccess);

  const token = options?.token ?? options?.config?.token ?? process.env.FACTORY_HOST_TOKEN ?? "";
  if (remoteAccess && !token) {
    throw new Error("Invalid FACTORY_HOST_TOKEN");
  }
  if (token && !/^[\x21-\x7e]{32,}$/.test(token)) {
    throw new Error("Invalid FACTORY_HOST_TOKEN");
  }

  const buildId =
    options?.config?.buildId ?? process.env.FACTORY_RUNTIME_CANDIDATE ?? "test-candidate";

  const config: Configuration = {
    hostname,
    port,
    token,
    buildId,
    remoteAccess,
    ...options?.config,
    ...(token ? { token } : undefined),
  };

  let origin = options?.origin;
  if (!origin && process.env.FACTORY_HOST_URL) {
    origin = hostOrigin();
  }
  origin = origin ?? "";
  const webDir =
    options?.webDir ??
    process.env.FACTORY_WEB_DIR ??
    join(fileURLToPath(new URL("../../../apps/web/dist", import.meta.url)));

  const ownsDb = !options?.db;
  const db =
    options?.db ??
    initializeDatabase(options?.stateDir ? join(options.stateDir, "console.db") : undefined);

  const registryService = new ProjectRegistryService(db, options?.forge);
  const sharedIntakeService = new IntakeService(
    registryService.getDb(),
    registryService.getForge(),
  );
  const workService = new WorkService(registryService.getDb());
  const planService = new PlanService(registryService.getDb(), registryService.getForge());
  const onboardingService = new ProjectOnboardingService(registryService);
  const harnessService = new HarnessService();

  const failure = (error: OperatorErrorCode, status = 503) => Response.json({ error }, { status });

  // Bun 1.4.2 still resolves ambient proxies with fetch({ proxy: "" }).
  if (origin) {
    try {
      process.env.NO_PROXY = process.env.no_proxy = new URL(origin).hostname;
    } catch {}
  }

  async function forwardToHost(internalPath: string, schema?: any, init?: RequestInit) {
    if (!origin) {
      return failure("host_unavailable");
    }
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

  const commandService = new CommandService(db, {
    engineAdapter: {
      async getLap(lapId: string) {
        const res = await forwardToHost(
          `/internal/v1/laps/${encodeURIComponent(lapId)}`,
          lapDetailSchema,
        );
        if (res.status === 404) return null;
        if (!res.ok) {
          throw new Error(`Engine host unavailable: ${res.status}`);
        }
        return (await res.json()) as any;
      },
      async listLaps() {
        const res = await forwardToHost("/internal/v1/laps", lapListSchema);
        if (!res.ok) {
          throw new Error(`Engine host unavailable: ${res.status}`);
        }
        return (await res.json()) as any;
      },
    },
    forgeAdapter: {
      async checkPr(repoId: number, prNumber?: number) {
        try {
          const project = registryService.getProjectByRepoId(repoId);
          if (!project || !prNumber) return null;
          const { execFileSync } = await import("node:child_process");
          const stdout = execFileSync(
            "gh",
            ["pr", "view", String(prNumber), "--json", "number,url,state"],
            {
              cwd: project.checkout_path,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const data = JSON.parse(stdout);
          return {
            exists: true,
            merged: data.state === "MERGED",
            url: data.url,
          };
        } catch {
          return null;
        }
      },
    },
  });

  // Reconcile in-flight/dispatched commands on startup
  void Promise.resolve().then(() => {
    try {
      commandService.reconcile().catch(() => {});
    } catch {}
  });

  const dispatchService = new DispatchService(registryService.getDb(), {
    ...options?.dispatch,
    plans: planService,
    ledger: commandService.ledger,
    brakes: commandService.brakes,
  });

  // Preserve interrupted/unknown ownership on startup instead of freeing claims by lease age.
  void Promise.resolve().then(() => {
    try {
      dispatchService.reconcile();
    } catch {}
  });

  const coordinationService = new SpecCoordinatorService(
    registryService.getDb(),
    registryService.getForge(),
    {
      ledger: commandService.ledger,
      commandService,
    },
  );

  const evidenceService = new EvidenceService(
    registryService.getDb(),
    registryService.getForge(),
    commandService.ledger,
  );

  const publicationService = new PublicationService(
    registryService.getDb(),
    registryService.getForge(),
  );

  const monitorRuntime =
    options?.monitorRuntime ?? (await loadMonitorRuntime({ forge: options?.forge }));
  const monitorInterval =
    options?.monitorIntervalMs ??
    (process.env.FACTORY_MONITOR_INTERVAL_MS !== undefined
      ? Number(process.env.FACTORY_MONITOR_INTERVAL_MS)
      : undefined);

  const monitor = new RegisteredProjectMonitor(registryService, {
    runtime: monitorRuntime,
    intervalMs: monitorInterval,
    authority: () => readExecutionAuthority().authority,
    localDispatch: () =>
      runLocalDispatchTick({
        db: registryService.getDb(),
        registry: registryService,
        plans: planService,
        dispatch: dispatchService,
        actor: "monitor",
      }),
  });

  const githubWebhookService = new GitHubWebhookService(registryService, {
    onProjectWake: (projectId) => monitor.wakeProject(projectId),
  });

  const wsClients = new Set<ServerWebSocket<WsClientData>>();
  let wsEventSeq = 1;

  function broadcastWsEvent(event: {
    id?: string;
    seq?: number;
    type: "log" | "lifecycle" | "invalidation" | "gap" | "heartbeat";
    projectId?: string;
    lapId?: string;
    timestamp?: string;
    payload: Record<string, unknown>;
  }) {
    const fullEvent = {
      id: event.id ?? `evt-${Date.now()}-${wsEventSeq}`,
      seq: event.seq ?? wsEventSeq++,
      type: event.type,
      projectId: event.projectId,
      lapId: event.lapId,
      timestamp: event.timestamp ?? new Date().toISOString(),
      payload: event.payload,
    };
    const json = JSON.stringify(fullEvent);
    for (const client of wsClients) {
      if (
        fullEvent.projectId &&
        client.data.subscribedProjects.size > 0 &&
        !client.data.subscribedProjects.has(fullEvent.projectId)
      ) {
        continue;
      }
      if (
        fullEvent.lapId &&
        client.data.subscribedLaps.size > 0 &&
        !client.data.subscribedLaps.has(fullEvent.lapId)
      ) {
        continue;
      }
      try {
        client.send(json);
      } catch {}
    }
  }

  const routeContext: RouteContext = {
    commandService,
    registryService,
    forwardToHost,
    broadcastWsEvent,
  };

  if (options?.startMonitor) {
    monitor.start();
  }

  let stopPromise: Promise<void> | null = null;
  const stop = async () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      await monitor.stop();
      wsClients.clear();
      if (ownsDb) {
        try {
          db.close();
        } catch {}
      }
    })();
    return stopPromise;
  };

  const appFetch = async (request: Request, server?: any): Promise<Response> => {
    try {
      validateCsrfProtection(request);
    } catch {
      return Response.json({ error: "csrf_rejected" }, { status: 403 });
    }

    const path = new URL(request.url).pathname;

    if (path !== "/health" && path !== "/build-id" && path !== "/api/v1/webhooks/github") {
      try {
        authenticateOperatorRequest(request, {
          remoteAccess: config.remoteAccess,
          operatorToken: process.env.FACTORY_OPERATOR_TOKEN,
        });
      } catch {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    if (path === "/api/v1/webhooks/github") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      return await githubWebhookService.handleWebhook(request);
    }

    if (
      request.headers.get("upgrade")?.toLowerCase() === "websocket" ||
      path === "/api/v1/ws" ||
      path.endsWith("/ws")
    ) {
      if (server?.upgrade) {
        const url = new URL(request.url);
        const projParam = url.searchParams.get("projectId") || undefined;
        const lapParam = url.searchParams.get("lapId") || undefined;
        const upgraded = server.upgrade(request, {
          data: {
            projectId: projParam,
            lapId: lapParam,
            subscribedProjects: new Set<string>(projParam ? [projParam] : []),
            subscribedLaps: new Set<string>(lapParam ? [lapParam] : []),
          },
        });
        if (upgraded) return undefined as any;
      }
      return new Response(null, { status: 426, statusText: "Upgrade Required" });
    }

    if (
      request.method !== "GET" &&
      request.method !== "POST" &&
      request.method !== "DELETE" &&
      request.method !== "PATCH"
    )
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET, POST, DELETE, PATCH" } },
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

    // Global unified route handlers
    if (path === "/api/v1/laps" || path.startsWith("/api/v1/laps/")) {
      const sub = path.slice("/api/v1/".length);
      const parts = sub.split("/");
      return handleLapsRoute(request, parts, routeContext);
    }

    if (path === "/api/v1/controls") {
      return handleControlsRoute(request, routeContext);
    }

    if (path.startsWith("/api/v1/promotion/")) {
      const sub = path.slice("/api/v1/".length);
      const parts = sub.split("/");
      return handlePromotionRoute(request, parts, routeContext);
    }

    if (path === "/api/v1/brakes") {
      return handleBrakesRoute(request, routeContext);
    }

    if (path === "/api/v1/commands" || path.startsWith("/api/v1/commands/")) {
      const sub = path.slice("/api/v1/".length);
      const parts = sub.split("/");
      return handleCommandsRoute(request, parts, routeContext);
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
        const backlog = await sharedIntakeService.evaluateBacklog(forceRefresh);
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
        const found = await sharedIntakeService.getIssue(issueNum);
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

    if (path === "/api/v1/monitoring" && request.method === "GET") {
      return Response.json(monitoringStatusSchema.parse(monitor.status()));
    }

    if (path === "/api/v1/projects") {
      if (request.method === "GET") {
        const projects = registryService.listProjects();
        return Response.json(projectListSchema.parse(projects));
      }
      if (request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const parsed = projectRegistrationSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        try {
          const project = await onboardingService.register(parsed.data);
          return Response.json(projectSchema.parse(project), { status: 201 });
        } catch (err) {
          if (err instanceof ProjectRegistryError) {
            return Response.json({ error: err.code, message: err.message }, { status: 400 });
          }
          return Response.json(
            {
              error: "project_checkout_invalid",
              message: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          );
        }
      }
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET, POST" } },
      );
    }

    if (path.startsWith("/api/v1/projects/")) {
      const subPath = path.slice("/api/v1/projects/".length);
      const parts = subPath.split("/");
      const projectId = decodeURIComponent(parts[0]);

      if (!projectId || projectId.trim() === "") {
        return Response.json({ error: "scope_mismatch" }, { status: 400 });
      }

      if (parts.length === 1) {
        if (request.method === "GET") {
          try {
            const project = registryService.getProject(projectId);
            return Response.json(projectSchema.parse(project));
          } catch (err) {
            if (err instanceof ProjectRegistryError) {
              const status = err.code === "project_not_found" ? 404 : 400;
              return Response.json({ error: err.code }, { status });
            }
            return Response.json({ error: "project_not_found" }, { status: 404 });
          }
        }
        if (request.method === "DELETE") {
          try {
            if (registryService.getActiveRunCount(projectId) > 0) {
              try {
                const checkRes = await forwardToHost("/internal/v1/laps", lapListSchema);
                if (checkRes.ok) {
                  const laps = (await checkRes.json()) as Array<{
                    id: string;
                    native_status: string;
                    product_status: string;
                    completed_at?: string | null;
                  }>;
                  for (const lap of laps) {
                    const lapProj = registryService.getRunProject(lap.id);
                    if (lapProj === projectId) {
                      const isFinished = Boolean(
                        lap.completed_at ||
                        ["completed", "failed", "stopped", "cancelled", "succeeded"].includes(
                          lap.native_status.toLowerCase(),
                        ) ||
                        ["completed", "failed", "stopped", "cancelled", "succeeded"].includes(
                          lap.product_status.toLowerCase(),
                        ),
                      );
                      if (isFinished) {
                        registryService.updateRunStatus(lap.id, "completed");
                      }
                    }
                  }
                }
              } catch {}
            }
            const result = await registryService.deregisterProject(projectId);
            return Response.json(deregisterResultSchema.parse(result));
          } catch (err) {
            if (err instanceof ProjectRegistryError) {
              const status = err.code === "project_not_found" ? 404 : 400;
              return Response.json({ error: err.code }, { status });
            }
            return Response.json({ error: "project_not_found" }, { status: 404 });
          }
        }
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET, DELETE" } },
        );
      }

      if (parts.length === 2 && parts[1] === "retarget") {
        if (request.method !== "POST") {
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "POST" } },
          );
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const parsed = projectRetargetSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        try {
          const project = await registryService.retargetProject(projectId, parsed.data);
          return Response.json(projectSchema.parse(project));
        } catch (err) {
          if (err instanceof ProjectRegistryError) {
            const status = err.code === "project_not_found" ? 404 : 400;
            return Response.json({ error: err.code }, { status });
          }
          return Response.json({ error: "retarget_rejected" }, { status: 400 });
        }
      }

      // Project-scoped subroutes require verified project scope
      try {
        registryService.validateScope(projectId);
      } catch (err) {
        const code = err instanceof ProjectRegistryError ? err.code : "scope_mismatch";
        const status = code === "project_not_found" ? 404 : 400;
        return Response.json({ error: code }, { status });
      }

      const scopedAction = parts[1];

      if (scopedAction === "intake") {
        const intakeRes = await handleProjectIntakeRoute(
          request,
          projectId,
          parts,
          sharedIntakeService,
        );
        if (intakeRes) return intakeRes;
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (scopedAction === "work") {
        const workRes = await handleProjectWorkRoute(request, projectId, parts, workService);
        if (workRes) return workRes;
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (scopedAction === "plans") {
        const planRes = await handleProjectPlanRoute(request, projectId, parts, planService);
        if (planRes) return planRes;
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (scopedAction === "dispatch") {
        const dispatchRes = await handleProjectDispatchRoute(
          request,
          projectId,
          parts,
          dispatchService,
        );
        if (dispatchRes) return dispatchRes;
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (scopedAction === "coordination") {
        if (readExecutionAuthority().authority === "local" && request.method !== "GET") {
          return Response.json(
            {
              error: "execution_authority_moved",
              message:
                "Legacy live-forge coordination dispatch is disabled after local authority activation; use the frozen plan dispatch routes",
            },
            { status: 409 },
          );
        }
        const coordRes = await handleProjectCoordinationRoute(
          request,
          projectId,
          parts,
          coordinationService,
        );
        if (coordRes) return coordRes;
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (scopedAction === "evidence") {
        const evidenceRes = await handleProjectEvidenceRoute(
          request,
          projectId,
          parts,
          evidenceService,
        );
        if (evidenceRes) return evidenceRes;
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (scopedAction === "publication") {
        const publicationRes = await handleProjectPublicationRoute(
          request,
          projectId,
          parts,
          publicationService,
        );
        if (publicationRes) return publicationRes;
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (scopedAction === "laps") {
        return handleLapsRoute(request, parts.slice(1), routeContext, projectId);
      }

      if (scopedAction === "controls") {
        return handleControlsRoute(request, routeContext, projectId);
      }

      if (scopedAction === "promotion") {
        return handlePromotionRoute(request, parts.slice(1), routeContext, projectId);
      }

      if (scopedAction === "brakes") {
        return handleBrakesRoute(request, routeContext, projectId);
      }

      if (scopedAction === "commands") {
        return handleCommandsRoute(request, parts.slice(1), routeContext, projectId);
      }
    }

    if (path.startsWith("/api/v1/harness/") || path.startsWith("/api/harness/")) {
      const harnessRes = await handleHarnessRoute(request, path, harnessService);
      if (harnessRes) return harnessRes;
    }

    const staticRes = await handleStaticWebRoute(request, webDir);
    if (staticRes) return staticRes;

    return Response.json({ error: "not_found" }, { status: 404 });
  };

  const websocket = {
    open(ws: ServerWebSocket<WsClientData>) {
      wsClients.add(ws);
      ws.send(
        JSON.stringify({
          id: `evt-${Date.now()}-0`,
          seq: 0,
          type: "heartbeat",
          timestamp: new Date().toISOString(),
          payload: {},
        }),
      );
    },
    message(ws: ServerWebSocket<WsClientData>, raw: unknown) {
      try {
        const data = JSON.parse(String(raw));
        if (data.action === "subscribe") {
          if (data.projectId) ws.data.subscribedProjects.add(data.projectId);
          if (data.lapId) ws.data.subscribedLaps.add(data.lapId);
        } else if (data.action === "unsubscribe") {
          if (data.projectId) ws.data.subscribedProjects.delete(data.projectId);
          if (data.lapId) ws.data.subscribedLaps.delete(data.lapId);
        } else if (data.action === "ping") {
          ws.send(
            JSON.stringify({
              id: `evt-${Date.now()}-pong`,
              seq: 0,
              type: "pong",
              timestamp: new Date().toISOString(),
              payload: {},
            }),
          );
        }
      } catch {}
    },
    close(ws: ServerWebSocket<WsClientData>) {
      wsClients.delete(ws);
    },
  };

  return {
    publication: publicationService,
    fetch: appFetch,
    websocket,
    monitor,
    db,
    stop,
  };
}

if (import.meta.main) {
  let server: ReturnType<typeof Bun.serve<WsClientData>> | null = null;
  let app: BackendApp | null = null;
  let shuttingDown = false;

  const handleShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.allSettled([
      server ? server.stop(true) : Promise.resolve(),
      app ? app.stop() : Promise.resolve(),
    ]).finally(() => {
      process.exit(0);
    });
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, handleShutdown);
  }

  try {
    const config = configuration();
    const origin = hostOrigin();
    const createdApp = await createBackendApp({ config, origin, startMonitor: true });
    app = createdApp;
    server = Bun.serve<WsClientData>({
      hostname: config.hostname,
      port: config.port,
      fetch(request, server) {
        return createdApp.fetch(request, server);
      },
      websocket: createdApp.websocket,
    });
    console.log(JSON.stringify({ url: server.url.origin, runtime: `Bun ${Bun.version}` }));
  } catch {
    console.error(
      "Backend startup failed: check --host, --port, FACTORY_HOST_URL, FACTORY_HOST_TOKEN and candidate identity",
    );
    process.exit(1);
  }
}
