import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";
import {
  InstallationHeldError,
  InstallationHoldUnavailableError,
  assertInstallationNotHeldAtStateDir,
} from "@animus/contracts/installation-hold";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import type { MonitorRuntime } from "../../apps/backend/src/monitor/runtime";
import { DeliveryRuntimeCoordinator } from "../../apps/backend/src/delivery/runtime";
import { runAnimusLoop } from "../../scripts/animus-loop";
import { runLoopCliCommand } from "../../scripts/cli/commands/loop";
import { launchNativeLap } from "../../apps/engine-host/src/native";

const REPO = "owner/launch-hold";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;
const ORIGINAL_ANIMUS_STATE_DIR = process.env.ANIMUS_STATE_DIR;
const ORIGINAL_FACTORY_STATE_DIR = process.env.FACTORY_STATE_DIR;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function issueBody(): string {
  return [
    "## Source and problem",
    "Held launch probe.",
    "## Outcome",
    "No builder may spawn.",
    "## Invariants",
    "- Fail closed.",
    "## Acceptance criteria",
    "- [ ] AC1: held.",
    "## Boundary",
    "Probe.",
    "Depends on: None",
  ].join("\n");
}

function createCheckout(root: string): string {
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "user.email", "test@example.com");
  writeFileSync(join(checkout, "README.md"), "# launch hold\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-q", "-m", "base");
  git(checkout, "remote", "add", "origin", `https://github.com/${REPO}.git`);
  return checkout;
}

function holdDatabase(stateDir: string, now = Date.now()): void {
  mkdirSync(stateDir, { recursive: true });
  const db = initializeDatabase(join(stateDir, "console.db"));
  try {
    db.prepare(
      `INSERT INTO installation_holds
         (id, status, reason, source_restore_id, restored_at, reconciled_at, reconciled_by, reconciliation_report)
       VALUES ('installation', 'held', 'restored installation pending reconciliation', 'restore_probe', ?, NULL, NULL, NULL)`,
    ).run(now);
  } finally {
    db.close();
  }
}

