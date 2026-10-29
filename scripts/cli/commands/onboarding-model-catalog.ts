import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import type { SupportedProvider } from "../../loop/providers";

export interface CatalogModel {
  id: string;
  name?: string;
  capabilities?: string;
  reasoning?: boolean;
}
export interface ModelCatalog {
  models: CatalogModel[];
  source?: string;
  unavailableReason?: string;
}
export type ModelCatalogLoader = (provider: SupportedProvider) => Promise<ModelCatalog>;
export type CatalogCommand = (binary: string, args: string[]) => Promise<string>;

const execute = promisify(execFile);

/** Catalogs come from documented CLI output, never a bundled model list. */
export function createModelCatalogLoader(
  command: CatalogCommand = async (binary, args) => {
    const result = await execute(binary, args, {
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", PI_OFFLINE: "1" },
    });
    return result.stdout;
  },
): ModelCatalogLoader {
  return async (provider) => {
    if (provider !== "pi" && provider !== "opencode")
      return {
        models: [],
        unavailableReason:
          "No supported documented model catalog adapter for this harness. Enter a model ID manually.",
      };
    try {
      if (provider === "opencode") {
        const output = await command("opencode", ["models", "--standalone"]);
        const ids = output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (!ids.length || !ids.every((id) => /^[^\s/]+\/\S+$/.test(id))) {
          return {
            models: [],
            unavailableReason:
              "OpenCode returned no recognized model catalog. Enter a model ID manually.",
          };
        }
        return {
          models: [...new Set(ids)].map((id) => ({ id })),
          source: "opencode models --standalone",
        };
      }
      const output = await command("pi", [
        "--offline",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
        "--list-models",
      ]);
      const lines = stripVTControlCharacters(output).split(/\r?\n/);
      const header = lines.findIndex((line) =>
        /^provider\s+model\s+context\s+max-out\s+thinking\s+images\s*$/.test(line.trim()),
      );
      if (header < 0)
        return {
          models: [],
          unavailableReason: "Pi returned no recognized model catalog. Enter a model ID manually.",
        };
      const models: CatalogModel[] = [];
      for (const line of lines.slice(header + 1)) {
        const match = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(yes|no)\s+(yes|no)\s*$/.exec(line);
        if (!match) continue;
        models.push({
          id: `${match[1]}/${match[2]}`,
          reasoning: match[5] === "yes",
          capabilities: `Context: ${match[3]}; max output: ${match[4]}; thinking: ${match[5]}; images: ${match[6]} (reported by Pi)`,
        });
      }
      return {
        models,
        source: "pi --offline --list-models",
        ...(!models.length
          ? {
              unavailableReason:
                "No models are available in the local Pi catalog. Enter a model ID manually.",
            }
          : {}),
      };
    } catch (error) {
      return {
        models: [],
        unavailableReason: `Model catalog unavailable: ${error instanceof Error ? error.message : String(error)}. Enter a model ID manually.`,
      };
    }
  };
}
