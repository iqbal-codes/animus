import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendApp } from "../../apps/backend/src/main";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { PlanService } from "../../apps/backend/src/plans";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService } from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../../apps/backend/src/work/budget";
import { PublicationService } from "../../apps/backend/src/publication";
import { DeliveryGateService, DeliveryRuntimeCoordinator } from "../../apps/backend/src/delivery";
import { ChildIntegrationService } from "../../apps/backend/src/integration";
import { FinalDeliveryService } from "../../apps/backend/src/final";
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthorityAt } from "../../tests/integration/support/activated-authority";

// Manual UI verification harness for the operator board. It seeds a real kernel
// database (temp SQLite, git worktrees and bare origin) with an offline forge and
// model transport, then serves the final-source web build. No fixture mode.
const root = mkdtempSync(join(tmpdir(), "animus-board-ui-"));
process.env.ANIMUS_HOME = join(root, "home");
seedActivatedAuthorityAt(join(root, "state"));
const artifactRoot = join(root, "home", "state", "artifacts");
const db = initializeDatabase(join(root, "state", "console.db"));
const checkout = join(root, "checkout");
mkdirSync(checkout);
const bareOrigin = join(root, "origin.git");
execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
const REPO = "owner/board-ui";

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
git(["remote", "add", "origin", `https://github.com/${REPO}.git`]);
git(["config", `url.${bareOrigin}.insteadOf`, `https://github.com/${REPO}.git`]);
writeFileSync(join(checkout, "baseline.txt"), "baseline\n");
git(["add", "baseline.txt"]);
git(["commit", "-q", "-m", "baseline"]);
git(["push", "-q", "origin", "main"]);
mkdirSync(join(checkout, ".factory"), { recursive: true });
writeFileSync(join(checkout, ".factory", "schedule.json"), '{"max_laps":3,"parallel":3}\n');

function specBody(criteria: string[]): string {
  return [
    "## Source and problem",
    "",
    "The operator needs truthful parent progress, child activity, PRs, lap history, findings and retained stuck work visible on the existing board.",
    "",
    "## Outcome",
    "",
    "Parent progress and child references appear on the existing cards without a new board structure.",
    "",
    "## Invariants",
    "",
    "- Existing columns, ordering, layout and card styling stay unchanged.",
    "- Integrated children never falsely complete the parent.",
    "- Counts distinguish specs, executable tickets and actual workers.",
    "",
    "## Acceptance criteria",
    "",
    ...criteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "## Boundary",
    "",
    "Existing application modules only; no second engine or metric store.",
  ].join("\n");
}

function ticketBody(options: {
  partOf?: number;
  dependsOn?: number[];
  coverage?: string;
  long?: boolean;
}): string {
  const lines: string[] = [];
  if (options.partOf) lines.push(`Part of #${options.partOf}`, "");
  if (options.coverage) lines.push(`Source acceptance coverage: ${options.coverage}`, "");
  lines.push(
    "## Source and problem",
    "",
    options.long
      ? "This ticket carries a deliberately long contract body so the detail view is exercised with wrapped text instead of a short placeholder. ".repeat(
          8,
        )
      : "Prepared ticket source.",
    "",
    "## Outcome",
    "",
    "Prepared ticket outcome.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1: prepared criterion",
    "",
    "## Boundary",
    "",
    "Prepared ticket boundary.",
    "",
    options.dependsOn && options.dependsOn.length > 0
      ? `Depends on: ${options.dependsOn.map((number) => `#${number}`).join(", ")}`
      : "Depends on: None",
  );
  return lines.join("\n");
}

function addIssue(number: number, title: string, body: string, labels: string[]): void {
  forge.addIssue(REPO, {
    number,
    title,
    body,
    state: "OPEN",
    labels: labels.map((name) => ({ name })),
    comments: [],
  });
}

const mergeOnBareOrigin = (_repo: string, pr: ForgePullRequest): { sha: string } => {
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
};
const forge = new SyntheticForgeAdapter(
  { [REPO]: 1900 },
  {
    requireRemoteSourceRef: true,
    resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
    mergeRemote: mergeOnBareOrigin,
  },
);

const registry = new ProjectRegistryService(db, forge);
const project = await registry.registerProject({
  method: "local_checkout",
  name: "Operator board",
  checkout_path: checkout,
});
const plans = new PlanService(db, forge);
const ledger = new CommandLedger(db);
const brakes = new BrakeService(db);
const observations = new ExecutionObservationService(db, { artifactRoot });
const budget = new ExecutionBudgetService(db);
const publication = new PublicationService(db, forge);
const gate = new DeliveryGateService(db, { observations, publication, forge });

