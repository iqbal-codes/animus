import { z } from "zod";

export const healthSchema = z
  .object({
    status: z.literal("healthy"),
    buildId: z.string(),
    host: z.object({ status: z.literal("healthy"), buildId: z.string() }),
  })
  .refine((value) => value.buildId === value.host.buildId);
export type Health = z.infer<typeof healthSchema>;
export const operatorErrorSchema = z.object({
  error: z.enum([
    "host_unavailable",
    "host_unauthorized",
    "invalid_host_response",
    "candidate_mismatch",
  ]),
});
export type OperatorErrorCode = z.infer<typeof operatorErrorSchema>["error"];
