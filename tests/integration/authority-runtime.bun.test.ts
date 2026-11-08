import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { writeExecutionAuthority } from "@animus/contracts/execution-authority";

/**
 * Real compiled Bun binary proof for #165 AC6.
 *
 * The packaged CLI is compiled from the same source and run against a temporary
 * state dir. `authority status` opens the real SQLite database through the
 * normal `initializeDatabase` path, which executes and verifies WAL, FULL
 * synchronous, foreign keys and busy timeout. No fake flag or dev-only source
 * path is involved.
 */
describe("packaged authority runtime", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("compiled CLI reads the migrated SQLite state and authority marker", () => {
    root = mkdtempSync(join(tmpdir(), "animus-authority-binary-"));
    const home = join(root, "home");
    const stateDir = join(home, "state");
    const repoRoot = resolve(import.meta.dir, "../..");
    const binary = join(root, "animus");

    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        `--outfile=${binary}`,
        join(repoRoot, "scripts/cli/cli.ts"),
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
    );
    expect(build.exitCode).toBe(0);
    expect(existsSync(binary)).toBe(true);

    const version = Bun.spawnSync([binary, "version", "--json"], {
      env: { ...process.env, ANIMUS_HOME: home, ANIMUS_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    expect(version.exitCode).toBe(0);
    expect(JSON.parse(version.stdout.toString()).name).toBe("animus");

    // Prove the artifact is a compiled executable, not a shell/script wrapper.
    const fd = openSync(binary, "r");
    const header = Buffer.alloc(2);
    try {
      readSync(fd, header, 0, 2, 0);
    } finally {
      closeSync(fd);
    }
    expect(header.toString("utf-8")).not.toBe("#!");

    // Build the real schema with the production initializer, then mark it active.
    const db = initializeDatabase(join(stateDir, "console.db"));
    db.close();
    writeExecutionAuthority("local", {
      stateDir,
      cutoverId: "cutover_binary",
      inventorySha256: "a".repeat(64),
      backupManifestSha256: "b".repeat(64),
      phase: "active",
    });

    const status = Bun.spawnSync(
      [binary, "authority", "status", "--json", "--state-dir", stateDir],
      {
        env: { ...process.env, ANIMUS_HOME: home, ANIMUS_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      },
    );
    expect(status.exitCode).toBe(0);
    const parsed = JSON.parse(status.stdout.toString()) as {
      authority: string;
      phase: string | null;
      cutoverId: string | null;
      schemaVersion: number;
      tableCount: number;
      databasePath: string;
    };
    expect(parsed.authority).toBe("local");
    expect(parsed.phase).toBe("active");
    expect(parsed.cutoverId).toBe("cutover_binary");
    expect(parsed.schemaVersion).toBe(15);
    expect(parsed.tableCount).toBeGreaterThan(10);
    expect(parsed.databasePath).toBe(join(stateDir, "console.db"));
  }, 180_000);
});
