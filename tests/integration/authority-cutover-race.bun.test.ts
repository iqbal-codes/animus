import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { BackupRestoreService } from "../../apps/backend/src/restore/service";
import { AuthorityCutoverService } from "../../apps/backend/src/cutover/service";
import { evaluateExecutionAuthority as evaluateBackendAuthority } from "../../apps/backend/src/authority/guard";
import {
  ExecutionAuthorityConflictError,
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

  function isolatedCutover(label: string) {
    const iterRoot = join(root, label);
    const iterHome = join(iterRoot, "home");
    const iterStateDir = join(iterHome, "state");
    mkdirSync(iterStateDir, { recursive: true });
    const iterDb = initializeDatabase(join(iterStateDir, "console.db"));
    const iterBackup = new BackupRestoreService(iterDb, { stateDir: iterStateDir });
    const iterCutover = new AuthorityCutoverService(iterDb, {
      stateDir: iterStateDir,
      home: iterHome,
      backup: iterBackup,
    });
    return { iterRoot, iterHome, iterStateDir, iterDb, iterBackup, iterCutover };
  }

  type ChildResult = { ok: boolean; error: string | null; code: string | null; mode?: string };

  function isCorruptLockError(result: ChildResult): boolean {
    if (result.code === "cutover_lock_ambiguous") return true;
    return /unreadable ownership|operation recovery|Unexpected EOF|Unexpected end of JSON|ambiguous/i.test(
      result.error ?? "",
    );
  }

  test("two OS processes racing the marker CAS produce exactly one winner (repeated)", async () => {
    const REPEATS = 6;
    const authModule = join(REPO_ROOT, "packages/contracts/src/execution-authority.ts");
    const script = writeChildScript(
      "cas",
      `
import { writeFileSync, existsSync } from "node:fs";
import { writeExecutionAuthority } from "${authModule}";
const stateDir = process.env.ANIMUS_STATE_DIR!;
const barrier = process.env.BARRIER!;
const out = process.env.OUT!;
while (!existsSync(barrier)) await Bun.sleep(2);
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

    const rounds: Array<{ winner: string; loser: string; loserCode: string }> = [];
    for (let round = 0; round < REPEATS; round += 1) {
      const iterStateDir = join(root, `cas-round-${round}`);
      mkdirSync(iterStateDir, { recursive: true });
      const barrier = join(iterStateDir, "go");
      const children = [0, 1].map((index) => {
        const out = join(iterStateDir, `result-${index}.json`);
        return {
          out,
          index,
          child: spawnChild(script, {
            ANIMUS_HOME: root,
            ANIMUS_STATE_DIR: iterStateDir,
            BARRIER: barrier,
            OUT: out,
            CUTOVER: `cutover_race_${round}_${index}`,
          }),
        };
      });

      // Let both processes load and block on the barrier before releasing them.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      writeFileSync(barrier, "1");
      for (const { child } of children) await child.exited;

      const results = children.map(
        ({ out }) => JSON.parse(readFileSync(out, "utf-8")) as ChildResult,
      );
      const winners = results.filter((result) => result.ok);
      const losers = results.filter((result) => !result.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const loser = losers[0]!;
      // A healthy competitor is either lock-busy or CAS-conflict. Both are the
      // same stable semantic conflict code; never a brittle message or a corrupt
      // lock/EOF classification from a healthy creator.
      expect(loser.code).toBe("authority_marker_conflict");
      expect(isCorruptLockError(loser)).toBe(false);
      const finalMarker = readExecutionAuthority(iterStateDir);
      expect(finalMarker.authority).toBe("migrating");
      expect(finalMarker.cutover_id).toMatch(new RegExp(`^cutover_race_${round}_[01]$`));
      const winner = winners[0]!;
      const winnerIndex = results.indexOf(winner);
      rounds.push({
        winner: `cutover_race_${round}_${winnerIndex}`,
        loser: loser.error ?? "",
        loserCode: loser.code ?? "",
      });
    }

    expect(rounds).toHaveLength(REPEATS);
    console.log(
      JSON.stringify({
        test: "marker-cas-race",
        repeats: REPEATS,
        winners: rounds.map((r) => r.winner),
      }),
    );
  }, 90_000);

  test("racing abort and activate produce one consistent marker/database outcome (repeated)", async () => {
    const REPEATS = 3;
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
while (!existsSync(barrier)) await Bun.sleep(2);
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

    const outcomes: string[] = [];
    for (let round = 0; round < REPEATS; round += 1) {
      const { iterRoot, iterHome, iterStateDir, iterDb, iterCutover } = isolatedCutover(
        `abort-activate-${round}`,
      );
      try {
        const staged = await iterCutover.stage({ actor: "operator" });
        expect(staged.operation.status).toBe("staged");
        const operation = staged.operation;
        const barrier = join(iterRoot, "go");
        const specs: Array<{ mode: string; out: string; env: Record<string, string> }> = [
          {
            mode: "activate",
            out: join(iterRoot, "activate-result.json"),
            env: {
              INVENTORY: operation.inventorySha256!,
              MANIFEST: operation.backupManifestSha256!,
            },
          },
          { mode: "abort", out: join(iterRoot, "abort-result.json"), env: {} },
        ];
        const children = specs.map((spec) => ({
          ...spec,
          child: spawnChild(script, {
            ANIMUS_HOME: iterHome,
            ANIMUS_STATE_DIR: iterStateDir,
            BARRIER: barrier,
            OUT: spec.out,
            MODE: spec.mode,
            CUTOVER: operation.id,
            ...spec.env,
          }),
        }));

        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        writeFileSync(barrier, "1");
        for (const { child } of children) await child.exited;

        const results = children.map(
          ({ out }) => JSON.parse(readFileSync(out, "utf-8")) as ChildResult,
        );
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toHaveLength(1);

        const marker = readExecutionAuthority(iterStateDir);
        const row = iterDb
          .prepare("SELECT status FROM authority_cutover_operations WHERE id = ?")
          .get(operation.id) as { status: string };
        const winner = results.find((result) => result.ok)!;
        const loser = results.find((result) => !result.ok)!;

        // A healthy loser must serialize behind the winner and observe the
        // terminal state, never a corrupt/ambiguous lock.
        expect(loser.code === "cutover_already_active" || loser.code === "cutover_not_staged").toBe(
          true,
        );
        expect(loser.code).not.toBe("cutover_lock_ambiguous");
        expect(isCorruptLockError(loser)).toBe(false);

        if (winner.mode === "activate") {
          expect(marker.authority).toBe("local");
          expect(row.status).toBe("activated");
          expect(loser.mode).toBe("abort");
          outcomes.push("activate");
        } else {
          expect(marker.authority).toBe("legacy");
          expect(row.status).toBe("aborted");
          expect(loser.mode).toBe("activate");
          outcomes.push("abort");
        }
        // The verified backend gate only trusts a local marker backed by an activated row.
        const decision = evaluateBackendAuthority(iterDb);
        expect(decision.settled).toBe(true);
        if (marker.authority === "local") expect(decision.marker.authority).toBe("local");
      } finally {
        iterDb.close();
      }
    }
    expect(outcomes).toHaveLength(REPEATS);
    console.log(
      JSON.stringify({ test: "abort-activate-race", repeats: REPEATS, winners: outcomes }),
    );
  }, 120_000);

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

  test("a database-activated row without the local marker resumes only after re-verification", async () => {
    const staged = await cutover.stage({ actor: "operator" });
    const operation = staged.operation;
    // Simulate a crash after the DB committed `activated` but before the marker.
    db.prepare(
      "UPDATE authority_cutover_operations SET status = 'activated', activated_at = ? WHERE id = ?",
    ).run(Date.now(), operation.id);
    expect(readExecutionAuthority(stateDir).authority).toBe("migrating");
    const fenced = evaluateBackendAuthority(db);
    expect(fenced.settled).toBe(false);

    const resumed = await cutover.activate({
      actor: "operator",
      cutoverId: operation.id,
      inventorySha256: operation.inventorySha256!,
      backupManifestSha256: operation.backupManifestSha256!,
    });
    expect(resumed.operation.status).toBe("activated");
    expect(readExecutionAuthority(stateDir).authority).toBe("local");
    expect(evaluateBackendAuthority(db).settled).toBe(true);

    // Once activated, abort is forbidden: rollback is a validated restore, not a revert.
    let abortError: unknown;
    try {
      await cutover.abort({ actor: "operator", reason: "no revert", cutoverId: operation.id });
    } catch (caught) {
      abortError = caught;
    }
    expect(abortError).toMatchObject({ code: "cutover_already_active" });
  }, 60_000);

  test("a corrupt pre-existing marker owner record fails closed and is never stolen", () => {
    const iterStateDir = join(root, "corrupt-marker-lock");
    mkdirSync(iterStateDir, { recursive: true });
    const lockPath = join(iterStateDir, ".execution-authority.lock");
    // Zero-length: a corrupt pre-existing lock, not a healthy in-flight creator.
    writeFileSync(lockPath, "");
    let error: unknown;
    try {
      writeExecutionAuthority("migrating", { stateDir: iterStateDir, expected: "legacy" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExecutionAuthorityConflictError);
    expect((error as ExecutionAuthorityConflictError).code).toBe("authority_marker_conflict");
    expect((error as Error).message).toMatch(/unreadable ownership|operation recovery/);
    expect(readExecutionAuthority(iterStateDir).authority).toBe("legacy");

    // Operator removes the corrupt lock; the next write proceeds normally.
    unlinkSync(lockPath);
    writeExecutionAuthority("migrating", { stateDir: iterStateDir, expected: "legacy" });
    expect(readExecutionAuthority(iterStateDir).authority).toBe("migrating");
  });

  test("a leftover marker-lock temp record does not block a healthy writer", () => {
    const iterStateDir = join(root, "marker-temp-leftover");
    mkdirSync(iterStateDir, { recursive: true });
    // A crash after writing the temp owner but before `link` leaves only this.
    writeFileSync(join(iterStateDir, ".execution-authority.lock.999.dead.tmp"), '{"partial":');
    writeExecutionAuthority("migrating", { stateDir: iterStateDir, expected: "legacy" });
    expect(readExecutionAuthority(iterStateDir).authority).toBe("migrating");
  });

  test("a corrupt cutover operation lock fails closed while a stale temp record is ignored", async () => {
    const { iterStateDir, iterDb, iterCutover } = isolatedCutover("operation-lock");
    try {
      // A leftover temp record from a crashed creator is inert.
      writeFileSync(join(iterStateDir, ".authority-cutover.lock.999.dead.tmp"), '{"partial":');
      // A corrupt live lock path must not be stolen.
      writeFileSync(join(iterStateDir, ".authority-cutover.lock"), "");
      let lockError: unknown;
      try {
        await iterCutover.stage({ actor: "operator" });
      } catch (caught) {
        lockError = caught;
      }
      expect(lockError).toMatchObject({ code: "cutover_lock_ambiguous" });
      expect(readExecutionAuthority(iterStateDir).authority).toBe("legacy");

      // Operator clears the corrupt lock; staging proceeds.
      unlinkSync(join(iterStateDir, ".authority-cutover.lock"));
      const staged = await iterCutover.stage({ actor: "operator" });
      expect(staged.operation.status).toBe("staged");
    } finally {
      iterDb.close();
    }
  }, 60_000);

  test("dead-owner operation lock is reclaimed without two critical sections (4 processes, repeated)", async () => {
    const ROUNDS = 30;
    const CONTENDERS = 4;
    const CRIT_MS = 3;
    const lockModule = join(REPO_ROOT, "apps/backend/src/cutover/lock.ts");
    const script = writeChildScript(
      "reclaim-overlap",
      `
import { existsSync, writeFileSync } from "node:fs";
const { withCutoverLock } = await import(process.env.LOCK_MODULE!);
const stateDir = process.env.STATE_DIR!;
const barrier = process.env.BARRIER!;
const log = process.env.LOG!;
while (!existsSync(barrier)) await Bun.sleep(1);
try {
  await withCutoverLock(stateDir, async () => {
    writeFileSync(log, "start\\n", { flag: "a" });
    await Bun.sleep(Number(process.env.CRIT_MS ?? 3));
    writeFileSync(log, "end\\n", { flag: "a" });
  }, 5000);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : String(error);
  writeFileSync(log, "err " + code + "\\n", { flag: "a" });
}
`,
    );

    let overlapRounds = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const dir = join(root, `reclaim-round-${round}`);
      mkdirSync(dir, { recursive: true });
      const log = join(dir, "critical.log");
      const barrier = join(dir, "go");
      writeFileSync(log, "");
      // A proven-dead owner (ESRCH) is exactly the crash-recovery path that the
      // old blind-unlink reclaim raced on.
      writeFileSync(
        join(dir, ".authority-cutover.lock"),
        JSON.stringify({
          pid: 999_999_999,
          ownerToken: `dead-owner-${round}`,
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      const children = Array.from({ length: CONTENDERS }, () =>
        spawnChild(script, {
          ANIMUS_HOME: root,
          ANIMUS_STATE_DIR: dir,
          STATE_DIR: dir,
          BARRIER: barrier,
          LOG: log,
          CRIT_MS: String(CRIT_MS),
          LOCK_MODULE: lockModule,
        }),
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      writeFileSync(barrier, "1");
      for (const child of children) await child.exited;

      const lines = readFileSync(log, "utf-8").trim().split("\n").filter(Boolean);
      let open = 0;
      let starts = 0;
      let ends = 0;
      let overlap = false;
      for (const line of lines) {
        if (line === "start") {
          starts += 1;
          open += 1;
          if (open > 1) overlap = true;
        } else if (line === "end") {
          ends += 1;
          open -= 1;
        }
      }
      // Non-vacuous: every contender must actually have entered and left, and no
      // interval may overlap another.
      expect(starts).toBe(CONTENDERS);
      expect(ends).toBe(CONTENDERS);
      expect(overlap).toBe(false);
      if (overlap) overlapRounds += 1;
    }
    expect(overlapRounds).toBe(0);
    console.log(
      JSON.stringify({
        test: "operation-lock-reclaim-overlap",
        rounds: ROUNDS,
        contenders: CONTENDERS,
        overlapRounds,
      }),
    );
  }, 120_000);

  test("dead-owner marker lock is reclaimed by exactly one of several processes (repeated)", async () => {
    const ROUNDS = 8;
    const CONTENDERS = 4;
    const authModule = join(REPO_ROOT, "packages/contracts/src/execution-authority.ts");
    const script = writeChildScript(
      "marker-reclaim",
      `
import { existsSync, writeFileSync } from "node:fs";
const { writeExecutionAuthority } = await import(process.env.AUTH_MODULE!);
const stateDir = process.env.STATE_DIR!;
const barrier = process.env.BARRIER!;
const out = process.env.OUT!;
while (!existsSync(barrier)) await Bun.sleep(1);
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

    for (let round = 0; round < ROUNDS; round += 1) {
      const dir = join(root, `marker-reclaim-${round}`);
      mkdirSync(dir, { recursive: true });
      const barrier = join(dir, "go");
      writeFileSync(
        join(dir, ".execution-authority.lock"),
        JSON.stringify({
          pid: 999_999_999,
          ownerToken: `dead-marker-${round}`,
          createdAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      const children = Array.from({ length: CONTENDERS }, (_, index) => {
        const out = join(dir, `result-${index}.json`);
        return {
          index,
          out,
          cutoverId: `cutover_marker_reclaim_${round}_${index}`,
          child: spawnChild(script, {
            ANIMUS_HOME: root,
            ANIMUS_STATE_DIR: dir,
            STATE_DIR: dir,
            BARRIER: barrier,
            OUT: out,
            CUTOVER: `cutover_marker_reclaim_${round}_${index}`,
            AUTH_MODULE: authModule,
          }),
        };
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      writeFileSync(barrier, "1");
      for (const { child } of children) await child.exited;

      const results = children.map(({ out }) => {
        return JSON.parse(readFileSync(out, "utf-8")) as ChildResult;
      });
      const winners = results.filter((result) => result.ok);
      const losers = results.filter((result) => !result.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(CONTENDERS - 1);
      for (const loser of losers) {
        expect(loser.code).toBe("authority_marker_conflict");
        expect(isCorruptLockError(loser)).toBe(false);
      }
      const winnerIndex = results.indexOf(winners[0]!);
      const finalMarker = readExecutionAuthority(dir);
      expect(finalMarker.authority).toBe("migrating");
      expect(finalMarker.cutover_id).toBe(`cutover_marker_reclaim_${round}_${winnerIndex}`);
    }
  }, 90_000);

  test("an unresolvable marker lock never falls through into an unheld acquisition", () => {
    const iterStateDir = join(root, "marker-fallthrough");
    mkdirSync(iterStateDir, { recursive: true });
    // A dangling symlink keeps `link(2)` failing with EEXIST while the owner read
    // keeps returning ENOENT: the exact "missing" loop the retry budget bounds.
    const lockPath = join(iterStateDir, ".execution-authority.lock");
    symlinkSync(join(iterStateDir, "absent-owner-record"), lockPath);

    let error: unknown;
    try {
      writeExecutionAuthority("migrating", { stateDir: iterStateDir, expected: "legacy" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExecutionAuthorityConflictError);
    expect((error as ExecutionAuthorityConflictError).code).toBe("authority_marker_conflict");
    // Exhaustion must not have written the marker as if the lock were held.
    expect(readExecutionAuthority(iterStateDir).authority).toBe("legacy");

    unlinkSync(lockPath);
    writeExecutionAuthority("migrating", { stateDir: iterStateDir, expected: "legacy" });
    expect(readExecutionAuthority(iterStateDir).authority).toBe("migrating");
  });
});