function committingRunner() {
  return async (context: {
    worktree_path: string;
    issue_number: number;
    run_id: string;
  }): Promise<{ success: boolean; headSha: string }> => {
    const name = `impl-${context.issue_number}-${context.run_id.slice(0, 6)}.txt`;
    writeFileSync(join(context.worktree_path, name), "implemented\n");
    git(["add", name], context.worktree_path);
    git(["commit", "-q", "-m", `implement ${name}`], context.worktree_path);
    return { success: true, headSha: git(["rev-parse", "HEAD"], context.worktree_path) };
  };
}

const dispatch = new DispatchService(db, {
  plans,
  ledger,
  brakes,
  observations,
  budget,
  runner: committingRunner(),
});
const integration = new ChildIntegrationService(db, { observations, publication, forge });

const transport: AgentTransport = async (request) => {
  const head = git(["rev-parse", "HEAD"], request.cwd);
  const report =
    request.role === "reviewer"
      ? { sha: head, outcome: "approved", summary: "review passed", findings: [] }
      : {
          head,
          overall: "PASS",
          summary: "combined acceptance passed",
          lines: [
            { id: "AC1", kind: "criterion", verdict: "PASS", text: "AC1 works", evidence: ["AC1"] },
            { id: "AC2", kind: "criterion", verdict: "PASS", text: "AC2 works", evidence: ["AC2"] },
          ],
        };
  return {
    exitCode: 0,
    stdout: JSON.stringify({ type: "result", finalText: JSON.stringify(report) }),
    stderr: "",
  };
};
const runtimeRef: { current: DeliveryRuntimeCoordinator | null } = { current: null };
const finalService = new FinalDeliveryService(db, {
  plans,
  dispatch,
  observations,
  publication,
  gate,
  budget,
  runtime: () => runtimeRef.current!,
});
const runtime = new DeliveryRuntimeCoordinator(db, {
  gate,
  observations,
  dispatch,
  budget,
  publication,
  artifactRoot,
  engine: { transport, provider: "pi", model: "test-model" },
  regressionChecks: ["true"],
  maxCorrections: 4,
  correction: { dispatch: (request) => finalService.dispatchCorrection(request) },
});
runtimeRef.current = runtime;

function register(id: string, role: "peer_reviewer" | "independent_evaluator" | "automated_gate") {
  return observations.registerTrustedProducer(project.id, { id, role });
}

function recordReview(runId: string, id: string): void {
  const producer = register(id, "peer_reviewer");
  observations.recordRunObservation(project.id, runId, {
    stage: "independent_review",
    status: "passed",
    producer: producer.producer,
    checks: [{ name: "standards", command: "review diff", result: "PASS", kind: "review" }],
  });
}
function recordAcceptance(runId: string, id: string): void {
  const producer = register(id, "independent_evaluator");
  observations.recordRunObservation(project.id, runId, {
    stage: "final_acceptance",
    status: "passed",
    producer: producer.producer,
    checks: [
      {
        name: "AC1",
        command: "acceptance AC1",
        result: "PASS",
        kind: "acceptance",
        criterionKey: "AC1",
      },
      { name: "regression", command: "bun test", result: "PASS", kind: "regression" },
      { name: "remote ci", command: "gh pr checks", result: "PASS", kind: "remote_ci" },
    ],
  });
}

async function importSpec(
  specIssue: number,
  title: string,
  children: Array<{ issue: number; title: string; coverage: string; long?: boolean }>,
  criteria: string[],
) {
  addIssue(specIssue, title, specBody(criteria), ["ready-for-agent", "spec"]);
  for (const child of children) {
    addIssue(
      child.issue,
      child.title,
      ticketBody({ partOf: specIssue, coverage: child.coverage, long: child.long }),
      ["ready-for-agent"],
    );
  }
  const plan = await plans.importPlan(project.id, { issue_number: specIssue, kind: "spec" });
  const branch = `factory/spec-${specIssue}-integration`;
  git(["branch", "-f", branch, "main"]);
  git(["push", "-q", "origin", branch]);
  return { plan, branch };
}

async function importStandalone(issue: number, title: string) {
  addIssue(issue, title, ticketBody({}), ["ready-for-agent"]);
  return plans.importPlan(project.id, { issue_number: issue, kind: "standalone" });
}

