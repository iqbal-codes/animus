import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService } from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { PlanService } from "../../apps/backend/src/plans";
import { ChildIntegrationService } from "../../apps/backend/src/integration";
import { inventoryInstallation } from "../../apps/backend/src/cutover/inventory";
import { AuthorityCutoverService } from "../../apps/backend/src/cutover/service";
import { BackupRestoreService } from "../../apps/backend/src/restore/service";
import { GitHubWebhookService } from "../../apps/backend/src/webhooks/github";
import {
  readExecutionAuthority,
  writeExecutionAuthority,
} from "@animus/contracts/execution-authority";
import { readInstallationHold } from "@animus/contracts/installation-hold";
import { seedActivatedAuthority } from "./support/activated-authority";
import type { AgentTransport } from "../../scripts/loop/types";

const REPO = "owner/cutover-repo";

function ticketBody(): string {
  return [
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
  ].join("\n");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function committingTransport(): AgentTransport {
  return async (request) => {
    writeFileSync(join(request.cwd, "cutover-engine.txt"), "implemented\n");
    git(request.cwd, "add", "cutover-engine.txt");
    git(request.cwd, "commit", "-q", "-m", "feat: implement frozen ticket");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("authority cutover (#165)", () => {
  let root: string;
  let home: string;
  let stateDir: string;
  let checkoutPath: string;
  let forge: SyntheticForgeAdapter;
  let app: BackendApp;
  let projectId: string;
  let cutover: AuthorityCutoverService;
  let backup: BackupRestoreService;

  async function buildApp() {
    app = await createBackendApp({
      stateDir,
      startMonitor: false,
      forge,
      dispatch: { engine: { transport: committingTransport() } },
    });
    const registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    backup = new BackupRestoreService(app.db, { stateDir, forge });
    cutover = new AuthorityCutoverService(app.db, { stateDir, backup, home });
    return app;
  }

  function addIssue(number: number) {
    forge.addIssue(REPO, {
      number,
      title: `Issue ${number}`,
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
  }

  async function importPlan(issueNumber: number) {
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/plans/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue_number: issueNumber, kind: "standalone" }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string };
  }

  async function stage() {
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/v1/authority/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "operator" }),
      }),
    );
    return { response, body: (await response.json()) as any };
  }

  async function activate(operation: {
    id: string;
    inventorySha256: string;
    backupManifestSha256: string;
  }) {
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/v1/authority/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "operator",
          cutoverId: operation.id,
          inventorySha256: operation.inventorySha256,
          backupManifestSha256: operation.backupManifestSha256,
        }),
      }),
    );
    return { response, body: (await response.json()) as any };
  }

  function seedLegacyLedger() {
    const now = new Date().toISOString();
    app.db
      .prepare(
        `INSERT INTO commands
           (request_id, actor, project_id, action, target, timestamp, state, outcome,
            evidence_links, created_at, updated_at, reconciled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "cmd_legacy_1",
        "operator",
        projectId,
        "launch",
        "issue:1",
        now,
        "succeeded",
        "legacy command retained",
        "[]",
        now,
        now,
        now,
      );
    app.db
      .prepare(
        `INSERT INTO brakes (id, scope, project_id, brake_type, active, reason, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "brake_legacy_1",
        "project",
        projectId,
        "schedule_pause",
        0,
        "prior pause",
        "operator",
        now,
      );
    app.db
      .prepare(
        `INSERT INTO project_runs (id, project_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("run_legacy_1", projectId, "completed", now, now);
    app.db
      .prepare(
        `INSERT INTO project_issue_integrations
           (project_id, issue_number, branch, commit_sha, integrated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, 501, "factory/legacy", "a".repeat(40), now);
    app.db
      .prepare(
        `INSERT INTO project_spec_coordinations
           (id, project_id, spec_issue_number, is_standalone, integration_branch, base_branch,
            base_sha, current_integration_sha, status, plan_snapshot, final_pr_number,
            final_pr_url, halt_reason, halt_attribution, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "coord_legacy_1",
        projectId,
        500,
        1,
        "factory/legacy",
        "main",
        "b".repeat(40),
        "c".repeat(40),
        "halted",
        "{}",
        null,
        null,
        "operator halt",
        "operator",
        now,
        now,
      );
  }

  function sign(secret: string, raw: Buffer): string {
    return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "animus-authority-cutover-"));
    home = join(root, "animus-home");
    stateDir = join(home, "state");
    process.env.ANIMUS_HOME = home;
    process.env.ANIMUS_STATE_DIR = stateDir;
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    git(checkoutPath, "commit", "--allow-empty", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    forge = new SyntheticForgeAdapter({ [REPO]: 951 });
  });

  afterEach(async () => {
    await app?.stop();
    delete process.env.ANIMUS_HOME;
    delete process.env.ANIMUS_STATE_DIR;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    rmSync(root, { recursive: true, force: true });
  });

  test("deterministic inventory preserves real legacy identities and history", async () => {
    await buildApp();
    seedLegacyLedger();
    mkdirSync(join(stateDir, "artifacts", projectId, "evidence"), { recursive: true });
    writeFileSync(join(stateDir, "artifacts", projectId, "evidence", "legacy.log"), "proof\n");

    const first = inventoryInstallation(app.db, { stateDir });
    const second = inventoryInstallation(app.db, { stateDir });

    expect(first.stateDigest).toBe(second.stateDigest);
    expect(first.identityDigest).toBe(second.identityDigest);
    expect(first.schemaVersion).toBe(15);
    expect(first.artifacts.count).toBe(1);
    expect(first.held).toEqual([]);
    const tableNames = first.tables.map((table) => table.table);
    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("commands");
    expect(tableNames).toContain("project_issue_integrations");

    const integration = first.mappings.find(
      (mapping) => mapping.entity === "project_issue_integrations",
    );
    expect(integration).toMatchObject({
      disposition: "preserved_history",
      legacyId: integration?.newId,
    });
    const command = first.mappings.find((mapping) => mapping.entity === "commands");
    expect(command?.disposition).toBe("preserved");
    expect(command?.legacyHash).toBe(command?.newHash);
  });

  test("stage proves verified backup and held restore, activation enables local execution", async () => {
    await buildApp();
    addIssue(700);
    seedLegacyLedger();
    const plan = await importPlan(700);

    const staged = await stage();
    expect(staged.response.status).toBe(201);
    expect(staged.body.operation.status).toBe("staged");
    expect(staged.body.restore.held).toBe(true);
    expect(readExecutionAuthority().authority).toBe("migrating");
    expect(readExecutionAuthority().cutover_id).toBe(staged.body.operation.id);
    expect(existsSync(staged.body.snapshot.destinationPath)).toBe(true);

    const restoredDbPath = join(staged.body.restore.targetStateDir, "console.db");
    expect(existsSync(restoredDbPath)).toBe(true);
    const restoredDb = new DatabaseSync(restoredDbPath, { readOnly: true });
    try {
      expect(readInstallationHold(restoredDb).held).toBe(true);
      const project = restoredDb
        .prepare("SELECT id, repo_name FROM projects WHERE id = ?")
        .get(projectId) as { id: string; repo_name: string } | undefined;
      expect(project).toMatchObject({ id: projectId, repo_name: REPO });
      const command = restoredDb
        .prepare("SELECT request_id, state FROM commands WHERE request_id = ?")
        .get("cmd_legacy_1") as { request_id: string; state: string } | undefined;
      expect(command).toEqual({ request_id: "cmd_legacy_1", state: "succeeded" });
    } finally {
      restoredDb.close();
    }

    const mappings = cutover.mappings(staged.body.operation.id).mappings;
    expect(mappings.length).toBeGreaterThan(0);
    const projectMapping = mappings.find((mapping) => mapping.entity === "projects");
    expect(projectMapping?.legacyId).toBe(projectMapping?.newId);
    expect(projectMapping?.legacyHash).toBe(projectMapping?.newHash);

    const activated = await activate(staged.body.operation);
    expect(activated.response.status).toBe(200);
    expect(activated.body.status.authority).toBe("local");
    expect(activated.body.status.blockingReasons).toEqual([]);
    expect(readExecutionAuthority()).toMatchObject({
      authority: "local",
      cutover_id: staged.body.operation.id,
      phase: "active",
    });

    // The normal local dispatcher now runs against the frozen plan.
    const dispatchResponse = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.id }),
      }),
    );
    expect(dispatchResponse.status).toBe(201);
    const run = (await dispatchResponse.json()) as {
      state: string;
      head_sha: string | null;
      worktree_path: string;
    };
    expect(run.state).toBe("succeeded");
    expect(run.head_sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(readFileSync(join(run.worktree_path, "cutover-engine.txt"), "utf-8")).toContain(
      "implemented",
    );
  });

  test("a live legacy writer blocks staging and abort returns to legacy control", async () => {
    await buildApp();
    const now = new Date().toISOString();
    app.db
      .prepare(
        "INSERT INTO project_runs (id, project_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("run_active", projectId, "running", now, now);

    const staged = await stage();
    expect(staged.response.status).toBe(409);
    expect(staged.body.error).toBe("cutover_writers_active");
    expect(staged.body.details.held.length).toBe(1);
    expect(readExecutionAuthority().authority).toBe("migrating");

    const status = cutover.status();
    expect(status.held.length).toBe(1);
    expect(status.blockingReasons.some((reason) => reason.includes("live_writer"))).toBe(true);

    const abortResponse = await app.fetch(
      new Request("http://127.0.0.1/api/v1/authority/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "operator",
          reason: "quiesce the run first",
          cutoverId: status.operation?.id,
        }),
      }),
    );
    expect(abortResponse.status).toBe(200);
    expect(readExecutionAuthority().authority).toBe("legacy");
    expect(cutover.status().operation?.status).toBe("aborted");
  });

  test("restaging reuses the same operation, backup and held restore", async () => {
    await buildApp();
    const first = await stage();
    expect(first.response.status).toBe(201);

    const resumed = await stage();
    expect(resumed.response.status).toBe(201);
    expect(resumed.body.operation.id).toBe(first.body.operation.id);
    expect(resumed.body.snapshot.destinationPath).toBe(first.body.snapshot.destinationPath);
    expect(resumed.body.restore.operationId).toBe(first.body.restore.operationId);
    expect(resumed.body.inventory.stateDigest).toBe(first.body.inventory.stateDigest);
  });

  test("activation refuses drift and corrupt backups", async () => {
    await buildApp();
    const staged = await stage();
    expect(staged.response.status).toBe(201);

    app.db
      .prepare(
        "INSERT INTO brakes (id, scope, project_id, brake_type, active, reason, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "brake_drift",
        "project",
        projectId,
        "schedule_pause",
        0,
        "drift",
        "operator",
        new Date().toISOString(),
      );

    const drifted = await activate(staged.body.operation);
    expect(drifted.response.status).toBe(409);
    expect(drifted.body.error).toBe("cutover_state_changed");

    const status = cutover.status();
    expect(status.blockingReasons).toContain("installation_changed_since_staging");
    expect(readExecutionAuthority().authority).toBe("migrating");
  });

  test("corrupt staged backup blocks activation", async () => {
    await buildApp();
    const staged = await stage();
    expect(staged.response.status).toBe(201);
    writeFileSync(
      join(staged.body.snapshot.destinationPath, "manifest.json"),
      JSON.stringify({ kind: "tampered" }),
    );

    expect(backup.verifySnapshotAt(staged.body.snapshot.destinationPath).restorable).toBe(false);
    const activated = await activate(staged.body.operation);
    expect(activated.response.status).toBe(400);
    expect(activated.body.error).toBe("cutover_backup_invalid");
    expect(readExecutionAuthority().authority).toBe("migrating");
  });

  test("crash after marker write is reconciled on the next activation", async () => {
    await buildApp();
    const staged = await stage();
    expect(staged.response.status).toBe(201);
    const operation = staged.body.operation as {
      id: string;
      inventorySha256: string;
      backupManifestSha256: string;
    };

    // Simulate: marker written, process died before the operation row updated.
    writeExecutionAuthority("local", {
      expected: "migrating",
      cutoverId: operation.id,
      inventorySha256: operation.inventorySha256,
      backupManifestSha256: operation.backupManifestSha256,
      phase: "active",
    });

    const status = cutover.status();
    expect(status.blockingReasons).toContain("authority_marker_without_activated_cutover");

    const activated = await activate(operation);
    expect(activated.response.status).toBe(200);
    expect(activated.body.operation.status).toBe("activated");
    expect(activated.body.status.blockingReasons).toEqual([]);
  });

  test("crash after operation activation intent resumes and activates", async () => {
    await buildApp();
    const staged = await stage();
    expect(staged.response.status).toBe(201);
    app.db
      .prepare("UPDATE authority_cutover_operations SET status = 'activating' WHERE id = ?")
      .run(staged.body.operation.id);

    const activated = await activate(staged.body.operation);
    expect(activated.response.status).toBe(200);
    expect(readExecutionAuthority().authority).toBe("local");
    expect(activated.body.operation.status).toBe("activated");
  });

  test("activation requires the exact staged evidence", async () => {
    await buildApp();
    const staged = await stage();
    const response = await app.fetch(
      new Request("http://127.0.0.1/api/v1/authority/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "operator",
          cutoverId: staged.body.operation.id,
          inventorySha256: "0".repeat(64),
          backupManifestSha256: staged.body.operation.backupManifestSha256,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("cutover_expected_mismatch");
    expect(readExecutionAuthority().authority).toBe("migrating");
  });

  test("abort after activation is refused; rollback requires a validated restore", async () => {
    await buildApp();
    const staged = await stage();
    const activated = await activate(staged.body.operation);
    expect(activated.response.status).toBe(200);

    const abortResponse = await app.fetch(
      new Request("http://127.0.0.1/api/v1/authority/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "operator",
          reason: "try to revert",
          cutoverId: staged.body.operation.id,
        }),
      }),
    );
    expect(abortResponse.status).toBe(409);
    expect(((await abortResponse.json()) as { error: string }).error).toBe(
      "cutover_already_active",
    );
    expect(readExecutionAuthority().authority).toBe("local");
  });

  test("external writers fail closed while the authority is migrating", async () => {
    await buildApp();
    const staged = await stage();
    expect(staged.response.status).toBe(201);
    expect(readExecutionAuthority().authority).toBe("migrating");

    // Read surfaces stay usable during the fence.
    const statusRes = await app.fetch(new Request("http://127.0.0.1/api/v1/authority"));
    expect(statusRes.status).toBe(200);
    expect(((await statusRes.json()) as { authority: string }).authority).toBe("migrating");

    // Route preflight refuses every scoped external writer with a stable 409.
    for (const action of [
      "publication/reconcile",
      "integration/land",
      "draft-publications",
      "delivery/verify-merge",
      "final/advance",
    ]) {
      const response = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${projectId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(
        "execution_authority_moving",
      );
    }

    // Internal callers (final -> integration/publication, dispatch -> publication)
    // are fenced by the same shared service guard, not only the HTTP layer.
    const gate = { code: "execution_authority_moving" };
    await expect(app.publication.reconcileAll(projectId)).rejects.toMatchObject(gate);
    await expect(app.publication.publish(projectId, "missing-target")).rejects.toMatchObject(gate);
    await expect(
      app.draftPublication.publishDraft(projectId, "missing-draft"),
    ).rejects.toMatchObject(gate);
    await expect(app.draftPublication.reconcileAll(projectId)).rejects.toMatchObject(gate);
    await expect(app.delivery.verifyMerge(projectId, "missing-run")).rejects.toMatchObject(gate);
    await expect(app.final.advance(projectId, "missing-plan")).rejects.toMatchObject(gate);
    await expect(app.final.verifyMerge(projectId, "missing-plan")).rejects.toMatchObject(gate);
    await expect(
      app.final.dispatchCorrection({
        projectId,
        runId: "missing-run",
        deliveryId: "missing-delivery",
        planId: "missing-plan",
        workId: "missing-work",
        actor: "operator",
        findings: [],
      }),
    ).rejects.toMatchObject(gate);
    const integration = new ChildIntegrationService(app.db, {
      observations: new ExecutionObservationService(app.db),
      publication: app.publication,
      forge,
    });
    await expect(integration.land(projectId, "missing-run")).rejects.toMatchObject(gate);

    // Abort returns to legacy so the pre-cutover legacy writers remain supported.
    const operation = staged.body.operation as { id: string };
    const aborted = await app.fetch(
      new Request("http://127.0.0.1/api/v1/authority/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "operator",
          reason: "restore legacy",
          cutoverId: operation.id,
        }),
      }),
    );
    expect(aborted.status).toBe(200);
    expect(readExecutionAuthority().authority).toBe("legacy");
    // Legacy publication remains callable before cutover (no publication target => empty).
    await expect(app.publication.reconcileAll(projectId)).resolves.toEqual([]);
  });

  test("post-activation GitHub manual feedback never mutates accepted work", async () => {
    await buildApp();
    addIssue(701);
    const plan = await importPlan(701);
    const staged = await stage();
    const activated = await activate(staged.body.operation);
    expect(activated.response.status).toBe(200);

    const registry = new ProjectRegistryService(app.db, forge);
    const webhooks = new GitHubWebhookService(registry, {
      secret: "test-secret",
      authority: () => readExecutionAuthority().authority,
    });

    const before = {
      revisions: (
        app.db.prepare("SELECT COUNT(*) AS count FROM work_revisions").get() as { count: number }
      ).count,
      decisions: (
        app.db.prepare("SELECT COUNT(*) AS count FROM plan_decisions").get() as { count: number }
      ).count,
      findings: (
        app.db.prepare("SELECT COUNT(*) AS count FROM factory_findings").get() as { count: number }
      ).count,
      plans: (app.db.prepare("SELECT COUNT(*) AS count FROM plans").get() as { count: number })
        .count,
    };
    const planBefore = app.db.prepare("SELECT * FROM plans WHERE id = ?").get(plan.id);

    const issueEdit = Buffer.from(
      JSON.stringify({
        action: "edited",
        issue: { number: 701 },
        repository: { id: 951, full_name: REPO },
      }),
    );
    const editResponse = await webhooks.handleWebhook(
      new Request("http://127.0.0.1/api/v1/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-edit-1",
          "x-hub-signature-256": sign("test-secret", issueEdit),
        },
        body: issueEdit,
      }),
    );
    expect(editResponse.status).toBe(202);
    expect(((await editResponse.json()) as { reason: string }).reason).toBe(
      "manual_feedback_ignored",
    );

    const review = Buffer.from(
      JSON.stringify({
        action: "submitted",
        pull_request: { number: 1 },
        repository: { id: 951, full_name: REPO },
      }),
    );
    const reviewResponse = await webhooks.handleWebhook(
      new Request("http://127.0.0.1/api/v1/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-event": "pull_request_review",
          "x-github-delivery": "delivery-review-1",
          "x-hub-signature-256": sign("test-secret", review),
        },
        body: review,
      }),
    );
    expect(reviewResponse.status).toBe(202);
    expect(((await reviewResponse.json()) as { reason: string }).reason).toBe(
      "manual_feedback_ignored",
    );

    const after = {
      revisions: (
        app.db.prepare("SELECT COUNT(*) AS count FROM work_revisions").get() as { count: number }
      ).count,
      decisions: (
        app.db.prepare("SELECT COUNT(*) AS count FROM plan_decisions").get() as { count: number }
      ).count,
      findings: (
        app.db.prepare("SELECT COUNT(*) AS count FROM factory_findings").get() as { count: number }
      ).count,
      plans: (app.db.prepare("SELECT COUNT(*) AS count FROM plans").get() as { count: number })
        .count,
    };
    expect(after).toEqual(before);
    expect(app.db.prepare("SELECT * FROM plans WHERE id = ?").get(plan.id)).toEqual(planBefore);

    const ci = Buffer.from(
      JSON.stringify({
        action: "completed",
        check_run: { conclusion: "success" },
        repository: { id: 951, full_name: REPO },
      }),
    );
    const ciResponse = await webhooks.handleWebhook(
      new Request("http://127.0.0.1/api/v1/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-event": "check_run",
          "x-github-delivery": "delivery-ci-1",
          "x-hub-signature-256": sign("test-secret", ci),
        },
        body: ci,
      }),
    );
    expect(ciResponse.status).toBe(202);
    expect(((await ciResponse.json()) as { status: string }).status).toBe("accepted");
  });

  test("a realistic populated installation preserves evidence through the held restore", async () => {
    await buildApp();
    addIssue(702);
    const plan = await importPlan(702);
    // Seed a genuinely activated authority so the real DB-verified dispatch path
    // can create the pre-cutover run. It is reset to legacy below to represent an
    // installation that already owns that run before the cutover is staged.
    const seededAuthority = seedActivatedAuthority(app.db, { stateDir });
    const dispatch = new DispatchService(app.db, {
      plans: new PlanService(app.db, forge),
      ledger: new CommandLedger(app.db),
      brakes: new BrakeService(app.db),
      runner: async (context) => {
        writeFileSync(join(context.worktree_path, "evidence.txt"), "verified\n");
        git(context.worktree_path, "add", "evidence.txt");
        git(context.worktree_path, "commit", "-q", "-m", "candidate evidence");
        return {
          success: true,
          headSha: git(context.worktree_path, "rev-parse", "HEAD"),
        };
      },
    });
    const run = await dispatch.dispatch(projectId, { plan_id: plan.id, actor: "operator" });
    expect(run.state).toBe("succeeded");

    const observations = new ExecutionObservationService(app.db);
    const reviewer = observations.registerTrustedProducer(projectId, {
      id: "cutover-reviewer",
      role: "peer_reviewer",
    });
    const artifactRelative = "review/cutover.log";
    mkdirSync(join(stateDir, "artifacts", projectId, "review"), { recursive: true });
    writeFileSync(join(stateDir, "artifacts", projectId, artifactRelative), "retained proof\n");
    observations.recordRunObservation(projectId, run.id, {
      stage: "independent_review",
      status: "failed",
      producer: reviewer.producer,
      checks: [{ name: "review", command: "review", result: "FAIL", detail: "needs work" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "evidence.txt:1",
          summary: "cutover blocking finding",
        },
      ],
      artifacts: [
        {
          ownerType: "finding",
          ownerFindingIndex: 0,
          name: "cutover review log",
          relativePath: artifactRelative,
          mediaType: "text/plain",
        },
      ],
    });

    // Return the installation to pre-cutover legacy control: the run/evidence
    // are real legacy data that the cutover must inventory and preserve.
    app.db
      .prepare("DELETE FROM authority_cutover_operations WHERE id = ?")
      .run(seededAuthority.cutoverId);
    writeExecutionAuthority("legacy", { stateDir, expected: "local", phase: null });

    const staged = await stage();
    expect(staged.response.status).toBe(201);
    expect(staged.body.inventory.artifacts.count).toBe(1);
    expect(staged.body.inventory.held).toEqual([]);

    const restoredArtifact = join(
      staged.body.restore.targetStateDir,
      "artifacts",
      projectId,
      artifactRelative,
    );
    expect(existsSync(restoredArtifact)).toBe(true);
    expect(readFileSync(restoredArtifact, "utf-8")).toBe("retained proof\n");

    const activated = await activate(staged.body.operation);
    expect(activated.response.status).toBe(200);
    const reviewArtifact = app.db
      .prepare("SELECT relative_path, digest_sha256 FROM execution_artifacts WHERE project_id = ?")
      .get(projectId) as { relative_path: string; digest_sha256: string } | undefined;
    expect(reviewArtifact?.relative_path).toBe(artifactRelative);
    expect(readFileSync(join(stateDir, "artifacts", projectId, artifactRelative), "utf-8")).toBe(
      "retained proof\n",
    );
  });

  test("a marker lock that never links fails closed instead of returning unheld (F4)", () => {
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, ".execution-authority.lock");
    // A dangling symlink makes link(2) fail EEXIST while the owner read sees ENOENT:
    // exactly the pathological interleaving that used to fall through as a held lock.
    symlinkSync(join(root, "missing-lock-owner.json"), lockPath);
    expect(() => writeExecutionAuthority("local", { stateDir })).toThrow(
      /could not be acquired|unreadable ownership/,
    );
    expect(existsSync(join(stateDir, "execution-authority.json"))).toBe(false);

    rmSync(lockPath, { force: true });
    expect(writeExecutionAuthority("local", { stateDir }).authority).toBe("local");
  });
  test("activation status CAS refuses to overwrite a competing terminal writer", async () => {
    await buildApp();
    const staged = await stage();
    expect(staged.response.status).toBe(201);
    const operation = staged.body.operation as {
      id: string;
      inventorySha256: string;
      backupManifestSha256: string;
    };

    // Simulate an external writer moving the durable row to a terminal state in
    // the window between the activation's read and its terminal UPDATE. The
    // injected `now` seam is the same boundary a concurrent abort races at.
    let flipped = false;
    const racing = new AuthorityCutoverService(app.db, {
      stateDir,
      backup,
      home,
      now: () => {
        const row = app.db
          .prepare("SELECT status FROM authority_cutover_operations WHERE id = ?")
          .get(operation.id) as { status: string } | undefined;
        if (!flipped && row?.status === "activating") {
          flipped = true;
          app.db
            .prepare(
              "UPDATE authority_cutover_operations SET status = 'aborted' WHERE id = ? AND status = 'activating'",
            )
            .run(operation.id);
        }
        return Date.now();
      },
    });

    let error: unknown;
    try {
      await racing.activate({
        actor: "operator",
        cutoverId: operation.id,
        inventorySha256: operation.inventorySha256,
        backupManifestSha256: operation.backupManifestSha256,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "cutover_inconsistent" });

    const row = app.db
      .prepare("SELECT status FROM authority_cutover_operations WHERE id = ?")
      .get(operation.id) as { status: string };
    expect(row.status).toBe("aborted");
    // Activation never reached the local marker write.
    expect(readExecutionAuthority(stateDir).authority).toBe("migrating");
  }, 60_000);

  test("abort status CAS never pairs a legacy marker with an activated row", async () => {
    await buildApp();
    const staged = await stage();
    const operation = staged.body.operation as {
      id: string;
      inventorySha256: string;
      backupManifestSha256: string;
    };

    // Simulate an activation that has already won the durable row at the abort
    // boundary. Abort must fence the row first and refuse, so it can never write
    // a `legacy` marker over an `activated` row.
    let flipped = false;
    const racing = new AuthorityCutoverService(app.db, {
      stateDir,
      backup,
      home,
      now: () => {
        const row = app.db
          .prepare("SELECT status FROM authority_cutover_operations WHERE id = ?")
          .get(operation.id) as { status: string } | undefined;
        if (!flipped && row?.status === "staged") {
          flipped = true;
          app.db
            .prepare(
              "UPDATE authority_cutover_operations SET status = 'activated' WHERE id = ? AND status = 'staged'",
            )
            .run(operation.id);
        }
        return Date.now();
      },
    });

    let error: unknown;
    try {
      await racing.abort({
        actor: "operator",
        reason: "race with activation",
        cutoverId: operation.id,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "cutover_inconsistent" });

    const row = app.db
      .prepare("SELECT status FROM authority_cutover_operations WHERE id = ?")
      .get(operation.id) as { status: string };
    expect(row.status).toBe("activated");
    // The winning activation was not demoted to a legacy marker.
    expect(readExecutionAuthority(stateDir).authority).toBe("migrating");
  }, 60_000);
});
