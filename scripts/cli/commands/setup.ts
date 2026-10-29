import { spawnSync } from "node:child_process";
import {
  completeRepositoryOnboarding,
  type FactoryConnectionOptions,
} from "./onboarding-registration";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TerminalWizardPrompts, type WizardPrompts } from "./onboarding-prompts";
import { createModelCatalogLoader, type ModelCatalogLoader } from "./onboarding-model-catalog";
import {
  readArchonConfig,
  writeArchonConfig,
  type ArchonConfig,
  type TierBinding,
} from "../../loop/config";
import {
  EFFORT_LADDER,
  PROVIDER_DESCRIPTORS,
  SUPPORTED_PROVIDERS,
  isEffortRung,
  isSupportedProvider,
  type EffortRung,
  type SupportedProvider,
} from "../../loop/providers";
import { loadScheduleConfig, type ScheduleConfig } from "../../loop/scheduler";
import type { ModelTier } from "../../loop/types";
import {
  auditRepositoryHarness,
  scaffoldRepositoryHarness,
  type HarnessAuditReport,
  type ScaffoldHarnessResult,
} from "./harness-scaffold";

export interface DetectedHarnessProvider {
  id: SupportedProvider;
  displayName: string;
  binaryName: string;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  status: "active" | "coming_soon";
  supportedEfforts: readonly EffortRung[];
}

export interface DetectedRepoCommands {
  projectType:
    | "typescript-bun"
    | "node"
    | "python"
    | "rust"
    | "go"
    | "flutter-dart"
    | "jvm"
    | "generic";
  staticCheck: string;
  unitTest: string;
  unitCountPattern: string;
  protectedPaths: string;
}

export interface HarnessConfigFile {
  static: string;
  unit: string;
  unit_count_pattern: string;
  required_checks: string;
  protected_paths: string;
  description: string;
}

export interface SetupConfigSummary {
  repoRoot: string;
  detectedHarnesses: DetectedHarnessProvider[];
  archonConfigPath: string;
  scheduleConfigPath: string;
  harnessConfigPath: string;
  toolGuidancePath: string;
  archonConfig: ArchonConfig;
  scheduleConfig: ScheduleConfig;
  harnessConfig: HarnessConfigFile;
  scaffoldResult: ScaffoldHarnessResult;
}

export const DEFAULT_PROVIDER_MODELS: Record<
  SupportedProvider,
  { small: string; medium: string; large: string }
> = {
  pi: {
    small: "router/ag/gemini-3.8-flash",
    medium: "router/ag/gemini-3.8-flash",
    large: "router/cx/gpt-6.1-sol",
  },
  claude: {
    small: "claude-haiku-4-5",
    medium: "claude-sonnet-4-5",
    large: "claude-opus-4-5",
  },
  omp: {
    small: "9router/ag/gemini-3.8-flash",
    medium: "9router/ag/gemini-3.8-flash",
    large: "9router/cx/gpt-6.1-sol",
  },
  codex: {
    small: "gpt-5.1-codex-mini",
    medium: "gpt-5.2-codex",
    large: "gpt-5.3-codex",
  },
  opencode: {
    small: "anthropic/claude-haiku-4-5",
    medium: "anthropic/claude-sonnet-4-5",
    large: "anthropic/claude-opus-4-5",
  },
};

export function detectAvailableHarnesses(): DetectedHarnessProvider[] {
  const results: DetectedHarnessProvider[] = [];

  for (const id of SUPPORTED_PROVIDERS) {
    const desc = PROVIDER_DESCRIPTORS[id];
    const whichRes = spawnSync("which", [desc.binaryName], {
      encoding: "utf-8",
      timeout: 3000,
    });
    const installed = whichRes.status === 0 && Boolean((whichRes.stdout || "").trim());
    const binaryPath = installed ? (whichRes.stdout || "").trim() : null;

    let version: string | null = null;
    if (installed) {
      try {
        const verRes = spawnSync(desc.binaryName, ["--version"], {
          encoding: "utf-8",
          timeout: 3000,
        });
        const firstLine = ((verRes.stdout || verRes.stderr || "").split("\n")[0] || "").trim();
        if (firstLine) version = firstLine.slice(0, 80);
      } catch {}
    }

    results.push({
      id,
      displayName: desc.displayName,
      binaryName: desc.binaryName,
      installed,
      binaryPath,
      version,
      status: desc.status,
      supportedEfforts: desc.supportedEfforts,
    });
  }

  return results;
}

