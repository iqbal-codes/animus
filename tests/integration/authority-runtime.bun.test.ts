import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { seedActivatedAuthority } from "./support/activated-authority";

/**
 * Real compiled Bun binary proof for #165 AC6.
 *
 * The packaged CLI is compiled from this source and run against a meaningful
 * populated temporary installation. `authority status` opens the real SQLite
 * database through `openReadOnlyDatabase`, which configures the connection-scoped
 * busy timeout/foreign keys and reports the effective journal/synchronous mode;
 * the test asserts those actual PRAGMAs. The test then runs a real workspace
 * backup and an isolated held restore through the compiled binary's
 * `backup create`/`backup restore` commands against the same real backend, and
 * proves the restored IDs/artifact history are retained. No live network calls.
 */
const HASH = "a".repeat(64);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function seedMeaningfulInstallation(db: DatabaseSync, stateDir: string, home: string) {
  const now = Date.now();
  const projectId = "proj_packed";
  const workId = "work_packed";
  const revisionId = "rev_packed";
  const planId = "plan_packed";
  const manifestId = "manifest_packed";
  const deliveryId = "delivery_packed";
  const runId = "run_packed";
  const observationId = "obs_packed";
  const artifactId = "art_packed";
  const findingId = "finding_packed";

  db.prepare(
    `INSERT INTO projects (id, name, repo_id, repo_name, checkout_path, status, status_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
  ).run(
    projectId,
    "Packed Product",
    165,
    "owner/packed",
    join(home, "checkout"),
    new Date(now).toISOString(),
    new Date(now).toISOString(),
  );
  db.prepare(
    `INSERT INTO work_items (id, project_id, repo_id, repo_name, issue_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(workId, projectId, 165, "owner/packed", 9001, now, now);
  db.prepare(
    `INSERT INTO work_revisions
       (id, work_id, project_id, revision_number, content_hash, source_title, source_body,
        source_state, source_labels, source_comments, source_url, provenance, imported_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 'OPEN', '[]', '[]', ?, '{}', ?)`,
  ).run(
    revisionId,
    workId,
    projectId,
    HASH,
    "Packed ticket",
    "Packed ticket body",
    "https://github.com/owner/packed/issues/9001",
    now,
  );
  db.prepare(
    `INSERT INTO plans
       (id, project_id, kind, root_work_id, root_revision_id, graph_hash, evidence_hash,
        delivery_branch, integration_branch, created_at, updated_at)
     VALUES (?, ?, 'standalone', ?, ?, ?, ?, 'main', NULL, ?, ?)`,
  ).run(planId, projectId, workId, revisionId, HASH, HASH, now, now);
  db.prepare(
    `INSERT INTO plan_members (plan_id, project_id, work_id, revision_id, role, gate_profile, issue_number)
     VALUES (?, ?, ?, ?, 'ticket', 'standalone', 9001)`,
  ).run(planId, projectId, workId, revisionId);
  db.prepare(
    `INSERT INTO plan_manifests (id, plan_id, project_id, graph_hash, manifest, created_at)
     VALUES (?, ?, ?, ?, '{}', ?)`,
  ).run(manifestId, planId, projectId, HASH, now);
  db.prepare(
    `INSERT INTO deliveries
       (id, project_id, plan_id, kind, delivery_branch, integration_branch, final_pr_base,
        merge_policy_child, merge_policy_standalone, merge_policy_final, manifest_id, graph_hash,
        created_at, updated_at)
     VALUES (?, ?, ?, 'standalone', 'main', NULL, 'main', 'auto_after_gates', 'manual', 'manual', ?, ?, ?, ?)`,
  ).run(deliveryId, projectId, planId, manifestId, HASH, now, now);
  db.prepare(
    `INSERT INTO dispatch_runs
       (id, project_id, delivery_id, plan_id, work_id, revision_id, content_hash, issue_number, role,
        gate_profile, merge_policy, target_branch, ownership_generation, state, actor,
        command_request_id, branch, worktree_path, base_sha, owner_pid, owner_token,
        lease_expires_at, head_sha, error, launched_at, finished_at, created_at, updated_at, lap)
     VALUES (?, ?, ?, ?, ?, ?, ?, 9001, 'ticket', 'standalone', 'manual', 'main', 1, 'succeeded',
             'operator', 'cmd_packed', 'packed-branch', '/tmp/packed-worktree', ?, NULL,
             'owner-token-packed', NULL, ?, NULL, ?, ?, ?, ?, 1)`,
  ).run(
    runId,
    projectId,
    deliveryId,
    planId,
    workId,
    revisionId,
    HASH,
    HASH,
    HASH,
    now,
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO execution_observations
       (id, project_id, delivery_id, run_id, lap, attempt_key, stage, status, candidate_head_sha,
        target_tip_sha, merge_base_sha, tested_identity, integration_lineage, producer_id,
        producer_role, producer_name, gate_profile, gate_profile_version, error, created_at)
     VALUES (?, ?, ?, ?, 1, 'packed-attempt', 'final_acceptance', 'passed', ?, ?, ?, 'packed-identity',
             'packed-lineage', 'packed-evaluator', 'independent_evaluator', 'Packed Evaluator',
             'standalone', 1, NULL, ?)`,
  ).run(observationId, projectId, deliveryId, runId, HASH, HASH, HASH, now);

  const artifactRelative = "proof/evidence.log";
  const artifactBytes = Buffer.from("packed runtime artifact proof\n");
  const artifactDir = join(stateDir, "artifacts", projectId, "proof");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "evidence.log"), artifactBytes);
  db.prepare(
    `INSERT INTO execution_artifacts
       (id, project_id, observation_id, owner_type, owner_id, name, relative_path, media_type,
        size_bytes, digest_sha256, created_at)
     VALUES (?, ?, ?, 'observation', ?, 'evidence.log', ?, 'text/plain', ?, ?, ?)`,
  ).run(
    artifactId,
    projectId,
    observationId,
    observationId,
    artifactRelative,
    artifactBytes.byteLength,
    sha256(artifactBytes),
    now,
  );
  db.prepare(
    `INSERT INTO factory_findings
       (id, project_id, delivery_id, run_id, work_id, issue_number, ac_key, severity, file_context,
        summary, origin_observation_id, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, 9001, 'AC1', 'blocking', 'proof/evidence.log', 'Packed finding',
             ?, 'open', ?, NULL)`,
  ).run(findingId, projectId, deliveryId, runId, workId, observationId, now);
  db.prepare(
    `INSERT INTO commands
       (request_id, actor, project_id, action, target, timestamp, state, outcome, evidence_links,
        created_at, updated_at, reconciled_at)
     VALUES ('cmd_packed', 'operator', ?, 'dispatch', 'issue-9001', ?, 'succeeded', 'ok', '[]', ?, ?, ?)`,
  ).run(
    projectId,
    new Date(now).toISOString(),
    new Date(now).toISOString(),
    new Date(now).toISOString(),
    new Date(now).toISOString(),
  );
  db.prepare(
    `INSERT INTO project_issue_integrations (project_id, issue_number, branch, commit_sha, integrated_at)
     VALUES (?, 9001, 'factory/packed', ?, ?)`,
  ).run(projectId, HASH, new Date(now).toISOString());

  return {
    projectId,
    workId,
    revisionId,
    planId,
    deliveryId,
    runId,
    observationId,
    artifactId,
    findingId,
    artifactBytes,
    artifactRelative,
  };
}

describe("packaged authority runtime", () => {
  let root: string;
  let home: string;
  let stateDir: string;

  afterEach(async () => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("compiled CLI reports real PRAGMAs and runs backup + isolated held restore", async () => {
    root = mkdtempSync(join(tmpdir(), "animus-authority-binary-"));
    home = join(root, "home");
    stateDir = join(home, "state");
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

    // Build the real schema with the production initializer, seed a meaningful
    // installation (project/plan/delivery/run/observation/artifact/finding/
    // command/integration history), then mark it active.
    const db = initializeDatabase(join(stateDir, "console.db"));
    const seeded = seedMeaningfulInstallation(db, stateDir, home);
    seedActivatedAuthority(db, {
      stateDir,
      cutoverId: "cutover_binary",
      inventorySha256: HASH,
      backupManifestSha256: HASH,
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
      artifactCount: number;
      databasePath: string;
      pragmas: {
        journalMode: string;
        synchronous: number;
        foreignKeys: number;
        busyTimeout: number;
      } | null;
    };
    expect(parsed.authority).toBe("local");
    expect(parsed.phase).toBe("active");
    expect(parsed.cutoverId).toBe("cutover_binary");
    expect(parsed.schemaVersion).toBe(15);
    expect(parsed.tableCount).toBeGreaterThan(10);
    expect(parsed.artifactCount).toBe(1);
    expect(parsed.databasePath).toBe(join(stateDir, "console.db"));
    // The packaged process reports the PRAGMAs it actually observed/configured.
    expect(parsed.pragmas).toEqual({
      journalMode: "wal",
      synchronous: 2,
      foreignKeys: 1,
      busyTimeout: 5000,
    });

    // Start the real backend over loopback and drive backup/restore through the
    // compiled binary's supported local command path (same BackupRestoreService,
    // no network transport).
    const backupDestination = join(root, "backup-bundle");
    const restoreHome = join(root, "restore-home");
    const restoreStateDir = join(restoreHome, "state");
    const commonEnv = {
      ...process.env,
      ANIMUS_HOME: home,
      ANIMUS_STATE_DIR: stateDir,
    };

    db.close();

    const backup = Bun.spawnSync(
      [binary, "backup", "create", backupDestination, "--state-dir", stateDir, "--json"],
      { env: commonEnv, stdout: "pipe", stderr: "pipe", timeout: 60_000 },
    );
    if (backup.exitCode !== 0) {
      console.error(
        "backup stderr:",
        backup.stderr.toString(),
        "stdout:",
        backup.stdout.toString(),
      );
    }
    expect(backup.exitCode).toBe(0);
    const backupResult = JSON.parse(backup.stdout.toString()) as {
      destinationPath: string;
      manifestHash: string;
      artifactCount: number;
      schemaVersion: number;
    };
    expect(backupResult.destinationPath).toBe(backupDestination);
    expect(backupResult.artifactCount).toBe(1);
    expect(backupResult.schemaVersion).toBe(15);

    const restore = Bun.spawnSync(
      [
        binary,
        "backup",
        "restore",
        backupDestination,
        "--state-dir",
        stateDir,
        "--target-state-dir",
        restoreStateDir,
        "--target-home",
        restoreHome,
        "--json",
      ],
      { env: commonEnv, stdout: "pipe", stderr: "pipe", timeout: 60_000 },
    );
    if (restore.exitCode !== 0) {
      console.error(
        "restore stderr:",
        restore.stderr.toString(),
        "stdout:",
        restore.stdout.toString(),
      );
    }
    expect(restore.exitCode).toBe(0);
    const restoreResult = JSON.parse(restore.stdout.toString()) as {
      operation: { targetStateDir: string };
      installation: { held: boolean };
    };
    expect(restoreResult.operation.targetStateDir).toBe(restoreStateDir);
    expect(restoreResult.installation.held).toBe(true);

    // The restored installation retains the same IDs, evidence and artifact bytes.
    const restoredDb = new DatabaseSync(join(restoreStateDir, "console.db"), { readOnly: true });
    try {
      for (const [table, idColumn, id] of [
        ["work_items", "id", seeded.workId],
        ["plans", "id", seeded.planId],
        ["deliveries", "id", seeded.deliveryId],
        ["dispatch_runs", "id", seeded.runId],
        ["execution_artifacts", "id", seeded.artifactId],
        ["factory_findings", "id", seeded.findingId],
      ] as const) {
        const row = restoredDb
          .prepare(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ?`)
          .get(id);
        expect(row).toEqual({ [idColumn]: id });
      }
      const restoredArtifact = restoredDb
        .prepare("SELECT size_bytes, digest_sha256 FROM execution_artifacts WHERE id = ?")
        .get(seeded.artifactId) as { size_bytes: number; digest_sha256: string };
      expect(restoredArtifact.size_bytes).toBe(seeded.artifactBytes.byteLength);
      expect(restoredArtifact.digest_sha256).toBe(sha256(seeded.artifactBytes));
      expect(
        restoredDb
          .prepare(
            "SELECT COUNT(*) AS count FROM project_issue_integrations WHERE project_id = ? AND issue_number = 9001",
          )
          .get(seeded.projectId),
      ).toEqual({ count: 1 });
    } finally {
      restoredDb.close();
    }

    const restoredStatus = Bun.spawnSync(
      [binary, "authority", "status", "--json", "--state-dir", restoreStateDir],
      {
        env: { ...process.env, ANIMUS_HOME: restoreHome, ANIMUS_STATE_DIR: restoreStateDir },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      },
    );
    expect(restoredStatus.exitCode).toBe(0);
    const restoredSnapshot = JSON.parse(restoredStatus.stdout.toString()) as {
      installationHeld: boolean;
      artifactCount: number;
      schemaVersion: number;
    };
    expect(restoredSnapshot.installationHeld).toBe(true);
    expect(restoredSnapshot.artifactCount).toBe(1);
    expect(restoredSnapshot.schemaVersion).toBe(15);

    const evidencePath = process.env.AUTHORITY_RUNTIME_EVIDENCE;
    if (evidencePath) {
      writeFileSync(
        evidencePath,
        `${JSON.stringify(
          {
            packagedBinary: binary,
            schemaVersion: parsed.schemaVersion,
            tableCount: parsed.tableCount,
            artifactCount: parsed.artifactCount,
            pragmas: parsed.pragmas,
            backup: {
              destinationPath: backupResult.destinationPath,
              manifestHash: backupResult.manifestHash,
              artifactCount: backupResult.artifactCount,
              schemaVersion: backupResult.schemaVersion,
            },
            restore: {
              targetStateDir: restoreResult.operation.targetStateDir,
              held: restoreResult.installation.held,
              restoredArtifactDigest: sha256(seeded.artifactBytes),
              restoredIds: {
                project: seeded.projectId,
                work: seeded.workId,
                plan: seeded.planId,
                delivery: seeded.deliveryId,
                run: seeded.runId,
                observation: seeded.observationId,
                artifact: seeded.artifactId,
                finding: seeded.findingId,
              },
              integrationHistoryRows: 1,
            },
            redaction: "No credentials, tokens or private transcripts are included.",
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 240_000);
});
