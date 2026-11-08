import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { PlanService } from "../../apps/backend/src/plans";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService, type DispatchRunner } from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { PublicationService } from "../../apps/backend/src/publication";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";

const REPO = "owner/publication-repo";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function ticketBody(
  options: {
    partOf?: number;
    coverage?: string;
    dependsOn?: number[];
  } = {},
): string {
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

class AmbiguousCreateForge extends SyntheticForgeAdapter {
  async createPullRequest(
    ...args: Parameters<SyntheticForgeAdapter["createPullRequest"]>
  ): ReturnType<SyntheticForgeAdapter["createPullRequest"]> {
    await super.createPullRequest(...args);
    throw new Error("socket hang up after remote acceptance");
  }
}

class AmbiguousCommentForge extends SyntheticForgeAdapter {
  private ambiguous = true;
  async createIssueComment(
    ...args: Parameters<SyntheticForgeAdapter["createIssueComment"]>
  ): ReturnType<SyntheticForgeAdapter["createIssueComment"]> {
    const result = await super.createIssueComment(...args);
    if (this.ambiguous) {
      this.ambiguous = false;
      throw new Error("timed out after remote comment acceptance");
    }
    return result;
  }
}

class WrongBindingForge extends SyntheticForgeAdapter {
  async createPullRequest(
    repo: string,
    input: Parameters<SyntheticForgeAdapter["createPullRequest"]>[1],
  ): ReturnType<SyntheticForgeAdapter["createPullRequest"]> {
    return super.createPullRequest(repo, { ...input, head: `wrong-${input.head}` });
  }
}

describe("durable PR publication and per-lap audit", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let projectId: string;
  let checkoutPath: string;
  let observations: ExecutionObservationService;

  function artifactRoot(): string {
    return join(root, "animus-home", "state", "artifacts", projectId);
  }

  function writeArtifact(relativePath: string, contents = "checked\n"): void {
    const absolute = join(artifactRoot(), relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
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

  function publisher(targetForge: SyntheticForgeAdapter = forge): PublicationService {
    return new PublicationService(db, targetForge);
  }

  function register(
    id: string,
    role: "peer_reviewer" | "independent_evaluator" | "automated_gate" | "builder",
  ) {
    return observations.registerTrustedProducer(projectId, { id, role });
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

  async function recordTechnicalFailure(runId: string, finding = true) {
    const gate = register(`gate-${Math.random().toString(16).slice(2)}`, "automated_gate");
    return observations.recordRunObservation(projectId, runId, {
      stage: "technical_checks",
      status: "failed",
      producer: gate.producer,
      checks: [{ name: "unit", command: "bun test", result: "FAIL", detail: "1 failing" }],
      findings: finding
        ? [
            {
              severity: "blocking",
              acKey: "AC1",
              fileContext: "impl.txt:1",
              summary: "prepared criterion is not implemented",
            },
          ]
        : [],
    });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-publication-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    writeExecutionAuthority("local");
    db = initializeDatabase(join(root, "state", "console.db"));
    forge = new SyntheticForgeAdapter({ [REPO]: 812 });
    registry = new ProjectRegistryService(db, forge);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    git(checkoutPath, "commit", "--allow-empty", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
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
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1/AC3: dispatch and evidence writers queue a target, events and intents atomically", async () => {
    const { run } = await dispatchStandalone(800);
    await recordTechnicalFailure(run.id);

    const target = db
      .prepare("SELECT * FROM publication_targets WHERE project_id = ? AND work_id = ?")
      .get(projectId, run.work_id) as any;
    expect(target).toMatchObject({
      candidate_head_sha: run.head_sha,
      source_branch: run.branch,
      target_branch: "main",
      state: "ready",
    });
    const intents = db
      .prepare("SELECT * FROM publication_intents WHERE target_id = ?")
      .all(target.id) as any[];
    expect(intents.some((intent) => intent.kind === "create_pr")).toBe(true);
    expect(intents.filter((intent) => intent.kind === "publish_event")).toHaveLength(3);
    const events = db
      .prepare("SELECT * FROM publication_events WHERE target_id = ? ORDER BY sequence")
      .all(target.id) as any[];
    expect(events.map((event) => event.kind)).toEqual([
      "verdict",
      "verification_failure",
      "finding",
    ]);
    expect(events.every((event) => event.candidate_head_sha === run.head_sha)).toBe(true);
    expect(events.every((event) => event.lap === 1)).toBe(true);
  });

  test("AC1: publish creates one draft PR with exact source/target binding and publishes queued events", async () => {
    const { run } = await dispatchStandalone(801);
    await recordTechnicalFailure(run.id, false);

    const service = publisher();
    const status = await service.publishByRun(projectId, run.id);

    expect(status.pullRequests).toHaveLength(1);
    const pr = status.pullRequests[0]!;
    expect(pr).toMatchObject({
      headBranch: run.branch,
      baseBranch: "main",
      candidateHeadSha: run.head_sha,
      draft: true,
      state: "open",
      active: true,
    });
    expect(status.auditComplete).toBe(true);
    expect(status.publishedEventCount).toBe(2);
    expect(status.queuedEventCount).toBe(0);
    const remote = await forge.getPullRequest(REPO, pr.number!);
    expect(remote).toMatchObject({ head: run.branch, base: "main", state: "OPEN" });
    expect(remote?.draft).toBe(true);

    // Replay must not duplicate the PR, comments or summary.
    const beforeComments = (await forge.getIssue(REPO, pr.number!))?.comments?.length ?? 0;
    const replay = await service.publishByRun(projectId, run.id);
    expect(replay.pullRequests).toHaveLength(1);
    const afterComments = (await forge.getIssue(REPO, pr.number!))?.comments?.length ?? 0;
    expect(afterComments).toBe(beforeComments);
  });

  test("AC1: events queued before PR creation are published after the PR exists", async () => {
    const { run } = await dispatchStandalone(802);
    const flaky = new SyntheticForgeAdapter({ [REPO]: 812 });
    flaky.failNextPullRequest = true;
    const first = await publisher(flaky).publishByRun(projectId, run.id);
    expect(first.pullRequests).toHaveLength(0);
    expect(first.auditComplete).toBe(false);
    expect(first.queuedEventCount).toBe(1);
    expect(first.target.state).toBe("failed");

    const second = await publisher(flaky).publishByRun(projectId, run.id);
    expect(second.pullRequests).toHaveLength(1);
    expect(second.publishedEventCount).toBe(1);
    expect(second.auditComplete).toBe(true);
  });

  test("AC3: crash after remote PR acceptance is reconciled without a duplicate PR", async () => {
    const { run } = await dispatchStandalone(803);
    const crashy = new AmbiguousCreateForge({ [REPO]: 812 });
    const status = await publisher(crashy).publishByRun(projectId, run.id);
    expect(status.pullRequests).toHaveLength(1);
    expect(status.auditComplete).toBe(true);
    expect((await crashy.listPullRequests(REPO)).length).toBe(1);
  });

  test("AC3: crash before remote PR acceptance retries without duplicating", async () => {
    const { run } = await dispatchStandalone(804);
    const flaky = new SyntheticForgeAdapter({ [REPO]: 812 });
    flaky.failNextPullRequest = true;
    const first = await publisher(flaky).publishByRun(projectId, run.id);
    expect(first.pullRequests).toHaveLength(0);
    const second = await publisher(flaky).publishByRun(projectId, run.id);
    expect(second.pullRequests).toHaveLength(1);
    expect((await flaky.listPullRequests(REPO)).length).toBe(1);
  });

  test("AC3: ambiguous comment acceptance is reconciled by its marker without replay", async () => {
    const { run } = await dispatchStandalone(805);
    const ambiguous = new AmbiguousCommentForge({ [REPO]: 812 });
    const first = await publisher(ambiguous).publishByRun(projectId, run.id);
    expect(first.pullRequests).toHaveLength(1);
    expect(first.publishedEventCount).toBe(1);
    const pr = first.pullRequests[0]!;
    const comments = (await ambiguous.getIssue(REPO, pr.number!))?.comments?.length ?? 0;
    const second = await publisher(ambiguous).publishByRun(projectId, run.id);
    expect(second.publishedEventCount).toBe(1);
    expect((await ambiguous.getIssue(REPO, pr.number!))?.comments?.length ?? 0).toBe(comments);
  });

  test("AC1/AC6: a remote PR with the wrong binding is rejected, never claimed as published", async () => {
    const { run } = await dispatchStandalone(806);
    const wrong = new WrongBindingForge({ [REPO]: 812 });
    const status = await publisher(wrong).publishByRun(projectId, run.id);
    expect(status.pullRequests).toHaveLength(0);
    expect(status.auditComplete).toBe(false);
    expect(status.target.state).toBe("failed");
    expect(status.target.lastError).toContain("does not match source");
  });

  test("AC6: GitHub outage remains readable and is distinguished from verification failure", async () => {
    const { run } = await dispatchStandalone(807);
    const service = publisher();
    const published = await service.publishByRun(projectId, run.id);
    expect(published.auditComplete).toBe(true);

    forge.failNextGetPullRequest = true;
    const status = await service.publishByRun(projectId, run.id);
    expect(status.target.state).toBe("unknown");
    expect(status.auditComplete).toBe(false);
    expect(status.target.lastError).toContain("unreadable");
    // Verification evidence is still locally readable.
    const evidence = observations.getRunEvidence(projectId, run.id);
    expect(evidence.observations.length).toBeGreaterThan(0);
  });

  test("AC4: secrets and local paths are sanitized and manual upload stays explicit", async () => {
    const { run } = await dispatchStandalone(808);
    writeArtifact("checks/report.log", "upstream token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    const gate = register("gate-sanitize", "automated_gate");
    observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "passed",
      producer: gate.producer,
      checks: [
        {
          name: "unit",
          command: `cat /Users/private/project/secret.txt`,
          result: "PASS",
          detail:
            "api_key=sk-or-v1-abcdefghijklmnopqrstuvwxyz012345 ghp_abcdefghijklmnopqrstuvwxyz0123456789",
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

    const status = await publisher().publishByRun(projectId, run.id);
    const remote = await forge.getPullRequest(REPO, status.pullRequests[0]!.number!);
    const comments = (await forge.getIssue(REPO, status.pullRequests[0]!.number!))?.comments ?? [];
    const combined = `${remote?.body ?? ""}\n${comments.map((comment) => comment.body ?? "").join("\n")}`;
    expect(combined).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(combined).not.toContain("/Users/private/project");
    expect(combined).not.toContain("sk-or-v1-abcdefghijklmnopqrstuvwxyz012345");
    expect(combined).toContain("[REDACTED_GH_TOKEN]");
    expect(combined).toContain("[LOCAL_PATH]");
    expect(combined).toContain("manual upload pending");
    expect(combined).not.toContain("file://");

    const artifact = observations
      .getRunEvidence(projectId, run.id)
      .observations.flatMap((observation) => observation.artifacts)[0]!;
    const bound = publisher().bindEvidence(
      projectId,
      status.target.id,
      artifact.id,
      "https://github.com/user-attachments/assets/report.png",
    );
    expect(bound.evidence[0]).toMatchObject({
      status: "supplied_unverified",
      hostedUrl: "https://github.com/user-attachments/assets/report.png",
    });
    const republished = await publisher().publishByRun(projectId, run.id);
    const refreshed = await forge.getPullRequest(REPO, republished.pullRequests[0]!.number!);
    expect(refreshed?.body).toContain("https://github.com/user-attachments/assets/report.png");
    expect(refreshed?.body).toContain("supplied unverified");
  });

  test("AC2: findings use the inline review convention when the candidate diff contains the line", async () => {
    const { run } = await dispatchStandalone(809);
    await recordTechnicalFailure(run.id, true);
    const status = await publisher().publishByRun(projectId, run.id);
    expect(status.auditComplete).toBe(true);
    const pr = status.pullRequests[0]!;
    const reviews = await forge.listPullRequestReviews(REPO, pr.number!);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body).toContain("Finding:");
    expect(reviews[0]!.body).toContain("impl.txt:1");
  });

  test("AC2: failed history is retained after a later pass and the current summary stays separate", async () => {
    const { run } = await dispatchStandalone(810);
    await recordTechnicalFailure(run.id, true);
    const first = await publisher().publishByRun(projectId, run.id);
    expect(first.events.map((event) => event.kind)).toEqual([
      "verdict",
      "verification_failure",
      "finding",
    ]);

    const findings = observations.listFindings(projectId, { runId: run.id });
    const finding = findings[0]!;
    observations.recordFindingFix(projectId, finding.id, {
      actor: "operator",
      detail: "builder claims fixed",
    });
    const reviewer = register("reviewer-pass", "peer_reviewer");
    observations.recordFindingRecheck(projectId, finding.id, {
      producer: reviewer.producer,
      status: "passed",
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });

    const second = await publisher().publishByRun(projectId, run.id);
    expect(second.auditComplete).toBe(true);
    expect(second.events.map((event) => event.kind)).toContain("verification_failure");
    expect(second.events.map((event) => event.kind)).toContain("fix_submitted");
    expect(second.events.map((event) => event.kind)).toContain("recheck_passed");
    expect(second.summary).toContain("Failed results are retained");
    expect(second.summary).not.toContain("finding is open");
  });

  test("AC1: a new candidate replaces the active PR while preserving closed history", async () => {
    const { plan, run } = await dispatchStandalone(811);
    const first = await publisher().publishByRun(projectId, run.id);
    const firstPr = first.pullRequests[0]!;
    await recordTechnicalFailure(run.id, true);

    const secondRun = await makeDispatch(committingRunner("impl-2.txt")).dispatch(projectId, {
      plan_id: plan.id,
      work_id: run.work_id,
      actor: "operator",
    });
    expect(secondRun.lap).toBe(2);
    const second = await publisher().publishByRun(projectId, secondRun.id);

    expect(second.pullRequests).toHaveLength(2);
    const old = second.pullRequests.find((pr) => pr.number === firstPr.number)!;
    const active = second.pullRequests.find((pr) => pr.active)!;
    expect(old.active).toBe(false);
    expect(old.state).toBe("superseded");
    expect(active.id).not.toBe(old.id);
    expect(active.candidateHeadSha).toBe(secondRun.head_sha);
    const remoteOld = await forge.getPullRequest(REPO, firstPr.number!);
    expect(remoteOld?.state).toBe("CLOSED");
    expect(second.events.length).toBeGreaterThan(first.events.length);
  });

  test("AC1: sibling tickets in one spec delivery get their own PRs, not one shared PR", async () => {
    addIssue(820, specBody(["parent first", "parent second"]), ["ready-for-agent", "spec"]);
    addIssue(821, ticketBody({ partOf: 820, coverage: "AC1" }));
    addIssue(822, ticketBody({ partOf: 820, coverage: "AC2" }));
    const plan = await plans.importPlan(projectId, { issue_number: 820, kind: "spec" });
    expect(plan.authority).toBe("admitted");
    git(checkoutPath, "branch", "factory/spec-820-integration", "main");

    const service = makeDispatch();
    const runA = await service.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 821,
      actor: "operator",
    });
    const runB = await service.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 822,
      actor: "operator",
    });
    expect(runA.delivery_id).toBe(runB.delivery_id);

    const targetA = await publisher().publishByRun(projectId, runA.id);
    const targetB = await publisher().publishByRun(projectId, runB.id);
    expect(targetA.target.workId).not.toBe(targetB.target.workId);
    expect(targetA.pullRequests).toHaveLength(1);
    expect(targetB.pullRequests).toHaveLength(1);
    expect(targetA.pullRequests[0]!.baseBranch).toBe("factory/spec-820-integration");
    expect(targetB.pullRequests[0]!.baseBranch).toBe("factory/spec-820-integration");
    expect(targetA.pullRequests[0]!.headBranch).not.toBe(targetB.pullRequests[0]!.headBranch);
    expect(await forge.listPullRequests(REPO)).toHaveLength(2);
  });

  test("AC1: no candidate change means no PR is fabricated", async () => {
    const { run } = await dispatchStandalone(812, async (context) => ({
      success: true,
      headSha: context.base_sha,
    }));
    const status = await publisher().publishByRun(projectId, run.id);
    expect(status.target.state).toBe("no_candidate");
    expect(status.pullRequests).toHaveLength(0);
    expect(status.auditComplete).toBe(false);
    expect(await forge.listPullRequests(REPO)).toHaveLength(0);
  });
});
