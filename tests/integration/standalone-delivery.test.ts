import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { PublicationService } from "../../apps/backend/src/publication";
import { DeliveryGateService } from "../../apps/backend/src/delivery";
import { DeliveryError } from "../../apps/backend/src/delivery/errors";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";

const REPO = "owner/standalone-delivery";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function ticketBody(partOf?: number): string {
  return [
    ...(partOf ? [`Part of #${partOf}`, "", "Source acceptance coverage: AC1", ""] : []),
    "## Source and problem",
    "",
    "Prepared standalone ticket source.",
    "",
    "## Outcome",
    "",
    "Prepared standalone ticket outcome.",
    "",
    "## Invariants",
    "",
    "- Keep the invariant.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1: first prepared criterion",
    "- [ ] AC2: second prepared criterion",
    "",
    "## Boundary",
    "",
    "Prepared standalone ticket boundary.",
    "",
    "Depends on: None",
  ].join("\n");
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
    "- [ ] AC1 — parent criterion",
    "",
    "## Boundary",
    "",
    "Prepared specification boundary.",
  ].join("\n");
}

describe("standalone full-delivery gate and verified merge", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let observations: ExecutionObservationService;
  let publication: PublicationService;
  let delivery: DeliveryGateService;
  let projectId: string;
  let checkoutPath: string;
  let bareOrigin: string;

  function remoteHead(branch: string): string | null {
    try {
      const sha = execFileSync(
        "git",
        ["--git-dir", bareOrigin, "rev-parse", "--verify", `refs/heads/${branch}`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return sha || null;
    } catch {
      return null;
    }
  }

  function forgeOptions(): SyntheticForgeOptions {
    return {
      requireRemoteSourceRef: true,
      resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
    };
  }

  function commitInWorktree(worktreePath: string, name: string): string {
    writeFileSync(join(worktreePath, name), "implemented\n");
    git(worktreePath, "add", name);
    git(worktreePath, "commit", "-q", "-m", `implement ${name}`);
    return git(worktreePath, "rev-parse", "HEAD");
  }

  function committingRunner(name = "impl.txt"): DispatchRunner {
    return async (context) => ({
      success: true,
      headSha: commitInWorktree(context.worktree_path, name),
    });
  }

  function makeDispatch(runner: DispatchRunner = committingRunner()): DispatchService {
    return new DispatchService(db, {
      plans,
      ledger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner,
    });
  }

  function addIssue(
    number: number,
    body: string = ticketBody(),
    labels: string[] = ["ready-for-agent"],
  ): void {
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
    role: "independent_evaluator" | "peer_reviewer" | "automated_gate",
  ): void {
    observations.registerTrustedProducer(projectId, { id, role });
  }

  async function dispatchStandalone(issueNumber: number, runner?: DispatchRunner) {
    addIssue(issueNumber);
    const plan = await plans.importPlan(projectId, {
      issue_number: issueNumber,
      kind: "standalone",
    });
    const run = await makeDispatch(runner).dispatch(projectId, {
      plan_id: plan.id,
      actor: "operator",
    });
    return { plan, run };
  }

  function recordReview(runId: string, producerId = "reviewer-1"): void {
    observations.recordRunObservation(projectId, runId, {
      stage: "independent_review",
      status: "passed",
      producer: { id: producerId, role: "peer_reviewer" },
      checks: [
        {
          name: "standards review",
          command: "review diff",
          result: "PASS",
          kind: "review",
        },
      ],
    });
  }

  function recordFinalAcceptance(
    runId: string,
    options: { status?: "passed" | "failed"; producerId?: string; finding?: boolean } = {},
  ): void {
    const status = options.status ?? "passed";
    observations.recordRunObservation(projectId, runId, {
      stage: "final_acceptance",
      status,
      producer: { id: options.producerId ?? "final-1", role: "independent_evaluator" },
      checks:
        status === "passed"
          ? [
              {
                name: "AC1 black-box",
                command: "acceptance AC1",
                result: "PASS",
                kind: "acceptance",
                criterionKey: "AC1",
              },
              {
                name: "AC2 black-box",
                command: "acceptance AC2",
                result: "PASS",
                kind: "acceptance",
                criterionKey: "AC2",
              },
              {
                name: "regression suite",
                command: "bun test targeted",
                result: "PASS",
                kind: "regression",
              },
              {
                name: "remote ci",
                command: "gh pr checks",
                result: "PASS",
                kind: "remote_ci",
              },
            ]
          : [
              {
                name: "AC1 black-box",
                command: "acceptance AC1",
                result: "FAIL",
                kind: "acceptance",
                criterionKey: "AC1",
                detail: "criterion not met",
              },
            ],
      findings:
        status === "failed" && options.finding !== false
          ? [
              {
                severity: "blocking",
                acKey: "AC1",
                fileContext: "impl.txt:1",
                summary: "AC1 is not satisfied by the candidate",
              },
            ]
          : [],
    });
  }

  function fullGate(runId: string): void {
    recordReview(runId);
    recordFinalAcceptance(runId);
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-standalone-delivery-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    writeExecutionAuthority("local");
    db = initializeDatabase(join(root, "state", "console.db"));
    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
    forge = new SyntheticForgeAdapter({ [REPO]: 151 }, forgeOptions());
    registry = new ProjectRegistryService(db, forge);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", `url.${bareOrigin}.insteadOf`, `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    git(checkoutPath, "commit", "--allow-empty", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    git(checkoutPath, "push", "-q", "origin", "main");
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    plans = new PlanService(db, forge);
    ledger = new CommandLedger(db);
    brakes = new BrakeService(db);
    observations = new ExecutionObservationService(db);
    publication = new PublicationService(db, forge);
    delivery = new DeliveryGateService(db, { observations, publication, forge });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1/AC2: standalone uses its own branch and PR to the delivery branch; child/technical evidence cannot satisfy the full gate", async () => {
    const { plan, run } = await dispatchStandalone(1600);
    expect(plan.kind).toBe("standalone");
    expect(plan.integration_branch).toBeNull();
    expect(run.gate_profile).toBe("standalone");
    expect(run.merge_policy).toBe("manual");
    expect(run.target_branch).toBe("main");
    expect(run.branch).toMatch(/^factory\/standalone-1600/);
    expect(run.branch).not.toBe("main");

    const published = await publication.publishByRun(projectId, run.id);
    expect(published.pullRequests).toHaveLength(1);
    expect(published.pullRequests[0]).toMatchObject({
      headBranch: run.branch,
      baseBranch: "main",
      draft: true,
    });
    expect(published.auditComplete).toBe(true);

    register("gate-1", "automated_gate");
    observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "passed",
      producer: { id: "gate-1", role: "automated_gate" },
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });

    const technicalOnly = await delivery.getGate(projectId, run.id);
    expect(technicalOnly.state).toBe("blocked");
    expect(technicalOnly.stages.find((stage) => stage.name === "final_acceptance")).toMatchObject({
      status: "missing",
    });
    expect(technicalOnly.mergePolicy).toBe("manual");
    expect(technicalOnly.merge.state).toBe("not_merged");

    // A child-profile run can never use the full-delivery gate as a shortcut.
    addIssue(1601, specBody(), ["ready-for-agent", "spec"]);
    addIssue(1602, ticketBody(1601));
    const specPlan = await plans.importPlan(projectId, {
      issue_number: 1601,
      kind: "spec",
    });
    expect(specPlan.authority).toBe("admitted");
    git(checkoutPath, "branch", "factory/spec-1601-integration", "main");
    const childRun = await makeDispatch().dispatch(projectId, {
      plan_id: specPlan.id,
      issue_number: 1602,
      actor: "operator",
    });
    expect(childRun.gate_profile).toBe("child");
    await expect(delivery.getGate(projectId, childRun.id)).rejects.toMatchObject({
      code: "delivery_profile_unsupported",
    });
  });

  test("AC2/AC3/AC5: failed final acceptance enters correction, a bounded re-lap passes full QA/review and waits for manual merge", async () => {
    const { plan, run } = await dispatchStandalone(1610);
    await publication.publishByRun(projectId, run.id);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");
    register("gate-1", "automated_gate");

    recordReview(run.id);
    recordFinalAcceptance(run.id, { status: "failed" });
    const failed = await delivery.getGate(projectId, run.id);
    expect(failed.state).toBe("correction_required");
    expect(failed.acceptance.openBlockingFindingIds.length).toBeGreaterThan(0);
    expect(failed.reasons).toContain("open_blocking_findings");

    const finding = observations.listFindings(projectId, { runId: run.id })[0]!;
    expect(finding.status).toBe("open");

    const secondRun = await makeDispatch(committingRunner("impl-2.txt")).dispatch(projectId, {
      plan_id: plan.id,
      work_id: run.work_id,
      actor: "operator",
    });
    expect(secondRun.lap).toBe(2);

    observations.recordFindingFix(projectId, finding.id, {
      actor: "operator",
      detail: "builder corrected AC1 in lap 2",
    });
    const resolved = observations.recordFindingRecheck(projectId, finding.id, {
      runId: secondRun.id,
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      status: "passed",
      checks: [{ name: "AC1 recheck", command: "acceptance AC1", result: "PASS" }],
    });
    expect(resolved.status).toBe("resolved");

    fullGate(secondRun.id);
    const republished = await publication.publishByRun(projectId, secondRun.id);
    expect(republished.auditComplete).toBe(true);
    expect(republished.pullRequests.filter((pr) => pr.active)).toHaveLength(1);
    expect(republished.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["verification_failure", "fix_submitted", "recheck_passed"]),
    );

    const ready = await delivery.getGate(projectId, secondRun.id);
    expect(ready.state).toBe("ready_for_operator_review");
    expect(ready.reasons).toEqual([]);
    expect(ready.manualMergeRequired).toBe(true);
    expect(ready.merge.state).toBe("not_merged");
    expect(
      ready.stages.every((stage) => stage.status === "passed" || stage.status === "not_applicable"),
    ).toBe(true);

    // The manual-merge default is real: no delivery to main happened.
    const remoteMain = remoteHead("main");
    expect(remoteMain).not.toBe(secondRun.head_sha);
    expect(
      (await forge.getPullRequest(REPO, republished.pullRequests.find((pr) => pr.active)!.number!))
        ?.state,
    ).toBe("OPEN");
  });

  test("AC4: remote head/base drift and closed-unmerged PRs never authorize delivery", async () => {
    const { run } = await dispatchStandalone(1620);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");
    fullGate(run.id);
    const published = await publication.publishByRun(projectId, run.id);
    const pr = published.pullRequests[0]!;
    expect((await delivery.getGate(projectId, run.id)).state).toBe("ready_for_operator_review");

    await forge.updatePullRequest(REPO, pr.number!, { base: "develop" });
    const drifted = await delivery.getGate(projectId, run.id);
    expect(drifted.state).toBe("invalidated");
    expect(drifted.reasons).toContain("remote_base_branch_mismatch");

    await forge.updatePullRequest(REPO, pr.number!, { base: "main", state: "closed" });
    const closed = await delivery.getGate(projectId, run.id);
    expect(closed.state).toBe("closed_unmerged");
    expect(closed.merge.state).toBe("closed_unmerged");

    expect(
      await delivery.verifyMerge(projectId, run.id).then(
        () => "unexpected",
        (error) => (error as DeliveryError).code,
      ),
    ).toBe("delivery_merge_not_verified");
  });

  test("AC4/AC5: remote unavailability stays incomplete and is distinct from a merge", async () => {
    const { run } = await dispatchStandalone(1630);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");
    fullGate(run.id);
    await publication.publishByRun(projectId, run.id);

    forge.failNextGetPullRequest = true;
    const unavailable = await delivery.getGate(projectId, run.id);
    expect(unavailable.state).toBe("remote_unavailable");
    expect(unavailable.merge.state).toBe("remote_unavailable");
    forge.failNextGetPullRequest = true;
    await expect(delivery.verifyMerge(projectId, run.id)).rejects.toMatchObject({
      code: "delivery_remote_unreadable",
    });
  });

  test("AC4/AC5: a merged PR is delivered only after target lineage verification, idempotently", async () => {
    const { run } = await dispatchStandalone(1640);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");
    fullGate(run.id);
    const published = await publication.publishByRun(projectId, run.id);
    const pr = published.pullRequests[0]!;
    expect((await delivery.getGate(projectId, run.id)).state).toBe("ready_for_operator_review");

    // Remote merge without target inclusion is not delivery.
    await forge.updatePullRequest(REPO, pr.number!, { draft: false });
    expect((await forge.mergePullRequest(REPO, pr.number!)).merged).toBe(true);
    const mergedWithoutLineage = await delivery.getGate(projectId, run.id);
    expect(mergedWithoutLineage.state).toBe("invalidated");
    expect(mergedWithoutLineage.reasons).toContain("target_lineage_not_verified");
    await expect(delivery.verifyMerge(projectId, run.id)).rejects.toMatchObject({
      code: "delivery_gate_unsatisfied",
    });

    // The exact configured target now includes the candidate.
    execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", run.head_sha!], {
      stdio: "ignore",
    });
    const awaiting = await delivery.getGate(projectId, run.id);
    expect(awaiting.state).toBe("awaiting_merge_verification");
    expect(awaiting.merge.state).toBe("unverified");
    expect(awaiting.merge.remoteTargetTipSha).toBe(run.head_sha);

    const delivered = await delivery.verifyMerge(projectId, run.id, "operator");
    expect(delivered.state).toBe("delivered");
    expect(delivered.merge.verified).toBe(true);
    expect(delivered.merge.verification).toMatchObject({
      runId: run.id,
      prNumber: pr.number,
      sourceBranch: run.branch,
      targetBranch: "main",
      candidateHeadSha: run.head_sha,
      remoteTargetTipSha: run.head_sha,
      mergeCommitSha: `merged_sha_${pr.number}`,
      verifiedBy: "operator",
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM delivery_merge_verifications WHERE project_id = ? AND run_id = ?",
        )
        .get(projectId, run.id),
    ).toEqual({ count: 1 });

    const replay = await delivery.verifyMerge(projectId, run.id, "operator");
    expect(replay.state).toBe("delivered");
    expect(replay.merge.verification?.id).toBe(delivered.merge.verification?.id);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM delivery_merge_verifications WHERE project_id = ? AND run_id = ?",
        )
        .get(projectId, run.id),
    ).toEqual({ count: 1 });
  });
});
