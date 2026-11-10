import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { serve } from "bun";

const PORT = 3591;
const DIST = resolve("apps/web/dist");

// Start Bun static server for apps/web/dist
const server = serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    let filePath = `${DIST}${url.pathname}`;
    if (url.pathname === "/" || !url.pathname.includes(".")) {
      filePath = `${DIST}/index.html`;
    }
    const file = Bun.file(filePath);
    return new Response(file);
  },
});

console.log(`Server listening at http://localhost:${PORT}`);

const MENUS = [
  {
    id: "01-personal-preferences",
    scope: "personal",
    section: "preferences",
    name: "Personal / Preferences",
  },
  {
    id: "02-platform-system",
    scope: "platform",
    section: "system",
    name: "Platform / System",
  },
  {
    id: "03-platform-providers",
    scope: "platform",
    section: "providers",
    name: "Platform / Providers",
  },
  {
    id: "04-platform-automation",
    scope: "platform",
    section: "automation",
    name: "Platform / Automation",
  },
  {
    id: "05-platform-github",
    scope: "platform",
    section: "github",
    name: "Platform / GitHub",
  },
  {
    id: "06-project-models",
    scope: "project",
    section: "models",
    name: "Project / Models",
  },
  {
    id: "07-project-checks",
    scope: "project",
    section: "checks",
    name: "Project / Checks",
  },
  {
    id: "08-project-memory",
    scope: "project",
    section: "memory",
    name: "Project / Memory",
  },
  {
    id: "09-project-releases",
    scope: "project",
    section: "releases",
    name: "Project / Releases",
  },
];

async function capture() {
  const playwrightBin = "/Users/efishery/.vite-plus/bin/playwright";

  for (const m of MENUS) {
    const url = `http://localhost:${PORT}/?settings=true&scope=${m.scope}&section=${m.section}`;
    const outputPath = resolve(`docs/design/evidence/settings/${m.id}.png`);
    console.log(`Capturing ${m.name} -> ${outputPath}`);

    await new Promise<void>((res, rej) => {
      const proc = spawn(
        playwrightBin,
        [
          "screenshot",
          "--channel",
          "chrome",
          "--wait-for-timeout",
          "800",
          "--viewport-size",
          "1280, 960",
          url,
          outputPath,
        ],
        { stdio: "inherit" },
      );
      proc.on("close", (code) => {
        if (code === 0) res();
        else rej(new Error(`Exit code ${code}`));
      });
    });
  }

  console.log("All screenshots captured successfully!");
  server.stop();
  process.exit(0);
}

capture().catch((err) => {
  console.error("Capture failed:", err);
  server.stop();
  process.exit(1);
});
