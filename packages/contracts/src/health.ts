import { z } from "zod";

export const serviceHealthSchema = z.object({ status: z.literal("healthy"), buildId: z.string() });
