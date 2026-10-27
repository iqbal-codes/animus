import { z } from "zod";
import { serviceHealthSchema } from "./health";

export const hostHealthSchema = serviceHealthSchema;
export type HostHealth = z.infer<typeof hostHealthSchema>;
