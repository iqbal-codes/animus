import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedActivatedAuthorityAt } from "./support/activated-authority";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { SpecCoordinatorService } from "../../apps/backend/src/coordination";
import { ChildIntegrationService } from "../../apps/backend/src/integration";
import {
  InstallationHeldError,
  assertInstallationNotHeldAtStateDir,
} from "@animus/contracts/installation-hold";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";

const REPO = "owner/hold-gates";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ticketBody(dependsOn = "None"): string {
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
    `Depends on: ${dependsOn}`,
  ].join("\n");
}

function hold(db: DatabaseSync, now = Date.now()): void {
  db.prepare(
    `INSERT INTO installation_holds
       (id, status, reason, source_restore_id, restored_at, reconciled_at, reconciled_by, reconciliation_report)
     VALUES ('installation', 'held', 'restored installation pending reconciliation', 'restore_test', ?, NULL, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       status = 'held', reason = excluded.reason,
       source_restore_id = excluded.source_restore_id, restored_at = excluded.restored_at,
       reconciled_at = NULL, reconciled_by = NULL, reconciliation_report = NULL`,
  ).run(now);
}

class CountingForge extends SyntheticForgeAdapter {
  creates = 0;
  merges = 0;
  pullRequests = 0;

  async createIssue(
    ...args: Parameters<SyntheticForgeAdapter["createIssue"]>
  ): ReturnType<SyntheticForgeAdapter["createIssue"]> {
    this.creates += 1;
    return super.createIssue(...args);
  }

  async createPullRequest(
    ...args: Parameters<SyntheticForgeAdapter["createPullRequest"]>
  ): ReturnType<SyntheticForgeAdapter["createPullRequest"]> {
    this.pullRequests += 1;
    return super.createPullRequest(...args);
  }

  async mergePullRequest(
    ...args: Parameters<SyntheticForgeAdapter["mergePullRequest"]>
  ): ReturnType<SyntheticForgeAdapter["mergePullRequest"]> {
    this.merges += 1;
    return super.mergePullRequest(...args);
  }
}

describe("restored installation hold fences every outward writer", () => {
  let root: string;
  let home: string;
  let stateDir: string;
  let db: DatabaseSync;
  let app: BackendApp;
  let forge: CountingForge;
  let registry: ProjectRegistryService;
  let projectId: string;
  let checkout: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-hold-gates-"));
    home = join(root, "home");
    stateDir = join(home, "state");
    process.env.ANIMUS_HOME = home;
    seedActivatedAuthorityAt(stateDir);
    checkout = join(root, "checkout");
    mkdirSync(checkout, { recursive: true });
    git(checkout, "init", "-q", "-b", "main");
    git(checkout, "config", "user.name", "Test");
    git(checkout, "config", "user.email", "test@example.com");
    writeFileSync(join(checkout, "README.md"), "# hold gates\n");
    git(checkout, "add", "README.md");
    git(checkout, "commit", "-q", "-m", "base");
    git(checkout, "remote", "add", "origin", `https://github.com/${REPO}.git`);

    forge = new CountingForge({ [REPO]: 301 });
    forge.addIssue(REPO, {
      number: 501,
      title: "Standalone request",
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: 502,
      title: "Spec request",
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: 503,
      title: "Child request",
      body: ticketBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });

    app = await createBackendApp({
      stateDir,
      startMonitor: false,
      forge,
      dispatch: { processAlive: () => true, ownerPid: () => 4242 },
    });
    db = app.db;
    registry = new ProjectRegistryService(db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Hold product",
      checkout_path: checkout,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    try {
      await app.stop();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("B1: a held installation performs zero draft/issue publication effects", async () => {
    hold(db);
    await expect(app.draftPublication.publish(projectId, "pub_missing")).rejects.toMatchObject({
      code: "draft_publication_installation_held",
    });
    await expect(
      app.draftPublication.publishDraft(projectId, "draft_missing"),
    ).rejects.toMatchObject({ code: "draft_publication_installation_held" });
    await expect(app.draftPublication.reconcileAll(projectId)).rejects.toMatchObject({
      code: "draft_publication_installation_held",
    });
    expect(forge.creates).toBe(0);
  }, 20000);

  test("B2: a held installation refuses coordination dispatch and final PR creation", async () => {
    const coordinator = new SpecCoordinatorService(db, forge, { ledger: new CommandLedger(db) });
    hold(db);

    let runnerCalls = 0;
    await expect(
      coordinator.dispatchChild({
        projectId,
        specIssueNumber: 502,
        childIssueNumber: 503,
        runner: async () => {
          runnerCalls += 1;
          return {
            success: true,
            childIssueNumber: 503,
            headSha: git(checkout, "rev-parse", "HEAD"),
            branch: "factory/spec-502/ticket-503",
            worktreePath: join(root, "worktrees", "spec-502", "ticket-503"),
          } as never;
        },
      }),
    ).rejects.toMatchObject({ code: "coordination_installation_held" });
    expect(runnerCalls).toBe(0);

    await expect(
      coordinator.createFinalPullRequest({ projectId, specIssueNumber: 501 }),
    ).rejects.toMatchObject({ code: "coordination_installation_held" });
    expect(forge.pullRequests).toBe(0);
  }, 20000);

  test("B2: a held installation never auto-merges a child integration", async () => {
    const integration = new ChildIntegrationService(db, {
      observations: app.publication as never,
      publication: app.publication,
      forge,
    } as never);
    hold(db);
    await expect(integration.land(projectId, "run_missing")).rejects.toMatchObject({
      code: "integration_installation_held",
    });
    expect(forge.merges).toBe(0);
  }, 20000);

  test("B2: a held installation refuses publication PR control paths", async () => {
    hold(db);
    await expect(app.publication.publish(projectId, "missing_target")).rejects.toMatchObject({
      code: "publication_installation_held",
    });
    await expect(app.publication.reconcileAll(projectId)).rejects.toMatchObject({
      code: "publication_installation_held",
    });
  }, 20000);

  test("B2: legacy CLI, native launch and scheduler launchers fail closed while held", async () => {
    const { runLoopCliCommand } = await import("../../scripts/cli/commands/loop");
    const { runAnimusLoop } = await import("../../scripts/animus-loop");
    hold(db);

    expect(() => assertInstallationNotHeldAtStateDir()).toThrow(InstallationHeldError);

    const code = await runLoopCliCommand({
      subcommand: "run",
      positionals: ["loop", "run"],
      repoRoot: checkout,
      issue: "501",
      json: true,
    });
    expect(code).toBe(1);

    await expect(
      runAnimusLoop(
        checkout,
        {
          number: 501,
          title: "Blocked child",
          body: ticketBody(),
          labels: ["ready-for-agent"],
          state: "OPEN",
        } as never,
        { stateRoot: stateDir },
      ),
    ).rejects.toMatchObject({ code: "installation_held" });
  }, 20000);

  test("B4: the hold read-only path tolerates a pre-v11 database without a hold table", () => {
    const dir = join(root, "legacy-state");
    mkdirSync(dir, { recursive: true });
    const legacy = new DatabaseSync(join(dir, "console.db"));
    legacy.exec("CREATE TABLE projects (id TEXT PRIMARY KEY)");
    legacy.close();
    expect(() => assertInstallationNotHeldAtStateDir(dir)).not.toThrow();
  });
});
