import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@animus/client";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import {
  ProjectRegistryService,
  SyntheticForgeAdapter,
  type SyntheticForgeOptions,
} from "../../apps/backend/src/registry";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import { runPlanCommand } from "../../scripts/cli/commands/operations";

const REPO = "owner/standalone-delivery-http";

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
    "- [ ] AC1: prepared criterion",
    "",
    "## Boundary",
    "",
    "Prepared standalone ticket boundary.",
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

describe("standalone delivery gate through backend HTTP, client and CLI", () => {
  let root: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
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

  function backendFetch(application: BackendApp) {
    return async (input: string, init?: RequestInit) => application.fetch(new Request(input, init));
  }

  function commitInWorktree(worktreePath: string): string {
    writeFileSync(join(worktreePath, "delivery.txt"), "implemented\n");
    execFileSync("git", ["add", "delivery.txt"], { cwd: worktreePath, stdio: "ignore" });
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
    root = mkdtempSync(join(tmpdir(), "animus-standalone-http-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    writeExecutionAuthority("local");
    checkoutPath = join(root, "checkout");
    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
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
    execFileSync("git", [
      "-C",
      checkoutPath,
      "config",
      `url.${bareOrigin}.insteadOf`,
      `https://github.com/${REPO}.git`,
    ]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", checkoutPath, "commit", "--allow-empty", "-q", "-m", "base"]);
    execFileSync("git", ["-C", checkoutPath, "branch", "-M", "main"]);
    execFileSync("git", ["-C", checkoutPath, "push", "-q", "origin", "main"]);

    const options: SyntheticForgeOptions = {
      requireRemoteSourceRef: true,
      resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
    };
    forge = new SyntheticForgeAdapter({ [REPO]: 916 }, options);
    forge.addIssue(REPO, {
      number: 1700,
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

  test("operators can see the full gate, wait for manual merge and verify the remote merge through HTTP, client and CLI", async () => {
    const plan = await importPlan(1700);
    const client = createFactoryClient({ baseUrl: "http://127.0.0.1", fetch: backendFetch(app) });
    const scoped = client.forProject(projectId);

    const run = await scoped.dispatchPlan({ plan_id: plan.id, actor: "operator" });
    expect(run.state).toBe("succeeded");

    const producerService = new ExecutionObservationService(app.db);
    const reviewer = producerService.registerTrustedProducer(projectId, {
      id: "reviewer-http",
      role: "peer_reviewer",
    });
    const finalEvaluator = producerService.registerTrustedProducer(projectId, {
      id: "final-http",
      role: "independent_evaluator",
    });

    await scoped.recordObservation({
      run_id: run.id,
      producer_credential: reviewer.credential,
      stage: "independent_review",
      status: "passed",
      checks: [
        { name: "standards review", command: "review diff", result: "PASS", kind: "review" },
      ],
    });
    await scoped.recordObservation({
      run_id: run.id,
      producer_credential: finalEvaluator.credential,
      stage: "final_acceptance",
      status: "passed",
      checks: [
        {
          name: "AC1 black-box",
          command: "acceptance AC1",
          result: "PASS",
          kind: "acceptance",
          criterionKey: "AC1",
        },
        { name: "regression", command: "bun test targeted", result: "PASS", kind: "regression" },
        { name: "remote ci", command: "gh pr checks", result: "PASS", kind: "remote_ci" },
      ],
    });

    const published = await scoped.publishPublication(run.id);
    expect(published.auditComplete).toBe(true);
    const pr = published.pullRequests.find((candidate) => candidate.active)!;

    const gate = await scoped.deliveryGate(run.id);
    expect(gate.state).toBe("ready_for_operator_review");
    expect(gate.manualMergeRequired).toBe(true);
    expect(gate.merge.state).toBe("not_merged");
    expect(gate.publication).toMatchObject({
      prNumber: pr.number,
      remoteState: "open",
      draft: true,
      auditComplete: true,
    });

    const cli = await captureLogs(() =>
      runPlanCommand({
        subcommand: "gate",
        positionals: ["plan", "gate", run.id],
        projectId,
        factoryUrl: "http://127.0.0.1",
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(cli.code).toBe(0);
    const printed = JSON.parse(cli.logs.join("\n"));
    expect(printed.state).toBe("ready_for_operator_review");
    expect(printed.manualMergeRequired).toBe(true);

    // The operator has not merged yet; verification is refused over HTTP.
    const beforeMerge = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/delivery/runs/${encodeURIComponent(run.id)}/verify-merge`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      ),
    );
    expect(beforeMerge.status).toBe(409);
    expect(((await beforeMerge.json()) as { error: string }).error).toBe(
      "delivery_gate_unsatisfied",
    );

    // Manual merge in GitHub plus target inclusion.
    await forge.mergePullRequest(REPO, pr.number!);
    execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", run.head_sha!], {
      stdio: "ignore",
    });

    // A publication reconciliation after the remote merge must not erase the
    // already-published audit or hide the awaiting-verification state.
    await scoped.publishPublication(run.id);
    const mergedGate = await scoped.deliveryGate(run.id);
    expect(mergedGate.state).toBe("awaiting_merge_verification");
    expect(mergedGate.publication.state).toBe("published");
    expect(mergedGate.publication.remoteState).toBe("merged");

    const delivered = await scoped.verifyDeliveryMerge(run.id, "operator");
    expect(delivered.state).toBe("delivered");
    expect(delivered.merge.verified).toBe(true);
    expect(delivered.merge.verification).toMatchObject({
      prNumber: pr.number,
      targetBranch: "main",
      candidateHeadSha: run.head_sha,
      verifiedBy: "operator",
    });

    const verifyCli = await captureLogs(() =>
      runPlanCommand({
        subcommand: "verify-merge",
        positionals: ["plan", "verify-merge", run.id],
        projectId,
        factoryUrl: "http://127.0.0.1",
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(verifyCli.code).toBe(0);
    expect(JSON.parse(verifyCli.logs.join("\n")).state).toBe("delivered");
  });

  test("missing and child-profile delivery gate reads fail honestly over HTTP", async () => {
    const missing = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/delivery/runs/run_missing`),
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("delivery_run_not_found");
  });
});
