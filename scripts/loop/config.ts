import { readMachineConfig, TIER_NAME_REGEX } from "../../packages/contracts/src/machine-config";
import {
  readRepoConfig,
  writeRepoConfig,
  type RepoConfigFile,
} from "../../packages/contracts/src/repo-config";
import { PIPELINE_ROLES, type LoopRole, type ModelTier } from "./types";
import { type EffortRung, isEffortRung } from "./providers";

export interface TierBinding {
  provider: string;
  model: string;
  effort?: EffortRung;
}

export interface AnimusConfig {
  assistant?: string;
  assistants?: Record<string, { model: string }>;
  tiers?: Record<string, TierBinding>;
  roles?: Partial<Record<LoopRole, ModelTier>>;
  worktree?: { baseBranch?: string; strategy?: string };
  loop?: { resumeBuilderSession?: boolean | string };
  concurrencyLimit?: number;
  releases?: Record<string, unknown>;
}

export const DEFAULT_ROLE_TIERS: Record<LoopRole, "small" | "medium" | "large"> = {
  triage: "medium",
  planner: "large",
  builder: "medium",
  qa: "small",
  reviewer: "large",
  reflector: "large",
};

/**
 * Reads `<repo>/.animus/config.yaml`, migrating a legacy `schedule.json` into
 * the same file on first read. Unknown keys are preserved for whoever wrote them.
 */
export function readAnimusConfig(root: string): AnimusConfig {
  return readRepoConfig(root) as AnimusConfig;
}

/** Merges `config` into the repository YAML file; keys not mentioned survive. */
export function writeAnimusConfig(root: string, config: AnimusConfig): string {
  return writeRepoConfig(root, config as RepoConfigFile);
}

function resolveUserTiers(): Record<string, TierBinding> {
  try {
    const machine = readMachineConfig();
    if (!machine?.tiers) return {};
    const out: Record<string, TierBinding> = {};
    for (const [key, binding] of Object.entries(machine.tiers)) {
      if (!binding?.provider || !binding?.model) continue;
      out[key] = {
        provider: binding.provider,
        model: binding.model,
        ...(binding.effort && isEffortRung(binding.effort) ? { effort: binding.effort } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function resolveUserDefaultProvider(): string | undefined {
  try {
    return readMachineConfig()?.system.defaultProvider;
  } catch {
    return undefined;
  }
}

function resolveTierBinding(config: AnimusConfig, tier: ModelTier): TierBinding | undefined {
  const repoTier = config.tiers?.[tier];
  if (repoTier && typeof repoTier === "object" && repoTier.provider && repoTier.model) {
    return repoTier;
  }
  const userTiers = resolveUserTiers();
  const userTier = userTiers[tier];
  if (userTier) {
    return userTier;
  }
  return undefined;
}

export function isValidTierName(name: string): boolean {
  return TIER_NAME_REGEX.test(name);
}

export function isPipelineRole(role: string): role is LoopRole {
  return (PIPELINE_ROLES as readonly string[]).includes(role);
}

export function resolveModelTier(role: LoopRole, rootOrConfig?: string | AnimusConfig): ModelTier {
  if (rootOrConfig) {
    const config = typeof rootOrConfig === "string" ? readAnimusConfig(rootOrConfig) : rootOrConfig;
    const roleOverride = config.roles?.[role];
    if (typeof roleOverride === "string" && isValidTierName(roleOverride.trim())) {
      return roleOverride.trim();
    }
  }
  return DEFAULT_ROLE_TIERS[role] ?? "small";
}

export function resolveModelForRole(
  root: string,
  role: LoopRole,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.FACTORY_LOOP_MODEL) return env.FACTORY_LOOP_MODEL;
  const config = readAnimusConfig(root);
  const tier = resolveModelTier(role, config);
  const tierBinding = resolveTierBinding(config, tier);
  if (tierBinding?.model) {
    return tierBinding.model;
  }

  if (config.assistant && config.assistants?.[config.assistant]?.model) {
    return config.assistants[config.assistant]!.model;
  }

  return undefined;
}

export function resolveProviderForRole(
  root: string,
  role: LoopRole,
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.FACTORY_LOOP_PROVIDER) return env.FACTORY_LOOP_PROVIDER;
  const config = readAnimusConfig(root);
  const tier = resolveModelTier(role, config);
  const tierBinding = resolveTierBinding(config, tier);
  if (tierBinding?.provider) {
    return tierBinding.provider;
  }

  if (config.assistant) {
    return config.assistant;
  }

  return resolveUserDefaultProvider() ?? "pi";
}

export function resolveEffortForRole(
  root: string,
  role: LoopRole,
  env: Record<string, string | undefined> = process.env,
): EffortRung | undefined {
  const roleEnvKey = `FACTORY_LOOP_${role.toUpperCase()}_EFFORT`;
  const roleEffort = env[roleEnvKey];
  if (roleEffort && isEffortRung(roleEffort)) {
    return roleEffort;
  }
  if (env.FACTORY_LOOP_EFFORT && isEffortRung(env.FACTORY_LOOP_EFFORT)) {
    return env.FACTORY_LOOP_EFFORT;
  }
  const config = readAnimusConfig(root);
  const tier = resolveModelTier(role, config);
  const tierBinding = resolveTierBinding(config, tier);
  if (tierBinding?.effort && isEffortRung(tierBinding.effort)) {
    return tierBinding.effort;
  }

  return undefined;
}
export function resolveRoleConfig(
  root: string,
  role: LoopRole,
  env: Record<string, string | undefined> = process.env,
): { provider: string; model?: string; effort?: EffortRung } {
  return {
    provider: resolveProviderForRole(root, role, env),
    model: resolveModelForRole(root, role, env),
    effort: resolveEffortForRole(root, role, env),
  };
}

/**
 * Whether a `continue` lap should resume the previous lap's builder session.
 * Off by default: the loop deliberately re-derives state from the worktree and
 * PR rather than trusting a prior transcript. Env wins over repository config.
 */
export function resolveResumeBuilderSession(
  root: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.FACTORY_LOOP_RESUME_BUILDER_SESSION;
  if (raw !== undefined) {
    return raw === "1" || raw.toLowerCase() === "true";
  }
  const configured = readAnimusConfig(root).loop?.resumeBuilderSession;
  return configured === true || configured === "true";
}
