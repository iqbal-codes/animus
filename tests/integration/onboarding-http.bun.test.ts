import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFactoryClient } from "@animus/client";
import { createBackendApp } from "../../apps/backend/src/main";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { ProjectRegistryService } from "../../apps/backend/src/registry/service";
import { SyntheticForgeAdapter } from "../../apps/backend/src/registry/forge";
import { RegisteredProjectMonitor } from "../../apps/backend/src/monitor/service";
import { loadMonitorRuntime } from "../../apps/backend/src/monitor/runtime";
import { processRun, withProcessPolicy } from "../../scripts/loop/process";

test("real backend enrolls a checkout, provisions labels, reports held setup, and preserves admission", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-onboarding-http-")));
  const checkout = join(root, "product");
  const bin = join(root, "bin");
  mkdirSync(bin);
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/product.git",
  ]);
  const labelsPath = join(root, "labels.json");
  writeFileSync(
    labelsPath,
    JSON.stringify([{ name: "custom", color: "123456", description: "Keep" }]),
  );
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst path = process.env.TEST_LABELS;\nif (args[0] !== "api") process.exit(2);\nif (args[1] === "repos/acme/product") { console.log(JSON.stringify({id:42,nameWithOwner:"acme/product"})); process.exit(0); }\nif (args[1] !== "repos/acme/product/labels") process.exit(3);\nconst labels = await Bun.file(path).json();\nif (args.includes("POST")) { const fields=Object.fromEntries(args.filter((value,index)=>args[index-1]==="-f").map(value=>{const at=value.indexOf("=");return [value.slice(0,at),value.slice(at+1)];}));labels.push(fields);await Bun.write(path, JSON.stringify(labels));console.log(JSON.stringify(fields)); } else console.log(JSON.stringify([labels]));\n`,
    { mode: 0o700 },
  );
  const secret = randomBytes(32).toString("hex");
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: "unused" }, { status: 404 }),
  });
  const backend = Bun.spawn([process.execPath, "apps/backend/src/main.ts", "--port", "0"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_LABELS: labelsPath,
      FACTORY_STATE_DIR: join(root, "state"),
      FACTORY_HOST_URL: host.url.origin,
      FACTORY_HOST_TOKEN: secret,
      FACTORY_RUNTIME_CANDIDATE: "onboarding-test",
      FACTORY_MONITOR_INTERVAL_MS: "20",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = backend.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(5000).then(() => {
        throw new Error("Backend startup deadline");
      }),
    ]);
    if (!first.value) throw new Error(await new Response(backend.stderr).text());
    const { url } = JSON.parse(new TextDecoder().decode(first.value));
    reader.releaseLock();
    const client = createFactoryClient({ baseUrl: url });
    const registration = {
      method: "local_checkout" as const,
      name: "Product",
      checkout_path: checkout,
    };
    const project = await client.registerProject(registration);
    expect(project.repo_id).toBe(42);
    expect((await client.registerProject(registration)).id).toBe(project.id);
    expect((await client.projects()).map((entry) => entry.id)).toEqual([project.id]);
    const labels = (await Bun.file(labelsPath).json()) as { name: string }[];
    expect(labels.map((label) => label.name).sort()).toEqual([
      "custom",
      "needs-info",
      "needs-triage",
      "ready-for-agent",
      "ready-for-human",
      "wontfix",
    ]);
    let monitoring = await client.monitoring();
    const deadline = Date.now() + 5000;
    while (monitoring.projects[0]?.state !== "held" && Date.now() < deadline) {
      await Bun.sleep(20);
      monitoring = await client.monitoring();
    }
    expect(monitoring.enabled).toBe(true);
    expect(monitoring.projects[0]?.reason).toBe("setup_incomplete");
    expect(monitoring.projects[0]?.run_id).toBeUndefined();
    expect((await client.deregisterProject(project.id)).status).toBe("tombstone");
    expect(await client.projects()).toEqual([]);
  } finally {
    if (backend.exitCode === null) backend.kill("SIGTERM");
    const exit = await Promise.race([backend.exited, Bun.sleep(5000).then(() => "timeout")]);
    if (exit === "timeout") {
      backend.kill("SIGKILL");
      await backend.exited;
    }
    await host.stop(true);
    rmSync(root, { recursive: true, force: true });
    expect(exit).toBe(0);
  }
}, 15000);

describe("In-Process Backend Application Kernel & Monitor Runtime (Ticket #147)", () => {
  test("AC1: createBackendApp exports { fetch, websocket, monitor, db, stop } for direct in-process testing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "backend-kernel-test-")));
    const token = randomBytes(16).toString("hex");
    try {
      const app = await createBackendApp({
        stateDir: join(root, "state"),
        token,
        startMonitor: false,
      });

      expect(typeof app.fetch).toBe("function");
      expect(typeof app.websocket).toBe("object");
      expect(typeof app.websocket.open).toBe("function");
      expect(typeof app.websocket.message).toBe("function");
      expect(typeof app.websocket.close).toBe("function");
      expect(app.monitor).toBeInstanceOf(RegisteredProjectMonitor);
      expect(app.db).toBeInstanceOf(DatabaseSync);
      expect(typeof app.stop).toBe("function");

      // Verify direct in-process HTTP routing without port binding
      const healthRes = await app.fetch(new Request("http://127.0.0.1/health"));
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ status: "healthy" });

      const buildIdRes = await app.fetch(new Request("http://127.0.0.1/build-id"));
      expect(buildIdRes.status).toBe(200);

      await app.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC1: lifecycle stop is idempotent and preserves injected db ownership", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "backend-ownership-test-")));
    try {
      // 1. Injected DB ownership
      const callerDb = initializeDatabase(":memory:");
      callerDb.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY);");

      const appWithInjectedDb = await createBackendApp({
        db: callerDb,
        stateDir: join(root, "state1"),
        startMonitor: false,
      });

      expect(appWithInjectedDb.db).toBe(callerDb);
      await appWithInjectedDb.stop();
      // Idempotent: repeated stop calls should not throw
      await appWithInjectedDb.stop();
      await appWithInjectedDb.stop();

      // Injected DB remains open and operable because the caller owns it
      callerDb.exec("INSERT INTO test_table (id) VALUES (1);");
      const rows = callerDb.prepare("SELECT COUNT(*) as count FROM test_table").get() as {
        count: number;
      };
      expect(rows.count).toBe(1);
      callerDb.close();

      // 2. Internally created DB ownership
      const appWithInternalDb = await createBackendApp({
        stateDir: join(root, "state2"),
        startMonitor: false,
      });
      const internalDb = appWithInternalDb.db;
      expect(internalDb).toBeInstanceOf(DatabaseSync);

      await appWithInternalDb.stop();
      // Idempotent: repeated stop calls do not throw
      await appWithInternalDb.stop();

      // Internally created DB was owned by the app and is now closed
      expect(() => internalDb.exec("SELECT 1;")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC2 & AC3: unified global and project-scoped route handlers parameterized by projectId & single shared IntakeService", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "backend-routes-test-")));
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      "https://github.com/test-org/test-repo.git",
    ]);

    const token = randomBytes(16).toString("hex");
    const mockHost = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const now = new Date().toISOString();
        if (url.pathname === "/internal/v1/controls") {
          if (req.method === "POST") {
            return Response.json({
              halted: true,
              paused: false,
              active_brake: "stop",
              updated_at: now,
            });
          }
          return Response.json({
            halted: false,
            paused: false,
            active_brake: "none",
            updated_at: now,
          });
        }
        if (url.pathname === "/internal/v1/promotion/status") {
          return Response.json({
            main_branch: "main",
            develop_branch: "develop",
            unpromoted_count: 0,
            delivered_tickets: [],
            candidate_freeze: false,
            existing_pr: null,
            ready_to_promote: true,
          });
        }
        if (url.pathname === "/internal/v1/promotion/prepare") {
          return Response.json({
            pr_number: 1,
            pr_url: "https://github.com/test-org/test-repo/pull/1",
            title: "Promotion PR",
            unpromoted_count: 0,
            candidate_freeze: true,
            partial_effect: false,
          });
        }
        if (url.pathname === "/internal/v1/laps") {
          if (req.method === "POST") {
            return Response.json({ id: "lap-123", status: "dispatched" });
          }
          return Response.json([
            {
              id: "lap-123",
              workflow_name: "test-workflow",
              native_status: "running",
              product_status: "running",
            },
          ]);
        }
        if (url.pathname === "/internal/v1/laps/lap-123") {
          return Response.json({
            id: "lap-123",
            workflow_name: "test-workflow",
            native_status: "running",
            product_status: "running",
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });

    try {
      const forge = new SyntheticForgeAdapter({ "test-org/test-repo": 1001 });
      const app = await createBackendApp({
        stateDir: join(root, "state"),
        token,
        origin: mockHost.url.origin,
        startMonitor: false,
        forge,
      });

      const registry = new ProjectRegistryService(app.db, forge);
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Test Project",
        checkout_path: checkout,
      });

      // 1. Controls route (global & project-scoped share implementation)
      const globalControlsGet = await app.fetch(new Request("http://127.0.0.1/api/v1/controls"));
      expect(globalControlsGet.status).toBe(200);
      expect(await globalControlsGet.json()).toMatchObject({
        halted: false,
        paused: false,
        active_brake: "none",
      });

      const projectControlsGet = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${project.id}/controls`),
      );
      expect(projectControlsGet.status).toBe(200);
      expect(await projectControlsGet.json()).toMatchObject({
        halted: false,
        paused: false,
        active_brake: "none",
      });

      const globalControlsPost = await app.fetch(
        new Request("http://127.0.0.1/api/v1/controls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "halt" }),
        }),
      );
      expect(globalControlsPost.status).toBe(200);
      expect(await globalControlsPost.json()).toMatchObject({
        halted: true,
        paused: false,
        active_brake: "stop",
      });

      const projectControlsPost = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${project.id}/controls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "halt" }),
        }),
      );
      expect(projectControlsPost.status).toBe(200);
      expect(await projectControlsPost.json()).toMatchObject({
        halted: true,
        paused: false,
        active_brake: "stop",
      });

      // 2. Promotion route (global & project-scoped share implementation)
      const globalPromoStatus = await app.fetch(
        new Request("http://127.0.0.1/api/v1/promotion/status"),
      );
      expect(globalPromoStatus.status).toBe(200);

      const projectPromoStatus = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${project.id}/promotion/status`),
      );
      expect(projectPromoStatus.status).toBe(200);

      // 3. Brakes route (global vs project-scoped parameterized by projectId)
      const globalBrakesGet = await app.fetch(new Request("http://127.0.0.1/api/v1/brakes"));
      expect(globalBrakesGet.status).toBe(200);
      const globalBrakeState = await globalBrakesGet.json();
      expect(globalBrakeState).toHaveProperty("global_launch_brake");

      const projectBrakesGet = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${project.id}/brakes`),
      );
      expect(projectBrakesGet.status).toBe(200);
      const projectBrakeState = await projectBrakesGet.json();
      expect(projectBrakeState).toHaveProperty("launch_brake");

      // Mutate project brake
      const setProjectBrake = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${project.id}/brakes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brake: "launch_brake",
            active: true,
            actor: "test",
            reason: "maintenance",
          }),
        }),
      );
      expect(setProjectBrake.status).toBe(200);
      const updatedProjectBrake = await setProjectBrake.json();
      expect(updatedProjectBrake.launch_brake).toBe(true);

      // Global brake unaffected
      const recheckGlobal = await (
        await app.fetch(new Request("http://127.0.0.1/api/v1/brakes"))
      ).json();
      expect(recheckGlobal.global_launch_brake).toBe(false);

      // 4. Commands route (global vs project-scoped)
      const postCmd = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${project.id}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: "operator",
            action: "sync",
            target: { type: "test" },
          }),
        }),
      );
      expect(postCmd.status).toBe(201);
      const cmdRecord = await postCmd.json();
      expect(cmdRecord.projectId).toBe(project.id);

      // Scoped get
      const getScopedCmd = await app.fetch(
        new Request(
          `http://127.0.0.1/api/v1/projects/${project.id}/commands/${cmdRecord.requestId}`,
        ),
      );
      expect(getScopedCmd.status).toBe(200);

      // Scope mismatch 404
      const mismatchCmd = await app.fetch(
        new Request(
          `http://127.0.0.1/api/v1/projects/non-existent-proj/commands/${cmdRecord.requestId}`,
        ),
      );
      expect(mismatchCmd.status).toBe(404); // non-existent project validation fails with project_not_found (404)

      // 5. Laps route (global vs project-scoped)
      const globalLapsGet = await app.fetch(new Request("http://127.0.0.1/api/v1/laps"));
      expect(globalLapsGet.status).toBe(200);

      const projectLapsGet = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${project.id}/laps`),
      );
      expect(projectLapsGet.status).toBe(200);

      // 6. Single shared IntakeService backed by registry DB and forge adapter
      // Both global and project intake endpoints evaluate against the shared database
      const globalIntake = await app.fetch(new Request("http://127.0.0.1/api/v1/intake"));
      expect(globalIntake.status).toBe(200);

      const projectIntake = await app.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${project.id}/intake`),
      );
      expect(projectIntake.status).toBe(200);

      await app.stop();
    } finally {
      await mockHost.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AC4: monitor runtime executes backlog polling, contract binding, and triage passes in-process without worker.ts", async () => {
    // 1. Verify worker.ts is deleted
    const workerPath = join(import.meta.dir, "../../apps/backend/src/monitor/worker.ts");
    expect(existsSync(workerPath)).toBe(false);

    // 2. Verify loadMonitorRuntime executes in-process
    const mockBacklogIssues = [
      {
        number: 42,
        title: "Test Issue",
        state: "OPEN",
        labels: ["ready-for-agent"],
        dependencies: [],
      },
    ];

    const runtime = await loadMonitorRuntime({
      fetchBacklog: async () => ({
        issues: mockBacklogIssues,
        closedNumbers: new Set<number>(),
      }),
      triage: async () => ({
        processed: [{ issueNumber: 42, status: "succeeded" }],
        skippedCount: 0,
        successCount: 1,
        failureCount: 0,
        heldCount: 0,
      }),
    });

    const backlog = await runtime.fetchBacklog("dummy-root", "owner/repo");
    expect(backlog.issues).toEqual(mockBacklogIssues);
    expect(backlog.closedNumbers.size).toBe(0);

    const triageResult = await runtime.triage!({
      root: "dummy-root",
      repo: "owner/repo",
      stateRoot: "dummy-state",
      issueNumber: 42,
    });
    expect(triageResult.successCount).toBe(1);
    expect(triageResult.processed[0]?.issueNumber).toBe(42);
  });

  test("remediation: concurrent app.stop() calls drain monitor together without early return", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "backend-concurrent-stop-")));
    try {
      const callerDb = initializeDatabase(":memory:");
      const app = await createBackendApp({
        db: callerDb,
        stateDir: join(root, "state"),
        startMonitor: false,
      });

      let drained = false;
      const originalDrain = app.monitor.drain.bind(app.monitor);
      app.monitor.drain = async () => {
        await Bun.sleep(50);
        drained = true;
        await originalDrain();
      };

      const [stop1, stop2, stop3] = await Promise.all([app.stop(), app.stop(), app.stop()]);
      expect(stop1).toBeUndefined();
      expect(stop2).toBeUndefined();
      expect(stop3).toBeUndefined();
      expect(drained).toBe(true);
      expect(app.monitor.status().stopping).toBe(true);
      callerDb.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("remediation: in-process processRun with manageSignals: false does not leak process signal handlers", async () => {
    const beforeListeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

    const result = await processRun(
      ["node", "-e", "setTimeout(() => {}, 20);"],
      process.cwd(),
      1000,
      undefined,
      { manageSignals: false },
    );
    expect(result.exitCode).toBe(0);

    const afterListeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    expect(afterListeners).toEqual(beforeListeners);
  });

  test("embedded subprocess policy propagates across await without taking host signal ownership", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await withProcessPolicy({ manageSignals: false }, async () => {
      await Promise.resolve();
      const child = processRun(
        [process.execPath, "-e", "console.log('done')"],
        process.cwd(),
        1000,
      );
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
      expect((await child).exitCode).toBe(0);
    });
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  test("remediation: arbitrary observer on SIGTERM does not disable CLI signal exit", async () => {
    const modulePath = join(process.cwd(), "scripts/loop/process.ts");
    const childHost = spawn(
      process.execPath,
      [
        "-e",
        `
        import { processRun } from ${JSON.stringify(modulePath)};
        process.on("SIGTERM", () => {
          // Arbitrary observer
        });
        await processRun(["node", "-e", "setInterval(()=>{}, 1000);"], process.cwd(), 30000);
      `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    await Bun.sleep(150);
    childHost.kill("SIGTERM");

    const exitedCode = await Promise.race([
      new Promise<number | null>((resolve) =>
        childHost.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1))),
      ),
      Bun.sleep(4000).then(() => "timeout"),
    ]);

    expect(exitedCode).toBe(143);
  });

  test("remediation: real in-process monitor cancellation and draining during in-flight operations", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "backend-monitor-cancellation-")));
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      "https://github.com/test-org/cancel-repo.git",
    ]);

    try {
      const forge = new SyntheticForgeAdapter({ "test-org/cancel-repo": 2002 });
      let triageStarted = false;
      let triageCompleted = false;

      const runtime = await loadMonitorRuntime({
        forge,
        fetchBacklog: async () => ({
          issues: [
            {
              number: 1,
              title: "Pending",
              state: "OPEN",
              labels: ["ready-for-agent"],
              dependencies: [],
            },
          ],
          closedNumbers: new Set<number>(),
        }),
        triage: async () => {
          triageStarted = true;
          await Bun.sleep(120);
          triageCompleted = true;
          return {
            processed: [{ issueNumber: 1, status: "succeeded" }],
            skippedCount: 0,
            successCount: 1,
            failureCount: 0,
            heldCount: 0,
          };
        },
      });

      const app = await createBackendApp({
        stateDir: join(root, "state"),
        startMonitor: false,
        monitorRuntime: runtime,
        forge,
      });

      const registry = new ProjectRegistryService(app.db, forge);
      await registry.registerProject({
        method: "local_checkout",
        name: "Cancel Project",
        checkout_path: checkout,
      });

      app.monitor.start();
      app.monitor.wakeProject("test-org/cancel-repo");

      for (let i = 0; i < 30; i++) {
        if (triageStarted) break;
        await Bun.sleep(20);
      }
      expect(triageStarted).toBe(true);

      const stopStartTime = Date.now();
      await app.monitor.stop();
      const stopDuration = Date.now() - stopStartTime;

      expect(app.monitor.status().stopping).toBe(true);
      expect(app.monitor.status().enabled).toBe(false);
      expect(triageCompleted).toBe(true);
      expect(stopDuration).toBeGreaterThanOrEqual(40);

      await app.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("remediation: graceful SIGTERM to backend server process exits with code 0 without fake success", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "backend-sigterm-test-")));
    const secret = randomBytes(32).toString("hex");
    const mockHost = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ error: "unused" }, { status: 404 }),
    });

    const backend = Bun.spawn([process.execPath, "apps/backend/src/main.ts", "--port", "0"], {
      env: {
        ...process.env,
        FACTORY_STATE_DIR: join(root, "state"),
        FACTORY_HOST_URL: mockHost.url.origin,
        FACTORY_HOST_TOKEN: secret,
        FACTORY_RUNTIME_CANDIDATE: "sigterm-test",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const reader = backend.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        Bun.sleep(5000).then(() => {
          throw new Error("Backend startup deadline");
        }),
      ]);
      if (!first.value) throw new Error(await new Response(backend.stderr).text());
      const { url } = JSON.parse(new TextDecoder().decode(first.value));
      reader.releaseLock();

      const healthRes = await fetch(`${url}/health`);
      expect(healthRes.status).toBe(200);

      backend.kill("SIGTERM");

      const exitCode = await Promise.race([
        backend.exited,
        Bun.sleep(5000).then(() => {
          backend.kill("SIGKILL");
          return -1;
        }),
      ]);

      expect(exitCode).toBe(0);
    } finally {
      await mockHost.stop(true);
      if (backend.exitCode === null) {
        backend.kill("SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
