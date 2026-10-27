import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** @returns {Promise<number>} */
async function getAvailablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise((r) => server.close(r));
  return port;
}

/**
 * @param {string} repoRoot
 * @param {string} outputDir
 * @returns {Promise<string[]>}
 */
export async function captureOperatorScreenshots(repoRoot, outputDir) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const webPort = await getAvailablePort();
  const webUrl = `http://127.0.0.1:${webPort}`;

  const preview = spawn(
    "node",
    [
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
    { cwd: repoRoot, stdio: "ignore" },
  );

  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(webUrl);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const captured = [];
  try {
    if (ready) {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(webUrl, { waitUntil: "domcontentloaded" });

      const desktopFile = join(outputDir, "operator-desktop.png");
      await page.screenshot({ path: desktopFile });
      captured.push(desktopFile);

      await browser.close();
    }
  } finally {
    preview.kill("SIGTERM");
  }

  return captured;
}

if (process.argv[1]?.endsWith("capture-screenshots.mjs")) {
  const root = process.cwd();
  const outDir = process.env.OUT_DIR || join(root, "artifacts/screenshots");
  void captureOperatorScreenshots(root, outDir).then((files) => {
    console.log(`Captured ${files.length} screenshots:`, files);
    process.exit(0);
  });
}