export function detectRepoCheckCommands(repoRoot: string): DetectedRepoCommands {
  const existingHarnessPath = join(repoRoot, "harness/harness.config.json");
  if (existsSync(existingHarnessPath)) {
    try {
      const existing = JSON.parse(
        readFileSync(existingHarnessPath, "utf-8"),
      ) as Partial<HarnessConfigFile>;
      if (existing.static && existing.unit) {
        return {
          projectType: "typescript-bun",
          staticCheck: existing.static,
          unitTest: existing.unit,
          unitCountPattern: existing.unit_count_pattern ?? "Tests\\s+(\\d+)\\s+passed",
          protectedPaths:
            existing.protected_paths ??
            "MISSION.md,FACTORY.md,FACTORY_RULES.md,harness/**,.claude/settings.json,.ignore",
        };
      }
    } catch {}
  }

  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const hasBunLock =
        existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"));
      const runner = hasBunLock ? "bun run" : "npm run";

      const staticCheck = scripts.check
        ? `${runner} check`
        : scripts.typecheck && scripts.lint
          ? `${runner} lint && ${runner} typecheck`
          : scripts.lint
            ? `${runner} lint`
            : scripts.typecheck
              ? `${runner} typecheck`
              : "true";

      const unitTest =
        pkg.devDependencies?.["vite-plus"] &&
        existsSync(join(repoRoot, "node_modules/vite-plus/bin/vp"))
          ? "node node_modules/vite-plus/bin/vp test run"
          : scripts.test
            ? `${runner} test`
            : hasBunLock
              ? "bun test"
              : "npm test";

      return {
        projectType: hasBunLock ? "typescript-bun" : "node",
        staticCheck,
        unitTest,
        unitCountPattern: "Tests\\s+(\\d+)\\s+passed|(\\d+)\\s+pass",
        protectedPaths:
          "MISSION.md,FACTORY.md,FACTORY_RULES.md,harness/**,.claude/settings.json,.ignore",
      };
    } catch {}
  }

  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    return {
      projectType: "rust",
      staticCheck: "cargo check",
      unitTest: "cargo test",
      unitCountPattern: "(\\d+)\\s+passed",
      protectedPaths: "MISSION.md,FACTORY.md,FACTORY_RULES.md,harness/**",
    };
  }

  if (existsSync(join(repoRoot, "go.mod"))) {
    return {
      projectType: "go",
      staticCheck: "go vet ./...",
      unitTest: "go test ./...",
      unitCountPattern: "ok\\s+",
      protectedPaths: "MISSION.md,FACTORY.md,FACTORY_RULES.md,harness/**",
    };
  }

  if (existsSync(join(repoRoot, "pubspec.yaml"))) {
    return {
      projectType: "flutter-dart",
      staticCheck: "flutter analyze",
      unitTest: "flutter test",
      unitCountPattern: "All tests passed|\\+(\\d+)",
      protectedPaths: "MISSION.md,FACTORY.md,FACTORY_RULES.md,harness/**",
    };
  }

  if (
    existsSync(join(repoRoot, "build.gradle")) ||
    existsSync(join(repoRoot, "build.gradle.kts")) ||
    existsSync(join(repoRoot, "pom.xml"))
  ) {
    const isGradle =
      existsSync(join(repoRoot, "build.gradle")) || existsSync(join(repoRoot, "build.gradle.kts"));
    return {
      projectType: "jvm",
      staticCheck: isGradle ? "./gradlew check -x test" : "mvn test-compile",
      unitTest: isGradle ? "./gradlew test" : "mvn test",
      unitCountPattern: "BUILD SUCCESSFUL|Tests run:\\s*(\\d+)",
      protectedPaths: "MISSION.md,FACTORY.md,FACTORY_RULES.md,harness/**",
    };
  }

  if (
    existsSync(join(repoRoot, "pyproject.toml")) ||
    existsSync(join(repoRoot, "requirements.txt"))
  ) {
    return {
      projectType: "python",
      staticCheck: "python3 -m compileall .",
      unitTest: "pytest",
      unitCountPattern: "(\\d+)\\s+passed",
      protectedPaths: "MISSION.md,FACTORY.md,FACTORY_RULES.md,harness/**",
    };
  }

  return {
    projectType: "generic",
    staticCheck: "true",
    unitTest: "true",
    unitCountPattern: "",
    protectedPaths: "MISSION.md,FACTORY.md,FACTORY_RULES.md,harness/**",
  };
}

export function detectBaseBranch(repoRoot: string): string {
  const existing = readArchonConfig(repoRoot);
  if (existing.worktree?.baseBranch) return existing.worktree.baseBranch;
  try {
    const res = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const branch = (res.stdout || "").trim();
    if (branch === "main" || branch === "develop" || branch === "master") {
      return branch;
    }
  } catch {}
  return "main";
}

export function parseTierSpec(spec: string, fallbackProvider: SupportedProvider): TierBinding {
  if (!spec.trim()) throw new Error("Model ID must not be empty.");
  const parts = spec.trim().split(":");
  if (parts.length >= 3 && isSupportedProvider(parts[0]!)) {
    const provider = parts[0]!;
    const effortCandidate = parts[parts.length - 1]!;
    if (isEffortRung(effortCandidate)) {
      const model = parts.slice(1, -1).join(":");
      const binding = { provider, model, effort: effortCandidate };
      validateTierBinding(binding);
      return binding;
    }
  }
  if (parts.length >= 2 && isSupportedProvider(parts[0]!)) {
    const binding = { provider: parts[0]!, model: parts.slice(1).join(":") };
    validateTierBinding(binding);
    return binding;
  }
  return {
    provider: fallbackProvider,
    model: spec,
  };
}

