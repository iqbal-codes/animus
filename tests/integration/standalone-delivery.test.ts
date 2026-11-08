import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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

  let cloneCounter = 0;

  function cloneOrigin(label: string): string {
    const dir = join(root, `${label}-${cloneCounter++}`);
    execFileSync("git", ["clone", "-q", bareOrigin, dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    return dir;
  }

  function advanceRemoteMain(label = "advance"): string {
    const dir = cloneOrigin(label);
    git(dir, "checkout", "-q", "main");
    git(dir, "commit", "--allow-empty", "-q", "-m", `remote advance ${label}`);
    git(dir, "push", "-q", "origin", "main");
    return git(dir, "rev-parse", "HEAD");
  }

  function mergePrIntoRemoteMain(
    pr: { headBranch?: string | null; baseBranch?: string | null },
    label = "merge",
  ): string {
    const head = pr.headBranch!;
    const base = pr.baseBranch!;
    const dir = cloneOrigin(label);
    git(dir, "checkout", "-q", base);
    git(dir, "fetch", "-q", "origin", `${head}:refs/remotes/origin/${head}`);
    git(dir, "merge", "--no-ff", `origin/${head}`, "-m", `merge ${head}`);
    git(dir, "push", "-q", "origin", base);
    return git(dir, "rev-parse", "HEAD");
  }

  function artifactRootForTest(): string {
    return join(root, "animus-home", "state", "artifacts", projectId);
  }

  function writeArtifact(relativePath: string, content: string): void {
    const absolute = join(artifactRootForTest(), relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
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
      mergeCommitSha: null,
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

  test("B1: remote target advancement invalidates readiness before merge", async () => {
    const { run } = await dispatchStandalone(1650);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");
    fullGate(run.id);
    await publication.publishByRun(projectId, run.id);

    const ready = await delivery.getGate(projectId, run.id);
    expect(ready.state).toBe("ready_for_operator_review");
    const testedTip = ready.acceptance.targetTipSha;

    const advanced = advanceRemoteMain("pre-merge");
    expect(advanced).not.toBe(testedTip);

    const stale = await delivery.getGate(projectId, run.id);
    expect(stale.state).toBe("invalidated");
    expect(stale.reasons).toContain("stale_target_tip");
  });

  test("B1: a merge onto an advanced target never delivers stale tested evidence", async () => {
    const { run } = await dispatchStandalone(1651);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");
    fullGate(run.id);
    const published = await publication.publishByRun(projectId, run.id);
    const pr = published.pullRequests[0]!;

    advanceRemoteMain("advanced-before-merge");
    const mergeSha = mergePrIntoRemoteMain(pr, "stale-merge");
    forge.setMergeRemote(() => ({ sha: mergeSha }));
    await forge.updatePullRequest(REPO, pr.number!, { draft: false });
    await forge.mergePullRequest(REPO, pr.number!);

    const gate = await delivery.getGate(projectId, run.id);
    expect(gate.state).toBe("invalidated");
    expect(gate.merge.verified).toBe(false);
    expect(gate.reasons.join(",")).toMatch(/stale_target_tip|merge_base_mismatch/);
    await expect(delivery.verifyMerge(projectId, run.id)).rejects.toMatchObject({
      code: "delivery_gate_unsatisfied",
    });
  });

  test("B1: an ordinary merge onto the tested target tip is verified only with real lineage proof", async () => {
    const { run } = await dispatchStandalone(1652);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");
    fullGate(run.id);
    const published = await publication.publishByRun(projectId, run.id);
    const pr = published.pullRequests[0]!;

    const mergeSha = mergePrIntoRemoteMain(pr, "ordinary-merge");
    forge.setMergeRemote(() => ({ sha: mergeSha }));
    await forge.updatePullRequest(REPO, pr.number!, { draft: false });
    await forge.mergePullRequest(REPO, pr.number!);

    const awaiting = await delivery.getGate(projectId, run.id);
    expect(awaiting.state).toBe("awaiting_merge_verification");
    expect(awaiting.merge.remoteTargetTipSha).toBe(mergeSha);

    const delivered = await delivery.verifyMerge(projectId, run.id, "operator");
    expect(delivered.state).toBe("delivered");
    expect(delivered.merge.verification?.mergeCommitSha).toBe(mergeSha);
    expect(delivered.merge.verification?.remoteTargetTipSha).toBe(mergeSha);
  });

  test("B2: required remote CI is read from branch protection for the PR head and cannot be producer-asserted", async () => {
    const { run } = await dispatchStandalone(1653);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");
    fullGate(run.id);
    await publication.publishByRun(projectId, run.id);

    forge.setRequiredStatusChecks(REPO, "main", ["ci/build"]);

    const missing = await delivery.getGate(projectId, run.id);
    expect(missing.state).toBe("blocked");
    expect(missing.stages.find((stage) => stage.name === "remote_ci")?.status).toBe("failed");
    expect(missing.reasons).toContain("remote_ci_missing");

    forge.setCheckRuns(REPO, run.head_sha!, [
      { name: "ci/build", status: "in_progress", conclusion: null },
    ]);
    const pending = await delivery.getGate(projectId, run.id);
    expect(pending.state).toBe("blocked");
    expect(pending.reasons).toContain("remote_ci_pending");

    forge.setCheckRuns(REPO, run.head_sha!, [
      { name: "ci/build", status: "completed", conclusion: "failure" },
    ]);
    const failed = await delivery.getGate(projectId, run.id);
    expect(failed.state).toBe("blocked");
    expect(failed.reasons).toContain("remote_ci_failed");

    forge.setCheckRuns(REPO, run.head_sha!, [
      { name: "ci/build", status: "completed", conclusion: "success" },
    ]);
    const passing = await delivery.getGate(projectId, run.id);
    expect(passing.state).toBe("ready_for_operator_review");
    expect(passing.stages.find((stage) => stage.name === "remote_ci")?.status).toBe("passed");

    forge.failNextCheckRuns = true;
    const unreadable = await delivery.getGate(projectId, run.id);
    expect(unreadable.state).toBe("blocked");
    expect(unreadable.reasons).toContain("remote_ci_unreadable");
  });

  test("B3: every authorizing observation re-verifies artifact presence, size and hash", async () => {
    const { run } = await dispatchStandalone(1654);
    register("reviewer-1", "peer_reviewer");
    register("final-1", "independent_evaluator");

    writeArtifact("checks/review.json", '{"review":"passed"}\n');
    writeArtifact("checks/qa.json", '{"qa":"passed"}\n');

    observations.recordRunObservation(projectId, run.id, {
      stage: "independent_review",
      status: "passed",
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      checks: [
        {
          name: "standards review",
          command: "review diff",
          result: "PASS",
          kind: "review",
          artifactPath: "checks/review.json",
        },
      ],
      artifacts: [
        {
          ownerType: "observation",
          name: "review-report",
          relativePath: "checks/review.json",
          mediaType: "application/json",
        },
      ],
    });
    observations.recordRunObservation(projectId, run.id, {
      stage: "final_acceptance",
      status: "passed",
      producer: { id: "final-1", role: "independent_evaluator" },
      checks: [
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
          artifactPath: "checks/qa.json",
        },
      ],
      artifacts: [
        {
          ownerType: "observation",
          name: "qa-report",
          relativePath: "checks/qa.json",
          mediaType: "application/json",
        },
      ],
    });
    await publication.publishByRun(projectId, run.id);
    const status = publication.getStatusByRun(projectId, run.id);
    for (const observation of observations.listObservations(projectId, { runId: run.id })) {
      for (const artifact of observation.artifacts) {
        publication.bindEvidence(
          projectId,
          status.target.id,
          artifact.id,
          `https://github.com/user-attachments/assets/${artifact.id}`,
        );
      }
    }
    await publication.publishByRun(projectId, run.id);

    expect((await delivery.getGate(projectId, run.id)).state).toBe("ready_for_operator_review");

    rmSync(join(artifactRootForTest(), "checks/review.json"));
    const missingReview = await delivery.getGate(projectId, run.id);
    expect(missingReview.state).toBe("blocked");
    expect(missingReview.reasons).toContain("artifact_missing:checks/review.json");

    writeArtifact("checks/review.json", '{"review":"fail3d"}\n');
    const corruptReview = await delivery.getGate(projectId, run.id);
    expect(corruptReview.state).toBe("blocked");
    expect(corruptReview.reasons).toContain("artifact_digest_mismatch:checks/review.json");

    rmSync(join(artifactRootForTest(), "checks/qa.json"));
    const missingFinal = await delivery.getGate(projectId, run.id);
    expect(missingFinal.state).toBe("blocked");
    expect(missingFinal.reasons).toContain("artifact_missing:checks/qa.json");
  });

  test("B3: final acceptance cannot be certified by the builder identity", async () => {
    const { run } = await dispatchStandalone(1655);
    register("reviewer-1", "peer_reviewer");
    recordReview(run.id);
    const lineage = (
      db
        .prepare("SELECT graph_hash FROM deliveries WHERE project_id = ? AND id = ?")
        .get(projectId, run.delivery_id) as { graph_hash: string }
    ).graph_hash;
    // Bypass the writer-level guard deliberately: the gate must defend in depth
    // against an authorizing observation recorded with the builder identity.
    db.prepare(
      `INSERT INTO execution_observations
         (id, project_id, delivery_id, run_id, lap, attempt_key, stage, status, candidate_head_sha,
          target_tip_sha, merge_base_sha, tested_identity, integration_lineage, producer_id,
          producer_role, producer_name, gate_profile, gate_profile_version, error, created_at)
       VALUES (?, ?, ?, ?, ?, 'stage:final_acceptance', 'final_acceptance', 'passed', ?, ?, ?, ?, ?, ?, 'independent_evaluator', NULL, ?, 2, NULL, ?)`,
    ).run(
      "obs_builder_final_n2",
      projectId,
      run.delivery_id,
      run.id,
      run.lap,
      run.head_sha,
      run.base_sha,
      run.base_sha,
      run.head_sha,
      `${lineage}@main`,
      "operator",
      run.gate_profile,
      Date.now(),
    );
    const gate = await delivery.getGate(projectId, run.id);
    expect(gate.state).toBe("correction_required");
    expect(gate.reasons).toContain("self_certified_stage:final_acceptance");
  });

  test("N2: the gate and acceptance use one canonical latest-observation ordering", async () => {
    const { run } = await dispatchStandalone(1656);
    const lineage = (
      db
        .prepare("SELECT graph_hash FROM deliveries WHERE project_id = ? AND id = ?")
        .get(projectId, run.delivery_id) as { graph_hash: string }
    ).graph_hash;
    const sameTime = 5_000_000;
    const insert = db.prepare(
      `INSERT INTO execution_observations
         (id, project_id, delivery_id, run_id, lap, attempt_key, stage, status, candidate_head_sha,
          target_tip_sha, merge_base_sha, tested_identity, integration_lineage, producer_id,
          producer_role, producer_name, gate_profile, gate_profile_version, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'independent_review', ?, ?, ?, ?, ?, ?, ?, 'peer_reviewer', NULL, ?, 2, NULL, ?)`,
    );
    // Insertion order is zzz then aaa with an identical timestamp. Only insertion
    // (rowid) order can say which one is actually latest.
    insert.run(
      "obs_zzz_n2",
      projectId,
      run.delivery_id,
      run.id,
      run.lap,
      "n2-passed",
      "passed",
      run.head_sha,
      run.base_sha,
      run.base_sha,
      run.head_sha,
      `${lineage}@main`,
      "n2-reviewer",
      run.gate_profile,
      sameTime,
    );
    insert.run(
      "obs_aaa_n2",
      projectId,
      run.delivery_id,
      run.id,
      run.lap,
      "n2-failed",
      "failed",
      run.head_sha,
      run.base_sha,
      run.base_sha,
      run.head_sha,
      `${lineage}@main`,
      "n2-reviewer",
      run.gate_profile,
      sameTime,
    );

    const reviews = observations
      .listObservations(projectId, { runId: run.id })
      .filter((observation) => observation.stage === "independent_review");
    expect(reviews.at(-1)?.id).toBe("obs_aaa_n2");

    const acceptance = observations.evaluateAcceptance(projectId, run.id);
    expect(acceptance.independentObservationId).toBe("obs_aaa_n2");

    const gate = await delivery.getGate(projectId, run.id);
    expect(gate.stages.find((stage) => stage.name === "independent_review")?.status).toBe("failed");
  });
});
