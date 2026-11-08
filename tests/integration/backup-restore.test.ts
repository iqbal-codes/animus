import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import {
  ProjectRegistryService,
  SyntheticForgeAdapter,
  type SyntheticForgeOptions,
} from "../../apps/backend/src/registry";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { PlanService } from "../../apps/backend/src/plans";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService, type DispatchRunner } from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../../apps/backend/src/work/budget";
import { PublicationService } from "../../apps/backend/src/publication";
import {
  BackupRestoreService,
  assertInstallationNotHeld,
  readInstallationHold,
} from "../../apps/backend/src/restore";
import {
  BACKUP_DATABASE_FILE,
  BACKUP_MANIFEST_FILE,
  BACKUP_MANIFEST_HASH_FILE,
} from "../../apps/backend/src/restore/manifest";
import { runBackupCommand } from "../../scripts/cli/commands/operations";

const REPO = "owner/backup-repo";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function ticketBody(options: { partOf?: number } = {}): string {
  const lines: string[] = [];
  if (options.partOf) lines.push(`Part of #${options.partOf}`, "");
  lines.push(
    "## Source and problem",
    "",
    "Prepared ticket source.",
    "",
    "## Outcome",
    "",
    "Prepared ticket outcome.",
    "",
    "## Invariants",
    "",
    "- Keep the invariant.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1: prepared criterion",
    "",
    "## Boundary",
    "",
    "Prepared ticket boundary.",
    "",
    "Depends on: None",
  );
  return lines.join("\n");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface SeedContext {
  projectId: string;
  checkoutPath: string;
  bareOrigin: string;
  completedRunId: string;
  artifactRelativePath: string;
  artifactSha: string;
  finishActive: () => Promise<void>;
}

describe("workspace backup and isolated restore", () => {
  let root: string;
  let home: string;
  let stateDir: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let observations: ExecutionObservationService;
  let budget: ExecutionBudgetService;
  let projectId: string;
  let checkoutPath: string;
  let bareOrigin: string;

  function remoteHead(branch: string): string | null {
    try {
      const sha = execFileSync(
        "git",
        ["--git-dir", bareOrigin, "rev-parse", "--verify", `refs/heads/${branch}`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return sha || null;
    } catch {
      return null;
    }
  }

  function forgeOptions(): SyntheticForgeOptions {
    return {
      requireRemoteSourceRef: true,
      resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
    };
  }

  function addIssue(number: number): void {
    forge.addIssue(REPO, {
      number,
      title: `Issue ${number}`,
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
  }

  function commitInWorktree(worktreePath: string, name: string): string {
    writeFileSync(join(worktreePath, name), "implemented\n");
    git(worktreePath, "add", name);
    git(worktreePath, "commit", "-q", "-m", `implement ${name}`);
    return git(worktreePath, "rev-parse", "HEAD");
  }

  function committingRunner(): DispatchRunner {
    return async (context) => ({
      success: true,
      headSha: commitInWorktree(context.worktree_path, `impl-${context.issue_number}.txt`),
    });
  }

  function dispatchService(runner: DispatchRunner = committingRunner()): DispatchService {
    return new DispatchService(app.db, {
      plans,
      ledger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner,
    });
  }

  async function waitForRunning(service: DispatchService, planId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const run = service.listRuns(projectId, { plan_id: planId })[0];
      if (run?.state === "running" || run?.state === "dispatched") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("active dispatch did not reach a running state");
  }

  /** Seeds a real published delivery, an active run, a grant, a finding and an artifact. */
  async function seed(context: string): Promise<SeedContext> {
    addIssue(700);
    const completedPlan = await plans.importPlan(projectId, {
      issue_number: 700,
      kind: "standalone",
    });
    const service = dispatchService();
    const completed = await service.dispatch(projectId, {
      plan_id: completedPlan.id,
      actor: "operator",
    });

    // Real offline PR publication through the existing forge/push seam.
    const target = app.db
      .prepare("SELECT id FROM publication_targets WHERE project_id = ? AND work_id = ?")
      .get(projectId, completed.work_id) as { id: string };
    await new PublicationService(app.db, forge).publish(projectId, target.id);

    // Explicit budget grant history.
    const detail = service.getRunDetail(projectId, completed.id);
    budget.applyGrant(detail.budget!, {
      amount: 1,
      reason: `${context} grant`,
      actor: "operator",
      commandRequestId: `cmd_grant_${context}`,
      idempotencyKey: `grant-${context}`,
      now: Date.now(),
    });

    // Real finalized artifact plus a blocking finding so restore must preserve both.
    const artifactRelativePath = "evidence/review.log";
    const artifactAbsolute = join(stateDir, "artifacts", projectId, artifactRelativePath);
    mkdirSync(join(artifactAbsolute, ".."), { recursive: true });
    writeFileSync(artifactAbsolute, `${context} reviewed artifact\n`);
    const reviewer = observations.registerTrustedProducer(projectId, {
      id: `reviewer-${context}`,
      role: "peer_reviewer",
    });
    observations.recordRunObservation(projectId, completed.id, {
      stage: "independent_review",
      status: "failed",
      producer: reviewer.producer,
      checks: [{ name: "review", command: "review", result: "FAIL", detail: "needs work" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "impl.txt:1",
          summary: `${context} blocking finding`,
        },
      ],
      artifacts: [
        {
          ownerType: "finding",
          ownerFindingIndex: 0,
          name: "review log",
          relativePath: artifactRelativePath,
          mediaType: "text/plain",
        },
      ],
    });

    // A genuinely active run that the backup must capture and the restore must interrupt.
    addIssue(701);
    const activePlan = await plans.importPlan(projectId, { issue_number: 701, kind: "standalone" });
    const active = deferred<{ success: boolean; headSha: string }>();
    const activeService = dispatchService(async () => active.promise);
    const activePromise = activeService.dispatch(projectId, {
      plan_id: activePlan.id,
      actor: "operator",
    });
    await waitForRunning(activeService, activePlan.id);
    const activeRun = activeService.listRuns(projectId, { plan_id: activePlan.id })[0]!;

    const artifactBytes = readFileSync(artifactAbsolute);
    const { createHash } = await import("node:crypto");
    return {
      projectId,
      checkoutPath,
      bareOrigin,
      completedRunId: completed.id,
      artifactRelativePath,
      artifactSha: createHash("sha256").update(artifactBytes).digest("hex"),
      finishActive: async () => {
        active.resolve({
          success: true,
          headSha: commitInWorktree(activeRun.worktree_path, "impl-701.txt"),
        });
        await activePromise.catch(() => undefined);
      },
    };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-backup-"));
    home = join(root, "animus-home");
    stateDir = join(home, "state");
    process.env.ANIMUS_HOME = home;
    writeExecutionAuthority("local");
    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
    forge = new SyntheticForgeAdapter({ [REPO]: 913 }, forgeOptions());
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", `url.${bareOrigin}.insteadOf`, `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    git(checkoutPath, "commit", "--allow-empty", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    git(checkoutPath, "push", "-q", "origin", "main");

    app = await createBackendApp({ stateDir, startMonitor: false, forge });
    registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    plans = new PlanService(app.db, forge);
    ledger = new CommandLedger(app.db);
    brakes = new BrakeService(app.db);
    observations = new ExecutionObservationService(app.db);
    budget = new ExecutionBudgetService(app.db);
  });

  afterEach(async () => {
    try {
      await app.stop();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1/AC2: a backup is a consistent database snapshot with hashed finalized artifacts and an honest status", async () => {
    const seeded = await seed("alpha");
    const bundle = join(root, "bundles", "alpha");

    const response = await app.fetch(
      new Request("http://127.0.0.1/api/v1/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinationPath: bundle, actor: "operator" }),
      }),
    );
    expect(response.status).toBe(201);
    const created = await json<{
      manifestHash: string;
      artifactCount: number;
      schemaVersion: number;
    }>(response);
    expect(created.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.artifactCount).toBe(1);
    expect(created.schemaVersion).toBe(11);

    const manifest = JSON.parse(readFileSync(join(bundle, BACKUP_MANIFEST_FILE), "utf8"));
    expect(manifest.kind).toBe("animus-workspace-backup");
    expect(manifest.credentials).toBeUndefined();
    expect(manifest.database.relativePath).toBe(BACKUP_DATABASE_FILE);
    expect(manifest.artifacts[0]).toMatchObject({
      relativePath: seeded.artifactRelativePath,
      sha256: seeded.artifactSha,
    });
    expect(manifest.completeness.tables.work_revisions).toBeGreaterThan(0);

    const bundleArtifact = join(bundle, "artifacts", seeded.projectId, seeded.artifactRelativePath);
    expect(existsSync(bundleArtifact)).toBe(true);

    const snapshotDb = new DatabaseSync(join(bundle, BACKUP_DATABASE_FILE), { readOnly: true });
    try {
      const work = snapshotDb
        .prepare("SELECT id FROM work_items WHERE project_id = ? ORDER BY id")
        .all(seeded.projectId) as Array<{ id: string }>;
      expect(work.length).toBeGreaterThanOrEqual(2);
      // Evidence and budget history are in the snapshot, not just table shells.
      expect(
        (snapshotDb.prepare("SELECT COUNT(*) AS c FROM factory_findings").get() as { c: number }).c,
      ).toBeGreaterThan(0);
      expect(
        (
          snapshotDb.prepare("SELECT COUNT(*) AS c FROM execution_budget_grants").get() as {
            c: number;
          }
        ).c,
      ).toBeGreaterThan(0);
      expect(
        (
          snapshotDb.prepare("SELECT COUNT(*) AS c FROM publication_pull_requests").get() as {
            c: number;
          }
        ).c,
      ).toBeGreaterThan(0);
    } finally {
      snapshotDb.close();
    }

    const statusResponse = await app.fetch(new Request("http://127.0.0.1/api/v1/backups/status"));
    expect(statusResponse.status).toBe(200);
    const status = await json<{
      restorable: boolean;
      reasons: string[];
      artifactCount: number;
      credentials: { included: boolean; note: string };
      sameDiskWarning: string;
    }>(statusResponse);
    expect(status.restorable).toBe(true);
    expect(status.reasons).toEqual([]);
    expect(status.artifactCount).toBe(1);
    expect(status.credentials.included).toBe(false);
    expect(status.credentials.note).toMatch(/reconfigure/i);
    expect(status.sameDiskWarning).toMatch(/same disk/i);

    // Corrupting the finalized artifact makes the snapshot non-restorable instead
    // of silently advertising a broken bundle.
    writeFileSync(bundleArtifact, "tampered after finalization\n");
    const corruptStatusResponse = await app.fetch(
      new Request("http://127.0.0.1/api/v1/backups/status"),
    );
    const corruptStatus = await json<{ restorable: boolean; reasons: string[] }>(
      corruptStatusResponse,
    );
    expect(corruptStatus.restorable).toBe(false);
    expect(corruptStatus.reasons.join(",")).toMatch(/artifact_(size|digest)_mismatch/);

    const targetState = join(root, "restored", "state");
    const corruptRestore = await app.fetch(
      new Request("http://127.0.0.1/api/v1/restores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePath: bundle,
          targetStateDir: targetState,
          targetHome: join(root, "restored"),
        }),
      }),
    );
    expect(corruptRestore.status).toBe(400);
    expect(existsSync(targetState)).toBe(false);
    await seeded.finishActive();
  });

  test("AC3/AC4/AC5: restore into another home preserves identity, history and evidence while holding all execution", async () => {
    const seeded = await seed("beta");
    const bundle = join(root, "bundles", "beta");
    const create = await app.fetch(
      new Request("http://127.0.0.1/api/v1/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinationPath: bundle, actor: "operator" }),
      }),
    );
    expect(create.status).toBe(201);

    const live = app.db;
    const snapshot = {
      workIds: (
        live.prepare("SELECT id FROM work_items ORDER BY id").all() as Array<{ id: string }>
      ).map((row) => row.id),
      revisionHashes: (
        live.prepare("SELECT content_hash FROM work_revisions ORDER BY id").all() as Array<{
          content_hash: string;
        }>
      ).map((row) => row.content_hash),
      deliveryIds: (
        live.prepare("SELECT id FROM deliveries ORDER BY id").all() as Array<{ id: string }>
      ).map((row) => row.id),
      prNumbers: (
        live.prepare("SELECT number FROM publication_pull_requests ORDER BY id").all() as Array<{
          number: number;
        }>
      ).map((row) => row.number),
      grantKeys: (
        live
          .prepare("SELECT idempotency_key FROM execution_budget_grants ORDER BY id")
          .all() as Array<{ idempotency_key: string }>
      ).map((row) => row.idempotency_key),
      findingIds: (
        live.prepare("SELECT id FROM factory_findings ORDER BY id").all() as Array<{ id: string }>
      ).map((row) => row.id),
      commandIds: (
        live.prepare("SELECT request_id FROM commands ORDER BY request_id").all() as Array<{
          request_id: string;
        }>
      ).map((row) => row.request_id),
      consumed: live
        .prepare(
          "SELECT SUM(consumed_attempts) AS c, SUM(granted_attempts) AS g FROM execution_budget_scopes",
        )
        .get() as { c: number; g: number },
      pendingIntents: (
        live
          .prepare(
            "SELECT COUNT(*) AS c FROM publication_intents WHERE state IN ('queued', 'attempting', 'failed', 'unknown')",
          )
          .get() as { c: number }
      ).c,
    };
    expect(snapshot.prNumbers.length).toBeGreaterThan(0);
    expect(snapshot.pendingIntents).toBeGreaterThan(0);

    const restoredHome = join(root, "restored-home");
    const restoredState = join(restoredHome, "state");
    const restoreResponse = await app.fetch(
      new Request("http://127.0.0.1/api/v1/restores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePath: bundle,
          targetStateDir: restoredState,
          targetHome: restoredHome,
          actor: "operator",
        }),
      }),
    );
    expect(restoreResponse.status).toBe(201);
    const restored = await json<{
      installation: { held: boolean; status: string };
      operation: { status: string; report: Record<string, unknown> };
    }>(restoreResponse);
    expect(restored.installation.held).toBe(true);
    expect(restored.operation.status).toBe("completed");
    expect(restored.operation.report.dispatchEnabled).toBe(false);
    expect(restored.operation.report.publicationEnabled).toBe(false);

    const targetDb = new DatabaseSync(join(restoredState, BACKUP_DATABASE_FILE));
    try {
      targetDb.exec("PRAGMA foreign_keys = ON;");
      expect(readInstallationHold(targetDb).held).toBe(true);
      expect(() => assertInstallationNotHeld(targetDb)).toThrow(/installation_held/);

      const restoredWorkIds = (
        targetDb.prepare("SELECT id FROM work_items ORDER BY id").all() as Array<{ id: string }>
      ).map((row) => row.id);
      const restoredRevisionHashes = (
        targetDb.prepare("SELECT content_hash FROM work_revisions ORDER BY id").all() as Array<{
          content_hash: string;
        }>
      ).map((row) => row.content_hash);
      expect(restoredWorkIds).toEqual(snapshot.workIds);
      expect(restoredRevisionHashes).toEqual(snapshot.revisionHashes);

      expect(
        (
          targetDb.prepare("SELECT id FROM deliveries ORDER BY id").all() as Array<{ id: string }>
        ).map((row) => row.id),
      ).toEqual(snapshot.deliveryIds);
      expect(
        (
          targetDb
            .prepare("SELECT number FROM publication_pull_requests ORDER BY id")
            .all() as Array<{ number: number }>
        ).map((row) => row.number),
      ).toEqual(snapshot.prNumbers);
      expect(
        (
          targetDb
            .prepare("SELECT idempotency_key FROM execution_budget_grants ORDER BY id")
            .all() as Array<{ idempotency_key: string }>
        ).map((row) => row.idempotency_key),
      ).toEqual(snapshot.grantKeys);
      expect(
        (
          targetDb.prepare("SELECT id FROM factory_findings ORDER BY id").all() as Array<{
            id: string;
          }>
        ).map((row) => row.id),
      ).toEqual(snapshot.findingIds);
      expect(
        (
          targetDb.prepare("SELECT request_id FROM commands ORDER BY request_id").all() as Array<{
            request_id: string;
          }>
        ).map((row) => row.request_id),
      ).toEqual(snapshot.commandIds);
      expect(
        targetDb
          .prepare(
            "SELECT SUM(consumed_attempts) AS c, SUM(granted_attempts) AS g FROM execution_budget_scopes",
          )
          .get(),
      ).toMatchObject(snapshot.consumed);
      expect(
        (
          targetDb
            .prepare(
              "SELECT COUNT(*) AS c FROM publication_intents WHERE state IN ('queued', 'attempting', 'failed', 'unknown')",
            )
            .get() as { c: number }
        ).c,
      ).toBe(snapshot.pendingIntents);

      // No run survives as active, and legitimate home-local paths point at the new home.
      expect(
        (
          targetDb
            .prepare(
              "SELECT COUNT(*) AS c FROM dispatch_runs WHERE state IN ('claimed', 'dispatched', 'running')",
            )
            .get() as { c: number }
        ).c,
      ).toBe(0);
      const runPaths = targetDb.prepare("SELECT worktree_path FROM dispatch_runs").all() as Array<{
        worktree_path: string;
      }>;
      expect(runPaths.length).toBeGreaterThan(0);
      for (const row of runPaths) {
        expect(row.worktree_path.startsWith(restoredHome + "/")).toBe(true);
        expect(row.worktree_path.includes("/projects/")).toBe(true);
      }
      expect(
        (
          targetDb
            .prepare(
              "SELECT COUNT(*) AS c FROM execution_controls WHERE status IN ('active', 'stopping')",
            )
            .get() as { c: number }
        ).c,
      ).toBe(0);

      // Finalized artifact bytes are present under the restored home and still match.
      const restoredArtifact = join(
        restoredState,
        "artifacts",
        seeded.projectId,
        seeded.artifactRelativePath,
      );
      expect(existsSync(restoredArtifact)).toBe(true);
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(readFileSync(restoredArtifact)).digest("hex")).toBe(
        seeded.artifactSha,
      );

      // Publication is held even though the local records are readable.
      const restoredTarget = targetDb
        .prepare("SELECT id FROM publication_targets ORDER BY id LIMIT 1")
        .get() as { id: string };
      await expect(
        new PublicationService(targetDb, forge).publish(seeded.projectId, restoredTarget.id),
      ).rejects.toMatchObject({ code: "publication_installation_held" });

      // Dispatch is held before any worktree or tool starts.
      const restoredPlans = new PlanService(targetDb, forge);
      const restoredLedger = new CommandLedger(targetDb);
      const restoredBrakes = new BrakeService(targetDb);
      const restoredDispatch = new DispatchService(targetDb, {
        plans: restoredPlans,
        ledger: restoredLedger,
        brakes: restoredBrakes,
        runner: async () => ({ success: false, error: "must not run" }),
        processAlive: () => true,
        ownerPid: () => 4242,
      });
      const restoredPlan = targetDb.prepare("SELECT id FROM plans ORDER BY id LIMIT 1").get() as {
        id: string;
      };
      await expect(
        restoredDispatch.dispatch(seeded.projectId, {
          plan_id: restoredPlan.id,
          actor: "operator",
        }),
      ).rejects.toMatchObject({ code: "installation_held" });
    } finally {
      targetDb.close();
    }

    // Explicit reconciliation clears the hold without touching budgets or history.
    const reconcileResponse = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restoredState)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: "operator",
            reason: "Inspected the restored run owner and pending publication intents",
          }),
        },
      ),
    );
    expect(reconcileResponse.status).toBe(200);
    const reconciled = await json<{ installation: { held: boolean; status: string } }>(
      reconcileResponse,
    );
    expect(reconciled.installation.held).toBe(false);
    expect(reconciled.installation.status).toBe("reconciled");

    const reconciledDb = new DatabaseSync(join(restoredState, BACKUP_DATABASE_FILE), {
      readOnly: true,
    });
    try {
      expect(() => assertInstallationNotHeld(reconciledDb)).not.toThrow();
      expect(
        (
          reconciledDb.prepare("SELECT COUNT(*) AS c FROM execution_budget_grants").get() as {
            c: number;
          }
        ).c,
      ).toBe(snapshot.grantKeys.length);
    } finally {
      reconciledDb.close();
    }
    await seeded.finishActive();
  });

  test("AC5: concurrent writers are drained at the SQLite boundary and broken or incomplete bundles fail closed", async () => {
    const seeded = await seed("gamma");
    const service = new BackupRestoreService(app.db, {
      stateDir,
      ledger,
      busyTimeoutMs: 150,
    });
    const bundle = join(root, "bundles", "gamma");

    // A real foreign connection holds a write transaction: the snapshot must fail
    // closed rather than read a torn state.
    const blocker = new DatabaseSync(join(stateDir, BACKUP_DATABASE_FILE));
    blocker.exec("PRAGMA busy_timeout = 150;");
    blocker.exec("BEGIN IMMEDIATE;");
    blocker
      .prepare(
        `INSERT INTO commands (request_id, actor, project_id, action, target, timestamp, state, outcome, evidence_links, created_at, updated_at)
         VALUES ('blocker', 'test', NULL, 'block', '{}', '2026-01-01T00:00:00Z', 'dispatched', NULL, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();
    expect(() => service.createBackup(bundle, "operator")).toThrow(/drain|locked|busy/i);
    expect(existsSync(bundle)).toBe(false);
    blocker.exec("ROLLBACK;");
    blocker.close();

    const created = service.createBackup(bundle, "operator");
    expect(created.artifactCount).toBe(1);
    expect(existsSync(join(bundle, BACKUP_MANIFEST_FILE))).toBe(true);

    // A non-complete partial directory is never advertised and never overwritten.
    const partial = `${bundle}.partial-leftover`;
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "junk"), "x");
    expect(service.backupStatus().reasons).toEqual([]);
    expect(() => service.createBackup(bundle, "operator")).toThrow();

    // Truncated database is rejected before any target activation.
    const truncated = join(root, "bundles", "truncated");
    execFileSync("cp", ["-R", bundle, truncated]);
    writeFileSync(join(truncated, BACKUP_DATABASE_FILE), "not a sqlite database");
    expect(() =>
      service.restoreBackup({
        sourcePath: truncated,
        targetStateDir: join(root, "restored-truncated", "state"),
        targetHome: join(root, "restored-truncated"),
      }),
    ).toThrow(/restore_validation_failed|incomplete|corrupt/i);
    expect(existsSync(join(root, "restored-truncated", "state"))).toBe(false);

    // Removing a finalized artifact is a completeness failure.
    const missing = join(root, "bundles", "missing");
    execFileSync("cp", ["-R", bundle, missing]);
    const manifest = JSON.parse(readFileSync(join(missing, BACKUP_MANIFEST_FILE), "utf8"));
    rmSync(
      join(
        missing,
        "artifacts",
        manifest.artifacts[0].projectId,
        manifest.artifacts[0].relativePath,
      ),
    );
    expect(() =>
      service.restoreBackup({
        sourcePath: missing,
        targetStateDir: join(root, "restored-missing", "state"),
        targetHome: join(root, "restored-missing"),
      }),
    ).toThrow(/incomplete or corrupt/i);
    expect(existsSync(join(root, "restored-missing", "state"))).toBe(false);

    // A tampered manifest hash fails closed.
    const tampered = join(root, "bundles", "tampered");
    execFileSync("cp", ["-R", bundle, tampered]);
    writeFileSync(join(tampered, BACKUP_MANIFEST_HASH_FILE), `${"f".repeat(64)}\n`);
    expect(() =>
      service.restoreBackup({
        sourcePath: tampered,
        targetStateDir: join(root, "restored-tampered", "state"),
        targetHome: join(root, "restored-tampered"),
      }),
    ).toThrow(/manifest hash/i);

    // A target directory that already has content is refused without mutation.
    const occupied = join(root, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "keep"), "do not delete");
    expect(() =>
      service.restoreBackup({
        sourcePath: bundle,
        targetStateDir: occupied,
        targetHome: join(root, "occupied-home"),
      }),
    ).toThrow(/already exists/i);
    expect(readFileSync(join(occupied, "keep"), "utf8")).toBe("do not delete");
    await seeded.finishActive();
  }, 20000);
  test("AC1/AC5: the normal CLI exposes verified backup, held restore and explicit reconciliation", async () => {
    const seeded = await seed("cli");
    const bundle = join(root, "bundles", "cli");
    const fetchShim = (input: string, init?: RequestInit) => app.fetch(new Request(input, init));

    async function capture(run: () => Promise<number>): Promise<{ code: number; logs: string[] }> {
      const logs: string[] = [];
      const original = console.log;
      const originalError = console.error;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      console.error = (...args: unknown[]) => logs.push(args.join(" "));
      try {
        return { code: await run(), logs };
      } finally {
        console.log = original;
        console.error = originalError;
      }
    }

    const base = {
      factoryUrl: "http://127.0.0.1",
      fetch: fetchShim,
      json: true as const,
    };

    const created = await capture(() =>
      runBackupCommand({
        ...base,
        subcommand: "create",
        positionals: [],
        destination: bundle,
        actor: "operator",
      }),
    );
    expect(created.code).toBe(0);
    const createdBody = JSON.parse(created.logs.join("\n"));
    expect(createdBody.destinationPath).toBe(bundle);
    expect(createdBody.artifactCount).toBe(1);

    const status = await capture(() =>
      runBackupCommand({ ...base, subcommand: "status", positionals: [] }),
    );
    expect(status.code).toBe(0);
    expect(JSON.parse(status.logs.join("\n")).restorable).toBe(true);

    const restoredState = join(root, "cli-restored", "state");
    const restoredHome = join(root, "cli-restored");
    const restore = await capture(() =>
      runBackupCommand({
        ...base,
        subcommand: "restore",
        positionals: ["backup", "restore", bundle],
        targetStateDir: restoredState,
        targetHome: restoredHome,
        actor: "operator",
      }),
    );
    expect(restore.code, restore.logs.join("\n")).toBe(0);
    const restoreBody = JSON.parse(restore.logs.join("\n"));
    expect(restoreBody.installation.held).toBe(true);
    expect(restoreBody.operation.report.dispatchEnabled).toBe(false);

    const restores = await capture(() =>
      runBackupCommand({
        ...base,
        subcommand: "restores",
        positionals: [],
        targetStateDir: restoredState,
      }),
    );
    expect(restores.code).toBe(0);
    expect(JSON.parse(restores.logs.join("\n")).installation.held).toBe(true);

    const reconcile = await capture(() =>
      runBackupCommand({
        ...base,
        subcommand: "reconcile",
        positionals: [],
        targetStateDir: restoredState,
        actor: "operator",
        reason: "CLI operator inspected restored ownership",
      }),
    );
    expect(reconcile.code).toBe(0);
    expect(JSON.parse(reconcile.logs.join("\n")).installation.held).toBe(false);

    await seeded.finishActive();
  }, 20000);
});
