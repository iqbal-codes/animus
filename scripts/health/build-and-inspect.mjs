import { build } from "vite-plus";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const modules = new Set();
const forbidden = [
  "FACTORY_HOST_TOKEN",
  "FACTORY_HOST_URL",
  "FACTORY_BACKEND_URL",
  "OPENROUTER_API_KEY",
  "JEV_API_KEY",
  "bun:",
  "node:",
];
await build({
  root: `${root}apps/web`,
  configFile: `${root}apps/web/vite.config.ts`,
  plugins: [
    {
      name: "inspect-client-authority",
      generateBundle() {
        for (const id of this.getModuleIds()) {
          modules.add(id);
          if (
            id.includes("/apps/backend/") ||
            id.includes("/apps/engine-host/") ||
            id.includes("/contracts/src/host") ||
            id.includes("__vite-browser-external") ||
            /^(node:|bun:)/.test(id)
          )
            throw new Error("Private server module entered browser graph");
        }
      },
    },
  ],
});
/** @param {string} directory */
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await inspect(path);
    else {
      const text = await readFile(path, "utf8");
      const envValues = /** @type {string[]} */ (
        [
          process.env.FACTORY_HOST_TOKEN,
          process.env.OPENROUTER_API_KEY,
          process.env.JEV_API_KEY,
        ].filter(Boolean)
      );
      for (const value of [...forbidden, ...envValues]) {
        if (!value) continue;
        const isForbidden =
          value === "node:" || value === "bun:"
            ? /(["'`])(node|bun):[a-z]/.test(text)
            : text.includes(value);
        if (isForbidden) throw new Error("Private configuration entered browser artifact");
      }
    }
  }
}
await inspect(`${root}apps/web/dist`);
console.log(`Browser authority inspection passed: ${modules.size} modules; built assets inspected`);
