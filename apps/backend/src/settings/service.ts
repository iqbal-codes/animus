import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type PlatformSettings,
  platformSettingsSchema,
  type PlatformSettingsUpdate,
  readMachineConfig,
  writeMachineConfig,
} from "@animus/contracts/machine-config";
import {
  readRepoConfig,
  writeRepoConfig,
  type RepoConfigFile,
} from "@animus/contracts/repo-config";
import {
  type PersonalPreferences,
  personalPreferencesSchema,
  type ProjectSettings,
  projectSettingsSchema,
  type ProjectSettingsUpdate,
} from "./types";

/**
 * A partial settings update must never erase a stored value by passing the key
 * as `undefined`. The onboarding marker and runtime root are owned by
 * `animus onboard` and must survive every platform settings save.
 */
function omitUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

const FALLBACK_HARNESS_MODELS: Record<string, string[]> = {
  pi: [
    "default",
    "google-vertex/gemini-2.5-pro",
    "google-vertex/gemini-2.5-flash",
    "google-vertex/gemini-3.7-flash",
    "google-vertex/gemini-3.8-flash",
    "openai/gpt-5",
    "openai/gpt-4o",
    "openai/o3-mini",
    "minimax/MiniMax-M3",
  ],
  claude: [
    "default",
    "claude-3-7-sonnet",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5",
  ],
  omp: [
    "default",
    "opus",
    "sonnet",
    "gpt-5.2",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "deepseek-v4.1-flash",
  ],
  codex: [
    "default",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2-codex",
    "o3-mini",
    "o4-mini",
    "gpt-4o",
  ],
  opencode: ["default", "opencode-zen", "opencode-go", "deepseek-coder", "claude-3-5-sonnet"],
  commandcode: ["default", "commandcode-default", "claude-3-7-sonnet", "gpt-4o"],
};

