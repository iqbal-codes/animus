import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCliArgs } from "../../scripts/cli/args";
import { renderHelp } from "../../scripts/cli/help";
import { runCli, formatVersionOutput } from "../../scripts/cli/cli";
import { runServeCommand } from "../../scripts/cli/commands/serve";
import {
  detectAvailableHarnesses,
  detectRepoCheckCommands,
} from "../../scripts/cli/commands/setup";
import { readArchonConfig } from "../../scripts/loop/config";
import { loadScheduleConfig } from "../../scripts/loop/scheduler";
import { FactoryLauncher } from "../../apps/launcher/src/launcher";

describe("LabQ Factory Unified CLI & Repository Setup Onboarding", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `factory-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("parses commands, subcommands, and setup/config flags cleanly", () => {
    const parsed = parseCliArgs([
      "setup",
      "--yes",
      "--provider",
      "claude",
      "--max-laps",
      "5",
      "--parallel",
      "2",
    ]);
    expect(parsed.command).toBe("setup");
    expect(parsed.values.yes).toBe(true);
    expect(parsed.values.provider).toBe("claude");
    expect(parsed.values["max-laps"]).toBe("5");
    expect(parsed.values.parallel).toBe("2");
  });

  test("renders global and command-scoped help tables cleanly", () => {
    const globalHelp = renderHelp();
    expect(globalHelp).toContain(
      "LabQ Factory CLI - Unified Backend, Engine-Host & Autonomous Loop Operator",
    );
    expect(globalHelp).toContain("setup [--yes] [options]");
    expect(globalHelp).toContain("config <show|audit|harnesses|tier|laps|harness|pattern|rule>");
    expect(globalHelp).toContain("serve [start|status|stop]");

    const setupHelp = renderHelp("setup");
    expect(setupHelp).toContain("setup [--yes] [options]");
    expect(setupHelp).toContain("labq-factory setup");
  });

  test("formats version output in text and JSON modes", () => {
    const textVer = formatVersionOutput(false);
    expect(textVer).toContain("labq-factory v");
    const jsonVer = JSON.parse(formatVersionOutput(true));
    expect(jsonVer.name).toBe("labq-factory");
    expect(jsonVer.version).toBeDefined();
  });

  test("detects available agent harnesses and repository verification commands", () => {
    const harnesses = detectAvailableHarnesses();
    expect(harnesses.length).toBe(5);
    expect(harnesses.map((h) => h.id)).toEqual(["pi", "claude", "omp", "codex", "opencode"]);
    expect(harnesses.find((h) => h.id === "omp")?.status).toBe("active");
    expect(harnesses.find((h) => h.id === "codex")?.status).toBe("coming_soon");
    expect(harnesses.find((h) => h.id === "opencode")?.status).toBe("coming_soon");

    // Simulate a Node/TypeScript repository in tempDir
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "sample-repo",
        scripts: {
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          test: "vitest run",
        },
      }),
    );
    const detected = detectRepoCheckCommands(tempDir);
    expect(detected.projectType).toBe("node");
    expect(detected.staticCheck).toBe("npm run lint && npm run typecheck");
    expect(detected.unitTest).toBe("npm run test");
  });

  test("labq-factory setup and config commands configure harness, model tiers, and max laps per repo", async () => {
    // 1. Run non-interactive setup on a fresh target repository
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "target-repo",
        scripts: { check: "bun run check", test: "bun test" },
      }),
    );
    writeFileSync(join(tempDir, "bun.lock"), "");

    const setupCode = await runCli([
      "setup",
      "--cwd",
      tempDir,
      "--yes",
      "--provider",
      "claude",
      "--max-laps",
      "4",
      "--parallel",
      "2",
      "--interval",
      "120",
      "--base-branch",
      "develop",
      "--work-window",
      "21:00-06:00",
      "--json",
    ]);
    expect(setupCode).toBe(0);

    // Verify .archon/config.yaml was created with claude tiers and develop baseBranch
    const archonCfg = readArchonConfig(tempDir);
    expect(archonCfg.assistant).toBe("claude");
    expect(archonCfg.tiers?.small?.provider).toBe("claude");
    expect(archonCfg.tiers?.medium?.model).toBe("claude-sonnet-4-5");
    expect(archonCfg.tiers?.large?.model).toBe("claude-opus-4-5");
    expect(archonCfg.worktree?.baseBranch).toBe("develop");

    // Verify .factory/schedule.json was created with max_laps=4, parallel=2, interval=120
    const schedCfg = loadScheduleConfig(tempDir);
    expect(schedCfg.max_laps).toBe(4);
    expect(schedCfg.parallel).toBe(2);
    expect(schedCfg.interval_seconds).toBe(120);
    expect(schedCfg.work_window?.enabled).toBe(true);
    expect(schedCfg.work_window?.start_time).toBe("21:00");
    expect(schedCfg.work_window?.end_time).toBe("06:00");

    // Verify harness/harness.config.json was created
    const harnessCfg = JSON.parse(
      readFileSync(join(tempDir, "harness/harness.config.json"), "utf-8"),
    );
    expect(harnessCfg.static).toBe("bun run check");
    expect(harnessCfg.unit).toBe("bun run test");

    // 2. Reconfigure a specific model tier via 'config tier'
    const tierCode = await runCli([
      "config",
      "tier",
      "large",
      "codex",
      "gpt-5.3-codex",
      "--effort",
      "xhigh",
      "--cwd",
      tempDir,
      "--json",
    ]);
    expect(tierCode).toBe(0);

    const updatedArchon = readArchonConfig(tempDir);
    expect(updatedArchon.tiers?.large?.provider).toBe("codex");
    expect(updatedArchon.tiers?.large?.model).toBe("gpt-5.3-codex");
    expect(updatedArchon.tiers?.large?.effort).toBe("xhigh");
    expect(updatedArchon.aliases?.["@reasoning"]?.model).toBe("gpt-5.3-codex");

    // 3. Reconfigure laps & capacity via 'config laps'
    const lapsCode = await runCli([
      "config",
      "laps",
      "--max-laps",
      "6",
      "--parallel",
      "3",
      "--cwd",
      tempDir,
      "--json",
    ]);
    expect(lapsCode).toBe(0);
    expect(loadScheduleConfig(tempDir).max_laps).toBe(6);
    expect(loadScheduleConfig(tempDir).parallel).toBe(3);

    // 4. Register a reusable component & codebase rule via CLI
    const compCode = await runCli([
      "config",
      "component",
      "datatable",
      "Use <DataTable /> for paginated lists or <SimpleTable /> for static detail views",
      "--cwd",
      tempDir,
      "--json",
    ]);
    expect(compCode).toBe(0);

    const ruleCode = await runCli([
      "config",
      "rule",
      "prefer-form-field",
      "--glob",
      "src/features/**/*Form*.tsx",
      "--forbid",
      "<input\\b",
      "--hint",
      "Use <FormField /> with useAppForm()",
      "--mode",
      "warn",
      "--cwd",
      tempDir,
      "--json",
    ]);
    expect(ruleCode).toBe(0);

    // 5. Inspect full config via 'config show' and 'config audit'
    const showCode = await runCli(["config", "show", "--cwd", tempDir, "--json"]);
    expect(showCode).toBe(0);

    const auditCode = await runCli(["config", "audit", "--cwd", tempDir, "--json"]);
    expect(auditCode).toBe(0);

    // Verify greenfield harness files were scaffolded automatically
    expect(existsSync(join(tempDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(tempDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".agents/skills/tdd/SKILL.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".claude/skills"))).toBe(true);
    expect(existsSync(join(tempDir, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(tempDir, ".factory/hooks/loop-guard.ts"))).toBe(true);
    expect(existsSync(join(tempDir, ".factory/codebase-rules.json"))).toBe(true);
    expect(existsSync(join(tempDir, ".factory/hooks/holdout_fence.py"))).toBe(true);
    expect(existsSync(join(tempDir, ".factory/holdout/HOLDOUT.md"))).toBe(true);
    expect(existsSync(join(tempDir, "harness/ci.ts"))).toBe(true);
  });

  test("brownfield repository with poor AGENTS.md is audited, backed up, and upgraded while preserving notes", async () => {
    // Create a poor/sparse AGENTS.md in a brownfield repo
    const poorAgentsContent = "# Old Repo Guide\nAlways use snake_case for database columns.\n";
    writeFileSync(join(tempDir, "AGENTS.md"), poorAgentsContent, "utf-8");

    const setupCode = await runCli(["setup", "--cwd", tempDir, "--yes", "--json"]);
    expect(setupCode).toBe(0);

    // Backup of original AGENTS.md must exist
    const backupPath = join(tempDir, ".factory/AGENTS.md.bak");
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf-8")).toBe(poorAgentsContent);

    // Upgraded AGENTS.md must include canonical pointers AND preserved project conventions
    const upgradedContent = readFileSync(join(tempDir, "AGENTS.md"), "utf-8");
    expect(upgradedContent).toContain(".agents/skills/");
    expect(upgradedContent).toContain(".factory/tool-guidance.json");
    expect(upgradedContent).toContain("## Project-Specific Conventions");
    expect(upgradedContent).toContain("Always use snake_case for database columns.");
    expect(upgradedContent.split("\n").length).toBeLessThanOrEqual(150);
  });

  test("executes engine catalog, doctor, and control commands via runCli", async () => {
    const codeCatalog = await runCli(["engine", "catalog", "--json"]);
    expect(codeCatalog).toBe(0);

    const codeDoctor = await runCli(["doctor", "--json"]);
    expect(codeDoctor).toBe(0);

    const codeControl = await runCli(["control", "status", "--json"]);
    expect(codeControl).toBe(0);
  });

  test("manages project registry and command ledger via CLI", async () => {
    const codeProjList = await runCli(["project", "list", "--state-dir", tempDir, "--json"]);
    expect(codeProjList).toBe(0);

    const codeCmdList = await runCli(["command", "list", "--state-dir", tempDir, "--json"]);
    expect(codeCmdList).toBe(0);

    const backupPath = join(tempDir, "backup.db");
    const codeBackup = await runCli([
      "command",
      "backup",
      backupPath,
      "--state-dir",
      tempDir,
      "--json",
    ]);
    expect(codeBackup).toBe(0);
    expect(existsSync(backupPath)).toBe(true);
  });

  test("serve command coordinates backend + engine-host and records runtime metadata", async () => {
    const code = await runServeCommand(
      {
        subcommand: "start",
        repoRoot: process.cwd(),
        stateDir: tempDir,
        port: 3100,
        json: true,
      },
      (opts) => {
        const launcher = new FactoryLauncher(opts);
        launcher.start = () => launcher.startSimulated({ backendOk: true, engineHostOk: true });
        return launcher;
      },
    );
    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "runtime.json"))).toBe(true);

    const stopCode = await runCli(["serve", "stop", "--state-dir", tempDir, "--json"]);
    expect(stopCode).toBe(0);
    expect(existsSync(join(tempDir, "runtime.json"))).toBe(false);
  });
});
