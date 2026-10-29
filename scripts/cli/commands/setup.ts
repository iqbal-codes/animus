import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
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
  const parts = spec.split(":");
  if (parts.length >= 3 && isSupportedProvider(parts[0]!)) {
    const provider = parts[0]!;
    const effortCandidate = parts[parts.length - 1]!;
    if (isEffortRung(effortCandidate)) {
      const model = parts.slice(1, -1).join(":");
      return { provider, model, effort: effortCandidate };
    }
  }
  if (parts.length >= 2 && isSupportedProvider(parts[0]!)) {
    return {
      provider: parts[0]!,
      model: parts.slice(1).join(":"),
    };
  }
  return {
    provider: fallbackProvider,
    model: spec,
  };
}

export interface SetupCommandOptions {
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

export async function applyRepositorySetup(opts: SetupCommandOptions): Promise<SetupConfigSummary> {
  const repoRoot = resolve(opts.repoRoot);
  const detectedHarnesses = detectAvailableHarnesses();
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

  let selectedProvider = defaultProvider;
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

  if (opts.smallTier) smallBinding = parseTierSpec(opts.smallTier, selectedProvider);
  if (opts.mediumTier) mediumBinding = parseTierSpec(opts.mediumTier, selectedProvider);
  if (opts.largeTier) largeBinding = parseTierSpec(opts.largeTier, selectedProvider);

  if (opts.workWindow) {
    if (opts.workWindow === "off" || opts.workWindow === "false" || opts.workWindow === "none") {
      workWindowEnabled = false;
    } else {
      const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(opts.workWindow.trim());
      if (match) {
        workWindowEnabled = true;
        workWindowStart = match[1]!;
        workWindowEnd = match[2]!;
      }
    }
  }

  const isInteractive = !opts.nonInteractive && !opts.json && Boolean(process.stdin.isTTY);
  if (isInteractive) {
    console.log("\n╭──────────────────────────────────────────────────────────╮");
    console.log("│  LabQ Software Factory — Repository Onboarding & Setup   │");
    console.log("╰──────────────────────────────────────────────────────────╯\n");
    console.log(`Target Repository: ${repoRoot} (mode: ${harnessAudit.projectMode.toUpperCase()})\n`);
    console.log("1. Detected Agent Harnesses on this Host:");
    for (const h of detectedHarnesses) {
      const badge = h.installed ? "✓ INSTALLED" : "✗ missing  ";
      const detail = h.installed
        ? `${h.binaryPath}${h.version ? ` (${h.version})` : ""}`
        : `(${h.binaryName} not found in PATH)`;
      console.log(`   [${badge}] ${h.id.padEnd(10)} ${h.displayName.padEnd(16)} ${detail}`);
    }

    console.log("\n2. Repository Harness & AGENTS.md Audit:");
    console.log(
      `   AGENTS.md status: ${harnessAudit.agentsMd.status.toUpperCase()} (score: ${harnessAudit.agentsMd.score}/100, lines: ${harnessAudit.agentsMd.lineCount})`,
    );
    for (const issue of harnessAudit.agentsMd.issues) {
      console.log(`     - ${issue}`);
    }
    console.log(
      `   Installed skills: ${harnessAudit.skillsInstalled.length}/10 (${harnessAudit.skillsInstalled.join(", ") || "none"})`,
    );
    console.log("");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (promptText: string, defaultVal: string): Promise<string> => {
      const ans = (await rl.question(`? ${promptText} [${defaultVal}]: `)).trim();
      return ans || defaultVal;
    };

    try {
      const provInput = await ask(
        `Default agent harness (${SUPPORTED_PROVIDERS.join("/")})`,
        selectedProvider,
      );
      if (isSupportedProvider(provInput)) {
        if (provInput !== selectedProvider) {
          selectedProvider = provInput;
          const pDef = DEFAULT_PROVIDER_MODELS[selectedProvider];
          smallBinding = { provider: selectedProvider, model: pDef.small, effort: "medium" };
          mediumBinding = { provider: selectedProvider, model: pDef.medium, effort: "high" };
          largeBinding = { provider: selectedProvider, model: pDef.large, effort: "high" };
        }
      }

      if (!harnessAudit.agentsMd.exists) {
        console.log("\n   [Greenfield] AGENTS.md will be created with canonical Factory pointers.");
        agentsMdAction = "overwrite";
      } else if (harnessAudit.agentsMd.status === "poor") {
        const actIn = await ask(
          "Existing AGENTS.md is incomplete. Action (upgrade/overwrite/keep)",
          "upgrade",
        );
        if (actIn === "upgrade" || actIn === "overwrite" || actIn === "keep") {
          agentsMdAction = actIn;
        }
      } else {
        const actIn = await ask("AGENTS.md is already healthy. Action (keep/upgrade/overwrite)", "keep");
        if (actIn === "upgrade" || actIn === "overwrite" || actIn === "keep") {
          agentsMdAction = actIn;
        }
      }

      console.log("\n3. Model Tiers (format: provider:model:effort or model):");
      const smallIn = await ask(
        "Small tier (QA / Auditor)",
        `${smallBinding.provider}:${smallBinding.model}:${smallBinding.effort ?? "medium"}`,
      );
      smallBinding = parseTierSpec(smallIn, selectedProvider);

      const medIn = await ask(
        "Medium tier (Builder / Simplifier)",
        `${mediumBinding.provider}:${mediumBinding.model}:${mediumBinding.effort ?? "high"}`,
      );
      mediumBinding = parseTierSpec(medIn, selectedProvider);

      const largeIn = await ask(
        "Large tier (Reviewer / Planner / Manager)",
        `${largeBinding.provider}:${largeBinding.model}:${largeBinding.effort ?? "high"}`,
      );
      largeBinding = parseTierSpec(largeIn, selectedProvider);

      console.log("\n4. Loop & Laps Capacity:");
      const lapsIn = await ask("Max laps per issue before escalating to owner", String(maxLaps));
      if (/^[1-9]\d*$/.test(lapsIn)) maxLaps = Number(lapsIn);

      const parIn = await ask("Max parallel autonomous laps", String(parallel));
      if (/^[1-9]\d*$/.test(parIn)) parallel = Number(parIn);

      const intIn = await ask("Scheduler polling interval (seconds)", String(intervalSeconds));
      if (/^[1-9]\d*$/.test(intIn)) intervalSeconds = Number(intIn);

      const baseIn = await ask("Default base branch for worktrees & PRs", baseBranch);
      if (baseIn) baseBranch = baseIn;

      console.log("\n5. Repository Verification Harness Commands:");
      staticCheck = await ask("Static check command (lint + typecheck)", staticCheck);
      unitTest = await ask("Unit test command", unitTest);
    } finally {
      rl.close();
    }
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
    assistants: {
      ...(existingArchon.assistants ?? {}),
      [selectedProvider]: { model: mediumBinding.model },
    },
    tiers: {
      small: smallBinding,
      medium: mediumBinding,
      large: largeBinding,
    },
    aliases: {
      ...(existingArchon.aliases ?? {}),
      "@reasoning": {
        provider: largeBinding.provider,
        model: largeBinding.model,
        effort: largeBinding.effort ?? "high",
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

export async function runSetupCommand(opts: SetupCommandOptions): Promise<number> {
  try {
    const summary = await applyRepositorySetup(opts);
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }

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
    return 0;
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

      if (!tierArg || !["small", "medium", "large"].includes(tierArg) || !providerArg || !modelArg) {
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
        throw new Error(
          `Invalid effort '${effortVal}'. Supported: ${EFFORT_LADDER.join(", ")}`,
        );
      }

      const cfg = readArchonConfig(repoRoot);
      const updated: ArchonConfig = {
        ...cfg,
        assistant: cfg.assistant ?? providerArg,
        tiers: {
          ...(cfg.tiers ?? {}),
          [tierArg]: {
            provider: providerArg,
            model: modelArg,
            ...(effortVal ? { effort: effortVal } : {}),
          },
        },
      };
      if (tierArg === "large") {
        updated.aliases = {
          ...(cfg.aliases ?? {}),
          "@reasoning": {
            provider: providerArg,
            model: modelArg,
            effort: effortVal ?? cfg.aliases?.["@reasoning"]?.effort ?? "high",
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

    if (
      sub === "pattern" ||
      sub === "patterns" ||
      sub === "component" ||
      sub === "components"
    ) {
      // Usage: labq-factory config pattern <domain> "<guidance>"
      const domainKey = opts.positionals[2];
      const guidanceText = opts.positionals.slice(3).join(" ").trim();
      const { persistCodebaseRulesUpdates } = await import("../../loop/reflector");
      const rulesPath = join(repoRoot, ".factory/codebase-rules.json");

      if (!domainKey) {
        const current = existsSync(rulesPath)
          ? JSON.parse(readFileSync(rulesPath, "utf-8"))
          : { pattern_registry: {}, rules: [] };
        const reg = { ...(current.component_registry ?? {}), ...(current.pattern_registry ?? {}) };
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
            console.log(`  - [${r.id}] (${r.mode ?? "warn"}) glob=${r.file_glob} -> ${r.replacement_hint}`);
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
        console.log(`Configured codebase rule '${ruleId}' (mode=${modeVal}, glob=${opts.fileGlob})`);
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
