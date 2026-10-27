import { z } from "zod";

export const hostHealthSchema = z.object({ status: z.literal("healthy"), buildId: z.string() });
export type HostHealth = z.infer<typeof hostHealthSchema>;