describe("native launch wrappers are fenced by the real installation hold", () => {
  let root: string;
  let home: string;
  let stateDir: string;
  let checkout: string;
  let app: BackendApp | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "animus-launch-hold-"));
    home = join(root, "home");
    stateDir = join(home, "state");
    delete process.env.ANIMUS_STATE_DIR;
    delete process.env.FACTORY_STATE_DIR;
    process.env.ANIMUS_HOME = home;
    writeExecutionAuthority("local");
    checkout = createCheckout(root);
    holdDatabase(stateDir);
  });

  afterEach(async () => {
    if (app) {
      try {
        await app.stop();
      } catch {}
      app = null;
    }
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    if (ORIGINAL_ANIMUS_STATE_DIR === undefined) delete process.env.ANIMUS_STATE_DIR;
    else process.env.ANIMUS_STATE_DIR = ORIGINAL_ANIMUS_STATE_DIR;
    if (ORIGINAL_FACTORY_STATE_DIR === undefined) delete process.env.FACTORY_STATE_DIR;
    else process.env.FACTORY_STATE_DIR = ORIGINAL_FACTORY_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("runAnimusLoop rejects a held installation before any worktree or transport work", async () => {
    const projectStateRoot = join(root, "project-worktree-state");
    let transportCalls = 0;
    await expect(
      runAnimusLoop(
        checkout,
        {
          number: 1,
          title: "Held launch",
          body: issueBody(),
          labels: ["ready-for-agent"],
          state: "OPEN",
        } as never,
        {
          stateRoot: projectStateRoot,
          transport: async () => {
            transportCalls += 1;
            throw new Error("builder transport must not run while held");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "installation_held" });
    expect(transportCalls).toBe(0);
    // The project worktree state root has no console.db and is never used for the
    // hold check; nothing may be allocated before the gate rejects.
    expect(existsSync(projectStateRoot)).toBe(false);
  }, 20000);

  test("the CLI loop wrapper refuses before forge access while held", async () => {
    const code = await runLoopCliCommand({
      subcommand: "run",
      positionals: ["loop", "run"],
      repoRoot: checkout,
      issue: "1",
      json: true,
    });
    expect(code).toBe(1);
  }, 20000);

  test("an explicit installationStateDir is honored over the environment", async () => {
    const cleanHome = join(root, "clean-home");
    process.env.ANIMUS_HOME = cleanHome;
    const explicitHeld = join(root, "explicit-held");
    holdDatabase(explicitHeld);
    let transportCalls = 0;
    await expect(
      runAnimusLoop(
        checkout,
        {
          number: 1,
          title: "Explicit held",
          body: issueBody(),
          labels: ["ready-for-agent"],
          state: "OPEN",
        } as never,
        {
          installationStateDir: explicitHeld,
          transport: async () => {
            transportCalls += 1;
            throw new Error("builder transport must not run");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "installation_held" });
    expect(transportCalls).toBe(0);

    // Divergence: the env home is clean, so only the explicit held dir rejects.
    process.env.ANIMUS_HOME = home;
    const explicitClean = join(root, "explicit-clean");
    mkdirSync(explicitClean, { recursive: true });
    expect(() => assertInstallationNotHeldAtStateDir()).toThrow(InstallationHeldError);
    expect(() => assertInstallationNotHeldAtStateDir(explicitClean)).not.toThrow();
  }, 20000);

  test("a missing installation database is allowed but an unreadable one fails closed", async () => {
    const brandNewHome = join(root, "brand-new-home");
    process.env.ANIMUS_HOME = brandNewHome;
    expect(() => assertInstallationNotHeldAtStateDir()).not.toThrow();

    const corruptHome = join(root, "corrupt-home");
    const corruptState = join(corruptHome, "state");
    mkdirSync(corruptState, { recursive: true });
    writeFileSync(join(corruptState, "console.db"), "not a sqlite database");
    process.env.ANIMUS_HOME = corruptHome;
    expect(() => assertInstallationNotHeldAtStateDir()).toThrow(InstallationHoldUnavailableError);

    let transportCalls = 0;
    await expect(
      runAnimusLoop(
        checkout,
        {
          number: 1,
          title: "Corrupt state",
          body: issueBody(),
          labels: ["ready-for-agent"],
          state: "OPEN",
        } as never,
        {
          transport: async () => {
            transportCalls += 1;
            throw new Error("builder transport must not run");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "installation_hold_unavailable" });
    expect(transportCalls).toBe(0);
  }, 20000);

  test("the registered project monitor never schedules or launches while held", async () => {
    const calls = {
      setup: 0,
      inspect: 0,
      schedule: 0,
      launch: 0,
      fetchBacklog: 0,
      readContract: 0,
    };
    const runtime: MonitorRuntime = {
      inspect: async () => {
        calls.inspect += 1;
        return { common: checkout, primary: checkout };
      },
      setup: () => {
        calls.setup += 1;
      },
      interval: () => 1000,
      schedule: async () => {
        calls.schedule += 1;
        return { action: "skipped", reason: "probe", activeLapsCount: 0 };
      },
      fetchBacklog: async () => {
        calls.fetchBacklog += 1;
        return { issues: [], closedNumbers: new Set<number>() };
      },
      readContract: async () => {
        calls.readContract += 1;
        throw new Error("monitor must not read a contract while held");
      },
      launch: async () => {
        calls.launch += 1;
        return { runId: "probe", status: "failed" };
      },
      hasCapacityFull: () => false,
      checkWorkWindow: () => true,
    };
    const forge = new SyntheticForgeAdapter({ [REPO]: 733 });
    app = await createBackendApp({
      stateDir,
      startMonitor: false,
      forge,
      monitorRuntime: runtime,
    });
    const registry = new ProjectRegistryService(app.db, forge);
    await registry.registerProject({
      method: "local_checkout",
      name: "Launch hold product",
      checkout_path: checkout,
    });

    await app.monitor.tick();
    await app.monitor.drain();

    expect(calls.setup).toBe(0);
    expect(calls.inspect).toBe(0);
    expect(calls.schedule).toBe(0);
    expect(calls.launch).toBe(0);
    expect(calls.fetchBacklog).toBe(0);
    expect(calls.readContract).toBe(0);
    expect(app.monitor.status().projects[0]?.state).toBe("held");
  }, 30000);

  test("the delivery runtime cannot start reviewer/QA work or evidence while held", async () => {
    const db = new DatabaseSync(join(stateDir, "console.db"));
    try {
      let executorCalls = 0;
      let dispatchCalls = 0;
      let publicationCalls = 0;
      const coordinator = new DeliveryRuntimeCoordinator(db, {
        gate: {
          getGate: async () => {
            throw new Error("gate must not be read while held");
          },
        } as never,
        observations: {} as never,
        dispatch: {
          dispatch: async () => {
            dispatchCalls += 1;
            throw new Error("dispatch must not run while held");
          },
        } as never,
        budget: {} as never,
        publication: {
          getStatusByRun: () => {
            publicationCalls += 1;
            throw new Error("publication must not run while held");
          },
        } as never,
        executor: async () => {
          executorCalls += 1;
          throw new Error("role executor must not run while held");
        },
      });
      await expect(coordinator.process("project_probe", "run_probe")).rejects.toMatchObject({
        code: "installation_held",
      });
      expect(executorCalls).toBe(0);
      expect(dispatchCalls).toBe(0);
      expect(publicationCalls).toBe(0);
    } finally {
      db.close();
    }
  }, 20000);

  test("the engine host native launcher refuses before spawning the cached workflow", () => {
    expect(() => launchNativeLap(checkout, "held specification")).toThrow(/installation_held/);
  }, 20000);
});
