import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { handleProjectDeliveryRoute } from "../../apps/backend/src/delivery/routes";
import { runCli } from "../../scripts/cli/cli";
import { seedActivatedAuthority } from "./support/activated-authority";

const RUN_ID = "run-cli-claim";

/**
 * The CLI must drive the real backend HTTP surface (never shell into the DB), so
 * this starts the actual delivery route handler and exercises `animus plan
 * claims` / `plan claim-interrupt` end to end.
 */
describe("CLI delivery claim controls use the backend API", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let server: Server;
  let baseUrl: string;
  let projectId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-cli-claim-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    process.env.ANIMUS_STATE_DIR = join(root, "animus-home", "state");
    db = initializeDatabase(join(root, "state", "console.db"));
    seedActivatedAuthority(db);
    const now = Date.now();
    const forge = new SyntheticForgeAdapter({ "owner/repo": 1 });
    const registry = new ProjectRegistryService(db, forge);
    const checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    execFileSync("git", [
      "-C",
      checkoutPath,
      "remote",
      "add",
      "origin",
      "https://github.com/owner/repo.git",
    ]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.name", "Test"]);
    writeFileSync(join(checkoutPath, "base.txt"), "base\n");
    execFileSync("git", ["-C", checkoutPath, "add", "base.txt"]);
    execFileSync("git", ["-C", checkoutPath, "commit", "-q", "-m", "base"]);
    execFileSync("git", ["-C", checkoutPath, "branch", "-M", "main"]);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    db.exec("PRAGMA foreign_keys = OFF;");
    // Seed the run + an interrupted, owner-unverified claim that must be reclaimable.
    db.prepare(
      `INSERT INTO deliveries
         (id, project_id, plan_id, kind, delivery_branch, integration_branch, final_pr_base,
          merge_policy_child, merge_policy_standalone, merge_policy_final, manifest_id, graph_hash,
          created_at, updated_at)
       VALUES ('del-cli', ?, 'plan-cli', 'standalone', 'delivery/cli', 'factory/spec-151-integration',
               'main', 'auto_after_gates', 'manual', 'manual', 'manifest_cli', ?, ?, ?)`,
    ).run(project.id, "a".repeat(64), now, now);
    db.prepare(
      `INSERT INTO dispatch_runs
         (id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash, issue_number,
          role, gate_profile, merge_policy, target_branch, ownership_generation, state, actor,
          command_request_id, branch, worktree_path, base_sha, owner_pid, owner_token,
          lease_expires_at, head_sha, error, launched_at, finished_at, created_at, updated_at)
       VALUES (?, ?, 'del-cli', 'plan-cli', 'work-cli', 'rev-cli', ?, 1, 'ticket', 'child',
               'auto_after_gates', 'main', 1, 'succeeded', 'monitor', 'cmd', 'b', '/tmp/wt',
               ?, NULL, 'tok', NULL, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(RUN_ID, project.id, "a".repeat(64), "a".repeat(40), "a".repeat(40), now, now);
    db.prepare(
      `INSERT INTO delivery_role_claims
         (id, project_id, delivery_id, run_id, lap, stage, candidate_head_sha, attempt_key,
          claim_token, claim_generation, owner_pid, owner_process_start, role_pid, role_pgid,
          role_process_start, lease_expires_at, heartbeat_at, state, result_observation_id, error,
          disposition, disposition_reason, disposition_owner_probe, resolved_at, created_at, updated_at)
       VALUES ('claim-cli', ?, 'del-cli', ?, 1, 'final_acceptance', ?, 'final_acceptance:claim:x',
               'token', 3, 999999, 'dead-start', NULL, NULL, NULL, 0, ?, 'interrupted', NULL,
               'frozen', 'frozen_unknown_owner', 'operator_frozen_unknown_owner', 'dead', NULL, ?, ?)`,
    ).run(project.id, RUN_ID, "a".repeat(40), now, now, now);
    db.exec("PRAGMA foreign_keys = ON;");

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const match = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/delivery\/(.*)$/);
      if (!match) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      });
      const parts = [decodeURIComponent(match[1]!), "delivery", ...match[2]!.split("/")];
      const response = await handleProjectDeliveryRoute(
        request,
        decodeURIComponent(match[1]!),
        parts,
        {} as never,
        db,
      );
      if (!response) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.FACTORY_URL = baseUrl;
  });

  afterEach(() => {
    server.close();
    delete process.env.FACTORY_URL;
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  test("plan claims lists the durable claim through the backend", async () => {
    const code = await runCli([
      "plan",
      "claims",
      RUN_ID,
      "--project",
      projectId,
      "--factory-url",
      baseUrl,
      "--json",
    ]);
    expect(code).toBe(0);
  });

  test("plan claim-interrupt releases a proven-dead claim through the backend", async () => {
    const code = await runCli([
      "plan",
      "claim-interrupt",
      RUN_ID,
      "--project",
      projectId,
      "--stage",
      "final_acceptance",
      "--lap",
      "1",
      "--expected-generation",
      "3",
      "--expected-state",
      "interrupted",
      "--reason",
      "coordinator and role are proven dead",
      "--factory-url",
      baseUrl,
      "--json",
    ]);
    expect(code).toBe(0);
    const row = db
      .prepare(
        "SELECT state, disposition, owner_pid, claim_generation FROM delivery_role_claims WHERE id = 'claim-cli'",
      )
      .get() as {
      state: string;
      disposition: string;
      owner_pid: number | null;
      claim_generation: number;
    };
    expect(row.state).toBe("interrupted");
    expect(row.disposition).toBe("released_dead_owner");
    expect(row.owner_pid).toBeNull();
    expect(row.claim_generation).toBe(4);
    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM delivery_role_claim_audit WHERE claim_id = 'claim-cli'")
      .get() as { c: number };
    expect(audit.c).toBe(1);
  });

  test("plan claim-interrupt refuses a stale generation without mutating the claim", async () => {
    const code = await runCli([
      "plan",
      "claim-interrupt",
      RUN_ID,
      "--project",
      projectId,
      "--stage",
      "final_acceptance",
      "--lap",
      "1",
      "--expected-generation",
      "9",
      "--reason",
      "operator reviewed the frozen role",
      "--factory-url",
      baseUrl,
      "--json",
    ]);
    expect(code).toBe(1);
    const row = db
      .prepare("SELECT state, claim_generation FROM delivery_role_claims WHERE id = 'claim-cli'")
      .get() as { state: string; claim_generation: number };
    expect(row.state).toBe("interrupted");
    expect(row.claim_generation).toBe(3);
  });
});
