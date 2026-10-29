import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoopRole, ModelTier } from "./types";
import { type EffortRung, isEffortRung } from "./providers";

export interface TierBinding {
  provider: string;
  model: string;
  effort?: EffortRung;
}

export interface ArchonConfig {
  assistant?: string;
  assistants?: Record<string, { model: string }>;
  tiers?: Partial<Record<ModelTier, TierBinding>>;
  aliases?: Record<string, TierBinding>;
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

export function serializeArchonConfigYaml(config: ArchonConfig): string {
  const lines: string[] = ["# Archon Repository Configuration for labq-software-factory"];
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

  if (config.worktree?.baseBranch) {
    lines.push("worktree:");
    lines.push(`  baseBranch: ${config.worktree.baseBranch}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function readArchonConfig(root: string): ArchonConfig {
  const configPath = join(root, ".archon/config.yaml");
  if (!existsSync(configPath)) return {};
  try {
    const content = readFileSync(configPath, "utf-8");
    return parseYamlSimple(content);
  } catch {
    return {};
  }
}

export function writeArchonConfig(root: string, config: ArchonConfig): string {
  const configPath = join(root, ".archon/config.yaml");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, serializeArchonConfigYaml(config), "utf-8");
  return configPath;
}

export function resolveModelTier(role: LoopRole): ModelTier {
  switch (role) {
    case "reviewer":
    case "reflector":
    case "planner":
    case "manager":
      return "large";
    case "builder":
    case "investigator":
    case "simplifier":
      return "medium";
    case "qa":
    case "auditor":
    default:
      return "small";
  }
}

export function resolveModelForRole(root: string, role: LoopRole): string | undefined {
  if (process.env.FACTORY_LOOP_MODEL) return process.env.FACTORY_LOOP_MODEL;
  const config = readArchonConfig(root);
  const tier = resolveModelTier(role);

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
  const config = readArchonConfig(root);
  const tier = resolveModelTier(role);

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
  if (process.env.FACTORY_LOOP_EFFORT && isEffortRung(process.env.FACTORY_LOOP_EFFORT)) {
    return process.env.FACTORY_LOOP_EFFORT;
  }
  const config = readArchonConfig(root);
  const tier = resolveModelTier(role);

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