async function integrateChild(planId: string, issue: number, label: string): Promise<string> {
  const run = await dispatch.dispatch(project.id, {
    plan_id: planId,
    issue_number: issue,
    actor: "operator",
  });
  const gateProducer = register(`gate-${label}`, "automated_gate");
  const reviewer = register(`reviewer-${label}`, "peer_reviewer");
  observations.recordRunObservation(project.id, run.id, {
    stage: "technical_checks",
    status: "passed",
    producer: gateProducer.producer,
    checks: [{ name: "unit", command: "bun test", result: "PASS" }],
  });
  observations.recordRunObservation(project.id, run.id, {
    stage: "independent_review",
    status: "passed",
    producer: reviewer.producer,
    checks: [{ name: "standards", command: "review diff", result: "PASS" }],
  });
  await publication.publishByRun(project.id, run.id);
  const status = await integration.land(project.id, run.id);
  if (status.state !== "integrated") {
    throw new Error(
      `child ${issue} not integrated: ${status.blockers.map((b) => `${b.code}:${b.message}`).join(",")}`,
    );
  }
  return run.work_id;
}

function bindFinalEvidence(runId: string, workId: string): void {
  const status = publication.getStatusByRun(project.id, runId);
  for (const observation of observations.listObservations(project.id, { workId })) {
    for (const artifact of observation.artifacts) {
      publication.bindEvidence(
        project.id,
        status.target.id,
        artifact.id,
        `https://github.com/user-attachments/assets/${artifact.id}`,
      );
    }
  }
}

async function deliverReady(planId: string, workId: string) {
  let status = await finalService.advance(project.id, planId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!status.runId) break;
    bindFinalEvidence(status.runId, workId);
    await publication.publishByRun(project.id, status.runId);
    status = await finalService.advance(project.id, planId);
    if (status.state === "awaiting_manual_merge") break;
  }
  return status;
}

