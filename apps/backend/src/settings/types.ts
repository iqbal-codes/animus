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

export const modelTierBindingSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().optional(),
});

export type ModelTierBinding = z.infer<typeof modelTierBindingSchema>;

export const modelTiersMapSchema = z.record(
  z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/, "Tier name must be lowercase alphanumeric/hyphen/underscore"),
  modelTierBindingSchema,
);

export type ModelTiersMap = z.infer<typeof modelTiersMapSchema>;

export const pipelineRoleSchema = z.enum([
  "triage",
  "planner",
  "builder",
  "qa",
  "reviewer",
  "reflector",
]);

export type PipelineRole = z.infer<typeof pipelineRoleSchema>;

export const roleRoutingMapSchema = z.record(
  pipelineRoleSchema,
  z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
);

export type RoleRoutingMap = z.infer<typeof roleRoutingMapSchema>;

export const projectSettingsSchema = z.object({
  models: z
    .object({
      tiers: modelTiersMapSchema.optional(),
      roles: roleRoutingMapSchema.optional(),
      worktreeStrategy: z.string().default("isolated"),
      baseBranch: z.string().default("main"),
      concurrencyLimit: z.number().default(2),
    })
    .passthrough()
    .default({
      worktreeStrategy: "isolated",
      baseBranch: "main",
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
