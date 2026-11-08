import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
  SystemForgeAdapter,
  type SyntheticForgeOptions,
} from "../../apps/backend/src/registry";
import { PlanService } from "../../apps/backend/src/plans";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService, type DispatchRunner } from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { PublicationService } from "../../apps/backend/src/publication";
import { PublicationError } from "../../apps/backend/src/publication/errors";
import {
  enqueuePublicationEvent,
  ensurePublicationTarget,
} from "../../apps/backend/src/publication/outbox";
import type { CreatePullRequestReviewInput } from "../../apps/backend/src/registry/forge";
import { seedActivatedAuthority } from "./support/activated-authority";

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
  constructor(repos?: Record<string, number>, options?: SyntheticForgeOptions) {
    super(repos, options);
  }

  async createPullRequest(
    ...args: Parameters<SyntheticForgeAdapter["createPullRequest"]>
  ): ReturnType<SyntheticForgeAdapter["createPullRequest"]> {
    await super.createPullRequest(...args);
    throw new Error("socket hang up after remote acceptance");
  }
}

class AmbiguousCommentForge extends SyntheticForgeAdapter {
  constructor(repos?: Record<string, number>, options?: SyntheticForgeOptions) {
    super(repos, options);
  }

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
  constructor(repos?: Record<string, number>, options?: SyntheticForgeOptions) {
    super(repos, options);
  }

  async createPullRequest(
    repo: string,
    input: Parameters<SyntheticForgeAdapter["createPullRequest"]>[1],
  ): ReturnType<SyntheticForgeAdapter["createPullRequest"]> {
    const created = await super.createPullRequest(repo, input);
    // Simulate a transport/forge that accepts the create but reports a different
    // source branch on read-back; the service must refuse to bind it.
    const wrong = { ...created, head: `wrong-${input.head}` };
    this.addPullRequest(repo, wrong);
    return wrong;
  }
}

class RecordingReviewForge extends SyntheticForgeAdapter {
  readonly reviews: Array<{
    repo: string;
    prNumber: number;
    input: CreatePullRequestReviewInput;
  }> = [];

  constructor(repos?: Record<string, number>, options?: SyntheticForgeOptions) {
    super(repos, options);
  }

  async createPullRequestReview(
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewInput,
  ) {
    this.reviews.push({ repo, prNumber, input });
    return super.createPullRequestReview(repo, prNumber, input);
  }
}

class MissingHeadForge extends SyntheticForgeAdapter {
  constructor(repos?: Record<string, number>, options?: SyntheticForgeOptions) {
    super(repos, options);
  }

  async getPullRequest(repo: string, prNumber: number) {
    const pr = await super.getPullRequest(repo, prNumber);
    if (!pr) return null;
    const { headRefOid: _ignored, ...rest } = pr;
    return rest;
  }

  async listPullRequests(repo: string) {
    const list = await super.listPullRequests(repo);
    return list.map((pr) => {
      const { headRefOid: _ignored, ...rest } = pr;
      return rest;
    });
  }
}

class AdvancedHeadForge extends SyntheticForgeAdapter {
  constructor(repos?: Record<string, number>, options?: SyntheticForgeOptions) {
    super(repos, options);
  }

  async getPullRequest(repo: string, prNumber: number) {
    const pr = await super.getPullRequest(repo, prNumber);
    return pr ? { ...pr, headRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" } : null;
  }

  async listPullRequests(repo: string) {
    const list = await super.listPullRequests(repo);
    return list.map((pr) => ({ ...pr, headRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }));
  }
}

class WrongRepoForge extends SyntheticForgeAdapter {
  constructor(repos?: Record<string, number>, options?: SyntheticForgeOptions) {
    super(repos, options);
  }

  async getPullRequest(repo: string, prNumber: number) {
    const pr = await super.getPullRequest(repo, prNumber);
    return pr ? { ...pr, repository: "other/repository" } : null;
  }

  async listPullRequests(repo: string) {
    const list = await super.listPullRequests(repo);
    return list.map((pr) => ({ ...pr, repository: "other/repository" }));
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
  let bareOrigin: string;
  let observations: ExecutionObservationService;

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
    db = initializeDatabase(join(root, "state", "console.db"));
    seedActivatedAuthority(db);
    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
    forge = new SyntheticForgeAdapter({ [REPO]: 812 }, forgeOptions());
    registry = new ProjectRegistryService(db, forge);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    // Rewrite the recorded GitHub remote to the offline bare origin for this test,
    // exercising the real push/ls-remote path without network access.
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
    const flaky = new SyntheticForgeAdapter({ [REPO]: 812 }, forgeOptions());
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
    const crashy = new AmbiguousCreateForge({ [REPO]: 812 }, forgeOptions());
    const status = await publisher(crashy).publishByRun(projectId, run.id);
    expect(status.pullRequests).toHaveLength(1);
    expect(status.auditComplete).toBe(true);
    expect((await crashy.listPullRequests(REPO)).length).toBe(1);
  });

