import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
  type SyntheticForgeOptions,
} from "../../apps/backend/src/registry";
import { PlanService } from "../../apps/backend/src/plans";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService, type DispatchRunner } from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../../apps/backend/src/work/budget";
import { PublicationService } from "../../apps/backend/src/publication";
import { DeliveryGateService, DeliveryRuntimeCoordinator } from "../../apps/backend/src/delivery";
import { ChildIntegrationService } from "../../apps/backend/src/integration";
import { FinalDeliveryService } from "../../apps/backend/src/final";
import { OperatorBoardService } from "../../apps/backend/src/board";
import { WorkService } from "../../apps/backend/src/work";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import type { AgentTransport } from "../../scripts/loop/types";
import {
  operatorBoardSchema,
  operatorWorkDetailSchema,
  type OperatorBoard,
  type OperatorWorkDetail,
} from "@animus/contracts/operator";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";

export const REPO = "owner/operator-board";
export const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function specBody(
  criteria: string[] = ["AC1 — parent criterion one", "AC2 — parent criterion two"],
): string {
  return [
    "## Source and problem",
    "",
    "Prepared specification source.",
    "",
    "## Outcome",
    "",
    "Prepared specification outcome.",
    "",
    "## Acceptance criteria",
    "",
    ...criteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "## Boundary",
    "",
    "Prepared specification boundary.",
  ].join("\n");
}

