import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type PersonalPreferences,
  personalPreferencesSchema,
  type PlatformSettings,
  platformSettingsSchema,
  type PlatformSettingsUpdate,
  type ProjectSettings,
  projectSettingsSchema,
  type ProjectSettingsUpdate,
} from "./types";

const DEFAULT_PLATFORM_PROVIDERS = [
  {
    id: "pi",
    name: "Pi Coding Agent",
    binary: "pi",
    path: "/opt/homebrew/bin/pi",
    version: "v0.42.1",
    efforts: "minimal · low · medium · high · xhigh · max",
    capabilities: "Resume · Fork · Native Tools",
    status: "INSTALLED" as const,
    enabled: true,
  },
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    path: "/usr/local/bin/claude",
    version: "v1.0.24 (built-in)",
    efforts: "low · medium · high · xhigh · max",
    capabilities: "Resume · Fork · Strict MCP",
    status: "INSTALLED" as const,
    enabled: true,
  },
  {
    id: "omp",
    name: "Oh-My-Pi (OMP)",
    binary: "omp",
    path: "/Users/efishery/.bun/bin/omp",
    version: "v0.9.4",
    efforts: "minimal · low · medium · high · xhigh · max",
    capabilities: "Resume · Fork · Extension Hooks",
    status: "INSTALLED" as const,
    enabled: false,
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    binary: "codex",
    path: "codex exec --json",
    version: "built-in adapter",
    efforts: "minimal · low · medium · high · xhigh · max · ultra",
    capabilities: "Resume · Effort Clamping",
    status: "COMING SOON" as const,
    enabled: false,
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    path: "opencode run --format json",
    version: "standalone",
    efforts: "low · medium · high",
    capabilities: "Resume · Auto Mode",
    status: "COMING SOON" as const,
    enabled: false,
  },
];

export class SettingsService {
  private userAnimusDir: string;
  private defaultRepoRoot: string;

  constructor(
    options: {
      userAnimusDir?: string;
      defaultRepoRoot?: string;
    } = {},
  ) {
    this.userAnimusDir =
      options.userAnimusDir || process.env.ANIMUS_HOME || join(homedir(), ".animus");
    this.defaultRepoRoot =
      options.defaultRepoRoot || process.env.FACTORY_REPO_ROOT || process.cwd();
  }