  test("AC3: crash before remote PR acceptance retries without duplicating", async () => {
    const { run } = await dispatchStandalone(804);
    const flaky = new SyntheticForgeAdapter({ [REPO]: 812 }, forgeOptions());
    flaky.failNextPullRequest = true;
    const first = await publisher(flaky).publishByRun(projectId, run.id);
    expect(first.pullRequests).toHaveLength(0);
    const second = await publisher(flaky).publishByRun(projectId, run.id);
    expect(second.pullRequests).toHaveLength(1);
    expect((await flaky.listPullRequests(REPO)).length).toBe(1);
  });

  test("AC3: ambiguous comment acceptance is reconciled by its marker without replay", async () => {
    const { run } = await dispatchStandalone(805);
    const ambiguous = new AmbiguousCommentForge({ [REPO]: 812 }, forgeOptions());
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
    const wrong = new WrongBindingForge({ [REPO]: 812 }, forgeOptions());
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

  test("B1: publish pushes the exact committed candidate to the recorded remote before creating the PR", async () => {
    const { run } = await dispatchStandalone(830);
    expect(remoteHead(run.branch)).toBeNull();

    const status = await publisher().publishByRun(projectId, run.id);

    expect(remoteHead(run.branch)).toBe(run.head_sha);
    expect(status.target.remoteSourceRef).toBe(`refs/heads/${run.branch}`);
    expect(status.target.remoteSourceSha).toBe(run.head_sha);
    expect(status.pullRequests).toHaveLength(1);
    expect(status.pullRequests[0]!.headRefOid).toBe(run.head_sha);
    expect(status.auditComplete).toBe(true);
  });

  test("B1: a rejected push cannot fabricate a PR or published audit", async () => {
    const { run } = await dispatchStandalone(831);
    const service = new PublicationService(db, forge, {
      gitRemote: async (args) =>
        args[0] === "push"
          ? { exitCode: 1, stdout: "", stderr: "! [rejected] non-fast-forward" }
          : { exitCode: 0, stdout: "", stderr: "" },
    });
    const status = await service.publishByRun(projectId, run.id);

    expect(remoteHead(run.branch)).toBeNull();
    expect(status.pullRequests).toHaveLength(0);
    expect(status.auditComplete).toBe(false);
    expect(status.target.state).toBe("failed");
    expect(status.target.lastError).toContain("git push");
  });

  test("B1: an ambiguous push timeout is explicit unknown, never success", async () => {
    const { run } = await dispatchStandalone(832);
    const service = new PublicationService(db, forge, {
      gitRemote: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true }),
    });
    const status = await service.publishByRun(projectId, run.id);

    expect(status.pullRequests).toHaveLength(0);
    expect(status.auditComplete).toBe(false);
    expect(status.target.state).toBe("unknown");
    expect(status.intents.find((intent) => intent.kind === "create_pr")!.state).toBe("unknown");
  });

  test("B1: the injected forge refuses a PR whose source ref does not exist on the remote", async () => {
    const { run } = await dispatchStandalone(833);
    const targetRow = db
      .prepare("SELECT * FROM publication_targets WHERE project_id = ? AND work_id = ?")
      .get(projectId, run.work_id) as any;
    const service = new PublicationService(db, forge, {
      gitRemote: async (args) => {
        const ref = args[args.length - 1]!;
        if (args[0] === "push") return { exitCode: 0, stdout: "", stderr: "" };
        // Claim the source ref was pushed without writing it to the bare origin;
        // the transport must still refuse to create the PR.
        return {
          exitCode: 0,
          stdout: `${targetRow.candidate_head_sha}\t${ref}`,
          stderr: "",
        };
      },
    });
    const status = await service.publishByRun(projectId, run.id);

    expect(remoteHead(run.branch)).toBeNull();
    expect(status.pullRequests).toHaveLength(0);
    expect(status.auditComplete).toBe(false);
    expect(status.target.lastError).toContain("missing");
  });

