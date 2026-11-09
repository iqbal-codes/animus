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
import { ChildIntegrationService } from "../../apps/backend/src/integration";
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import { seedActivatedAuthority } from "./support/activated-authority";

const REPO = "owner/child-integration-repo";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function specBody(criteria: string[]): string {
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
    ...criteria.map((criterion, index) => `- [ ] AC${index + 1} — ${criterion}`),
    "",
    "## Boundary",
    "",
    "Prepared specification boundary.",
  ].join("\n");
}

function ticketBody(options: { partOf: number; dependsOn?: number[]; coverage?: string }): string {
  const lines = ["Part of #" + options.partOf, ""];
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
      ? `Depends on: ${options.dependsOn.map((n) => `#${n}`).join(", ")}`
      : "Depends on: None",
  );
  return lines.join("\n");
}

describe("child gate integration", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let observations: ExecutionObservationService;
  let publication: PublicationService;
  let checkoutPath: string;
  let bareOrigin: string;
  let projectId: string;

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
      mergeRemote: (_repo, pr) => mergeOnBareOrigin(pr),
    };
  }

  function mergeOnBareOrigin(pr: ForgePullRequest): { sha: string } {
    const headSha = pr.headRefOid ?? remoteHead(pr.head);
    const baseSha = remoteHead(pr.base);
    if (!headSha || !baseSha) {
      throw new Error("merge transport is missing a real remote ref");
    }
    const tree = git(checkoutPath, "merge-tree", "--write-tree", baseSha, headSha);
    const treeSha = tree.split("\n")[0]!.trim();
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

  function committingRunner(name: string): DispatchRunner {
    return async (context) => {
      writeFileSync(join(context.worktree_path, name), "implemented\n");
      git(context.worktree_path, "add", name);
      git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
      return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
    };
  }

  function makeDispatch(runner: DispatchRunner): DispatchService {
    return new DispatchService(db, {
      plans,
      ledger,
      brakes,
      observations,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner,
    });
  }

  function makeIntegration(targetForge: SyntheticForgeAdapter = forge): ChildIntegrationService {
    return new ChildIntegrationService(db, {
      observations,
      publication: new PublicationService(db, targetForge),
      forge: targetForge,
    });
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
    role: "peer_reviewer" | "independent_evaluator" | "automated_gate" | "builder",
  ) {
    return observations.registerTrustedProducer(projectId, { id, role });
  }

  async function importSpec(
    specIssue: number,
    tickets: Array<{ issue: number; dependsOn?: number[] }>,
  ) {
    addIssue(specIssue, specBody(tickets.map((ticket) => `ticket ${ticket.issue}`)), [
      "ready-for-agent",
      "spec",
    ]);
    tickets.forEach((ticket, index) => {
      addIssue(
        ticket.issue,
        ticketBody({
          partOf: specIssue,
          dependsOn: ticket.dependsOn,
          coverage: `AC${index + 1}`,
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

  async function recordPassingGates(runId: string, label = "round") {
    const gate = register(`gate-${label}`, "automated_gate");
    const reviewer = register(`reviewer-${label}`, "peer_reviewer");
    observations.recordRunObservation(projectId, runId, {
      stage: "technical_checks",
      status: "passed",
      producer: gate.producer,
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });
    observations.recordRunObservation(projectId, runId, {
      stage: "independent_review",
      status: "passed",
      producer: reviewer.producer,
      checks: [{ name: "standards", command: "review diff", result: "PASS" }],
    });
  }

  function integrationRow(runId: string) {
    return db
      .prepare("SELECT * FROM child_integrations WHERE project_id = ? AND run_id = ?")
      .get(projectId, runId) as Record<string, unknown> | undefined;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-child-integration-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
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
    forge = new SyntheticForgeAdapter({ [REPO]: 823 }, forgeOptions());
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
    observations = new ExecutionObservationService(db);
    publication = new PublicationService(db, forge);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1/AC4: a child runs through gates, publishes a real PR, merges and releases its dependent", async () => {
    const { plan, branch } = await importSpec(900, [
      { issue: 901 },
      { issue: 902, dependsOn: [901] },
    ]);
    const dispatch = makeDispatch(committingRunner("impl-a.txt"));
    const integration = makeIntegration();

    // The dependent is held until the prerequisite is verified on the target lineage.
    await expect(
      dispatch.dispatch(projectId, { plan_id: plan.id, issue_number: 902, actor: "operator" }),
    ).rejects.toMatchObject({ code: "dependency_pending_integration" });

    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 901,
      actor: "operator",
    });
    expect(run.state).toBe("succeeded");

    await recordPassingGates(run.id);
    await publication.publishByRun(projectId, run.id);

    const status = await integration.land(projectId, run.id);
    expect(status.state).toBe("integrated");
    expect(status.blockers).toHaveLength(0);
    expect(status.acceptance.authorized).toBe(true);
    expect(status.integration).toMatchObject({
      candidateHeadSha: run.head_sha,
      targetBranch: branch,
    });

    const row = integrationRow(run.id)!;
    expect(row).toBeTruthy();
    expect(row.merge_sha).toBeTruthy();
    expect(remoteHead(branch)).toBe(row.target_tip_after_sha);

    // The remote merge commit includes the candidate.
    git(checkoutPath, "merge-base", "--is-ancestor", run.head_sha!, row.merge_sha as string);

    // The PR is MERGED and the dependent is now dispatchable.
    const publicationStatus = publication.getStatusByRun(projectId, run.id);
    const mergedPullRequest = publicationStatus.pullRequests.find((pr) => pr.number)!;
    const remote = await forge.getPullRequest(REPO, mergedPullRequest.number!);
    expect(remote?.state).toBe("MERGED");

    const dependent = await makeDispatch(committingRunner("impl-b.txt")).dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 902,
      actor: "operator",
    });
    expect(dependent.issue_number).toBe(902);

    // Landing again is idempotent: one record, one merged event.
    const again = await integration.land(projectId, run.id);
    expect(again.state).toBe("integrated");
    const integrations = db
      .prepare("SELECT COUNT(*) AS count FROM child_integrations WHERE run_id = ?")
      .get(run.id) as { count: number };
    expect(integrations.count).toBe(1);
    const mergedEvents = db
      .prepare(
        "SELECT COUNT(*) AS count FROM child_integration_events WHERE run_id = ? AND kind = 'merged'",
      )
      .get(run.id) as { count: number };
    expect(mergedEvents.count).toBe(1);
  });

  test("AC1/AC2: missing independent review or a self-certified reviewer blocks the merge", async () => {
    const { plan } = await importSpec(910, [{ issue: 911 }]);
    const dispatch = makeDispatch(committingRunner("impl-review.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 911,
      actor: "operator",
    });

    const gate = register("gate-review", "automated_gate");
    observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "passed",
      producer: gate.producer,
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });
    await publication.publishByRun(projectId, run.id);

    const missing = await integration.land(projectId, run.id);
    expect(missing.state).toBe("blocked");
    expect(missing.acceptance.reasons).toContain("required_stage_missing:independent_review");
    expect(remoteHead("factory/spec-910-integration")).toBe(run.base_sha);

    // A builder identity cannot certify its own independent stage.
    const builder = { id: "operator", role: "builder" as const };
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "independent_review",
        status: "passed",
        producer: builder,
        checks: [{ name: "review", command: "self", result: "PASS" }],
      }),
    ).toThrow(/self.?certif|builder/i);

    await recordPassingGates(run.id, "review-pass");
    const merged = await integration.land(projectId, run.id);
    expect(merged.state).toBe("integrated");
  });

  test("AC2: a failed review finding blocks; an authorized fix and recheck release it", async () => {
    const { plan } = await importSpec(920, [{ issue: 921 }]);
    const dispatch = makeDispatch(committingRunner("impl-fix.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 921,
      actor: "operator",
    });

    const gate = register("gate-fix", "automated_gate");
    observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "failed",
      producer: gate.producer,
      checks: [{ name: "unit", command: "bun test", result: "FAIL", detail: "1 failing" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "impl-fix.txt:1",
          summary: "prepared criterion is not implemented",
        },
      ],
    });
    await publication.publishByRun(projectId, run.id);
    const blocked = await integration.land(projectId, run.id);
    expect(blocked.state).toBe("blocked");
    expect(blocked.acceptance.reasons).toContain("open_blocking_findings");

    const finding = observations.listFindings(projectId, { runId: run.id })[0]!;
    observations.recordFindingFix(projectId, finding.id, {
      actor: "operator",
      detail: "builder claims fixed",
    });
    // A builder fix submission alone cannot resolve the finding.
    expect(observations.listFindings(projectId, { runId: run.id })[0]!.status).toBe("open");
    const reviewer = register("reviewer-fix", "peer_reviewer");
    observations.recordFindingRecheck(projectId, finding.id, {
      producer: reviewer.producer,
      status: "passed",
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });
    await recordPassingGates(run.id, "fix-pass");

    const merged = await integration.land(projectId, run.id);
    expect(merged.state).toBe("integrated");
    expect(
      observations
        .listObservations(projectId, { runId: run.id })
        .some((item) => item.stage === "technical_checks" && item.status === "failed"),
    ).toBe(true);
  });

  test("AC1/AC2: required remote CI must be completed and passing", async () => {
    const { plan, branch } = await importSpec(930, [{ issue: 931 }]);
    const dispatch = makeDispatch(committingRunner("impl-ci.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 931,
      actor: "operator",
    });
    await recordPassingGates(run.id);
    await publication.publishByRun(projectId, run.id);
    forge.setRequiredStatusChecks(REPO, branch, ["ci/verify"]);

    const missing = await integration.land(projectId, run.id);
    expect(missing.state).toBe("blocked");
    expect(missing.blockers.map((b) => b.code)).toContain("integration_ci_missing");

    forge.setCheckRuns(REPO, run.head_sha!, [
      { name: "ci/verify", status: "in_progress", conclusion: null },
    ]);
    const pending = await integration.land(projectId, run.id);
    expect(pending.blockers.map((b) => b.code)).toContain("integration_ci_pending");

    forge.setCheckRuns(REPO, run.head_sha!, [
      { name: "ci/verify", status: "completed", conclusion: "failure" },
    ]);
    const failed = await integration.land(projectId, run.id);
    expect(failed.blockers.map((b) => b.code)).toContain("integration_ci_failed");

    forge.setCheckRuns(REPO, run.head_sha!, [
      { name: "ci/verify", status: "completed", conclusion: "success" },
    ]);
    const merged = await integration.land(projectId, run.id);
    expect(merged.state).toBe("integrated");
    expect(merged.requiredChecks).toEqual([
      { name: "ci/verify", required: true, status: "completed", conclusion: "success" },
    ]);
  });

  test("AC3: a conflicting integration branch holds instead of forcing the merge", async () => {
    const { plan, branch } = await importSpec(940, [{ issue: 941 }]);
    const dispatch = makeDispatch(committingRunner("impl-conflict.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 941,
      actor: "operator",
    });

    // Advance the integration branch with a conflicting edit to the same file, then
    // record evidence against that fresh target so only the conflict can block.
    const conflictWorktree = join(root, "conflict-worktree");
    git(checkoutPath, "worktree", "add", "-q", "--detach", conflictWorktree, branch);
    writeFileSync(join(conflictWorktree, "impl-conflict.txt"), "conflicting\n");
    git(conflictWorktree, "add", "impl-conflict.txt");
    git(conflictWorktree, "commit", "-q", "-m", "conflicting edit");
    git(conflictWorktree, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    git(checkoutPath, "update-ref", `refs/heads/${branch}`, remoteHead(branch)!);

    await recordPassingGates(run.id);
    await publication.publishByRun(projectId, run.id);

    const blocked = await integration.land(projectId, run.id);
    expect(blocked.state).toBe("blocked");
    expect(blocked.blockers.map((b) => b.code)).toContain("integration_conflict");
    expect(integrationRow(run.id)).toBeUndefined();
    const publicationStatus = publication.getStatusByRun(projectId, run.id);
    const active = publicationStatus.pullRequests.find((pr) => pr.active)!;
    expect((await forge.getPullRequest(REPO, active.number!))?.state).toBe("OPEN");
  });

  test("AC3: target drift after evidence invalidates the candidate instead of merging", async () => {
    const { plan, branch } = await importSpec(950, [{ issue: 951 }]);
    const dispatch = makeDispatch(committingRunner("impl-drift.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 951,
      actor: "operator",
    });
    await recordPassingGates(run.id);
    await publication.publishByRun(projectId, run.id);

    const driftWorktree = join(root, "drift-worktree");
    git(checkoutPath, "worktree", "add", "-q", "--detach", driftWorktree, branch);
    writeFileSync(join(driftWorktree, "unrelated.txt"), "drift\n");
    git(driftWorktree, "add", "unrelated.txt");
    git(driftWorktree, "commit", "-q", "-m", "unrelated drift");
    git(driftWorktree, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    const driftedTip = remoteHead(branch);
    git(checkoutPath, "update-ref", `refs/heads/${branch}`, driftedTip!);

    const blocked = await integration.land(projectId, run.id);
    expect(blocked.state).toBe("blocked");
    expect(blocked.acceptance.reasons).toContain("stale_target_tip");
    expect(integrationRow(run.id)).toBeUndefined();
    expect(remoteHead(branch)).toBe(driftedTip);

    // Stale evidence must re-enter a new bounded builder lap on the fresh target.
    const rebound = await makeDispatch(committingRunner("impl-drift-2.txt")).dispatch(projectId, {
      plan_id: plan.id,
      work_id: run.work_id,
      actor: "operator",
    });
    expect(rebound.lap).toBe(2);
    await recordPassingGates(rebound.id, "reverify");
    const merged = await integration.land(projectId, rebound.id);
    expect(merged.state).toBe("integrated");
    expect(merged.integration?.candidateHeadSha).toBe(rebound.head_sha);
  });

  test("AC3/AC5: concurrent completions serialize and the second re-verifies", async () => {
    const { plan, branch } = await importSpec(960, [{ issue: 961 }, { issue: 962 }]);
    const dispatchFirst = makeDispatch(committingRunner("impl-concurrent-a.txt"));
    const dispatchSecond = makeDispatch(committingRunner("impl-concurrent-b.txt"));
    const integration = makeIntegration();

    const first = await dispatchFirst.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 961,
      actor: "operator",
    });
    const second = await dispatchSecond.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 962,
      actor: "operator",
    });
    await recordPassingGates(first.id, "first");
    await recordPassingGates(second.id, "second");
    await publication.publishByRun(projectId, first.id);
    await publication.publishByRun(projectId, second.id);

    const integratedFirst = await integration.land(projectId, first.id);
    expect(integratedFirst.state).toBe("integrated");
    const tipAfterFirst = remoteHead(branch);

    // The second candidate's evidence was bound to the previous target tip; it holds.
    const stale = await integration.land(projectId, second.id);
    expect(stale.state).toBe("blocked");
    expect(stale.acceptance.reasons).toContain("stale_target_tip");
    expect(remoteHead(branch)).toBe(tipAfterFirst);

    // The stale candidate re-enters a new bounded builder lap on the advanced target.
    const rebound = await dispatchSecond.dispatch(projectId, {
      plan_id: plan.id,
      work_id: second.work_id,
      actor: "operator",
    });
    expect(rebound.lap).toBe(2);
    await recordPassingGates(rebound.id, "second-reverify");
    const integratedSecond = await integration.land(projectId, rebound.id);
    expect(integratedSecond.state).toBe("integrated");

    const tipAfterSecond = remoteHead(branch);
    git(checkoutPath, "merge-base", "--is-ancestor", first.head_sha!, tipAfterSecond!);
    git(checkoutPath, "merge-base", "--is-ancestor", rebound.head_sha!, tipAfterSecond!);
  });

  test("AC2/AC4: a closed pull request never satisfies the dependency", async () => {
    const { plan } = await importSpec(970, [{ issue: 971 }, { issue: 972, dependsOn: [971] }]);
    const dispatch = makeDispatch(committingRunner("impl-closed.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 971,
      actor: "operator",
    });
    await recordPassingGates(run.id);
    const published = await publication.publishByRun(projectId, run.id);
    const active = published.pullRequests.find((pr) => pr.active)!;
    await forge.updatePullRequest(REPO, active.number!, { state: "closed" });
    // Re-publish so the stored target reflects the closed remote PR state.
    await publication.publishByRun(projectId, run.id);

    const blocked = await integration.land(projectId, run.id);
    expect(blocked.state).toBe("blocked");
    expect(integrationRow(run.id)).toBeUndefined();
    await expect(
      dispatch.dispatch(projectId, { plan_id: plan.id, issue_number: 972, actor: "operator" }),
    ).rejects.toMatchObject({ code: "dependency_pending_integration" });
  });

  test("AC4: a remote MERGED state without lineage inclusion is not recorded as integrated", async () => {
    const fakeForge = new SyntheticForgeAdapter(
      { [REPO]: 823 },
      {
        requireRemoteSourceRef: true,
        resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
        // Marks the PR merged without advancing the remote target: not enough proof.
        mergeRemote: () => ({ sha: "b".repeat(40) }),
      },
    );
    fakeForge.addIssue(REPO, {
      number: 980,
      title: "Issue 980",
      body: specBody(["ticket 981"]),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });
    fakeForge.addIssue(REPO, {
      number: 981,
      title: "Issue 981",
      body: ticketBody({ partOf: 980, coverage: "AC1" }),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    const fakePlans = new PlanService(db, fakeForge);
    const fakePlan = await fakePlans.importPlan(projectId, { issue_number: 980, kind: "spec" });
    const branch = "factory/spec-980-integration";
    git(checkoutPath, "branch", "-f", branch, "main");
    git(checkoutPath, "push", "-q", "origin", branch);
    const fakeDispatch = new DispatchService(db, {
      plans: fakePlans,
      ledger,
      brakes,
      observations,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: committingRunner("impl-fake-merge.txt"),
    });
    const run = await fakeDispatch.dispatch(projectId, {
      plan_id: fakePlan.id,
      issue_number: 981,
      actor: "operator",
    });
    await recordPassingGates(run.id);
    await new PublicationService(db, fakeForge).publishByRun(projectId, run.id);

    const status = await new ChildIntegrationService(db, {
      observations,
      publication: new PublicationService(db, fakeForge),
      forge: fakeForge,
    }).land(projectId, run.id);
    expect(status.state).toBe("blocked");
    expect(status.blockers.map((b) => b.code)).toContain("integration_lineage_unverified");
    expect(integrationRow(run.id)).toBeUndefined();
  });

  test("AC2: an exhausted ticket budget blocks the merge", async () => {
    const { plan } = await importSpec(990, [{ issue: 991 }]);
    const dispatch = makeDispatch(committingRunner("impl-budget.txt"));
    const integration = makeIntegration();
    const gate = register("gate-budget", "automated_gate");

    let lastRunId = "";
    for (let lap = 1; lap <= 3; lap += 1) {
      const run = await dispatch.dispatch(projectId, {
        plan_id: plan.id,
        issue_number: 991,
        actor: "operator",
      });
      lastRunId = run.id;
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "failed",
        producer: gate.producer,
        checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
        findings: [
          {
            severity: "blocking",
            acKey: "AC1",
            fileContext: "impl-budget.txt:1",
            summary: `rejected lap ${lap}`,
          },
        ],
      });
    }

    const status = await integration.land(projectId, lastRunId);
    expect(status.state).toBe("blocked");
    expect(status.acceptance.reasons).toContain("budget_exhausted");
    expect(integrationRow(lastRunId)).toBeUndefined();
  });

  test("AC2: a forge merge rejection fails closed without recording integration", async () => {
    const { plan } = await importSpec(1000, [{ issue: 1001 }]);
    const dispatch = makeDispatch(committingRunner("impl-reject.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 1001,
      actor: "operator",
    });
    await recordPassingGates(run.id);
    await publication.publishByRun(projectId, run.id);

    forge.failNextMerge = true;
    const status = await integration.land(projectId, run.id);
    expect(status.state).toBe("blocked");
    expect(status.blockers.map((b) => b.code)).toContain("integration_merge_rejected");
    expect(integrationRow(run.id)).toBeUndefined();
  });

  test("AC3: a wrong remote PR binding is rejected before any merge", async () => {
    const { plan } = await importSpec(1010, [{ issue: 1011 }]);
    const dispatch = makeDispatch(committingRunner("impl-binding.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 1011,
      actor: "operator",
    });
    await recordPassingGates(run.id);
    const published = await publication.publishByRun(projectId, run.id);
    const active = published.pullRequests.find((pr) => pr.active)!;
    // Rewrite the remote base so the read-back no longer matches the frozen target.
    const pr = await forge.getPullRequest(REPO, active.number!);
    forge.addPullRequest(REPO, { ...pr!, base: "main" });

    const status = await integration.land(projectId, run.id);
    expect(status.state).toBe("blocked");
    expect(status.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /integration_remote_binding_mismatch|integration_publication_incomplete/,
        ),
      ]),
    );
    expect(integrationRow(run.id)).toBeUndefined();
  });

  test("AC3: a late failed review recorded during the pre-merge remote read blocks the merge", async () => {
    const { plan, branch } = await importSpec(1020, [{ issue: 1021 }]);
    const dispatch = makeDispatch(committingRunner("impl-late-review.txt"));
    const integration = makeIntegration();
    const run = await dispatch.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 1021,
      actor: "operator",
    });
    await recordPassingGates(run.id, "late");
    await publication.publishByRun(projectId, run.id);

    // A concurrent reviewer records a blocking failure after acceptance was
    // snapshotted but before the forge merge. The freshness fence must see it.
    const lateReviewer = register("late-concurrent-reviewer", "peer_reviewer");
    const originalGetPullRequest = forge.getPullRequest.bind(forge);
    let fired = false;
    forge.getPullRequest = async (repo, number) => {
      const result = await originalGetPullRequest(repo, number);
      if (!fired) {
        fired = true;
        observations.recordRunObservation(
          projectId,
          run.id,
          {
            stage: "independent_review",
            status: "failed",
            producer: lateReviewer.producer,
            checks: [{ name: "late review", command: "review diff", result: "FAIL" }],
            findings: [
              {
                severity: "blocking",
                fileContext: "impl-late-review.txt:1",
                summary: "late concurrent blocking defect",
              },
            ],
          },
          { attemptKey: "late-review-attempt" },
        );
      }
      return result;
    };

    const status = await integration.land(projectId, run.id);
    expect(status.state).toBe("blocked");
    expect(status.acceptance.authorized).toBe(false);
    expect(status.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["integration_acceptance_blocked"]),
    );
    expect(integrationRow(run.id)).toBeUndefined();
    expect(remoteHead(branch)).toBeTruthy();
    const reviews = observations
      .listObservations(projectId, { runId: run.id })
      .filter((observation) => observation.stage === "independent_review");
    expect(reviews.map((review) => review.status)).toContain("failed");
    expect(reviews).toHaveLength(2);
  });
});
