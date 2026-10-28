import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createFactoryClient } from "@labq/client";

const root = fileURLToPath(new URL("../../", import.meta.url));
const children = new Map<ChildProcess, string>();
const candidate = "  browser-<candidate>-é\n";
const token = randomBytes(32).toString("hex");
let logs = "";

async function released(url: string) {
  const listener = createServer();
  try {
    listener.listen(Number(new URL(url).port), "127.0.0.1");
    await once(listener, "listening");
  } finally {
    if (listener.listening)
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
async function stop(child: ChildProcess) {
  const url = children.get(child);
  if (!url) return;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) throw new Error("Missing owned process group");
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const closed =
    child.stdout?.closed && child.stderr?.closed ? Promise.resolve() : once(child, "close");
  // Vite+ wrappers can exit before their server children; signal the owned group either way.
  signalGroup("SIGTERM");
  const timeout = setTimeout(() => signalGroup("SIGKILL"), 3000);
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        const deadline = setTimeout(() => reject(new Error("Process cleanup deadline")), 5000);
        void closed.finally(() => clearTimeout(deadline));
      }),
    ]);
    expect(
      child.exitCode === 0 || (child.spawnargs[0] === "node" && child.signalCode === "SIGTERM"),
    ).toBe(true);
    await released(url);
    children.delete(child);
  } finally {
    clearTimeout(timeout);
  }
}
test.afterEach(async () => {
  const outcomes = await Promise.allSettled([...children.keys()].reverse().map(stop));
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  expect(logs).not.toContain(token);
});
async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function start(argv: string[], url: string, env: Record<string, string> = {}) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd: root,
    env: { ...process.env, FACTORY_RUNTIME_CANDIDATE: candidate, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.set(child, url);
  child.stdout?.on("data", (data: Buffer) => {
    logs += data.toString();
  });
  child.stderr?.on("data", (data: Buffer) => {
    logs += data.toString();
  });
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(`Process exited: ${logs}`);
          try {
            return (
              await fetch(`${url}/health`, {
                headers: env.FACTORY_HOST_TOKEN
                  ? { Authorization: `Bearer ${env.FACTORY_HOST_TOKEN}` }
                  : {},
              })
            ).status;
          } catch {
            return 0;
          }
        },
        { timeout: 5000, intervals: [10, 50, 100] },
      )
      .toBe(200);
  } catch (error) {
    await stop(child);
    throw error;
  }
  return child;
}