  test("B2: inline review comment bodies are sanitized at the outbound boundary", async () => {
    const { run } = await dispatchStandalone(834);
    const targetRow = db
      .prepare("SELECT * FROM publication_targets WHERE project_id = ? AND work_id = ?")
      .get(projectId, run.work_id) as any;
    enqueuePublicationEvent(db, {
      targetId: targetRow.id,
      projectId,
      workId: run.work_id,
      runId: run.id,
      lap: 1,
      candidateHeadSha: run.head_sha!,
      observationId: null,
      findingId: null,
      kind: "finding",
      severity: "blocking",
      title: "leaky finding",
      body: "Location: `impl.txt:1`\nsecret ghp_abcdefghijklmnopqrstuvwxyz0123456789\nlocal /Users/secret/path/report.log",
      occurredAt: Date.now(),
    });

    const recording = new RecordingReviewForge({ [REPO]: 812 }, forgeOptions());
    const status = await publisher(recording).publishByRun(projectId, run.id);

    expect(status.pullRequests).toHaveLength(1);
    expect(recording.reviews).toHaveLength(1);
    const inline = recording.reviews[0]?.input.comments?.[0];
    expect(inline).toBeDefined();
    if (!inline) throw new Error("expected an inline review comment");
    expect(inline.path).toBe("impl.txt");
    expect(inline.body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(inline.body).not.toContain("/Users/secret/path");
    expect(inline.body).toContain("[REDACTED_GH_TOKEN]");
    expect(inline.body).toContain("[LOCAL_PATH]");
  });

  test("B3: evidence binding reuses the supported hosted-asset policy and blocks Markdown injection", async () => {
    const { run } = await dispatchStandalone(835);
    writeArtifact("checks/report.log", "checked\n");
    const gate = register("gate-b3", "automated_gate");
    observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "passed",
      producer: gate.producer,
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
      artifacts: [
        {
          ownerType: "observation",
          name: "unit-report",
          relativePath: "checks/report.log",
          mediaType: "text/plain",
        },
      ],
    });
    const artifact = observations
      .getRunEvidence(projectId, run.id)
      .observations.flatMap((observation) => observation.artifacts)[0]!;
    const targetRow = db
      .prepare("SELECT * FROM publication_targets WHERE project_id = ? AND work_id = ?")
      .get(projectId, run.work_id) as any;

    const pending = await publisher().publishByRun(projectId, run.id);
    expect(pending.auditComplete).toBe(false);
    expect(pending.summary).toContain("manual upload pending");

    const unsafeUrls = [
      "https://evil.example.com/x.png",
      "https://github.com/owner/repo",
      "https://user:pass@github.com/a/b/assets/x.png",
      "https://github.com:8443/a/b/assets/x.png",
      "https://example",
      "https://github.com/a/b/assets/x.png) [click](https://evil.example)",
    ];
    for (const url of unsafeUrls) {
      let caught: unknown;
      try {
        publisher().bindEvidence(projectId, targetRow.id, artifact.id, url);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PublicationError);
    }

    const hosted = "https://github.com/user-attachments/assets/report.png";
    const bound = publisher().bindEvidence(projectId, targetRow.id, artifact.id, hosted);
    expect(bound.evidence[0]).toMatchObject({
      status: "supplied_unverified",
      hostedUrl: hosted,
    });
    const published = await publisher().publishByRun(projectId, run.id);
    expect(published.auditComplete).toBe(true);
    expect(published.summary).toContain(`(<${hosted}>)`);
    expect(published.summary).not.toContain(") [click](");
  });

  test("B4: a failed replacement create preserves the previous active PR", async () => {
    const { plan, run } = await dispatchStandalone(836);
    const first = await publisher().publishByRun(projectId, run.id);
    const firstPr = first.pullRequests[0]!;
    await recordTechnicalFailure(run.id, true);

    const secondRun = await makeDispatch(committingRunner("impl-2.txt")).dispatch(projectId, {
      plan_id: plan.id,
      work_id: run.work_id,
      actor: "operator",
    });
    expect(secondRun.lap).toBe(2);
    // Fail the replacement create on the same transport that owns the first PR so
    // the test observes the real previous-PR preservation path.
    forge.failNextPullRequest = true;
    const second = await publisher().publishByRun(projectId, secondRun.id);

    const preserved = second.pullRequests.find((pr) => pr.number === firstPr.number)!;
    expect(preserved.active).toBe(true);
    expect(preserved.state).toBe("open");
    expect((await forge.getPullRequest(REPO, firstPr.number!))?.state).toBe("OPEN");
    expect(second.pullRequests.filter((pr) => pr.active)).toHaveLength(1);
    expect(second.auditComplete).toBe(false);
    expect(second.failedIntentCount).toBeGreaterThan(0);
  });

  test("B4: advancing the candidate on the same branch updates the existing PR instead of replacing it", async () => {
    const { run } = await dispatchStandalone(837);
    const first = await publisher().publishByRun(projectId, run.id);
    const firstPr = first.pullRequests[0]!;
    const newSha = commitInWorktree(run.worktree_path, "impl-same.txt");
    const targetRow = db
      .prepare("SELECT * FROM publication_targets WHERE project_id = ? AND work_id = ?")
      .get(projectId, run.work_id) as any;
    ensurePublicationTarget(db, {
      projectId,
      deliveryId: targetRow.delivery_id,
      planId: targetRow.plan_id,
      workId: targetRow.work_id,
      issueNumber: targetRow.issue_number,
      gateProfile: targetRow.gate_profile,
      sourceBranch: run.branch,
      targetBranch: targetRow.target_branch,
      candidateHeadSha: newSha,
      baseSha: targetRow.base_sha,
      eligible: true,
    });

    const second = await publisher().publishByRun(projectId, run.id);

    expect(second.pullRequests).toHaveLength(1);
    expect(second.pullRequests[0]!.number).toBe(firstPr.number);
    expect(second.pullRequests[0]!.candidateHeadSha).toBe(newSha);
    expect(second.pullRequests[0]!.headRefOid).toBe(newSha);
    expect(second.auditComplete).toBe(true);
    expect((await forge.getPullRequest(REPO, firstPr.number!))?.state).toBe("OPEN");
  });

  test("B5: a create intent left attempting is reconciled instead of staying stuck", async () => {
    const { run } = await dispatchStandalone(838);
    const targetRow = db
      .prepare("SELECT * FROM publication_targets WHERE project_id = ? AND work_id = ?")
      .get(projectId, run.work_id) as any;
    db.prepare(
      "UPDATE publication_intents SET state = 'attempting' WHERE target_id = ? AND kind = 'create_pr'",
    ).run(targetRow.id);

    const status = await publisher().publishByRun(projectId, run.id);

    const createIntent = status.intents.find((intent) => intent.kind === "create_pr")!;
    expect(createIntent.state).toBe("accepted");
    expect(createIntent.attempts).toBeGreaterThanOrEqual(1);
    expect(status.pullRequests).toHaveLength(1);
    expect(status.auditComplete).toBe(true);
  });

  test("B5: an attempting create after remote acceptance reconciles without duplicating", async () => {
    const { run } = await dispatchStandalone(839);
    git(checkoutPath, "push", "-q", "origin", `${run.branch}:${run.branch}`);
    const remote = await forge.createPullRequest(REPO, {
      title: "pre-accepted",
      body: "",
      head: run.branch,
      base: "main",
      draft: true,
    });
    const targetRow = db
      .prepare("SELECT * FROM publication_targets WHERE project_id = ? AND work_id = ?")
      .get(projectId, run.work_id) as any;
    db.prepare(
      "UPDATE publication_intents SET state = 'attempting' WHERE target_id = ? AND kind = 'create_pr'",
    ).run(targetRow.id);

    const status = await publisher().publishByRun(projectId, run.id);

    expect(status.pullRequests).toHaveLength(1);
    expect(status.pullRequests[0]!.number).toBe(remote.number);
    expect(status.pullRequests[0]!.headRefOid).toBe(run.head_sha);
    expect(await forge.listPullRequests(REPO)).toHaveLength(1);
    expect(status.intents.find((intent) => intent.kind === "create_pr")!.state).toBe("accepted");
  });

  test("B5: replayed publication does not duplicate the inline review or comments", async () => {
    const { run } = await dispatchStandalone(840);
    await recordTechnicalFailure(run.id, true);
    const recording = new RecordingReviewForge({ [REPO]: 812 }, forgeOptions());
    const first = await publisher(recording).publishByRun(projectId, run.id);
    expect(first.auditComplete).toBe(true);
    const reviewCount = recording.reviews.length;
    const commentCount =
      (await recording.getIssue(REPO, first.pullRequests[0]!.number!))?.comments?.length ?? 0;

    const second = await publisher(recording).publishByRun(projectId, run.id);

    expect(second.auditComplete).toBe(true);
    expect(recording.reviews.length).toBe(reviewCount);
    expect(
      (await recording.getIssue(REPO, first.pullRequests[0]!.number!))?.comments?.length ?? 0,
    ).toBe(commentCount);
  });

  test("B5: concurrent publish calls converge on one PR and one audit set", async () => {
    const { run } = await dispatchStandalone(841);
    const first = new PublicationService(db, forge);
    const second = new PublicationService(db, forge);

    const [a, b] = await Promise.all([
      first.publishByRun(projectId, run.id),
      second.publishByRun(projectId, run.id),
    ]);

    expect(await forge.listPullRequests(REPO)).toHaveLength(1);
    expect(a.pullRequests.length).toBeLessThanOrEqual(1);
    expect(b.pullRequests.length).toBeLessThanOrEqual(1);
    // Whichever publisher lost the claim may return before the winner binds; the
    // durable settled state must still show exactly one PR and a complete audit.
    const settled = new PublicationService(db, forge).getStatusByRun(projectId, run.id);
    expect(settled.pullRequests).toHaveLength(1);
    expect(settled.auditComplete).toBe(true);
    expect(
      (await forge.getIssue(REPO, settled.pullRequests[0]!.number!))?.comments?.length ?? 0,
    ).toBe(1);
  });

  test("B7: a missing remote head SHA blocks binding", async () => {
    const { run } = await dispatchStandalone(842);
    const missing = new MissingHeadForge({ [REPO]: 812 }, forgeOptions());
    const status = await publisher(missing).publishByRun(projectId, run.id);

    expect(status.pullRequests).toHaveLength(0);
    expect(status.auditComplete).toBe(false);
    expect(status.target.lastError).toContain("head");
  });

  test("B7: an advanced remote head blocks binding", async () => {
    const { run } = await dispatchStandalone(843);
    const advanced = new AdvancedHeadForge({ [REPO]: 812 }, forgeOptions());
    const status = await publisher(advanced).publishByRun(projectId, run.id);

    expect(status.pullRequests).toHaveLength(0);
    expect(status.auditComplete).toBe(false);
    expect(status.target.lastError).toContain("does not match the pushed candidate");
  });

  test("B7: a remote PR bound to another repository blocks binding", async () => {
    const { run } = await dispatchStandalone(844);
    const wrongRepo = new WrongRepoForge({ [REPO]: 812 }, forgeOptions());
    const status = await publisher(wrongRepo).publishByRun(projectId, run.id);

    expect(status.pullRequests).toHaveLength(0);
    expect(status.auditComplete).toBe(false);
    expect(status.target.lastError).toContain("belongs to 'other/repository'");
  });

  test("B6: a real-adapter relay outage marks the target unknown, never a closed PR", async () => {
    const { run } = await dispatchStandalone(845);
    const first = await publisher().publishByRun(projectId, run.id);
    const firstPr = first.pullRequests[0]!;

    const outage = new SystemForgeAdapter(async () => {
      throw new Error("HTTP 502 Bad Gateway");
    });
    const status = await new PublicationService(db, outage).publishByRun(projectId, run.id);

    expect(status.target.state).toBe("unknown");
    expect(status.target.lastError).toContain("unreadable");
    expect(status.auditComplete).toBe(false);
    const preserved = status.pullRequests.find((pr) => pr.number === firstPr.number)!;
    expect(preserved.active).toBe(true);
    expect(preserved.state).toBe("open");
  });

  test("B4: a failed retirement is durable and retried without losing the new active PR", async () => {
    const { plan, run } = await dispatchStandalone(846);
    const first = await publisher().publishByRun(projectId, run.id);
    const firstPr = first.pullRequests[0]!;
    await recordTechnicalFailure(run.id, true);

    const secondRun = await makeDispatch(committingRunner("impl-retire.txt")).dispatch(projectId, {
      plan_id: plan.id,
      work_id: run.work_id,
      actor: "operator",
    });
    // The new PR is created and bound, then closing the superseded PR fails
    // twice: once in executeCreateIntent and once in the same reconcile retry.
    forge.failNextUpdateCount = 2;
    const afterFailure = await publisher().publishByRun(projectId, secondRun.id);
    const active = afterFailure.pullRequests.find((pr) => pr.active)!;
    expect(active.number).not.toBe(firstPr.number);
    expect(afterFailure.pullRequests.filter((pr) => pr.active)).toHaveLength(1);
    expect(afterFailure.auditComplete).toBe(false);
    expect((await forge.getPullRequest(REPO, firstPr.number!))?.state).toBe("OPEN");

    // Reconciliation retries the durable retirement and clears the blocking error.
    const recovered = await publisher().publishByRun(projectId, secondRun.id);
    expect(recovered.auditComplete).toBe(true);
    expect(recovered.target.lastError).toBeNull();
    expect((await forge.getPullRequest(REPO, firstPr.number!))?.state).toBe("CLOSED");
  });
});
