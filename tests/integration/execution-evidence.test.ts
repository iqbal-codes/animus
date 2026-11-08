import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
import { ExecutionObservationService, EvidenceError } from "../../apps/backend/src/evidence";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import type { ArtifactSubmission } from "@animus/contracts/operator";

const REPO = "owner/evidence-repo";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function ticketBody(
  options: { partOf?: number; coverage?: string; dependsOn?: number[] } = {},
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

describe("candidate-bound execution observations, findings and artifacts", () => {
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

  function committingRunner(): DispatchRunner {
    return async (context) => ({
      success: true,
      headSha: commitInWorktree(context.worktree_path, "impl.txt"),
    });
  }

  function makeDispatch(options: Record<string, unknown> = {}) {
    return new DispatchService(db, {
      plans,
      ledger,
      brakes,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: committingRunner(),
      ...options,
    } as ConstructorParameters<typeof DispatchService>[1]);
  }

  function addIssue(
    number: number,
    body: string = ticketBody(),
    labels: string[] = ["ready-for-agent"],
  ) {
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

  async function dispatchStandalone(issueNumber: number) {
    addIssue(issueNumber);
    const plan = await plans.importPlan(projectId, {
      issue_number: issueNumber,
      kind: "standalone",
    });
    const run = await makeDispatch().dispatch(projectId, { plan_id: plan.id, actor: "operator" });
    return { plan, run };
  }

  function countObservations(): number {
    return (
      db.prepare("SELECT COUNT(*) AS count FROM execution_observations").get() as { count: number }
    ).count;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-evidence-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    writeExecutionAuthority("local");
    db = initializeDatabase(join(root, "state", "console.db"));
    forge = new SyntheticForgeAdapter({ [REPO]: 712 });
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

  test("AC1: dispatch persists an immutable candidate-bound builder observation with the full envelope", async () => {
    const { run } = await dispatchStandalone(700);

    const list = observations.listObservations(projectId, { runId: run.id });
    expect(list).toHaveLength(1);
    const [builder] = list;
    expect(builder).toMatchObject({
      stage: "builder_execution",
      status: "passed",
      lap: 1,
      candidateHeadSha: run.head_sha,
      targetTipSha: run.base_sha,
      mergeBaseSha: run.base_sha,
      testedIdentity: run.head_sha,
      gateProfile: "standalone",
      gateProfileVersion: 2,
      producer: { id: "operator", role: "builder" },
      error: null,
    });
    expect(builder!.integrationLineage).toMatch(/^[a-f0-9]{64}@main$/);
    expect(builder!.checks).toHaveLength(1);
    expect(builder!.checks[0]).toMatchObject({ name: "builder_commit", result: "PASS" });

    expect(() =>
      db
        .prepare("UPDATE execution_observations SET status = 'failed' WHERE id = ?")
        .run(builder!.id),
    ).toThrow(/immutable/i);
    expect(() =>
      db.prepare("DELETE FROM execution_observations WHERE id = ?").run(builder!.id),
    ).toThrow(/immutable/i);
  });

  test("AC2: findings keep original evidence across laps; fix cannot resolve; failed recheck preserves; authorized pass resolves", async () => {
    const { run } = await dispatchStandalone(701);
    register("gate-1", "automated_gate");
    register("reviewer-1", "peer_reviewer");
    register("reviewer-2", "peer_reviewer");

    const gate = { id: "gate-1", role: "automated_gate" as const };
    const failed = observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "failed",
      producer: gate,
      checks: [{ name: "unit", command: "bun test", result: "FAIL", detail: "2 failing" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "apps/backend/src/example.ts:42",
          summary: "Unit test fails for the prepared criterion",
        },
      ],
    });
    const finding = observations.listFindings(projectId, { runId: run.id })[0]!;
    expect(finding.status).toBe("open");
    expect(finding.originObservationId).toBe(failed.id);
    expect(finding.events.map((event) => event.action)).toEqual(["opened"]);

    const afterFixClaim = observations.recordFindingFix(projectId, finding.id, {
      actor: "operator",
      detail: "builder claims fixed",
    });
    expect(afterFixClaim.status).toBe("open");
    expect(afterFixClaim.events.map((event) => event.action)).toEqual(["opened", "fix_submitted"]);

    // The builder identity cannot certify its own fix.
    expect(() =>
      observations.recordFindingRecheck(projectId, finding.id, {
        producer: { id: "operator", role: "peer_reviewer" },
        status: "passed",
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
      }),
    ).toThrowError(/builder identity/i);

    const failedRecheck = observations.recordFindingRecheck(projectId, finding.id, {
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      status: "failed",
      checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
    });
    expect(failedRecheck.status).toBe("open");
    expect(failedRecheck.events.map((event) => event.action)).toEqual([
      "opened",
      "fix_submitted",
      "recheck_failed",
    ]);

    writeArtifact("checks/report.log", "recheck passed\n");
    const passedRecheck = observations.recordFindingRecheck(projectId, finding.id, {
      producer: { id: "reviewer-2", role: "peer_reviewer" },
      status: "passed",
      checks: [
        {
          name: "unit",
          command: "bun test",
          result: "PASS",
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
    expect(passedRecheck.status).toBe("resolved");
    expect(passedRecheck.events.map((event) => event.action)).toEqual([
      "opened",
      "fix_submitted",
      "recheck_failed",
      "recheck_passed",
    ]);
    expect(passedRecheck.resolvedAt).toBeTypeOf("number");

    // Old failed evidence remains readable, including its original observation.
    const all = observations.listObservations(projectId, { runId: run.id });
    const failedStill = all.find((item) => item.id === failed.id)!;
    expect(failedStill.status).toBe("failed");
    expect(
      all.some((item) => item.stage === "independent_review" && item.status === "failed"),
    ).toBe(true);
    const resolvedFinding = observations.getFinding(projectId, finding.id);
    const recheckEvent = resolvedFinding.events.find((event) => event.action === "recheck_failed")!;
    expect(recheckEvent.observationId).toBeTruthy();

    const acceptance = observations.evaluateAcceptance(projectId, run.id);
    expect(acceptance.authorized).toBe(true);
    expect(acceptance.reasons).toEqual([]);
    expect(acceptance.verifiedArtifactIds).toHaveLength(1);

    // Corrupting a finalized artifact revokes authorization without rewriting history.
    writeFileSync(join(artifactRoot(), "checks/report.log"), "tampered\n");
    const corrupt = observations.evaluateAcceptance(projectId, run.id);
    expect(corrupt.authorized).toBe(false);
    expect(corrupt.reasons.join(" ")).toMatch(
      /artifact_(digest|size)_mismatch:checks\/report\.log/,
    );

    unlinkSync(join(artifactRoot(), "checks/report.log"));
    const missing = observations.evaluateAcceptance(projectId, run.id);
    expect(missing.authorized).toBe(false);
    expect(missing.reasons).toContain("artifact_missing:checks/report.log");
  });

  test("AC3: stale target tip, forged ownership and self-certified review cannot authorize acceptance", async () => {
    const { run } = await dispatchStandalone(702);
    register("reviewer-1", "peer_reviewer");

    observations.recordRunObservation(projectId, run.id, {
      stage: "independent_review",
      status: "passed",
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      checks: [{ name: "standards", command: "review diff", result: "PASS" }],
    });
    expect(observations.evaluateAcceptance(projectId, run.id).authorized).toBe(true);

    // A new candidate head or target advance invalidates the prior evidence.
    git(checkoutPath, "commit", "--allow-empty", "-q", "-m", "advance target");
    const stale = observations.evaluateAcceptance(projectId, run.id);
    expect(stale.authorized).toBe(false);
    expect(stale.reasons).toContain("stale_target_tip");

    // The builder identity cannot stand in for an independent reviewer.
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "final_acceptance",
        status: "passed",
        producer: { id: "operator", role: "independent_evaluator" },
        checks: [{ name: "final", command: "qa", result: "PASS" }],
      }),
    ).toThrowError(/builder identity/i);

    // A run owned by another project cannot be observed through this project.
    forge.addIssue("owner/other-repo", {
      number: 1,
      title: "Other",
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    const otherRegistry = new ProjectRegistryService(db, forge);
    const otherPath = join(root, "other-checkout");
    mkdirSync(otherPath, { recursive: true });
    execFileSync("git", ["init", "-q", otherPath]);
    git(otherPath, "remote", "add", "origin", "https://github.com/owner/other-repo.git");
    git(otherPath, "config", "user.email", "test@example.com");
    git(otherPath, "config", "user.name", "Test");
    git(otherPath, "commit", "--allow-empty", "-q", "-m", "base");
    git(otherPath, "branch", "-M", "main");
    const other = await otherRegistry.registerProject({
      method: "local_checkout",
      name: "Other",
      checkout_path: otherPath,
    });
    try {
      observations.recordRunObservation(other.id, run.id, {
        stage: "technical_checks",
        status: "passed",
        producer: { id: "gate-1", role: "automated_gate" },
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
      });
      throw new Error("expected forged ownership to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceError);
      expect((error as EvidenceError).code).toBe("forged_ownership");
    }
  });

  test("AC4/AC5: missing, unsafe and atomic violations leave no partial observation rows", async () => {
    const { run } = await dispatchStandalone(703);
    register("gate-1", "automated_gate");
    register("gate-2", "automated_gate");
    const before = countObservations();

    // A check that cites an unfinalized artifact cannot be recorded.
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "passed",
        producer: { id: "gate-1", role: "automated_gate" },
        checks: [
          { name: "unit", command: "bun test", result: "PASS", artifactPath: "missing/report.log" },
        ],
      }),
    ).toThrowError(/missing/i);
    expect(countObservations()).toBe(before);

    // Path traversal is rejected before any row is written.
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "passed",
        producer: { id: "gate-1", role: "automated_gate" },
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
        artifacts: [
          {
            ownerType: "observation",
            name: "escape",
            relativePath: "../escape.log",
            mediaType: "text/plain",
          },
        ],
      }),
    ).toThrowError(/escapes|relative path/i);
    expect(countObservations()).toBe(before);

    // A finding owned by an index that does not exist is forged ownership.
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "passed",
        producer: { id: "gate-1", role: "automated_gate" },
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
        artifacts: [
          {
            ownerType: "finding",
            ownerFindingIndex: 3,
            name: "report",
            relativePath: "missing/report.log",
            mediaType: "text/plain",
          },
        ],
      }),
    ).toThrowError(/finding index/i);
    expect(countObservations()).toBe(before);

    // A finding cannot be scoped to a different ticket than the run's own work item.
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "failed",
        producer: { id: "gate-1", role: "automated_gate" },
        checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
        findings: [
          {
            severity: "blocking",
            workId: "work-other-ticket",
            fileContext: "apps/backend/src/example.ts",
            summary: "cross-ticket finding",
          },
        ],
      }),
    ).toThrowError(/own work item/i);
    expect(countObservations()).toBe(before);

    // A real database constraint failure rolls back the observation, checks and findings.
    writeArtifact("checks/atomic.log");
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "failed",
        producer: { id: "gate-1", role: "automated_gate" },
        checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
        findings: [
          {
            severity: "blocking",
            fileContext: "apps/backend/src/example.ts",
            summary: "forced constraint failure",
          },
        ],
        artifacts: [
          {
            ownerType: "observation",
            name: "atomic",
            relativePath: "checks/atomic.log",
            mediaType: "text/plain",
          },
          // The second identical owner/path violates a real UNIQUE constraint.
          {
            ownerType: "observation",
            name: "atomic-duplicate",
            relativePath: "checks/atomic.log",
            mediaType: "text/plain",
          },
        ],
      }),
    ).toThrow();
    expect(countObservations()).toBe(before);
    const checks = db.prepare("SELECT COUNT(*) AS count FROM execution_checks").get() as {
      count: number;
    };
    expect(checks.count).toBe(1); // only the dispatch builder check
    const findings = db.prepare("SELECT COUNT(*) AS count FROM factory_findings").get() as {
      count: number;
    };
    expect(findings.count).toBe(0);
    const artifacts = db.prepare("SELECT COUNT(*) AS count FROM execution_artifacts").get() as {
      count: number;
    };
    expect(artifacts.count).toBe(0);
  });

  test("AC2/AC5: a real fix lap appends evidence without rewriting the prior failed result", async () => {
    const { plan, run } = await dispatchStandalone(704);
    register("gate-1", "automated_gate");
    register("reviewer-3", "peer_reviewer");

    const failed = observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "failed",
      producer: { id: "gate-1", role: "automated_gate" },
      checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "src/a.ts",
          summary: "failed on candidate one",
        },
      ],
    });
    const crossLapFinding = observations.listFindings(projectId, { runId: run.id })[0]!;
    expect(crossLapFinding.status).toBe("open");

    // A real re-dispatch after the open finding starts the next builder/fix lap for
    // this ticket; it is not a manually fabricated dispatch row.
    const secondRun = await makeDispatch().dispatch(projectId, {
      plan_id: plan.id,
      work_id: run.work_id,
      actor: "operator",
    });
    expect(secondRun.work_id).toBe(run.work_id);
    expect(secondRun.lap).toBe(2);
    expect(observations.listObservations(projectId, { runId: secondRun.id })[0]!.lap).toBe(2);

    const firstRunEvidence = observations.listObservations(projectId, { runId: run.id });
    expect(firstRunEvidence.find((item) => item.id === failed.id)).toMatchObject({
      status: "failed",
      candidateHeadSha: run.head_sha,
      lap: 1,
    });
    expect(
      observations.getRunEvidence(projectId, secondRun.id).findings.map((f) => f.id),
    ).toContain(crossLapFinding.id);

    // The finding persists into the next lap; an authorized recheck against the new
    // candidate resolves it and the later run's detail still shows that history.
    const resolvedOnNextLap = observations.recordFindingRecheck(projectId, crossLapFinding.id, {
      runId: secondRun.id,
      producer: { id: "reviewer-3", role: "peer_reviewer" },
      status: "passed",
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });
    expect(resolvedOnNextLap.status).toBe("resolved");
    expect(resolvedOnNextLap.events.at(-1)).toMatchObject({
      action: "recheck_passed",
      actor: "reviewer-3",
    });
    const nextEvidence = observations.getRunEvidence(projectId, secondRun.id);
    expect(
      nextEvidence.findings.find((finding) => finding.id === crossLapFinding.id)!.events.at(-1)!
        .action,
    ).toBe("recheck_passed");
    expect(nextEvidence.acceptance.authorized).toBe(true);
    expect(nextEvidence.acceptance.independentObservationId).toBe(
      resolvedOnNextLap.events.at(-1)!.observationId,
    );
  });

  test("B1/AC1: a newer inconclusive or failed stage result revokes an earlier pass", async () => {
    const { run } = await dispatchStandalone(706);
    register("reviewer-1", "peer_reviewer");
    register("reviewer-2", "peer_reviewer");

    observations.recordRunObservation(projectId, run.id, {
      stage: "independent_review",
      status: "passed",
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      checks: [{ name: "standards", command: "review", result: "PASS" }],
    });
    expect(observations.evaluateAcceptance(projectId, run.id).authorized).toBe(true);

    observations.recordRunObservation(projectId, run.id, {
      stage: "independent_review",
      status: "inconclusive",
      producer: { id: "reviewer-2", role: "peer_reviewer" },
      checks: [{ name: "standards", command: "review", result: "BLOCKED" }],
    });
    const afterInconclusive = observations.evaluateAcceptance(projectId, run.id);
    expect(afterInconclusive.authorized).toBe(false);
    expect(afterInconclusive.reasons).toContain(
      "required_stage_not_passed:independent_review:inconclusive",
    );
    // History is retained rather than rewritten.
    expect(
      observations
        .listObservations(projectId, { runId: run.id })
        .filter((item) => item.stage === "independent_review"),
    ).toHaveLength(2);

    // The same rule applies to the builder stage: a newer non-pass dominates an older pass.
    observations.recordRunObservation(
      projectId,
      run.id,
      {
        stage: "builder_execution",
        status: "failed",
        producer: { id: "operator", role: "builder" },
        checks: [{ name: "builder_commit", command: "git rev-parse HEAD", result: "FAIL" }],
      },
      { attemptKey: "builder-late-attempt" },
    );
    expect(observations.evaluateAcceptance(projectId, run.id).reasons).toContain(
      "builder_result_not_passed:failed",
    );
  });

  test("B2/AC2/AC3: sibling tickets in one spec delivery never share findings or acceptance", async () => {
    addIssue(100, specBody(["parent first", "parent second"]), ["ready-for-agent", "spec"]);
    addIssue(101, ticketBody({ partOf: 100, coverage: "AC1" }));
    addIssue(102, ticketBody({ partOf: 100, coverage: "AC2" }));
    const plan = await plans.importPlan(projectId, { issue_number: 100, kind: "spec" });
    expect(plan.authority).toBe("admitted");
    git(checkoutPath, "branch", "factory/spec-100-integration", "main");
    register("gate-1", "automated_gate");
    register("reviewer-1", "peer_reviewer");

    const service = makeDispatch();
    const runA = await service.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 101,
      actor: "operator",
    });
    const runB = await service.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 102,
      actor: "operator",
    });
    expect(runA.issue_number).not.toBe(runB.issue_number);
    expect(runA.delivery_id).toBe(runB.delivery_id);

    observations.recordRunObservation(projectId, runA.id, {
      stage: "technical_checks",
      status: "failed",
      producer: { id: "gate-1", role: "automated_gate" },
      checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "src/a.ts",
          summary: "ticket A defect",
        },
      ],
    });
    observations.recordRunObservation(projectId, runB.id, {
      stage: "technical_checks",
      status: "passed",
      producer: { id: "gate-1", role: "automated_gate" },
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });
    // The child gate profile also requires an independent standards/contract review.
    observations.recordRunObservation(projectId, runB.id, {
      stage: "independent_review",
      status: "passed",
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      checks: [{ name: "standards", command: "review diff", result: "PASS" }],
    });

    const findingA = observations.listFindings(projectId, { runId: runA.id })[0]!;
    const evidenceA = observations.getRunEvidence(projectId, runA.id);
    const evidenceB = observations.getRunEvidence(projectId, runB.id);
    expect(evidenceB.findings).toHaveLength(0);
    expect(evidenceB.acceptance.authorized).toBe(true);
    expect(evidenceA.findings.map((finding) => finding.id)).toEqual([findingA.id]);
    expect(evidenceA.acceptance.authorized).toBe(false);
    expect(evidenceA.acceptance.reasons).toContain("open_blocking_findings");

    // A sibling ticket cannot recheck (or inherit) another ticket's finding.
    expect(() =>
      observations.recordFindingRecheck(projectId, findingA.id, {
        runId: runB.id,
        producer: { id: "gate-1", role: "automated_gate" },
        status: "passed",
        checks: [{ name: "unit", command: "bun test", result: "PASS" }],
      }),
    ).toThrowError(/own work item/i);
  });

  test("B3/AC1: laps are per-ticket builder cycles, distinct from delivery ownership generations", async () => {
    addIssue(200, specBody(["parent first", "parent second"]), ["ready-for-agent", "spec"]);
    addIssue(201, ticketBody({ partOf: 200, coverage: "AC1" }));
    addIssue(202, ticketBody({ partOf: 200, coverage: "AC2" }));
    const plan = await plans.importPlan(projectId, { issue_number: 200, kind: "spec" });
    git(checkoutPath, "branch", "factory/spec-200-integration", "main");
    register("gate-1", "automated_gate");

    const service = makeDispatch();
    const runA = await service.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 201,
      actor: "operator",
    });
    const runB = await service.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 202,
      actor: "operator",
    });

    // Ownership generation fences the whole delivery; lap is the ticket's own cycle.
    expect(runA.ownership_generation).toBe(1);
    expect(runB.ownership_generation).toBe(2);
    expect(runA.lap).toBe(1);
    expect(runB.lap).toBe(1);
    expect(observations.listObservations(projectId, { runId: runA.id })[0]!.lap).toBe(1);
    expect(observations.listObservations(projectId, { runId: runB.id })[0]!.lap).toBe(1);

    observations.recordRunObservation(projectId, runA.id, {
      stage: "technical_checks",
      status: "failed",
      producer: { id: "gate-1", role: "automated_gate" },
      checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
      findings: [{ severity: "blocking", fileContext: "src/a.ts", summary: "fix the ticket" }],
    });
    const nextA = await service.dispatch(projectId, {
      plan_id: plan.id,
      issue_number: 201,
      actor: "operator",
    });
    expect(nextA.lap).toBe(2);
    expect(nextA.ownership_generation).toBeGreaterThan(runB.ownership_generation);
    expect(observations.listObservations(projectId, { runId: nextA.id })[0]!.lap).toBe(2);
    // Ticket B's first cycle stays lap 1; sibling laps never advance it.
    expect(observations.listObservations(projectId, { runId: runB.id })[0]!.lap).toBe(1);
  });

  test("B4/AC3: producer identity is a durable trusted registration, not a caller string", async () => {
    const { run } = await dispatchStandalone(708);

    // A fresh, unregistered reviewer id is not an identity.
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "independent_review",
        status: "passed",
        producer: { id: "forged-reviewer", role: "peer_reviewer" },
        checks: [{ name: "standards", command: "review", result: "PASS" }],
      }),
    ).toThrowError(/registered trusted identity/i);

    // The builder result is bound to the durable dispatch actor/claim.
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "builder_execution",
        status: "passed",
        producer: { id: "someone-else", role: "builder" },
        checks: [{ name: "builder_commit", command: "git rev-parse HEAD", result: "PASS" }],
      }),
    ).toThrowError(/durable dispatch actor/i);

    // Credentials are one-time secrets over a durable registered identity.
    const registered = observations.registerTrustedProducer(projectId, {
      id: "reviewer-1",
      role: "peer_reviewer",
      name: "Reviewer One",
    });
    expect(observations.authenticateProducer(projectId, registered.credential)).toMatchObject({
      id: "reviewer-1",
      role: "peer_reviewer",
      name: "Reviewer One",
    });
    expect(() =>
      observations.authenticateProducer(projectId, "prd_forged_credential"),
    ).toThrowError(/credential is not registered/i);
    expect(() =>
      observations.registerTrustedProducer(projectId, { id: "reviewer-1", role: "peer_reviewer" }),
    ).toThrowError(/already registered/i);

    observations.recordRunObservation(projectId, run.id, {
      stage: "independent_review",
      status: "passed",
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      checks: [{ name: "standards", command: "review", result: "PASS" }],
    });
    expect(observations.evaluateAcceptance(projectId, run.id).authorized).toBe(true);
  });

  test("AC2: one reviewer can recheck multiple findings in the same lap with distinct attempts", async () => {
    const { run } = await dispatchStandalone(709);
    register("gate-1", "automated_gate");
    register("reviewer-1", "peer_reviewer");

    observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "failed",
      producer: { id: "gate-1", role: "automated_gate" },
      checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
      findings: [
        { severity: "blocking", acKey: "AC1", fileContext: "src/a.ts", summary: "first" },
        { severity: "blocking", acKey: "AC2", fileContext: "src/b.ts", summary: "second" },
      ],
    });
    const findings = observations.listFindings(projectId, { runId: run.id });
    expect(findings).toHaveLength(2);

    const first = observations.recordFindingRecheck(projectId, findings[0]!.id, {
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      status: "passed",
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });
    const second = observations.recordFindingRecheck(projectId, findings[1]!.id, {
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      status: "passed",
      checks: [{ name: "unit", command: "bun test", result: "PASS" }],
    });
    expect(first.status).toBe("resolved");
    expect(second.status).toBe("resolved");
    const rechecks = observations
      .listObservations(projectId, { runId: run.id })
      .filter((observation) => observation.stage === "independent_review");
    expect(rechecks).toHaveLength(2);
    expect(new Set(rechecks.map((observation) => observation.attemptKey)).size).toBe(2);
    expect(observations.evaluateAcceptance(projectId, run.id).authorized).toBe(true);
  });

  test("AC4: artifact ownership is typed and re-verified on disk", async () => {
    const { run } = await dispatchStandalone(705);
    register("gate-1", "automated_gate");
    register("gate-2", "automated_gate");
    writeArtifact("checks/a.log", "a\n");
    writeArtifact("checks/b.log", "b\n");

    const observation = observations.recordRunObservation(projectId, run.id, {
      stage: "technical_checks",
      status: "failed",
      producer: { id: "gate-1", role: "automated_gate" },
      checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
      findings: [
        {
          severity: "conditional",
          fileContext: "src/b.ts",
          summary: "conditional finding",
        },
      ],
      artifacts: [
        {
          ownerType: "observation",
          name: "run-log",
          relativePath: "checks/a.log",
          mediaType: "text/plain",
        },
        {
          ownerType: "finding",
          ownerFindingIndex: 0,
          name: "finding-log",
          relativePath: "checks/b.log",
          mediaType: "text/plain",
        },
      ],
    });

    expect(observation.artifacts.map((artifact) => artifact.ownerType)).toEqual([
      "observation",
      "finding",
    ]);
    const finding = observations.listFindings(projectId, { runId: run.id })[0]!;
    const findingArtifact = observation.artifacts.find(
      (artifact) => artifact.ownerType === "finding",
    )!;
    expect(findingArtifact.ownerId).toBe(finding.id);
    expect(findingArtifact.sizeBytes).toBe(2);
    expect(findingArtifact.digestSha256).toMatch(/^[a-f0-9]{64}$/);

    // Finalized artifacts cannot be rewritten in place.
    expect(() =>
      db
        .prepare("UPDATE execution_artifacts SET size_bytes = 999 WHERE id = ?")
        .run(findingArtifact.id),
    ).toThrow(/immutable/i);

    // An observation-owned artifact cannot claim a finding index.
    expect(() =>
      observations.recordRunObservation(projectId, run.id, {
        stage: "technical_checks",
        status: "failed",
        producer: { id: "gate-2", role: "automated_gate" },
        checks: [{ name: "other", command: "bun test", result: "FAIL" }],
        artifacts: [
          {
            ownerType: "observation",
            ownerFindingIndex: 0,
            name: "bad",
            relativePath: "checks/a.log",
            mediaType: "text/plain",
          } as ArtifactSubmission,
        ],
      }),
    ).toThrowError(/finding index/i);
  });
});