  private ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    }
  }

  private atomicWrite(filePath: string, content: string): void {
    this.ensureDir(dirname(filePath));
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, filePath);
  }

  // ==========================================
  // Personal Preferences (~/.animus/preferences.json)
  // ==========================================
  getPersonalPreferences(): PersonalPreferences {
    const filePath = join(this.userAnimusDir, "preferences.json");
    if (!existsSync(filePath)) {
      return personalPreferencesSchema.parse({});
    }
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return personalPreferencesSchema.parse(raw);
    } catch {
      return personalPreferencesSchema.parse({});
    }
  }

  updatePersonalPreferences(updates: Partial<PersonalPreferences>): PersonalPreferences {
    const current = this.getPersonalPreferences();
    const merged = { ...current, ...updates };
    const validated = personalPreferencesSchema.parse(merged);
    const filePath = join(this.userAnimusDir, "preferences.json");
    this.atomicWrite(filePath, JSON.stringify(validated, null, 2));
    return validated;
  }

  // ==========================================
  // Platform Settings (~/.animus/config.json)
  // ==========================================
  getPlatformSettings(): PlatformSettings {
    const filePath = join(this.userAnimusDir, "config.json");
    if (!existsSync(filePath)) {
      return platformSettingsSchema.parse({
        providers: DEFAULT_PLATFORM_PROVIDERS,
      });
    }
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      if (!raw.providers || raw.providers.length === 0) {
        raw.providers = DEFAULT_PLATFORM_PROVIDERS;
      }
      return platformSettingsSchema.parse(raw);
    } catch {
      return platformSettingsSchema.parse({
        providers: DEFAULT_PLATFORM_PROVIDERS,
      });
    }
  }

  updatePlatformSettings(updates: PlatformSettingsUpdate): PlatformSettings {
    const current = this.getPlatformSettings();
    const merged = {
      system: { ...current.system, ...updates.system },
      providers: updates.providers ?? current.providers,
      automation: { ...current.automation, ...updates.automation },
      github: { ...current.github, ...updates.github },
    };
    const validated = platformSettingsSchema.parse(merged);
    const filePath = join(this.userAnimusDir, "config.json");
    this.atomicWrite(filePath, JSON.stringify(validated, null, 2));
    return validated;
  }

  // ==========================================
  // Project Settings (<repoRoot>)
  // ==========================================
  getProjectSettings(repoRoot = this.defaultRepoRoot): ProjectSettings {
    // 1. Models & Releases: .animus/config.yaml
    const animusYamlPath = join(repoRoot, ".animus/config.yaml");
    let modelsData = {};
    let releasesData = {};
    if (existsSync(animusYamlPath)) {
      try {
        const parsed = parseYaml(readFileSync(animusYamlPath, "utf-8"));
        if (parsed && typeof parsed === "object") {
          modelsData = parsed;
          if (parsed.releases && typeof parsed.releases === "object") {
            releasesData = parsed.releases;
          }
        }
      } catch {}
    }

    // 2. Checks: .factory/tool-guidance.json
    const toolGuidancePath = join(repoRoot, ".factory/tool-guidance.json");
    let checksData: any = {};
    if (existsSync(toolGuidancePath)) {
      try {
        const parsed = JSON.parse(readFileSync(toolGuidancePath, "utf-8"));
        if (parsed && typeof parsed === "object") {
          const rawGuidance: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string" && k !== "protectedPaths") {
              rawGuidance[k] = v;
            }
          }
          checksData = {
            staticCmd: parsed.staticCmd || parsed.check || "bun run check",
            unitCmd: parsed.unitCmd || parsed.test || "bun test",
            countPattern: parsed.countPattern || "Tests\\s+(\\d+)\\s+passed",
            protectedPaths: Array.isArray(parsed.protectedPaths)
              ? parsed.protectedPaths
              : typeof parsed.protectedPaths === "string"
                ? parsed.protectedPaths
                    .split(",")
                    .map((s: string) => s.trim())
                    .filter(Boolean)
                : ["MISSION.md", "FACTORY.md", "harness/**"],
            toolGuidance: rawGuidance,
          };
        }
      } catch {}
    }

    // 3. Rules: .factory/codebase-rules.json
    const rulesPath = join(repoRoot, ".factory/codebase-rules.json");
    let rulesData = [];
    if (existsSync(rulesPath)) {
      try {
        const parsed = JSON.parse(readFileSync(rulesPath, "utf-8"));
        if (Array.isArray(parsed)) {
          rulesData = parsed;
        } else if (parsed && Array.isArray(parsed.rules)) {
          rulesData = parsed.rules;
        }
      } catch {}
    }

    // 4. Schedule: .factory/schedule.json
    const schedulePath = join(repoRoot, ".factory/schedule.json");
    let scheduleData = {};
    if (existsSync(schedulePath)) {
      try {
        const parsed = JSON.parse(readFileSync(schedulePath, "utf-8"));
        if (parsed && typeof parsed === "object") {
          scheduleData = parsed;
        }
      } catch {}
    }

    return projectSettingsSchema.parse({
      models: modelsData,
      checks: checksData,
      rules: rulesData,
      schedule: scheduleData,
      releases: releasesData,
    });
  }

  updateProjectSettings(
    updates: ProjectSettingsUpdate,
    repoRoot = this.defaultRepoRoot,
  ): ProjectSettings {
    const current = this.getProjectSettings(repoRoot);
    const merged = {
      models: { ...current.models, ...updates.models },
      checks: { ...current.checks, ...updates.checks },
      rules: updates.rules ?? current.rules,
      schedule: { ...current.schedule, ...updates.schedule },
      releases: { ...current.releases, ...updates.releases },
    };
    const validated = projectSettingsSchema.parse(merged);

    // Write 1. .animus/config.yaml
    const animusYamlPath = join(repoRoot, ".animus/config.yaml");
    let existingYaml: Record<string, unknown> = {};
    if (existsSync(animusYamlPath)) {
      try {
        const parsed = parseYaml(readFileSync(animusYamlPath, "utf-8"));
        if (parsed && typeof parsed === "object") {
          existingYaml = parsed as Record<string, unknown>;
        }
      } catch {}
    }
    const mergedYaml = {
      ...existingYaml,
      ...validated.models,
      releases: validated.releases,
    };
    this.atomicWrite(animusYamlPath, stringifyYaml(mergedYaml));

    // Write 2. .factory/tool-guidance.json
    const toolGuidancePath = join(repoRoot, ".factory/tool-guidance.json");
    const guidanceContent = {
      ...validated.checks.toolGuidance,
      staticCmd: validated.checks.staticCmd,
      unitCmd: validated.checks.unitCmd,
      countPattern: validated.checks.countPattern,
      protectedPaths: validated.checks.protectedPaths,
    };
    this.atomicWrite(toolGuidancePath, JSON.stringify(guidanceContent, null, 2));

    // Write 3. .factory/codebase-rules.json
    const rulesPath = join(repoRoot, ".factory/codebase-rules.json");
    this.atomicWrite(rulesPath, JSON.stringify(validated.rules, null, 2));

    // Write 4. .factory/schedule.json
    const schedulePath = join(repoRoot, ".factory/schedule.json");
    this.atomicWrite(schedulePath, JSON.stringify(validated.schedule, null, 2));

    return validated;
  }
}
