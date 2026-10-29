export const SUPPORTED_PROVIDERS = [
  "pi",
  "claude",
  "omp",
  "codex",
  "opencode",
] as const;

export const ACTIVE_PROVIDERS = ["pi", "claude", "omp"] as const;
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
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  opencode: ["low", "medium", "high"],
};

/**
 * Resolves an Archon rung into a provider vocabulary. Unsupported values clamp
 * to a weaker rung first so a mapping never silently buys more reasoning,
 * matching Archon's @archon/provider-contract/src/effort.ts clampEffort.
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
}

/**
 * Builds standard CLI arguments for running an autonomous lap step across
 * any supported Archon SDLC provider harness with reasoning effort mapping.
 */
export function buildProviderArgv(
  provider: string,
  options: BuildProviderArgvOptions,
): string[] {
  const norm = (provider.toLowerCase() as SupportedProvider);
  const descriptor = isSupportedProvider(norm) ? PROVIDER_DESCRIPTORS[norm] : undefined;
  const clamped =
    options.effort && descriptor
      ? clampEffort(options.effort, descriptor.supportedEfforts)
      : options.effort;

  switch (norm) {
    case "claude":
      return [
        "claude",
        "--print",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        ...(options.model ? ["--model", options.model] : []),
        ...(clamped ? ["--effort", clamped] : []),
        ...(options.appendSystemPrompts?.flatMap((p) => ["--append-system-prompt", p]) ?? []),
        "-p",
        options.prompt,
      ];

    case "omp":
      return [
        "omp",
        "--print",
        "--mode",
        "json",
        ...(options.sessionDir ? ["--session-dir", options.sessionDir] : ["--no-session"]),
        "--no-extensions",
        ...(options.extensions?.flatMap((e) => ["-e", e]) ?? []),
        "--no-skills",
        ...(options.skills?.flatMap((s) => ["--skills", s]) ?? []),
        "--no-context-files",
        ...(options.appendSystemPrompts?.flatMap((p) => ["--append-system-prompt", p]) ?? []),
        "--auto-approve",
        ...(options.model ? ["--model", options.model] : []),
        ...(clamped ? ["--thinking", clamped] : []),
        options.prompt,
      ];

    case "codex": {
      const finalPrompt = options.appendSystemPrompts?.length
        ? `${options.appendSystemPrompts.join("\n\n")}\n\n---\n\n${options.prompt}`
        : options.prompt;
      return [
        "codex",
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        ...(options.model ? ["--model", options.model] : []),
        ...(clamped ? ["-c", `model_reasoning_effort="${clamped}"`] : []),
        finalPrompt,
      ];
    }

    case "opencode": {
      const finalPrompt = options.appendSystemPrompts?.length
        ? `${options.appendSystemPrompts.join("\n\n")}\n\n---\n\n${options.prompt}`
        : options.prompt;
      return [
        "opencode",
        "run",
        "--format",
        "json",
        "--auto",
        "--standalone",
        ...(options.model ? ["--model", options.model] : []),
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
        "--no-extensions",
        ...(options.extensions?.flatMap((e) => ["-e", e]) ?? []),
        "--no-mcp",
        "--no-skills",
        ...(options.skills?.flatMap((s) => ["--skill", s]) ?? []),
        "--no-prompt-templates",
        "--no-context-files",
        ...(options.appendSystemPrompts?.flatMap((p) => ["--append-system-prompt", p]) ?? []),
        "--no-approve",
        ...(options.model ? ["--model", options.model] : []),
        ...(clamped ? ["--thinking", clamped] : []),
        "--",
        options.prompt,
      ];
  }
}
