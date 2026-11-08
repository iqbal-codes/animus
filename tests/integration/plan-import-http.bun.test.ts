import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@animus/client";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { runPlanCommand } from "../../scripts/cli/commands/operations";

const REPO = "owner/repo";

function ticketBody(
  options: {
    partOf?: number | null;
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

describe("prepared plan admission through backend, client and CLI", () => {
  let root: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
  let projectId: string;
  let checkoutPath: string;

  function backendFetch(application: BackendApp) {
    return async (input: string, init?: RequestInit) => application.fetch(new Request(input, init));
  }

  async function importIssues() {
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/intake?refresh=true`),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      issues: Array<{ number: number; work?: { id: string } }>;
    };
  }

  function workId(intake: Awaited<ReturnType<typeof importIssues>>, issueNumber: number): string {
    const found = intake.issues.find((issue) => issue.number === issueNumber)?.work;
    if (!found) throw new Error(`missing work for #${issueNumber}`);
    return found.id;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-plan-http-"));
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

    forge = new SyntheticForgeAdapter({ [REPO]: 909 });
    forge.addIssue(REPO, {
      number: 100,
      title: "Spec 100",
      body: specBody(["parent first", "parent second"]),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: 101,
      title: "Child 101",
      body: ticketBody({ partOf: 100, coverage: "AC1" }),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: 102,
      title: "Child 102",
      body: ticketBody({ partOf: 100, coverage: "AC2", dependsOn: [101] }),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: 300,
      title: "Empty spec without children",
      body: specBody(["orphan criterion"]),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });

    app = await createBackendApp({
      stateDir: join(root, "state"),
      startMonitor: false,
      forge,
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
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1/AC2/AC4: HTTP, client and CLI expose the frozen plan, accepted revision and decisions", async () => {
    const intake = await importIssues();
    const rootWorkId = workId(intake, 100);

    const importResponse = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/plans/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_id: rootWorkId, kind: "spec" }),
      }),
    );
    expect(importResponse.status).toBe(200);
    const imported = (await importResponse.json()) as {
      id: string;
      authority: string;
      dispatchable: boolean;
      graph_hash: string;
      accepted_revision: { revision_id: string; content_hash: string } | null;
      members: Array<{ issue_number: number; role: string }>;
      manifest: { graph_hash: string } | null;
      decisions: Array<{ action: string; outcome: string }>;
    };
    expect(imported.authority).toBe("admitted");
    expect(imported.dispatchable).toBe(true);
    expect(
      imported.members.map((member) => member.issue_number).sort((left, right) => left - right),
    ).toEqual([100, 101, 102]);
    expect(imported.accepted_revision?.revision_id).toMatch(/^wrev_/);
    expect(imported.manifest?.graph_hash).toBe(imported.graph_hash);
    expect(imported.decisions).toHaveLength(1);
    expect(imported.decisions[0]).toMatchObject({ action: "import", outcome: "admitted" });

    const listResponse = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/plans`),
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as Array<{
      id: string;
      authority: string;
      ticket_count: number;
    }>;
    const summary = listed.find((item) => item.id === imported.id);
    expect(summary).toMatchObject({ authority: "admitted", ticket_count: 2 });

    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: backendFetch(app),
    });
    const scoped = client.forProject(projectId);
    const clientPlans = await scoped.plans();
    expect(clientPlans.map((plan) => plan.id)).toContain(imported.id);
    const clientPlan = await scoped.plan(imported.id);
    expect(clientPlan.graph_hash).toBe(imported.graph_hash);
    expect(clientPlan.accepted_revision?.revision_id).toBe(imported.accepted_revision?.revision_id);

    const jsonList = await captureLogs(() =>
      runPlanCommand({
        subcommand: "list",
        positionals: [],
        projectId,
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(jsonList.code).toBe(0);
    const parsedList = JSON.parse(jsonList.logs.join("\n")) as Array<{
      id: string;
      authority: string;
    }>;
    expect(parsedList.find((item) => item.id === imported.id)?.authority).toBe("admitted");

    const humanGet = await captureLogs(() =>
      runPlanCommand({
        subcommand: "get",
        positionals: ["plan", "get", imported.id],
        projectId,
        fetch: backendFetch(app),
      }),
    );
    expect(humanGet.code).toBe(0);
    const output = humanGet.logs.join("\n");
    expect(output).toContain(`Plan ${imported.id} (spec)`);
    expect(output).toContain("Authority:  admitted");
    expect(output).toContain(`Accepted:   ${imported.accepted_revision!.revision_id}`);
    expect(output).toContain("Holds:      none");

    const humanImport = await captureLogs(() =>
      runPlanCommand({
        subcommand: "import",
        positionals: [],
        issue: "100",
        kind: "spec",
        projectId,
        fetch: backendFetch(app),
        json: true,
      }),
    );
    expect(humanImport.code).toBe(0);
    expect(JSON.parse(humanImport.logs.join("\n")).id).toBe(imported.id);

    const approved = await scoped.approvePlan(imported.id, { actor: "operator" });
    expect(approved.decisions).toHaveLength(1);
    const revoked = await scoped.revokePlan(imported.id, {
      actor: "operator",
      reason: "withdrawn",
    });
    expect(revoked.authority).toBe("revoked");
    expect(revoked.dispatchable).toBe(false);
    expect(revoked.decisions.map((decision) => decision.action)).toEqual(["import", "revoke"]);
    expect(revoked.decisions.at(-1)?.reason).toBe("withdrawn");
  });

  test("AC3/AC5: HTTP and CLI expose precise holds for an incomplete spec", async () => {
    const intake = await importIssues();
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/plans/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_id: workId(intake, 300), kind: "spec" }),
      }),
    );
    expect(response.status).toBe(200);
    const held = (await response.json()) as {
      id: string;
      authority: string;
      dispatchable: boolean;
      manifest: null;
      accepted_revision: null;
      holds: Array<{ code: string; severity: string; detail: string }>;
    };
    expect(held.authority).toBe("held");
    expect(held.dispatchable).toBe(false);
    expect(held.manifest).toBeNull();
    expect(held.accepted_revision).toBeNull();
    const hold = held.holds.find((item) => item.code === "incomplete_child_discovery");
    expect(hold).toMatchObject({ severity: "blocking" });
    expect(hold?.detail).toContain("never executed as standalone");

    const human = await captureLogs(() =>
      runPlanCommand({
        subcommand: "get",
        positionals: ["plan", "get", held.id],
        projectId,
        fetch: backendFetch(app),
      }),
    );
    expect(human.code).toBe(0);
    const output = human.logs.join("\n");
    expect(output).toContain("Authority:  held");
    expect(output).toContain("Accepted:   none");
    expect(output).toContain("incomplete_child_discovery");

    const rejected = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/plans/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_id: workId(intake, 300) }),
      }),
    );
    expect(rejected.status).toBe(400);
  });
});
