import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedActivatedAuthorityAt } from "./support/activated-authority";
import {
  InstallationHeldError,
  InstallationHoldUnavailableError,
  assertInstallationNotHeldAtStateDir,
} from "@animus/contracts/installation-hold";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { DeliveryRuntimeCoordinator } from "../../apps/backend/src/delivery/runtime";
import { runSchedulerCliCommand } from "../../scripts/cli/commands/loop";
import { launchNativeLap } from "../../apps/engine-host/src/native";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";

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

function reconcileHoldDatabase(stateDir: string, now = Date.now()): void {
  const db = initializeDatabase(join(stateDir, "console.db"));
  try {
    db.prepare(
      "UPDATE installation_holds SET status = 'reconciled', reconciled_at = ?, reconciled_by = 'test' WHERE id = 'installation'",
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "animus-launch-hold-"));
    home = join(root, "home");
    stateDir = join(home, "state");
    delete process.env.ANIMUS_STATE_DIR;
    delete process.env.FACTORY_STATE_DIR;
    process.env.ANIMUS_HOME = home;
    seedActivatedAuthorityAt(stateDir);
    checkout = createCheckout(root);
    holdDatabase(stateDir);
  });

  afterEach(() => {
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    if (ORIGINAL_ANIMUS_STATE_DIR === undefined) delete process.env.ANIMUS_STATE_DIR;
    else process.env.ANIMUS_STATE_DIR = ORIGINAL_ANIMUS_STATE_DIR;
    if (ORIGINAL_FACTORY_STATE_DIR === undefined) delete process.env.FACTORY_STATE_DIR;
    else process.env.FACTORY_STATE_DIR = ORIGINAL_FACTORY_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("the removed legacy launcher fails closed and the hold gate blocks first", async () => {
    const originalError = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      // A held installation refuses before the launcher resolves any work.
      expect(await runSchedulerCliCommand({ repoRoot: checkout, once: true })).toBe(1);
      expect(messages.join("\n")).toContain("installation_held");

      // Without the hold the removed legacy path still refuses to start a lap.
      messages.length = 0;
      reconcileHoldDatabase(stateDir);
      writeExecutionAuthority("legacy", { stateDir });
      expect(await runSchedulerCliCommand({ repoRoot: checkout, once: true })).toBe(1);
      expect(messages.join("\n")).toContain("legacy_launcher_removed");
      expect(messages.join("\n")).not.toContain("installation_held");
    } finally {
      console.error = originalError;
    }
  }, 20000);

  test("an explicit installationStateDir is honored over the environment", () => {
    const explicitHeld = join(root, "explicit-held");
    holdDatabase(explicitHeld);
    process.env.ANIMUS_HOME = home;
    const explicitClean = join(root, "explicit-clean");
    mkdirSync(explicitClean, { recursive: true });
    expect(() => assertInstallationNotHeldAtStateDir()).toThrow(InstallationHeldError);
    expect(() => assertInstallationNotHeldAtStateDir(explicitHeld)).toThrow(InstallationHeldError);
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

    // The surviving launcher fails closed on the unreadable hold instead of launching.
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
    try {
      expect(await runSchedulerCliCommand({ repoRoot: checkout, once: true })).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(messages.join("\n")).toContain("installation_hold_unavailable");
  }, 20000);

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
