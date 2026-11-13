import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { mergeYamlFile, readYamlObject, removeFileIfExists } from "./config-file";
import { resolveAnimusHome } from "./paths";

/**
 * Machine-level Animus configuration (`~/.animus/config.yaml`).
 *
 * This is the single source of truth for machine-wide settings: the provider
 * fleet detected on this machine, the platform defaults, the GitHub credential
 * state, and the marker proving `animus onboard` completed. Per-repository
 * settings live in `<repo>/.animus/config.yaml` and are never written here.
 *
 * An optional top-level `schedule:` block carries the user's global override
 * (formerly `~/.animus/schedule.json`); it is not part of this schema because
 * no machine command owns it, and YAML merges preserve it across writes.
 */
export const MACHINE_CONFIG_SCHEMA_VERSION = 1;

export const providerItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  binary: z.string(),
  path: z.string(),
  version: z.string(),
  efforts: z.string().default("low · medium · high"),
  capabilities: z.string().default("Resume · Fork"),
  status: z.enum(["INSTALLED", "COMING SOON"]).default("INSTALLED"),
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export const tierBindingSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().optional(),
});

export type TierBindingConfig = z.infer<typeof tierBindingSchema>;

export const TIER_NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

export const DEFAULT_TIER_KEYS = ["small", "medium", "large"] as const;

export const modelTiersRecordSchema = z.record(
  z.string().regex(TIER_NAME_REGEX, "Tier key must be lowercase alphanumeric/hyphen/underscore"),
  tierBindingSchema,
);

export function defaultMachineTiers(defaultProvider = "pi"): Record<string, TierBindingConfig> {
  return {
    small: { provider: defaultProvider, model: "default", effort: "medium" },
    medium: { provider: defaultProvider, model: "default", effort: "high" },
    large: { provider: defaultProvider, model: "default", effort: "high" },
  };
}

export type ProviderItem = z.infer<typeof providerItemSchema>;

export const platformSettingsSchema = z.object({
  schemaVersion: z.number().int().default(MACHINE_CONFIG_SCHEMA_VERSION),
  system: z
    .object({
      remoteAccess: z.boolean().default(false),
      bindAddress: z.string().default("127.0.0.1"),
      vaultEnabled: z.boolean().default(true),
      hostOrigin: z.string().default("http://127.0.0.1:4000"),
      defaultProvider: z.string().default("pi"),
      /** ISO timestamp written by `animus onboard`; absent means not onboarded. */
      onboardedAt: z.string().optional(),
      /** Absolute path of the Animus runtime source tree used by `animus start`. */
      runtimeRoot: z.string().optional(),
    })
    .default({
      remoteAccess: false,
      bindAddress: "127.0.0.1",
      vaultEnabled: true,
      hostOrigin: "http://127.0.0.1:4000",
      defaultProvider: "pi",
    }),
  providers: z.array(providerItemSchema).default([]),
  tiers: modelTiersRecordSchema.optional(),
  automation: z
    .object({
      parallelJobs: z.number().default(2),
      maxLaps: z.number().default(3),
      pollInterval: z.number().default(300),
      continuations: z.number().default(1),
      limitWorkWindow: z.boolean().default(true),
      startTime: z.string().default("20:00"),
      endTime: z.string().default("05:00"),
      timezone: z.string().default("Asia/Jakarta (UTC+7)"),
      schedulePaused: z.boolean().default(false),
      globalBrake: z.boolean().default(false),
    })
    .default({
      parallelJobs: 2,
      maxLaps: 3,
      pollInterval: 300,
      continuations: 1,
      limitWorkWindow: true,
      startTime: "20:00",
      endTime: "05:00",
      timezone: "Asia/Jakarta (UTC+7)",
      schedulePaused: false,
      globalBrake: false,
    }),
  github: z
    .object({
      appId: z.string().default(""),
      appName: z.string().default(""),
      installationId: z.string().default(""),
      connected: z.boolean().default(false),
      lastChecked: z.string().default(""),
      pat: z.string().default(""),
      readyEvent: z.boolean().default(true),
      changeEvent: z.boolean().default(true),
      reviewEvent: z.boolean().default(true),
    })
    .default({
      appId: "",
      appName: "",
      installationId: "",
      connected: false,
      lastChecked: "",
      pat: "",
      readyEvent: true,
      changeEvent: true,
      reviewEvent: true,
    }),
});

export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export type PlatformSettingsUpdate = {
  system?: Partial<PlatformSettings["system"]>;
  providers?: PlatformSettings["providers"];
  tiers?: Record<string, TierBindingConfig>;
  automation?: Partial<PlatformSettings["automation"]>;
  github?: Partial<PlatformSettings["github"]>;
};

