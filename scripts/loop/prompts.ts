import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function resolveArchonCommandsDir(root: string): string | null {
  const packPath = join(root, "factory/pack.json");
  if (!existsSync(packPath)) return null;
  try {
    const pack = JSON.parse(readFileSync(packPath, "utf-8"));
    const reqRev = pack.integration_revision_required;
    const sourceDirRel = pack.source_directory || ".archon/workflows/sdlc";
    const candidates = [
      join(root, sourceDirRel, "loop/commands"),
      join(process.env.HOME || "", ".cache/factory/archon", reqRev, sourceDirRel, "loop/commands"),
      join(process.env.HOME || "", ".cache/factory/archon", reqRev, "loop/commands"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {}
  return null;
}

export function loadPrompt(promptName: string, root: string): string {
  // 1. Check local scripts/prompts/
  const localPromptPath = join(root, "scripts/prompts", `${promptName}.md`);
  if (existsSync(localPromptPath)) {
    return readFileSync(localPromptPath, "utf-8");
  }

  // 2. Check pinned Archon pack commands
  const commandsDir = resolveArchonCommandsDir(root);
  if (commandsDir) {
    const pinnedPath = join(commandsDir, `${promptName}.md`);
    if (existsSync(pinnedPath)) {
      return readFileSync(pinnedPath, "utf-8");
    }
  }

  throw new Error(`Prompt template '${promptName}' could not be located.`);
}

export function renderPrompt(
  template: string,
  vars: Record<string, string>,
  artifactsDir: string,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`$INPUTS.${key}`, value);
  }
  result = result.replaceAll("$ARTIFACTS_DIR", artifactsDir);
  return result;
}
