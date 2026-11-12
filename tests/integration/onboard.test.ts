import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MACHINE_CONFIG_SCHEMA_VERSION,
  MachineConfigSchemaError,
  MachineOnboardingRequiredError,
  assertMachineOnboarded,
  machineConfigPath,
  machineOnboardingStatus,
  readMachineConfig,
} from "@animus/contracts/machine-config";
import type { DetectedHarnessProvider } from "../../scripts/cli/commands/harness-detection";
import type { WizardChoice, WizardPrompts } from "../../scripts/cli/commands/onboarding-prompts";
import { onboardMachine, runOnboardCommand } from "../../scripts/cli/commands/onboard";

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const harnesses: DetectedHarnessProvider[] = [
  {
    id: "pi",
    displayName: "Pi",
    binaryName: "pi",
    installed: true,
    binaryPath: "/usr/local/bin/pi",
    version: "pi 1.2.3",
    status: "active",
    supportedEfforts: ["low", "medium", "high"],
  },
  {
    id: "claude",
    displayName: "Claude Code",
    binaryName: "claude",
    installed: false,
    binaryPath: null,
    version: null,
    status: "active",
    supportedEfforts: ["low", "high"],
  },
  {
    id: "codex",
    displayName: "Codex",
    binaryName: "codex",
    installed: false,
    binaryPath: null,
    version: null,
    status: "coming_soon",
    supportedEfforts: ["low", "high"],
  },
];

function runtimeRoot(): string {
  const root = tempRoot("animus-runtime-");
  mkdirSync(join(root, "apps/backend/src"), { recursive: true });
  mkdirSync(join(root, "apps/engine-host/src"), { recursive: true });
  writeFileSync(join(root, "apps/backend/src/main.ts"), "", "utf-8");
  writeFileSync(join(root, "apps/engine-host/src/main.ts"), "", "utf-8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { bun: "1.4.2" } }), "utf-8");
  return root;
}

function passingProbes(overrides: Record<string, unknown> = {}) {
  return {
    detectHarnesses: () => harnesses,
    runtimeRoot,
    portFree: async () => true,
    serviceHealthy: async () => false,
    exec: (cmd: string) => {
      if (cmd === "git") return { status: 0, stdout: "git version 2.43.0", stderr: "" };
      if (cmd === "gh") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "1.4.4", stderr: "" };
    },
    now: () => new Date("2026-11-12T10:00:00.000Z"),
    isTTY: false,
    ...overrides,
  };
}

class ScriptedPrompts implements WizardPrompts {
  questions: string[] = [];
  notes: string[] = [];
  constructor(
    private selects: string[],
    private answers: string[],
  ) {}

  async checkbox(_message: string, _choices: WizardChoice[], selected: string[]) {
    return selected;
  }

  async select(_message: string, choices: WizardChoice[]) {
    const next = this.selects.shift() ?? choices[0]!.value;
    return choices.some((choice) => choice.value === next) ? next : choices[0]!.value;
  }

  async text(message: string) {
    this.questions.push(message);
    return this.answers.shift() ?? "";
  }

  note(message: string) {
    this.notes.push(message);
  }

  close() {}
}

