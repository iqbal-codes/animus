import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { BackupRestoreService } from "../../apps/backend/src/restore/service";
import { AuthorityCutoverService } from "../../apps/backend/src/cutover/service";
import {
  inventoryInstallation,
  resolveLegacyStateRoots,
} from "../../apps/backend/src/cutover/inventory";
import { readExecutionAuthority } from "@animus/contracts/execution-authority";
import { resolveProjectWorkspace } from "@animus/contracts/paths";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;
const ORIGINAL_ANIMUS_STATE_DIR = process.env.ANIMUS_STATE_DIR;

function waitFor(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      if (existsSync(path)) return resolvePromise();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("authority cutover filesystem legacy state (#165 B1)", () => {
  let root: string;
  let home: string;
  let stateDir: string;
  let checkout: string;
  let db: ReturnType<typeof initializeDatabase>;
  let backup: BackupRestoreService;
  let cutover: AuthorityCutoverService;
  let workspace: ReturnType<typeof resolveProjectWorkspace>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "animus-authority-fs-"));
    home = join(root, "home");
    stateDir = join(home, "state");
    checkout = join(root, "checkout");
    mkdirSync(checkout, { recursive: true });
    process.env.ANIMUS_HOME = home;
    process.env.ANIMUS_STATE_DIR = stateDir;
    db = initializeDatabase(join(stateDir, "console.db"));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, name, repo_id, repo_name, checkout_path, status, status_reason, created_at, updated_at)
       VALUES ('proj_fs', 'Packed Product', 165, 'owner/packed', ?, 'active', NULL, ?, ?)`,
    ).run(checkout, now, now);
    workspace = resolveProjectWorkspace(checkout, { customHome: home, customStateDir: stateDir });
    backup = new BackupRestoreService(db, { stateDir });
    cutover = new AuthorityCutoverService(db, { stateDir, home, backup });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    if (ORIGINAL_ANIMUS_STATE_DIR === undefined) delete process.env.ANIMUS_STATE_DIR;
    else process.env.ANIMUS_STATE_DIR = ORIGINAL_ANIMUS_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  function writeLiveLegacyState() {
    const liveRun = join(workspace.runsDir, "run_live_1");
    mkdirSync(liveRun, { recursive: true });
    writeFileSync(
      join(liveRun, "state.json"),
      JSON.stringify({ runId: "run_live_1", status: "building", pid: process.pid }, null, 2),
    );
    writeFileSync(
      join(liveRun, "issue.json"),
      JSON.stringify({ number: 501, url: "https://github.com/owner/packed/issues/501" }),
    );

    const liveLock = join(workspace.locksDir, "issue-501");
    mkdirSync(liveLock, { recursive: true });
    writeFileSync(
      join(liveLock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        ownerToken: randomUUID(),
        createdAt: new Date().toISOString(),
      }),
    );

    const worktree = join(workspace.worktreesDir, "issue-502");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(worktree, ".worktree.lock"),
      JSON.stringify({ pid: process.pid, runId: "run_502", branch: "local-loop/issue-502" }),
    );

    mkdirSync(workspace.dossiersDir, { recursive: true });
    writeFileSync(
      join(workspace.dossiersDir, "issue-501.json"),
      JSON.stringify({ issueNumber: 501 }),
    );
    writeFileSync(join(workspace.dossiersDir, "issue-502.json"), "{not-json");
  }

  test("live filesystem-only workers are inventoried and block staging without a DB process row", async () => {
    writeLiveLegacyState();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_runs").get() as { count: number },
    ).toEqual({ count: 0 });

    const inventory = inventoryInstallation(db, { stateDir, home });
    const entities = inventory.held.map((fact) => fact.entity).sort();
    expect(entities).toContain("legacy_run");
    expect(entities).toContain("legacy_lock");
    expect(entities).toContain("legacy_worktree");
    expect(entities).toContain("legacy_dossier");
    expect(inventory.legacyState.runs).toBe(1);
    expect(inventory.legacyState.locks).toBe(1);
    expect(inventory.legacyState.worktrees).toBe(1);
    expect(inventory.legacyState.dossiers).toBe(2);
    expect(inventory.legacyState.malformed).toBeGreaterThanOrEqual(1);

    // Deterministic identity/count/digest across repeated inventory passes.
    const again = inventoryInstallation(db, { stateDir, home });
    expect(again.legacyState.digest).toBe(inventory.legacyState.digest);
    expect(again.legacyState.runs).toBe(inventory.legacyState.runs);
    expect(again.stateDigest).toBe(inventory.stateDigest);
    expect(again.identityDigest).toBe(inventory.identityDigest);

    // Only registered-project-derived roots are inspected.
    const roots = resolveLegacyStateRoots(db, { stateDir, home });
    const allowedPrefixes = [home, realpathSync(home), checkout, realpathSync(checkout)];
    for (const legacyRoot of roots.roots) {
      expect(allowedPrefixes.some((prefix) => legacyRoot.startsWith(prefix))).toBe(true);
    }

    await cutover.stage({ actor: "operator" }).then(
      () => {
        throw new Error("expected staging to fail on a live filesystem writer");
      },
      (error: unknown) => {
        expect((error as { code?: string }).code).toBe("cutover_writers_active");
      },
    );
    expect(readExecutionAuthority(stateDir).authority).toBe("migrating");
    const status = cutover.status();
    expect(status.held.some((fact) => fact.entity === "legacy_run")).toBe(true);
    expect(status.blockingReasons.some((reason) => reason.includes("live_writer"))).toBe(true);

    await cutover.abort({
      actor: "operator",
      reason: "quiesce legacy writers first",
      cutoverId: status.operation!.id,
    });
    expect(readExecutionAuthority(stateDir).authority).toBe("legacy");
  });

  test("a proven-dead filesystem owner is stale, not a live writer", () => {
    const deadRun = join(workspace.runsDir, "run_dead");
    mkdirSync(deadRun, { recursive: true });
    writeFileSync(
      join(deadRun, "state.json"),
      JSON.stringify({ runId: "run_dead", status: "building", pid: 999_999_999 }),
    );
    const inventory = inventoryInstallation(db, { stateDir, home });
    expect(inventory.held.some((fact) => fact.identity.includes("run_dead"))).toBe(false);
    expect(inventory.legacyState.runs).toBe(1);
  });

  test("a legacy worker that passed startup cannot write or spawn after the fence", async () => {
    const dbPath = join(stateDir, "console.db");
    const marker = join(root, "child-started");
    const resume = join(root, "child-resume");
    const resultPath = join(root, "child-result.json");
    const childScript = join(
      REPO_ROOT,
      "tests/integration",
      `.tmp-authority-fs-child-${randomUUID()}.ts`,
    );
    writeFileSync(
      childScript,
      `