function validateTierBinding(binding: TierBinding): void {
  if (!isSupportedProvider(binding.provider))
    throw new Error(`Unsupported provider '${binding.provider}'.`);
  if (!binding.model.trim() || /[\r\n]/.test(binding.model))
    throw new Error("Model ID must be nonempty and single-line.");
  if (
    binding.effort &&
    !PROVIDER_DESCRIPTORS[binding.provider].supportedEfforts.includes(binding.effort)
  ) {
    throw new Error(
      `Effort '${binding.effort}' is not supported by ${binding.provider}. Supported: ${PROVIDER_DESCRIPTORS[binding.provider].supportedEfforts.join(", ")}`,
    );
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

export interface SetupCommandOptions extends FactoryConnectionOptions {
  localOnly?: boolean;
  name?: string;
  repoRoot: string;
  nonInteractive?: boolean;
  provider?: string;
  smallTier?: string;
  mediumTier?: string;
  largeTier?: string;
  maxLaps?: number;
  parallel?: number;
  intervalSeconds?: number;
  baseBranch?: string;
  staticCmd?: string;
  unitCmd?: string;
  workWindow?: string;
  timezone?: string;
  agentsMdAction?: "keep" | "upgrade" | "overwrite";
  json?: boolean;
}

export interface SetupInteraction {
  prompts?: WizardPrompts;
  catalog?: ModelCatalogLoader;
  detectHarnesses?: () => DetectedHarnessProvider[];
  registrationFetch?: FactoryConnectionOptions["fetch"];
}

export async function applyRepositorySetup(
  opts: SetupCommandOptions,
  interaction: SetupInteraction = {},
): Promise<SetupConfigSummary> {
  if (opts.provider !== undefined && !isSupportedProvider(opts.provider))
    throw new Error(`Unsupported provider '${opts.provider}'.`);
  for (const [name, value] of Object.entries({
    maxLaps: opts.maxLaps,
    parallel: opts.parallel,
    intervalSeconds: opts.intervalSeconds,
  })) {
    if (value !== undefined) positiveInteger(value, name);
  }
  const repoRoot = resolve(opts.repoRoot);
  const detectedHarnesses = (interaction.detectHarnesses ?? detectAvailableHarnesses)();
  const detectedCommands = detectRepoCheckCommands(repoRoot);
  const existingArchon = readArchonConfig(repoRoot);
  const existingSchedule = loadScheduleConfig(repoRoot);
  const harnessAudit: HarnessAuditReport = auditRepositoryHarness(repoRoot);

  const firstInstalled = detectedHarnesses.find((h) => h.installed)?.id ?? "pi";
  const defaultProvider: SupportedProvider =
    opts.provider && isSupportedProvider(opts.provider)
      ? opts.provider
      : existingArchon.assistant && isSupportedProvider(existingArchon.assistant)
        ? existingArchon.assistant
        : firstInstalled;

  const providerDefaults = DEFAULT_PROVIDER_MODELS[defaultProvider];

  let selectedProviders: SupportedProvider[] = opts.provider
    ? [defaultProvider]
    : Object.keys(existingArchon.assistants ?? {}).filter(isSupportedProvider);
  if (!selectedProviders.length)
    selectedProviders = opts.provider
      ? [defaultProvider]
      : [
          ...new Set([
            defaultProvider,
            ...Object.values(existingArchon.tiers ?? {})
              .map((binding) => binding.provider)
              .filter(isSupportedProvider),
          ]),
        ];
  let selectedProvider = selectedProviders.includes(defaultProvider)
    ? defaultProvider
    : selectedProviders[0]!;
  let smallBinding: TierBinding = existingArchon.tiers?.small ?? {
    provider: defaultProvider,
    model: providerDefaults.small,
    effort: "medium",
  };
  let mediumBinding: TierBinding = existingArchon.tiers?.medium ?? {
    provider: defaultProvider,
    model: providerDefaults.medium,
    effort: "high",
  };
  let largeBinding: TierBinding = existingArchon.tiers?.large ?? {
    provider: defaultProvider,
    model: providerDefaults.large,
    effort: "high",
  };

  let maxLaps = opts.maxLaps ?? existingSchedule.max_laps ?? 3;
  let parallel = opts.parallel ?? existingSchedule.parallel ?? 1;
  let intervalSeconds = opts.intervalSeconds ?? existingSchedule.interval_seconds ?? 300;
  let baseBranch = opts.baseBranch ?? detectBaseBranch(repoRoot);
  let staticCheck = opts.staticCmd ?? detectedCommands.staticCheck;
  let unitTest = opts.unitCmd ?? detectedCommands.unitTest;
  let workWindowEnabled = existingSchedule.work_window?.enabled ?? false;
  let workWindowStart = existingSchedule.work_window?.start_time ?? "20:00";
  let workWindowEnd = existingSchedule.work_window?.end_time ?? "05:00";
  let workWindowTz =
    opts.timezone ??
    existingSchedule.work_window?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "Asia/Jakarta";

  let agentsMdAction: "keep" | "upgrade" | "overwrite" =
    opts.agentsMdAction ??
    (!harnessAudit.agentsMd.exists
      ? "overwrite"
      : harnessAudit.agentsMd.status === "poor"
        ? "upgrade"
        : "keep");

  if (opts.provider && isSupportedProvider(opts.provider)) {
    selectedProvider = opts.provider;
    const pModels = DEFAULT_PROVIDER_MODELS[selectedProvider];
    if (!opts.smallTier) {
      smallBinding = { provider: selectedProvider, model: pModels.small, effort: "medium" };
    }
    if (!opts.mediumTier) {
      mediumBinding = { provider: selectedProvider, model: pModels.medium, effort: "high" };
    }
    if (!opts.largeTier) {
      largeBinding = { provider: selectedProvider, model: pModels.large, effort: "high" };
    }
  }

  if (opts.smallTier !== undefined) smallBinding = parseTierSpec(opts.smallTier, selectedProvider);
  if (opts.mediumTier !== undefined)
    mediumBinding = parseTierSpec(opts.mediumTier, selectedProvider);
  if (opts.largeTier !== undefined) largeBinding = parseTierSpec(opts.largeTier, selectedProvider);
  for (const binding of [smallBinding, mediumBinding, largeBinding]) validateTierBinding(binding);
  for (const [spec, binding] of [
    [opts.smallTier, smallBinding],
    [opts.mediumTier, mediumBinding],
    [opts.largeTier, largeBinding],
  ] as const) {
    if (spec !== undefined && !selectedProviders.includes(binding.provider as SupportedProvider))
      selectedProviders.push(binding.provider as SupportedProvider);
  }

  if (opts.workWindow !== undefined) {
    if (opts.workWindow === "off" || opts.workWindow === "false" || opts.workWindow === "none") {
      workWindowEnabled = false;
    } else {
      const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(opts.workWindow.trim());
      if (!match || !match.slice(1).every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time!)))
        throw new Error("Work window must be HH:MM-HH:MM with valid 24-hour times, or off.");
      workWindowEnabled = true;
      workWindowStart = match[1]!;
      workWindowEnd = match[2]!;
    }
  }

  const normalizeBinding = (binding: TierBinding, tier: ModelTier): TierBinding => {
    if (selectedProviders.includes(binding.provider as SupportedProvider)) return binding;
    return {
      provider: selectedProvider,
      model:
        existingArchon.assistants?.[selectedProvider]?.model ??
        DEFAULT_PROVIDER_MODELS[selectedProvider][tier],
      effort: tier === "small" ? "medium" : "high",
    };
  };
  const isInteractive =
    !opts.nonInteractive && !opts.json && Boolean(interaction.prompts || process.stdin.isTTY);
  if (isInteractive) {
    const prompts = interaction.prompts ?? new TerminalWizardPrompts();
    const ask = (message: string, initial: string) => prompts.text(message, initial);
    try {
      prompts.note(`LabQ Software Factory — Repository Setup
Target: ${repoRoot}`);
      const choices = SUPPORTED_PROVIDERS.map((id) => {
        const detected = detectedHarnesses.find((h) => h.id === id);
        return {
          value: id,
          label: `${PROVIDER_DESCRIPTORS[id].displayName} (${id}) — ${detected?.installed ? "installed" : "missing"}`,
        };
      });
      let checked: string[];
      do {
        checked = await prompts.checkbox("Select agent harnesses", choices, selectedProviders);
        if (!checked.length) prompts.note("Select at least one harness.");
      } while (!checked.length);
      if (!checked.every(isSupportedProvider)) throw new Error("Unsupported harness selection.");
      selectedProviders = [...new Set(checked)] as SupportedProvider[];
      if (!selectedProviders.includes(selectedProvider)) selectedProvider = selectedProviders[0]!;
      smallBinding = normalizeBinding(smallBinding, "small");
      mediumBinding = normalizeBinding(mediumBinding, "medium");
      largeBinding = normalizeBinding(largeBinding, "large");

      prompts.note(
        `AGENTS.md: ${harnessAudit.agentsMd.status} (${harnessAudit.agentsMd.score}/100)`,
      );
      if (harnessAudit.agentsMd.exists) {
        agentsMdAction = (await prompts.select(
          "AGENTS.md action",
          ["keep", "upgrade", "overwrite"].map((value) => ({ value, label: value })),
          agentsMdAction,
        )) as typeof agentsMdAction;
      }
      prompts.note(
        "Configured model IDs are not a verified catalog. Model capabilities unknown until reported by a catalog.",
      );
      const bindings = { small: smallBinding, medium: mediumBinding, large: largeBinding };
      for (;;) {
        const tier = await prompts.select("Model tier overview — select a tier to edit", [
          ...(["small", "medium", "large"] as const).map((value) => ({
            value,
            label: `${value}: ${bindings[value].provider} / ${bindings[value].model} / ${bindings[value].effort ?? "default effort"}`,
          })),
          { value: "continue", label: "Continue with these tiers" },
        ]);
        if (tier === "continue") break;
        if (tier !== "small" && tier !== "medium" && tier !== "large")
          throw new Error("Unknown tier.");
        const provider = (await prompts.select(
          "Harness (type to search)",
          choices.filter((c) => selectedProviders.includes(c.value as SupportedProvider)),
          bindings[tier].provider,
          true,
        )) as SupportedProvider;
        const initialModel =
          bindings[tier].provider === provider
            ? bindings[tier].model
            : (existingArchon.assistants?.[provider]?.model ??
              DEFAULT_PROVIDER_MODELS[provider][tier]);
        const catalog = await (interaction.catalog ?? createModelCatalogLoader())(provider);
        let model: string;
        if (catalog.models.length) {
          prompts.note(
            `Models from ${catalog.source ?? "harness catalog"}. Availability may depend on credentials.`,
          );
          const choice = await prompts.select(
            "Model (type to search)",
            [
              ...catalog.models.map((m) => ({
                value: m.id,
                label: `${m.id}${m.name ? ` — ${m.name}` : ""}`,
              })),
              { value: "__manual__", label: "Enter a model ID manually" },
            ],
            initialModel,
            true,
          );
          model = choice === "__manual__" ? await ask("Model ID", initialModel) : choice;
        } else {
          prompts.note(
            catalog.unavailableReason ?? "Model catalog unavailable. Enter a model ID manually.",
          );
          model = await ask("Model ID", initialModel);
        }
        const metadata = catalog.models.find((m) => m.id === model);
        prompts.note(metadata?.capabilities ?? "Model capabilities unknown.");
        let effort = "default";
        if (metadata?.reasoning === false) {
          prompts.note(
            "This catalog model does not support reasoning; no effort override will be set.",
          );
        } else {
          prompts.note(
            "Reasoning choices reflect harness support only; model-specific effort levels are unverified.",
          );
          const efforts = PROVIDER_DESCRIPTORS[provider].supportedEfforts;
          effort = await prompts.select(
            "Reasoning effort",
            [
              { value: "default", label: "Harness default" },
              ...efforts.map((value) => ({ value, label: value })),
            ],
            bindings[tier].effort ?? "default",
          );
        }
        bindings[tier] = {
          provider,
          model,
          ...(effort !== "default" ? { effort: effort as EffortRung } : {}),
        };
      }
      smallBinding = bindings.small;
      mediumBinding = bindings.medium;
      largeBinding = bindings.large;
      const askInteger = async (message: string, initial: number): Promise<number> => {
        for (;;) {
          const answer = await ask(message, String(initial));
          const value = Number(answer);
          if (/^\d+$/.test(answer) && Number.isSafeInteger(value) && value > 0) return value;
          prompts.note(`${message} must be a positive safe integer. Try again.`);
        }
      };
      maxLaps = await askInteger("Max laps per issue", maxLaps);
      parallel = await askInteger("Max parallel autonomous laps", parallel);
      intervalSeconds = await askInteger("Scheduler polling interval (seconds)", intervalSeconds);
      baseBranch = await ask("Default base branch", baseBranch);
      staticCheck = await ask("Static check command", staticCheck);
      unitTest = await ask("Unit test command", unitTest);
    } finally {
      prompts.close();
    }
  } else {
    smallBinding = normalizeBinding(smallBinding, "small");
    mediumBinding = normalizeBinding(mediumBinding, "medium");
    largeBinding = normalizeBinding(largeBinding, "large");
  }

  positiveInteger(maxLaps, "maxLaps");
  positiveInteger(parallel, "parallel");
  positiveInteger(intervalSeconds, "intervalSeconds");
  for (const binding of [smallBinding, mediumBinding, largeBinding]) {
    validateTierBinding(binding);
    if (!selectedProviders.includes(binding.provider as SupportedProvider))
      throw new Error("Tier harness must be selected.");
  }

  // Scaffold Harness Structure (AGENTS.md, CLAUDE.md, .agents/skills, .factory/hooks, HOLDOUT.md, etc.)
  const scaffoldResult = scaffoldRepositoryHarness({
    targetRepoRoot: repoRoot,
    detectedCommands: {
      ...detectedCommands,
      staticCheck,
      unitTest,
    },
    agentsMdAction,
  });

  // Persist 1: .archon/config.yaml
  const archonConfig: ArchonConfig = {
    assistant: selectedProvider,
    assistants: Object.fromEntries(
      selectedProviders.map((provider) => {
        const binding = [mediumBinding, smallBinding, largeBinding].find(
          (b) => b.provider === provider,
        );
        return [
          provider,
          {
            model:
              binding?.model ??
              existingArchon.assistants?.[provider]?.model ??
              DEFAULT_PROVIDER_MODELS[provider].medium,
          },
        ];
      }),
    ),
    tiers: {
      small: smallBinding,
      medium: mediumBinding,
      large: largeBinding,
    },
    aliases: {
      ...Object.fromEntries(
        Object.entries(existingArchon.aliases ?? {}).filter(([, binding]) =>
          selectedProviders.includes(binding.provider as SupportedProvider),
        ),
      ),
      "@reasoning": {
        ...largeBinding,
      },
    },
    worktree: {
      baseBranch,
    },
  };
  const archonConfigPath = writeArchonConfig(repoRoot, archonConfig);

  // Persist 2: .factory/schedule.json
  const scheduleConfig: ScheduleConfig = {
    workflow: existingSchedule.workflow || "archon-loop",
    parallel,
    max_laps: maxLaps,
    interval_seconds: intervalSeconds,
    inputs: existingSchedule.inputs ?? { merge: "approve" },
    work_window: {
      enabled: workWindowEnabled,
      start_time: workWindowStart,
      end_time: workWindowEnd,
      timezone: workWindowTz,
    },
  };
  const scheduleConfigPath = join(repoRoot, ".factory/schedule.json");
  mkdirSync(join(repoRoot, ".factory"), { recursive: true });
  writeFileSync(scheduleConfigPath, JSON.stringify(scheduleConfig, null, 2) + "\n", "utf-8");

  // Persist 3: harness/harness.config.json
  const harnessConfig: HarnessConfigFile = {
    static: staticCheck,
    unit: unitTest,
    unit_count_pattern: detectedCommands.unitCountPattern,
    required_checks: "none",
    protected_paths: detectedCommands.protectedPaths,
    description: `Ordinary project checks configured by labq-factory setup (${detectedCommands.projectType}).`,
  };
  const harnessConfigPath = join(repoRoot, "harness/harness.config.json");
  mkdirSync(join(repoRoot, "harness"), { recursive: true });
  if (existsSync(harnessConfigPath)) {
    try {
      const prev = JSON.parse(
        readFileSync(harnessConfigPath, "utf-8"),
      ) as Partial<HarnessConfigFile>;
      if (prev.unit_count_pattern) harnessConfig.unit_count_pattern = prev.unit_count_pattern;
      if (prev.protected_paths) harnessConfig.protected_paths = prev.protected_paths;
      if (prev.description) harnessConfig.description = prev.description;
    } catch {}
  }
  writeFileSync(harnessConfigPath, JSON.stringify(harnessConfig, null, 2) + "\n", "utf-8");

  // Persist 4: .factory/tool-guidance.json
  const toolGuidancePath = join(repoRoot, ".factory/tool-guidance.json");
  let existingTools: Record<string, string> = {};
  if (existsSync(toolGuidancePath)) {
    try {
      existingTools = JSON.parse(readFileSync(toolGuidancePath, "utf-8"));
    } catch {}
  }
  const updatedTools = {
    test: existsSync(join(repoRoot, "harness/ci.ts")) ? "bun harness/ci.ts" : unitTest,
    lint: existingTools.lint ?? staticCheck,
    format: existingTools.format ?? "bun run format",
    typecheck: existingTools.typecheck ?? staticCheck,
    build: existingTools.build ?? "bun run build:web",
    verify: existingTools.verify ?? staticCheck,
    ...existingTools,
  };
  writeFileSync(toolGuidancePath, JSON.stringify(updatedTools, null, 2) + "\n", "utf-8");

  return {
    repoRoot,
    detectedHarnesses,
    archonConfigPath,
    scheduleConfigPath,
    harnessConfigPath,
    toolGuidancePath,
    archonConfig,
    scheduleConfig,
    harnessConfig,
    scaffoldResult,
  };
}

