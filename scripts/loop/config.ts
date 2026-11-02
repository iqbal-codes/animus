import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  worktree?: { baseBranch?: string };
}

export function parseYamlSimple(text: string): Record<string, any> {
  const result: Record<string, any> = {};
  let currentSection: string | null = null;
  let currentSubSection: string | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.trim().startsWith("#")) continue;

    // Top-level key: value or section:
    const topMatch = /^['"]?([a-zA-Z0-9_@-]+)['"]?:(?:\s*(.*))?$/.exec(line);
    if (topMatch && !line.startsWith(" ")) {
      const [, key, val] = topMatch;
      const cleanVal = val !== undefined ? val.trim().replace(/^['"]|['"]$/g, "") : undefined;
      if (cleanVal !== undefined && cleanVal !== "") {
        result[key!] = cleanVal;
        currentSection = null;
      } else {
        result[key!] = {};
        currentSection = key!;
      }
      currentSubSection = null;
      continue;
    }

    // 2-space indented key
    const subMatch = /^ {2}['"]?([a-zA-Z0-9_@-]+)['"]?:(?:\s*(.*))?$/.exec(line);
    if (subMatch && currentSection) {
      const [, key, val] = subMatch;
      const cleanVal = val !== undefined ? val.trim().replace(/^['"]|['"]$/g, "") : undefined;
      if (cleanVal !== undefined && cleanVal !== "") {
        result[currentSection][key!] = cleanVal;
        currentSubSection = null;
      } else {
        result[currentSection][key!] = {};
        currentSubSection = key!;
      }
      continue;
    }

    // 4-space indented key
    const subSubMatch = /^ {4}['"]?([a-zA-Z0-9_@-]+)['"]?:\s*(.*)$/.exec(line);
    if (subSubMatch && currentSection && currentSubSection) {
      const [, key, val] = subSubMatch;
      result[currentSection][currentSubSection][key!] = val!.trim().replace(/^['"]|['"]$/g, "");
    }
  }

  return result;
}

export function serializeAnimusConfigYaml(config: AnimusConfig): string {
  const lines: string[] = ["# Animus Repository Configuration for animus"];
  if (config.assistant) {
    lines.push(`assistant: ${config.assistant}`, "");
  }

  if (config.assistants && Object.keys(config.assistants).length > 0) {
    lines.push("assistants:");
    for (const [provider, settings] of Object.entries(config.assistants)) {
      lines.push(`  ${provider}:`);
      lines.push(`    model: ${settings.model}`);
    }
    lines.push("");
  }

  if (config.tiers && Object.keys(config.tiers).length > 0) {
    lines.push("tiers:");
    for (const tier of ["small", "medium", "large"] as const) {
      const binding = config.tiers[tier];
      if (!binding) continue;
      lines.push(`  ${tier}:`);
      lines.push(`    provider: ${binding.provider}`);
      lines.push(`    model: ${binding.model}`);
      if (binding.effort) {
        lines.push(`    effort: ${binding.effort}`);
      }
    }
    lines.push("");
  }

  if (config.aliases && Object.keys(config.aliases).length > 0) {
    lines.push("aliases:");
    for (const [alias, binding] of Object.entries(config.aliases)) {
      const keyStr = alias.startsWith("@") ? `'${alias}'` : alias;
      lines.push(`  ${keyStr}:`);
      lines.push(`    provider: ${binding.provider}`);
      lines.push(`    model: ${binding.model}`);
      if (binding.effort) {
        lines.push(`    effort: ${binding.effort}`);
      }
    }
    lines.push("");
  }

  if (config.roles && Object.keys(config.roles).length > 0) {
    lines.push("roles:");
    for (const [role, binding] of Object.entries(config.roles)) {
      if (!binding) continue;
      lines.push(`  ${role}:`);
      if (typeof binding === "string") {
        lines.push(`    tier: ${binding}`);
      } else {
        if (binding.tier) lines.push(`    tier: ${binding.tier}`);
        if (binding.provider) lines.push(`    provider: ${binding.provider}`);
        if (binding.model) lines.push(`    model: ${binding.model}`);
        if (binding.effort) lines.push(`    effort: ${binding.effort}`);
      }
    }
    lines.push("");
  }

  if (config.worktree?.baseBranch) {
    lines.push("worktree:");
    lines.push(`  baseBranch: ${config.worktree.baseBranch}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function readAnimusConfig(root: string): AnimusConfig {
  const configPath = join(root, ".animus/config.yaml");
  if (!existsSync(configPath)) return {};
  try {
    const content = readFileSync(configPath, "utf-8");
    return parseYamlSimple(content);
  } catch {
    return {};
  }
}

export function writeAnimusConfig(root: string, config: AnimusConfig): string {
  const configPath = join(root, ".animus/config.yaml");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, serializeAnimusConfigYaml(config), "utf-8");
  return configPath;
}

export function resolveModelTier(role: LoopRole, rootOrConfig?: string | AnimusConfig): ModelTier {
  if (rootOrConfig) {
    const config = typeof rootOrConfig === "string" ? readAnimusConfig(rootOrConfig) : rootOrConfig;
    const roleOverride = config.roles?.[role];
    if (typeof roleOverride === "string" && (roleOverride === "small" || roleOverride === "medium" || roleOverride === "large")) {
      return roleOverride;
    }
    if (roleOverride && typeof roleOverride === "object" && typeof roleOverride.tier === "string") {
      if (roleOverride.tier === "small" || roleOverride.tier === "medium" || roleOverride.tier === "large") {
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

export function resolveModelForRole(root: string, role: LoopRole): string | undefined {
  if (process.env.FACTORY_LOOP_MODEL) return process.env.FACTORY_LOOP_MODEL;
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

export function resolveProviderForRole(root: string, role: LoopRole): string {
  if (process.env.FACTORY_LOOP_PROVIDER) return process.env.FACTORY_LOOP_PROVIDER;
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

export function resolveEffortForRole(root: string, role: LoopRole): EffortRung | undefined {
  const roleEnvKey = `FACTORY_LOOP_${role.toUpperCase()}_EFFORT`;
  const roleEffort = process.env[roleEnvKey];
  if (roleEffort && isEffortRung(roleEffort)) {
    return roleEffort;
  }
  if (process.env.FACTORY_LOOP_EFFORT && isEffortRung(process.env.FACTORY_LOOP_EFFORT)) {
    return process.env.FACTORY_LOOP_EFFORT;
  }
  const config = readAnimusConfig(root);
  const roleOverride = config.roles?.[role];
  if (roleOverride && typeof roleOverride === "object" && roleOverride.effort && isEffortRung(roleOverride.effort)) {
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
): { provider: string; model?: string; effort?: EffortRung } {
  return {
    provider: resolveProviderForRole(root, role),
    model: resolveModelForRole(root, role),
    effort: resolveEffortForRole(root, role),
  };
}
