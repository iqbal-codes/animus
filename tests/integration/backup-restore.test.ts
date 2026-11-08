import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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
  backupManifestSchema,
  canonicalJson,
  manifestHash,
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

interface UnresolvedRunFact {
  runId: string;
  state: string;
  worktreePresent: boolean;
  ownerPidCleared: boolean;
  leaseCleared: boolean;
}
interface UnresolvedIntentFact {
  intentId: string;
  kind: string;
  state: string;
  attempts: number;
}
interface InspectedRestore {
  installation: {
    held: boolean;
    status: string | null;
    sourceRestoreId: string | null;
    restoredAt: number | null;
  };
  unresolved: { runs: UnresolvedRunFact[]; intents: UnresolvedIntentFact[] };
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

    // Verified release: every interrupted run and pending intent is enumerated and
    // explicitly dispositioned; a bare reason cannot clear the hold.
    const inspectedResponse = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/status?state_dir=${encodeURIComponent(restoredState)}`,
      ),
    );
    const inspected = await json<InspectedRestore>(inspectedResponse);
    expect(inspected.unresolved.runs.length).toBeGreaterThan(0);
    expect(inspected.unresolved.intents.length).toBeGreaterThan(0);
    for (const run of inspected.unresolved.runs) {
      expect(run.ownerPidCleared).toBe(true);
      expect(run.leaseCleared).toBe(true);
    }

    const bareReason = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restoredState)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: "operator",
            reason: "Inspected the restored run owner and pending publication intents",
            snapshot: {
              sourceRestoreId: inspected.installation.sourceRestoreId,
              restoredAt: inspected.installation.restoredAt,
            },
          }),
        },
      ),
    );
    expect(bareReason.status).toBe(400);

    const reconcileResponse = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restoredState)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: "operator",
            reason: "Verified restored ownership and remote intent state read-only",
            snapshot: {
              sourceRestoreId: inspected.installation.sourceRestoreId,
              restoredAt: inspected.installation.restoredAt,
            },
            runs: inspected.unresolved.runs.map((run) => ({
              runId: run.runId,
              disposition: "resolved",
            })),
            intents: inspected.unresolved.intents.map((intent) => ({
              intentId: intent.intentId,
              disposition: "abandoned",
            })),
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

    const inspectedCli = await capture(() =>
      runBackupCommand({
        ...base,
        subcommand: "restores",
        positionals: [],
        targetStateDir: restoredState,
      }),
    );
    const inspectedBody = JSON.parse(inspectedCli.logs.join("\n")) as InspectedRestore;
    expect(inspectedBody.unresolved.runs.length).toBeGreaterThan(0);

    const bareReconcile = await capture(() =>
      runBackupCommand({
        ...base,
        subcommand: "reconcile",
        positionals: [],
        targetStateDir: restoredState,
        actor: "operator",
        reason: "CLI operator inspected restored ownership",
      }),
    );
    expect(bareReconcile.code).toBe(1);
    expect(bareReconcile.logs.join("\n")).toMatch(/explicit disposition/i);

    const reconcile = await capture(() =>
      runBackupCommand({
        ...base,
        subcommand: "reconcile",
        positionals: [],
        targetStateDir: restoredState,
        actor: "operator",
        reason: "CLI operator verified restored ownership and remote intent state",
        releaseRuns: inspectedBody.unresolved.runs.map((run) => `${run.runId}:resolved`),
        releaseIntents: inspectedBody.unresolved.intents.map(
          (intent) => `${intent.intentId}:abandoned`,
        ),
      }),
    );
    expect(reconcile.code, reconcile.logs.join("\n")).toBe(0);
    expect(JSON.parse(reconcile.logs.join("\n")).installation.held).toBe(false);

    await seeded.finishActive();
  }, 20000);

  async function backup(label: string): Promise<string> {
    const bundle = join(root, "bundles", label);
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/v1/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinationPath: bundle, actor: "operator" }),
      }),
    );
    expect(response.status).toBe(201);
    return bundle;
  }

  async function restore(
    bundle: string,
    restoredHome: string,
  ): Promise<{
    state: string;
    body: InspectedRestore & { operation: { report: Record<string, unknown> } };
  }> {
    const state = join(restoredHome, "state");
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/v1/restores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePath: bundle,
          targetStateDir: state,
          targetHome: restoredHome,
          actor: "operator",
        }),
      }),
    );
    expect(response.status).toBe(201);
    return { state, body: await json(response) };
  }

  async function inspect(state: string): Promise<InspectedRestore> {
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/restores/status?state_dir=${encodeURIComponent(state)}`),
    );
    expect(response.status).toBe(200);
    return (await json(response)) as InspectedRestore;
  }

  function releasePayload(
    inspected: InspectedRestore,
    overrides: {
      runs?: Array<{ runId: string; disposition: "resolved" | "abandoned" }>;
      intents?: Array<{ intentId: string; disposition: "resolved" | "abandoned" }>;
      snapshot?: { sourceRestoreId: string; restoredAt: number };
    } = {},
  ) {
    return {
      actor: "operator",
      reason: "Verified restored ownership and remote effect state",
      snapshot: overrides.snapshot ?? {
        sourceRestoreId: inspected.installation.sourceRestoreId as string,
        restoredAt: inspected.installation.restoredAt as number,
      },
      runs:
        overrides.runs ??
        inspected.unresolved.runs.map((run) => ({
          runId: run.runId,
          disposition: "resolved" as const,
        })),
      intents:
        overrides.intents ??
        inspected.unresolved.intents.map((intent) => ({
          intentId: intent.intentId,
          disposition: "abandoned" as const,
        })),
    };
  }

  test("AC4: restored runs lose copied owner identity and a reason-only release is refused", async () => {
    const seeded = await seed("owner-clear");
    const before = app.db
      .prepare(
        "SELECT id, owner_pid, owner_token FROM dispatch_runs WHERE state IN ('claimed','dispatched','running','interrupted')",
      )
      .all() as Array<{ id: string; owner_pid: number | null; owner_token: string }>;
    const beforeTokens = new Map(before.map((row) => [row.id, row.owner_token]));

    const bundle = await backup("owner-clear");
    const restored = await restore(bundle, join(root, "owner-clear-home"));
    const report = restored.body.operation.report as Record<string, unknown>;
    expect(report.clearedOwnerCount).toBeGreaterThan(0);

    const restoredDb = new DatabaseSync(join(restored.state, BACKUP_DATABASE_FILE));
    try {
      restoredDb.exec("PRAGMA foreign_keys = ON;");
      const runs = restoredDb
        .prepare(
          "SELECT id, owner_pid, owner_token, lease_expires_at FROM dispatch_runs WHERE state IN ('claimed','dispatched','running','interrupted')",
        )
        .all() as Array<{
        id: string;
        owner_pid: number | null;
        owner_token: string;
        lease_expires_at: number | null;
      }>;
      for (const run of runs) {
        expect(run.owner_pid).toBeNull();
        expect(run.lease_expires_at).toBeNull();
        expect(run.owner_token).not.toBe(beforeTokens.get(run.id));
      }
      // Budget and lap history survive the identity clearing untouched.
      expect(
        restoredDb
          .prepare(
            "SELECT SUM(consumed_attempts) AS c, SUM(granted_attempts) AS g FROM execution_budget_scopes",
          )
          .get(),
      ).toMatchObject(
        app.db
          .prepare(
            "SELECT SUM(consumed_attempts) AS c, SUM(granted_attempts) AS g FROM execution_budget_scopes",
          )
          .get() as object,
      );
    } finally {
      restoredDb.close();
    }

    const inspected = await inspect(restored.state);
    for (const run of inspected.unresolved.runs) {
      expect(run.ownerPidCleared).toBe(true);
      expect(run.leaseCleared).toBe(true);
    }

    const reasonOnly = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restored.state)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: "operator",
            reason: "Operator says everything is fine",
            snapshot: {
              sourceRestoreId: inspected.installation.sourceRestoreId,
              restoredAt: inspected.installation.restoredAt,
            },
            runs: [],
            intents: [],
          }),
        },
      ),
    );
    expect(reasonOnly.status).toBe(409);
    expect(await json<{ error: string }>(reasonOnly)).toMatchObject({
      error: "restore_reconcile_unresolved",
    });

    const staleFence = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restored.state)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            releasePayload(inspected, {
              snapshot: {
                sourceRestoreId: inspected.installation.sourceRestoreId!,
                restoredAt: (inspected.installation.restoredAt ?? 0) + 1,
              },
            }),
          ),
        },
      ),
    );
    expect(staleFence.status).toBe(409);

    const released = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restored.state)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(releasePayload(inspected)),
        },
      ),
    );
    expect(released.status).toBe(200);
    const releaseBody = await json<{
      installation: { held: boolean; reconciliation: { runs: unknown[] } };
    }>(released);
    expect(releaseBody.installation.held).toBe(false);
    expect(releaseBody.installation.reconciliation.runs.length).toBe(
      inspected.unresolved.runs.length,
    );

    await seeded.finishActive();
  }, 30000);

  test("AC4: reused PID, unreadable remote readback and a present remote effect block release", async () => {
    const seeded = await seed("release-fences");
    const bundle = await backup("release-fences");
    const restored = await restore(bundle, join(root, "release-fences-home"));
    const inspected = await inspect(restored.state);
    const activeRun = inspected.unresolved.runs[0]!;

    // A reused PID is never authority: the restored row must stay cleared.
    const restoredDb = new DatabaseSync(join(restored.state, BACKUP_DATABASE_FILE));
    try {
      restoredDb
        .prepare("UPDATE dispatch_runs SET owner_pid = 4242 WHERE id = ?")
        .run(activeRun.runId);
    } finally {
      restoredDb.close();
    }
    const withPid = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restored.state)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            releasePayload(await inspect(restored.state), {
              runs: [{ runId: activeRun.runId, disposition: "resolved" }],
            }),
          ),
        },
      ),
    );
    expect(withPid.status).toBe(409);
    expect(
      (await json<{ details: { blocked: Array<{ reason: string }> } }>(withPid)).details.blocked,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "owner_identity_not_cleared" })]),
    );

    const cleared = new DatabaseSync(join(restored.state, BACKUP_DATABASE_FILE));
    try {
      cleared
        .prepare("UPDATE dispatch_runs SET owner_pid = NULL WHERE id = ?")
        .run(activeRun.runId);
    } finally {
      cleared.close();
    }

    // An unreadable remote readback fails closed instead of guessing.
    const failingForge = new SyntheticForgeAdapter({ [REPO]: 913 }, forgeOptions());
    failingForge.failNextListPullRequests = true;
    const failing = new BackupRestoreService(app.db, {
      stateDir,
      ledger,
      forge: failingForge,
    });
    await expect(
      failing.reconcileRestore(
        releasePayload(await inspect(restored.state), {
          intents: (await inspect(restored.state)).unresolved.intents.map((intent) => ({
            intentId: intent.intentId,
            disposition: "resolved" as const,
          })),
        }),
        restored.state,
      ),
    ).rejects.toMatchObject({ code: "restore_reconcile_unverified", details: expect.anything() });

    // A remote object that exists must be dispositioned `resolved`, not abandoned.
    const remoteState = new DatabaseSync(join(restored.state, BACKUP_DATABASE_FILE));
    let branch = "";
    try {
      const pr = remoteState
        .prepare(
          "SELECT target_id, head_branch, project_id FROM publication_pull_requests WHERE active = 1 LIMIT 1",
        )
        .get() as { target_id: string; head_branch: string; project_id: string } | undefined;
      expect(pr).toBeTruthy();
      branch = pr!.head_branch;
      remoteState
        .prepare(
          `INSERT INTO publication_intents
             (id, target_id, project_id, draft_publication_id, operation_key, kind, resource_kind,
              state, request_json, attempts, remote_object_id, remote_url, last_error, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, 'create_pr', 'pull_request', 'queued', ?, 0, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          "int_present_effect",
          pr!.target_id,
          pr!.project_id,
          `create_pr:${branch}:present-probe`,
          JSON.stringify({ sourceBranch: branch }),
          Date.now(),
          Date.now(),
        );
    } finally {
      remoteState.close();
    }

    const presentInspected = await inspect(restored.state);
    expect(
      presentInspected.unresolved.intents.some((i) => i.intentId === "int_present_effect"),
    ).toBe(true);
    const abandonedPresent = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restored.state)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            releasePayload(presentInspected, {
              intents: presentInspected.unresolved.intents.map((intent) => ({
                intentId: intent.intentId,
                disposition: "abandoned" as const,
              })),
            }),
          ),
        },
      ),
    );
    expect(abandonedPresent.status).toBe(409);
    expect(
      (await json<{ details: { blocked: Array<{ reason: string }> } }>(abandonedPresent)).details
        .blocked,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "remote_effect_present" })]),
    );

    const resolvedPresent = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/restores/reconcile?state_dir=${encodeURIComponent(restored.state)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            releasePayload(presentInspected, {
              intents: presentInspected.unresolved.intents.map((intent) => ({
                intentId: intent.intentId,
                disposition:
                  intent.intentId === "int_present_effect"
                    ? ("resolved" as const)
                    : ("abandoned" as const),
              })),
            }),
          ),
        },
      ),
    );
    expect(resolvedPresent.status).toBe(200);

    await seeded.finishActive();
  }, 30000);

  test("AC1/AC3: duplicate owner artifact references back up once and restore intact", async () => {
    const seeded = await seed("duplicate-artifact");
    const artifact = app.db
      .prepare(
        "SELECT id, project_id, observation_id, name, relative_path, media_type, size_bytes, digest_sha256, created_at FROM execution_artifacts LIMIT 1",
      )
      .get() as {
      id: string;
      project_id: string;
      observation_id: string;
      name: string;
      relative_path: string;
      media_type: string;
      size_bytes: number;
      digest_sha256: string;
      created_at: number;
    };
    app.db
      .prepare(
        `INSERT INTO execution_artifacts
           (id, project_id, observation_id, owner_type, owner_id, name, relative_path, media_type,
            size_bytes, digest_sha256, created_at)
         VALUES (?, ?, ?, 'finding', 'dup-owner', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "art_duplicate_owner",
        artifact.project_id,
        artifact.observation_id,
        artifact.name,
        artifact.relative_path,
        artifact.media_type,
        artifact.size_bytes,
        artifact.digest_sha256,
        artifact.created_at,
      );

    const created = await app.fetch(
      new Request("http://127.0.0.1/api/v1/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destinationPath: join(root, "bundles", "duplicate-artifact"),
          actor: "operator",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const body = await json<{ artifactCount: number }>(created);
    expect(body.artifactCount).toBe(1);

    const restored = await restore(
      join(root, "bundles", "duplicate-artifact"),
      join(root, "dup-home"),
    );
    const restoredDb = new DatabaseSync(join(restored.state, BACKUP_DATABASE_FILE), {
      readOnly: true,
    });
    try {
      expect(
        (
          restoredDb
            .prepare("SELECT COUNT(*) AS c FROM execution_artifacts WHERE relative_path = ?")
            .get(artifact.relative_path) as { c: number }
        ).c,
      ).toBe(2);
    } finally {
      restoredDb.close();
    }
    await seeded.finishActive();
  }, 30000);

  test("AC3: manifest completeness counts are cross-checked before activation", async () => {
    const seeded = await seed("completeness");
    const bundle = await backup("completeness");
    const manifestPath = join(bundle, BACKUP_MANIFEST_FILE);
    const manifest = backupManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );
    const tampered = {
      ...manifest,
      completeness: {
        ...manifest.completeness,
        tables: {
          ...manifest.completeness.tables,
          work_items: manifest.completeness.tables.work_items + 1,
        },
      },
    };
    writeFileSync(manifestPath, canonicalJson(tampered));
    writeFileSync(
      join(bundle, BACKUP_MANIFEST_HASH_FILE),
      `${manifestHash(backupManifestSchema.parse(tampered))}\n`,
    );

    const response = await app.fetch(
      new Request("http://127.0.0.1/api/v1/restores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePath: bundle,
          targetStateDir: join(root, "completeness-home", "state"),
          targetHome: join(root, "completeness-home"),
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await json<{ message: string }>(response)).message).toMatch(/manifest recorded/);
    expect(existsSync(join(root, "completeness-home", "state"))).toBe(false);
    await seeded.finishActive();
  }, 30000);

  test("AC1/AC3: artifactRoot defaults to the service state directory", async () => {
    const seeded = await seed("artifact-root");
    const service = new BackupRestoreService(app.db, { stateDir, ledger });
    const bundle = join(root, "bundles", "artifact-root");
    const created = service.createBackup(bundle, "operator");
    expect(created.artifactCount).toBe(1);
    expect(
      existsSync(join(bundle, "artifacts", seeded.projectId, seeded.artifactRelativePath)),
    ).toBe(true);
    await seeded.finishActive();
  }, 30000);

  test("AC3: restored home references are rehomed, checkouts are reported and bundles are not required", async () => {
    const seeded = await seed("rehome");
    const bundle = await backup("rehome");
    const restoredHome = join(root, "rehome-home");
    const restored = await restore(bundle, restoredHome);
    const report = restored.body.operation.report as {
      projectCheckouts: Array<{ checkoutPath: string; present: boolean; rehomeRequired: boolean }>;
    };
    expect(report.projectCheckouts.length).toBeGreaterThan(0);
    expect(report.projectCheckouts[0]!.checkoutPath).toBe(checkoutPath);
    expect(report.projectCheckouts[0]!.present).toBe(true);

    const restoredDb = new DatabaseSync(join(restored.state, BACKUP_DATABASE_FILE));
    try {
      const runs = restoredDb.prepare("SELECT worktree_path FROM dispatch_runs").all() as Array<{
        worktree_path: string;
      }>;
      for (const run of runs) {
        expect(run.worktree_path.startsWith(restoredHome + "/")).toBe(true);
        expect(run.worktree_path.includes(join(root, "animus-home"))).toBe(false);
      }
      expect(restoredDb.prepare("SELECT checkout_path FROM projects").get()).toMatchObject({
        checkout_path: checkoutPath,
      });
    } finally {
      restoredDb.close();
    }

    // Restored artifacts are independent of the source bundle.
    rmSync(bundle, { recursive: true, force: true });
    const restoredArtifact = join(
      restored.state,
      "artifacts",
      seeded.projectId,
      seeded.artifactRelativePath,
    );
    expect(existsSync(restoredArtifact)).toBe(true);
    expect(createHash("sha256").update(readFileSync(restoredArtifact)).digest("hex")).toBe(
      seeded.artifactSha,
    );
    await seeded.finishActive();
  }, 30000);

  test("AC3: a v11-only snapshot restores into the combined v8+v10+v11 registry", async () => {
    const seeded = await seed("lineage");
    const bundle = await backup("lineage");
    const snapshotPath = join(bundle, BACKUP_DATABASE_FILE);
    const snapshot = new DatabaseSync(snapshotPath);
    try {
      snapshot.exec("PRAGMA foreign_keys = OFF;");
      snapshot.exec("DROP TABLE child_integration_events;");
      snapshot.exec("DROP TABLE child_integrations;");
      snapshot.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
      expect(
        (
          snapshot
            .prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 8")
            .get() as {
            c: number;
          }
        ).c,
      ).toBe(0);
      snapshot.exec("PRAGMA journal_mode = DELETE;");
    } finally {
      snapshot.close();
    }
    const manifestPath = join(bundle, BACKUP_MANIFEST_FILE);
    const manifest = backupManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );
    const bytes = readFileSync(snapshotPath);
    const updated = {
      ...manifest,
      database: {
        ...manifest.database,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      completeness: {
        ...manifest.completeness,
        tables: {
          ...manifest.completeness.tables,
          dispatch_runs: manifest.completeness.tables.dispatch_runs,
        },
      },
    };
    writeFileSync(manifestPath, canonicalJson(updated));
    writeFileSync(
      join(bundle, BACKUP_MANIFEST_HASH_FILE),
      `${manifestHash(backupManifestSchema.parse(updated))}\n`,
    );

    const restored = await restore(bundle, join(root, "lineage-home"));
    const restoredDb = new DatabaseSync(join(restored.state, BACKUP_DATABASE_FILE), {
      readOnly: true,
    });
    try {
      const versions = (
        restoredDb
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{
          version: number;
        }>
      ).map((row) => row.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
      expect(
        restoredDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='child_integrations'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      restoredDb.close();
    }
    await seeded.finishActive();
  }, 30000);
});
