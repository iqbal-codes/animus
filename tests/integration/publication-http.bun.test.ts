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

const REPO = "owner/publication-http";

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

describe("publication audit through backend HTTP, client and CLI", () => {
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
    root = mkdtempSync(join(tmpdir(), "animus-publication-http-"));
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

    forge = new SyntheticForgeAdapter(
      { [REPO]: 915 },
      {
        requireRemoteSourceRef: true,
        resolveHeadRefOid: (_repo, branch) => remoteHead(branch),
      },
    );
    forge.addIssue(REPO, {
      number: 900,
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

  test("operators can audit, publish and recover through HTTP, client and CLI", async () => {
    const plan = await importPlan(900);
    const client = createFactoryClient({ baseUrl: "http://127.0.0.1", fetch: backendFetch(app) });
    const scoped = client.forProject(projectId);
    const run = await scoped.dispatchPlan({ plan_id: plan.id, actor: "operator" });
    expect(run.state).toBe("succeeded");

    const before = await scoped.publication(run.id);
    expect(before.pullRequests).toHaveLength(0);
    expect(before.queuedEventCount).toBe(1);
    expect(before.auditComplete).toBe(false);

    const published = await scoped.publishPublication(run.id);
    expect(published.pullRequests).toHaveLength(1);
    expect(published.auditComplete).toBe(true);
    expect(published.target.state).toBe("published");
    expect(await forge.getPullRequest(REPO, published.pullRequests[0]!.number!)).toMatchObject({
      head: run.branch,
      base: "main",
      state: "OPEN",
      draft: true,
    });

    const cli = await captureLogs(() =>
      runPlanCommand({
        subcommand: "publication",
        positionals: ["plan", "publication", run.id],
        projectId,
        factoryUrl: "http://127.0.0.1",
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(cli.code).toBe(0);
    const printed = JSON.parse(cli.logs.join("\n"));
    expect(printed.auditComplete).toBe(true);
    expect(printed.target.issueNumber).toBe(900);

    const publishCli = await captureLogs(() =>
      runPlanCommand({
        subcommand: "publish",
        positionals: ["plan", "publish", run.id],
        projectId,
        factoryUrl: "http://127.0.0.1",
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(publishCli.code).toBe(0);

    const targets = await scoped.publicationTargets({ workId: run.work_id });
    expect(targets).toHaveLength(1);
  });

  test("publication readers and recovery expose honest errors over HTTP", async () => {
    const plan = await importPlan(900);
    const client = createFactoryClient({ baseUrl: "http://127.0.0.1", fetch: backendFetch(app) });
    const scoped = client.forProject(projectId);
    const run = await scoped.dispatchPlan({ plan_id: plan.id, actor: "operator" });
    await scoped.publishPublication(run.id);
    const status = await scoped.publication(run.id);
    const targetId = status.target.id;

    const missing = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/publication/targets/pub_missing`),
    );
    expect(missing.status).toBe(404);

    const missingRun = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/publication/runs/run_missing`),
    );
    expect(missingRun.status).toBe(404);

    const invalidUrl = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/publication/targets/${targetId}/evidence/artifact_missing/bind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hosted_url: "http://localhost/private.png" }),
        },
      ),
    );
    expect(invalidUrl.status).toBe(400);

    const invalidSchema = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/publication/targets/${targetId}/evidence/artifact_missing/bind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hosted_url: "https://example.com/a.png", producer: { id: "x" } }),
        },
      ),
    );
    expect(invalidSchema.status).toBe(400);

    const unknownArtifact = await app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${projectId}/publication/targets/${targetId}/evidence/artifact_missing/bind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hosted_url: "https://github.com/user-attachments/assets/a.png",
          }),
        },
      ),
    );
    expect(unknownArtifact.status).toBe(404);
  });
});
