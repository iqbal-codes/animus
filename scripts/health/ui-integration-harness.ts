import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";

// Manual UI verification harness for child integration. It builds the same
// backend kernel/temp SQLite/git/bare-origin world used by the integration tests
// and exposes it to a real browser; no production fixture mode is involved.
const root = mkdtempSync(join(tmpdir(), "animus-integration-ui-"));
process.env.ANIMUS_HOME = join(root, "home");
writeExecutionAuthority("local");
const checkout = join(root, "checkout");
mkdirSync(checkout);
const bareOrigin = join(root, "origin.git");
execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
function git(args: string[], cwd = checkout): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}
function remoteHead(branch: string): string | null {
  try {
    return (
      execFileSync(
        "git",
        ["--git-dir", bareOrigin, "rev-parse", "--verify", `refs/heads/${branch}`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || null
    );
  } catch {
    return null;
  }
}
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "harness@test.local"]);
git(["config", "user.name", "UI Harness"]);
git(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
git(["config", `url.${bareOrigin}.insteadOf`, "https://github.com/owner/repo.git"]);
writeFileSync(join(checkout, "baseline.txt"), "baseline\n");
git(["add", "baseline.txt"]);
git(["commit", "-q", "-m", "baseline"]);
git(["push", "-q", "origin", "main"]);

const specBody = [
  "## Source and problem",
  "Verify child integration from the operator console.",
  "## Outcome",
  "An approved child runs through gates and integrates safely.",
  "## Invariants",
  "- No live forge rebinding.",
  "## Acceptance criteria",
  "- [ ] AC1 — child integration is verified.",
  "## Boundary",
  "Child gate integration.",
].join("\n\n");
const childBody = [
  "Part of #700",
  "",
  "Source acceptance coverage: AC1",
  "",
  "## Source and problem",
  "Prepared child source.",
  "## Outcome",
  "Prepared child outcome.",
  "## Invariants",
  "- Keep the invariant.",
  "## Acceptance criteria",
  "- [ ] AC1: prepared criterion",
  "## Boundary",
  "Prepared child boundary.",
  "Depends on: None",
].join("\n\n");

const forge = new SyntheticForgeAdapter(
  { "owner/repo": 914 },
  {
    requireRemoteSourceRef: true,
    resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
    mergeRemote: (_repo, pr) => {
      const headSha = pr.headRefOid ?? remoteHead(pr.head);
      const baseSha = remoteHead(pr.base);
      if (!headSha || !baseSha) throw new Error("missing remote refs");
      const treeSha = git(["merge-tree", "--write-tree", baseSha, headSha]).split("\n")[0]!.trim();
      const mergeSha = git([
        "commit-tree",
        treeSha,
        "-p",
        baseSha,
        "-p",
        headSha,
        "-m",
        `merge ${pr.head}`,
      ]);
      git(["update-ref", `refs/heads/${pr.base}`, mergeSha, baseSha]);
      git(["push", "-q", "origin", `refs/heads/${pr.base}`]);
      return { sha: mergeSha };
    },
  },
);
forge.addIssue("owner/repo", {
  number: 700,
  title: "Child integration verification",
  body: specBody,
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }, { name: "spec" }],
  comments: [],
});
forge.addIssue("owner/repo", {
  number: 701,
  title: "Verify a blocked child integration",
  body: childBody,
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }],
  comments: [],
});

const app = await createBackendApp({
  stateDir: join(root, "state"),
  startMonitor: false,
  forge,
  webDir: fileURLToPath(new URL("../../apps/web/dist", import.meta.url)),
  dispatch: {
    runner: async (context) => {
      writeFileSync(join(context.worktree_path, "child.txt"), "verified child change\n");
      git(["add", "child.txt"], context.worktree_path);
      git(["commit", "-q", "-m", "child verification"], context.worktree_path);
      return { success: true, headSha: git(["rev-parse", "HEAD"], context.worktree_path) };
    },
  },
});
const project = await new ProjectRegistryService(app.db, forge).registerProject({
  method: "local_checkout",
  name: "Child integration verification",
  checkout_path: checkout,
});
const branch = "factory/spec-700-integration";
git(["branch", branch, "main"]);
git(["push", "-q", "origin", branch]);

async function projectFetch(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1/api/v1/projects/${project.id}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    }),
  );
}
async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await projectFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Seed ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

const importResponse = await projectFetch("/plans/import", {
  method: "POST",
  body: JSON.stringify({ issue_number: 700, kind: "spec" }),
});
if (!importResponse.ok) throw new Error(`Plan import failed: ${await importResponse.text()}`);
const plan = (await importResponse.json()) as { id: string };

const dispatchResponse = await projectFetch("/dispatch", {
  method: "POST",
  body: JSON.stringify({ plan_id: plan.id, issue_number: 701, actor: "operator" }),
});
if (!dispatchResponse.ok)
  throw new Error(`Child dispatch failed: ${await dispatchResponse.text()}`);
const run = (await dispatchResponse.json()) as { id: string };

const producers = new ExecutionObservationService(app.db);
const gate = producers.registerTrustedProducer(project.id, {
  id: "gate-ui",
  role: "automated_gate",
});
await postJson("/evidence/observations", {
  run_id: run.id,
  producer_credential: gate.credential,
  stage: "technical_checks",
  status: "passed",
  checks: [{ name: "unit", command: "bun test", result: "PASS" }],
});
const publishResponse = await projectFetch(
  `/publication/runs/${encodeURIComponent(run.id)}/publish`,
  {
    method: "POST",
  },
);
if (!publishResponse.ok) throw new Error(`Publication failed: ${await publishResponse.text()}`);
const integrationResponse = await projectFetch(`/integration/runs/${encodeURIComponent(run.id)}`);
if (!integrationResponse.ok)
  throw new Error(`Integration read failed: ${await integrationResponse.text()}`);
const integration = (await integrationResponse.json()) as {
  state: string;
  blockers: Array<{ code: string }>;
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => app.fetch(request),
  websocket: app.websocket,
});
console.log(
  JSON.stringify({
    url: server.url.origin,
    project_id: project.id,
    plan_id: plan.id,
    run_id: run.id,
    integration,
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
