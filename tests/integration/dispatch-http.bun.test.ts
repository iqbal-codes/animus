import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@animus/client";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { runPlanCommand } from "../../scripts/cli/commands/operations";

const REPO = "owner/repo";

function ticketBody(
  options: { partOf?: number; coverage?: string; criteria?: string[] } = {},
): string {
  const lines: string[] = [];
  if (options.partOf) lines.push(`Part of #${options.partOf}`, "");
  if (options.coverage) lines.push(`Source acceptance coverage: ${options.coverage}`, "");
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
    ...(options.criteria ?? ["AC1: prepared criterion"]).map((line) => `- [ ] ${line}`),
    "",
    "## Boundary",
    "",
    "Prepared ticket boundary.",
    "",
    "Depends on: None",
  );
  return lines.join("\n");
}

async function captureLogs(run: () => Promise<number>): Promise<{ code: number; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const code = await run();
    return { code, logs };
  } finally {
    console.log = original;
  }
}

describe("local dispatch through backend, client and CLI", () => {
  let root: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
  let projectId: string;
  let checkoutPath: string;

  function backendFetch(application: BackendApp) {
    return async (input: string, init?: RequestInit) => application.fetch(new Request(input, init));
  }

  function commitInWorktree(worktreePath: string): string {
    writeFileSync(join(worktreePath, "dispatch.txt"), "implemented\n");
    execFileSync("git", ["add", "dispatch.txt"], { cwd: worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "implement"], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-dispatch-http-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    execFileSync("git", [
      "-C",
      checkoutPath,
      "remote",
      "add",
      "origin",
      `https://github.com/${REPO}.git`,
    ]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", checkoutPath, "commit", "--allow-empty", "-q", "-m", "base"]);
    execFileSync("git", ["-C", checkoutPath, "branch", "-M", "main"]);

    forge = new SyntheticForgeAdapter({ [REPO]: 913 });
    forge.addIssue(REPO, {
      number: 500,
      title: "Standalone delivery",
      body: ticketBody({}),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: 501,
      title: "Standalone failure",
      body: ticketBody({}),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });

    app = await createBackendApp({
      stateDir: join(root, "state"),
      startMonitor: false,
      forge,
      dispatch: {
        processAlive: () => true,
        ownerPid: () => 4242,
        runner: async (context) => {
          if (context.issue_number === 501) {
            return { success: false, error: "offline model transport refused" };
          }
          return { success: true, headSha: commitInWorktree(context.worktree_path) };
        },
      },
    });
    const registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    await app.stop();
    delete process.env.ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  async function importPlan(issueNumber: number, kind: "standalone" | "spec") {
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/plans/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue_number: issueNumber, kind }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      id: string;
      accepted_revision: { revision_id: string; content_hash: string } | null;
      members: Array<{ issue_number: number; revision_id: string }>;
    };
  }

  test("HTTP/client/CLI dispatch a frozen plan and expose real run, owner and revision state", async () => {
    const plan = await importPlan(500, "standalone");
    const payload = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: plan.id, actor: "operator" }),
    };

    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/dispatch`, payload),
    );
    expect(response.status).toBe(201);
    const run = (await response.json()) as {
      id: string;
      state: string;
      issue_number: number;
      revision_id: string;
      content_hash: string;
      owner_pid: number | null;
      command_request_id: string;
      gate_profile: string;
      target_branch: string;
      head_sha: string | null;
    };
    expect(run.state).toBe("succeeded");
    expect(run.issue_number).toBe(500);
    expect(run.revision_id).toBe(plan.accepted_revision!.revision_id);
    expect(run.content_hash).toBe(plan.accepted_revision!.content_hash);
    expect(run.owner_pid).toBe(4242);
    expect(run.gate_profile).toBe("standalone");
    expect(run.target_branch).toBe("main");
    expect(run.head_sha).toBeTruthy();

    const commandResponse = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/commands/${run.command_request_id}`,
      ),
    );
    expect(commandResponse.status).toBe(200);
    const command = (await commandResponse.json()) as { state: string };
    expect(command.state).toBe("succeeded");

    const listResponse = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/dispatch/runs?plan_id=${encodeURIComponent(plan.id)}`,
      ),
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as Array<{ id: string; state: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: run.id, state: "succeeded" });

    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: backendFetch(app),
    });
    const scoped = client.forProject(projectId);
    const clientRun = await scoped.dispatchRun(run.id);
    expect(clientRun.owner_pid).toBe(4242);
    expect(clientRun.revision_id).toBe(run.revision_id);
    const clientRuns = await scoped.dispatchRuns({ planId: plan.id });
    expect(clientRuns.map((item) => item.id)).toEqual([run.id]);

    const cliRuns = await captureLogs(() =>
      runPlanCommand({
        subcommand: "runs",
        positionals: ["plan", "runs", plan.id],
        projectId,
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(cliRuns.code).toBe(0);
    const parsed = JSON.parse(cliRuns.logs.join("\n")) as Array<{
      id: string;
      state: string;
      owner_pid: number;
    }>;
    expect(parsed[0]).toMatchObject({ id: run.id, state: "succeeded", owner_pid: 4242 });

    const humanRun = await captureLogs(() =>
      runPlanCommand({
        subcommand: "run",
        positionals: ["plan", "run", run.id],
        projectId,
        fetch: backendFetch(app),
      }),
    );
    expect(humanRun.code).toBe(0);
    const output = humanRun.logs.join("\n");
    expect(output).toContain(run.id);
    expect(output).toContain(`Revision:  ${run.revision_id}`);
    expect(output).toContain("Owner:     4242");
    expect(output).toContain("succeeded");
  });

  test("CLI dispatch launches the local frozen plan and prints the real run state", async () => {
    forge.addIssue(REPO, {
      number: 503,
      title: "CLI delivery",
      body: ticketBody({}),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    const plan = await importPlan(503, "standalone");

    const result = await captureLogs(() =>
      runPlanCommand({
        subcommand: "dispatch",
        positionals: ["plan", "dispatch", plan.id],
        projectId,
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(result.code).toBe(0);
    const run = JSON.parse(result.logs.join("\n")) as {
      id: string;
      state: string;
      issue_number: number;
      revision_id: string;
      owner_pid: number;
      command_request_id: string;
    };
    expect(run.state).toBe("succeeded");
    expect(run.issue_number).toBe(503);
    expect(run.revision_id).toBe(plan.accepted_revision!.revision_id);
    expect(run.owner_pid).toBe(4242);

    const human = await captureLogs(() =>
      runPlanCommand({
        subcommand: "run",
        positionals: ["plan", "run", run.id],
        projectId,
        fetch: backendFetch(app),
      }),
    );
    expect(human.code).toBe(0);
    expect(human.logs.join("\n")).toContain("succeeded");
  });

  test("HTTP exposes failure state and dispatches never return success for a failed runner", async () => {
    const plan = await importPlan(501, "standalone");
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.id }),
      }),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("dispatch_failed");

    const listResponse = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/dispatch/runs`),
    );
    const runs = (await listResponse.json()) as Array<{
      id: string;
      state: string;
      error: string | null;
      command_request_id: string;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("failed");
    expect(runs[0]!.error).toContain("offline model transport refused");

    const command = app.db
      .prepare("SELECT state FROM commands WHERE request_id = ?")
      .get(runs[0]!.command_request_id) as { state: string };
    expect(command.state).toBe("failed");
  });

  test("HTTP refuses a held plan and exposes precise holds", async () => {
    forge.addIssue(REPO, {
      number: 502,
      title: "Spec without children",
      body: [
        "## Source and problem",
        "",
        "Spec source.",
        "",
        "## Outcome",
        "",
        "Spec outcome.",
        "",
        "## Invariants",
        "",
        "- planning only",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] AC1 — orphan",
        "",
        "## Boundary",
        "",
        "Spec boundary.",
      ].join("\n"),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });
    const plan = await importPlan(502, "spec");
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.id }),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: string;
      details?: { holds?: Array<{ code: string }> };
    };
    expect(body.error).toBe("plan_not_dispatchable");
    expect(body.details?.holds?.map((hold) => hold.code)).toContain("incomplete_child_discovery");
  });
});
