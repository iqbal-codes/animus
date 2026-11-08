import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { BackupRestoreService } from "../../apps/backend/src/restore/service";
import { AuthorityCutoverService } from "../../apps/backend/src/cutover";
import { readExecutionAuthority } from "@animus/contracts/execution-authority";

// Real operator-app harness for the #165 authority surface. It uses a disposable
// home only, real SQLite and the built web app. STATE=legacy|staged|local.
const target = (process.env.AUTHORITY_STATE ?? "legacy").trim();
if (!["legacy", "staged", "local"].includes(target)) {
  throw new Error(`Unknown AUTHORITY_STATE: ${target}`);
}

const root = mkdtempSync(join(tmpdir(), "animus-authority-ui-"));
process.env.ANIMUS_HOME = root;
const stateDir = join(root, "state");
const checkout = join(root, "checkout");
mkdirSync(checkout);
execFileSync("git", ["init", "-q", "-b", "main", checkout]);
execFileSync("git", ["-C", checkout, "config", "user.email", "harness@test.local"]);
execFileSync("git", ["-C", checkout, "config", "user.name", "UI Harness"]);
execFileSync("git", [
  "-C",
  checkout,
  "remote",
  "add",
  "origin",
  "https://github.com/owner/authority-ui.git",
]);
execFileSync("git", ["-C", checkout, "commit", "--allow-empty", "-q", "-m", "baseline"]);

const forge = new SyntheticForgeAdapter({ "owner/authority-ui": 971 });
const app = await createBackendApp({
  stateDir,
  startMonitor: false,
  forge,
  webDir: fileURLToPath(new URL("../../apps/web/dist", import.meta.url)),
});
const registry = new ProjectRegistryService(app.db, forge);
await registry.registerProject({
  method: "local_checkout",
  name: "Authority verification",
  checkout_path: checkout,
});
const backup = new BackupRestoreService(app.db, { stateDir, forge });
const cutover = new AuthorityCutoverService(app.db, { stateDir, backup });

if (target !== "legacy") {
  const staged = await cutover.stage({ actor: "operator" });
  if (target === "local") {
    await cutover.activate({
      actor: "operator",
      cutoverId: staged.operation.id,
      inventorySha256: staged.operation.inventorySha256!,
      backupManifestSha256: staged.operation.backupManifestSha256!,
    });
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => app.fetch(request),
  websocket: app.websocket,
});
console.log(
  JSON.stringify({
    url: server.url.origin,
    state: target,
    authority: readExecutionAuthority(stateDir).authority,
    root,
  }),
);

async function shutdown() {
  await server.stop(true);
  await app.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
