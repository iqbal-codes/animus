import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  tiers?: Record<ModelTier, TierBinding>;
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

export function resolveModelTier(role: LoopRole): ModelTier {
  switch (role) {
    case "reviewer":
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

  if (role === "reviewer" && config.aliases?.["@reasoning"]?.model) {
    return config.aliases["@reasoning"].model;
  }

  if (config.tiers?.[tier]?.model) {
    return config.tiers[tier].model;
  }

  if (config.assistant && config.assistants?.[config.assistant]?.model) {
    return config.assistants[config.assistant].model;
  }

  return undefined;
}

export function resolveProviderForRole(root: string, role: LoopRole): string {
  if (process.env.FACTORY_LOOP_PROVIDER) return process.env.FACTORY_LOOP_PROVIDER;
  const config = readArchonConfig(root);
  const tier = resolveModelTier(role);

  if (role === "reviewer" && config.aliases?.["@reasoning"]?.provider) {
    return config.aliases["@reasoning"].provider;
  }

  if (config.tiers?.[tier]?.provider) {
    return config.tiers[tier].provider;
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
    role === "reviewer" &&
    config.aliases?.["@reasoning"]?.effort &&
    isEffortRung(config.aliases["@reasoning"].effort)
  ) {
    return config.aliases["@reasoning"].effort;
  }

  if (config.tiers?.[tier]?.effort && isEffortRung(config.tiers[tier].effort)) {
    return config.tiers[tier].effort;
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