describe("machine onboarding", () => {
  test("writes detected providers, onboarding marker and runtime root to the machine config", async () => {
    const home = tempRoot("animus-home-");
    const root = runtimeRoot();

    const report = await onboardMachine(
      { home, nonInteractive: true, acceptUnverifiedAuth: true },
      passingProbes({ runtimeRoot: () => root }),
    );

    expect(report.ok).toBe(true);
    expect(report.configPath).toBe(machineConfigPath(home));
    expect(existsSync(report.configPath)).toBe(true);

    const written = readMachineConfig(home);
    expect(written?.schemaVersion).toBe(MACHINE_CONFIG_SCHEMA_VERSION);
    expect(written?.system.onboardedAt).toBe("2026-11-12T10:00:00.000Z");
    expect(written?.system.defaultProvider).toBe("pi");
    expect(written?.system.runtimeRoot).toBe(root);
    expect(written?.github.connected).toBe(true);
    expect(written?.providers.map((item) => item.id)).toEqual(["pi", "claude", "codex"]);
    expect(written?.providers.find((item) => item.id === "pi")).toMatchObject({
      path: "/usr/local/bin/pi",
      version: "pi 1.2.3",
      enabled: true,
      status: "INSTALLED",
    });
    expect(written?.providers.find((item) => item.id === "claude")).toMatchObject({
      path: "",
      enabled: false,
    });
    expect(written?.providers.find((item) => item.id === "codex")?.status).toBe("COMING SOON");
  });

  test("refuses to write configuration when GitHub authentication fails", async () => {
    const home = tempRoot("animus-home-");
    const report = await onboardMachine(
      { home, nonInteractive: true, acceptUnverifiedAuth: true },
      passingProbes({
        exec: (cmd: string) =>
          cmd === "gh"
            ? { status: 1, stdout: "", stderr: "not logged in" }
            : { status: 0, stdout: "1.4.4", stderr: "" },
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "gh-auth")).toMatchObject({ ok: false });
    expect(existsSync(machineConfigPath(home))).toBe(false);
  });

  test("refuses to write configuration when no harness binary is installed", async () => {
    const home = tempRoot("animus-home-");
    const report = await onboardMachine(
      { home, nonInteractive: true, acceptUnverifiedAuth: true },
      passingProbes({
        detectHarnesses: () =>
          harnesses.map((entry) => ({ ...entry, installed: false, binaryPath: null })),
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "providers")?.ok).toBe(false);
    expect(existsSync(machineConfigPath(home))).toBe(false);
  });

  test("requires explicit acceptance when harness sign-in cannot be verified", async () => {
    const home = tempRoot("animus-home-");
    const report = await onboardMachine({ home, nonInteractive: true }, passingProbes());

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "provider-auth")).toMatchObject({
      ok: false,
      blocking: true,
    });
    expect(existsSync(machineConfigPath(home))).toBe(false);
  });

  test("re-running preserves automation and GitHub credentials while refreshing detection", async () => {
    const home = tempRoot("animus-home-");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      machineConfigPath(home),
      JSON.stringify({
        schemaVersion: MACHINE_CONFIG_SCHEMA_VERSION,
        system: {
          onboardedAt: "2026-01-01T00:00:00.000Z",
          defaultProvider: "claude",
          runtimeRoot: "/old/runtime",
          remoteAccess: true,
          bindAddress: "10.0.0.5",
        },
        providers: [],
        automation: {
          parallelJobs: 4,
          maxLaps: 9,
          pollInterval: 60,
          continuations: 2,
          limitWorkWindow: false,
          startTime: "01:00",
          endTime: "02:00",
          timezone: "UTC",
          schedulePaused: true,
          globalBrake: true,
        },
        github: {
          appId: "123",
          pat: "ghp_secret",
          connected: false,
          lastChecked: "",
          appName: "",
          installationId: "",
        },
      }),
      "utf-8",
    );

    const report = await onboardMachine(
      { home, nonInteractive: true, acceptUnverifiedAuth: true },
      passingProbes(),
    );

    expect(report.ok).toBe(true);
    const written = readMachineConfig(home);
    expect(written?.automation).toMatchObject({ parallelJobs: 4, maxLaps: 9, globalBrake: true });
    expect(written?.github.pat).toBe("ghp_secret");
    expect(written?.github.appId).toBe("123");
    expect(written?.system.remoteAccess).toBe(true);
    expect(written?.system.bindAddress).toBe("10.0.0.5");
    expect(written?.system.defaultProvider).toBe("pi");
    expect(written?.providers.length).toBe(3);
  });

  test("records machine automation policy from flags", async () => {
    const home = tempRoot("animus-home-");
    const report = await onboardMachine(
      {
        home,
        nonInteractive: true,
        acceptUnverifiedAuth: true,
        maxLaps: 5,
        parallel: 3,
        intervalSeconds: 60,
        workWindow: "22:00-04:00",
      },
      passingProbes(),
    );

    expect(report.ok).toBe(true);
    expect(readMachineConfig(home)?.automation).toMatchObject({
      maxLaps: 5,
      parallelJobs: 3,
      pollInterval: 60,
      limitWorkWindow: true,
      startTime: "22:00",
      endTime: "04:00",
    });
  });

  test("rejects invalid automation policy without writing configuration", async () => {
    const home = tempRoot("animus-home-");
    const report = await onboardMachine(
      {
        home,
        nonInteractive: true,
        acceptUnverifiedAuth: true,
        maxLaps: 0,
        workWindow: "25:00-99:00",
      },
      passingProbes(),
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "automation")?.ok).toBe(false);
    expect(existsSync(machineConfigPath(home))).toBe(false);
  });

  test("interactive onboarding asks for laps, parallelism, interval and work window", async () => {
    const home = tempRoot("animus-home-");
    const prompts = new ScriptedPrompts(["confirm", "claude"], ["4", "2", "120", "off"]);
    const bothInstalled = harnesses.map((entry) =>
      entry.id === "claude"
        ? { ...entry, installed: true, binaryPath: "/usr/local/bin/claude" }
        : entry,
    );

    const report = await onboardMachine(
      { home },
      passingProbes({ prompts, isTTY: true, detectHarnesses: () => bothInstalled }),
    );

    expect(report.ok).toBe(true);
    expect(prompts.questions).toEqual([
      "Max laps per issue",
      "Parallel jobs",
      "Poll interval (seconds)",
      "Work window (HH:MM-HH:MM or off)",
    ]);
    const written = readMachineConfig(home);
    expect(written?.automation).toMatchObject({
      maxLaps: 4,
      parallelJobs: 2,
      pollInterval: 120,
      limitWorkWindow: false,
    });
    expect(written?.system.defaultProvider).toBe("claude");
  });

  test("machine config is written owner-only", async () => {
    const home = tempRoot("animus-home-");
    const report = await onboardMachine(
      { home, nonInteractive: true, acceptUnverifiedAuth: true },
      passingProbes(),
    );

    expect(report.ok).toBe(true);
    expect(statSync(report.configPath).mode & 0o777).toBe(0o600);
  });

  test("prints a machine-readable report for --json and a nonzero exit for blocked runs", async () => {
    const home = tempRoot("animus-home-");
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });

    const okCode = await runOnboardCommand(
      { home, json: true, nonInteractive: true, acceptUnverifiedAuth: true },
      passingProbes(),
    );
    expect(okCode).toBe(0);
    const payload = JSON.parse(logged.join("\n"));
    expect(payload).toMatchObject({ ok: true, defaultProvider: "pi" });
    expect(payload.providers).toEqual([
      { id: "pi", installed: true, version: "pi 1.2.3" },
      { id: "claude", installed: false, version: "" },
      { id: "codex", installed: false, version: "" },
    ]);

    logged.length = 0;
    const blockedCode = await runOnboardCommand(
      { home: tempRoot("animus-home-"), json: true, nonInteractive: true },
      passingProbes(),
    );
    expect(blockedCode).toBe(1);
    expect(JSON.parse(logged.join("\n")).ok).toBe(false);
  });
});

