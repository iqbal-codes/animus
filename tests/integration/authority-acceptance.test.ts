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
import { BackupRestoreService } from "../../apps/backend/src/restore/service";
import { AuthorityCutoverService } from "../../apps/backend/src/cutover/service";
import { readExecutionAuthority } from "@animus/contracts/execution-authority";

const REPO = "owner/cutover-acceptance";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function ticketBody(): string {
  return [
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

/**
 * Public macro-acceptance after the authority cutover: prepared-ticket intake,
 * real branch/PR publication, full standalone QA + independent review, manual
 * remote merge and verified completion through normal services and real temp
 * SQLite/git/bare origin with synthetic offline transports.
 */
describe("authority cutover public acceptance", () => {
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
  let stateDir: string;

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

  function committingRunner(): DispatchRunner {
    return async (context) => {
      writeFileSync(join(context.worktree_path, "impl.txt"), "implemented\n");
      git(context.worktree_path, "add", "impl.txt");
      git(context.worktree_path, "commit", "-q", "-m", "implement standalone ticket");
      return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
    };
  }

  function register(
    id: string,
    role: "independent_evaluator" | "peer_reviewer" | "automated_gate",
  ): void {
    observations.registerTrustedProducer(projectId, { id, role });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-authority-acceptance-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    stateDir = join(root, "animus-home", "state");
    process.env.ANIMUS_STATE_DIR = stateDir;
    db = initializeDatabase(join(stateDir, "console.db"));
    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
    forge = new SyntheticForgeAdapter({ [REPO]: 165 }, forgeOptions());
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
    delete process.env.ANIMUS_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("standalone full QA, manual remote merge and verified delivery after activation", async () => {
    const backup = new BackupRestoreService(db, { stateDir, forge });
    const cutover = new AuthorityCutoverService(db, { stateDir, backup });
    const staged = await cutover.stage({ actor: "operator" });
    expect(staged.operation.status).toBe("staged");
    const activated = await cutover.activate({
      actor: "operator",
      cutoverId: staged.operation.id,
      inventorySha256: staged.operation.inventorySha256!,
      backupManifestSha256: staged.operation.backupManifestSha256!,
    });
    expect(activated.status.authority).toBe("local");
    expect(readExecutionAuthority().authority).toBe("local");

    forge.addIssue(REPO, {
      number: 1700,
      title: "Standalone acceptance ticket",
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    const plan = await plans.importPlan(projectId, { issue_number: 1700, kind: "standalone" });
    expect(plan.kind).toBe("standalone");
    expect(plan.authority).toBe("admitted");

    const dispatch = new DispatchService(db, {
      plans,
      ledger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: committingRunner(),
    });
    const run = await dispatch.dispatch(projectId, { plan_id: plan.id, actor: "operator" });
    expect(run.state).toBe("succeeded");
    expect(run.gate_profile).toBe("standalone");
    expect(run.merge_policy).toBe("manual");
    expect(run.target_branch).toBe("main");

    const published = await publication.publishByRun(projectId, run.id);
    expect(published.pullRequests).toHaveLength(1);
    expect(published.auditComplete).toBe(true);
    const pr = published.pullRequests[0]!;
    expect(pr).toMatchObject({ headBranch: run.branch, baseBranch: "main", draft: true });

    register("reviewer-acceptance", "peer_reviewer");
    observations.recordRunObservation(projectId, run.id, {
      stage: "independent_review",
      status: "passed",
      producer: { id: "reviewer-acceptance", role: "peer_reviewer" },
      checks: [
        { name: "standards review", command: "review diff", result: "PASS", kind: "review" },
      ],
    });
    register("final-acceptance", "independent_evaluator");
    observations.recordRunObservation(projectId, run.id, {
      stage: "final_acceptance",
      status: "passed",
      producer: { id: "final-acceptance", role: "independent_evaluator" },
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
        },
        {
          name: "remote ci",
          command: "gh pr checks",
          result: "PASS",
          kind: "remote_ci",
        },
      ],
    });

    const gate = await delivery.getGate(projectId, run.id);
    expect(gate.state).toBe("ready_for_operator_review");
    expect(gate.mergePolicy).toBe("manual");
    expect(gate.merge.state).toBe("not_merged");

    // Manual remote merge, then exact target-lineage verification.
    await forge.updatePullRequest(REPO, pr.number!, { draft: false });
    expect((await forge.mergePullRequest(REPO, pr.number!)).merged).toBe(true);
    execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", run.head_sha!], {
      stdio: "ignore",
    });
    const awaiting = await delivery.getGate(projectId, run.id);
    expect(awaiting.state).toBe("awaiting_merge_verification");

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
      verifiedBy: "operator",
    });

    // The cutover evidence remains available and the audit history is retained.
    const status = cutover.status();
    expect(status.authority).toBe("local");
    expect(status.operation?.status).toBe("activated");
    expect(status.operation?.report).toMatchObject({ activatedBy: "operator" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM delivery_merges WHERE run_id = ? AND gate_profile != 'child'",
        )
        .get(run.id),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM authority_cutover_mappings WHERE cutover_id = ?")
        .get(staged.operation.id) as { count: number },
    ).toMatchObject({ count: expect.any(Number) });
  });
});
