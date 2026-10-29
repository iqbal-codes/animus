import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadPrompt, renderPrompt } from "./prompts";

export interface DiscoveryItem {
  id: string;
  title: string;
  claim: string;
  evidence: string;
  relation: "unrelated" | "scope_conflict";
  source_node: string;
}

export async function auditDiscoveries(
  root: string,
  artifactsDir = join(root, ".factory-local-loop/discoveries"),
): Promise<{ discoveries: DiscoveryItem[]; prompt: string }> {
  const discoveries: DiscoveryItem[] = [];

  // Check architecture boundaries via check-architecture script if available
  const archCheckScript = join(root, "scripts/health/check-architecture.mjs");
  if (existsSync(archCheckScript)) {
    try {
      const p = Bun.spawnSync(["node", archCheckScript], { cwd: root });
      if (p.exitCode !== 0) {
        discoveries.push({
          id: "DISC-ARCH-01",
          title: "Architecture boundary rule violation detected",
          claim: "Codebase imports violate defined package isolation boundaries.",
          evidence: p.stdout.toString() || p.stderr.toString(),
          relation: "unrelated",
          source_node: "discoveries",
        });
      }
    } catch {}
  }

  const promptTemplate = loadPrompt("discoveries", root);
  const prompt = renderPrompt(
    promptTemplate,
    {
      runtime: "docs/runtime.md",
    },
    artifactsDir,
  );

  return { discoveries, prompt };
}