test("web refuses missing configuration, invalid targets and every remote bind syntax", () => {
  for (const command of ["dev", "preview"]) {
    for (const [args, backend] of [
      [[], "http://127.0.0.1:1"],
      [["--port", "0"], "http://127.0.0.1:1"],
      [["--port", "65536"], "http://127.0.0.1:1"],
      [["--port", "12345", "--host", "0.0.0.0"], "http://127.0.0.1:1"],
      [["--port=12345", "--host=0.0.0.0"], "http://127.0.0.1:1"],
      [["--port=12345", "--host=127.0.0.1", "--host=0.0.0.0"], "http://127.0.0.1:1"],
      [["--port=12345", "--host=localhost"], "http://127.0.0.1:1"],
      [["--port", "12345"], undefined],
      [["--port", "12345"], "http://private-secret@127.0.0.1:1"],
      [["--port", "12345"], "http://example.com:1234"],
      [["--port", "12345"], "http://127.0.0.1:0"],
    ] as const) {
      const result = spawnSync(
        "node",
        [
          "node_modules/vite-plus/bin/vp",
          command,
          "apps/web",
          "--config",
          "apps/web/vite.config.ts",
          ...args,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            FACTORY_BACKEND_URL: backend,
            FACTORY_RUNTIME_CANDIDATE: candidate,
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain("private-secret");
    }
  }
});

test("built browser health journey observes host outage and recovery without credentials", async ({
  page,
  request,
}) => {
  const hostPort = await port();
  const backendPort = await port();
  const webPort = await port();
  const hostUrl = `http://127.0.0.1:${hostPort}`;
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const hostArgs = ["bun", "apps/engine-host/src/main.ts", "--port", String(hostPort)];
  const host = await start(hostArgs, hostUrl, { FACTORY_HOST_TOKEN: token });
  await start(["bun", "apps/backend/src/main.ts", "--port", String(backendPort)], backendUrl, {
    FACTORY_HOST_TOKEN: token,
    FACTORY_HOST_URL: hostUrl,
  });
  expect((await createFactoryClient({ baseUrl: backendUrl }).health()).buildId).toBe(candidate);
  const preview = await start(
    [
      "node",
      "node_modules/vite-plus/bin/vp",
      "preview",
      "apps/web",
      "--config",
      "apps/web/vite.config.ts",
      "--port",
      String(webPort),
      "--host",
      "127.0.0.1",
      "--strictPort",
    ],
    webUrl,
    { FACTORY_BACKEND_URL: backendUrl },
  );
  const headers: Record<string, string>[] = [];
  page.on("request", (req) => headers.push(req.headers()));
  await page.goto(webUrl);
  await expect(page.getByRole("status")).toHaveText("Healthy: backend and engine host connected.");
  expect(await page.locator("#backend-id").textContent()).toBe(candidate);
  expect(await page.locator("#host-id").textContent()).toBe(candidate);
  expect(await (await request.get(`${webUrl}/build-id`)).text()).toBe(candidate);
  for (const path of ["/internal/v1/health", "/api/doctor", "/api/v1/unknown"])
    expect((await request.get(`${webUrl}${path}`)).status()).toBe(404);
  await stop(host);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("status")).toHaveText("Unavailable: engine host is not reachable.");
  await expect(page.locator("#identities")).toBeHidden();
  expect(await page.locator("#backend-id").textContent()).toBe("");
  await start(hostArgs, hostUrl, { FACTORY_HOST_TOKEN: token });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("status")).toHaveText("Healthy: backend and engine host connected.");
  expect(JSON.stringify(headers)).not.toContain(token);
  expect(headers.every((item) => !item.authorization)).toBe(true);
  expect(await page.content()).not.toContain(token);
  const devPort = await port();
  const devUrl = `http://127.0.0.1:${devPort}`;
  const dev = await start(
    [
      "node",
      "node_modules/vite-plus/bin/vp",
      "dev",
      "apps/web",
      "--config",
      "apps/web/vite.config.ts",
      "--port",
      String(devPort),
      "--host",
      "127.0.0.1",
      "--strictPort",
    ],
    devUrl,
    { FACTORY_BACKEND_URL: backendUrl },
  );
  expect((await createFactoryClient({ baseUrl: devUrl }).health()).buildId).toBe(candidate);

  // Verify Operator Promotion Journey through DOM
  await expect(page.locator("#promotion-status")).toBeVisible();
  await expect(page.locator("#btn-promote")).toBeVisible();

  // Verify Console Navigator & Spec Sidebar (AC1)
  await expect(page.locator("#project-selector")).toBeVisible();
  await expect(page.locator("#spec-sidebar")).toBeVisible();

  // Verify Tab navigation to Live Log Observation (AC2, AC3)
  await page.getByRole("tab", { name: "Live Log Observation" }).click();
  await expect(page.getByText("Live Observation Logs")).toBeVisible();

  preview.kill("SIGTERM");
  await expect.poll(() => preview.signalCode, { timeout: 3000 }).toBe("SIGTERM");
  await stop(preview);
  await stop(dev);
});

test("failed readiness cleans the listening process before returning the error", async () => {
  const unavailablePort = await port();
  const url = `http://127.0.0.1:${unavailablePort}`;
  await expect(
    start(
      [
        "node",
        "--input-type=module",
        "-e",
        `import { createServer } from "node:http";
     createServer((_, response) => { response.writeHead(503); response.end(); })
       .listen(${unavailablePort}, "127.0.0.1");`,
      ],
      url,
    ),
  ).rejects.toThrow(/toBe/);
  await released(url);
});
