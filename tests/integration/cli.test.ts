import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
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
import { readAnimusConfig } from "../../scripts/loop/config";
import { loadScheduleConfig } from "../../scripts/loop/scheduler";
import { FactoryLauncher } from "../../apps/launcher/src/launcher";

describe("Animus Unified CLI & Repository Setup Onboarding", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `factory-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    execFileSync("git", ["init", "--quiet", tempDir]);
    execFileSync("git", [
      "-C",
      tempDir,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/target-repo.git",
    ]);
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
      "Animus CLI - Unified Backend, Engine-Host & Autonomous Loop Operator",
    );
    expect(globalHelp).toContain("setup [--yes] [options]");
    expect(globalHelp).toContain("config <show|audit|harnesses|tier|laps|harness|pattern|rule>");
    expect(globalHelp).toContain("serve [start|status|stop]");

    const setupHelp = renderHelp("setup");
    expect(setupHelp).toContain("setup [--yes] [options]");
    expect(setupHelp).toContain("animus setup");
  });

  test("formats version output in text and JSON modes", () => {
    const textVer = formatVersionOutput(false);
    expect(textVer).toContain("animus v");
    const jsonVer = JSON.parse(formatVersionOutput(true));
    expect(jsonVer.name).toBe("animus");
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

  test("animus setup and config commands configure harness, model tiers, and max laps per repo", async () => {
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
      "--local-only",
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

    // Verify .animus/config.yaml was created with claude tiers and develop baseBranch
    const animusCfg = readAnimusConfig(tempDir);
    expect(animusCfg.assistant).toBe("claude");
    expect(animusCfg.tiers?.small?.provider).toBe("claude");
    expect(animusCfg.tiers?.medium?.model).toBe("default");
    expect(animusCfg.tiers?.large?.model).toBe("default");
    expect(animusCfg.worktree?.baseBranch).toBe("develop");

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

    // Verify .pi/settings.json and .omp/settings.json were created
    expect(existsSync(join(tempDir, ".pi/settings.json"))).toBe(true);
    expect(existsSync(join(tempDir, ".omp/settings.json"))).toBe(true);
    const piSettings = JSON.parse(readFileSync(join(tempDir, ".pi/settings.json"), "utf-8"));
    expect(piSettings.extensions).toContain("./.factory/hooks/loop-guard.ts");
    const ompSettings = JSON.parse(readFileSync(join(tempDir, ".omp/settings.json"), "utf-8"));
    expect(ompSettings.extensions).toContain("./.factory/hooks/loop-guard.ts");

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

    const updatedAnimus = readAnimusConfig(tempDir);
    expect(updatedAnimus.tiers?.large?.provider).toBe("codex");
    expect(updatedAnimus.tiers?.large?.model).toBe("gpt-5.3-codex");
    expect(updatedAnimus.tiers?.large?.effort).toBe("xhigh");
    expect(updatedAnimus.aliases?.["@reasoning"]?.model).toBe("gpt-5.3-codex");

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
    expect(existsSync(join(tempDir, ".agents/skills/animus-brainstorm/SKILL.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".agents/skills/animus-grill/SKILL.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".agents/skills/animus-architecture/SKILL.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".agents/skills/security-hardening/SKILL.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".agents/skills/animus-harness/SKILL.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".agents/skills/animus-learn/SKILL.md"))).toBe(true);
    expect(existsSync(join(tempDir, "docs/agents/issue-tracker.md"))).toBe(true);
    expect(existsSync(join(tempDir, "docs/agents/domain.md"))).toBe(true);
    expect(existsSync(join(tempDir, "docs/agents/pr-evidence-contract.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".claude/skills"))).toBe(true);
    expect(existsSync(join(tempDir, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(tempDir, ".factory/hooks/loop-guard.ts"))).toBe(true);
    expect(existsSync(join(tempDir, ".factory/codebase-rules.json"))).toBe(true);
    expect(existsSync(join(tempDir, ".factory/hooks/holdout_fence.py"))).toBe(true);
    expect(existsSync(join(tempDir, ".factory/holdout/HOLDOUT.md"))).toBe(true);
    expect(existsSync(join(tempDir, "harness/ci.ts"))).toBe(true);
  });

  test("brownfield repository with existing AGENTS.md keeps it untouched by default and supports explicit --agents-md overwrite", async () => {
    const existingAgents = "# Existing Repo Guide\nAlways use snake_case for database columns.\n";
    writeFileSync(join(tempDir, "AGENTS.md"), existingAgents, "utf-8");

    const setupCode = await runCli(["setup", "--cwd", tempDir, "--yes", "--local-only", "--json"]);
    expect(setupCode).toBe(0);

    expect(readFileSync(join(tempDir, "AGENTS.md"), "utf-8")).toBe(existingAgents);
    expect(existsSync(join(tempDir, ".factory/AGENTS.md.bak"))).toBe(false);

    const overwriteCode = await runCli([
      "setup",
      "--cwd",
      tempDir,
      "--yes",
      "--local-only",
      "--agents-md",
      "overwrite",
      "--json",
    ]);
    expect(overwriteCode).toBe(0);

    const backupPath = join(tempDir, ".factory/AGENTS.md.bak");
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf-8")).toBe(existingAgents);
    const newAgents = readFileSync(join(tempDir, "AGENTS.md"), "utf-8");
    expect(newAgents).toContain(".agents/skills/");
  });

  test("animus setup fails closed before writing files when .git or GitHub origin remote is missing", async () => {
    const noGitDir = join(
      tmpdir(),
      `factory-nogit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(noGitDir, { recursive: true, mode: 0o700 });

    const gitlabDir = join(
      tmpdir(),
      `factory-gitlab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(gitlabDir, { recursive: true, mode: 0o700 });
    execFileSync("git", ["init", "--quiet", gitlabDir]);
    execFileSync("git", [
      "-C",
      gitlabDir,
      "remote",
      "add",
      "origin",
      "https://gitlab.com/acme/repo.git",
    ]);

    try {
      const noGitCode = await runCli([
        "setup",
        "--cwd",
        noGitDir,
        "--yes",
        "--local-only",
        "--json",
      ]);
      expect(noGitCode).toBe(1);
      expect(existsSync(join(noGitDir, ".animus"))).toBe(false);

      const gitlabCode = await runCli([
        "setup",
        "--cwd",
        gitlabDir,
        "--yes",
        "--local-only",
        "--json",
      ]);
      expect(gitlabCode).toBe(1);
      expect(existsSync(join(gitlabDir, ".animus"))).toBe(false);
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
      rmSync(gitlabDir, { recursive: true, force: true });
    }
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
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:3000/api/v1/projects");
      expect(init?.method).toBe("GET");
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const codeProjList = await runCli([
        "project",
        "list",
        "--factory-url",
        "http://127.0.0.1:3000",
        "--state-dir",
        tempDir,
        "--json",
      ]);
      expect(codeProjList).toBe(0);
      expect(fetch).toHaveBeenCalledOnce();
      expect(existsSync(join(tempDir, "console.db"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }

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
