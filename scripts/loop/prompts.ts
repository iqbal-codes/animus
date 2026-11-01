import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_PROMPTS } from "./bundled-prompts";

export function resolveAnimusCommandsDir(root: string): string | null {
  const packPath = join(root, "factory/pack.json");
  if (!existsSync(packPath)) return null;
  try {
    const pack = JSON.parse(readFileSync(packPath, "utf-8"));
    const reqRev = pack.integration_revision_required;
    const sourceDirRel = pack.source_directory || ".animus/workflows/sdlc";
    const candidates = [
      join(root, sourceDirRel, "loop/commands"),
      join(process.env.HOME || "", ".cache/factory/animus", reqRev, sourceDirRel, "loop/commands"),
      join(process.env.HOME || "", ".cache/factory/animus", reqRev, "loop/commands"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {}
  return null;
}

export function loadPrompt(promptName: string, root: string = process.cwd()): string {
  // 1. Check local scripts/prompts/ (consumer override precedence)
  const localPromptPath = join(root, "scripts/prompts", `${promptName}.md`);
  if (existsSync(localPromptPath)) {
    return readFileSync(localPromptPath, "utf-8");
  }

  // 2. Check pinned Animus pack commands
  const commandsDir = resolveAnimusCommandsDir(root);
  if (commandsDir) {
    const pinnedPath = join(commandsDir, `${promptName}.md`);
    if (existsSync(pinnedPath)) {
      return readFileSync(pinnedPath, "utf-8");
    }
  }

  // 3. Check bundled canonical resources for installed distributions
  if (BUNDLED_PROMPTS[promptName]) {
    return BUNDLED_PROMPTS[promptName]!;
  }

  throw new Error(
    `Prompt template '${promptName}' could not be located in local scripts/prompts, pinned pack, or bundled resources.`,
  );
}

export interface PromptRenderOptions {
  allowUnresolved?: boolean;
  requiredTokens?: string[];
}

export function renderPrompt(
  template: string,
  vars: Record<string, string | undefined>,
  artifactsDir: string,
  options?: PromptRenderOptions,
): string {
  let result = template;
  // Sort keys descending by length so longer variable names (e.g. $INPUTS.profile)
  // are replaced before prefixes (e.g. $INPUTS.pr).
  const sortedEntries = Object.entries(vars)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => b.length - a.length);

  for (const [key, value] of sortedEntries) {
    if (value !== undefined) {
      result = result.replaceAll(`$INPUTS.${key}`, value);
    }
  }
  result = result.replaceAll("$ARTIFACTS_DIR", artifactsDir);

  // Validate required tokens
  if (options?.requiredTokens) {
    const missingTokens = options.requiredTokens.filter((token) => {
      const val = vars[token];
      return val === undefined || val === "";
    });
    if (missingTokens.length > 0) {
      throw new Error(
        `Prompt rendering failed: missing required inputs: ${missingTokens.join(", ")}`,
      );
    }
  }

  // Reject unresolved $INPUTS tokens at render/dispatch seam unless explicitly allowed
  if (!options?.allowUnresolved) {
    const unresolvedMatches = [...result.matchAll(/\$INPUTS\.([a-zA-Z0-9_]+)/g)];
    if (unresolvedMatches.length > 0) {
      const unresolvedTokens = Array.from(new Set(unresolvedMatches.map((m) => m[1])));
      throw new Error(
        `Prompt rendering failed: unresolved required template tokens: ${unresolvedTokens.map((t) => `$INPUTS.${t}`).join(", ")}`,
      );
    }
  }

  return result;
}
