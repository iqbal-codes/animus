import type { DatabaseSync } from "node:sqlite";
import type { ForgeAdapter } from "./registry";
import type { PlanService } from "./plans";
import type { DispatchService } from "./dispatch";
import { ExecutionObservationService } from "./evidence";
import { ExecutionBudgetService } from "./work/budget";
import { PublicationService } from "./publication";
import {
  DeliveryGateService,
  DeliveryRuntimeCoordinator,
  type DeliveryRuntimeEngine,
} from "./delivery";
import { ChildIntegrationService } from "./integration";
import { FinalDeliveryService } from "./final";

export interface LocalExecutionRuntimeOptions {
  db: DatabaseSync;
  plans: PlanService;
  dispatch: DispatchService;
  forge: ForgeAdapter;
  observations?: ExecutionObservationService;
  budget?: ExecutionBudgetService;
  publication?: PublicationService;
  artifactRoot?: string;
  engine?: DeliveryRuntimeEngine;
  regressionChecks?: string[];
  technicalChecks?: string[];
  maxCorrections?: number;
  gitRunner?: (cmd: string[], options: { cwd: string }) => string;
  /** Test/embedding override; production uses the coordinator built here. */
  deliveryRuntime?: DeliveryRuntimeCoordinator;
}

/**
 * The single composition root for local execution. The app kernel, the CLI
 * scheduler and `animus loop` scheduler must all build their delivery surfaces
 * here so a scheduled child, standalone or final run receives the same gate,
 * child-integration and recovery wiring instead of diverging per entry point.
 */
export interface LocalExecutionRuntime {
  observations: ExecutionObservationService;
  budget: ExecutionBudgetService;
  publication: PublicationService;
  gate: DeliveryGateService;
  integration: ChildIntegrationService;
  final: FinalDeliveryService;
  delivery: DeliveryRuntimeCoordinator;
}

export function createLocalExecutionRuntime(
  options: LocalExecutionRuntimeOptions,
): LocalExecutionRuntime {
  const observations = options.observations ?? new ExecutionObservationService(options.db);
  const budget = options.budget ?? new ExecutionBudgetService(options.db);
  const publication = options.publication ?? new PublicationService(options.db, options.forge);
  const gate = new DeliveryGateService(options.db, {
    observations,
    publication,
    forge: options.forge,
  });
  const integration = new ChildIntegrationService(options.db, {
    observations,
    publication,
    forge: options.forge,
    ...(options.gitRunner ? { gitRunner: options.gitRunner } : {}),
  });

  const runtimeRef: { current: DeliveryRuntimeCoordinator | null } = { current: null };
  const final = new FinalDeliveryService(options.db, {
    plans: options.plans,
    dispatch: options.dispatch,
    observations,
    publication,
    gate,
    budget,
    runtime: () => runtimeRef.current!,
    ...(options.gitRunner
      ? { gitRunner: (cmd: string[], cwd: string) => options.gitRunner!(cmd, { cwd }) }
      : {}),
  });

  const delivery =
    options.deliveryRuntime ??
    new DeliveryRuntimeCoordinator(options.db, {
      gate,
      observations,
      dispatch: options.dispatch,
      budget,
      publication,
      integration,
      ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
      ...(options.engine ? { engine: options.engine } : {}),
      ...(options.regressionChecks ? { regressionChecks: options.regressionChecks } : {}),
      ...(options.technicalChecks ? { technicalChecks: options.technicalChecks } : {}),
      ...(options.maxCorrections !== undefined ? { maxCorrections: options.maxCorrections } : {}),
      correction: {
        dispatch: (request) => final.dispatchCorrection(request),
      },
    });
  runtimeRef.current = delivery;

  return { observations, budget, publication, gate, integration, final, delivery };
}
