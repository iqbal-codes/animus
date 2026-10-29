/**
 * Pi Extension Hook (-e .factory/hooks/loop-guard.ts)
 * Acts inside the tool execution loop (Harness² c8 component) across any stack
 * (Backend, Frontend, Full-Stack, Mobile, Database, CLI) to enforce:
 * 1. Protected path invariants
 * 2. Codebase convention rules (.factory/codebase-rules.json) — warn by default, block for strict invariants
 * 3. Shared pattern/module registry hints (.factory/codebase-rules.json)
 * 4. Active repository lessons (.factory/lessons.jsonl) matching the target file
 * 5. Verified CLI guidance hints on bash tool failures (.factory/tool-guidance.json)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CodebaseRule {
  id: string;
  description: string;
  file_glob: string;
  forbid_regex?: string;
  require_regex?: string;
  replacement_hint: string;
  mode?: "block" | "warn";
}

export interface PatternRegistryEntry {
  guidance: string;
  file_glob?: string;
}

export interface CodebaseRulesConfig {
  schema_version?: number;
  description?: string;
  rules?: CodebaseRule[];
  pattern_registry?: Record<string, string | PatternRegistryEntry>;
  /** Alias for backwards compatibility */
  component_registry?: Record<string, string | PatternRegistryEntry>;
}

const DEFAULT_PROTECTED_PATTERNS = [
  /^\.factory\/holdout(\/|$)/,
  /^\.factory\/hooks(\/|$)/,
  /^\.claude\/settings\.json$/,
  /^harness(\/|$)/,
  /^MISSION\.md$/,
  /^FACTORY\.md$/,
  /^FACTORY_RULES\.md$/,
];

const SOURCE_FILE_REGEX =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|dart|rb|php|cs|c|cpp|h|sql|prisma|graphql|proto|sh)$/i;

export function isProtectedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return DEFAULT_PROTECTED_PATTERNS.some((rx) => rx.test(normalized));
}

function globMatchesPath(globPattern: string, targetPath: string): boolean {
  const normPath = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    if (new Bun.Glob(globPattern).match(normPath)) return true;
  } catch {}
  const cleanToken = globPattern.replace(/\*+/g, "").toLowerCase();
  return cleanToken.length >= 3 && normPath.toLowerCase().includes(cleanToken);
}

export function loadCodebaseRules(cwd: string): CodebaseRulesConfig {
  const p = join(cwd, ".factory/codebase-rules.json");
  if (!existsSync(p)) return { rules: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CodebaseRulesConfig;
  } catch {
    return { rules: [] };
  }
}

export function evaluateCodebaseRulesOnEdit(
  cwd: string,
  relPath: string,
  newContent: string,
): { blocked: boolean; reasons: string[]; warnings: string[]; registryHints: string[] } {
  const cfg = loadCodebaseRules(cwd);
  const rules = cfg.rules ?? [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const registryHints: string[] = [];

  for (const rule of rules) {
    if (!globMatchesPath(rule.file_glob, relPath)) continue;

    let violated = false;
    if (rule.forbid_regex) {
      try {
        const rx = new RegExp(rule.forbid_regex, "m");
        if (rx.test(newContent)) violated = true;
      } catch {}
    }
    if (!violated && rule.require_regex) {
      try {
        const rx = new RegExp(rule.require_regex, "m");
        if (!rx.test(newContent)) violated = true;
      } catch {}
    }

    if (violated) {
      const msg = `[${rule.id}] ${rule.description} — ${rule.replacement_hint}`;
      if (rule.mode === "block") {
        reasons.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  const combinedRegistry = {
    ...(cfg.component_registry ?? {}),
    ...(cfg.pattern_registry ?? {}),
  };

  if (Object.keys(combinedRegistry).length > 0 && SOURCE_FILE_REGEX.test(relPath)) {
    for (const [domain, entry] of Object.entries(combinedRegistry)) {
      if (typeof entry === "string") {
        registryHints.push(`[${domain}] ${entry}`);
      } else if (entry && typeof entry === "object" && typeof entry.guidance === "string") {
        if (!entry.file_glob || globMatchesPath(entry.file_glob, relPath)) {
          registryHints.push(`[${domain}] ${entry.guidance}`);
        }
      }
    }
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    warnings,
    registryHints,
  };
}

function loadMatchingLessonsForFile(cwd: string, relPath: string): string[] {
  const p = join(cwd, ".factory/lessons.jsonl");
  if (!existsSync(p)) return [];
  const matches: string[] = [];
  try {
    const lines = readFileSync(p, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry && !entry.vetoed && Array.isArray(entry.trigger_patterns)) {
        if (entry.trigger_patterns.some((pat: string) => globMatchesPath(pat, relPath))) {
          matches.push(`[${entry.topic}] ${entry.rule}`);
        }
      }
    }
  } catch {}
  return matches.slice(0, 3);
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

      const candidateText =
        typeof args.content === "string"
          ? args.content
          : Array.isArray(args.edits)
            ? args.edits.map((e: any) => e?.newText ?? "").join("\n")
            : "";

      if (candidateText) {
        const evalRes = evaluateCodebaseRulesOnEdit(process.cwd(), args.path, candidateText);
        if (evalRes.blocked) {
          return {
            block: true,
            reason: `CODEBASE STANDARD VIOLATION in '${args.path}':\n${evalRes.reasons.map((r) => `  - ${r}`).join("\n")}`,
          };
        }
      }
    }
    return undefined;
  });

  api.on("tool_result", async (event: any) => {
    const toolName = String(event?.toolName ?? "");
    const args = event?.args ?? {};

    if (toolName === "bash" && event?.isError) {
      const guidance = loadToolGuidance(process.cwd());
      const entries = Object.entries(guidance);
      if (entries.length > 0) {
        const hint = entries.map(([k, v]) => `${k}: \`${v}\``).join(", ");
        return {
          appendText: `\n[HARNESS TOOL GUIDANCE HINT] Verified repository commands -> ${hint}`,
        };
      }
    }

    if (
      (toolName === "read" || toolName === "write" || toolName === "edit") &&
      typeof args.path === "string"
    ) {
      const lessons = loadMatchingLessonsForFile(process.cwd(), args.path);
      const candidateText =
        typeof args.content === "string"
          ? args.content
          : Array.isArray(args.edits)
            ? args.edits.map((e: any) => e?.newText ?? "").join("\n")
            : "";
      const ruleEval = evaluateCodebaseRulesOnEdit(process.cwd(), args.path, candidateText);

      const sections: string[] = [];
      if (ruleEval.warnings.length > 0) {
        sections.push(
          `[CODEBASE PATTERN REMINDER for ${args.path}]:\n${ruleEval.warnings.map((w) => `  - ${w}`).join("\n")}`,
        );
      }
      if (toolName === "read" && ruleEval.registryHints.length > 0) {
        sections.push(
          `[SHARED PATTERN & MODULE REGISTRY]:\n${ruleEval.registryHints.map((h) => `  - ${h}`).join("\n")}`,
        );
      }
      if (lessons.length > 0) {
        sections.push(
          `[HARNESS ACTIVE LESSONS for ${args.path}]:\n${lessons.map((l) => `  - ${l}`).join("\n")}`,
        );
      }
      if (sections.length > 0) {
        return {
          appendText: `\n${sections.join("\n")}`,
        };
      }
    }

    return undefined;
  });
}
