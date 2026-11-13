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
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5",
    "claude-3-7-sonnet",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
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
  private catalogCache = new Map<
    string,
    { expiresAt: number; value: Awaited<ReturnType<SettingsService["getHarnessModels"]>> }
  >();

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
  async getHarnessModels(providerId = "pi"): Promise<{
    provider: string;
    models: string[];
    supportedEfforts: string[];
    defaultEffort: string;
    source?: string;
    catalogLive?: boolean;
    unavailableReason?: string;
  }> {
    const provider = providerId.toLowerCase();
    const cached = this.catalogCache.get(provider);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const supportedEfforts = HARNESS_EFFORTS[provider] || ["low", "medium", "high", "max"];
    const defaultEffort = supportedEfforts.includes("high")
      ? "high"
      : supportedEfforts[0] || "medium";

    if (
      provider === "pi" ||
      provider === "omp" ||
      provider === "opencode" ||
      provider === "commandcode"
    ) {
      try {
        const factory = new URL("../../../../", import.meta.url);
        const catalogMod = (await import(
          new URL("scripts/cli/commands/onboarding-model-catalog.ts", factory).href
        )) as {
          createModelCatalogLoader: () => (p: string) => Promise<{
            models: Array<{ id: string }>;
            source?: string;
            unavailableReason?: string;
          }>;
        };
        const loader = catalogMod.createModelCatalogLoader();
        const catalog = await Promise.race([
          loader(provider),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
        ]);
        if (catalog && catalog.models.length > 0) {
          const merged = Array.from(
            new Set<string>(["default", ...catalog.models.map((m) => m.id)]),
          );
          const result = {
            provider,
            models: merged,
            supportedEfforts,
            defaultEffort,
            ...(catalog.source ? { source: catalog.source } : {}),
            catalogLive: true,
          };
          this.catalogCache.set(provider, { expiresAt: Date.now() + 60_000, value: result });
          return result;
        }
        return {
          provider,
          models: FALLBACK_HARNESS_MODELS[provider] || ["default"],
          supportedEfforts,
          defaultEffort,
          catalogLive: false,
          unavailableReason:
            catalog?.unavailableReason ??
            "Catalog discovery timed out. Choose a preset or enter a model ID manually.",
        };
      } catch {}
    }

    const fallback = FALLBACK_HARNESS_MODELS[provider] || ["default"];
    return {
      provider,
      models: fallback,
      supportedEfforts,
      defaultEffort,
      catalogLive: false,
      unavailableReason:
        "No live model catalog CLI available for this harness. Choose a preset or enter a model ID manually.",
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

    // 2. Checks: harness/harness.config.json (authoritative loop checks) + .animus/tool-guidance.json
    const harnessConfigPath = join(repoRoot, "harness/harness.config.json");
    let harnessData: {
      static?: string;
      unit?: string;
      unit_count_pattern?: string;
      protected_paths?: string;
    } = {};
    if (existsSync(harnessConfigPath)) {
      try {
        harnessData = JSON.parse(readFileSync(harnessConfigPath, "utf-8")) ?? {};
      } catch {}
    }

    const animusToolGuidance = join(repoRoot, ".animus/tool-guidance.json");
    const factoryToolGuidance = join(repoRoot, ".factory/tool-guidance.json");
    const toolGuidancePath = existsSync(animusToolGuidance)
      ? animusToolGuidance
      : factoryToolGuidance;
    let parsedGuidance: Record<string, unknown> = {};
    const rawGuidance: Record<string, string> = {};
    if (existsSync(toolGuidancePath)) {
      try {
        const parsed = JSON.parse(readFileSync(toolGuidancePath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedGuidance = parsed as Record<string, unknown>;
          for (const [k, v] of Object.entries(parsedGuidance)) {
            if (typeof v === "string" && k !== "protectedPaths") {
              rawGuidance[k] = v;
            }
          }
        }
      } catch {}
    }

    const checksData: Record<string, unknown> = {
      staticCmd:
        (typeof harnessData.static === "string" && harnessData.static) ||
        (typeof parsedGuidance.staticCmd === "string" && parsedGuidance.staticCmd) ||
        (typeof parsedGuidance.check === "string" && parsedGuidance.check) ||
        "bun run check",
      unitCmd:
        (typeof harnessData.unit === "string" && harnessData.unit) ||
        (typeof parsedGuidance.unitCmd === "string" && parsedGuidance.unitCmd) ||
        (typeof parsedGuidance.test === "string" && parsedGuidance.test) ||
        "bun test",
      countPattern:
        (typeof harnessData.unit_count_pattern === "string" && harnessData.unit_count_pattern) ||
        (typeof parsedGuidance.countPattern === "string" && parsedGuidance.countPattern) ||
        "Tests\\s+(\\d+)\\s+passed",
      protectedPaths: Array.isArray(parsedGuidance.protectedPaths)
        ? parsedGuidance.protectedPaths
        : typeof harnessData.protected_paths === "string"
          ? harnessData.protected_paths
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : typeof parsedGuidance.protectedPaths === "string"
            ? parsedGuidance.protectedPaths
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : ["harness/**", ".animus/holdout/**", ".animus/hooks/**"],
      toolGuidance: rawGuidance,
    };
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
    const existingTiers = (currentConfig.tiers ?? {}) as Record<string, Record<string, unknown>>;
    const tiers: Record<string, Record<string, unknown>> = { ...existingTiers };
    const defaultTierEfforts: Record<string, string> = {
      small: "medium",
      medium: validated.models.effort,
      large:
        validated.models.effort === "max" || validated.models.effort === "xhigh"
          ? validated.models.effort
          : "high",
    };
    const explicitTiers = updates.models?.tiers;
    const assistantChanged =
      updates.models?.assistant !== undefined &&
      updates.models.assistant !== current.models.assistant;
    const defaultModelChanged =
      updates.models?.defaultModel !== undefined &&
      updates.models.defaultModel !== current.models.defaultModel;
    const effortChanged =
      updates.models?.effort !== undefined && updates.models.effort !== current.models.effort;

    const assistantsMap: Record<string, Record<string, unknown>> = {
      ...currentConfig.assistants,
      [assistant]: { model: validated.models.defaultModel },
    };

    for (const tier of ["small", "medium", "large"] as const) {
      const explicit = explicitTiers?.[tier];
      const existing = existingTiers[tier];
      if (explicit) {
        const nextProvider = explicit.provider || assistant;
        const nextModel = explicit.model || "default";
        tiers[tier] = {
          provider: nextProvider,
          model: nextModel,
          ...(explicit.effort ? { effort: explicit.effort } : {}),
        };
        if (!assistantsMap[nextProvider]) {
          assistantsMap[nextProvider] = { model: nextModel };
        }
      } else if (existing) {
        tiers[tier] = {
          ...existing,
          ...(assistantChanged && !explicitTiers ? { provider: assistant } : {}),
          ...(tier === "medium" && defaultModelChanged
            ? { model: validated.models.defaultModel }
            : {}),
          ...(tier === "medium" && effortChanged ? { effort: validated.models.effort } : {}),
        };
      } else {
        tiers[tier] = {
          provider: assistant,
          model: validated.models.defaultModel,
          effort: defaultTierEfforts[tier],
        };
      }
    }

    const aliases = { ...currentConfig.aliases } as Record<string, Record<string, unknown>>;
    const explicitReasoning = updates.models?.reasoningAlias;
    if (explicitReasoning) {
      const reasoningProvider =
        explicitReasoning.provider || (tiers.large?.provider as string) || assistant;
      const reasoningModel =
        explicitReasoning.model || (tiers.large?.model as string) || validated.models.defaultModel;
      aliases["@reasoning"] = {
        provider: reasoningProvider,
        model: reasoningModel,
        ...(explicitReasoning.effort ? { effort: explicitReasoning.effort } : {}),
      };
      if (!assistantsMap[reasoningProvider]) {
        assistantsMap[reasoningProvider] = { model: reasoningModel };
      }
    } else if (explicitTiers?.large) {
      const largeTier = tiers.large!;
      aliases["@reasoning"] = {
        provider: largeTier.provider,
        model: largeTier.model,
        ...(largeTier.effort ? { effort: largeTier.effort } : {}),
      };
    } else {
      aliases["@reasoning"] = {
        provider: (tiers.large?.provider as string) || assistant,
        model:
          (typeof aliases["@reasoning"]?.model === "string" &&
            !defaultModelChanged &&
            aliases["@reasoning"].model) ||
          (tiers.large?.model as string) ||
          validated.models.defaultModel,
        effort:
          (typeof tiers.large?.effort === "string" && tiers.large.effort) ||
          (validated.models.effort === "max" ? "max" : "high"),
      };
    }

    const nextConfig: RepoConfigFile = {
      ...currentConfig,
      assistant,
      assistants: assistantsMap,
      tiers,
      aliases,
      concurrencyLimit: validated.models.concurrencyLimit,
      worktree: {
        ...currentConfig.worktree,
        strategy: validated.models.worktreeStrategy,
        baseBranch: validated.models.baseBranch,
      },
      releases: validated.releases,
    };
    writeRepoConfig(repoRoot, nextConfig);

    // Write side files: tool guidance, harness/harness.config.json, and codebase rules.
    const toolGuidancePath = join(repoRoot, ".animus/tool-guidance.json");
    const guidanceContent = {
      ...validated.checks.toolGuidance,
      staticCmd: validated.checks.staticCmd,
      unitCmd: validated.checks.unitCmd,
      countPattern: validated.checks.countPattern,
      protectedPaths: validated.checks.protectedPaths,
    };
    this.atomicWrite(toolGuidancePath, JSON.stringify(guidanceContent, null, 2));

    const harnessConfigPath = join(repoRoot, "harness/harness.config.json");
    let existingHarnessConfig: Record<string, unknown> = {};
    if (existsSync(harnessConfigPath)) {
      try {
        existingHarnessConfig = JSON.parse(readFileSync(harnessConfigPath, "utf-8")) ?? {};
      } catch {}
    }
    const nextHarnessConfig = {
      ...existingHarnessConfig,
      static: validated.checks.staticCmd,
      unit: validated.checks.unitCmd,
      unit_count_pattern: validated.checks.countPattern,
      required_checks:
        typeof existingHarnessConfig.required_checks === "string"
          ? existingHarnessConfig.required_checks
          : "none",
      protected_paths: validated.checks.protectedPaths.join(","),
      description:
        typeof existingHarnessConfig.description === "string"
          ? existingHarnessConfig.description
          : "Ordinary project checks configured via Animus Settings.",
    };
    this.atomicWrite(harnessConfigPath, JSON.stringify(nextHarnessConfig, null, 2) + "\n");

    const rulesPath = join(repoRoot, ".animus/codebase-rules.json");
    this.atomicWrite(rulesPath, JSON.stringify(validated.rules, null, 2));

    return this.getProjectSettings(repoRoot);
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
  const tiers = (config.tiers ?? {}) as Record<
    string,
    { provider?: string; model?: string; effort?: string }
  >;
  const aliases = (config.aliases ?? {}) as Record<
    string,
    { provider?: string; model?: string; effort?: string }
  >;
  const worktree = (config.worktree ?? {}) as Record<string, unknown>;

  const defaultModel = assistants[assistant]?.model || tiers.medium?.model || "default";
  const defaultEffort = tiers.medium?.effort || aliases["@reasoning"]?.effort || "high";
  const resolveTier = (tierKey: "small" | "medium" | "large", fallbackEffort: string) => ({
    provider: tiers[tierKey]?.provider || assistant,
    model: tiers[tierKey]?.model || defaultModel,
    effort: tiers[tierKey]?.effort || fallbackEffort,
  });
  const projectedTiers = {
    small: resolveTier("small", "medium"),
    medium: resolveTier("medium", defaultEffort),
    large: resolveTier(
      "large",
      defaultEffort === "max" || defaultEffort === "xhigh" ? defaultEffort : "high",
    ),
  };
  const reasoningAlias = {
    provider: aliases["@reasoning"]?.provider || projectedTiers.large.provider,
    model: aliases["@reasoning"]?.model || projectedTiers.large.model,
    effort: aliases["@reasoning"]?.effort || projectedTiers.large.effort,
  };

  return {
    assistant,
    defaultModel,
    effort: defaultEffort,
    concurrencyLimit: typeof config.concurrencyLimit === "number" ? config.concurrencyLimit : 2,
    plannerModel: projectedTiers.large.model,
    builderModel: projectedTiers.medium.model,
    reviewerModel: reasoningAlias.model,
    tiers: projectedTiers,
    reasoningAlias,
    worktreeStrategy: typeof worktree.strategy === "string" ? worktree.strategy : "isolated",
    baseBranch:
      typeof worktree.baseBranch === "string" && worktree.baseBranch ? worktree.baseBranch : "main",
  };
}
