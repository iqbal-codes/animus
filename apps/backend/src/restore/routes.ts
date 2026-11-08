import {
  backupCreateResultSchema,
  backupCreateSubmissionSchema,
  backupStatusSchema,
  restoreCreateResultSchema,
  restoreCreateSubmissionSchema,
  restoreReconcileSubmissionSchema,
  restoreStatusResultSchema,
} from "@animus/contracts/operator";
import { BackupRestoreError, type BackupRestoreService } from "./service";

function statusFor(code: string): number {
  switch (code) {
    case "restore_target_unavailable":
      return 409;
    case "restore_validation_failed":
    case "restore_failed":
    case "backup_incomplete":
    case "backup_failed":
      return 400;
    default:
      return 500;
  }
}

function failure(error: unknown): Response {
  if (error instanceof BackupRestoreError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status: statusFor(error.code) },
    );
  }
  return Response.json(
    { error: "restore_failed", message: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleBackupRoute(
  request: Request,
  path: string,
  service: BackupRestoreService,
): Promise<Response | null> {
  if (path === "/api/v1/backups") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const parsed = backupCreateSubmissionSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const result = service.createBackup(parsed.data.destinationPath, parsed.data.actor);
      return Response.json(backupCreateResultSchema.parse(result), { status: 201 });
    } catch (error) {
      return failure(error);
    }
  }

  if (path === "/api/v1/backups/status") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    try {
      return Response.json(backupStatusSchema.parse(service.backupStatus()));
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}

export async function handleRestoreRoute(
  request: Request,
  path: string,
  service: BackupRestoreService,
): Promise<Response | null> {
  if (path === "/api/v1/restores") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const parsed = restoreCreateSubmissionSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const result = service.restoreBackup({
        sourcePath: parsed.data.sourcePath,
        targetStateDir: parsed.data.targetStateDir,
        targetHome: parsed.data.targetHome,
        actor: parsed.data.actor,
      });
      return Response.json(restoreCreateResultSchema.parse(result), { status: 201 });
    } catch (error) {
      return failure(error);
    }
  }

  if (path === "/api/v1/restores/status") {
    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET" } },
      );
    }
    const url = new URL(request.url);
    const stateDir = url.searchParams.get("state_dir") ?? undefined;
    try {
      return Response.json(restoreStatusResultSchema.parse(service.restoreStatus(stateDir)));
    } catch (error) {
      return failure(error);
    }
  }

  if (path === "/api/v1/restores/reconcile") {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const parsed = restoreReconcileSubmissionSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const url = new URL(request.url);
    const stateDir = url.searchParams.get("state_dir") ?? undefined;
    try {
      return Response.json(
        restoreStatusResultSchema.parse({
          ...service.restoreStatus(stateDir),
          installation: service.reconcileRestore(
            { actor: parsed.data.actor, reason: parsed.data.reason },
            stateDir,
          ),
        }),
      );
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}
