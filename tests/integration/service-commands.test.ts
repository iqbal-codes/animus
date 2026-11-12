import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryLauncher, LauncherOptions } from "../../apps/launcher/src/launcher";
import {
  RuntimeRootNotFoundError,
  isValidRuntimeRoot,
  resolveRuntimeRoot,
  resolveWebDir,
} from "../../scripts/cli/runtime-root";
import { runStartCommand, runStopCommand } from "../../scripts/cli/commands/service";

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeCheckout(): string {
  const root = tempRoot("animus-checkout-");
  for (const marker of ["apps/backend/src/main.ts", "apps/engine-host/src/main.ts"]) {
    mkdirSync(join(root, marker, ".."), { recursive: true });
    writeFileSync(join(root, marker), "", "utf-8");
  }
  return root;
}

describe("runtime root resolution", () => {
  test("prefers ANIMUS_SOURCE_ROOT, then the invoking checkout, then ~/.animus/source", () => {
    const envRoot = runtimeCheckout();
    const cwdRoot = runtimeCheckout();
    const homeRoot = runtimeCheckout();
    mkdirSync(join(homeRoot, ".."), { recursive: true });

    const home = tempRoot("animus-home-");
    mkdirSync(join(home, "source"), { recursive: true });
    for (const marker of ["apps/backend/src/main.ts", "apps/engine-host/src/main.ts"]) {
      mkdirSync(join(home, "source", marker, ".."), { recursive: true });
      writeFileSync(join(home, "source", marker), "", "utf-8");
    }

    expect(resolveRuntimeRoot({ cwd: cwdRoot, home, env: { ANIMUS_SOURCE_ROOT: envRoot } })).toBe(
      envRoot,
    );
    expect(resolveRuntimeRoot({ cwd: cwdRoot, home, env: {} })).toBe(cwdRoot);
    expect(resolveRuntimeRoot({ cwd: tempRoot("animus-elsewhere-"), home, env: {} })).toBe(
      join(home, "source"),
    );
  });

  test("rejects directories missing either service entrypoint", () => {
    const root = tempRoot("animus-partial-");
    mkdirSync(join(root, "apps/backend/src"), { recursive: true });
    writeFileSync(join(root, "apps/backend/src/main.ts"), "", "utf-8");

    expect(isValidRuntimeRoot(root)).toBe(false);
    expect(() =>
      resolveRuntimeRoot({ cwd: root, home: tempRoot("animus-home-"), env: {} }),
    ).toThrow(RuntimeRootNotFoundError);
  });

  test("reports the web console only when index.html exists", () => {
    const root = runtimeCheckout();
    expect(resolveWebDir(root)).toBeUndefined();

    mkdirSync(join(root, "apps/web/dist"), { recursive: true });
    writeFileSync(join(root, "apps/web/dist/index.html"), "<html></html>", "utf-8");
    expect(resolveWebDir(root)).toBe(join(root, "apps/web/dist"));
  });
});

