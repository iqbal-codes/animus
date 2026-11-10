import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../apps/backend/src/settings/service";
import {
  handleSettingsRoute,
  handleProjectScopedSettingsRoute,
} from "../../apps/backend/src/settings/routes";

describe("Settings Service & Backend Routes", () => {
  let testUserDir: string;
  let testRepoDir: string;
  let service: SettingsService;

  beforeEach(() => {
    testUserDir = mkdtempSync(join(tmpdir(), "animus-user-settings-"));
    testRepoDir = mkdtempSync(join(tmpdir(), "animus-repo-settings-"));
    service = new SettingsService({
      userAnimusDir: testUserDir,
      defaultRepoRoot: testRepoDir,
    });
  });

  afterEach(() => {
    try {
      rmSync(testUserDir, { recursive: true, force: true });
      rmSync(testRepoDir, { recursive: true, force: true });
    } catch {}
  });

  test("Personal preferences read default and write persists to preferences.json", async () => {
    const initial = service.getPersonalPreferences();
    expect(initial.theme).toBe("dark");
    expect(initial.cardDensity).toBe("comfortable");

    const updated = service.updatePersonalPreferences({
      cardDensity: "compact",
      startupView: "jobs",
    });
    expect(updated.cardDensity).toBe("compact");
    expect(updated.startupView).toBe("jobs");

    const onDisk = JSON.parse(readFileSync(join(testUserDir, "preferences.json"), "utf-8"));
    expect(onDisk.cardDensity).toBe("compact");
    expect(onDisk.startupView).toBe("jobs");
  });

  test("Platform settings read default and write persists to config.json", async () => {
    const initial = service.getPlatformSettings();
    expect(initial.system.remoteAccess).toBe(false);

    const updated = service.updatePlatformSettings({
      system: {
        remoteAccess: true,
        bindAddress: "127.0.0.1",
        vaultEnabled: true,
        hostOrigin: "http://127.0.0.1:4000",
      },
      automation: {
        parallelJobs: 4,
        maxLaps: 5,
        pollInterval: 120,
        continuations: 2,
        limitWorkWindow: false,
        startTime: "18:00",
        endTime: "06:00",
        timezone: "UTC",
        schedulePaused: false,
        globalBrake: false,
      },
    });
    expect(updated.system.remoteAccess).toBe(true);
    expect(updated.automation.parallelJobs).toBe(4);

    const onDisk = JSON.parse(readFileSync(join(testUserDir, "config.json"), "utf-8"));
    expect(onDisk.system.remoteAccess).toBe(true);
    expect(onDisk.automation.parallelJobs).toBe(4);
  });

  test("Project settings update writes to .animus/config.yaml, .factory/tool-guidance.json, and rules", async () => {
    const updated = service.updateProjectSettings({
      models: {
        defaultModel: "claude-3-5-sonnet",
        plannerModel: "claude-3-7-sonnet",
        builderModel: "claude-3-5-sonnet",
        reviewerModel: "claude-3-7-sonnet",
        worktreeStrategy: "isolated",
        concurrencyLimit: 3,
      },
      checks: {
        staticCmd: "bun run check",
        unitCmd: "bun test",
        countPattern: "Passed (\\d+)",
        protectedPaths: ["MISSION.md"],
        toolGuidance: { test: "bun test" },
      },
      rules: [{ id: "rule-1", name: "Strict typing", description: "No any", enabled: true }],
    });

    expect(updated.models.defaultModel).toBe("claude-3-5-sonnet");
    expect(updated.models.concurrencyLimit).toBe(3);

    expect(existsSync(join(testRepoDir, ".animus/config.yaml"))).toBe(true);
    expect(existsSync(join(testRepoDir, ".factory/tool-guidance.json"))).toBe(true);
    expect(existsSync(join(testRepoDir, ".factory/codebase-rules.json"))).toBe(true);

    const yamlContent = readFileSync(join(testRepoDir, ".animus/config.yaml"), "utf-8");
    expect(yamlContent).toContain("defaultModel: claude-3-5-sonnet");
    expect(yamlContent).toContain("concurrencyLimit: 3");
  });

  test("handleSettingsRoute handles HTTP GET and PUT for personal and platform", async () => {
    // GET personal
    const getPersonalReq = new Request("http://localhost:3000/api/v1/settings/personal");
    const getPersonalRes = await handleSettingsRoute(getPersonalReq, "/api/v1/settings/personal", {
      settingsService: service,
    });
    expect(getPersonalRes?.status).toBe(200);
    const personalData = await getPersonalRes?.json();
    expect(personalData.cardDensity).toBe("comfortable");

    // PUT personal
    const putPersonalReq = new Request("http://localhost:3000/api/v1/settings/personal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardDensity: "compact" }),
    });
    const putPersonalRes = await handleSettingsRoute(putPersonalReq, "/api/v1/settings/personal", {
      settingsService: service,
    });
    expect(putPersonalRes?.status).toBe(200);
    const updatedPersonal = await putPersonalRes?.json();
    expect(updatedPersonal.cardDensity).toBe("compact");

    // GET platform
    const getPlatformReq = new Request("http://localhost:3000/api/v1/settings/platform");
    const getPlatformRes = await handleSettingsRoute(getPlatformReq, "/api/v1/settings/platform", {
      settingsService: service,
    });
    expect(getPlatformRes?.status).toBe(200);

    // PUT project
    const putProjectReq = new Request("http://localhost:3000/api/v1/settings/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: { concurrencyLimit: 4 },
      }),
    });
    const putProjectRes = await handleSettingsRoute(putProjectReq, "/api/v1/settings/project", {
      settingsService: service,
    });
    expect(putProjectRes?.status).toBe(200);
    const updatedProj = await putProjectRes?.json();
    expect(updatedProj.models.concurrencyLimit).toBe(4);
    // Project-scoped route
    const scopedReq = new Request("http://localhost:3000/api/v1/projects/proj-1/settings");
    const scopedRes = await handleProjectScopedSettingsRoute(scopedReq, "proj-1", {
      settingsService: service,
    });
    expect(scopedRes?.status).toBe(200);
    const scopedData = await scopedRes?.json();
    expect(scopedData.models.concurrencyLimit).toBe(4);
  });

  test("Harness models dynamic discovery returns real models and supported efforts", async () => {
    // 1. Service direct call
    const piModels = service.getHarnessModels("pi");
    expect(piModels.provider).toBe("pi");
    expect(piModels.models).toBeArray();
    expect(piModels.models.length).toBeGreaterThan(0);
    expect(piModels.models).toContain("default");
    expect(piModels.supportedEfforts).toBeArray();
    expect(piModels.supportedEfforts).toContain("medium");
    expect(piModels.supportedEfforts).toContain("high");

    const claudeModels = service.getHarnessModels("claude");
    expect(claudeModels.provider).toBe("claude");
    expect(claudeModels.models).toContain("default");
    expect(claudeModels.models).toContain("claude-3-5-sonnet");
    expect(claudeModels.supportedEfforts).toContain("high");

    // 2. HTTP route via handleSettingsRoute
    const req = new Request("http://localhost:3000/api/v1/settings/harness-models?provider=claude");
    const res = await handleSettingsRoute(req, "/api/v1/settings/harness-models?provider=claude", {
      settingsService: service,
    });
    expect(res?.status).toBe(200);
    const body = await res?.json();
    expect(body.provider).toBe("claude");
    expect(body.models).toContain("claude-3-7-sonnet");
    expect(body.supportedEfforts).toContain("max");
  });
});
