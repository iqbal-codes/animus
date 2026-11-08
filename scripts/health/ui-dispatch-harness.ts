import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";

// Manual UI/persistence verification only: the process boundary commits locally,
// while the real application owns admission, claims, worktrees, and run records.
const root = mkdtempSync(join(tmpdir(), "animus-dispatch-ui-"));
process.env.ANIMUS_HOME = join(root, "home");
writeExecutionAuthority("local");
const checkout = join(root, "checkout");
mkdirSync(checkout);
function git(args: string[], cwd = checkout): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "harness@test.local"]);
git(["config", "user.name", "UI Harness"]);
git(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
git(["commit", "--allow-empty", "-q", "-m", "baseline"]);
const body = [
  "## Source and problem",
  "Verify local dispatch from the operator console.",
  "## Outcome",
  "A frozen plan produces a persisted run.",
  "## Invariants",
  "- No live forge rebinding.",
  "## Acceptance criteria",
  "- [ ] AC1: Dispatch records the frozen profile and merge policy.",
  "## Boundary",
  "Operator dispatch and persistence.",
  "Depends on: None",
].join("\n\n");
const forge = new SyntheticForgeAdapter({ "owner/repo": 913 });
for (const [number, title] of [
  [500, "Verify local dispatch from the operator console"],
  [501, "Verify an honest launch failure"],
] as const) {
  forge.addIssue("owner/repo", {
    number,
    title,
    body,
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    comments: [],
  });
}
const app = await createBackendApp({
  stateDir: join(root, "state"),
  startMonitor: false,
  forge,
  webDir: fileURLToPath(new URL("../../apps/web/dist", import.meta.url)),
  dispatch: {
    runner: async (context) => {
      if (context.issue_number === 501)
        return { success: false, error: "Offline process transport refused" };
      writeFileSync(join(context.worktree_path, "dispatch.txt"), "verified local dispatch\n");
      git(["add", "dispatch.txt"], context.worktree_path);
      git(["commit", "-q", "-m", "dispatch verification"], context.worktree_path);
      return { success: true, headSha: git(["rev-parse", "HEAD"], context.worktree_path) };
    },
  },
});
const project = await new ProjectRegistryService(app.db, forge).registerProject({
  method: "local_checkout",
  name: "Dispatch verification",
  checkout_path: checkout,
});
for (const number of [500, 501]) {
  const response = await app.fetch(
    new Request(`http://127.0.0.1/api/v1/projects/${project.id}/plans/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_number: number, kind: "standalone" }),
    }),
  );
  if (!response.ok) throw new Error(`Admission failed: ${await response.text()}`);
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => app.fetch(request),
  websocket: app.websocket,
});
console.log(JSON.stringify({ url: server.url.origin, project_id: project.id, root }));
async function shutdown() {
  await server.stop(true);
  await app.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
