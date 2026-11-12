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
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthorityAt } from "../../tests/integration/support/activated-authority";

// Manual UI verification harness for final-spec delivery. It seeds a real kernel
// database (temp SQLite, git worktrees and bare origin) with an offline forge and
// model transport, then serves the final-source web build. No fixture mode.
const root = mkdtempSync(join(tmpdir(), "animus-final-ui-"));
process.env.ANIMUS_HOME = join(root, "home");
seedActivatedAuthorityAt(join(root, "state"));
const artifactRoot = join(root, "home", "state", "artifacts");
const db = initializeDatabase(join(root, "state", "console.db"));
const checkout = join(root, "checkout");
mkdirSync(checkout);
const bareOrigin = join(root, "origin.git");
execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
const REPO = "owner/final-ui";

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
writeFileSync(join(checkout, ".factory", "schedule.json"), '{"max_laps":3}\n');

const specBody = [
  "## Source and problem",
  "Verify final-spec delivery in the operator console.",
  "## Outcome",
  "The combined feature is verified and waits for the operator merge.",
  "## Invariants",
  "- No live forge rebinding.",
  "## Acceptance criteria",
  "- [ ] AC1 — combined behaviour is verified.",
  "- [ ] AC2 — regression is verified.",
  "## Boundary",
  "Final delivery.",
].join("\n\n");
function childBody(number: number, dependsOn?: number): string {
  return [
    `Part of #900`,
    "",
    `Source acceptance coverage: AC${number === 901 ? 1 : 2}`,
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
    "",
    dependsOn ? `Depends on: #${dependsOn}` : "Depends on: None",
  ].join("\n");
}

const forge = new SyntheticForgeAdapter(
  { [REPO]: 900 },
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
forge.addIssue(REPO, {
  number: 900,
  title: "Final delivery verification",
  body: specBody,
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }, { name: "spec" }],
  comments: [],
});
forge.addIssue(REPO, {
  number: 901,
  title: "First child",
  body: childBody(901),
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }],
  comments: [],
});
forge.addIssue(REPO, {
  number: 902,
  title: "Second child",
  body: childBody(902, 901),
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }],
  comments: [],
});

const registry = new ProjectRegistryService(db, forge);
const project = await registry.registerProject({
  method: "local_checkout",
  name: "Final delivery UI",
  checkout_path: checkout,
});
const plans = new PlanService(db, forge);
const ledger = new CommandLedger(db);
const brakes = new BrakeService(db);
const observations = new ExecutionObservationService(db, { artifactRoot });
const budget = new ExecutionBudgetService(db);
const publication = new PublicationService(db, forge);
const gate = new DeliveryGateService(db, { observations, publication, forge });
const dispatch = new DispatchService(db, {
  plans,
  ledger,
  brakes,
  observations,
  budget,
  processAlive: () => true,
  ownerPid: () => 4343,
  runner: async (context) => {
    const name = `child-${context.issue_number}.txt`;
    writeFileSync(join(context.worktree_path, name), "implemented\n");
    git(["add", name], context.worktree_path);
    git(["commit", "-q", "-m", `implement ${name}`], context.worktree_path);
    return { success: true, headSha: git(["rev-parse", "HEAD"], context.worktree_path) };
  },
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

const plan = await plans.importPlan(project.id, { issue_number: 900, kind: "spec" });
const branch = "factory/spec-900-integration";
git(["branch", branch, "main"]);
git(["push", "-q", "origin", branch]);

async function integrateChild(issue: number, label: string): Promise<void> {
  const run = await dispatch.dispatch(project.id, {
    plan_id: plan.id,
    issue_number: issue,
    actor: "operator",
  });
  const gateProducer = observations.registerTrustedProducer(project.id, {
    id: `gate-${label}`,
    role: "automated_gate",
  });
  const reviewer = observations.registerTrustedProducer(project.id, {
    id: `reviewer-${label}`,
    role: "peer_reviewer",
  });
  observations.recordRunObservation(project.id, run.id, {
    stage: "technical_checks",
    status: "passed",
    producer: gateProducer.producer,
    checks: [{ name: "unit", command: "bun test", result: "PASS" }],
  });
  observations.recordRunObservation(project.id, run.id, {
    stage: "code_review",
    status: "passed",
    producer: reviewer.producer,
    checks: [{ name: "standards", command: "review diff", result: "PASS" }],
  });
  await publication.publishByRun(project.id, run.id);
  const status = await integration.land(project.id, run.id);
  if (status.state !== "integrated") {
    throw new Error(
      `child ${issue} not integrated: ${status.blockers.map((b) => b.code).join(",")}`,
    );
  }
}
await integrateChild(901, "a");
await integrateChild(902, "b");

function bindFinalEvidence(runId: string): void {
  const status = publication.getStatusByRun(project.id, runId);
  for (const observation of observations.listObservations(project.id, {
    workId: plan.root_work_id,
  })) {
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

let finalStatus = await finalService.advance(project.id, plan.id);
for (let attempt = 0; attempt < 4; attempt += 1) {
  if (!finalStatus.runId) break;
  bindFinalEvidence(finalStatus.runId);
  await publication.publishByRun(project.id, finalStatus.runId);
  finalStatus = await finalService.advance(project.id, plan.id);
  if (finalStatus.state === "awaiting_manual_merge") break;
}

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
    plan_id: plan.id,
    run_id: finalStatus.runId,
    state: finalStatus.state,
    integrated: finalStatus.integratedCount,
    required: finalStatus.requiredCount,
    candidate: finalStatus.candidateHeadSha,
    pull_request: finalStatus.pullRequest,
    merge: finalStatus.merge,
    budget: finalStatus.budget,
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
