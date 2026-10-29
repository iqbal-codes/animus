/**
 * Pi Extension Hook (`-e .factory/hooks/loop-guard.ts`)
 * Acts inside the tool execution loop (Harness² c8 component) to enforce
 * protected path invariants and append targeted CLI guidance on tool failures.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PROTECTED_PATTERNS = [
  /^\.factory\/holdout(\/|$)/,
  /^\.factory\/hooks(\/|$)/,
  /^\.claude\/settings\.json$/,
  /^harness(\/|$)/,
  /^MISSION\.md$/,
  /^FACTORY\.md$/,
  /^FACTORY_RULES\.md$/,
];

function isProtectedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return DEFAULT_PROTECTED_PATTERNS.some((rx) => rx.test(normalized));
}

function loadToolGuidance(cwd: string): Record<string, string> {
  const p = join(cwd, ".factory/tool-guidance.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

export default function registerLoopGuard(api: any) {
  if (!api || typeof api.on !== "function") return;

  api.on("tool_call", async (event: any) => {
    const toolName = String(event?.toolName ?? "");
    const args = event?.args ?? {};

    if ((toolName === "write" || toolName === "edit") && typeof args.path === "string") {
      if (isProtectedPath(args.path)) {
        return {
          block: true,
          reason: `HARNESS GUARD: Modifying protected path '${args.path}' inside a delivery lap is forbidden.`,
        };
      }
    }
    return undefined;
  });

  api.on("tool_result", async (event: any) => {
    if (event?.toolName === "bash" && event?.isError) {
      const guidance = loadToolGuidance(process.cwd());
      const entries = Object.entries(guidance);
      if (entries.length > 0) {
        const hint = entries.map(([k, v]) => `${k}: \`${v}\``).join(", ");
        return {
          appendText: `\n[HARNESS TOOL GUIDANCE HINT] Verified repository commands -> ${hint}`,
        };
      }
    }
    return undefined;
  });
}
