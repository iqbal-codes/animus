import type { ProjectRegistryService } from "../registry";
import { SettingsService } from "./service";
import { platformSettingsSchema } from "@animus/contracts/machine-config";
import { personalPreferencesSchema, projectSettingsSchema } from "./types";

export interface SettingsRouteContext {
  settingsService?: SettingsService;
  registryService?: ProjectRegistryService;
}

export async function handleSettingsRoute(
  request: Request,
  path: string,
  ctx: SettingsRouteContext = {},
): Promise<Response | null> {
  const service = ctx.settingsService ?? new SettingsService();

  const rawPath = path.split("?")[0] ?? path;
  const normalized = rawPath.startsWith("/api/v1/settings/")
    ? rawPath.slice("/api/v1/settings/".length)
    : rawPath.startsWith("/api/settings/")
      ? rawPath.slice("/api/settings/".length)
      : null;

  if (normalized === null) return null;

  // 0. Harness Models Dynamic Discovery
  if (normalized === "harness-models") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    const url = new URL(request.url);
    const provider = url.searchParams.get("provider") || "pi";
    const modelsInfo = service.getHarnessModels(provider);
    return Response.json(modelsInfo);
  }

  // 1. Personal Preferences
  if (normalized === "personal" || normalized === "preferences") {
    if (request.method === "GET") {
      return Response.json(service.getPersonalPreferences());
    }
    if (request.method === "PUT" || request.method === "POST" || request.method === "PATCH") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = personalPreferencesSchema.partial().safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload", details: parsed.error }, { status: 400 });
      }
      const updated = service.updatePersonalPreferences(parsed.data);
      return Response.json(updated);
    }
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "GET, PUT, POST, PATCH" } },
    );
  }

  // 2. Platform Settings
  if (normalized === "platform") {
    if (request.method === "GET") {
      return Response.json(service.getPlatformSettings());
    }
    if (request.method === "PUT" || request.method === "POST" || request.method === "PATCH") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = platformSettingsSchema.partial().safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload", details: parsed.error }, { status: 400 });
      }
      const updated = service.updatePlatformSettings(parsed.data);
      return Response.json(updated);
    }
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "GET, PUT, POST, PATCH" } },
    );
  }

  // 3. Project Settings
  if (normalized === "project" || normalized.startsWith("project/")) {
    const url = new URL(request.url);
    const queryProjId = url.searchParams.get("projectId");
    const pathProjId = normalized.startsWith("project/")
      ? decodeURIComponent(normalized.slice("project/".length))
      : undefined;
    const projectId = pathProjId || queryProjId;

    let repoRoot: string | undefined;
    if (projectId && ctx.registryService) {
      try {
        const proj = ctx.registryService.getProject(projectId);
        repoRoot = proj?.checkout_path;
      } catch {}
    }

    if (request.method === "GET") {
      return Response.json(service.getProjectSettings(repoRoot));
    }
    if (request.method === "PUT" || request.method === "POST" || request.method === "PATCH") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = projectSettingsSchema.partial().safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload", details: parsed.error }, { status: 400 });
      }
      const updated = service.updateProjectSettings(parsed.data, repoRoot);
      return Response.json(updated);
    }
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "GET, PUT, POST, PATCH" } },
    );
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

export async function handleProjectScopedSettingsRoute(
  request: Request,
  projectId: string,
  ctx: SettingsRouteContext = {},
): Promise<Response | null> {
  const service = ctx.settingsService ?? new SettingsService();
  let repoRoot: string | undefined;
  if (ctx.registryService) {
    try {
      const proj = ctx.registryService.getProject(projectId);
      repoRoot = proj?.checkout_path;
    } catch {}
  }

  if (request.method === "GET") {
    return Response.json(service.getProjectSettings(repoRoot));
  }
  if (request.method === "PUT" || request.method === "POST" || request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const parsed = projectSettingsSchema.partial().safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload", details: parsed.error }, { status: 400 });
    }
    const updated = service.updateProjectSettings(parsed.data, repoRoot);
    return Response.json(updated);
  }
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "GET, PUT, POST, PATCH" } },
  );
}
