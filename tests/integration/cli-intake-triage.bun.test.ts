import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { runIntakeCommand } from "../../scripts/cli/commands/operations";
import { runCli } from "../../scripts/cli/cli";
import type { RunTriagePassOptions, TriagePassResult } from "../../scripts/loop/triage";

describe("CLI animus intake triage", () => {
  let root: string;
  let checkout: string;
  let dbPath: string;
  let db: ReturnType<typeof initializeDatabase>;
  let registry: ProjectRegistryService;
  let brakes: BrakeService;
  let projectId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cli-intake-triage-"));
    checkout = join(root, "repo");
    mkdirSync(checkout);
    execFileSync("git", ["init", "--quiet", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      "https://github.com/owner/target-repo.git",
    ]);

    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    dbPath = join(stateDir, "console.db");
    db = initializeDatabase(dbPath);
    brakes = new BrakeService(db);
    const forge = new SyntheticForgeAdapter({ "owner/target-repo": 101 });
    registry = new ProjectRegistryService(db, forge);

    const project = await registry.registerProject({
      method: "local_checkout",
      name: "target-repo",
      checkout_path: checkout,
    });
    projectId = project.id;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  test("runs triage on registered project with real root, repo, stateRoot in human format", async () => {
    let capturedOptions: RunTriagePassOptions | undefined;
    const mockRunner = async (opts: RunTriagePassOptions): Promise<TriagePassResult> => {
      capturedOptions = opts;
      return {
        processed: [
          {
            issueNumber: 15,
            status: "promoted_single",
            action: "promote_single_ticket",
          },
        ],
        skippedCount: 0,
        successCount: 1,
        failureCount: 0,
        heldCount: 0,
      };
    };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        triageRunner: mockRunner,
      });

      expect(exitCode).toBe(0);
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions?.root).toBe(checkout);
      expect(capturedOptions?.repo).toBe("owner/target-repo");
      expect(capturedOptions?.dryRun).toBe(false);
      expect(capturedOptions?.issueNumber).toBeUndefined();

      const output = logs.join("\n");
      expect(output).toContain("Triage pass complete for owner/target-repo: 1 succeeded");
      expect(output).toContain("#15");
      expect(output).toContain("[promoted_single]");
    } finally {
      console.log = origLog;
    }
  });

  test("honors --issue flag and targets specific issue", async () => {
    let capturedOptions: RunTriagePassOptions | undefined;
    const mockRunner = async (opts: RunTriagePassOptions): Promise<TriagePassResult> => {
      capturedOptions = opts;
      return {
        processed: [
          {
            issueNumber: opts.issueNumber!,
            status: "clarification_requested",
            action: "ask_clarification",
          },
        ],
        skippedCount: 0,
        successCount: 1,
        failureCount: 0,
        heldCount: 0,
      };
    };

    const exitCode = await runIntakeCommand({
      subcommand: "triage",
      positionals: ["intake", "triage"],
      repoRoot: checkout,
      stateDir: join(root, "state"),
      issue: "42",
      triageRunner: mockRunner,
    });

    expect(exitCode).toBe(0);
    expect(capturedOptions?.issueNumber).toBe(42);
  });

  test("supports positional issue number argument", async () => {
    let capturedOptions: RunTriagePassOptions | undefined;
    const mockRunner = async (opts: RunTriagePassOptions): Promise<TriagePassResult> => {
      capturedOptions = opts;
      return {
        processed: [],
        skippedCount: 0,
        successCount: 0,
        failureCount: 0,
        heldCount: 0,
      };
    };

    const exitCode = await runIntakeCommand({
      subcommand: "triage",
      positionals: ["intake", "triage", "99"],
      repoRoot: checkout,
      stateDir: join(root, "state"),
      triageRunner: mockRunner,
    });

    expect(exitCode).toBe(0);
    expect(capturedOptions?.issueNumber).toBe(99);
  });

  test("honors --dry-run flag and outputs structured JSON with --json", async () => {
    let capturedOptions: RunTriagePassOptions | undefined;
    const mockRunner = async (opts: RunTriagePassOptions): Promise<TriagePassResult> => {
      capturedOptions = opts;
      return {
        processed: [
          {
            issueNumber: 10,
            status: "skipped",
            reason: "dry_run_simulation",
          },
        ],
        skippedCount: 1,
        successCount: 0,
        failureCount: 0,
        heldCount: 0,
      };
    };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        dryRun: true,
        json: true,
        triageRunner: mockRunner,
      });

      expect(exitCode).toBe(0);
      expect(capturedOptions?.dryRun).toBe(true);

      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(true);
      expect(parsed.skippedCount).toBe(1);
      expect(parsed.processed[0]?.issueNumber).toBe(10);
    } finally {
      console.log = origLog;
    }
  });

  test("honors BrakeService launch brake and exits code 1 with error details in JSON and human mode", async () => {
    brakes.setProjectLaunchBrake(projectId, true, "operator-brake");

    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.join(" "));

    try {
      // Human mode
      const exitCodeHuman = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
      });
      expect(exitCodeHuman).toBe(1);
      expect(errs.join("\n")).toContain("Triage blocked by brake: launch_brake_set");
    } finally {
      console.error = origErr;
    }

    // JSON mode
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCodeJson = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });
      expect(exitCodeJson).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("launch_brake_set");
      expect(parsed.error).toContain("launch_brake_set");
    } finally {
      console.log = origLog;
    }
  });

  test("honors BrakeService schedule pause and exits code 1", async () => {
    brakes.setGlobalSchedulePause(true, "operator-pause");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("schedule_paused");
    } finally {
      console.log = origLog;
    }
  });

  test("honors filesystem STOP and PAUSE brakes", async () => {
    mkdirSync(join(checkout, ".animus"), { recursive: true });
    writeFileSync(join(checkout, ".animus/STOP"), "stop");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("stop_brake_set");
      expect(parsed.error).toContain("STOP brake is active");
    } finally {
      console.log = origLog;
    }

    rmSync(join(checkout, ".animus/STOP"));
    writeFileSync(join(checkout, ".animus/PAUSE"), "pause");

    logs.length = 0;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("pause_brake_set");
      expect(parsed.error).toContain("PAUSE brake is active");
    } finally {
      console.log = origLog;
    }
  });

  test("honors work window in schedule.json", async () => {
    mkdirSync(join(checkout, ".animus"), { recursive: true });
    writeFileSync(
      join(checkout, ".animus/schedule.json"),
      JSON.stringify({
        work_window: { enabled: true, start_time: "00:00", end_time: "00:00", timezone: "UTC" },
      }),
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("outside_work_window");
      expect(parsed.error).toContain("Outside work window");
    } finally {
      console.log = origLog;
    }
  });

  test("returns exit code 1 with honest errors when triage pass fails", async () => {
    const mockFailingRunner = async (): Promise<TriagePassResult> => {
      return {
        processed: [
          {
            issueNumber: 7,
            status: "failed",
            error: "Failed to query issue metadata from forge",
          },
        ],
        skippedCount: 0,
        successCount: 0,
        failureCount: 1,
        heldCount: 0,
      };
    };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
        triageRunner: mockFailingRunner,
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.failureCount).toBe(1);
      expect(parsed.processed[0]?.error).toContain("Failed to query issue metadata from forge");
    } finally {
      console.log = origLog;
    }
  });

  test("runs end-to-end via runCli with flags", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      // When executed via runCli on a repo with .animus/STOP, returns exit code 1
      mkdirSync(join(checkout, ".animus"), { recursive: true });
      writeFileSync(join(checkout, ".animus/STOP"), "stop");

      const exitCode = await runCli([
        "intake",
        "triage",
        "--cwd",
        checkout,
        "--state-dir",
        join(root, "state"),
        "--json",
      ]);
      expect(exitCode).toBe(1);

      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("stop_brake_set");
    } finally {
      console.log = origLog;
    }
  });

  test("explicit state-dir missing console.db fails closed instead of bypassing registry/brakes", async () => {
    const emptyStateDir = join(root, "empty-state");
    mkdirSync(emptyStateDir, { recursive: true });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: emptyStateDir,
        json: true,
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("does not contain console.db");
    } finally {
      console.log = origLog;
    }
  });

  test("malformed schedule.json fails closed and reports error", async () => {
    mkdirSync(join(checkout, ".animus"), { recursive: true });
    writeFileSync(join(checkout, ".animus/schedule.json"), "invalid json {");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("invalid_schedule_config");
      expect(parsed.error).toContain("Malformed schedule config");
    } finally {
      console.log = origLog;
    }
  });

  test("invalid work window timezone fails closed and reports error", async () => {
    mkdirSync(join(checkout, ".animus"), { recursive: true });
    writeFileSync(
      join(checkout, ".animus/schedule.json"),
      JSON.stringify({
        work_window: {
          enabled: true,
          start_time: "09:00",
          end_time: "17:00",
          timezone: "Invalid/Fake_Zone",
        },
      }),
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Invalid timezone");
    } finally {
      console.log = origLog;
    }
  });

  test("primary checkout STOP brake blocks triage in linked worktree", async () => {
    // Create initial commit so we can add a worktree
    writeFileSync(join(checkout, "README.md"), "# Target Repo\n");
    execFileSync("git", ["-C", checkout, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ]);

    const worktreeDir = join(root, "worktree-1");
    execFileSync("git", ["-C", checkout, "worktree", "add", "-b", "feature", worktreeDir]);

    // Place STOP brake in primary checkout only
    mkdirSync(join(checkout, ".animus"), { recursive: true });
    writeFileSync(join(checkout, ".animus/STOP"), "stop in primary");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: worktreeDir,
        stateDir: join(root, "state"),
        json: true,
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe("stop_brake_set");
      expect(parsed.error).toContain("STOP brake is active in primary checkout");
    } finally {
      console.log = origLog;
    }
  });

  test("held or disabled project in registry does not run triage", async () => {
    db.prepare("UPDATE projects SET status = ?, status_reason = ? WHERE id = ?").run(
      "held",
      "manual_audit_required",
      projectId,
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("is not active (status: held");
    } finally {
      console.log = origLog;
    }
  });

  test("project origin mismatch against registry fails closed", async () => {
    // Change origin URL to point to a different repo
    execFileSync("git", [
      "-C",
      checkout,
      "remote",
      "set-url",
      "origin",
      "https://github.com/different-owner/other-repo.git",
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const exitCode = await runIntakeCommand({
        subcommand: "triage",
        positionals: ["intake", "triage"],
        repoRoot: checkout,
        stateDir: join(root, "state"),
        json: true,
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Project origin mismatch");
    } finally {
      console.log = origLog;
    }
  });
});
