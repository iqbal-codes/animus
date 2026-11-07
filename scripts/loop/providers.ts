import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SUPPORTED_PROVIDERS = [
  "pi",
  "claude",
  "omp",
  "commandcode",
  "codex",
  "opencode",
] as const;

export const ACTIVE_PROVIDERS = ["pi", "claude", "omp", "commandcode"] as const;
export const COMING_SOON_PROVIDERS = ["codex", "opencode"] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];
export type ActiveProvider = (typeof ACTIVE_PROVIDERS)[number];

export const EFFORT_LADDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const;

export type EffortRung = (typeof EFFORT_LADDER)[number];

export function isEffortRung(value: unknown): value is EffortRung {
  return typeof value === "string" && (EFFORT_LADDER as readonly string[]).includes(value);
}

export const PROVIDER_EFFORT_VOCABULARIES: Record<SupportedProvider, readonly EffortRung[]> = {
  pi: ["minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  omp: ["minimal", "low", "medium", "high", "xhigh", "max"],
  commandcode: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  opencode: ["low", "medium", "high"],
};

/**
 * Resolves an Animus rung into a provider vocabulary. Unsupported values clamp
 * to a weaker rung first so a mapping never silently buys more reasoning,
 * matching Animus's @animus/provider-contract/src/effort.ts clampEffort.
 */
export function clampEffort<T extends EffortRung>(
  value: unknown,
  supported: readonly T[],
): T | undefined {
  if (!isEffortRung(value)) return undefined;
  const index = EFFORT_LADDER.indexOf(value);
  const isSupported = (rung: EffortRung): rung is T =>
    (supported as readonly EffortRung[]).includes(rung as T);

  if (isSupported(value)) return value;

  // Search downwards first (weaker rung)
  for (let i = index - 1; i >= 0; i--) {
    const candidate = EFFORT_LADDER[i];
    if (candidate !== undefined && isSupported(candidate)) return candidate;
  }
  // Fall back to upwards if no weaker rung exists
  for (let i = index + 1; i < EFFORT_LADDER.length; i++) {
    const candidate = EFFORT_LADDER[i];
    if (candidate !== undefined && isSupported(candidate)) return candidate;
  }
  return undefined;
}

export interface ProviderCapabilities {
  sessionResume: boolean;
  sessionFork: boolean;
  nativeTools: boolean;
  effortControl: boolean;
}

export interface ProviderDescriptor {
  id: SupportedProvider;
  displayName: string;
  builtIn: boolean;
  binaryName: string;
  status: "active" | "coming_soon";
  capabilities: ProviderCapabilities;
  supportedEfforts: readonly EffortRung[];
}

export const PROVIDER_DESCRIPTORS: Record<SupportedProvider, ProviderDescriptor> = {
  pi: {
    id: "pi",
    displayName: "Pi",
    builtIn: false,
    binaryName: "pi",
    status: "active",
    capabilities: {
      sessionResume: true,
      sessionFork: true,
      nativeTools: true,
      effortControl: true,
    },
    supportedEfforts: PROVIDER_EFFORT_VOCABULARIES.pi,
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    builtIn: true,
    binaryName: "claude",
    status: "active",
    capabilities: {
      sessionResume: true,
      sessionFork: true,
      nativeTools: true,
      effortControl: true,
    },
    supportedEfforts: PROVIDER_EFFORT_VOCABULARIES.claude,
  },
  omp: {
    id: "omp",
    displayName: "Oh-My-Pi (OMP)",
    builtIn: false,
    binaryName: "omp",
    status: "active",
    capabilities: {
      sessionResume: true,
      sessionFork: true,
      nativeTools: true,
      effortControl: true,
    },
    supportedEfforts: PROVIDER_EFFORT_VOCABULARIES.omp,
  },
  commandcode: {
    id: "commandcode",
    displayName: "Command Code",
    builtIn: false,
    binaryName: "commandcode",
    status: "active",
    capabilities: {
      sessionResume: true,
      sessionFork: true,
      nativeTools: true,
      effortControl: true,
    },
    supportedEfforts: PROVIDER_EFFORT_VOCABULARIES.commandcode,
  },
  codex: {
    id: "codex",
    displayName: "Codex (Coming Soon)",
    builtIn: true,
    binaryName: "codex",
    status: "coming_soon",
    capabilities: {
      sessionResume: true,
      sessionFork: false,
      nativeTools: true,
      effortControl: true,
    },
    supportedEfforts: PROVIDER_EFFORT_VOCABULARIES.codex,
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode (Coming Soon)",
    builtIn: false,
    binaryName: "opencode",
    status: "coming_soon",
    capabilities: {
      sessionResume: true,
      sessionFork: false,
      nativeTools: true,
      effortControl: true,
    },
    supportedEfforts: PROVIDER_EFFORT_VOCABULARIES.opencode,
  },
};

export function isSupportedProvider(provider: string): provider is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

export function getProviderDescriptor(provider: string): ProviderDescriptor {
  if (!isSupportedProvider(provider)) {
    throw new Error(
      `Unsupported agent provider '${provider}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }
  return PROVIDER_DESCRIPTORS[provider];
}

export interface BuildProviderArgvOptions {
  model?: string;
  effort?: EffortRung;
  prompt: string;
  sessionDir?: string;
  skills?: string[];
  extensions?: string[];
  appendSystemPrompts?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string;
  strictMcp?: boolean;
  settingSources?: string;
  readOnly?: boolean;
  /** Resume an existing provider session by explicit id. Never inferred from cwd. */
  sessionId?: string;
}

/**
 * Whether this provider has a verified on-disk session layout, so a recorded id
 * can be trusted to reopen an existing transcript instead of silently creating one.
 */
export function supportsSessionResume(provider: string): boolean {
  return provider === "pi" || provider === "omp";
}

/**
 * Checks that a recorded session actually exists on disk.
 *
 * Pi and OMP store transcripts as `<sessionDir>/--<cwd>--/<timestamp>_<session-id>.jsonl`,
 * so the id is a filename suffix rather than a known path. Providers whose layout
 * is unverified are refused: resuming an id that silently creates a new session
 * would report continuity that does not exist.
 */
export function providerSessionExists(
  provider: string,
  sessionDir: string,
  sessionId: string,
): boolean {
  if (!supportsSessionResume(provider)) return false;
  if (!existsSync(sessionDir)) return false;
  const suffix = `${sessionId}.jsonl`;
  const visit = (directory: string): boolean => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (visit(join(directory, entry.name))) return true;
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  };
  return visit(sessionDir);
}

export function materializeSkillContent(skillPath: string): string | null {
  const candidates = [join(skillPath, "SKILL.md"), skillPath];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const stat = statSync(c);
        if (stat.isFile()) {
          return readFileSync(c, "utf-8");
        }
      } catch {}
    }
  }
  return null;
}

export function materializeContextText(textOrPath: string): string {
  if (existsSync(textOrPath)) {
    try {
      const stat = statSync(textOrPath);
      if (stat.isFile()) {
        return readFileSync(textOrPath, "utf-8");
      }
    } catch {}
  }
  return textOrPath;
}

const COMPANION_PLANNING_SKILLS = new Set([
  "animus-brainstorm",
  "animus-grill",
  "animus-architecture",
  "animus-spec",
  "animus-tickets",
]);

function getSkillName(skillPath: string): string {
  const normalized = skillPath.replace(/[/\\]SKILL\.md$/i, "").replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] ?? skillPath;
}

/**
 * Builds standard CLI arguments for running an autonomous lap step across
 * any supported Animus SDLC provider harness with reasoning effort mapping.
 */
export function buildProviderArgv(provider: string, options: BuildProviderArgvOptions): string[] {
  const norm = provider.toLowerCase() as SupportedProvider;
  const descriptor = isSupportedProvider(norm) ? PROVIDER_DESCRIPTORS[norm] : undefined;
  const clamped =
    options.effort && descriptor
      ? clampEffort(options.effort, descriptor.supportedEfforts)
      : options.effort;

  const model = options.model && options.model !== "default" ? options.model : undefined;

  const isPi = norm === "pi";

  const skillContents: string[] =
    isPi || !options.skills || options.skills.length === 0
      ? []
      : (() => {
          const hasTriage = options.skills.some((s) => getSkillName(s) === "animus-triage");
          const contents: string[] = [];
          const companionList: string[] = [];
          for (const s of options.skills) {
            const name = getSkillName(s);
            if (hasTriage && COMPANION_PLANNING_SKILLS.has(name)) {
              companionList.push(`- ${name}: ${s}`);
            } else {
              const content = materializeSkillContent(s);
              if (content && content.trim().length > 0) {
                contents.push(content);
              }
            }
          }
          if (companionList.length > 0) {
            contents.push(
              `Companion planning skills available on demand:\n${companionList.join("\n")}`,
            );
          }
          return contents;
        })();

  const materializedSystemPrompts = isPi
    ? []
    : skillContents.concat(
        (options.appendSystemPrompts ?? []).map((p) => materializeContextText(p)),
      );

  switch (norm) {
    case "claude": {
      const toolFlags: string[] = [];
      if (options.tools !== undefined) {
        toolFlags.push("--tools", options.tools);
      }
      if (options.allowedTools && options.allowedTools.length > 0) {
        toolFlags.push("--allowed-tools", options.allowedTools.join(","));
      }
      if (options.disallowedTools && options.disallowedTools.length > 0) {
        toolFlags.push("--disallowed-tools", options.disallowedTools.join(","));
      }
      if (options.strictMcp) {
        toolFlags.push("--strict-mcp-config");
      }
      if (options.settingSources !== undefined) {
        toolFlags.push("--setting-sources", options.settingSources);
      }
      return [
        "claude",
        "--print",
        "--output-format",
        "json",
        ...toolFlags,
        "--dangerously-skip-permissions",
        ...(model ? ["--model", model] : []),
        ...(clamped ? ["--effort", clamped] : []),
        ...materializedSystemPrompts.flatMap((p) => ["--append-system-prompt", p]),
        ...(options.sessionId ? ["--resume", options.sessionId] : []),
        "-p",
        options.prompt,
      ];
    }

    case "omp":
      return [
        "omp",
        "--print",
        "--mode",
        "json",
        ...(options.sessionDir ? ["--session-dir", options.sessionDir] : ["--no-session"]),
        ...(options.sessionId ? [`--resume=${options.sessionId}`] : []),
        "--no-extensions",
        ...(options.extensions?.flatMap((e) => ["-e", e]) ?? []),
        "--no-skills",
        "--no-context-files",
        ...(options.tools !== undefined ? ["--tools", options.tools] : []),
        ...materializedSystemPrompts.flatMap((p) => ["--append-system-prompt", p]),
        "--auto-approve",
        ...(model ? ["--model", model] : []),
        ...(clamped ? ["--thinking", clamped] : []),
        options.prompt,
      ];

    case "commandcode": {
      const finalPrompt = materializedSystemPrompts.length
        ? `${materializedSystemPrompts.join("\n\n")}\n\n---\n\n${options.prompt}`
        : options.prompt;
      return [
        "commandcode",
        "--print",
        "--output-format",
        "json",
        ...(options.readOnly ? [] : ["--yolo"]),
        ...(options.sessionId ? ["--resume", options.sessionId] : []),
        "--skip-onboarding",
        "--safe-mode",
        "--no-skills",
        ...(model ? ["--model", model] : []),
        ...(clamped ? ["--effort", clamped] : []),
        finalPrompt,
      ];
    }

    case "codex": {
      const finalPrompt = materializedSystemPrompts.length
        ? `${materializedSystemPrompts.join("\n\n")}\n\n---\n\n${options.prompt}`
        : options.prompt;
      return [
        "codex",
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        ...(model ? ["--model", model] : []),
        ...(clamped ? ["-c", `model_reasoning_effort="${clamped}"`] : []),
        finalPrompt,
      ];
    }

    case "opencode": {
      const finalPrompt = materializedSystemPrompts.length
        ? `${materializedSystemPrompts.join("\n\n")}\n\n---\n\n${options.prompt}`
        : options.prompt;
      return [
        "opencode",
        "run",
        "--format",
        "json",
        "--auto",
        "--standalone",
        ...(model ? ["--model", model] : []),
        ...(clamped && ["medium", "high", "xhigh", "max"].includes(clamped) ? ["--thinking"] : []),
        finalPrompt,
      ];
    }

    case "pi":
    default:
      return [
        "pi",
        "--print",
        "--mode",
        "json",
        ...(options.sessionDir ? ["--session-dir", options.sessionDir] : ["--no-session"]),
        ...(options.sessionId ? ["--session-id", options.sessionId] : []),
        "--no-extensions",
        ...(options.extensions?.flatMap((e) => ["-e", e]) ?? []),
        "--no-mcp",
        "--no-skills",
        ...(options.tools !== undefined ? ["--tools", options.tools] : []),
        ...(options.skills?.flatMap((s) => ["--skill", s]) ?? []),
        "--no-prompt-templates",
        "--no-context-files",
        ...(options.appendSystemPrompts?.flatMap((p) => ["--append-system-prompt", p]) ?? []),
        "--no-approve",
        ...(model ? ["--model", model] : []),
        ...(clamped ? ["--thinking", clamped] : []),
        "--",
        options.prompt,
      ];
  }
}