function ticketBody(options: { partOf?: number; dependsOn?: number[]; coverage?: string }): string {
  const lines: string[] = [];
  if (options.partOf) lines.push(`Part of #${options.partOf}`, "");
  if (options.coverage) lines.push(`Source acceptance coverage: ${options.coverage}`, "");
  lines.push(
    "## Source and problem",
    "",
    "Prepared ticket source.",
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

export interface Fixture {
  root: string;
  db: ReturnType<typeof initializeDatabase>;
  forge: SyntheticForgeAdapter;
  projectId: string;
  checkout: string;
  bareOrigin: string;
  plans: PlanService;
  dispatch: DispatchService;
  observations: ExecutionObservationService;
  budget: ExecutionBudgetService;
  publication: PublicationService;
  gate: DeliveryGateService;
  integration: ChildIntegrationService;
  finalService: FinalDeliveryService;
  runtime: DeliveryRuntimeCoordinator;
  boardService: OperatorBoardService;
  app: BackendApp | null;
  remoteHead(branch: string): string | null;
  addIssue(number: number, body: string, labels: string[]): void;
  importSpec(
    specIssue: number,
    children: Array<{ issue: number; dependsOn?: number[]; coverage: string }>,
    criteria?: string[],
  ): Promise<{ planId: string; branch: string }>;
  importStandalone(issue: number): Promise<{ planId: string; workId: string }>;
  integrateChild(planId: string, issue: number, label: string): Promise<string>;
  startApp(): Promise<BackendApp>;
  fetchBoard(): Promise<OperatorBoard>;
  fetchWork(workId: string): Promise<OperatorWorkDetail>;
  readBoard(): Promise<OperatorBoard>;
  readWork(workId: string): Promise<OperatorWorkDetail>;
}

function committingRunner(): DispatchRunner {
  return async (context) => {
    const name = `impl-${context.issue_number}-${context.run_id.slice(0, 6)}.txt`;
    writeFileSync(join(context.worktree_path, name), "implemented\n");
    git(context.worktree_path, "add", name);
    git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
    return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
  };
}

function offlineTransport(): AgentTransport {
  return async (request) => {
    const head = git(request.cwd, "rev-parse", "HEAD");
    const report =
      request.role === "reviewer"
        ? {
            sha: head,
            outcome: "approved",
            summary: "independent standards and contract review passed",
            findings: [],
          }
        : {
            head,
            overall: "PASS",
            summary: "combined candidate satisfies the parent criteria",
            lines: [
              { id: "AC1", kind: "criterion", verdict: "PASS", text: "AC1 works", evidence: [] },
              { id: "AC2", kind: "criterion", verdict: "PASS", text: "AC2 works", evidence: [] },
            ],
          };
    return {
      exitCode: 0,
      stdout: JSON.stringify({ type: "result", finalText: JSON.stringify(report) }),
      stderr: "",
    };
  };
}

export async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "animus-operator-board-"));
  process.env.ANIMUS_HOME = join(root, "animus-home");
  writeExecutionAuthority("local");
  const artifactRoot = join(root, "animus-home", "state", "artifacts");
  const db = initializeDatabase(join(root, "state", "console.db"));
  const bareOrigin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q", checkout]);
  git(checkout, "remote", "add", "origin", `https://github.com/${REPO}.git`);
  git(checkout, "config", `url.${bareOrigin}.insteadOf`, `https://github.com/${REPO}.git`);
  git(checkout, "config", "user.email", "test@example.com");
  git(checkout, "config", "user.name", "Test");
  writeFileSync(join(checkout, "base.txt"), "base\n");
  git(checkout, "add", "base.txt");
  git(checkout, "commit", "-q", "-m", "base");
  git(checkout, "branch", "-M", "main");
  git(checkout, "push", "-q", "origin", "main");
  mkdirSync(join(checkout, ".factory"), { recursive: true });
  writeFileSync(join(checkout, ".factory", "schedule.json"), '{"max_laps":3,"parallel":3}\n');

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

  function mergeOnBareOrigin(pr: ForgePullRequest): { sha: string } {
    const headSha = pr.headRefOid ?? remoteHead(pr.head);
    const baseSha = remoteHead(pr.base);
    if (!headSha || !baseSha) throw new Error("merge transport missing real remote ref");
    const treeSha = git(checkout, "merge-tree", "--write-tree", baseSha, headSha)
      .split("\n")[0]!
      .trim();
    const mergeSha = git(
      checkout,
      "commit-tree",
      treeSha,
      "-p",
      baseSha,
      "-p",
      headSha,
      "-m",
      `Merge ${pr.head} into ${pr.base}`,
    );
    git(checkout, "update-ref", `refs/heads/${pr.base}`, mergeSha, baseSha);
    git(checkout, "push", "-q", "origin", `refs/heads/${pr.base}`);
    return { sha: mergeSha };
  }

  const forgeOptions: SyntheticForgeOptions = {
    requireRemoteSourceRef: true,
    resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
    mergeRemote: (_repo, pr) => mergeOnBareOrigin(pr),
  };
  const forge = new SyntheticForgeAdapter({ [REPO]: 1800 }, forgeOptions);
  const registry = new ProjectRegistryService(db, forge);
  const project = await registry.registerProject({
    method: "local_checkout",
    name: "Board",
    checkout_path: checkout,
  });
  const projectId = project.id;

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
    runner: committingRunner(),
  });
  const integration = new ChildIntegrationService(db, { observations, publication, forge });
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
    engine: {
      transport: offlineTransport(),
      provider: "pi",
      model: "test-model",
      roleBudgets: {
        qa: { softMs: 5_000, hardMs: 10_000 },
        reviewer: { softMs: 5_000, hardMs: 10_000 },
      },
    },
    regressionChecks: ["true"],
    maxCorrections: 4,
    correction: { dispatch: (request) => finalService.dispatchCorrection(request) },
  });
  runtimeRef.current = runtime;

  const boardService = new OperatorBoardService({
    projects: registry,
    work: new WorkService(db),
    plans,
    dispatch,
    observations,
    publication,
    integration,
    gate,
    final: finalService,
  });

  function addIssue(number: number, body: string, labels: string[]): void {
    forge.addIssue(REPO, {
      number,
      title: `Issue ${number}`,
      body,
      state: "OPEN",
      labels: labels.map((name) => ({ name })),
      comments: [],
    });
  }

  let app: BackendApp | null = null;

  const fixture: Fixture = {
    root,
    db,
    forge,
    projectId,
    checkout,
    bareOrigin,
    plans,
    dispatch,
    observations,
    budget,
    publication,
    gate,
    integration,
    finalService,
    runtime,
    boardService,
    app: null,
    remoteHead,
    addIssue,
    async importSpec(specIssue, children, criteria) {
      addIssue(specIssue, specBody(criteria), ["ready-for-agent", "spec"]);
      for (const child of children) {
        addIssue(
          child.issue,
          ticketBody({
            partOf: specIssue,
            dependsOn: child.dependsOn,
            coverage: child.coverage,
          }),
          ["ready-for-agent"],
        );
      }
      const plan = await plans.importPlan(projectId, { issue_number: specIssue, kind: "spec" });
      const branch = `factory/spec-${specIssue}-integration`;
      git(checkout, "branch", "-f", branch, "main");
      git(checkout, "push", "-q", "origin", branch);
      return { planId: plan.id, branch };
    },
    async importStandalone(issue) {
      addIssue(issue, ticketBody({}), ["ready-for-agent"]);
      const plan = await plans.importPlan(projectId, { issue_number: issue, kind: "standalone" });
      return { planId: plan.id, workId: plan.root_work_id };
    },
    async integrateChild(planId, issue, label) {
      const run = await dispatch.dispatch(projectId, {
        plan_id: planId,
        issue_number: issue,
        actor: "operator",
      });
      const gateProducer = observations.registerTrustedProducer(projectId, {
        id: `gate-${label}`,
        role: "automated_gate",
      });
      const reviewer = observations.registerTrustedProducer(projectId, {
        id: `reviewer-${label}`,
        role: "peer_reviewer",
      });
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "passed",
        producer: gateProducer.producer,
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
      });
      observations.recordRunObservation(projectId, run.id, {
        stage: "independent_review",
        status: "passed",
        producer: reviewer.producer,
        checks: [{ name: "standards", command: "review diff", result: "PASS" }],
      });
      await publication.publishByRun(projectId, run.id);
      const status = await integration.land(projectId, run.id);
      if (status.state !== "integrated") {
        throw new Error(
          `child ${issue} did not integrate: ${status.blockers.map((blocker) => blocker.code).join(",")}`,
        );
      }
      return run.work_id;
    },
    async startApp() {
      if (app) return app;
      app = await createBackendApp({
        db,
        forge,
        stateDir: join(root, "state"),
        startMonitor: false,
        webDir: join(root, "web"),
      });
      return app;
    },
    async fetchBoard() {
      const backend = await fixture.startApp();
      const response = await backend.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${projectId}/board`),
      );
      if (response.status !== 200) {
        throw new Error(`board request failed: ${response.status} ${await response.text()}`);
      }
      return operatorBoardSchema.parse(await response.json());
    },
    async fetchWork(workId) {
      const backend = await fixture.startApp();
      const response = await backend.fetch(
        new Request(`http://127.0.0.1/api/v1/projects/${projectId}/board/work/${workId}`),
      );
      if (response.status !== 200) {
        throw new Error(`work detail request failed: ${response.status} ${await response.text()}`);
      }
      return operatorWorkDetailSchema.parse(await response.json());
    },
    async readBoard() {
      return boardService.getBoard(projectId);
    },
    async readWork(workId) {
      return boardService.getWorkDetail(projectId, workId);
    },
  };
  return fixture;
}

export function cardFor(board: OperatorBoard, issueNumber: number) {
  const cards = board.lanes.flatMap((lane) => lane.cards);
  const card = cards.find((candidate) => candidate.issueNumber === issueNumber);
  if (!card)
    throw new Error(
      `card #${issueNumber} not found in ${JSON.stringify(board.lanes.map((lane) => [lane.id, lane.count]))}`,
    );
  return card;
}