const HARNESS_EFFORTS: Record<string, string[]> = {
  pi: ["minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  omp: ["minimal", "low", "medium", "high", "xhigh", "max"],
  commandcode: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  opencode: ["low", "medium", "high"],
};

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
  // Platform Settings (~/.animus/config.yaml)
  // ==========================================
  /**
   * Absent or unreadable machine configuration returns schema defaults with an
   * empty provider list. Provider rows are never invented here: `animus onboard`
   * writes the fleet it actually detected on this machine.
   */
  getPlatformSettings(): PlatformSettings {
    return readMachineConfig(this.userAnimusDir) ?? platformSettingsSchema.parse({});
  }

  updatePlatformSettings(updates: PlatformSettingsUpdate): PlatformSettings {
    const current = this.getPlatformSettings();
    const merged = {
      schemaVersion: current.schemaVersion,
      system: { ...current.system, ...omitUndefined(updates.system) },
      providers: updates.providers ?? current.providers,
      automation: { ...current.automation, ...omitUndefined(updates.automation) },
      github: { ...current.github, ...omitUndefined(updates.github) },
    };
    const validated = platformSettingsSchema.parse(merged);
    writeMachineConfig(validated, this.userAnimusDir);
    return validated;
  }

  // ==========================================
  // Harness Models Discovery & Efforts
  // ==========================================
  getHarnessModels(providerId = "pi"): {
    provider: string;
    models: string[];
    supportedEfforts: string[];
    defaultEffort: string;
  } {
    const provider = providerId.toLowerCase();
    const supportedEfforts = HARNESS_EFFORTS[provider] || ["low", "medium", "high", "max"];
    const defaultEffort = supportedEfforts.includes("high")
      ? "high"
      : supportedEfforts[0] || "medium";

    if (provider === "pi") {
      try {
        const res = spawnSync("pi", ["--list-models"], {
          timeout: 3000,
          encoding: "utf-8",
        });
        if (res.status === 0 && res.stdout) {
          const lines = res.stdout.trim().split("\n");
          const parsedModels = new Set<string>(["default"]);
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].trim().split(/\s+/);
            if (parts.length >= 2) {
              const prov = parts[0];
              const mod = parts[1];
              parsedModels.add(prov ? `${prov}/${mod}` : mod);
            }
          }
          if (parsedModels.size > 1) {
            return {
              provider,
              models: Array.from(parsedModels),
              supportedEfforts,
              defaultEffort,
            };
          }
        }
      } catch {}
    }

    const fallback = FALLBACK_HARNESS_MODELS[provider] || ["default"];
    return {
      provider,
      models: fallback,
      supportedEfforts,
      defaultEffort,
    };
  }

  // ==========================================
  // Project Settings (<repoRoot>)
  // ==========================================
  getProjectSettings(repoRoot = this.defaultRepoRoot): ProjectSettings {
    // 1. Models, releases, and loop policy: <repo>/.animus/config.yaml
    //    A pre-existing schedule.json is folded in and removed by this read.
    const repoConfig = readRepoConfig(repoRoot);
    const modelsData = projectModelsFromConfig(repoConfig);

    // 2. Checks: .animus/tool-guidance.json (with fallback to .factory/tool-guidance.json)
    const animusToolGuidance = join(repoRoot, ".animus/tool-guidance.json");
    const factoryToolGuidance = join(repoRoot, ".factory/tool-guidance.json");
    const toolGuidancePath = existsSync(animusToolGuidance)
      ? animusToolGuidance
      : factoryToolGuidance;
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
                : ["harness/**", ".animus/holdout/**", ".animus/hooks/**"],
            toolGuidance: rawGuidance,
          };
        }
      } catch {}
    }

    // 3. Rules: .animus/codebase-rules.json (with fallback to .factory/codebase-rules.json)
    const animusRules = join(repoRoot, ".animus/codebase-rules.json");
    const factoryRules = join(repoRoot, ".factory/codebase-rules.json");
    const rulesPath = existsSync(animusRules) ? animusRules : factoryRules;
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

    return projectSettingsSchema.parse({
      models: modelsData,
      checks: checksData,
      rules: rulesData,
      releases: repoConfig.releases ?? {},
    });
  }

  updateProjectSettings(
    updates: ProjectSettingsUpdate,
    repoRoot = this.defaultRepoRoot,
  ): ProjectSettings {
    const currentConfig = readRepoConfig(repoRoot);
    const current = this.getProjectSettings(repoRoot);
    const nextModels = { ...current.models, ...omitUndefined(updates.models) };
    const nextChecks = { ...current.checks, ...omitUndefined(updates.checks) };
    const nextReleases = updates.releases
      ? { ...current.releases, ...omitUndefined(updates.releases) }
      : current.releases;

    const validated = projectSettingsSchema.parse({
      models: nextModels,
      checks: nextChecks,
      rules: updates.rules ?? current.rules,
      releases: nextReleases,
    });

    // The UI's model fields are a projection over `assistant`, `assistants`,
    // `tiers`, `aliases`, and `worktree`. Map them back onto those keys and
    // never persist the derived duplicates (plannerModel, reviewerModel, ...).
    const assistant = validated.models.assistant || currentConfig.assistant || "pi";
    const tiers = { ...currentConfig.tiers } as Record<string, Record<string, unknown>>;
    const defaultTierEfforts: Record<string, string> = {
      small: "medium",
      medium: validated.models.effort,
      large:
        validated.models.effort === "max" || validated.models.effort === "xhigh"
          ? validated.models.effort
          : "high",
    };
    for (const tier of ["small", "medium", "large"]) {
      const existing = tiers[tier];
      tiers[tier] = existing
        ? { ...existing, provider: assistant }
        : {
            provider: assistant,
            model: validated.models.defaultModel,
            effort: defaultTierEfforts[tier],
          };
    }
    if (tiers.medium) tiers.medium.effort = validated.models.effort;

    const aliases = { ...currentConfig.aliases } as Record<string, Record<string, unknown>>;
    aliases["@reasoning"] = {
      provider: assistant,
      model:
        (typeof aliases["@reasoning"]?.model === "string" && aliases["@reasoning"].model) ||
        validated.models.defaultModel,
      effort: validated.models.effort === "max" ? "max" : "high",
    };

    const nextConfig: RepoConfigFile = {
      ...currentConfig,
      assistant,
      assistants: {
        ...currentConfig.assistants,
        [assistant]: { model: validated.models.defaultModel },
      },
      tiers,
      aliases,
      concurrencyLimit: validated.models.concurrencyLimit,
      worktree: { ...currentConfig.worktree, strategy: validated.models.worktreeStrategy },
      releases: validated.releases,
    };
    writeRepoConfig(repoRoot, nextConfig);

    // Write side files: tool guidance and codebase rules.
    const toolGuidancePath = join(repoRoot, ".animus/tool-guidance.json");
    const guidanceContent = {
      ...validated.checks.toolGuidance,
      staticCmd: validated.checks.staticCmd,
      unitCmd: validated.checks.unitCmd,
      countPattern: validated.checks.countPattern,
      protectedPaths: validated.checks.protectedPaths,
    };
    this.atomicWrite(toolGuidancePath, JSON.stringify(guidanceContent, null, 2));

    const rulesPath = join(repoRoot, ".animus/codebase-rules.json");
    this.atomicWrite(rulesPath, JSON.stringify(validated.rules, null, 2));

    return validated;
  }
}

/**
 * Projects the stored repository configuration onto the settings-API view.
 * The derived fields exist only in the response; they are never written back.
 */
function projectModelsFromConfig(config: RepoConfigFile): Record<string, unknown> {
  const assistant =
    typeof config.assistant === "string" && config.assistant ? config.assistant : "pi";
  const assistants = (config.assistants ?? {}) as Record<string, { model?: string }>;
  const tiers = (config.tiers ?? {}) as Record<string, { model?: string; effort?: string }>;
  const aliases = (config.aliases ?? {}) as Record<string, { model?: string; effort?: string }>;
  const worktree = (config.worktree ?? {}) as Record<string, unknown>;

  const defaultModel = assistants[assistant]?.model || tiers.medium?.model || "default";
  return {
    assistant,
    defaultModel,
    effort: tiers.medium?.effort || aliases["@reasoning"]?.effort || "high",
    concurrencyLimit: typeof config.concurrencyLimit === "number" ? config.concurrencyLimit : 2,
    plannerModel: tiers.large?.model || defaultModel,
    builderModel: tiers.medium?.model || defaultModel,
    reviewerModel: aliases["@reasoning"]?.model || defaultModel,
    worktreeStrategy: typeof worktree.strategy === "string" ? worktree.strategy : "isolated",
  };
}
