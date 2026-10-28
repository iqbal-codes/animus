import { hostHealthSchema } from "@labq/contracts/host";
import type { DatabaseSync } from "node:sqlite";
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
  lapEvidenceSchema,
  promotionStatusSchema,
  promotionSubmissionSchema,
  promotionResultSchema,
  projectSchema,
  projectListSchema,
  projectRegistrationSchema,
  projectRetargetSchema,
  deregisterResultSchema,
  commandRecordSchema,
  commandListSchema,
  commandSubmissionSchema,
  commandReconciliationResultSchema,
  globalBrakeStateSchema,
  projectBrakeStateSchema,
  brakeSubmissionSchema,
  projectBrakeSubmissionSchema,
  backupSubmissionSchema,
  backupResultSchema,
  type OperatorErrorCode,
} from "@labq/contracts/operator";
import { configuration, hostOrigin } from "./config";
import { IntakeService, handleProjectIntakeRoute } from "./intake";
import { initializeDatabase, ProjectRegistryService, ProjectRegistryError } from "./registry";
import { CommandService, CommandError } from "./command";

try {
  const config = configuration();
  const origin = hostOrigin();
  const intakeService = new IntakeService();
  let sharedDb: DatabaseSync | null = null;
  const getDb = (): DatabaseSync => {
    if (!sharedDb) {
      sharedDb = initializeDatabase();
    }
    return sharedDb;
  };
  let registryServiceInstance: ProjectRegistryService | null = null;
  const getRegistryService = (): ProjectRegistryService => {
    if (!registryServiceInstance) {
      registryServiceInstance = new ProjectRegistryService(getDb());
    }
    return registryServiceInstance;
  };
  let commandServiceInstance: CommandService | null = null;
  const getCommandService = (): CommandService => {
    if (!commandServiceInstance) {
      commandServiceInstance = new CommandService(getDb(), {
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
              const registry = getRegistryService();
              const project = registry.getProjectByRepoId(repoId);
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
    }
    return commandServiceInstance;
  };
  // AC2: Reconcile in-flight/dispatched commands on startup
  void Promise.resolve().then(() => {
    try {
      getCommandService()
        .reconcile()
        .catch(() => {});
    } catch {}
  });

  let intakeServiceInstance: IntakeService | null = null;
  const getIntakeService = (): IntakeService => {
    if (!intakeServiceInstance) {
      const reg = getRegistryService();
      intakeServiceInstance = new IntakeService(reg.getDb(), reg.getForge());
    }
    return intakeServiceInstance;
  };
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
          const cmdService = getCommandService();
          try {
            const cmd = await cmdService.dispatch(
              {
                actor: "operator",
                action: "launch",
                target: parsed.data as Record<string, unknown>,
              },
              async () => {
                const forwardRes = await forwardToHost("/internal/v1/laps", launchAckSchema, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(parsed.data),
                });
                if (!forwardRes.ok) {
                  const errJson = (await forwardRes.json().catch(() => ({}))) as any;
                  const errCode = errJson?.error || "dispatch_failed";
                  if (
                    errCode === "host_unavailable" ||
                    forwardRes.status === 503 ||
                    forwardRes.status === 504
                  ) {
                    return { error: errCode, state: "unknown" };
                  }
                  return { error: errCode, state: "failed" };
                }
                const ack = (await forwardRes.json()) as { id: string };
                return { result: ack, state: "acknowledged" };
              },
            );
            if (cmd.state === "failed") {
              return Response.json(
                { error: cmd.outcome?.error || "native_launch_failed" },
                { status: 502 },
              );
            }
            if (cmd.state === "unknown") {
              return Response.json(
                { error: cmd.outcome?.error || "host_unavailable" },
                { status: 503 },
              );
            }
            return Response.json(
              cmd.outcome?.result ?? { id: cmd.requestId, status: "dispatched" },
            );
          } catch (err: any) {
            if (err instanceof CommandError) {
              const status = err.code === "storage_failed" ? 500 : 400;
              return Response.json({ error: err.code }, { status });
            }
            return Response.json({ error: "control_failed" }, { status: 400 });
          }
        }
        return forwardToHost("/internal/v1/laps", lapListSchema);
      }

      if (path.startsWith("/api/v1/laps/")) {
        const sub = path.slice("/api/v1/laps/".length);
        if (sub.endsWith("/evidence/report")) {
          const lapId = sub.slice(0, -"/evidence/report".length);
          return forwardToHost(`/internal/v1/laps/${encodeURIComponent(lapId)}/evidence/report`);
        }
        if (sub.endsWith("/evidence")) {
          const lapId = sub.slice(0, -"/evidence".length);
          return forwardToHost(
            `/internal/v1/laps/${encodeURIComponent(lapId)}/evidence`,
            lapEvidenceSchema,
          );
        }
        const lapId = sub;
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

      if (path === "/api/v1/promotion/status") {
        if (request.method !== "GET")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        return forwardToHost("/internal/v1/promotion/status", promotionStatusSchema);
      }

      if (path === "/api/v1/promotion/prepare") {
        if (request.method !== "POST")
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "POST" } },
          );
        let body: unknown = {};
        try {
          const text = await request.text();
          if (text.trim().length > 0) body = JSON.parse(text);
        } catch {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const parsed = promotionSubmissionSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        return forwardToHost("/internal/v1/promotion/prepare", promotionResultSchema, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
        });
      }

      if (path === "/api/v1/brakes") {
        const cmdService = getCommandService();
        if (request.method === "GET") {
          const state = cmdService.brakes.getGlobalBrakeState();
          return Response.json(globalBrakeStateSchema.parse(state));
        }
        if (request.method === "POST") {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const parsed = brakeSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          if (parsed.data.brake === "global_launch") {
            const state = cmdService.brakes.setGlobalLaunchBrake(
              parsed.data.active,
              parsed.data.actor,
              parsed.data.reason,
            );
            return Response.json(globalBrakeStateSchema.parse(state));
          }
          if (parsed.data.brake === "schedule_pause") {
            const state = cmdService.brakes.setGlobalSchedulePause(
              parsed.data.active,
              parsed.data.actor,
              parsed.data.reason,
            );
            return Response.json(globalBrakeStateSchema.parse(state));
          }
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET, POST" } },
        );
      }

      if (path === "/api/v1/commands") {
        const cmdService = getCommandService();
        if (request.method === "GET") {
          const url = new URL(request.url);
          const projectId = url.searchParams.get("projectId") || undefined;
          const state = (url.searchParams.get("state") || undefined) as any;
          const limitStr = url.searchParams.get("limit");
          const limit = limitStr ? parseInt(limitStr, 10) : undefined;
          const commands = cmdService.listCommands({ projectId, state, limit });
          return Response.json(commandListSchema.parse(commands));
        }
        if (request.method === "POST") {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const parsed = commandSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          try {
            const record = await cmdService.dispatch(parsed.data, async (cmd) => {
              if (cmd.action === "launch") {
                const forwardRes = await forwardToHost("/internal/v1/laps", launchAckSchema, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(cmd.target),
                });
                if (!forwardRes.ok) {
                  const errJson = (await forwardRes.json().catch(() => ({}))) as any;
                  return { error: errJson?.error || "dispatch_failed" };
                }
                const ack = (await forwardRes.json()) as { id: string };
                if (cmd.projectId) {
                  getRegistryService().recordRun(ack.id, cmd.projectId);
                }
                return { result: ack, state: "acknowledged" };
              }
              return { result: { ok: true }, state: "succeeded" };
            });
            return Response.json(commandRecordSchema.parse(record), { status: 201 });
          } catch (err: any) {
            if (err instanceof CommandError) {
              const status = err.code === "storage_failed" ? 500 : 400;
              return Response.json({ error: err.code }, { status });
            }
            return Response.json({ error: "control_failed" }, { status: 400 });
          }
        }
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET, POST" } },
        );
      }

      if (path === "/api/v1/commands/reconcile") {
        if (request.method !== "POST") {
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "POST" } },
          );
        }
        const cmdService = getCommandService();
        const result = await cmdService.reconcile();
        return Response.json(commandReconciliationResultSchema.parse(result));
      }

      if (path === "/api/v1/commands/backup") {
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
        const parsed = backupSubmissionSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const cmdService = getCommandService();
        try {
          const result = cmdService.backupDatabase(parsed.data.destinationPath);
          return Response.json(backupResultSchema.parse(result));
        } catch (err: any) {
          return Response.json({ error: err?.code || "backup_failed" }, { status: 500 });
        }
      }

      if (path.startsWith("/api/v1/commands/")) {
        const requestId = decodeURIComponent(path.slice("/api/v1/commands/".length));
        if (request.method !== "GET") {
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        }
        const cmdService = getCommandService();
        const cmd = cmdService.getCommand(requestId);
        if (!cmd) {
          return Response.json({ error: "command_not_found" }, { status: 404 });
        }
        return Response.json(commandRecordSchema.parse(cmd));
      }

      if (path === "/api/v1/projects") {
        const registryService = getRegistryService();
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
            const project = await registryService.registerProject(parsed.data);
            return Response.json(projectSchema.parse(project), { status: 201 });
          } catch (err) {
            if (err instanceof ProjectRegistryError) {
              return Response.json({ error: err.code }, { status: 400 });
            }
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
        }
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET, POST" } },
        );
      }

      if (path.startsWith("/api/v1/projects/")) {
        const registryService = getRegistryService();
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
            getIntakeService(),
          );
          if (intakeRes) return intakeRes;
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        if (scopedAction === "laps") {
          if (parts.length === 2) {
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
              const url = new URL(request.url);
              const isScheduled =
                url.searchParams.get("scheduled") === "true" ||
                request.headers.get("X-Scheduled") === "true";
              const cmdService = getCommandService();
              try {
                const cmd = await cmdService.dispatch(
                  {
                    actor: "operator",
                    projectId,
                    action: "launch",
                    target: parsed.data as Record<string, unknown>,
                  },
                  async () => {
                    const forwardRes = await forwardToHost("/internal/v1/laps", launchAckSchema, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(parsed.data),
                    });
                    if (!forwardRes.ok) {
                      const errJson = (await forwardRes.json().catch(() => ({}))) as any;
                      const errCode = errJson?.error || "dispatch_failed";
                      if (
                        errCode === "host_unavailable" ||
                        forwardRes.status === 503 ||
                        forwardRes.status === 504
                      ) {
                        return { error: errCode, state: "unknown" };
                      }
                      return { error: errCode, state: "failed" };
                    }
                    const ack = (await forwardRes.json()) as { id: string };
                    if (ack?.id) {
                      registryService.recordRun(ack.id, projectId);
                    }
                    return { result: ack, state: "acknowledged" };
                  },
                  { isScheduled },
                );
                if (cmd.state === "failed") {
                  return Response.json(
                    { error: cmd.outcome?.error || "native_launch_failed" },
                    { status: 502 },
                  );
                }
                if (cmd.state === "unknown") {
                  return Response.json(
                    { error: cmd.outcome?.error || "host_unavailable" },
                    { status: 503 },
                  );
                }
                return Response.json(
                  cmd.outcome?.result ?? { id: cmd.requestId, status: "dispatched" },
                );
              } catch (err: any) {
                if (err instanceof CommandError) {
                  const status = err.code === "storage_failed" ? 500 : 400;
                  return Response.json({ error: err.code }, { status });
                }
                return Response.json({ error: "control_failed" }, { status: 400 });
              }
            }
            const forwardRes = await forwardToHost("/internal/v1/laps", lapListSchema);
            if (forwardRes.ok) {
              try {
                const laps = (await forwardRes.clone().json()) as Array<{
                  id: string;
                  native_status: string;
                  product_status: string;
                  completed_at?: string | null;
                }>;
                for (const lap of laps) {
                  const lapProj = registryService.getRunProject(lap.id);
                  if (lapProj) {
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
                const projectRunIds = new Set(registryService.getProjectRunIds(projectId));
                const filteredLaps = laps.filter((l) => projectRunIds.has(l.id));
                return Response.json(filteredLaps);
              } catch {}
            }
            return forwardRes;
          }

          if (parts.length >= 3) {
            const lapId = decodeURIComponent(parts[2]);
            const lapProject = registryService.getRunProject(lapId);
            if (lapProject && lapProject !== projectId) {
              return Response.json({ error: "scope_mismatch" }, { status: 400 });
            }
            if (parts.length === 5 && parts[3] === "evidence" && parts[4] === "report") {
              return forwardToHost(
                `/internal/v1/laps/${encodeURIComponent(lapId)}/evidence/report`,
              );
            }
            if (parts.length === 4 && parts[3] === "evidence") {
              return forwardToHost(
                `/internal/v1/laps/${encodeURIComponent(lapId)}/evidence`,
                lapEvidenceSchema,
              );
            }
            const detailRes = await forwardToHost(
              `/internal/v1/laps/${encodeURIComponent(lapId)}`,
              lapDetailSchema,
            );
            if (detailRes.ok) {
              try {
                const detail = (await detailRes.clone().json()) as {
                  completed_at?: string | null;
                  native_status?: string;
                  product_status?: string;
                };
                const isFinished = Boolean(
                  detail.completed_at ||
                  ["completed", "failed", "stopped", "cancelled", "succeeded"].includes(
                    (detail.native_status || "").toLowerCase(),
                  ) ||
                  ["completed", "failed", "stopped", "cancelled", "succeeded"].includes(
                    (detail.product_status || "").toLowerCase(),
                  ),
                );
                if (isFinished) {
                  registryService.updateRunStatus(lapId, "completed");
                }
              } catch {}
            }
            return detailRes;
          }
        }

        if (scopedAction === "controls") {
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

        if (scopedAction === "promotion") {
          if (parts[2] === "status") {
            if (request.method !== "GET")
              return Response.json(
                { error: "method_not_allowed" },
                { status: 405, headers: { Allow: "GET" } },
              );
            return forwardToHost("/internal/v1/promotion/status", promotionStatusSchema);
          }
          if (parts[2] === "prepare") {
            if (request.method !== "POST")
              return Response.json(
                { error: "method_not_allowed" },
                { status: 405, headers: { Allow: "POST" } },
              );
            let body: unknown = {};
            try {
              const text = await request.text();
              if (text.trim().length > 0) body = JSON.parse(text);
            } catch {
              return Response.json({ error: "invalid_payload" }, { status: 400 });
            }
            const parsed = promotionSubmissionSchema.safeParse(body);
            if (!parsed.success) {
              return Response.json({ error: "invalid_payload" }, { status: 400 });
            }
            return forwardToHost("/internal/v1/promotion/prepare", promotionResultSchema, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(parsed.data),
            });
          }
        }

        if (scopedAction === "brakes") {
          const cmdService = getCommandService();
          if (request.method === "GET") {
            const state = cmdService.brakes.getProjectBrakeState(projectId);
            return Response.json(projectBrakeStateSchema.parse(state));
          }
          if (request.method === "POST") {
            let body: unknown;
            try {
              body = await request.json();
            } catch {
              return Response.json({ error: "invalid_payload" }, { status: 400 });
            }
            const parsed = projectBrakeSubmissionSchema.safeParse(body);
            if (!parsed.success) {
              return Response.json({ error: "invalid_payload" }, { status: 400 });
            }
            if (parsed.data.brake === "launch_brake") {
              const state = cmdService.brakes.setProjectLaunchBrake(
                projectId,
                parsed.data.active,
                parsed.data.actor,
                parsed.data.reason,
              );
              return Response.json(projectBrakeStateSchema.parse(state));
            }
            if (parsed.data.brake === "schedule_pause") {
              const state = cmdService.brakes.setProjectSchedulePause(
                projectId,
                parsed.data.active,
                parsed.data.actor,
                parsed.data.reason,
              );
              return Response.json(projectBrakeStateSchema.parse(state));
            }
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET, POST" } },
          );
        }

        if (scopedAction === "commands") {
          const cmdService = getCommandService();
          if (parts.length === 2) {
            if (request.method === "GET") {
              const url = new URL(request.url);
              const state = (url.searchParams.get("state") || undefined) as any;
              const limitStr = url.searchParams.get("limit");
              const limit = limitStr ? parseInt(limitStr, 10) : undefined;
              const commands = cmdService.listCommands({ projectId, state, limit });
              return Response.json(commandListSchema.parse(commands));
            }
            if (request.method === "POST") {
              let body: unknown;
              try {
                body = await request.json();
              } catch {
                return Response.json({ error: "invalid_payload" }, { status: 400 });
              }
              const bodyObj =
                typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
              const payload = { ...bodyObj, projectId };
              const parsed = commandSubmissionSchema.safeParse(payload);
              if (!parsed.success) {
                return Response.json({ error: "invalid_payload" }, { status: 400 });
              }
              try {
                const record = await cmdService.dispatch(parsed.data, async (cmd) => {
                  if (cmd.action === "launch") {
                    const forwardRes = await forwardToHost("/internal/v1/laps", launchAckSchema, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(cmd.target),
                    });
                    if (!forwardRes.ok) {
                      const errJson = (await forwardRes.json().catch(() => ({}))) as any;
                      return { error: errJson?.error || "dispatch_failed" };
                    }
                    const ack = (await forwardRes.json()) as { id: string };
                    getRegistryService().recordRun(ack.id, projectId);
                    return { result: ack, state: "acknowledged" };
                  }
                  return { result: { ok: true }, state: "succeeded" };
                });
                return Response.json(commandRecordSchema.parse(record), { status: 201 });
              } catch (err: any) {
                if (err instanceof CommandError) {
                  const status = err.code === "storage_failed" ? 500 : 400;
                  return Response.json({ error: err.code }, { status });
                }
                return Response.json({ error: "control_failed" }, { status: 400 });
              }
            }
            return Response.json(
              { error: "method_not_allowed" },
              { status: 405, headers: { Allow: "GET, POST" } },
            );
          }
          if (parts.length === 3) {
            const requestId = decodeURIComponent(parts[2]);
            if (request.method !== "GET") {
              return Response.json(
                { error: "method_not_allowed" },
                { status: 405, headers: { Allow: "GET" } },
              );
            }
            const cmd = cmdService.getCommand(requestId);
            if (!cmd || cmd.projectId !== projectId) {
              return Response.json({ error: "command_not_found" }, { status: 404 });
            }
            return Response.json(commandRecordSchema.parse(cmd));
          }
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
    "Backend startup failed: check --host, --port, FACTORY_HOST_URL, FACTORY_HOST_TOKEN and candidate identity",
  );
  process.exit(1);
}
