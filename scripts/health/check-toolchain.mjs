import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bun = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
const vite = JSON.parse(
  readFileSync(new URL("../../node_modules/vite-plus/package.json", import.meta.url), "utf8"),
).version;
if (process.versions.bun || process.version !== "v26.8.1" || bun !== "1.4.2" || vite !== "1.4.0") {
  throw new Error(
    "Use Node 26.8.1, Bun 1.4.2 on PATH and frozen local Vite+ 1.4.0; no global runtime is modified.",
  );
}
console.log(`Tooling Node ${process.version}; applications Bun ${bun}; local Vite+ ${vite}`);
