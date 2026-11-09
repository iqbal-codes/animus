import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { seedActivatedAuthorityAt } from "../../tests/integration/support/activated-authority";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";

// Manual UI/persistence verification only: the process boundary commits locally,
// while the real application owns admission, claims, worktrees, and run records.
const root = mkdtempSync(join(tmpdir(), "animus-dispatch-ui-"));
process.env.ANIMUS_HOME = join(root, "home");
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
git(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
git(["config", `url.${bareOrigin}.insteadOf`, "https://github.com/owner/repo.git"]);
git(["commit", "--allow-empty", "-q", "-m", "baseline"]);
git(["push", "-q", "origin", "main"]);
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
const forge = new SyntheticForgeAdapter(
  { "owner/repo": 913 },
  {
    requireRemoteSourceRef: true,
    resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
  },
);
for (const [number, title] of [
  [500, "Verify local dispatch from the operator console"],
  [501, "Verify an honest launch failure"],
  [502, "Verify bounded attempt escalation"],
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
      if (context.issue_number === 501 || context.issue_number === 502)
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
for (const number of [500, 501, 502]) {
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
const finalCredential = producers.registerTrustedProducer(project.id, {
  id: "final-1",
  role: "independent_evaluator",
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
    {
      name: "unit",
      command: "bun test",
      result: "PASS",
      kind: "review",
      artifactPath: "checks/report.log",
    },
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
await postJson("/evidence/observations", {
  run_id: seedRun.id,
  producer_credential: reviewerCredential.credential,
  stage: "independent_review",
  status: "passed",
  checks: [
    {
      name: "standards and spec review",
      command: "review candidate diff",
      result: "PASS",
      kind: "review",
    },
  ],
});
await postJson("/evidence/observations", {
  run_id: seedRun.id,
  producer_credential: finalCredential.credential,
  stage: "final_acceptance",
  status: "passed",
  checks: [
    {
      name: "AC1 black-box",
      command: "acceptance AC1",
      result: "PASS",
      kind: "acceptance",
      criterionKey: "AC1",
    },
    { name: "regression", command: "bun test targeted", result: "PASS", kind: "regression" },
    { name: "remote ci", command: "gh pr checks", result: "PASS", kind: "remote_ci" },
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
const publicationBefore = (await publicationBeforeResponse.json()) as {
  target: { id: string };
};
const runEvidenceResponse = await app.fetch(
  new Request(
    `http://127.0.0.1/api/v1/projects/${project.id}/evidence/runs/${encodeURIComponent(seedRun.id)}`,
  ),
);
if (!runEvidenceResponse.ok)
  throw new Error(`Seed run evidence read failed: ${await runEvidenceResponse.text()}`);
const runEvidence = (await runEvidenceResponse.json()) as {
  observations: Array<{ artifacts: Array<{ id: string }> }>;
};
const seedArtifact = runEvidence.observations.flatMap((observation) => observation.artifacts)[0];
if (!seedArtifact) throw new Error("Seed artifact was not persisted");
await postJson(
  `/publication/targets/${encodeURIComponent(publicationBefore.target.id)}/evidence/${encodeURIComponent(seedArtifact.id)}/bind`,
  { hosted_url: "https://github.com/user-attachments/assets/report.png" },
);
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
const seededGateResponse = await app.fetch(
  new Request(
    `http://127.0.0.1/api/v1/projects/${project.id}/delivery/runs/${encodeURIComponent(seedRun.id)}`,
  ),
);
if (!seededGateResponse.ok) {
  throw new Error(`Seed delivery gate read failed: ${await seededGateResponse.text()}`);
}
const seededGate = (await seededGateResponse.json()) as {
  state: string;
  merge: { state: string; verified: boolean };
  manualMergeRequired: boolean;
  stages: Array<{ name: string; status: string }>;
};
if (
  seededGate.state !== "ready_for_operator_review" ||
  !seededGate.manualMergeRequired ||
  seededGate.merge.state !== "not_merged"
) {
  throw new Error(
    `Seed delivery gate is not ready for operator review: ${JSON.stringify(seededGate)}`,
  );
}
// Exhaust a second ticket, grant one explicit attempt, reject it, then hold the work.
// This is real backend state so the operator surface renders Needs owner, retained
// workspace, prior attempts, grant history and control state without fixtures.
async function dispatchAttempt(planId: string): Promise<number> {
  const response = await app.fetch(
    new Request(`http://127.0.0.1/api/v1/projects/${project.id}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: planId, actor: "operator" }),
    }),
  );
  return response.status;
}
const exhaustPlanId = plans.get(502)!;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const status = await dispatchAttempt(exhaustPlanId);
  if (status !== 502) throw new Error(`Expected rejected dispatch ${attempt}, got ${status}`);
}
const exhaustedRunsResponse = await app.fetch(
  new Request(
    `http://127.0.0.1/api/v1/projects/${project.id}/dispatch/runs?plan_id=${encodeURIComponent(exhaustPlanId)}`,
  ),
);
const exhaustedRuns = (await exhaustedRunsResponse.json()) as Array<{ id: string }>;
const exhaustedRunId = exhaustedRuns[0]?.id;
if (!exhaustedRunId) throw new Error("Exhausted run was not persisted");
await postJson(`/dispatch/runs/${encodeURIComponent(exhaustedRunId)}/grant`, {
  amount: 1,
  reason: "operator reviewed the failure and allows one more attempt",
  actor: "operator",
  idempotency_key: "ui-grant-1",
});
const fourthStatus = await dispatchAttempt(exhaustPlanId);
if (fourthStatus !== 502) throw new Error(`Expected rejected granted attempt, got ${fourthStatus}`);
await postJson(`/dispatch/runs/${encodeURIComponent(exhaustedRunId)}/control`, {
  action: "hold",
  actor: "operator",
  reason: "await operator review of exhausted budget",
});

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
    delivery_gate: seededGate,
    plan_ids: Object.fromEntries(plans),
    exhausted_run_id: exhaustedRunId,
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
