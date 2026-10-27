import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createFactoryClient } from "@labq/client";

const root = fileURLToPath(new URL("../../", import.meta.url));
const children: ChildProcess[] = [];
const candidate = "  browser-<candidate>-é\n";
const token = randomBytes(32).toString("hex");
let logs = "";

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const [code, signal] = await exited;
    expect(code === 0 || (child.spawnargs[0] === "node" && signal === "SIGTERM")).toBe(true);
  } finally {
    clearTimeout(timeout);
  }
}
test.afterEach(async () => {
  const outcomes = await Promise.allSettled(children.splice(0).reverse().map(stop));
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
  });
  children.push(child);
  child.stdout?.on("data", (data: Buffer) => {
    logs += data.toString();
  });
  child.stderr?.on("data", (data: Buffer) => {
    logs += data.toString();
  });
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
  await start(
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
  await start(
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
});
