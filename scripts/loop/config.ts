import {
  readRepoConfig,
  writeRepoConfig,
  type RepoConfigFile,
} from "../../packages/contracts/src/repo-config";
import type { LoopRole, ModelTier } from "./types";
import { type EffortRung, isEffortRung } from "./providers";

export interface TierBinding {
  provider: string;
  model: string;
  effort?: EffortRung;
}

export interface RoleBinding {
  tier?: ModelTier;
  provider?: string;
  model?: string;
  effort?: EffortRung;
}

export interface AnimusConfig {
  assistant?: string;
  assistants?: Record<string, { model: string }>;
  tiers?: Partial<Record<ModelTier, TierBinding>>;
  aliases?: Record<string, TierBinding>;
  roles?: Partial<Record<LoopRole, RoleBinding | ModelTier>>;
  worktree?: { baseBranch?: string; strategy?: string };
  loop?: { resumeBuilderSession?: boolean | string };
  concurrencyLimit?: number;
  releases?: Record<string, unknown>;
}

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

export function resolveModelTier(role: LoopRole, rootOrConfig?: string | AnimusConfig): ModelTier {
  if (rootOrConfig) {
    const config = typeof rootOrConfig === "string" ? readAnimusConfig(rootOrConfig) : rootOrConfig;
    const roleOverride = config.roles?.[role];
    if (
      typeof roleOverride === "string" &&
      (roleOverride === "small" || roleOverride === "medium" || roleOverride === "large")
    ) {
      return roleOverride;
    }
    if (roleOverride && typeof roleOverride === "object" && typeof roleOverride.tier === "string") {
      if (
        roleOverride.tier === "small" ||
        roleOverride.tier === "medium" ||
        roleOverride.tier === "large"
      ) {
        return roleOverride.tier;
      }
    }
  }

  switch (role) {
    case "reviewer":
    case "reflector":
    case "planner":
    case "manager":
      return "large";
    case "builder":
    case "investigator":
    case "simplifier":
    case "triage":
      return "medium";
    case "qa":
    case "auditor":
    default:
      return "small";
  }
}

export function resolveModelForRole(
  root: string,
  role: LoopRole,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.FACTORY_LOOP_MODEL) return env.FACTORY_LOOP_MODEL;
  const config = readAnimusConfig(root);
  const roleOverride = config.roles?.[role];
  if (roleOverride && typeof roleOverride === "object" && roleOverride.model) {
    return roleOverride.model;
  }
  const tier = resolveModelTier(role, config);

  if ((role === "reviewer" || role === "reflector") && config.aliases?.["@reasoning"]?.model) {
    return config.aliases["@reasoning"].model;
  }

  if (config.tiers?.[tier]?.model) {
    return config.tiers[tier]!.model;
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
  const roleOverride = config.roles?.[role];
  if (roleOverride && typeof roleOverride === "object" && roleOverride.provider) {
    return roleOverride.provider;
  }
  const tier = resolveModelTier(role, config);

  if ((role === "reviewer" || role === "reflector") && config.aliases?.["@reasoning"]?.provider) {
    return config.aliases["@reasoning"].provider;
  }

  if (config.tiers?.[tier]?.provider) {
    return config.tiers[tier]!.provider;
  }

  if (config.assistant) {
    return config.assistant;
  }

  return "pi";
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
  const roleOverride = config.roles?.[role];
  if (
    roleOverride &&
    typeof roleOverride === "object" &&
    roleOverride.effort &&
    isEffortRung(roleOverride.effort)
  ) {
    return roleOverride.effort;
  }
  const tier = resolveModelTier(role, config);

  if (
    (role === "reviewer" || role === "reflector") &&
    config.aliases?.["@reasoning"]?.effort &&
    isEffortRung(config.aliases["@reasoning"].effort)
  ) {
    return config.aliases["@reasoning"].effort;
  }

  if (config.tiers?.[tier]?.effort && isEffortRung(config.tiers[tier]!.effort)) {
    return config.tiers[tier]!.effort;
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
