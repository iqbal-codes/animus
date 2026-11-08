import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { PlanService } from "../../apps/backend/src/plans";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService } from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { seedActivatedAuthorityAt } from "../../tests/integration/support/activated-authority";

// Manual UI/persistence verification for workspace backup/restore. The harness
// uses real SQLite, real files and a local bare git origin; it never touches a
// live Animus home outside its temporary root.
const root = mkdtempSync(join(tmpdir(), "animus-backup-ui-"));
process.env.ANIMUS_HOME = root;
seedActivatedAuthorityAt(join(root, "state"));
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
git(["remote", "add", "origin", "https://github.com/owner/backup-ui.git"]);
git(["config", `url.${bareOrigin}.insteadOf`, "https://github.com/owner/backup-ui.git"]);
git(["commit", "--allow-empty", "-q", "-m", "baseline"]);
git(["push", "-q", "origin", "main"]);

const body = [
  "## Source and problem",
  "Verify workspace backup and restore from the operator console.",
  "## Outcome",
  "A verified bundle restores into an isolated held home.",
  "## Invariants",
  "- No live process or uncommitted edit is claimed as restored.",
  "## Acceptance criteria",
  "- [ ] AC1: backup is verified and restorable.",
  "## Boundary",
  "Installation-level backup and restore.",
  "Depends on: None",
].join("\n\n");

const forge = new SyntheticForgeAdapter(
  { "owner/backup-ui": 913 },
  { requireRemoteSourceRef: true, resolveHeadRefOid: (_repo, branch) => remoteHead(branch) },
);
forge.addIssue("owner/backup-ui", {
  number: 900,
  title: "Verify workspace backup from the operator console",
  body,
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }],
  comments: [],
});
forge.addIssue("owner/backup-ui", {
  number: 901,
  title: "Interrupted run for the held restore surface",
  body,
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }],
  comments: [],
});

const app = await createBackendApp({
  stateDir: join(root, "state"),
  startMonitor: false,
  forge,
  webDir: fileURLToPath(new URL("../../apps/web/dist", import.meta.url)),
});
const registry = new ProjectRegistryService(app.db, forge);
const project = await registry.registerProject({
  method: "local_checkout",
  name: "Backup verification",
  checkout_path: checkout,
});
const plans = new PlanService(app.db, forge);
const plan = await plans.importPlan(project.id, { issue_number: 900, kind: "standalone" });
const dispatch = new DispatchService(app.db, {
  plans,
  ledger: new CommandLedger(app.db),
  brakes: new BrakeService(app.db),
  processAlive: () => true,
  ownerPid: () => 4242,
  runner: async (context) => {
    writeFileSync(join(context.worktree_path, "backup.txt"), "verified\n");
    git(["add", "backup.txt"], context.worktree_path);
    git(["commit", "-q", "-m", "backup verification"], context.worktree_path);
    return { success: true, headSha: git(["rev-parse", "HEAD"], context.worktree_path) };
  },
});
const completedRun = await dispatch.dispatch(project.id, {
  plan_id: plan.id,
  actor: "operator",
});

// Real candidate-bound evidence creates durable pending publication intents, so
// a held restore has external intents for the operator to disposition.
const observations = new ExecutionObservationService(app.db);
const reviewer = observations.registerTrustedProducer(project.id, {
  id: "ui-reviewer",
  role: "peer_reviewer",
});
const artifactRelativePath = "evidence/ui-review.log";
mkdirSync(join(root, "state", "artifacts", project.id, "evidence"), { recursive: true });
writeFileSync(
  join(root, "state", "artifacts", project.id, artifactRelativePath),
  "held restore review artifact\n",
);
observations.recordRunObservation(project.id, completedRun.id, {
  stage: "independent_review",
  status: "failed",
  producer: reviewer.producer,
  checks: [{ name: "review", command: "review", result: "FAIL", detail: "needs work" }],
  findings: [
    {
      severity: "blocking",
      acKey: "AC1",
      fileContext: "backup.txt:1",
      summary: "ui harness blocking finding",
    },
  ],
  artifacts: [
    {
      ownerType: "finding",
      ownerFindingIndex: 0,
      name: "ui review log",
      relativePath: artifactRelativePath,
      mediaType: "text/plain",
    },
  ],
});

// A genuinely active run is captured by the backup and interrupted by restore.
const interruptedPlan = await plans.importPlan(project.id, {
  issue_number: 901,
  kind: "standalone",
});
const interruptedDispatch = new DispatchService(app.db, {
  plans,
  ledger: new CommandLedger(app.db),
  brakes: new BrakeService(app.db),
  processAlive: () => true,
  ownerPid: () => 4242,
  runner: () => new Promise(() => {}),
});
void interruptedDispatch.dispatch(project.id, {
  plan_id: interruptedPlan.id,
  actor: "operator",
});
for (let attempt = 0; attempt < 200; attempt += 1) {
  const run = interruptedDispatch.listRuns(project.id, { plan_id: interruptedPlan.id })[0];
  if (run?.state === "running" || run?.state === "dispatched") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const bundle = join(root, "bundles", "runtime");
const backupResponse = await app.fetch(
  new Request("http://127.0.0.1/api/v1/backups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destinationPath: bundle, actor: "operator" }),
  }),
);
if (!backupResponse.ok) {
  throw new Error(`Backup seed failed: ${await backupResponse.text()}`);
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
    project_id: project.id,
    bundle,
    restored_state: join(root, "restored", "state"),
    restored_home: join(root, "restored"),
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