describe("start and stop commands", () => {
  test("start launches the runtime root and serves the built console", async () => {
    const root = runtimeCheckout();
    mkdirSync(join(root, "apps/web/dist"), { recursive: true });
    writeFileSync(join(root, "apps/web/dist/index.html"), "<html></html>", "utf-8");
    const stateDir = tempRoot("animus-state-");
    const received: LauncherOptions[] = [];

    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runStartCommand({ cwd: root, stateDir, json: true }, (options) => {
      received.push(options);
      return {
        start: async () => ({
          status: "running",
          backendUrl: "http://127.0.0.1:3000",
          engineHostUrl: "http://127.0.0.1:4001",
        }),
        getStatus: () => ({ state: "running" }),
        getProcesses: () => ({}),
        stop: async () => ({ status: "stopped", stopped: [] }),
      } as unknown as FactoryLauncher;
    });

    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      repoRoot: root,
      webDir: join(root, "apps/web/dist"),
      stateDir,
    });
    const metadata = JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf-8"));
    expect(metadata.backendUrl).toBe("http://127.0.0.1:3000");
  });

  test("start warns instead of silently claiming a dashboard when web assets are absent", async () => {
    const root = runtimeCheckout();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runStartCommand(
      { cwd: root, stateDir: tempRoot("animus-state-"), json: true },
      () =>
        ({
          start: async () => ({ status: "running", backendUrl: "http://127.0.0.1:3000" }),
          getStatus: () => ({ state: "running" }),
          getProcesses: () => ({}),
          stop: async () => ({ status: "stopped", stopped: [] }),
        }) as unknown as FactoryLauncher,
    );

    // --json keeps stdout machine-readable; the warning is suppressed in that mode.
    expect(warn).not.toHaveBeenCalled();
  });

  test("stop without runtime metadata reports not_running without failing", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });

    const code = await runStopCommand({ stateDir: tempRoot("animus-state-"), json: true });

    expect(code).toBe(0);
    expect(JSON.parse(logged.join("\n"))).toMatchObject({ ok: false, status: "not_running" });
  });

  test("start defaults to background detached mode and records metadata without blocking", async () => {
    const root = runtimeCheckout();
    const stateDir = tempRoot("animus-state-");
    const received: LauncherOptions[] = [];
    const logged: string[] = [];

    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logged.push(String(msg));
    });

    const code = await runStartCommand({ cwd: root, stateDir, json: true }, (options) => {
      received.push(options);
      return {
        start: async () => ({
          status: "running",
          backendUrl: "http://127.0.0.1:3000",
          engineHostUrl: "http://127.0.0.1:4001",
        }),
        getStatus: () => ({ state: "running", backendPid: 12345, engineHostPid: 12346 }),
        getProcesses: () => ({ backend: {}, engineHost: {} }),
        stop: async () => ({ status: "stopped", stopped: [] }),
      } as unknown as FactoryLauncher;
    });

    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].detached).toBe(true);
    const parsedLog = JSON.parse(logged.join("\n"));
    expect(parsedLog).toMatchObject({
      ok: true,
      status: "running",
      detached: true,
      backendPid: 12345,
      engineHostPid: 12346,
    });
    const metadata = JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf-8"));
    expect(metadata.backendPid).toBe(12345);
    expect(metadata.pid).toBe(12345);
  });

  test("start is idempotent when services are already running and healthy", async () => {
    const root = runtimeCheckout();
    const stateDir = tempRoot("animus-state-");
    writeFileSync(
      join(stateDir, "runtime.json"),
      JSON.stringify({
        pid: 99999,
        backendUrl: "http://127.0.0.1:3000",
        engineHostUrl: "http://127.0.0.1:4001",
        backendPid: 99999,
        engineHostPid: 99998,
        startedAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const launcherCalls: LauncherOptions[] = [];
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logged.push(String(msg));
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes("/health")) {
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as any;

    try {
      const code = await runStartCommand({ cwd: root, stateDir, json: true }, (options) => {
        launcherCalls.push(options);
        return {} as unknown as FactoryLauncher;
      });

      expect(code).toBe(0);
      expect(launcherCalls).toHaveLength(0);
      const parsedLog = JSON.parse(logged.join("\n"));
      expect(parsedLog).toMatchObject({
        ok: true,
        status: "already_running",
        backendPid: 99999,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("start with --foreground passes detached: false to launcher", async () => {
    const root = runtimeCheckout();
    const stateDir = tempRoot("animus-state-");
    const received: LauncherOptions[] = [];

    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runStartCommand(
      { cwd: root, stateDir, foreground: true, json: true },
      (options) => {
        received.push(options);
        return {
          start: async () => ({
            status: "running",
            backendUrl: "http://127.0.0.1:3000",
            engineHostUrl: "http://127.0.0.1:4001",
          }),
          getStatus: () => ({ state: "running" }),
          getProcesses: () => ({}),
          stop: async () => ({ status: "stopped", stopped: [] }),
        } as unknown as FactoryLauncher;
      },
    );

    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].detached).toBe(false);
  });
});