import { writeFileSync, existsSync } from "node:fs";
import { readExecutionAuthority } from "${join(REPO_ROOT, "packages/contracts/src/execution-authority.ts")}";
import { recordSubticketIntegration, executeSubticketAutoMerge } from "${join(REPO_ROOT, "scripts/loop/merge-queue.ts")}";

const stateDir = process.env.ANIMUS_STATE_DIR!;
const dbPath = process.env.TEST_DB_PATH!;
const root = process.env.TEST_ROOT!;
const started = process.env.TEST_STARTED!;
const resume = process.env.TEST_RESUME!;
const result = process.env.TEST_RESULT!;

// Simulate the legacy loop entry check that ran before the fence.
const startup = readExecutionAuthority(stateDir);
if (startup.authority !== "legacy") {
  writeFileSync(result, JSON.stringify({ startup: startup.authority, error: "startup_refused" }));
  process.exit(0);
}
writeFileSync(started, "1");
while (!existsSync(resume)) await Bun.sleep(20);

const rec = recordSubticketIntegration({
  root,
  issueNumber: 9001,
  branch: "factory/packed",
  candidate: "c".repeat(40),
  dbPath,
  projectId: "proj_fs",
});
let mergeThrew = false;
let mergeError = null;
let processCalls = 0;
try {
  await executeSubticketAutoMerge({
    root,
    candidate: "c".repeat(40),
    integrationBranch: "factory/packed",
    targetBaseTip: "b".repeat(40),
    worktree: root,
    issueNumber: 9001,
    defaultBaseBranch: "main",
    pr: "https://github.com/owner/packed/pull/1",
    hasOrigin: true,
    push: true,
    autoMergeEval: {
      authorized: true,
      decision: "auto_merge",
      isSubticket: true,
      targetBranch: "factory/packed",
      baseBranch: "main",
      riskLevel: "low",
      scopeAligned: true,
      criticalImpacts: [],
      deterministicImpacts: [],
      reviewerImpacts: [],
      reasons: [],
    },
    dbPath,
    projectId: "proj_fs",
    gitFn: async () => "",
    processRunFn: async () => {
      processCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
} catch (error) {
  mergeThrew = true;
  mergeError = error instanceof Error ? error.message : String(error);
}
writeFileSync(result, JSON.stringify({ startup: startup.authority, rec, mergeThrew, mergeError, processCalls }));
`,
    );

    const child = Bun.spawn([process.execPath, childScript], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ANIMUS_HOME: home,
        ANIMUS_STATE_DIR: stateDir,
        TEST_DB_PATH: dbPath,
        TEST_ROOT: checkout,
        TEST_STARTED: marker,
        TEST_RESUME: resume,
        TEST_RESULT: resultPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await waitFor(marker);
      // No live FS or DB writer is visible, so the fence can be written while
      // the child is paused mid-lap.
      const staged = await cutover.stage({ actor: "operator" });
      expect(staged.operation.status).toBe("staged");
      expect(readExecutionAuthority(stateDir).authority).toBe("migrating");

      writeFileSync(resume, "1");
      await child.exited;
      expect(existsSync(resultPath)).toBe(true);
      const childResult = JSON.parse(readFileSync(resultPath, "utf-8")) as {
        startup: string;
        rec: { integrated: boolean; error?: string };
        mergeThrew: boolean;
        mergeError: string | null;
        processCalls: number;
      };
      expect(childResult.startup).toBe("legacy");
      expect(childResult.rec.integrated).toBe(false);
      expect(childResult.rec.error).toContain("execution_authority_moved");
      expect(childResult.mergeThrew).toBe(true);
      expect(childResult.mergeError).toContain("execution_authority_moved");
      expect(childResult.processCalls).toBe(0);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM project_issue_integrations").get() as {
          count: number;
        },
      ).toEqual({ count: 0 });
      // No run rows, locks or worktrees were created by the resumed child.
      const after = inventoryInstallation(db, { stateDir, home });
      expect(after.held).toEqual([]);
      expect(after.legacyState.runs).toBe(0);
      expect(after.legacyState.locks).toBe(0);
      expect(after.legacyState.worktrees).toBe(0);
    } finally {
      try {
        child.kill();
      } catch {}
      rmSync(childScript, { force: true });
    }
  }, 60_000);
});
