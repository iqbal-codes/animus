import { z } from "zod";

export const personalPreferencesSchema = z.object({
  theme: z.string().default("dark"),
  cardDensity: z.enum(["comfortable", "compact"]).default("comfortable"),
  startupView: z.enum(["inbox", "jobs"]).default("inbox"),
  notifyNeedsAttention: z.boolean().default(true),
  notifyFailedJobs: z.boolean().default(true),
  soundAlerts: z.boolean().default(false),
  telemetryEnabled: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(true),
  profile: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .optional(),
});

export type PersonalPreferences = z.infer<typeof personalPreferencesSchema>;

export const providerItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  binary: z.string(),
  path: z.string(),
  version: z.string(),
  efforts: z.string().default("low · medium · high"),
  capabilities: z.string().default("Resume · Fork"),
  status: z.enum(["INSTALLED", "COMING SOON"]).default("INSTALLED"),
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export type ProviderItem = z.infer<typeof providerItemSchema>;

export const platformSettingsSchema = z.object({
  system: z
    .object({
      remoteAccess: z.boolean().default(false),
      bindAddress: z.string().default("127.0.0.1"),
      vaultEnabled: z.boolean().default(true),
      hostOrigin: z.string().default("http://127.0.0.1:4000"),
      defaultProvider: z.string().default("pi"),
    })
    .default({
      remoteAccess: false,
      bindAddress: "127.0.0.1",
      vaultEnabled: true,
      hostOrigin: "http://127.0.0.1:4000",
      defaultProvider: "pi",
    }),
  providers: z.array(providerItemSchema).default([]),
  automation: z
    .object({
      parallelJobs: z.number().default(2),
      maxLaps: z.number().default(3),
      pollInterval: z.number().default(300),
      continuations: z.number().default(1),
      limitWorkWindow: z.boolean().default(true),
      startTime: z.string().default("20:00"),
      endTime: z.string().default("05:00"),
      timezone: z.string().default("Asia/Jakarta (UTC+7)"),
      schedulePaused: z.boolean().default(false),
      globalBrake: z.boolean().default(false),
    })
    .default({
      parallelJobs: 2,
      maxLaps: 3,
      pollInterval: 300,
      continuations: 1,
      limitWorkWindow: true,
      startTime: "20:00",
      endTime: "05:00",
      timezone: "Asia/Jakarta (UTC+7)",
      schedulePaused: false,
      globalBrake: false,
    }),
  github: z
    .object({
      appId: z.string().default(""),
      appName: z.string().default(""),
      installationId: z.string().default(""),
      connected: z.boolean().default(false),
      lastChecked: z.string().default(""),
      pat: z.string().default(""),
      readyEvent: z.boolean().default(true),
      changeEvent: z.boolean().default(true),
      reviewEvent: z.boolean().default(true),
    })
    .default({
      appId: "",
      appName: "",
      installationId: "",
      connected: false,
      lastChecked: "",
      pat: "",
      readyEvent: true,
      changeEvent: true,
      reviewEvent: true,
    }),
});

export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export type PlatformSettingsUpdate = {
  system?: Partial<PlatformSettings["system"]>;
  providers?: PlatformSettings["providers"];
  automation?: Partial<PlatformSettings["automation"]>;
  github?: Partial<PlatformSettings["github"]>;
};

export const projectSettingsSchema = z.object({
  models: z
    .object({
      defaultModel: z.string().default("claude-3-7-sonnet"),
      plannerModel: z.string().default("claude-3-7-sonnet"),
      builderModel: z.string().default("claude-3-7-sonnet"),
      reviewerModel: z.string().default("claude-3-7-sonnet"),
      worktreeStrategy: z.string().default("isolated"),
      concurrencyLimit: z.number().default(2),
    })
    .default({
      defaultModel: "claude-3-7-sonnet",
      plannerModel: "claude-3-7-sonnet",
      builderModel: "claude-3-7-sonnet",
      reviewerModel: "claude-3-7-sonnet",
      worktreeStrategy: "isolated",
      concurrencyLimit: 2,
    }),
  checks: z
    .object({
      staticCmd: z.string().default("bun run check"),
      unitCmd: z.string().default("bun test"),
      countPattern: z.string().default("Tests\\s+(\\d+)\\s+passed"),
      protectedPaths: z.array(z.string()).default(["MISSION.md", "FACTORY.md", "harness/**"]),
      toolGuidance: z.record(z.string(), z.string()).default({}),
    })
    .default({
      staticCmd: "bun run check",
      unitCmd: "bun test",
      countPattern: "Tests\\s+(\\d+)\\s+passed",
      protectedPaths: ["MISSION.md", "FACTORY.md", "harness/**"],
      toolGuidance: {},
    }),
  rules: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
  schedule: z
    .object({
      cron: z.string().default("0 20 * * *"),
      enabled: z.boolean().default(false),
      workWindow: z
        .object({
          startTime: z.string().default("20:00"),
          endTime: z.string().default("05:00"),
          timezone: z.string().default("Asia/Jakarta (UTC+7)"),
        })
        .default({
          startTime: "20:00",
          endTime: "05:00",
          timezone: "Asia/Jakarta (UTC+7)",
        }),
    })
    .default({
      cron: "0 20 * * *",
      enabled: false,
      workWindow: {
        startTime: "20:00",
        endTime: "05:00",
        timezone: "Asia/Jakarta (UTC+7)",
      },
    }),
  releases: z
    .object({
      completionMode: z.enum(["wait", "auto"]).default("wait"),
      mergeMethod: z.enum(["squash", "rebase", "merge"]).default("squash"),
      independentReviewer: z.boolean().default(true),
      holdSensitive: z.boolean().default(true),
    })
    .default({
      completionMode: "wait",
      mergeMethod: "squash",
      independentReviewer: true,
      holdSensitive: true,
    }),
});

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export type ProjectSettingsUpdate = {
  models?: Partial<ProjectSettings["models"]>;
  checks?: Partial<ProjectSettings["checks"]>;
  rules?: ProjectSettings["rules"];
  schedule?: Partial<ProjectSettings["schedule"]>;
  releases?: Partial<ProjectSettings["releases"]>;
};