export class MachineOnboardingRequiredError extends Error {
  readonly code = "machine_not_onboarded";
  constructor(readonly configPath: string) {
    super(
      `Animus has not been onboarded on this machine. Run \`animus onboard\` first (expected config: ${configPath}).`,
    );
    this.name = "MachineOnboardingRequiredError";
  }
}

export class MachineConfigSchemaError extends Error {
  readonly code = "machine_config_schema_outdated";
  constructor(
    readonly configPath: string,
    readonly foundVersion: number,
  ) {
    super(
      `Machine configuration at ${configPath} uses schema version ${foundVersion}; this build requires ${MACHINE_CONFIG_SCHEMA_VERSION}. Run \`animus onboard --reconfigure\`.`,
    );
    this.name = "MachineConfigSchemaError";
  }
}

export interface MachineOnboardingState {
  onboarded: boolean;
  configPath: string;
  onboardedAt?: string;
  schemaVersion: number;
  reason?: "missing" | "unreadable" | "schema_outdated" | "incomplete";
}

export function machineConfigPath(home?: string): string {
  return join(resolveAnimusHome(home), "config.yaml");
}

/** Pre-YAML machine configuration; migrated once on read. */
export function legacyMachineConfigPath(home?: string): string {
  return join(resolveAnimusHome(home), "config.json");
}

/**
 * Folds `~/.animus/config.json` into `config.yaml` once. A file that fails
 * validation is left in place rather than deleted, so nothing is lost.
 */
function migrateLegacyMachineConfig(home?: string): void {
  const path = machineConfigPath(home);
  if (existsSync(path)) return;
  const legacy = legacyMachineConfigPath(home);
  if (!existsSync(legacy)) return;
  try {
    const parsed = platformSettingsSchema.safeParse(JSON.parse(readFileSync(legacy, "utf-8")));
    if (!parsed.success) return;
    writeMachineConfig(parsed.data, home);
    removeFileIfExists(legacy);
  } catch {}
}

/** Returns null when the file is absent or unparseable; onboarding must not fail open. */
export function readMachineConfig(home?: string): PlatformSettings | null {
  migrateLegacyMachineConfig(home);
  const raw = readYamlObject(machineConfigPath(home));
  if (!raw) return null;
  const parsed = platformSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Writes the machine configuration atomically with owner-only permissions.
 * The file can carry a GitHub PAT, so it must never be world-readable.
 */
export function writeMachineConfig(config: PlatformSettings, home?: string): string {
  const path = machineConfigPath(home);
  const validated = platformSettingsSchema.parse(config);
  mkdirSync(resolveAnimusHome(home), { recursive: true, mode: 0o700 });
  // Merging keeps the operator-owned `schedule:` block (and its comments) intact.
  return mergeYamlFile(path, validated as Record<string, unknown>, { mode: 0o600 });
}

export function machineOnboardingStatus(home?: string): MachineOnboardingState {
  migrateLegacyMachineConfig(home);
  const configPath = machineConfigPath(home);
  if (!existsSync(configPath)) {
    return { onboarded: false, configPath, schemaVersion: 0, reason: "missing" };
  }
  const raw = readYamlObject(configPath);
  if (!raw) {
    return { onboarded: false, configPath, schemaVersion: 0, reason: "unreadable" };
  }
  const parsed = platformSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return { onboarded: false, configPath, schemaVersion: 0, reason: "unreadable" };
  }
  const config = parsed.data;
  if (config.schemaVersion < MACHINE_CONFIG_SCHEMA_VERSION) {
    return {
      onboarded: false,
      configPath,
      schemaVersion: config.schemaVersion,
      reason: "schema_outdated",
    };
  }
  if (!config.system.onboardedAt?.trim()) {
    return {
      onboarded: false,
      configPath,
      schemaVersion: config.schemaVersion,
      reason: "incomplete",
    };
  }
  return {
    onboarded: true,
    configPath,
    onboardedAt: config.system.onboardedAt,
    schemaVersion: config.schemaVersion,
  };
}

/**
 * Dispatch and per-repository setup call this before writing anything.
 * Absent, unreadable, outdated, or incomplete machine configuration is refused
 * with an actionable error instead of silently falling back to defaults.
 */
export function assertMachineOnboarded(home?: string): MachineOnboardingState {
  const status = machineOnboardingStatus(home);
  if (status.reason === "schema_outdated") {
    throw new MachineConfigSchemaError(status.configPath, status.schemaVersion);
  }
  if (!status.onboarded) {
    throw new MachineOnboardingRequiredError(status.configPath);
  }
  return status;
}

/**
 * Machine onboarding is a hard prerequisite for anything that needs machine
 * defaults. Returns the parsed configuration so callers can inherit policy.
 */
export function requireMachineConfig(home?: string): PlatformSettings {
  assertMachineOnboarded(home);
  const config = readMachineConfig(home);
  if (!config) throw new MachineOnboardingRequiredError(machineConfigPath(home));
  return config;
}
