import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { readExecutionAuthority, writeExecutionAuthority } from "../../apps/backend/src/dispatch";
import { loadMonitorRuntime } from "../../apps/backend/src/monitor/runtime";
import { runSchedulerCliCommand } from "../../scripts/cli/commands/loop";
import type { AgentTransport } from "../../scripts/loop/types";

const REPO = "owner/repo";

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

/** Real bounded-builder transport: commits a candidate in the dispatched worktree. */
function committingTransport(received: string[] = []): AgentTransport {
  return async (request) => {
    received.push(request.prompt ?? request.argv.at(-1) ?? "");
    writeFileSync(join(request.cwd, "dispatch-engine.txt"), "implemented\n");
    git(request.cwd, "add", "dispatch-engine.txt");
    git(request.cwd, "commit", "-q", "-m", "feat: implement frozen ticket");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("dispatch execution authority cutover gate", () => {
  let root: string;
  let checkoutPath: string;
  let forge: SyntheticForgeAdapter;
  let app: BackendApp;
  let projectId: string;

  async function buildApp(options: { startMonitor?: boolean; monitorRuntime?: any } = {}) {
    app = await createBackendApp({
      stateDir: join(root, "animus-home", "state"),
      startMonitor: options.startMonitor ?? false,
      forge,
      monitorRuntime: options.monitorRuntime,
      dispatch: { engine: { transport: committingTransport() } },
    });
    const registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    return app;
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "animus-dispatch-authority-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    git(checkoutPath, "commit", "--allow-empty", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    forge = new SyntheticForgeAdapter({ [REPO]: 917 });
  });

  afterEach(async () => {
    await app?.stop();
    delete process.env.ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("default authority stays legacy and refuses new dispatch until activation", async () => {
    expect(readExecutionAuthority().authority).toBe("legacy");
    addIssue(600);
    await buildApp();
    const plan = await importPlan(600);

    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.id }),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("authority_not_activated");
    const runs = app.db.prepare("SELECT COUNT(*) AS count FROM dispatch_runs").get() as {
      count: number;
    };
    expect(runs.count).toBe(0);
  });

  test("production monitor dispatches the frozen local manifest without touching GitHub backlog or legacy launch", async () => {
    writeExecutionAuthority("local");
    addIssue(601);

    const runtime = await loadMonitorRuntime({ forge });
    let legacySchedule = 0;
    let legacyFetch = 0;
    let legacyLaunch = 0;
    runtime.schedule = async () => {
      legacySchedule += 1;
      throw new Error("legacy GitHub scheduler must not run under local authority");
    };
    runtime.fetchBacklog = async () => {
      legacyFetch += 1;
      throw new Error("legacy GitHub backlog must not be fetched under local authority");
    };
    runtime.launch = async () => {
      legacyLaunch += 1;
      throw new Error("legacy lap launch must not run under local authority");
    };

    await buildApp({ monitorRuntime: runtime });
    const plan = await importPlan(601);

    // After admission every forge read fails; a live rebind would abort the path.
    forge.listIssues = async () => {
      throw new Error("forge reads are forbidden after local admission");
    };
    forge.getIssue = async () => {
      throw new Error("forge reads are forbidden after local admission");
    };

    await app.monitor.tick();
    await app.monitor.drain();

    expect(legacySchedule).toBe(0);
    expect(legacyFetch).toBe(0);
    expect(legacyLaunch).toBe(0);

    const listResponse = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/dispatch/runs?plan_id=${encodeURIComponent(plan.id)}`,
      ),
    );
    expect(listResponse.status).toBe(200);
    const runs = (await listResponse.json()) as Array<{
      state: string;
      head_sha: string | null;
      issue_number: number;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.issue_number).toBe(601);
    expect(runs[0]!.state).toBe("succeeded");
    expect(runs[0]!.head_sha).toBeTruthy();
    expect(existsSync(join(root, "animus-home", "state", "execution-authority.json"))).toBe(true);
  });

  test("animus scheduler dispatches locally without resolving a GitHub repository", async () => {
    writeExecutionAuthority("local");
    addIssue(602);
    await buildApp();

    const originalSpawnSync = Bun.spawnSync;
    const ghCalls: string[][] = [];
    (Bun as any).spawnSync = (argv: string[], options?: any) => {
      if (Array.isArray(argv) && argv[0] === "gh") {
        ghCalls.push(argv);
        throw new Error("gh must not be resolved under local authority");
      }
      return originalSpawnSync(argv as any, options);
    };

    try {
      const plan = await importPlan(602);
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
      let code: number;
      try {
        code = await runSchedulerCliCommand({
          repoRoot: checkoutPath,
          once: true,
          json: true,
          engine: { transport: committingTransport() },
        });
      } finally {
        console.log = originalLog;
      }
      expect(code).toBe(0);
      expect(ghCalls).toHaveLength(0);
      expect(logs.join("\n")).toContain('"action": "launched"');

      const listResponse = await app.fetch(
        new Request(
          `http://127.0.0.1/api/v1/projects/${projectId}/dispatch/runs?plan_id=${encodeURIComponent(plan.id)}`,
        ),
      );
      const runs = (await listResponse.json()) as Array<{ state: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]!.state).toBe("succeeded");
    } finally {
      (Bun as any).spawnSync = originalSpawnSync;
    }
  });

  test("the real default engine runs a bounded builder on the frozen contract and records a verified SHA", async () => {
    writeExecutionAuthority("local");
    addIssue(603);
    const prompts: string[] = [];
    app = await createBackendApp({
      stateDir: join(root, "animus-home", "state"),
      startMonitor: false,
      forge,
      dispatch: { engine: { transport: committingTransport(prompts) } },
    });
    const registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    const plan = await importPlan(603);

    // Every live forge read after admission is forbidden; the engine must use the
    // frozen contract revision only.
    forge.listIssues = async () => {
      throw new Error("live forge must not be read during dispatch");
    };
    forge.getIssue = async () => {
      throw new Error("live forge must not be read during dispatch");
    };

    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.id }),
      }),
    );
    expect(response.status).toBe(201);
    const run = (await response.json()) as {
      state: string;
      head_sha: string | null;
      branch: string;
      worktree_path: string;
    };
    expect(run.state).toBe("succeeded");
    expect(run.head_sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(run.worktree_path, "rev-parse", "HEAD")).toBe(run.head_sha!);
    expect(git(run.worktree_path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(run.branch);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Prepared ticket outcome.");
    expect(prompts[0]).toContain("Bounded role execution");

    const source = readFileSync(join(run.worktree_path, "dispatch-engine.txt"), "utf-8");
    expect(source).toContain("implemented");
  });

  test("legacy live-forge coordination dispatch is refused after local activation", async () => {
    writeExecutionAuthority("local");
    addIssue(605);
    await buildApp();
    let forgeReads = 0;
    forge.listIssues = async () => {
      forgeReads += 1;
      throw new Error("legacy coordination must not read the forge");
    };

    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/coordination/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specIssueNumber: 605 }),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("execution_authority_moved");
    expect(forgeReads).toBe(0);
  });

  test("the default engine refuses success without a committed candidate", async () => {
    writeExecutionAuthority("local");
    addIssue(604);
    app = await createBackendApp({
      stateDir: join(root, "animus-home", "state"),
      startMonitor: false,
      forge,
      dispatch: {
        engine: {
          transport: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
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
    const plan = await importPlan(604);

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
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/dispatch/runs?plan_id=${encodeURIComponent(plan.id)}`,
      ),
    );
    const runs = (await listResponse.json()) as Array<{
      state: string;
      head_sha: string | null;
      error: string | null;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("failed");
    expect(runs[0]!.head_sha).toBeNull();
    expect(runs[0]!.error).toContain("without committing");
  });
});
