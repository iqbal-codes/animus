import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  DispatchService,
  runLocalDispatchTick,
  type DispatchRunner,
} from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../../apps/backend/src/work/budget";
import { PublicationService } from "../../apps/backend/src/publication";
import { DeliveryGateService, DeliveryRuntimeCoordinator } from "../../apps/backend/src/delivery";
import { ChildIntegrationService } from "../../apps/backend/src/integration";
import { FinalDeliveryService, handleProjectFinalRoute } from "../../apps/backend/src/final";
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthority } from "./support/activated-authority";

const REPO = "owner/final-delivery";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function specBody(): string {
  return [
    "## Source and problem",
    "",
    "Prepared specification source.",
    "",
    "## Outcome",
    "",
    "Prepared specification outcome.",
    "",
    "## Invariants",
    "",
    "- Planning record, never dispatched directly.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1 — first parent criterion",
    "- [ ] AC2 — second parent criterion",
    "",
    "## Boundary",
    "",
    "Prepared specification boundary.",
  ].join("\n");
}

function ticketBody(options: { partOf: number; dependsOn?: number[]; coverage: string }): string {
  const lines = [
    "Part of #" + options.partOf,
    "",
    `Source acceptance coverage: ${options.coverage}`,
    "",
  ];
  lines.push(
    "## Source and problem",
    "",
    "Prepared ticket source.",
    "",
    "## Outcome",
    "",
    "Prepared ticket outcome.",
    "",
    "## Invariants",
    "",
    "- Keep the invariant.",
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

describe("final-spec delivery coordination", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let observations: ExecutionObservationService;
  let budget: ExecutionBudgetService;
  let publication: PublicationService;
  let gate: DeliveryGateService;
  let dispatch: DispatchService;
  let integration: ChildIntegrationService;
  let finalService: FinalDeliveryService;
  let runtime: DeliveryRuntimeCoordinator;
  let projectId: string;
  let checkoutPath: string;
  let bareOrigin: string;
  let artifactRoot: string;
  let qaPasses: boolean;
  let repairFix: boolean;
  let repairRuns: string[];

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
    if (!headSha || !baseSha) throw new Error("merge transport is missing a real remote ref");
    const treeSha = git(checkoutPath, "merge-tree", "--write-tree", baseSha, headSha)
      .split("\n")[0]!
      .trim();
    const mergeSha = git(
      checkoutPath,
      "commit-tree",
      treeSha,
      "-p",
      baseSha,
      "-p",
      headSha,
      "-m",
      `Merge ${pr.head} into ${pr.base}`,
    );
    git(checkoutPath, "update-ref", `refs/heads/${pr.base}`, mergeSha, baseSha);
    git(checkoutPath, "push", "-q", "origin", `refs/heads/${pr.base}`);
    return { sha: mergeSha };
  }

  let cloneCounter = 0;

  function mergeRemoteDelivery(pr: {
    headBranch?: string | null;
    baseBranch?: string | null;
  }): string {
    const dir = join(root, `delivery-clone-${cloneCounter++}`);
    execFileSync("git", ["clone", "-q", bareOrigin, dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    const head = pr.headBranch!;
    const base = pr.baseBranch!;
    git(dir, "checkout", "-q", base);
    git(dir, "fetch", "-q", "origin", `${head}:refs/remotes/origin/${head}`);
    git(dir, "merge", "--no-ff", `origin/${head}`, "-m", `merge ${head}`);
    git(dir, "push", "-q", "origin", base);
    return git(dir, "rev-parse", "HEAD");
  }

  function forgeOptions(): SyntheticForgeOptions {
    return {
      requireRemoteSourceRef: true,
      resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
      mergeRemote: (_repo, pr) => mergeOnBareOrigin(pr),
    };
  }

  function committingRunner(): DispatchRunner {
    return async (context) => {
      const name =
        context.gate_profile === "final"
          ? repairFix
            ? "final-fix.txt"
            : "final-repair-attempt.txt"
          : `child-${context.issue_number}.txt`;
      if (context.gate_profile === "final") repairRuns.push(context.run_id);
      writeFileSync(join(context.worktree_path, name), "implemented\n");
      git(context.worktree_path, "add", name);
      git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
      return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
    };
  }

  function offlineTransport(): AgentTransport {
    return async (request) => {
      const head = git(request.cwd, "rev-parse", "HEAD");
      let report: Record<string, unknown>;
      if (request.role === "reviewer") {
        report = {
          sha: head,
          outcome: "approved",
          summary: "independent standards and contract review passed",
          findings: [],
        };
      } else {
        const pass = qaPasses || existsSync(join(request.cwd, "final-fix.txt"));
        report = {
          head,
          overall: pass ? "PASS" : "FAIL",
          summary: pass ? "combined candidate satisfies the parent criteria" : "AC1 missing",
          lines: [
            {
              id: "AC1",
              kind: "criterion",
              verdict: pass ? "PASS" : "FAIL",
              text: pass ? "AC1 works" : "AC1 missing",
              evidence: [],
            },
            {
              id: "AC2",
              kind: "criterion",
              verdict: "PASS",
              text: "AC2 works",
              evidence: [],
            },
          ],
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", finalText: JSON.stringify(report) }),
        stderr: "",
      };
    };
  }

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

  function register(
    id: string,
    role: "peer_reviewer" | "independent_evaluator" | "automated_gate",
  ) {
    return observations.registerTrustedProducer(projectId, { id, role });
  }

  async function importSpec(
    specIssue: number,
    children: Array<{ issue: number; dependsOn?: number[]; coverage: string }>,
  ) {
    addIssue(specIssue, specBody(), ["ready-for-agent", "spec"]);
    children.forEach((child) => {
      addIssue(
        child.issue,
        ticketBody({
          partOf: specIssue,
          dependsOn: child.dependsOn,
          coverage: child.coverage,
        }),
        ["ready-for-agent"],
      );
    });
    const plan = await plans.importPlan(projectId, { issue_number: specIssue, kind: "spec" });
    const branch = `factory/spec-${specIssue}-integration`;
    git(checkoutPath, "branch", "-f", branch, "main");
    git(checkoutPath, "push", "-q", "origin", branch);
    return { plan, branch };
  }

  async function integrateChild(planId: string, issue: number, label: string) {
    const run = await dispatch.dispatch(projectId, {
      plan_id: planId,
      issue_number: issue,
      actor: "operator",
    });
    expect(run.state).toBe("succeeded");
    const gateProducer = register(`gate-${label}`, "automated_gate");
    const reviewer = register(`reviewer-${label}`, "peer_reviewer");
    observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "passed",
      producer: gateProducer.producer,
      checks: [{ name: "unit", command: "bun test targeted", result: "PASS" }],
    });
    observations.recordRunObservation(projectId, run.id, {
      stage: "code_review",
      status: "passed",
      producer: reviewer.producer,
      checks: [{ name: "standards", command: "review diff", result: "PASS" }],
    });
    await publication.publishByRun(projectId, run.id);
    const status = await integration.land(projectId, run.id);
    expect(status.state).toBe("integrated");
    return run;
  }

  function rootWorkId(): string {
    return (
      db
        .prepare(
          "SELECT work_id FROM plan_members WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?) AND role = 'spec' LIMIT 1",
        )
        .get(projectId) as { work_id: string }
    ).work_id;
  }

  function bindFinalEvidence(runId: string, workId: string): void {
    const status = publication.getStatusByRun(projectId, runId);
    for (const observation of observations.listObservations(projectId, { workId })) {
      for (const artifact of observation.artifacts) {
        publication.bindEvidence(
          projectId,
          status.target.id,
          artifact.id,
          `https://github.com/user-attachments/assets/${artifact.id}`,
        );
      }
    }
  }

  async function deliverReady(planId: string) {
    let status = await finalService.advance(projectId, planId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!status.runId) break;
      bindFinalEvidence(status.runId, rootWorkId());
      await publication.publishByRun(projectId, status.runId);
      status = await finalService.advance(projectId, planId);
      if (status.state === "awaiting_manual_merge") break;
    }
    return status;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-final-delivery-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    artifactRoot = join(root, "animus-home", "state", "artifacts");
    db = initializeDatabase(join(root, "state", "console.db"));
    seedActivatedAuthority(db);
    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", `url.${bareOrigin}.insteadOf`, `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    writeFileSync(join(checkoutPath, "base.txt"), "base\n");
    git(checkoutPath, "add", "base.txt");
    git(checkoutPath, "commit", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    git(checkoutPath, "push", "-q", "origin", "main");
    mkdirSync(join(checkoutPath, ".factory"), { recursive: true });
    writeFileSync(join(checkoutPath, ".factory", "schedule.json"), '{"max_laps":3}\n');
    forge = new SyntheticForgeAdapter({ [REPO]: 160 }, forgeOptions());
    registry = new ProjectRegistryService(db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    plans = new PlanService(db, forge);
    ledger = new CommandLedger(db);
    brakes = new BrakeService(db);
    observations = new ExecutionObservationService(db, { artifactRoot });
    budget = new ExecutionBudgetService(db);
    publication = new PublicationService(db, forge);
    gate = new DeliveryGateService(db, { observations, publication, forge });
    qaPasses = false;
    repairFix = true;
    repairRuns = [];
    dispatch = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      observations,
      budget,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: committingRunner(),
    });
    integration = new ChildIntegrationService(db, {
      observations,
      publication,
      forge,
    });
    const runtimeRef: { current: DeliveryRuntimeCoordinator | null } = { current: null };
    finalService = new FinalDeliveryService(db, {
      plans,
      dispatch,
      observations,
      publication,
      gate,
      budget,
      runtime: () => runtimeRef.current!,
    });
    runtime = new DeliveryRuntimeCoordinator(db, {
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
      correction: {
        dispatch: (request) => finalService.dispatchCorrection(request),
      },
    });
    runtimeRef.current = runtime;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1: no final acceptance starts until every required child is verifiably integrated", async () => {
    const { plan } = await importSpec(1700, [
      { issue: 1701, coverage: "AC1" },
      { issue: 1702, dependsOn: [1701], coverage: "AC2" },
      { issue: 1703, coverage: "AC1" },
    ]);

    await expect(
      dispatch.dispatch(projectId, { plan_id: plan.id, issue_number: 1702, actor: "operator" }),
    ).rejects.toMatchObject({ code: "dependency_pending_integration" });

    const waiting = await finalService.advance(projectId, plan.id);
    expect(waiting.state).toBe("waiting_children");
    expect(waiting.requiredCount).toBe(3);
    expect(waiting.integratedCount).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM dispatch_runs WHERE gate_profile = 'final'").get(),
    ).toEqual({ count: 0 });

    await integrateChild(plan.id, 1701, "a");
    await integrateChild(plan.id, 1703, "c");
    const partial = await finalService.advance(projectId, plan.id);
    expect(partial.state).toBe("waiting_children");
    expect(partial.integratedCount).toBe(2);
    expect(partial.children.find((child) => child.issueNumber === 1702)?.integrated).toBe(false);
    expect(partial.state).toBe("waiting_children");
  });

  test("AC2/AC3/AC5/AC6: two ordered children plus independent work, final QA failure, bounded repair, fresh evidence and manual merge", async () => {
    const { plan, branch } = await importSpec(1710, [
      { issue: 1711, coverage: "AC1" },
      { issue: 1712, dependsOn: [1711], coverage: "AC2" },
      { issue: 1713, coverage: "AC1" },
    ]);

    await integrateChild(plan.id, 1711, "a");
    await integrateChild(plan.id, 1713, "c");
    await integrateChild(plan.id, 1712, "b");

    const first = await finalService.advance(projectId, plan.id);
    expect(first.requiredCount).toBe(3);
    expect(first.integratedCount).toBe(3);
    expect(first.runId).toBeTruthy();
    expect(first.state).toBe("blocked");

    const firstAssembly = db
      .prepare(
        "SELECT id, head_sha FROM dispatch_runs WHERE gate_profile = 'final' AND actor = 'final-coordinator' ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get() as { id: string; head_sha: string };
    const firstRunId = firstAssembly.id;
    const firstObservations = observations.listObservations(projectId, { runId: firstRunId });
    const failedAcceptance = firstObservations.find(
      (observation) => observation.stage === "blackbox_verification",
    )!;
    expect(failedAcceptance.status).toBe("failed");
    const findings = observations.listFindings(projectId, { workId: plan.root_work_id });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.status === "resolved")).toBe(true);
    expect(findings[0]!.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["opened", "recheck_passed"]),
    );

    // The bounded repair is a real builder lap on the integration lineage, not a
    // rerun of a child or a reset of its budget.
    expect(repairRuns.length).toBe(1);
    expect(branch).toBeTruthy();
    const childRuns = dispatch.listRuns(projectId, { plan_id: plan.id });
    expect(childRuns.filter((run) => run.gate_profile === "child")).toHaveLength(3);

    const repaired = await finalService.advance(projectId, plan.id);
    expect(repaired.candidateHeadSha).not.toBe(firstAssembly.head_sha);
    expect(repaired.runId).not.toBe(firstRunId);
    expect(repaired.integratedCount).toBe(3);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_runs WHERE gate_profile = 'final' AND actor = 'final-coordinator' AND state = 'succeeded'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_runs WHERE gate_profile = 'final' AND actor = 'final-repair' AND state = 'succeeded'",
        )
        .get(),
    ).toEqual({ count: 1 });

    // The successful new candidate carries immutable, hash-verifiable artifacts.
    const acceptance = observations
      .listObservations(projectId, { runId: repaired.runId! })
      .find((observation) => observation.stage === "blackbox_verification")!;
    expect(acceptance.status).toBe("passed");
    expect(
      acceptance.checks
        .filter((check) => check.kind === "acceptance")
        .map((check) => check.criterionKey),
    ).toEqual(["AC1", "AC2"]);
    expect(acceptance.checks.some((check) => check.kind === "regression")).toBe(true);
    for (const artifact of acceptance.artifacts) {
      const absolute = join(artifactRoot, projectId, artifact.relativePath);
      const bytes = readFileSync(absolute);
      expect(bytes.byteLength).toBe(artifact.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.digestSha256);
    }

    // Findings opened on the failed candidate are resolved only by the fresh pass.
    expect(
      observations
        .listFindings(projectId, { workId: plan.root_work_id })
        .every((finding) => finding.status === "resolved"),
    ).toBe(true);

    // Required remote CI is a real readback of branch protection + check runs for
    // the exact final candidate, not a producer-asserted PASS.
    forge.setRequiredStatusChecks(REPO, "main", ["ci/build"]);
    const ciBlocked = await finalService.advance(projectId, plan.id);
    expect(ciBlocked.state).toBe("blocked");
    expect(ciBlocked.reasons).toContain("remote_ci_missing");
    forge.setCheckRuns(REPO, ciBlocked.candidateHeadSha!, [
      { name: "ci/build", status: "completed", conclusion: "success" },
    ]);

    const ready = await deliverReady(plan.id);
    expect(ready.state).toBe("awaiting_manual_merge");
    expect(ready.delivered).toBe(false);
    expect(ready.merge?.verified).toBe(false);
    expect(ready.pullRequest).not.toBeNull();

    // One final PR, not one per candidate/repair.
    const status = publication.getStatusByRun(projectId, ready.runId!);
    expect(status.pullRequests.length).toBe(1);
    expect(status.pullRequests[0]).toMatchObject({ headBranch: branch, baseBranch: "main" });

    // Integration is not delivery: main has not moved yet.
    expect(remoteHead("main")).not.toBe(ready.candidateHeadSha);

    // Operator merges the final PR in the configured delivery branch.
    const pr = status.pullRequests[0]!;
    const testedMain = remoteHead("main");
    await forge.updatePullRequest(REPO, pr.number!, { draft: false });
    // The operator merges on the host; the local checkout's delivery branch is
    // deliberately not advanced before verification proves the remote lineage.
    const mergeSha = mergeRemoteDelivery(pr);
    forge.setMergeRemote(() => ({ sha: mergeSha }));
    const merged = await forge.mergePullRequest(REPO, pr.number!);
    expect(merged.merged).toBe(true);
    expect(remoteHead("main")).toBe(mergeSha);
    expect(git(checkoutPath, "rev-parse", "main")).toBe(testedMain);

    const delivered = await finalService.verifyMerge(projectId, plan.id, "operator");
    expect(delivered.state).toBe("delivered");
    expect(delivered.delivered).toBe(true);
    expect(delivered.merge?.verified).toBe(true);
    expect(delivered.merge?.verification?.targetBranch).toBe("main");
    expect(delivered.merge?.verification?.sourceBranch).toBe(branch);
    expect(remoteHead("main")).toBe(delivered.merge?.verification?.remoteTargetTipSha);
    expect(childRuns.filter((run) => run.gate_profile === "child")).toHaveLength(3);
  }, 30_000);

  test("AC4: final exhaustion holds delivery in Needs owner with retained findings and no child rerun", async () => {
    writeFileSync(join(checkoutPath, ".factory", "schedule.json"), '{"max_laps":2}\n');
    const { plan } = await importSpec(1720, [
      { issue: 1721, coverage: "AC1" },
      { issue: 1722, dependsOn: [1721], coverage: "AC2" },
    ]);
    await integrateChild(plan.id, 1721, "a");
    await integrateChild(plan.id, 1722, "b");

    qaPasses = false;
    repairFix = false;
    // The second acceptance fails as well; the injected transport never applies the
    // repair marker, so the bounded final scope must run out.
    let status = await finalService.advance(projectId, plan.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!status.runId || status.state === "needs_owner") break;
      bindFinalEvidence(status.runId, rootWorkId());
      await publication.publishByRun(projectId, status.runId);
      status = await finalService.advance(projectId, plan.id);
    }
    expect(status.state).toBe("needs_owner");
    expect(status.delivered).toBe(false);
    expect(status.budget?.status).toBe("exhausted");

    const retainedFindings = observations.listFindings(projectId, {
      workId: plan.root_work_id,
      status: "open",
    });
    expect(retainedFindings.length).toBeGreaterThan(0);
    const childRuns = dispatch
      .listRuns(projectId, { plan_id: plan.id })
      .filter((run) => run.gate_profile === "child");
    expect(childRuns).toHaveLength(2);
    expect(childRuns.every((run) => run.lap === 1)).toBe(true);
  }, 30_000);

  test("AC1: a child merged elsewhere cannot launch final acceptance", async () => {
    const { plan, branch } = await importSpec(1730, [
      { issue: 1731, coverage: "AC1" },
      { issue: 1732, dependsOn: [1731], coverage: "AC2" },
    ]);
    const base = remoteHead(branch);
    await integrateChild(plan.id, 1731, "a");
    await integrateChild(plan.id, 1732, "b");

    // Rewind only the remote integration lineage: the durable child integration
    // rows exist, but the actual remote tip no longer includes them.
    execFileSync("git", ["--git-dir", bareOrigin, "update-ref", `refs/heads/${branch}`, base!], {
      stdio: "ignore",
    });

    const blocked = await finalService.advance(projectId, plan.id);
    expect(blocked.state).toBe("blocked");
    expect(blocked.reasons.some((reason) => reason.startsWith("child_lineage_unverified"))).toBe(
      true,
    );
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM dispatch_runs WHERE gate_profile = 'final'").get(),
    ).toEqual({ count: 0 });
  }, 30_000);

  test("AC5: a remote MERGED PR without delivery-branch inclusion is never delivered", async () => {
    const { plan } = await importSpec(1740, [
      { issue: 1741, coverage: "AC1" },
      { issue: 1742, dependsOn: [1741], coverage: "AC2" },
    ]);
    await integrateChild(plan.id, 1741, "a");
    await integrateChild(plan.id, 1742, "b");
    const ready = await deliverReady(plan.id);
    expect(ready.state).toBe("awaiting_manual_merge");
    const publicationStatus = publication.getStatusByRun(projectId, ready.runId!);
    const pr = publicationStatus.pullRequests[0]!;
    const testedMain = remoteHead("main");

    await forge.updatePullRequest(REPO, pr.number!, { draft: false });
    forge.setMergeRemote(() => ({ sha: "f".repeat(40) }));
    await forge.mergePullRequest(REPO, pr.number!);
    expect(remoteHead("main")).toBe(testedMain);

    const invalidated = await gate.getGate(projectId, ready.runId!);
    expect(invalidated.state).toBe("invalidated");
    expect(invalidated.merge.verified).toBe(false);
    await expect(finalService.verifyMerge(projectId, plan.id, "operator")).rejects.toMatchObject({
      code: "delivery_gate_unsatisfied",
    });
  }, 30_000);

  test("AC5: delivery-branch advancement invalidates a tested final candidate", async () => {
    const { plan } = await importSpec(1750, [
      { issue: 1751, coverage: "AC1" },
      { issue: 1752, dependsOn: [1751], coverage: "AC2" },
    ]);
    await integrateChild(plan.id, 1751, "a");
    await integrateChild(plan.id, 1752, "b");
    const ready = await deliverReady(plan.id);
    expect(ready.state).toBe("awaiting_manual_merge");
    const testedTip = ready.gate?.targetTipSha;

    const dir = join(root, "advance-main");
    execFileSync("git", ["clone", "-q", bareOrigin, dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    git(dir, "checkout", "-q", "main");
    git(dir, "commit", "--allow-empty", "-q", "-m", "external advance");
    git(dir, "push", "-q", "origin", "main");

    const stale = await gate.getGate(projectId, ready.runId!);
    expect(stale.state).toBe("invalidated");
    expect(stale.reasons).toContain("stale_target_tip");
    expect(stale.targetTipSha).toBe(testedTip);
    await expect(finalService.verifyMerge(projectId, plan.id, "operator")).rejects.toMatchObject({
      code: "delivery_gate_unsatisfied",
    });
  }, 30_000);

  test("AC1: concurrent ticks create one final run and one final PR", async () => {
    const { plan } = await importSpec(1760, [
      { issue: 1761, coverage: "AC1" },
      { issue: 1762, coverage: "AC2" },
    ]);
    await integrateChild(plan.id, 1761, "a");
    await integrateChild(plan.id, 1762, "b");
    qaPasses = true;

    const [first, second] = await Promise.all([
      finalService.advance(projectId, plan.id),
      finalService.advance(projectId, plan.id),
    ]);
    const runIds = new Set([first.runId, second.runId].filter(Boolean));
    expect(runIds.size).toBe(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_runs WHERE gate_profile = 'final' AND actor = 'final-coordinator'",
        )
        .get(),
    ).toEqual({ count: 1 });

    // A restart/replay reuses the same combined candidate and PR.
    const replay = await finalService.advance(projectId, plan.id);
    expect(replay.runId).toBe(first.runId);
    expect(publication.getStatusByRun(projectId, replay.runId!).pullRequests).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_runs WHERE gate_profile = 'final' AND actor = 'final-coordinator'",
        )
        .get(),
    ).toEqual({ count: 1 });
  }, 30_000);

  test("AC3/AC4: an operator Stop prevents final verification and repairs", async () => {
    const { plan } = await importSpec(1770, [
      { issue: 1771, coverage: "AC1" },
      { issue: 1772, dependsOn: [1771], coverage: "AC2" },
    ]);
    const childRun = await integrateChild(plan.id, 1771, "a");
    await integrateChild(plan.id, 1772, "b");
    budget.setControl({
      projectId,
      deliveryId: childRun.delivery_id,
      workId: rootWorkId(),
      status: "stopped",
      actor: "operator",
      reason: "operator_stop",
      commandRequestId: "cmd_final_stop",
      lastRunId: childRun.id,
      now: Date.now(),
    });

    const stopped = await finalService.advance(projectId, plan.id);
    expect(stopped.runId).toBeTruthy();
    expect(
      observations
        .listObservations(projectId, { runId: stopped.runId! })
        .filter((observation) => observation.stage === "blackbox_verification"),
    ).toHaveLength(0);
    expect(repairRuns).toHaveLength(0);
  }, 30_000);

  test("AC4: final grants are reasoned, idempotent and separate from child budgets", async () => {
    writeFileSync(join(checkoutPath, ".factory", "schedule.json"), '{"max_laps":1}\n');
    const { plan } = await importSpec(1790, [
      { issue: 1791, coverage: "AC1" },
      { issue: 1792, dependsOn: [1791], coverage: "AC2" },
    ]);
    const childRun = await integrateChild(plan.id, 1791, "a");
    await integrateChild(plan.id, 1792, "b");
    qaPasses = false;
    repairFix = false;
    const exhausted = await finalService.advance(projectId, plan.id);
    expect(exhausted.state).toBe("needs_owner");
    expect(exhausted.budget?.status).toBe("exhausted");
    const finalRunId = exhausted.runId!;

    const granted = dispatch.grantBudget(projectId, finalRunId, {
      amount: 1,
      reason: "Operator approved one more final verification after evidence review",
      actor: "operator",
      idempotency_key: "final-grant-1790",
    });
    expect(granted.replayed).toBe(false);
    expect(granted.budget).toMatchObject({
      gateProfile: "final",
      workId: rootWorkId(),
      allowedAttempts: exhausted.budget!.allowedAttempts + 1,
      status: "active",
    });
    expect(granted.grant.reason).toContain("Operator approved");

    const replay = dispatch.grantBudget(projectId, finalRunId, {
      amount: 1,
      reason: "Operator approved one more final verification after evidence review",
      actor: "operator",
      idempotency_key: "final-grant-1790",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.grant.id).toBe(granted.grant.id);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM execution_budget_grants WHERE scope_id = ?")
        .get(granted.budget.scopeId),
    ).toEqual({ count: 1 });

    const childScope = budget.getScope({
      projectId,
      deliveryId: childRun.delivery_id,
      planId: plan.id,
      workId: childRun.work_id,
      gateProfile: "child",
    });
    expect(childScope).toMatchObject({
      gateProfile: "child",
      allowedAttempts: 1,
      consumedAttempts: 1,
      grantedAttempts: 0,
    });
  }, 30_000);

  test("AC6: the normal scheduler tick runs final coordination once children are integrated", async () => {
    const { plan } = await importSpec(1800, [
      { issue: 1801, coverage: "AC1" },
      { issue: 1802, dependsOn: [1801], coverage: "AC2" },
    ]);
    await integrateChild(plan.id, 1801, "a");
    await integrateChild(plan.id, 1802, "b");
    qaPasses = true;

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime,
      finalDeliveryRuntime: finalService,
    });
    expect(tick.action).toBe("launched");
    expect(tick.planId).toBe(plan.id);
    const delivery = tick.delivery as { runId: string | null; integratedCount: number };
    expect(delivery.integratedCount).toBe(2);
    expect(delivery.runId).toBeTruthy();
    expect(
      observations
        .listObservations(projectId, { runId: delivery.runId! })
        .some(
          (observation) =>
            observation.stage === "blackbox_verification" && observation.status === "passed",
        ),
    ).toBe(true);
  }, 30_000);

  test("public final-delivery routes expose real progress, advance and merge gates", async () => {
    const { plan } = await importSpec(1780, [
      { issue: 1781, coverage: "AC1" },
      { issue: 1782, dependsOn: [1781], coverage: "AC2" },
    ]);
    const listResponse = await handleProjectFinalRoute(
      new Request(`http://localhost/api/v1/projects/${projectId}/final`),
      projectId,
      [projectId, "final"],
      finalService,
    );
    expect(listResponse?.status).toBe(200);
    const listed = (await listResponse!.json()) as Array<{ state: string; requiredCount: number }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ state: "waiting_children", requiredCount: 2 });

    const statusResponse = await handleProjectFinalRoute(
      new Request(`http://localhost/api/v1/projects/${projectId}/final/${plan.id}`),
      projectId,
      [projectId, "final", plan.id],
      finalService,
    );
    expect(statusResponse?.status).toBe(200);

    const invalidResponse = await handleProjectFinalRoute(
      new Request(`http://localhost/api/v1/projects/${projectId}/final/${plan.id}/advance`, {
        method: "POST",
        body: JSON.stringify({ unexpected: true }),
      }),
      projectId,
      [projectId, "final", plan.id, "advance"],
      finalService,
    );
    expect(invalidResponse?.status).toBe(400);

    await integrateChild(plan.id, 1781, "a");
    await integrateChild(plan.id, 1782, "b");
    const advanceResponse = await handleProjectFinalRoute(
      new Request(`http://localhost/api/v1/projects/${projectId}/final/${plan.id}/advance`, {
        method: "POST",
        body: JSON.stringify({ actor: "operator" }),
      }),
      projectId,
      [projectId, "final", plan.id, "advance"],
      finalService,
    );
    expect(advanceResponse?.status).toBe(200);
    const advanced = (await advanceResponse!.json()) as {
      runId: string | null;
      integratedCount: number;
    };
    expect(advanced.integratedCount).toBe(2);
    expect(advanced.runId).toBeTruthy();
  }, 30_000);

  test("a held installation blocks final advance, merge verification and repair before any remote transport", async () => {
    const { plan } = await importSpec(1790, [
      { issue: 1791, coverage: "AC1" },
      { issue: 1792, dependsOn: [1791], coverage: "AC2" },
    ]);
    let remoteCalls = 0;
    const heldService = new FinalDeliveryService(db, {
      plans,
      dispatch,
      observations,
      publication,
      gate,
      budget,
      runtime: () => runtime,
      gitRemote: async () => {
        remoteCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    db.prepare(
      `INSERT INTO installation_holds
         (id, status, reason, source_restore_id, restored_at, reconciled_at, reconciled_by, reconciliation_report)
       VALUES ('installation', 'held', 'restored installation pending reconciliation', 'restore_probe', ?, NULL, NULL, NULL)`,
    ).run(Date.now());
    try {
      await expect(heldService.advance(projectId, plan.id)).rejects.toMatchObject({
        code: "final_installation_held",
      });
      await expect(heldService.verifyMerge(projectId, plan.id)).rejects.toMatchObject({
        code: "final_installation_held",
      });
      await expect(
        heldService.dispatchCorrection({
          projectId,
          runId: "run_probe",
          deliveryId: "delivery_probe",
          planId: plan.id,
          workId: rootWorkId(),
          actor: "probe",
          findings: [],
        }),
      ).rejects.toMatchObject({ code: "final_installation_held" });
      expect(remoteCalls).toBe(0);
    } finally {
      db.prepare("DELETE FROM installation_holds WHERE id = 'installation'").run();
    }
    await expect(heldService.advance(projectId, plan.id)).resolves.toMatchObject({
      state: "waiting_children",
      integratedCount: 0,
      requiredCount: 2,
    });
    expect(remoteCalls).toBe(0);
  }, 30_000);
});
