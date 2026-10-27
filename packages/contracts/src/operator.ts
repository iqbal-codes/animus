import { z } from "zod";
import { serviceHealthSchema } from "./health";

export const healthSchema = serviceHealthSchema
  .extend({ host: serviceHealthSchema })
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
