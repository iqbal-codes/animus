import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@animus/client";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import { runPlanCommand } from "../../scripts/cli/commands/operations";

const REPO = "owner/evidence-http";

function ticketBody(): string {
  return [
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
    "Depends on: None",
  ].join("\n");
}

async function captureLogs(run: () => Promise<number>): Promise<{ code: number; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const code = await run();
    return { code, logs };
  } finally {
    console.log = original;
  }
}

describe("candidate-bound evidence through backend HTTP, client and CLI", () => {
  let root: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
  let projectId: string;
  let checkoutPath: string;

  function backendFetch(application: BackendApp) {
    return async (input: string, init?: RequestInit) => application.fetch(new Request(input, init));
  }

  function artifactRoot(): string {
    return join(root, "animus-home", "state", "artifacts", projectId);
  }

  function commitInWorktree(worktreePath: string): string {
    writeFileSync(join(worktreePath, "dispatch.txt"), "implemented\n");
    execFileSync("git", ["add", "dispatch.txt"], { cwd: worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "implement"], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-evidence-http-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    writeExecutionAuthority("local");
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    execFileSync("git", [
      "-C",
      checkoutPath,
      "remote",
      "add",
      "origin",
      `https://github.com/${REPO}.git`,
    ]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", checkoutPath, "commit", "--allow-empty", "-q", "-m", "base"]);
    execFileSync("git", ["-C", checkoutPath, "branch", "-M", "main"]);

    forge = new SyntheticForgeAdapter({ [REPO]: 914 });
    forge.addIssue(REPO, {
      number: 800,
      title: "Standalone delivery",
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });

    app = await createBackendApp({
      stateDir: join(root, "state"),
      startMonitor: false,
      forge,
      dispatch: {
        processAlive: () => true,
        ownerPid: () => 4242,
        runner: async (context) => ({
          success: true,
          headSha: commitInWorktree(context.worktree_path),
        }),
      },
    });
    const registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    await app.stop();
    delete process.env.ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  async function importPlan(issueNumber: number) {
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/plans/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue_number: issueNumber, kind: "standalone" }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string };
  }

  test("operators see real checks, findings and acceptance through HTTP, client and CLI", async () => {
    const plan = await importPlan(800);
    const client = createFactoryClient({ baseUrl: "http://127.0.0.1", fetch: backendFetch(app) });
    const scoped = client.forProject(projectId);

    const run = await scoped.dispatchPlan({ plan_id: plan.id, actor: "operator" });
    expect(run.state).toBe("succeeded");

    // The dispatcher's own builder observation is durable and visible.
    const builderObservations = await scoped.observations({ runId: run.id });
    expect(builderObservations).toHaveLength(1);
    expect(builderObservations[0]!.stage).toBe("builder_execution");
    expect(builderObservations[0]!.candidateHeadSha).toBe(run.head_sha!);

    // A failing technical stage creates a persistent finding.
    const failed = await scoped.recordObservation({
      run_id: run.id,
      stage: "technical_checks",
      status: "failed",
      producer: { id: "gate-1", role: "automated_gate" },
      checks: [{ name: "unit", command: "bun test", result: "FAIL", detail: "1 failing" }],
      findings: [
        {
          severity: "blocking",
          acKey: "AC1",
          fileContext: "apps/backend/src/example.ts:10",
          summary: "prepared criterion is not implemented",
        },
      ],
    });
    const [finding] = await scoped.findings({ runId: run.id });
    expect(finding!.status).toBe("open");
    expect(finding!.originObservationId).toBe(failed.id);

    const afterFix = await scoped.submitFindingFix(finding!.id, {
      actor: "operator",
      detail: "builder claims fixed",
    });
    expect(afterFix.status).toBe("open");

    // Builder identity cannot self-resolve the finding.
    const selfResolve = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/evidence/findings/${finding!.id}/recheck`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            producer: { id: "operator", role: "peer_reviewer" },
            status: "passed",
            checks: [{ name: "unit", command: "bun test", result: "PASS" }],
          }),
        },
      ),
    );
    expect(selfResolve.status).toBe(422);
    expect(((await selfResolve.json()) as { error: string }).error).toBe(
      "self_certification_rejected",
    );

    const failedRecheck = await scoped.recheckFinding(finding!.id, {
      producer: { id: "reviewer-1", role: "peer_reviewer" },
      status: "failed",
      checks: [{ name: "unit", command: "bun test", result: "FAIL" }],
    });
    expect(failedRecheck.status).toBe("open");
    expect(failedRecheck.events.map((event) => event.action)).toContain("recheck_failed");

    mkdirSync(join(artifactRoot(), "checks"), { recursive: true });
    writeFileSync(join(artifactRoot(), "checks/http.log"), "independent review passed\n");
    const resolved = await scoped.recheckFinding(finding!.id, {
      producer: { id: "reviewer-2", role: "peer_reviewer" },
      status: "passed",
      checks: [
        {
          name: "unit",
          command: "bun test",
          result: "PASS",
          artifactPath: "checks/http.log",
        },
      ],
      artifacts: [
        {
          ownerType: "observation",
          name: "unit-report",
          relativePath: "checks/http.log",
          mediaType: "text/plain",
        },
      ],
    });
    expect(resolved.status).toBe("resolved");

    const report = await scoped.runEvidence(run.id);
    expect(report.acceptance.authorized).toBe(true);
    expect(report.acceptance.reasons).toEqual([]);
    expect(report.findings.find((item) => item.id === finding!.id)?.status).toBe("resolved");
    expect(report.observations.some((item) => item.artifacts.length > 0)).toBe(true);
    expect(report.acceptance.builderObservationId).toBe(builderObservations[0]!.id);
    expect(report.acceptance.independentObservationId).toBeTruthy();

    const acceptance = await scoped.acceptance(run.id);
    expect(acceptance).toEqual(report.acceptance);

    const humanRun = await captureLogs(() =>
      runPlanCommand({
        subcommand: "run",
        positionals: ["plan", "run", run.id],
        projectId,
        fetch: backendFetch(app),
      }),
    );
    expect(humanRun.code).toBe(0);
    const human = humanRun.logs.join("\n");
    expect(human).toContain("Checks & findings");
    expect(human).toContain("Acceptance: AUTHORIZED");
    expect(human).toContain("checks/http.log");
    expect(human).toContain("technical_checks");

    const cliEvidence = await captureLogs(() =>
      runPlanCommand({
        subcommand: "evidence",
        positionals: ["plan", "evidence", run.id],
        projectId,
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(cliEvidence.code).toBe(0);
    const parsed = JSON.parse(cliEvidence.logs.join("\n")) as {
      observations: unknown[];
      findings: unknown[];
      acceptance: { authorized: boolean };
    };
    expect(parsed.observations.length).toBeGreaterThanOrEqual(3);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.acceptance.authorized).toBe(true);

    const cliFindings = await captureLogs(() =>
      runPlanCommand({
        subcommand: "findings",
        positionals: ["plan", "findings", run.id],
        projectId,
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(cliFindings.code).toBe(0);
    expect((JSON.parse(cliFindings.logs.join("\n")) as unknown[]).length).toBe(1);
  });

  test("HTTP rejects forged ownership and unauthorized stage producers", async () => {
    const plan = await importPlan(800);
    const client = createFactoryClient({ baseUrl: "http://127.0.0.1", fetch: backendFetch(app) });
    const scoped = client.forProject(projectId);
    const run = await scoped.dispatchPlan({ plan_id: plan.id, actor: "operator" });

    const otherCheckout = join(root, "other-checkout");
    mkdirSync(otherCheckout, { recursive: true });
    execFileSync("git", ["init", "-q", otherCheckout]);
    execFileSync("git", [
      "-C",
      otherCheckout,
      "remote",
      "add",
      "origin",
      "https://github.com/owner/other-http.git",
    ]);
    execFileSync("git", ["-C", otherCheckout, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", otherCheckout, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", otherCheckout, "commit", "--allow-empty", "-q", "-m", "base"]);
    execFileSync("git", ["-C", otherCheckout, "branch", "-M", "main"]);
    const otherForge = new SyntheticForgeAdapter({ "owner/other-http": 915 });
    const otherRegistry = new ProjectRegistryService(app.db, otherForge);
    const other = await otherRegistry.registerProject({
      method: "local_checkout",
      name: "Other",
      checkout_path: otherCheckout,
    });

    const forged = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${other.id}/evidence/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: run.id,
          stage: "technical_checks",
          status: "passed",
          producer: { id: "gate-1", role: "automated_gate" },
          checks: [{ name: "unit", command: "bun test", result: "PASS" }],
        }),
      }),
    );
    expect(forged.status).toBe(422);
    expect(((await forged.json()) as { error: string }).error).toBe("forged_ownership");

    const wrongRole = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/evidence/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: run.id,
          stage: "independent_review",
          status: "passed",
          producer: { id: "someone", role: "builder" },
          checks: [{ name: "review", command: "review", result: "PASS" }],
        }),
      }),
    );
    expect(wrongRole.status).toBe(422);
    expect(((await wrongRole.json()) as { error: string }).error).toBe("invalid_stage_producer");

    const missing = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/evidence/findings/missing-finding/recheck`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            producer: { id: "reviewer-1", role: "peer_reviewer" },
            status: "passed",
            checks: [{ name: "review", command: "review", result: "PASS" }],
          }),
        },
      ),
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("finding_not_found");
  });
});