describe("machine onboarding gate", () => {
  test("reports missing, incomplete and outdated configs without failing open", () => {
    const home = tempRoot("animus-home-");
    expect(machineOnboardingStatus(home)).toMatchObject({
      onboarded: false,
      reason: "missing",
    });
    expect(() => assertMachineOnboarded(home)).toThrow(MachineOnboardingRequiredError);

    writeFileSync(machineConfigPath(home), JSON.stringify({ schemaVersion: 1 }), "utf-8");
    expect(machineOnboardingStatus(home)).toMatchObject({
      onboarded: false,
      reason: "incomplete",
    });

    writeFileSync(
      machineConfigPath(home),
      JSON.stringify({
        schemaVersion: MACHINE_CONFIG_SCHEMA_VERSION - 1,
        system: { onboardedAt: "2026-01-01T00:00:00.000Z" },
      }),
      "utf-8",
    );
    expect(machineOnboardingStatus(home)).toMatchObject({
      onboarded: false,
      reason: "schema_outdated",
    });
    expect(() => assertMachineOnboarded(home)).toThrow(MachineConfigSchemaError);

    writeFileSync(machineConfigPath(home), "{ not json", "utf-8");
    expect(machineOnboardingStatus(home)).toMatchObject({
      onboarded: false,
      reason: "unreadable",
    });
  });

  test("unblocks once onboarding has written the marker", async () => {
    const home = tempRoot("animus-home-");
    await onboardMachine(
      { home, nonInteractive: true, acceptUnverifiedAuth: true },
      passingProbes(),
    );

    expect(machineOnboardingStatus(home).onboarded).toBe(true);
    expect(assertMachineOnboarded(home).onboardedAt).toBe("2026-11-12T10:00:00.000Z");
    expect(readMachineConfig(home)?.system.onboardedAt).toBe("2026-11-12T10:00:00.000Z");
  });
});
