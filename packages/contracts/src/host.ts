import { z } from "zod";
import { serviceHealthSchema } from "./health";
import {
  diagnosticsSchema,
  workflowCatalogSchema,
  lapListSchema,
  lapDetailSchema,
  launchSubmissionSchema,
  launchAckSchema,
  controlStateSchema,
  controlSubmissionSchema,
} from "./operator";

export const hostHealthSchema = serviceHealthSchema;
export type HostHealth = z.infer<typeof hostHealthSchema>;

export const hostDiagnosticsSchema = diagnosticsSchema;
export const hostWorkflowCatalogSchema = workflowCatalogSchema;
export const hostLapListSchema = lapListSchema;
export const hostLapDetailSchema = lapDetailSchema;
export const hostLaunchSubmissionSchema = launchSubmissionSchema;
export const hostLaunchAckSchema = launchAckSchema;
export const hostControlStateSchema = controlStateSchema;
export const hostControlSubmissionSchema = controlSubmissionSchema;
