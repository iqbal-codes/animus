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
import { join, resolve } from "node:path";

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
    const args = (event?.input ?? event?.args ?? {}) as Record<string, any>;

    const now = Date.now();
    const hardDeadline = Number(process.env.FACTORY_LOOP_HARD_DEADLINE_MS);
    const softDeadline = Number(process.env.FACTORY_LOOP_SOFT_DEADLINE_MS);
    if (Number.isFinite(hardDeadline) && hardDeadline > 0 && now >= hardDeadline) {
      return {
        block: true,
        reason:
          "HARD DEADLINE: stop tools and report interrupted; the host preserves this attempt.",
      };
    }
    if (Number.isFinite(softDeadline) && softDeadline > 0 && now >= softDeadline) {
      const checkpoint = process.env.FACTORY_LOOP_CHECKPOINT_PATH;
      const checkpointWrite =
        (toolName === "write" || toolName === "edit") &&
        checkpoint &&
        typeof args.path === "string" &&
        resolve(args.path) === resolve(checkpoint);
      // Deliberately allow only simple read-only git commands, not arbitrary shell syntax.
      const gitInspection =
        toolName === "bash" &&
        typeof args.command === "string" &&
        /^git (?:status(?: --short)?|diff(?: --stat| --name-only)?|rev-parse HEAD)$/.test(
          args.command.trim(),
        );
      if (!checkpointWrite && !gitInspection) {
        return {
          block: true,
          reason: `SOFT DEADLINE: stop new work, write progress, checks, blockers and next steps to ${checkpoint ?? "the checkpoint path in your prompt"}, then report {"verdict":"interrupted"}. Do not claim pass.`,
        };
      }
    }
    if (toolName === "bash") {
      const requested =
        typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
          ? args.timeout
          : 90;
      args.timeout =
        Number.isFinite(hardDeadline) && hardDeadline > 0
          ? Math.min(requested, Math.max(0.001, (hardDeadline - now) / 1000))
          : requested;
    }

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
    const args = event?.input ?? event?.args ?? {};

    if (toolName === "bash" && event?.isError) {
      const guidance = loadToolGuidance(process.cwd());
      const entries = Object.entries(guidance);
      const hints: string[] = [];
      if (entries.length > 0) {
        const hint = entries.map(([k, v]) => `${k}: \`${v}\``).join(", ");
        hints.push(`[HARNESS TOOL GUIDANCE HINT] Verified repository commands -> ${hint}`);
      }
      const rawText = Array.isArray(event?.content)
        ? event.content.map((c: any) => c?.text ?? "").join("\n")
        : String(event?.content ?? "");
      if (
        rawText.toLowerCase().includes("timed out") ||
        rawText.toLowerCase().includes("timeout")
      ) {
        hints.push(
          "[HARNESS TIMEOUT HINT] Command exceeded timeout budget. Avoid long-running background tasks without explicit timeouts, and avoid reading daemon process streams before process termination.",
        );
      }
      if (hints.length > 0) {
        return {
          content: [...(event.content ?? []), { type: "text", text: `\n${hints.join("\n")}` }],
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
          content: [...(event.content ?? []), { type: "text", text: `\n${sections.join("\n")}` }],
        };
      }
    }

    return undefined;
  });
}

// CLI / git hook execution support
if (import.meta.main) {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  // If invoked with --pre-commit or list of files
  let filesToCheck: string[] = [];
  if (args.includes("--pre-commit")) {
    try {
      const proc = Bun.spawnSync(["git", "diff", "--cached", "--name-only"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = proc.stdout.toString();
      filesToCheck = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      filesToCheck = [];
    }
  } else {
    filesToCheck = args.filter((a) => !a.startsWith("-"));
  }

  let hasFatalError = false;
  for (const file of filesToCheck) {
    if (isProtectedPath(file)) {
      console.error(
        `\x1b[31m[HARNESS GUARD ERROR]\x1b[0m Modifying protected path '${file}' is forbidden during delivery laps.`,
      );
      hasFatalError = true;
    }
  }

  if (hasFatalError) {
    process.exit(1);
  }
}