export async function runSetupCommand(
  opts: SetupCommandOptions,
  interaction: SetupInteraction = {},
): Promise<number> {
  try {
    const summary = await applyRepositorySetup(opts, interaction);
    const finish = () =>
      completeRepositoryOnboarding(summary, {
        factoryUrl: opts.factoryUrl,
        factoryToken: opts.factoryToken,
        fetch: interaction.registrationFetch ?? opts.fetch,
        localOnly: opts.localOnly,
        name: opts.name,
        json: opts.json,
      });
    if (opts.json) return await finish();

    if (opts.nonInteractive || !process.stdin.isTTY) {
      console.log("LabQ Software Factory — Repository Setup Complete\n");
      console.log("Detected Agent Harnesses:");
      for (const h of summary.detectedHarnesses) {
        const badge = h.installed ? "[INSTALLED]" : "[MISSING]  ";
        console.log(
          `  ${badge} ${h.id.padEnd(10)} (${h.displayName}) ${h.binaryPath ?? "not in PATH"}`,
        );
      }
      console.log("");
    } else {
      console.log("\n✓ Setup saved successfully!\n");
    }

    console.log("Harness & AGENTS.md Scaffolding:");
    console.log(
      `  Project Mode:     ${summary.scaffoldResult.auditBefore.projectMode.toUpperCase()}`,
    );
    console.log(
      `  AGENTS.md:        ${summary.scaffoldResult.agentsMdActionTaken.toUpperCase()} (initial score: ${summary.scaffoldResult.auditBefore.agentsMd.score}/100)`,
    );
    if (summary.scaffoldResult.agentsMdBackupPath) {
      console.log(`  AGENTS.md Backup: ${summary.scaffoldResult.agentsMdBackupPath}`);
    }
    if (summary.scaffoldResult.skillsCopied.length > 0) {
      console.log(`  Skills Installed: ${summary.scaffoldResult.skillsCopied.join(", ")}`);
    }

    console.log("\nActive Repository Configuration:");
    console.log(`  Default Harness:  ${summary.archonConfig.assistant}`);
    console.log(
      `  Small Tier (QA):  ${summary.archonConfig.tiers?.small?.provider}/${summary.archonConfig.tiers?.small?.model} (effort: ${summary.archonConfig.tiers?.small?.effort ?? "default"})`,
    );
    console.log(
      `  Medium (Builder): ${summary.archonConfig.tiers?.medium?.provider}/${summary.archonConfig.tiers?.medium?.model} (effort: ${summary.archonConfig.tiers?.medium?.effort ?? "default"})`,
    );
    console.log(
      `  Large (Reviewer): ${summary.archonConfig.tiers?.large?.provider}/${summary.archonConfig.tiers?.large?.model} (effort: ${summary.archonConfig.tiers?.large?.effort ?? "default"})`,
    );
    console.log(
      `  Laps & Capacity:  max_laps=${summary.scheduleConfig.max_laps}, parallel=${summary.scheduleConfig.parallel}, interval=${summary.scheduleConfig.interval_seconds}s`,
    );
    console.log(`  Base Branch:      ${summary.archonConfig.worktree?.baseBranch ?? "main"}`);
    console.log(`  Static Check:     ${summary.harnessConfig.static}`);
    console.log(`  Unit Test:        ${summary.harnessConfig.unit}`);
    console.log("\nWritten / Verified Files:");
    console.log(`  - ${summary.archonConfigPath}`);
    console.log(`  - ${summary.scheduleConfigPath}`);
    console.log(`  - ${summary.harnessConfigPath}`);
    console.log(`  - ${summary.toolGuidancePath}`);
    for (const p of summary.scaffoldResult.createdOrUpdatedPaths) {
      console.log(`  - ${p}`);
    }
    return await finish();
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

export async function runConfigCliCommand(opts: {
  subcommand?: string;
  positionals: string[];
  repoRoot: string;
  provider?: string;
  effort?: string;
  maxLaps?: number;
  parallel?: number;
  intervalSeconds?: number;
  baseBranch?: string;
  staticCmd?: string;
  unitCmd?: string;
  workWindow?: string;
  timezone?: string;
  agentsMdAction?: "keep" | "upgrade" | "overwrite";
  fileGlob?: string;
  forbidRegex?: string;
  requireRegex?: string;
  hint?: string;
  mode?: string;
  json?: boolean;
}): Promise<number> {
  const sub = opts.subcommand ?? "show";
  const repoRoot = resolve(opts.repoRoot);

  try {
    if (sub === "audit") {
      const report = auditRepositoryHarness(repoRoot);
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Repository Harness Audit (${repoRoot}):`);
        console.log(`  Project Mode:       ${report.projectMode.toUpperCase()}`);
        console.log(
          `  AGENTS.md Status:   ${report.agentsMd.status.toUpperCase()} (score: ${report.agentsMd.score}/100, lines: ${report.agentsMd.lineCount})`,
        );
        for (const issue of report.agentsMd.issues) {
          console.log(`    - ${issue}`);
        }
        console.log(`  CLAUDE.md Symlink:  ${report.claudeMdSymlink ? "present" : "missing"}`);
        console.log(
          `  Installed Skills:   ${report.skillsInstalled.length}/10 (${report.skillsInstalled.join(", ") || "none"})`,
        );
        console.log(
          `  Hooks Installed:    loop-guard=${report.hooksInstalled.loopGuard}, holdout-fence=${report.hooksInstalled.holdoutFence}`,
        );
        console.log(
          `  Governance Files:   lessons=${report.governanceFiles.lessonsJsonl}, tool-guidance=${report.governanceFiles.toolGuidanceJson}, holdout=${report.governanceFiles.holdoutMd}, ci-runner=${report.governanceFiles.harnessCiRunner}`,
        );
      }
      return 0;
    }

    if (sub === "show" || sub === "list") {
      const archonConfig = readArchonConfig(repoRoot);
      const scheduleConfig = loadScheduleConfig(repoRoot);
      const harnessPath = join(repoRoot, "harness/harness.config.json");
      const harnessConfig = existsSync(harnessPath)
        ? JSON.parse(readFileSync(harnessPath, "utf-8"))
        : detectRepoCheckCommands(repoRoot);
      const detectedHarnesses = detectAvailableHarnesses();
      const harnessAudit = auditRepositoryHarness(repoRoot);

      const payload = {
        repoRoot,
        detectedHarnesses,
        harnessAudit,
        archonConfig,
        scheduleConfig,
        harnessConfig,
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return 0;
      }

      console.log(`Repository Configuration (${repoRoot}):\n`);
      console.log("Available Agent Harnesses:");
      for (const h of detectedHarnesses) {
        const status = h.installed ? `installed (${h.binaryPath})` : "not installed";
        console.log(
          `  - ${h.id.padEnd(10)} ${h.displayName.padEnd(16)} ${status} [efforts: ${h.supportedEfforts.join(", ")}]`,
        );
      }

      console.log("\nAGENTS.md & Harness Health:");
      console.log(
        `  AGENTS.md:         ${harnessAudit.agentsMd.status.toUpperCase()} (score: ${harnessAudit.agentsMd.score}/100, lines: ${harnessAudit.agentsMd.lineCount})`,
      );
      console.log(`  Skills Installed:  ${harnessAudit.skillsInstalled.length}/10`);

      console.log("\nModel Tiers (.archon/config.yaml):");
      console.log(`  Default Assistant: ${archonConfig.assistant ?? "pi"}`);
      for (const t of ["small", "medium", "large"] as const) {
        const b = archonConfig.tiers?.[t];
        console.log(
          `  ${t.padEnd(8)} -> ${b ? `${b.provider}/${b.model} (effort: ${b.effort ?? "default"})` : "not set"}`,
        );
      }
      if (archonConfig.aliases && Object.keys(archonConfig.aliases).length > 0) {
        for (const [alias, b] of Object.entries(archonConfig.aliases)) {
          console.log(
            `  ${alias.padEnd(8)} -> ${b.provider}/${b.model} (effort: ${b.effort ?? "default"})`,
          );
        }
      }

      console.log("\nLoop & Laps (.factory/schedule.json):");
      console.log(`  Workflow:          ${scheduleConfig.workflow}`);
      console.log(`  Max Laps / Issue:  ${scheduleConfig.max_laps}`);
      console.log(`  Parallel Laps:     ${scheduleConfig.parallel}`);
      console.log(`  Poll Interval:     ${scheduleConfig.interval_seconds}s`);
      console.log(
        `  Work Window:       ${scheduleConfig.work_window?.enabled ? `${scheduleConfig.work_window.start_time}-${scheduleConfig.work_window.end_time} (${scheduleConfig.work_window.timezone})` : "disabled (24/7)"}`,
      );
      console.log(`  Base Branch:       ${archonConfig.worktree?.baseBranch ?? "main"}`);

      console.log("\nVerification Harness (harness/harness.config.json):");
      console.log(`  Static Check:      ${harnessConfig.static ?? harnessConfig.staticCheck}`);
      console.log(`  Unit Test:         ${harnessConfig.unit ?? harnessConfig.unitTest}`);
      return 0;
    }

    if (sub === "harnesses" || sub === "providers") {
      const harnesses = detectAvailableHarnesses();
      if (opts.json) {
        console.log(JSON.stringify(harnesses, null, 2));
      } else {
        console.log("Supported Agent Harnesses:\n");
        for (const h of harnesses) {
          const badge = h.installed ? "[INSTALLED]" : "[MISSING]  ";
          console.log(
            `  ${badge} ${h.id.padEnd(10)} ${h.displayName.padEnd(16)} ${h.binaryPath ?? "not found in PATH"}`,
          );
          console.log(`              Supported efforts: ${h.supportedEfforts.join(", ")}`);
        }
      }
      return 0;
    }

    if (sub === "tier") {
      const tierArg = opts.positionals[2] as ModelTier | undefined;
      const providerArg = opts.positionals[3];
      const modelArg = opts.positionals[4];

      if (
        !tierArg ||
        !["small", "medium", "large"].includes(tierArg) ||
        !providerArg ||
        !modelArg
      ) {
        throw new Error(
          "Usage: labq-factory config tier <small|medium|large> <provider> <model> [--effort <minimal|low|medium|high|xhigh|max|ultra>]",
        );
      }
      if (!isSupportedProvider(providerArg)) {
        throw new Error(
          `Unsupported provider '${providerArg}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
        );
      }
      const effortVal = opts.effort;
      if (effortVal !== undefined && !isEffortRung(effortVal)) {
        throw new Error(`Invalid effort '${effortVal}'. Supported: ${EFFORT_LADDER.join(", ")}`);
      }

      validateTierBinding({
        provider: providerArg,
        model: modelArg,
        ...(effortVal ? { effort: effortVal as EffortRung } : {}),
      });
      const cfg = readArchonConfig(repoRoot);
      const updated: ArchonConfig = {
        ...cfg,
        assistants: { ...cfg.assistants, [providerArg]: { model: modelArg } },
        assistant: cfg.assistant ?? providerArg,
        tiers: {
          ...cfg.tiers,
          [tierArg]: {
            provider: providerArg,
            model: modelArg,
            ...(effortVal ? { effort: effortVal } : {}),
          },
        },
      };
      if (tierArg === "large") {
        updated.aliases = {
          ...cfg.aliases,
          "@reasoning": {
            provider: providerArg,
            model: modelArg,
            ...(effortVal ? { effort: effortVal } : {}),
          },
        };
      }
      const path = writeArchonConfig(repoRoot, updated);
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: true, tier: tierArg, binding: updated.tiers?.[tierArg], path },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `Updated tier '${tierArg}' -> ${providerArg}/${modelArg}${effortVal ? ` (effort: ${effortVal})` : ""} in ${path}`,
        );
      }
      return 0;
    }

    if (sub === "laps" || sub === "schedule") {
      const summary = await applyRepositorySetup({
        repoRoot,
        nonInteractive: true,
        maxLaps: opts.maxLaps,
        parallel: opts.parallel,
        intervalSeconds: opts.intervalSeconds,
        baseBranch: opts.baseBranch,
        workWindow: opts.workWindow,
        timezone: opts.timezone,
        agentsMdAction: "keep",
        json: true,
      });
      if (opts.json) {
        console.log(JSON.stringify(summary.scheduleConfig, null, 2));
      } else {
        console.log(
          `Updated loop/laps config: max_laps=${summary.scheduleConfig.max_laps}, parallel=${summary.scheduleConfig.parallel}, interval=${summary.scheduleConfig.interval_seconds}s`,
        );
      }
      return 0;
    }

    if (sub === "harness") {
      const summary = await applyRepositorySetup({
        repoRoot,
        nonInteractive: true,
        provider: opts.provider,
        staticCmd: opts.staticCmd,
        unitCmd: opts.unitCmd,
        agentsMdAction: opts.agentsMdAction ?? "keep",
        json: true,
      });
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              assistant: summary.archonConfig.assistant,
              harnessConfig: summary.harnessConfig,
              scaffoldResult: summary.scaffoldResult,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `Updated harness config: assistant=${summary.archonConfig.assistant}, static="${summary.harnessConfig.static}", unit="${summary.harnessConfig.unit}"`,
        );
      }
      return 0;
    }

    if (sub === "pattern" || sub === "patterns" || sub === "component" || sub === "components") {
      // Usage: labq-factory config pattern <domain> "<guidance>"
      const domainKey = opts.positionals[2];
      const guidanceText = opts.positionals.slice(3).join(" ").trim();
      const { persistCodebaseRulesUpdates } = await import("../../loop/reflector");
      const rulesPath = join(repoRoot, ".factory/codebase-rules.json");

      if (!domainKey) {
        const current = existsSync(rulesPath)
          ? JSON.parse(readFileSync(rulesPath, "utf-8"))
          : { pattern_registry: {}, rules: [] };
        const reg = { ...current.component_registry, ...current.pattern_registry };
        if (opts.json) {
          console.log(JSON.stringify(reg, null, 2));
        } else {
          console.log("Registered Shared Patterns & Modules (.factory/codebase-rules.json):");
          for (const [k, v] of Object.entries(reg)) {
            console.log(`  - [${k}] ${typeof v === "string" ? v : JSON.stringify(v)}`);
          }
        }
        return 0;
      }

      if (!guidanceText) {
        throw new Error('Usage: labq-factory config pattern <domain> "<guidance>"');
      }

      const res = persistCodebaseRulesUpdates(repoRoot, { [domainKey]: guidanceText });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, updatedPatterns: res.updatedComponents }, null, 2));
      } else {
        console.log(`Registered pattern guidance [${domainKey}] -> ${guidanceText}`);
      }
      return 0;
    }

    if (sub === "rule" || sub === "rules") {
      // Usage: labq-factory config rule <id> --glob "<glob>" --forbid "<regex>" --hint "<hint>" [--mode warn|block]
      const ruleId = opts.positionals[2];
      const { persistCodebaseRulesUpdates } = await import("../../loop/reflector");
      const rulesPath = join(repoRoot, ".factory/codebase-rules.json");

      if (!ruleId) {
        const current = existsSync(rulesPath)
          ? JSON.parse(readFileSync(rulesPath, "utf-8"))
          : { component_registry: {}, rules: [] };
        if (opts.json) {
          console.log(JSON.stringify(current.rules ?? [], null, 2));
        } else {
          console.log(`Codebase Rules (${(current.rules ?? []).length}):`);
          for (const r of current.rules ?? []) {
            console.log(
              `  - [${r.id}] (${r.mode ?? "warn"}) glob=${r.file_glob} -> ${r.replacement_hint}`,
            );
          }
        }
        return 0;
      }

      if (!opts.fileGlob || !opts.hint || (!opts.forbidRegex && !opts.requireRegex)) {
        throw new Error(
          'Usage: labq-factory config rule <id> --glob "<glob>" --forbid "<regex>" --hint "<replacement hint>" [--mode warn|block]',
        );
      }

      const modeVal = opts.mode === "block" ? "block" : "warn";
      const res = persistCodebaseRulesUpdates(repoRoot, undefined, [
        {
          id: ruleId,
          description: opts.positionals.slice(3).join(" ").trim() || ruleId,
          file_glob: opts.fileGlob,
          ...(opts.forbidRegex ? { forbid_regex: opts.forbidRegex } : {}),
          ...(opts.requireRegex ? { require_regex: opts.requireRegex } : {}),
          replacement_hint: opts.hint,
          mode: modeVal,
        },
      ]);

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, updatedRules: res.updatedRules }, null, 2));
      } else {
        console.log(
          `Configured codebase rule '${ruleId}' (mode=${modeVal}, glob=${opts.fileGlob})`,
        );
      }
      return 0;
    }

    throw new Error(
      `Unknown config subcommand: ${sub}. Expected show, audit, harnesses, tier, laps, harness, component, or rule.`,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}
