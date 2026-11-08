import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";

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
const plans = new Map<number, string>();
for (const number of [500, 501]) {
  const response = await app.fetch(
    new Request(`http://127.0.0.1/api/v1/projects/${project.id}/plans/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_number: number, kind: "standalone" }),
    }),
  );
  if (!response.ok) throw new Error(`Admission failed: ${await response.text()}`);
  plans.set(number, ((await response.json()) as { id: string }).id);
}

// Seed a real candidate-bound evidence trail for the successful delivery so the
// operator surface renders actual checks, findings, artifacts and acceptance.
// Producer credentials are minted by the trusted host boundary; the observation,
// fix and recheck writes then go through the public HTTP route exactly as an
// independent reviewer/gate client would.
const dispatchResponse = await app.fetch(
  new Request(`http://127.0.0.1/api/v1/projects/${project.id}/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan_id: plans.get(500), actor: "operator" }),
  }),
);
if (!dispatchResponse.ok) throw new Error(`Seed dispatch failed: ${await dispatchResponse.text()}`);
const seedRun = (await dispatchResponse.json()) as { id: string };
const producers = new ExecutionObservationService(app.db);
const gateCredential = producers.registerTrustedProducer(project.id, {
  id: "gate-1",
  role: "automated_gate",
});
const fixerCredential = producers.registerTrustedProducer(project.id, {
  id: "operator",
  role: "peer_reviewer",
});
const reviewerCredential = producers.registerTrustedProducer(project.id, {
  id: "reviewer-2",
  role: "peer_reviewer",
});

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await app.fetch(
    new Request(`http://127.0.0.1/api/v1/projects/${project.id}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) {
    throw new Error(`Seed write ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

const artifactDir = join(root, "home", "state", "artifacts", project.id, "checks");
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, "report.log"), "independent review passed\n");
await postJson("/evidence/observations", {
  run_id: seedRun.id,
  producer_credential: gateCredential.credential,
  stage: "technical_checks",
  status: "failed",
  checks: [{ name: "unit", command: "bun test", result: "FAIL", detail: "1 failing" }],
  findings: [
    {
      severity: "blocking",
      acKey: "AC1",
      fileContext: "apps/backend/src/example.ts:10",
      summary: "prepared criterion is not implemented",
    },
  ],
});
const findingsResponse = await app.fetch(
  new Request(
    `http://127.0.0.1/api/v1/projects/${project.id}/evidence/findings?run_id=${encodeURIComponent(seedRun.id)}`,
  ),
);
if (!findingsResponse.ok)
  throw new Error(`Seed findings read failed: ${await findingsResponse.text()}`);
const seedFindings = (await findingsResponse.json()) as Array<{ id: string }>;
const seedFinding = seedFindings[0];
if (!seedFinding) throw new Error("Seed finding was not persisted");
await postJson(`/evidence/findings/${encodeURIComponent(seedFinding.id)}/fix`, {
  producer_credential: fixerCredential.credential,
  detail: "builder claims fixed",
});
await postJson(`/evidence/findings/${encodeURIComponent(seedFinding.id)}/recheck`, {
  producer_credential: reviewerCredential.credential,
  status: "passed",
  checks: [
    { name: "unit", command: "bun test", result: "PASS", artifactPath: "checks/report.log" },
  ],
  artifacts: [
    {
      ownerType: "observation",
      name: "unit-report",
      relativePath: "checks/report.log",
      mediaType: "text/plain",
    },
  ],
});

// Publish the real candidate through the public route and the injected forge
// transport. This proves the operator audit panel is reading durable local state,
// not a UI fixture.
const publicationBeforeResponse = await app.fetch(
  new Request(
    `http://127.0.0.1/api/v1/projects/${project.id}/publication/runs/${encodeURIComponent(seedRun.id)}`,
  ),
);
if (!publicationBeforeResponse.ok)
  throw new Error(`Seed publication read failed: ${await publicationBeforeResponse.text()}`);
const publishResponse = await app.fetch(
  new Request(
    `http://127.0.0.1/api/v1/projects/${project.id}/publication/runs/${encodeURIComponent(seedRun.id)}/publish`,
    { method: "POST" },
  ),
);
if (!publishResponse.ok)
  throw new Error(`Seed publication failed: ${await publishResponse.text()}`);
const seededPublication = (await publishResponse.json()) as {
  auditComplete: boolean;
  queuedEventCount: number;
  pullRequests: Array<{ number: number; url: string | null; draft: boolean }>;
};
if (!seededPublication.auditComplete || seededPublication.pullRequests.length !== 1) {
  throw new Error(`Seed publication is not complete: ${JSON.stringify(seededPublication)}`);
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
    run_id: seedRun.id,
    publication: seededPublication,
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
