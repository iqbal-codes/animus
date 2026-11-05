import {
  launchSubmissionSchema,
  launchAckSchema,
  lapListSchema,
  lapDetailSchema,
  lapEvidenceSchema,
  controlSubmissionSchema,
  controlStateSchema,
  promotionStatusSchema,
  promotionSubmissionSchema,
  promotionResultSchema,
  globalBrakeStateSchema,
  projectBrakeStateSchema,
  brakeSubmissionSchema,
  projectBrakeSubmissionSchema,
  commandSubmissionSchema,
  commandListSchema,
  commandRecordSchema,
  commandReconciliationResultSchema,
  backupSubmissionSchema,
  backupResultSchema,
} from "@animus/contracts/operator";
import { CommandError, type CommandService } from "./command";
import type { ProjectRegistryService } from "./registry";

export interface RouteContext {
  commandService: CommandService;
  registryService: ProjectRegistryService;
  forwardToHost: (internalPath: string, schema?: any, init?: RequestInit) => Promise<Response>;
  broadcastWsEvent: (event: {
    id?: string;
    seq?: number;
    type: "log" | "lifecycle" | "invalidation" | "gap" | "heartbeat";
    projectId?: string;
    lapId?: string;
    timestamp?: string;
    payload: Record<string, unknown>;
  }) => void;
}

export async function handleLapsRoute(
  request: Request,
  parts: string[],
  ctx: RouteContext,
  projectId?: string,
): Promise<Response> {
  const { commandService: cmdService, registryService, forwardToHost, broadcastWsEvent } = ctx;

  if (parts.length === 1) {
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
            if (ack?.id && projectId) {
              registryService.recordRun(ack.id, projectId);
            }
            return { result: ack, state: "acknowledged" };
          },
          projectId ? { isScheduled } : undefined,
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
        return Response.json(cmd.outcome?.result ?? { id: cmd.requestId, status: "dispatched" });
      } catch (err: any) {
        if (err instanceof CommandError) {
          const status = err.code === "storage_failed" ? 500 : 400;
          return Response.json({ error: err.code }, { status });
        }
        return Response.json({ error: "control_failed" }, { status: 400 });
      } finally {
        broadcastWsEvent({
          type: "invalidation",
          projectId,
          payload: { scope: "laps" },
        });
      }
    }

    if (request.method === "GET") {
      const forwardRes = await forwardToHost("/internal/v1/laps", lapListSchema);
      if (!projectId) {
        return forwardRes;
      }
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

    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "GET, POST" } },
    );
  }

  if (parts.length >= 2) {
    const lapId = decodeURIComponent(parts[1]);
    if (projectId) {
      const lapProject = registryService.getRunProject(lapId);
      if (lapProject && lapProject !== projectId) {
        return Response.json({ error: "scope_mismatch" }, { status: 400 });
      }
    }

    if (parts.length === 4 && parts[2] === "evidence" && parts[3] === "report") {
      return forwardToHost(`/internal/v1/laps/${encodeURIComponent(lapId)}/evidence/report`);
    }
    if (parts.length === 3 && parts[2] === "evidence") {
      return forwardToHost(
        `/internal/v1/laps/${encodeURIComponent(lapId)}/evidence`,
        lapEvidenceSchema,
      );
    }

    const detailRes = await forwardToHost(
      `/internal/v1/laps/${encodeURIComponent(lapId)}`,
      lapDetailSchema,
    );
    if (projectId && detailRes.ok) {
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

  return Response.json({ error: "not_found" }, { status: 404 });
}

export async function handleControlsRoute(
  request: Request,
  ctx: RouteContext,
  _projectId?: string,
): Promise<Response> {
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
    return ctx.forwardToHost("/internal/v1/controls", controlStateSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
  }
  if (request.method === "GET") {
    return ctx.forwardToHost("/internal/v1/controls", controlStateSchema);
  }
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}

export async function handlePromotionRoute(
  request: Request,
  parts: string[],
  ctx: RouteContext,
  _projectId?: string,
): Promise<Response> {
  if (parts[1] === "status") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    return ctx.forwardToHost("/internal/v1/promotion/status", promotionStatusSchema);
  }
  if (parts[1] === "prepare") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
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
    return ctx.forwardToHost("/internal/v1/promotion/prepare", promotionResultSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

export async function handleBrakesRoute(
  request: Request,
  ctx: RouteContext,
  projectId?: string,
): Promise<Response> {
  const cmdService = ctx.commandService;

  if (request.method === "GET") {
    if (projectId) {
      const state = cmdService.brakes.getProjectBrakeState(projectId);
      return Response.json(projectBrakeStateSchema.parse(state));
    }
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

    if (projectId) {
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

export async function handleCommandsRoute(
  request: Request,
  parts: string[],
  ctx: RouteContext,
  projectId?: string,
): Promise<Response> {
  const cmdService = ctx.commandService;

  if (parts.length === 1) {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const targetProjectId = projectId ?? (url.searchParams.get("projectId") || undefined);
      const state = (url.searchParams.get("state") || undefined) as any;
      const limitStr = url.searchParams.get("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;
      const commands = cmdService.listCommands({ projectId: targetProjectId, state, limit });
      return Response.json(commandListSchema.parse(commands));
    }

    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const payload = projectId
        ? {
            ...(typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}),
            projectId,
          }
        : body;
      const parsed = commandSubmissionSchema.safeParse(payload);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      try {
        const record = await cmdService.dispatch(parsed.data, async (cmd) => {
          if (cmd.action === "launch") {
            const forwardRes = await ctx.forwardToHost("/internal/v1/laps", launchAckSchema, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(cmd.target),
            });
            if (!forwardRes.ok) {
              const errJson = (await forwardRes.json().catch(() => ({}))) as any;
              return { error: errJson?.error || "dispatch_failed" };
            }
            const ack = (await forwardRes.json()) as { id: string };
            const effectiveProj = cmd.projectId ?? projectId;
            if (effectiveProj) {
              ctx.registryService.recordRun(ack.id, effectiveProj);
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

  if (parts.length === 2) {
    if (!projectId && parts[1] === "reconcile") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      const result = await cmdService.reconcile();
      return Response.json(commandReconciliationResultSchema.parse(result));
    }

    if (!projectId && parts[1] === "backup") {
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
      try {
        const result = cmdService.backupDatabase(parsed.data.destinationPath);
        return Response.json(backupResultSchema.parse(result));
      } catch (err: any) {
        return Response.json({ error: err?.code || "backup_failed" }, { status: 500 });
      }
    }

    const requestId = decodeURIComponent(parts[1]);
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    const cmd = cmdService.getCommand(requestId);
    if (!cmd || (projectId && cmd.projectId !== projectId)) {
      return Response.json({ error: "command_not_found" }, { status: 404 });
    }
    return Response.json(commandRecordSchema.parse(cmd));
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
