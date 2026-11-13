import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  machineConfigPath,
  platformSettingsSchema,
  readMachineConfig,
  writeMachineConfig,
} from "@animus/contracts/machine-config";
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

  test("Platform settings read default and write persists to config.yaml", async () => {
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

    const onDisk = readMachineConfig(testUserDir)!;
    expect(onDisk.system.remoteAccess).toBe(true);
    expect(onDisk.automation.parallelJobs).toBe(4);
  });

  test("Project settings update writes tiers, role->tier routing, checks, and rules cleanly", async () => {
    const updated = service.updateProjectSettings({
      models: {
        tiers: {
          small: { provider: "pi", model: "default", effort: "medium" },
          medium: { provider: "claude", model: "claude-3-5-sonnet", effort: "high" },
          large: { provider: "claude", model: "claude-3-7-sonnet", effort: "max" },
          xhigh: { provider: "codex", model: "gpt-5.3-codex", effort: "xhigh" },
        },
        roles: {
          triage: "medium",
          planner: "xhigh",
          builder: "medium",
          qa: "small",
          reviewer: "xhigh",
          reflector: "large",
        },
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

    expect(updated.models.tiers?.medium?.model).toBe("claude-3-5-sonnet");
    expect(updated.models.tiers?.xhigh?.model).toBe("gpt-5.3-codex");
    expect(updated.models.roles?.planner).toBe("xhigh");
    expect(updated.models.concurrencyLimit).toBe(3);

    expect(existsSync(join(testRepoDir, ".animus/config.yaml"))).toBe(true);
    expect(existsSync(join(testRepoDir, ".animus/tool-guidance.json"))).toBe(true);
    expect(existsSync(join(testRepoDir, ".animus/codebase-rules.json"))).toBe(true);

    const yamlContent = readFileSync(join(testRepoDir, ".animus/config.yaml"), "utf-8");
    expect(yamlContent).toContain("claude-3-5-sonnet");
    expect(yamlContent).toContain("xhigh:");
    expect(yamlContent).toContain("planner: xhigh");
    expect(yamlContent).toContain("concurrencyLimit: 3");
    expect(yamlContent).not.toContain("@reasoning");
    expect(yamlContent).not.toContain("defaultModel:");
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

  test("platform settings updates preserve the onboarding marker and owner-only permissions", () => {
    const configPath = machineConfigPath(testUserDir);
    writeMachineConfig(
      platformSettingsSchema.parse({
        schemaVersion: 1,
        system: {
          onboardedAt: "2026-01-01T00:00:00.000Z",
          runtimeRoot: "/opt/animus/source",
          defaultProvider: "pi",
        },
        providers: [],
      }),
      testUserDir,
    );

    const updated = service.updatePlatformSettings({ system: { remoteAccess: true } });

    expect(updated.system.onboardedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.system.runtimeRoot).toBe("/opt/animus/source");
    expect(updated.schemaVersion).toBe(1);

    const stored = readMachineConfig(testUserDir)!;
    expect(stored.system.onboardedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(stored.system.remoteAccess).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("Harness models dynamic discovery returns models and efforts across all supported harnesses", async () => {
    const piModels = await service.getHarnessModels("pi");
    expect(piModels.provider).toBe("pi");
    expect(Array.isArray(piModels.models)).toBe(true);
    expect(piModels.models.length).toBeGreaterThan(0);
    expect(piModels.models).toContain("default");
    expect(piModels.supportedEfforts).toContain("medium");
    expect(piModels.supportedEfforts).toContain("high");

    for (const provider of ["claude", "omp", "commandcode", "codex", "opencode"] as const) {
      const info = await service.getHarnessModels(provider);
      expect(info.provider).toBe(provider);
      expect(info.models).toContain("default");
      expect(info.supportedEfforts.length).toBeGreaterThan(0);
    }

    const req = new Request("http://localhost:3000/api/v1/settings/harness-models?provider=claude");
    const res = await handleSettingsRoute(req, "/api/v1/settings/harness-models?provider=claude", {
      settingsService: service,
    });
    expect(res?.status).toBe(200);
    const body = await res?.json();
    expect(body.provider).toBe("claude");
    expect(body.models).toContain("claude-3-7-sonnet");
    expect(body.supportedEfforts).toContain("max");
  }, 20_000);
  test("Project settings support distinct harnesses/models/efforts per tier, baseBranch, user-level tier inheritance, and harness config sync", async () => {
    service.updatePlatformSettings({
      system: { defaultProvider: "omp" },
      tiers: {
        small: { provider: "omp", model: "9router/ag/gemini-3.8-flash", effort: "low" },
        medium: { provider: "claude", model: "claude-sonnet-4-6", effort: "high" },
        large: { provider: "codex", model: "gpt-5.3-codex", effort: "xhigh" },
      },
    });

    const inherited = service.getProjectSettings();
    expect(inherited.models.tiers?.small).toEqual({
      provider: "omp",
      model: "9router/ag/gemini-3.8-flash",
      effort: "low",
    });
    expect(inherited.models.tiers?.medium).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
    });
    expect(inherited.models.tiers?.large).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      effort: "xhigh",
    });
    expect(inherited.models.roles).toEqual({
      triage: "medium",
      planner: "large",
      builder: "medium",
      qa: "small",
      reviewer: "large",
      reflector: "large",
    });

    const updated = service.updateProjectSettings({
      models: {
        baseBranch: "develop",
        tiers: {
          small: { provider: "omp", model: "9router/ag/gemini-3.8-flash", effort: "low" },
          medium: { provider: "claude", model: "claude-sonnet-4-6", effort: "high" },
          large: { provider: "codex", model: "gpt-5.3-codex", effort: "xhigh" },
        },
        roles: {
          triage: "small",
          planner: "large",
          builder: "medium",
          qa: "small",
          reviewer: "large",
          reflector: "large",
        },
      },
      checks: {
        staticCmd: "bun run check",
        unitCmd: "bun test",
        countPattern: "(\\d+)\\s+pass",
        protectedPaths: ["harness/**", ".animus/**"],
      },
    });

    expect(updated.models.baseBranch).toBe("develop");
    expect(updated.models.roles?.triage).toBe("small");

    const yamlContent = readFileSync(join(testRepoDir, ".animus/config.yaml"), "utf-8");
    expect(yamlContent).toContain("baseBranch: develop");
    expect(yamlContent).toContain("provider: omp");
    expect(yamlContent).toContain("provider: claude");
    expect(yamlContent).toContain("provider: codex");
    expect(yamlContent).toContain("triage: small");

    const harnessConfig = JSON.parse(
      readFileSync(join(testRepoDir, "harness/harness.config.json"), "utf-8"),
    );
    expect(harnessConfig.static).toBe("bun run check");
    expect(harnessConfig.unit).toBe("bun test");
    expect(harnessConfig.unit_count_pattern).toBe("(\\d+)\\s+pass");
  });
});