function mergeFinal(pr: { headBranch: string; baseBranch: string }, prNumber: number): string {
  const dir = join(root, `final-merge-${prNumber}`);
  execFileSync("git", ["clone", "-q", bareOrigin, dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  git(["checkout", "-q", pr.baseBranch], dir);
  git(["fetch", "-q", "origin", `${pr.headBranch}:refs/remotes/origin/${pr.headBranch}`], dir);
  git(["merge", "--no-ff", `origin/${pr.headBranch}`, "-m", "merge final"], dir);
  git(["push", "-q", "origin", pr.baseBranch], dir);
  return git(["rev-parse", "HEAD"], dir);
}

// --- Seed the board states -------------------------------------------------

// Plan A: partial integration + failed review correction + exhausted child.
const planA = await importSpec(
  1900,
  "Operator visibility for the factory board",
  [
    { issue: 1901, title: "Integrated child ticket", coverage: "AC1" },
    { issue: 1902, title: "Child ticket with a rejected review", coverage: "AC2" },
    { issue: 1903, title: "Child ticket that exhausted its budget", coverage: "AC3" },
  ],
  ["AC1 — parent criterion one", "AC2 — parent criterion two", "AC3 — parent criterion three"],
);
await integrateChild(planA.plan.id, 1901, "a1");

const failedReviewRun = await dispatch.dispatch(project.id, {
  plan_id: planA.plan.id,
  issue_number: 1902,
  actor: "operator",
});
const reviewerA = register("reviewer-a2", "peer_reviewer");
observations.recordRunObservation(project.id, failedReviewRun.id, {
  stage: "independent_review",
  status: "failed",
  producer: reviewerA.producer,
  checks: [{ name: "standards", command: "review diff", result: "FAIL" }],
  findings: [
    {
      severity: "blocking",
      acKey: "AC2",
      fileContext: "apps/backend/src/example.ts:42",
      summary: "AC2 is not satisfied by the candidate",
    },
  ],
});
await publication.publishByRun(project.id, failedReviewRun.id);

const failingDispatch = new DispatchService(db, {
  plans,
  ledger: new CommandLedger(db),
  brakes: new BrakeService(db),
  observations,
  budget,
  processAlive: () => true,
  ownerPid: () => process.pid,
  runner: async () => ({ success: false, error: "rejected cycle" }),
});
for (let lap = 1; lap <= 3; lap += 1) {
  await failingDispatch
    .dispatch(project.id, { plan_id: planA.plan.id, issue_number: 1903, actor: "operator" })
    .catch(() => {});
}

// Plan C: a verified final target merge marks the parent delivered.
const planC = await importSpec(
  1920,
  "Delivered specification",
  [{ issue: 1921, title: "Delivered child", coverage: "AC1" }],
  ["AC1 — parent criterion one"],
);
await integrateChild(planC.plan.id, 1921, "c1");
const planCRecord = plans.getPlan(project.id, planC.plan.id);
const planCReady = await deliverReady(planC.plan.id, planCRecord.root_work_id);
if (!planCReady.runId) throw new Error("final run missing for delivered plan");
const planCPublication = publication.getStatusByRun(project.id, planCReady.runId);
const planCPr = planCPublication.pullRequests.find((candidate) => candidate.active)!;
const planCMergeSha = mergeFinal(planCPr, planCPr.number!);
await forge.updatePullRequest(REPO, planCPr.number!, { draft: false });
forge.setMergeRemote(() => ({ sha: planCMergeSha }));
await forge.mergePullRequest(REPO, planCPr.number!);
forge.setMergeRemote(mergeOnBareOrigin);
const planCDelivered = await finalService.verifyMerge(project.id, planC.plan.id, "operator");
// The operator merged the final PR on the host; the harness checkout syncs its
// local delivery branch before importing later plans from the advanced baseline.
git(["update-ref", "refs/heads/main", remoteHead("main")!]);

// Standalone: gates passed, publication still pending.
const pending = await importStandalone(1930, "Standalone ticket awaiting publication");
const pendingRun = await dispatch.dispatch(project.id, {
  plan_id: pending.id,
  actor: "operator",
});
recordReview(pendingRun.id, "reviewer-pending");
recordAcceptance(pendingRun.id, "evaluator-pending");

// Standalone: evidence becomes stale when the remote PR base drifts.
const stale = await importStandalone(1940, "Standalone ticket with stale evidence");
const staleRun = await dispatch.dispatch(project.id, { plan_id: stale.id, actor: "operator" });
recordReview(staleRun.id, "reviewer-stale");
recordAcceptance(staleRun.id, "evaluator-stale");
const stalePublication = await publication.publishByRun(project.id, staleRun.id);
const stalePr = stalePublication.pullRequests.find((candidate) => candidate.active)!;
await forge.updatePullRequest(REPO, stalePr.number!, { base: "develop" });

// Plan B: every child integrated; the final PR waits for the operator merge.
const planB = await importSpec(
  1910,
  "Final integration awaiting the operator merge",
  [
    { issue: 1911, title: "First integrated child", coverage: "AC1" },
    { issue: 1912, title: "Second integrated child", coverage: "AC2" },
  ],
  ["AC1 — parent criterion one", "AC2 — parent criterion two"],
);
await integrateChild(planB.plan.id, 1911, "b1");
await integrateChild(planB.plan.id, 1912, "b2");
const planBRecord = plans.getPlan(project.id, planB.plan.id);
const planBReady = await deliverReady(planB.plan.id, planBRecord.root_work_id);

// Standalone: a live owner process counts as one actual worker.
const live = await importStandalone(1950, "Standalone ticket with a live worker");
let releaseLive!: () => void;
const held = new Promise<void>((resolve) => {
  releaseLive = resolve;
});
const liveDispatch = new DispatchService(db, {
  plans,
  ledger: new CommandLedger(db),
  brakes: new BrakeService(db),
  observations,
  budget,
  ownerPid: () => process.pid,
  runner: async (context) => {
    await held;
    const name = `live-${context.issue_number}.txt`;
    writeFileSync(join(context.worktree_path, name), "implemented\n");
    git(["add", name], context.worktree_path);
    git(["commit", "-q", "-m", `implement ${name}`], context.worktree_path);
    return { success: true, headSha: git(["rev-parse", "HEAD"], context.worktree_path) };
  },
});
const livePending = liveDispatch.dispatch(project.id, {
  plan_id: live.id,
  actor: "operator",
});
for (let attempt = 0; attempt < 200; attempt += 1) {
  if (liveDispatch.listRuns(project.id, { plan_id: live.id }).length > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// Standalone: revoked authorization is visible in Triage without dispatch.
const revoked = await importStandalone(1960, "Standalone ticket with revoked authorization");
plans.revokePlan(project.id, revoked.id, { actor: "operator", reason: "scope withdrawn" });

const app = await createBackendApp({
  db,
  forge,
  stateDir: join(root, "state"),
  startMonitor: false,
  webDir: fileURLToPath(new URL("../../apps/web/dist", import.meta.url)),
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
    plans: {
      partial: planA.plan.id,
      awaiting_merge: planB.plan.id,
      delivered: planC.plan.id,
    },
    final_waiting_merge: planBReady.state,
    final_delivered: planCDelivered.state,
    root,
  }),
);

async function shutdown() {
  releaseLive();
  await livePending.catch(() => {});
  await server.stop(true);
  await app.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
