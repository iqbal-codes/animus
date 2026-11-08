import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { BackupRestoreService } from "../../apps/backend/src/restore/service";
import { AuthorityCutoverService } from "../../apps/backend/src/cutover/service";
import { evaluateExecutionAuthority as evaluateBackendAuthority } from "../../apps/backend/src/authority/guard";
import {
  readExecutionAuthority,
  writeExecutionAuthority,
} from "@animus/contracts/execution-authority";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;
const ORIGINAL_ANIMUS_STATE_DIR = process.env.ANIMUS_STATE_DIR;

function spawnChild(script: string, env: Record<string, string>) {
  return Bun.spawn([process.execPath, script], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("authority cutover cross-process serialization (#165 B2)", () => {
  let root: string;
  let home: string;
  let stateDir: string;
  let db: ReturnType<typeof initializeDatabase>;
  let backup: BackupRestoreService;
  let cutover: AuthorityCutoverService;
  let scripts: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "animus-authority-race-"));
    home = join(root, "home");
    stateDir = join(home, "state");
    mkdirSync(stateDir, { recursive: true });
    process.env.ANIMUS_HOME = home;
    process.env.ANIMUS_STATE_DIR = stateDir;
    db = initializeDatabase(join(stateDir, "console.db"));
    backup = new BackupRestoreService(db, { stateDir });
    cutover = new AuthorityCutoverService(db, { stateDir, home, backup });
    scripts = [];
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    for (const script of scripts) rmSync(script, { force: true });
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    if (ORIGINAL_ANIMUS_STATE_DIR === undefined) delete process.env.ANIMUS_STATE_DIR;
    else process.env.ANIMUS_STATE_DIR = ORIGINAL_ANIMUS_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  function writeChildScript(name: string, body: string): string {
    const script = join(REPO_ROOT, "tests/integration", `.tmp-${name}-${randomUUID()}.ts`);
    writeFileSync(script, body);
    scripts.push(script);
    return script;
  }

  test("two OS processes racing the marker CAS produce exactly one winner", async () => {
    const barrier = join(root, "go");
    const authModule = join(REPO_ROOT, "packages/contracts/src/execution-authority.ts");
    const script = writeChildScript(
      "cas",
      `
import { writeFileSync, existsSync } from "node:fs";
import { writeExecutionAuthority } from "${authModule}";
const stateDir = process.env.ANIMUS_STATE_DIR!;
const barrier = process.env.BARRIER!;
const out = process.env.OUT!;
while (!existsSync(barrier)) await Bun.sleep(5);
let ok = false;
let error = null;
let code = null;
try {
  writeExecutionAuthority("migrating", {
    stateDir,
    expected: "legacy",
    cutoverId: process.env.CUTOVER!,
    phase: "staging",
  });
  ok = true;
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
  code = err && typeof err === "object" && "code" in err ? String(err.code) : null;
}
writeFileSync(out, JSON.stringify({ ok, error, code }));
`,
    );

    const children = [0, 1].map((index) => {
      const out = join(root, `cas-result-${index}.json`);
      return {
        out,
        child: spawnChild(script, {
          ANIMUS_HOME: home,
          ANIMUS_STATE_DIR: stateDir,
          BARRIER: barrier,
          OUT: out,
          CUTOVER: `cutover_race_${index}`,
        }),
      };
    });

    // Let every process load and block on the barrier before releasing them.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    writeFileSync(barrier, "1");
    for (const { child } of children) await child.exited;

    const results = children.map(
      ({ out }) =>
        JSON.parse(readFileSync(out, "utf-8")) as {
          ok: boolean;
          error: string | null;
          code: string | null;
        },
    );
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.code).toBe("authority_marker_conflict");
    expect(losers[0]!.error).toContain("changed from legacy");
    const finalMarker = readExecutionAuthority(stateDir);
    expect(finalMarker.authority).toBe("migrating");
    expect(finalMarker.cutover_id).toMatch(/^cutover_race_[01]$/);
  }, 60_000);

  test("racing abort and activate produce one consistent marker/database outcome", async () => {
    const staged = await cutover.stage({ actor: "operator" });
    expect(staged.operation.status).toBe("staged");
    const operation = staged.operation;

    const barrier = join(root, "go");
    const serviceModule = join(REPO_ROOT, "apps/backend/src/cutover/service.ts");
    const backupModule = join(REPO_ROOT, "apps/backend/src/restore/service.ts");
    const dbModule = join(REPO_ROOT, "apps/backend/src/registry/db.ts");
    const script = writeChildScript(
      "abort-activate",
      `
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { initializeDatabase } from "${dbModule}";
import { BackupRestoreService } from "${backupModule}";
import { AuthorityCutoverService } from "${serviceModule}";
const stateDir = process.env.ANIMUS_STATE_DIR!;
const home = process.env.ANIMUS_HOME!;
const barrier = process.env.BARRIER!;
const out = process.env.OUT!;
const mode = process.env.MODE!;
const db = initializeDatabase(join(stateDir, "console.db"));
const backup = new BackupRestoreService(db, { stateDir });
const cutover = new AuthorityCutoverService(db, { stateDir, home, backup });
while (!existsSync(barrier)) await Bun.sleep(5);
let ok = false;
let error = null;
let code = null;
try {
  if (mode === "activate") {
    await cutover.activate({
      actor: "operator",
      cutoverId: process.env.CUTOVER!,
      inventorySha256: process.env.INVENTORY!,
      backupManifestSha256: process.env.MANIFEST!,
    });
  } else {
    await cutover.abort({
      actor: "operator",
      reason: "race abort",
      cutoverId: process.env.CUTOVER!,
    });
  }
  ok = true;
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
  code = err && typeof err === "object" && "code" in err ? String(err.code) : null;
}
db.close();
writeFileSync(out, JSON.stringify({ ok, error, code, mode }));
`,
    );

    const specs: Array<{ mode: string; out: string; env: Record<string, string> }> = [
      {
        mode: "activate",
        out: join(root, "activate-result.json"),
        env: {
          INVENTORY: operation.inventorySha256!,
          MANIFEST: operation.backupManifestSha256!,
        },
      },
      { mode: "abort", out: join(root, "abort-result.json"), env: {} },
    ];
    const children = specs.map((spec) => ({
      ...spec,
      child: spawnChild(script, {
        ANIMUS_HOME: home,
        ANIMUS_STATE_DIR: stateDir,
        BARRIER: barrier,
        OUT: spec.out,
        MODE: spec.mode,
        CUTOVER: operation.id,
        ...spec.env,
      }),
    }));

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    writeFileSync(barrier, "1");
    for (const { child } of children) await child.exited;

    const results = children.map(
      ({ out }) =>
        JSON.parse(readFileSync(out, "utf-8")) as {
          ok: boolean;
          error: string | null;
          code: string | null;
          mode: string;
        },
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);

    const marker = readExecutionAuthority(stateDir);
    const row = db
      .prepare("SELECT status FROM authority_cutover_operations WHERE id = ?")
      .get(operation.id) as { status: string };
    const winner = results.find((result) => result.ok)!;
    const loser = results.find((result) => !result.ok)!;

    if (winner.mode === "activate") {
      expect(marker.authority).toBe("local");
      expect(row.status).toBe("activated");
      expect(loser.mode).toBe("abort");
      expect(loser.code).toBe("cutover_already_active");
    } else {
      expect(marker.authority).toBe("legacy");
      expect(row.status).toBe("aborted");
      expect(loser.mode).toBe("activate");
      expect(loser.code).toBe("cutover_not_staged");
    }
    // The verified backend gate only trusts a local marker backed by an activated row.
    const decision = evaluateBackendAuthority(db);
    expect(decision.settled).toBe(true);
    if (marker.authority === "local") expect(decision.marker.authority).toBe("local");
  }, 90_000);

  test("a local marker written before the DB commit is fenced until reconciled", async () => {
    const staged = await cutover.stage({ actor: "operator" });
    const operation = staged.operation;
    // Simulate the old crash window: marker local, operation row still staged.
    writeExecutionAuthority("local", {
      stateDir,
      expected: "migrating",
      cutoverId: operation.id,
      inventorySha256: operation.inventorySha256,
      backupManifestSha256: operation.backupManifestSha256,
      phase: "active",
    });
    const fenced = evaluateBackendAuthority(db);
    expect(fenced.settled).toBe(false);
    expect(fenced.reason).toBe("authority_marker_without_activated_cutover");

    const reconciled = await cutover.activate({
      actor: "operator",
      cutoverId: operation.id,
      inventorySha256: operation.inventorySha256!,
      backupManifestSha256: operation.backupManifestSha256!,
    });
    expect(reconciled.operation.status).toBe("activated");
    expect(readExecutionAuthority(stateDir).authority).toBe("local");
    expect(evaluateBackendAuthority(db).settled).toBe(true);
  }, 60_000);
});
