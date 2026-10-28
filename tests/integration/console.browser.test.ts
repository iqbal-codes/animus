import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const children = new Map<ChildProcess, string>();
const candidate = "browser-candidate-e2e";
const token = randomBytes(32).toString("hex");

async function released(url: string) {
  const listener = createServer();
  try {
    listener.listen(Number(new URL(url).port), "127.0.0.1");
    await once(listener, "listening");
  } finally {
    if (listener.listening) {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
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
    await released(url);
    children.delete(child);
  } finally {
    clearTimeout(timeout);
  }
}

test.afterEach(async () => {
  const outcomes = await Promise.allSettled([...children.keys()].reverse().map(stop));
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
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
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error("Process exited early");
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

test("E2E Web Console Journey: Navigator, Sidebar, DAG, Tabs, and Consequential Modal", async ({
  page,
}) => {
  const hostPort = await port();
  const backendPort = await port();
  const webPort = await port();
  const hostUrl = `http://127.0.0.1:${hostPort}`;
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;

  // 1. Start Engine Host and Backend
  const hostArgs = ["bun", "apps/engine-host/src/main.ts", "--port", String(hostPort)];
  await start(hostArgs, hostUrl, { FACTORY_HOST_TOKEN: token });
  await start(["bun", "apps/backend/src/main.ts", "--port", String(backendPort)], backendUrl, {
    FACTORY_HOST_TOKEN: token,
    FACTORY_HOST_URL: hostUrl,
  });

  // 2. Start Preview Web Server with Proxy to Backend
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

  // 3. Navigate to Web Console
  await page.goto(webUrl);

  // 4. Verify Header and Authentic Health Status (Invariant 1)
  await expect(page.getByRole("heading", { name: "LABQ SOFTWARE FACTORY" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Healthy: backend and engine host connected.");
  expect(await page.locator("#backend-id").textContent()).toBe(candidate);
  expect(await page.locator("#host-id").textContent()).toBe(candidate);

  // 5. Verify Project-Scoped Navigator (AC1)
  const projectSelector = page.locator("#project-selector");
  await expect(projectSelector).toBeVisible();

  // 6. Verify Flat Spec Sidebar (AC1)
  const sidebar = page.locator("#spec-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(page.getByText("SPECS & BACKLOG")).toBeVisible();
  const searchInput = page.locator("#spec-sidebar-search");
  await expect(searchInput).toBeVisible();

  // Filter sidebar items
  await searchInput.fill("nonexistent-spec-query");
  await expect(page.getByText("No specs or issues match.")).toBeVisible();
  await searchInput.fill("");

  // 7. Verify Tab Switching & Virtualized Live Logs (AC2, AC3)
  const tabsList = page.getByRole("tablist");
  await expect(tabsList).toBeVisible();

  // Switch to Live Log Observation Tab
  await page.getByRole("tab", { name: "Live Log Observation" }).click();
  await expect(page.getByText("Live Observation Logs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Auto-scroll ON" })).toBeVisible();
  await expect(page.getByPlaceholder("Filter logs...")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();

  // Toggle Auto-scroll
  await page.getByRole("button", { name: "Auto-scroll ON" }).click();
  await expect(page.getByRole("button", { name: "Auto-scroll OFF" })).toBeVisible();
  await page.getByRole("button", { name: "Auto-scroll OFF" }).click();
  await expect(page.getByRole("button", { name: "Auto-scroll ON" })).toBeVisible();

  // Switch to Issue Details Tab
  await page.getByRole("tab", { name: "Issue Details" }).click();
  await expect(page.getByText("Select an issue from the sidebar.")).toBeVisible();

  // Switch back to Spec & DAG View Tab
  await page.getByRole("tab", { name: "Spec & DAG View" }).click();
  await expect(
    page.getByText("Select a spec or issue from the sidebar to inspect its child DAG"),
  ).toBeVisible();

  // 8. Verify Execution Brakes Ribbon
  await expect(page.locator("#btn-halt")).toBeVisible();
  await expect(page.locator("#btn-unhalt")).toBeVisible();
  await expect(page.locator("#btn-pause")).toBeVisible();
  await expect(page.locator("#btn-unpause")).toBeVisible();

  // Click Pause brake
  await page.locator("#btn-pause").click();
  await expect(page.locator("#control-status")).toContainText("PAUSED");

  // Click Unpause brake
  await page.locator("#btn-unpause").click();
  await expect(page.locator("#control-status")).toContainText("Active");

  // 9. Verify Consequential Action Modal (AC4)
  // Prepare Promotion PR modal
  const btnPromoteModal = page.locator("#btn-promote");
  await expect(btnPromoteModal).toBeVisible();
  // Click modal trigger
  await btnPromoteModal.click({ force: true });
  await expect(page.locator("#consequential-action-dialog")).toBeVisible();
  await expect(page.getByText("CONSEQUENTIAL ACTION")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prepare Promotion PR" })).toBeVisible();
  await expect(page.getByText("Target Branch:")).toBeVisible();
  await expect(page.getByText("Candidate SHA:")).toBeVisible();
  await expect(page.getByText("Live Freshness (≤10s):")).toBeVisible();

  // Test Cancel button closes dialog cleanly
  const cancelBtn = page.getByRole("button", { name: "Cancel" });
  await expect(cancelBtn).toBeVisible();
  await cancelBtn.click();
  await expect(page.locator("#consequential-action-dialog")).toBeHidden();

  // Test Keyboard Accessibility (Escape closes modal)
  await btnPromoteModal.click({ force: true });
  await expect(page.locator("#consequential-action-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#consequential-action-dialog")).toBeHidden();

  // Cleanup
  await stop(preview);
});
