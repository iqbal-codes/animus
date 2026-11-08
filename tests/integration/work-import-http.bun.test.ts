import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@animus/client";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { runWorkCommand } from "../../scripts/cli/commands/operations";

const REPO = "owner/repo";

describe("work import through backend, client and CLI readers", () => {
  let root: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
  let projectId: string;

  async function startApp(): Promise<BackendApp> {
    return await createBackendApp({
      stateDir: join(root, "state"),
      startMonitor: false,
      forge,
    });
  }

  function backendFetch(application: BackendApp) {
    return async (input: string, init?: RequestInit) => application.fetch(new Request(input, init));
  }

  async function readWorkList(application: BackendApp, id = projectId) {
    const response = await application.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${id}/work`),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Array<{
      id: string;
      issue_number: number;
      revision: { content_hash: string; source: { title: string; body: string } };
    }>;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-work-http-"));
    const checkout = join(root, "checkout");
    mkdirSync(checkout, { recursive: true });
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      `https://github.com/${REPO}.git`,
    ]);
    forge = new SyntheticForgeAdapter({ [REPO]: 777 });
    forge.addIssue(REPO, {
      number: 21,
      title: "Original request",
      body: "Original body",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [{ id: "c1", author: "reporter", body: "Original comment" }],
    });
    app = await startApp();
    const registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkout,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1: HTTP intake, work detail, client and CLI expose source, identity and immutable revision", async () => {
    const intakeResponse = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/intake?refresh=true`),
    );
    expect(intakeResponse.status).toBe(200);
    const intake = (await intakeResponse.json()) as {
      issues: Array<{
        number: number;
        work: {
          id: string;
          revision: { id: string; content_hash: string; source: { body: string } };
        };
      }>;
    };
    const imported = intake.issues.find((issue) => issue.number === 21)?.work;
    expect(imported).toBeDefined();
    expect(imported!.revision.source.body).toBe("Original body");

    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: backendFetch(app),
    });
    const list = await client.forProject(projectId).work();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(imported!.id);
    const detail = await client.forProject(projectId).workItem(imported!.id);
    expect(detail.revision.source).toMatchObject({
      title: "Original request",
      body: "Original body",
      comments: [{ id: "c1", author: "reporter", body: "Original comment" }],
    });
    expect(detail.revision.provenance.source_url).toBe(`https://github.com/${REPO}/issues/21`);

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      expect(
        await runWorkCommand({
          subcommand: "list",
          positionals: ["work", "list"],
          projectId,
          factoryUrl: "http://127.0.0.1",
          fetch: backendFetch(app),
          json: true,
        }),
      ).toBe(0);
      expect(JSON.parse(logs[0]!)[0].id).toBe(imported!.id);
      logs.length = 0;
      expect(
        await runWorkCommand({
          subcommand: "get",
          positionals: ["work", "get", imported!.id],
          projectId,
          factoryUrl: "http://127.0.0.1",
          fetch: backendFetch(app),
          json: true,
        }),
      ).toBe(0);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        id: imported!.id,
        revision: { source: { body: "Original body" } },
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("AC2: post-import edits and closure preserve the accepted snapshot and allocate no execution", async () => {
    await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/intake?refresh=true`),
    );
    const [accepted] = await readWorkList(app);

    forge.addIssue(REPO, {
      number: 21,
      title: "Rewritten",
      body: "Rewritten body",
      state: "OPEN",
      labels: [{ name: "needs-info" }],
      comments: [],
    });
    await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/intake?refresh=true`),
    );
    const [afterEdit] = await readWorkList(app);
    expect(afterEdit!.id).toBe(accepted!.id);
    expect(afterEdit!.revision.content_hash).toBe(accepted!.revision.content_hash);
    expect(afterEdit!.revision.source.body).toBe("Original body");

    forge.addIssue(REPO, {
      number: 21,
      title: "Rewritten",
      body: "Rewritten body",
      state: "CLOSED",
      labels: [],
      comments: [],
    });
    const closedIntake = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/intake?refresh=true`),
    );
    expect(((await closedIntake.json()) as { issues: unknown[] }).issues).toEqual([]);
    const [afterClosure] = await readWorkList(app);
    expect(afterClosure!.id).toBe(accepted!.id);
    expect(
      app.db.prepare("SELECT COUNT(*) AS count FROM project_runs").get() as { count: number },
    ).toEqual({ count: 0 });
  });

  test("AC2/AC5: concurrent cross-process imports converge on one identity", async () => {
    const script = [
      'import { initializeDatabase } from "./apps/backend/src/registry/db.ts";',
      'import { WorkService } from "./apps/backend/src/work/index.ts";',
      "const db = initializeDatabase(process.env.TEST_DB);",
      "const service = new WorkService(db);",
      "const record = service.importIssue(",
      "  { id: process.env.TEST_PROJECT, repo_id: Number(process.env.TEST_REPO_ID), repo_name: process.env.TEST_REPO_NAME },",
      '  { number: Number(process.env.TEST_ISSUE), title: "Concurrent", body: process.env.TEST_BODY, state: "OPEN", labels: [], comments: [] },',
      ");",
      "console.log(JSON.stringify({ id: record.id, revision: record.revision.id, body: record.revision.source.body }));",
      "db.close();",
    ].join("\n");
    const spawn = (body: string) =>
      Bun.spawn([process.execPath, "-e", script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_DB: join(root, "state", "console.db"),
          TEST_PROJECT: projectId,
          TEST_REPO_ID: "777",
          TEST_REPO_NAME: REPO,
          TEST_ISSUE: "22",
          TEST_BODY: body,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const children = [spawn("concurrent one"), spawn("concurrent two")];
    const outputs = await Promise.all(
      children.map(async (child) => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, code };
      }),
    );
    for (const output of outputs) {
      expect(output.code).toBe(0);
      expect(output.stderr).toBe("");
    }
    const results = outputs.map(
      (output) =>
        JSON.parse(output.stdout.trim().split("\n").at(-1)!) as {
          id: string;
          revision: string;
          body: string;
        },
    );
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(results[0]!.revision).toBe(results[1]!.revision);
    expect(["concurrent one", "concurrent two"]).toContain(results[0]!.body);
    expect(
      app.db.prepare("SELECT COUNT(*) AS count FROM work_items").get() as { count: number },
    ).toEqual({ count: 1 });
    expect(
      app.db.prepare("SELECT COUNT(*) AS count FROM work_revisions").get() as { count: number },
    ).toEqual({ count: 1 });
  });

  test("AC3/AC5: unavailable forge transport is reported honestly and persists nothing", async () => {
    forge.listIssues = async () => {
      throw new Error("offline");
    };
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/intake?refresh=true`),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "intake_unavailable" });
    expect(await readWorkList(app)).toEqual([]);
  });

  test("AC5: work identity and original source survive backend restart", async () => {
    await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/intake?refresh=true`),
    );
    const [accepted] = await readWorkList(app);

    await app.stop();
    app = await startApp();
    const [restored] = await readWorkList(app);
    expect(restored!.id).toBe(accepted!.id);
    expect(restored!.revision.content_hash).toBe(accepted!.revision.content_hash);
    expect(restored!.revision.source.body).toBe("Original body");
  });
});
