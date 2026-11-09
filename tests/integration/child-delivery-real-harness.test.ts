import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createLocalExecutionRuntime } from "../../apps/backend/src/local-runtime";
import type { ForgePullRequest } from "../../apps/backend/src/registry/forge";
import type { AgentTransport } from "../../scripts/loop/types";
import { seedActivatedAuthority } from "./support/activated-authority";
import {
  findInlineArtifactMarkers,
  encodeInlineArtifactMarker,
} from "../../packages/contracts/src/inline-artifact";
import { normalizeArtifactRelativePath } from "../../apps/backend/src/evidence/artifact-path";

const REPO = "owner/child-delivery-real-harness";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
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

function ticketBody(partOf: number, dependsOn?: number[]): string {
  return [
    `Part of #${partOf}`,
    "",
    "Source acceptance coverage: AC1–AC2",
    "",
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
    dependsOn && dependsOn.length > 0
      ? `Depends on: ${dependsOn.map((n) => `#${n}`).join(", ")}`
      : "Depends on: None",
  ].join("\n");
}

describe("child delivery through the real declared two-command harness", () => {
  let root: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let plans: PlanService;
  let observations: ExecutionObservationService;
  let budget: ExecutionBudgetService;
  let publication: PublicationService;
  let checkoutPath: string;
  let bareOrigin: string;
  let artifactRoot: string;
  let projectId: string;

  function remoteHead(branch: string): string | null {
    try {
      return execFileSync(
        "git",
        ["--git-dir", bareOrigin, "rev-parse", "--verify", `refs/heads/${branch}`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
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

  function forgeOptions(): SyntheticForgeOptions {
    return {
      requireRemoteSourceRef: true,
      resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
      mergeRemote: (_repo, pr) => mergeOnBareOrigin(pr),
    };
  }

  function committingRunner(suffix: string): DispatchRunner {
    return async (context) => {
      const proof = "candidate-proof.txt";
      const impl = `impl-${suffix}-${context.issue_number}-${context.run_id.slice(-6)}.txt`;
      writeFileSync(
        join(context.worktree_path, proof),
        `proof ${suffix} ${context.issue_number}\n`,
      );
      writeFileSync(join(context.worktree_path, impl), `impl ${suffix} ${context.issue_number}\n`);
      git(context.worktree_path, "add", proof, impl);
      git(
        context.worktree_path,
        "commit",
        "-q",
        "-m",
        `implement ${suffix} ${context.issue_number}`,
      );
      return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
    };
  }

  function offlineTransport(): AgentTransport {
    return async (request) => {
      const head = git(request.cwd, "rev-parse", "HEAD");
      const report = {
        sha: head,
        outcome: "approved",
        summary: "independent review passed",
        findings: [],
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", finalText: JSON.stringify(report) }),
        stderr: "",
      };
    };
  }

  function writeHarness(staticCommand: string, unitCommand: string): void {
    mkdirSync(join(checkoutPath, "harness"), { recursive: true });
    writeFileSync(
      join(checkoutPath, "harness", "harness.config.json"),
      `${JSON.stringify(
        { static: staticCommand, unit: unitCommand, protected_paths: ".factory" },
        null,
        2,
      )}\n`,
    );
    git(checkoutPath, "add", "harness/harness.config.json");
    git(checkoutPath, "commit", "-q", "-m", "declare harness checks");
    git(checkoutPath, "push", "-q", "origin", "main");
  }

  function makeRuntime(runner: DispatchRunner, options: { maxCorrections?: number } = {}) {
    const dispatch = new DispatchService(db, {
      plans,
      ledger: new CommandLedger(db),
      brakes: new BrakeService(db),
      observations,
      budget,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner,
    });
    const runtime = createLocalExecutionRuntime({
      db,
      plans,
      dispatch,
      forge,
      observations,
      budget,
      publication,
      artifactRoot,
      maxCorrections: options.maxCorrections ?? 3,
      engine: {
        transport: offlineTransport(),
        provider: "pi",
        model: "test-model",
        roleBudgets: {
          qa: { softMs: 5_000, hardMs: 10_000 },
          reviewer: { softMs: 5_000, hardMs: 10_000 },
        },
      },
    });
    return { dispatch, runtime };
  }

  async function importSpec(
    specIssue: number,
    children: Array<{ issue: number; dependsOn?: number[] }>,
  ) {
    forge.addIssue(REPO, {
      number: specIssue,
      title: "Spec",
      body: specBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });
    for (const child of children) {
      forge.addIssue(REPO, {
        number: child.issue,
        title: `Ticket ${child.issue}`,
        body: ticketBody(specIssue, child.dependsOn),
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        comments: [],
      });
    }
    const plan = await plans.importPlan(projectId, { issue_number: specIssue, kind: "spec" });
    const branch = `factory/spec-${specIssue}-integration`;
    git(checkoutPath, "branch", "-f", branch, "main");
    git(checkoutPath, "push", "-q", "origin", branch);
    return { plan, branch };
  }

  function integrationCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM child_integrations").get() as { c: number }).c;
  }

  function artifactBody(relativePath: string): string {
    return readFileSync(join(artifactRoot, projectId, relativePath), "utf-8");
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-child-real-harness-"));
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

    forge = new SyntheticForgeAdapter({ [REPO]: 9900 }, forgeOptions());
    registry = new ProjectRegistryService(db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    plans = new PlanService(db, forge);
    observations = new ExecutionObservationService(db, { artifactRoot });
    budget = new ExecutionBudgetService(db);
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

  test("two declared commands persist distinct checks, raw reports and inline audit, then integrate a dependent", async () => {
    writeHarness(
      "echo static-stdout && echo static-stderr >&2 && test -f candidate-proof.txt && git rev-parse HEAD > .real-harness-head",
      'echo unit-stdout && test "$(cat .real-harness-head)" = "$(git rev-parse HEAD)"',
    );
    const { plan, branch } = await importSpec(9100, [
      { issue: 9101 },
      { issue: 9102, dependsOn: [9101] },
    ]);
    // No technicalChecks override: the production runtime must read the declared
    // two-command harness config itself.
    const { dispatch, runtime } = makeRuntime(committingRunner("a"));

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(tick.action).toBe("launched");
    const runId = tick.runId!;
    expect((tick.delivery as { action: string }).action).toBe("published");

    const evidence = observations.listObservations(projectId, { runId });
    const technical = evidence.find((item) => item.stage === "technical_checks")!;
    expect(technical.status).toBe("passed");
    expect(technical.checks).toHaveLength(2);
    expect(technical.checks.map((check) => check.name)).toEqual([
      "declared technical/contract check #1",
      "declared technical/contract check #2",
    ]);
    expect(new Set(technical.checks.map((check) => check.name)).size).toBe(2);
    const technicalArtifact = technical.artifacts[0]!;
    const technicalReport = JSON.parse(artifactBody(technicalArtifact.relativePath)) as {
      report: {
        runs: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>;
      };
    };
    expect(technicalReport.report.runs).toHaveLength(2);
    expect(technicalReport.report.runs[0]!.stdout).toContain("static-stdout");
    expect(technicalReport.report.runs[0]!.stderr).toContain("static-stderr");
    expect(technicalReport.report.runs[1]!.stdout).toContain("unit-stdout");
    expect(technicalReport.report.runs.every((run) => run.exitCode === 0)).toBe(true);

    const review = evidence.find((item) => item.stage === "independent_review")!;
    expect(review.status).toBe("passed");
    const reviewArtifact = review.artifacts[0]!;
    const reviewReport = JSON.parse(artifactBody(reviewArtifact.relativePath)) as {
      attemptKey?: string;
      report: {
        rawStdout?: string;
        rawStderr?: string;
        exitCode?: number | null;
        attempt?: number;
        head?: string;
      };
    };
    expect(reviewReport.report.rawStdout ?? "").toContain("independent review passed");
    // N1: the immutable review artifact retains the actual process evidence and
    // attempt identity, not only the parsed report.
    expect(reviewReport.attemptKey).toBeTruthy();
    expect(reviewReport.report.rawStderr).toBe("");
    expect(reviewReport.report.exitCode).toBe(0);
    expect(reviewReport.report.attempt).toBe(0);
    expect(reviewReport.report.head).toMatch(/^[a-f0-9]{40}$/);

    // Inline audit evidence is bound to the immutable local artifact identity and
    // full-file digest, so a child can merge without a per-child hosted upload.
    const events = db
      .prepare("SELECT body FROM publication_events WHERE project_id = ? ORDER BY sequence")
      .all(projectId) as Array<{ body: string }>;
    const inlineMarkers = events
      .flatMap((event) => findInlineArtifactMarkers(event.body))
      .map((parsed) => parsed.marker);
    expect(inlineMarkers.length).toBeGreaterThanOrEqual(2);
    const artifactRows = db
      .prepare("SELECT id, digest_sha256 FROM execution_artifacts WHERE project_id = ?")
      .all(projectId) as Array<{ id: string; digest_sha256: string }>;
    for (const marker of inlineMarkers) {
      expect(marker.inlineSha256).toMatch(/^[a-f0-9]{64}$/);
      const row = artifactRows.find((artifact) => artifact.id === marker.artifactId);
      expect(row).toBeTruthy();
      expect(marker.digestSha256).toBe(row!.digest_sha256);
      expect(marker.truncated).toBe(false);
    }

    const status = publication.getStatusByRun(projectId, runId);
    expect(status.auditComplete).toBe(true);
    expect(status.evidence.length).toBe(0);

    const integration = db
      .prepare(
        "SELECT candidate_head_sha, target_tip_after_sha FROM child_integrations WHERE run_id = ?",
      )
      .get(runId) as { candidate_head_sha: string; target_tip_after_sha: string };
    const run = dispatch.getRun(projectId, runId);
    expect(integration.candidate_head_sha).toBe(run.head_sha);
    git(
      checkoutPath,
      "merge-base",
      "--is-ancestor",
      run.head_sha!,
      integration.target_tip_after_sha,
    );
    expect(integrationCount()).toBe(1);

    const second = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(second.action).toBe("launched");
    expect(second.issueNumber).toBe(9102);
    expect(integrationCount()).toBe(2);
    expect(remoteHead(branch)).toBeTruthy();
    expect(plan.id).toBeTruthy();
  });

  test("a failing middle command blocks merge and preserves every command result", async () => {
    writeHarness("echo first-ok", "echo second-fails >&2 && exit 3");
    await importSpec(9110, [{ issue: 9111 }]);
    const { dispatch, runtime } = makeRuntime(committingRunner("fail"), { maxCorrections: 1 });

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(tick.action).toBe("launched");
    const delivery = tick.delivery as { action: string; reasons: string[] };
    expect(delivery.action).toBe("failed");
    expect(integrationCount()).toBe(0);
    expect(publication.getStatusByRun(projectId, tick.runId!).pullRequests).toEqual([]);

    const technical = observations
      .listObservations(projectId, { runId: tick.runId! })
      .find((item) => item.stage === "technical_checks")!;
    expect(technical.status).toBe("failed");
    expect(technical.checks.map((check) => check.result)).toEqual(["PASS", "FAIL"]);
    expect(technical.checks[1]!.detail).toContain("exit 3");
    const artifact = technical.artifacts[0]!;
    const report = JSON.parse(artifactBody(artifact.relativePath)) as {
      report: { runs: Array<{ stdout: string; stderr: string; exitCode: number }> };
    };
    expect(report.report.runs[0]!.exitCode).toBe(0);
    expect(report.report.runs[1]!.exitCode).toBe(3);
    expect(report.report.runs[1]!.stderr).toContain("second-fails");
  });

  test("an intentionally repeated configured command keeps two distinct checks", async () => {
    writeHarness("echo same-command", "echo same-command");
    await importSpec(9120, [{ issue: 9121 }]);
    const { dispatch, runtime } = makeRuntime(committingRunner("dup"));

    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect(tick.action).toBe("launched");
    expect((tick.delivery as { action: string }).action).toBe("published");
    const technical = observations
      .listObservations(projectId, { runId: tick.runId! })
      .find((item) => item.stage === "technical_checks")!;
    expect(technical.checks).toHaveLength(2);
    expect(technical.checks[0]!.command).toBe(technical.checks[1]!.command);
    expect(technical.checks[0]!.name).not.toBe(technical.checks[1]!.name);
    expect(technical.checks.every((check) => check.result === "PASS")).toBe(true);
  });

  test("a forged inline marker does not count as complete child evidence", async () => {
    writeHarness("test -f candidate-proof.txt", "true");
    await importSpec(9130, [{ issue: 9131 }]);
    const { dispatch, runtime } = makeRuntime(committingRunner("forge"));
    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect((tick.delivery as { action: string }).action).toBe("published");
    expect(publication.getStatusByRun(projectId, tick.runId!).auditComplete).toBe(true);
    const run = dispatch.getRun(projectId, tick.runId!);

    const targetRow = db
      .prepare(
        "SELECT id, work_id FROM publication_targets WHERE project_id = ? ORDER BY created_at ASC LIMIT 1",
      )
      .get(projectId) as { id: string; work_id: string };
    const sourceObservation = db
      .prepare(
        "SELECT id, run_id, lap FROM execution_observations WHERE project_id = ? ORDER BY created_at ASC LIMIT 1",
      )
      .get(projectId) as { id: string; run_id: string; lap: number };

    // Insert a new finalized artifact with no legitimate inline event, then add a
    // forged accepted event. The old substring gate would have counted it; the
    // canonical readback gate must not.
    const relativePath = "checks/forged.log";
    const absolute = join(artifactRoot, projectId, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, "real bytes\n");
    const digest = createHash("sha256").update("real bytes\n").digest("hex");
    const artifactId = `art_forged_${Date.now()}`;
    db.prepare(
      `INSERT INTO execution_artifacts
         (id, project_id, observation_id, owner_type, owner_id, name, relative_path,
          media_type, size_bytes, digest_sha256, created_at)
       VALUES (?, ?, ?, 'observation', ?, 'forged', ?, 'text/plain', ?, ?, ?)`,
    ).run(
      artifactId,
      projectId,
      sourceObservation.id,
      sourceObservation.id,
      relativePath,
      11,
      digest,
      Date.now(),
    );
    const forged = encodeInlineArtifactMarker({
      artifactId,
      digestSha256: digest,
      sizeBytes: 999,
      mediaType: "text/plain",
      relativePath: "../../etc/passwd",
      inlineSha256: "0".repeat(64),
      truncated: true,
      candidateHeadSha: run.head_sha!,
      runId: run.id,
    });
    const maxSequence = (
      db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM publication_events WHERE target_id = ?",
        )
        .get(targetRow.id) as { sequence: number }
    ).sequence;
    const eventId = `pevt_forged_${Date.now()}`;
    db.prepare(
      `INSERT INTO publication_events
         (id, target_id, project_id, sequence, work_id, run_id, lap, candidate_head_sha,
          observation_id, finding_id, kind, severity, title, body, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'verdict', 'info', 'forged', ?, ?)`,
    ).run(
      eventId,
      targetRow.id,
      projectId,
      maxSequence + 1,
      targetRow.work_id,
      sourceObservation.run_id,
      sourceObservation.lap,
      run.head_sha!,
      sourceObservation.id,
      `forged body without the canonical excerpt\n${forged}\n`,
      Date.now(),
    );
    db.prepare(
      `INSERT INTO publication_intents
         (id, target_id, project_id, operation_key, kind, resource_kind, state, request_json, attempts,
          remote_object_id, remote_url, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'publish_event', 'pull_request', 'accepted', ?, 1, 'remote-forged', NULL, NULL, ?, ?)`,
    ).run(
      `int_forged_${Date.now()}`,
      targetRow.id,
      projectId,
      `event:${eventId}`,
      JSON.stringify({ eventId }),
      Date.now(),
      Date.now(),
    );
    expect(publication.getStatusByRun(projectId, tick.runId!).auditComplete).toBe(false);
  }, 120_000);

  test("a tampered finalized artifact revokes inline completeness", async () => {
    writeHarness("test -f candidate-proof.txt", "true");
    await importSpec(9140, [{ issue: 9141 }]);
    const { dispatch, runtime } = makeRuntime(committingRunner("tamper"));
    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect((tick.delivery as { action: string }).action).toBe("published");
    expect(publication.getStatusByRun(projectId, tick.runId!).auditComplete).toBe(true);
    const artifact = db
      .prepare(
        "SELECT relative_path FROM execution_artifacts WHERE project_id = ? ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get(projectId) as { relative_path: string };
    writeFileSync(join(artifactRoot, projectId, artifact.relative_path), "tampered bytes\n");
    expect(publication.getStatusByRun(projectId, tick.runId!).auditComplete).toBe(false);
  }, 120_000);

  test("binary and oversized child artifacts stay truthfully pending, not truncated", async () => {
    writeHarness("test -f candidate-proof.txt", "true");
    await importSpec(9150, [{ issue: 9151 }]);
    const { dispatch, runtime } = makeRuntime(committingRunner("pending"));
    const tick = await runLocalDispatchTick({
      db,
      registry,
      plans,
      dispatch,
      actor: "monitor",
      deliveryRuntime: runtime.delivery,
      finalDeliveryRuntime: runtime.final,
    });
    expect((tick.delivery as { action: string }).action).toBe("published");
    const run = dispatch.getRun(projectId, tick.runId!);
    const gate = observations.ensureTrustedProducer(projectId, {
      id: "pending-gate",
      role: "automated_gate",
    });

    const binaryRelative = "checks/binary.bin";
    const binaryAbsolute = join(artifactRoot, projectId, binaryRelative);
    mkdirSync(join(binaryAbsolute, ".."), { recursive: true });
    writeFileSync(binaryAbsolute, Buffer.from([0x00, 0xff, 0x1b, 0x02, 0x00]));
    observations.recordRunObservation(
      projectId,
      run.id,
      {
        stage: "technical_checks",
        status: "passed",
        producer: gate,
        checks: [{ name: "binary evidence", command: "inspect", result: "PASS" }],
        artifacts: [
          {
            ownerType: "observation",
            name: "binary",
            relativePath: binaryRelative,
            mediaType: "application/octet-stream",
          },
        ],
      },
      { attemptKey: "binary-evidence" },
    );
    expect(publication.getStatusByRun(projectId, tick.runId!).auditComplete).toBe(false);

    const oversizedRelative = "checks/oversized.txt";
    const oversizedAbsolute = join(artifactRoot, projectId, oversizedRelative);
    mkdirSync(join(oversizedAbsolute, ".."), { recursive: true });
    writeFileSync(oversizedAbsolute, "a".repeat(140_000));
    observations.recordRunObservation(
      projectId,
      run.id,
      {
        stage: "technical_checks",
        status: "passed",
        producer: gate,
        checks: [{ name: "oversized evidence", command: "inspect", result: "PASS" }],
        artifacts: [
          {
            ownerType: "observation",
            name: "oversized",
            relativePath: oversizedRelative,
            mediaType: "text/plain",
          },
        ],
      },
      { attemptKey: "oversized-evidence" },
    );
    expect(publication.getStatusByRun(projectId, tick.runId!).auditComplete).toBe(false);
  }, 120_000);

  test("unsafe marker metadata is rejected and never closes the HTML comment", () => {
    expect(() => normalizeArtifactRelativePath("checks/evil\nname.log")).toThrow(/unsafe/i);
    expect(() => normalizeArtifactRelativePath("checks/evil-->comment.log")).toThrow(/unsafe/i);
    expect(() => normalizeArtifactRelativePath("checks/evil<!--open.log")).toThrow(/unsafe/i);

    const encoded = encodeInlineArtifactMarker({
      artifactId: "art_safe",
      digestSha256: "a".repeat(64),
      sizeBytes: 3,
      mediaType: "text/plain --> <!-- INJECTED",
      relativePath: "runtime/proof.txt",
      inlineSha256: "b".repeat(64),
      truncated: false,
      candidateHeadSha: "c".repeat(40),
      runId: "run_safe",
    });
    const payload = encoded.slice(encoded.indexOf("{"), encoded.lastIndexOf("}") + 1);
    expect(payload).not.toContain("-->");
    expect(payload).not.toContain("<!--");
    expect(findInlineArtifactMarkers(encoded)[0]?.marker.mediaType).toBe(
      "text/plain --> <!-- INJECTED",
    );
  });
});
