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

export const projectSettingsSchema = z.object({
  models: z
    .object({
      assistant: z.string().default("pi"),
      defaultModel: z.string().default("default"),
      effort: z.string().default("high"),
      plannerModel: z.string().default("default"),
      builderModel: z.string().default("default"),
      reviewerModel: z.string().default("default"),
      worktreeStrategy: z.string().default("isolated"),
      concurrencyLimit: z.number().default(2),
    })
    .passthrough()
    .default({
      assistant: "pi",
      defaultModel: "default",
      effort: "high",
      plannerModel: "default",
      builderModel: "default",
      reviewerModel: "default",
      worktreeStrategy: "isolated",
      concurrencyLimit: 2,
    }),
  checks: z
    .object({
      staticCmd: z.string().default("bun run check"),
      unitCmd: z.string().default("bun test"),
      countPattern: z.string().default("Tests\\s+(\\d+)\\s+passed"),
      protectedPaths: z
        .array(z.string())
        .default(["harness/**", ".animus/holdout/**", ".animus/hooks/**"]),
      toolGuidance: z.record(z.string(), z.string()).default({}),
    })
    .default({
      staticCmd: "bun run check",
      unitCmd: "bun test",
      countPattern: "Tests\\s+(\\d+)\\s+passed",
      protectedPaths: ["harness/**", ".animus/holdout/**", ".animus/hooks/**"],
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
  releases?: Partial<ProjectSettings["releases"]>;
};
