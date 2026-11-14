import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@animus/client";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { seedActivatedAuthority } from "./support/activated-authority";

describe("factory engine control and new job creation through HTTP & client", () => {
  let root: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
  let localCheckout: string;
  let localProjectId: string;

  function backendFetch(application: BackendApp) {
    return async (input: string, init?: RequestInit) => application.fetch(new Request(input, init));
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-engine-new-job-"));
    localCheckout = join(root, "local-repo");
    mkdirSync(localCheckout, { recursive: true });
    execFileSync("git", ["init", "-q", localCheckout]);
    execFileSync("git", ["-C", localCheckout, "config", "user.email", "test@animus.local"]);
    execFileSync("git", ["-C", localCheckout, "config", "user.name", "Animus Test"]);
    execFileSync("git", ["-C", localCheckout, "commit", "--allow-empty", "-q", "-m", "init"]);

    forge = new SyntheticForgeAdapter({ "owner/repo": 777 });
    const stateDir = join(root, "state");
    app = await createBackendApp({
      stateDir,
      startMonitor: false,
      forge,
    });
    seedActivatedAuthority(app.db, { stateDir });

    const registry = new ProjectRegistryService(app.db, forge);
    const localProject = await registry.registerProject({
      method: "local_checkout",
      name: "Local Playground",
      checkout_path: localCheckout,
    });
    expect(localProject.repo_id).toBe(0);
    localProjectId = localProject.id;
  });

  afterEach(async () => {
    if (app) await app.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1: GET and POST /api/v1/engine transition between running, paused and stopped cleanly", async () => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: backendFetch(app),
    });

    const initial = await client.engineState();
    expect(initial.mode).toBe("running");
    expect(initial.global_launch_brake).toBe(false);
    expect(initial.schedule_pause).toBe(false);
    expect(initial.active_runs).toBe(0);

    const paused = await client.setEngineState({
      mode: "paused",
      actor: "operator-test",
      reason: "Drain current runs",
    });
    expect(paused.mode).toBe("paused");
    expect(paused.schedule_pause).toBe(true);
    expect(paused.global_launch_brake).toBe(false);
    expect(paused.active_runs).toBe(0);

    const resumed = await client.setEngineState({
      mode: "running",
      actor: "operator-test",
      reason: "Resume factory",
    });
    expect(resumed.mode).toBe("running");
    expect(resumed.schedule_pause).toBe(false);
    expect(resumed.global_launch_brake).toBe(false);
  });

  test("AC2: switching engine to stopped activates launch brake and stops active AI runs", async () => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: backendFetch(app),
    });

    const now = Date.now();
    const sha = execFileSync("git", ["-C", localCheckout, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    const contentHash = "a".repeat(64);
    const workId = "wrk_active_1";
    const revisionId = "rev_active_1";
    const planId = "pln_active_1";
    const manifestId = "man_active_1";
    const deliveryId = "dlv_active_1";
    const runId = "run_active_1";

    app.db
      .prepare(
        `INSERT INTO work_items (
          id, project_id, repo_id, repo_name, issue_number, created_at, updated_at
        ) VALUES (?, ?, 777, 'owner/repo', 99, ?, ?)`,
      )
      .run(workId, localProjectId, now, now);

    app.db
      .prepare(
        `INSERT INTO work_revisions (
          id, work_id, project_id, revision_number, content_hash, source_title,
          source_body, source_state, source_labels, source_comments, source_url, provenance, imported_at
        ) VALUES (?, ?, ?, 1, ?, 'Active AI task', 'Running process', 'OPEN', '["ready-for-agent"]', '[]', 'https://github.com/owner/repo/issues/99', '{}', ?)`,
      )
      .run(revisionId, workId, localProjectId, contentHash, now);

    app.db
      .prepare(
        `INSERT INTO plans (
          id, project_id, kind, root_work_id, root_revision_id, graph_hash, evidence_hash,
          delivery_branch, integration_branch, created_at, updated_at
        ) VALUES (?, ?, 'standalone', ?, ?, ?, ?, 'animus/issue-99', NULL, ?, ?)`,
      )
      .run(planId, localProjectId, workId, revisionId, contentHash, contentHash, now, now);

    app.db
      .prepare(
        `INSERT INTO plan_manifests (
          id, plan_id, project_id, graph_hash, manifest, created_at
        ) VALUES (?, ?, ?, ?, '{}', ?)`,
      )
      .run(manifestId, planId, localProjectId, contentHash, now);

    app.db
      .prepare(
        `INSERT INTO deliveries (
          id, project_id, plan_id, kind, delivery_branch, integration_branch, final_pr_base,
          merge_policy_child, merge_policy_standalone, merge_policy_final, manifest_id, graph_hash,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'standalone', 'animus/issue-99', NULL, 'main', 'manual', 'manual', 'manual', ?, ?, ?, ?)`,
      )
      .run(deliveryId, localProjectId, planId, manifestId, contentHash, now, now);

    app.db
      .prepare(
        `INSERT INTO dispatch_runs (
          id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash,
          issue_number, role, gate_profile, merge_policy, target_branch, ownership_generation,
          state, actor, command_request_id, branch, worktree_path, base_sha,
          owner_pid, owner_token, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 99, 'ticket', 'standalone', 'manual', 'main', 1, 'running', 'scheduler', 'cmd_1', 'animus/issue-99', ?, ?, ?, 'tok_active_1', ?, ?)`,
      )
      .run(
        runId,
        localProjectId,
        deliveryId,
        planId,
        workId,
        revisionId,
        contentHash,
        localCheckout,
        sha,
        null,
        now,
        now,
      );

    const beforeStop = await client.engineState();
    expect(beforeStop.mode).toBe("running");
    expect(beforeStop.active_runs).toBe(1);

    const stopped = await client.setEngineState({
      mode: "stopped",
      actor: "operator-test",
      reason: "Emergency stop",
    });

    expect(stopped.mode).toBe("stopped");
    expect(stopped.global_launch_brake).toBe(true);
    expect(stopped.stopped_runs).toBe(1);
    expect(stopped.failed_runs).toBe(0);

    const controlRow = app.db
      .prepare("SELECT status FROM execution_controls WHERE project_id = ? AND work_id = ?")
      .get(localProjectId, workId) as { status: string } | undefined;
    expect(controlRow).toBeDefined();
    expect(["stopping", "stopped"]).toContain(controlRow!.status);
  });

  test("AC3: engine route rejects invalid payloads (400) and unsupported HTTP methods (405)", async () => {
    const badMode = await app.fetch(
      new Request("http://127.0.0.1/api/v1/engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "turbo" }),
      }),
    );
    expect(badMode.status).toBe(400);

    const wrongMethod = await app.fetch(
      new Request("http://127.0.0.1/api/v1/engine", {
        method: "DELETE",
      }),
    );
    expect(wrongMethod.status).toBe(405);
  });

  test("AC4: publishTicket creates .animus/issues/*.md on local-only repositories and appears on board", async () => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: backendFetch(app),
    });

    const createdTriage = await client.forProject(localProjectId).publishTicket({
      title: 'Fix auth: edge "case"',
      body: "Reproduce steps for local issue",
      labels: ["needs-triage"],
    });

    expect(createdTriage.issue.number).toBe(1);
    expect(createdTriage.issue.title).toBe('Fix auth: edge "case"');
    expect(createdTriage.issue.labels).toContain("needs-triage");

    const issuesDir = join(localCheckout, ".animus", "issues");
    expect(existsSync(issuesDir)).toBe(true);
    const files = readdirSync(issuesDir);
    expect(files).toHaveLength(1);
    const fileBody = readFileSync(join(issuesDir, files[0]!), "utf-8");
    expect(fileBody).toContain('# Fix auth: edge "case"');
    expect(fileBody).toContain("needs-triage");

    const createdReady = await client.forProject(localProjectId).publishTicket({
      title: "Implement metrics endpoint",
      body: "Expose /metrics JSON",
      labels: ["ready-for-agent"],
    });
    expect(createdReady.issue.number).toBe(2);
    expect(createdReady.issue.labels).toContain("ready-for-agent");

    const board = await client.forProject(localProjectId).board();
    const triageLane = board.lanes.find((l) => l.id === "triage");
    expect(triageLane?.cards.some((c) => c.title === 'Fix auth: edge "case"')).toBe(true);
    const readyCard = triageLane?.cards.find((c) => c.title === "Implement metrics endpoint");
    expect(readyCard).toBeDefined();

    const detail = await client.forProject(localProjectId).workDetail(readyCard!.workId);
    expect(detail.contract.labels).toContain("ready-for-agent");

    const emptyTitleRes = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${localProjectId}/intake/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "   ", body: "ignored" }),
      }),
    );
    expect(emptyTitleRes.status).toBe(400);
  });
});
