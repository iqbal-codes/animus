import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * @param {string} file
 * @returns {string}
 */
const readPinned = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
    .trim()
    .replace(/^v/, "");
const nodeVersion = readPinned(".node-version");
const bunVersion = readPinned(".bun-version");
const bun = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
const vite = JSON.parse(
  readFileSync(new URL("../../node_modules/vite-plus/package.json", import.meta.url), "utf8"),
).version;

if (process.versions.bun) {
  throw new Error(`Run repository tooling with Node ${nodeVersion}, not Bun ${bun}.`);
}
if (process.version !== `v${nodeVersion}`) {
  throw new Error(
    `Use Node ${nodeVersion}; found ${process.version}. No global runtime is modified.`,
  );
}
if (bun !== bunVersion) {
  throw new Error(`Use Bun ${bunVersion}; found ${bun}. No global runtime is modified.`);
}
if (vite !== "1.4.0") {
  throw new Error(`Use local Vite+ 1.4.0; found ${vite}.`);
}
console.log(`Tooling Node ${process.version}; applications Bun ${bun}; local Vite+ ${vite}`);
