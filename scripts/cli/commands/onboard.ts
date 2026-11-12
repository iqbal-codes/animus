import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  MACHINE_CONFIG_SCHEMA_VERSION,
  machineConfigPath,
  providerItemSchema,
  readMachineConfig,
  writeMachineConfig,
  type PlatformSettings,
  type ProviderItem,
} from "@animus/contracts/machine-config";
import { resolveAnimusHome } from "@animus/contracts/paths";
import { PROVIDER_DESCRIPTORS, isSupportedProvider } from "../../loop/providers";
import { detectAvailableHarnesses, type DetectedHarnessProvider } from "./harness-detection";
import { TerminalWizardPrompts, type WizardPrompts } from "./onboarding-prompts";
import { resolveRuntimeRoot } from "../runtime-root";
import { parseWorkWindow } from "../work-window";
import { probeServiceHealth } from "./serve";

/** Minimum runtime used when `ANIMUS_SOURCE_ROOT` has no package.json to read. */
export const MINIMUM_BUN_VERSION = "1.4.2";
const BACKEND_PORT = 3000;
const ENGINE_PORT = 4001;

export interface OnboardCheck {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  fix?: string;
}

export interface OnboardReport {
  ok: boolean;
  checks: OnboardCheck[];
  configPath: string;
  config?: PlatformSettings;
}

export interface OnboardCommandOptions {
  home?: string;
  cwd?: string;
  nonInteractive?: boolean;
  json?: boolean;
  reconfigure?: boolean;
  acceptUnverifiedAuth?: boolean;
  provider?: string;
  maxLaps?: number;
  parallel?: number;
  intervalSeconds?: number;
  workWindow?: string;
}

export interface OnboardProbes {
  detectHarnesses?: () => DetectedHarnessProvider[];
  exec?: (
    cmd: string,
    args: string[],
  ) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  portFree?: (port: number) => Promise<boolean>;
  serviceHealthy?: (url: string) => Promise<boolean>;
  runtimeRoot?: () => string;
  now?: () => Date;
  prompts?: WizardPrompts;
  isTTY?: boolean;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function defaultExec(cmd: string, args: string[]): CommandResult {
  const res = spawnSync(cmd, args, { encoding: "utf-8", timeout: 5000 });
  return {
    status: res.status ?? (res.error ? -1 : 0),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? res.error.message : ""),
  };
}

async function defaultPortFree(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const server = createServer();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => {
    server.close(() => resolve(true));
  });
  return promise;
}

function compareVersions(actual: string, minimum: string): number {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(actual);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function requiredBunVersion(runtimeRoot: string | null): string {
  if (!runtimeRoot) return MINIMUM_BUN_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf-8")) as {
      engines?: { bun?: unknown };
    };
    const enginesBun = pkg.engines?.bun;
    if (typeof enginesBun === "string" && /^\d+\.\d+\.\d+$/.test(enginesBun)) return enginesBun;
  } catch {}
  return MINIMUM_BUN_VERSION;
}

function toProviderItem(detected: DetectedHarnessProvider, previous?: ProviderItem): ProviderItem {
  const descriptor = PROVIDER_DESCRIPTORS[detected.id];
  return providerItemSchema.parse({
    id: detected.id,
    name: detected.displayName,
    binary: detected.binaryName,
    path: detected.binaryPath ?? "",
    version: detected.version ?? "",
    efforts: descriptor.supportedEfforts.join(" · "),
    ...(previous?.capabilities ? { capabilities: previous.capabilities } : {}),
    status: descriptor.status === "active" ? "INSTALLED" : "COMING SOON",
    enabled: detected.installed,
    ...(previous?.apiKey ? { apiKey: previous.apiKey } : {}),
    ...(previous?.baseUrl ? { baseUrl: previous.baseUrl } : {}),
  });
}

/**
 * Collects machine prerequisites without writing anything. Every entry is a
 * real probe: presence is reported as presence, and authentication that cannot
 * be verified is never claimed as verified.
 */
export async function collectOnboardChecks(
  opts: OnboardCommandOptions = {},
  probes: OnboardProbes = {},
): Promise<OnboardCheck[]> {
  const exec = probes.exec ?? defaultExec;
  const checks: OnboardCheck[] = [];

  let runtimeRoot: string | null = null;
  try {
    runtimeRoot = probes.runtimeRoot ? probes.runtimeRoot() : resolveRuntimeRoot({ cwd: opts.cwd });
  } catch {
    runtimeRoot = null;
  }

  const requiredBun = requiredBunVersion(runtimeRoot);
  const bunActual =
    typeof Bun !== "undefined" && typeof Bun.version === "string"
      ? Bun.version
      : (() => {
          const res = exec("bun", ["--version"]);
          return res.status === 0 ? res.stdout.trim() : "";
        })();
  checks.push({
    id: "bun",
    label: "Bun runtime",
    ok: Boolean(bunActual) && compareVersions(bunActual, requiredBun) >= 0,
    blocking: true,
    detail: bunActual
      ? `${bunActual} (requires >= ${requiredBun})`
      : "not found on PATH; the Animus runtime is Bun-based",
    fix: "Install Bun >= 1.4.2: https://bun.sh",
  });

  const git = exec("git", ["--version"]);
  checks.push({
    id: "git",
    label: "Git",
    ok: git.status === 0,
    blocking: true,
    detail: git.status === 0 ? git.stdout.trim() : "not found on PATH",
    fix: "Install Git: https://git-scm.com",
  });

  const gh = exec("gh", ["auth", "status"]);
  checks.push({
    id: "gh-auth",
    label: "GitHub CLI auth",
    ok: gh.status === 0,
    blocking: true,
    detail:
      gh.status === 0
        ? "authenticated"
        : "not authenticated; label preparation, intake and publication will fail",
    fix: "Run `gh auth login`",
  });

  const home = resolveAnimusHome(opts.home);
  let homeDetail = home;
  let homeOk = true;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const probe = join(home, `.onboard-probe-${process.pid}`);
    writeFileSync(probe, "probe", { encoding: "utf-8", mode: 0o600 });
    rmSync(probe, { force: true });
  } catch (error) {
    homeOk = false;
    homeDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({
    id: "home",
    label: "Animus home writable",
    ok: homeOk,
    blocking: true,
    detail: homeDetail,
    fix: "Fix permissions or set ANIMUS_HOME to a writable directory",
  });

  checks.push({
    id: "runtime-root",
    label: "Runtime source tree",
    ok: runtimeRoot !== null,
    blocking: true,
    detail:
      runtimeRoot ?? "no checkout with apps/backend/src/main.ts and apps/engine-host/src/main.ts",
    fix: "Set ANIMUS_SOURCE_ROOT to an animus checkout, or run: git clone https://github.com/iqbal-codes/animus ~/.animus/source && cd ~/.animus/source && bun install --frozen-lockfile",
  });

  const detected = (probes.detectHarnesses ?? detectAvailableHarnesses)();
  const installed = detected.filter((entry) => entry.installed);
  checks.push({
    id: "providers",
    label: "Agent harness",
    ok: installed.length > 0,
    blocking: true,
    detail:
      installed.length > 0
        ? installed.map((entry) => entry.id).join(", ")
        : "no supported harness binary found on PATH",
    fix: "Install at least one harness (pi, claude, omp, commandcode)",
  });

  const portFree = probes.portFree ?? defaultPortFree;
  const healthy =
    probes.serviceHealthy ?? (async (url: string) => (await probeServiceHealth(url)).healthy);
  const backendFree = await portFree(BACKEND_PORT);
  const backendHealthy = backendFree ? true : await healthy(`http://127.0.0.1:${BACKEND_PORT}`);
  checks.push({
    id: "backend-port",
    label: `Backend port ${BACKEND_PORT}`,
    ok: backendFree || backendHealthy,
    blocking: true,
    detail: backendFree
      ? "free"
      : backendHealthy
        ? "already serving a healthy Animus backend"
        : "occupied by another process",
    fix: "Stop the process using the port, or run `animus status`",
  });

  // `animus start` allocates a dynamic engine port unless one is requested, so a
  // busy 4001 does not block startup; report it without failing the run.
  const engineFree = await portFree(ENGINE_PORT);
  checks.push({
    id: "engine-port",
    label: `Engine host port ${ENGINE_PORT}`,
    ok: engineFree,
    blocking: false,
    detail: engineFree ? "free" : "occupied; `animus start` will allocate a dynamic port",
  });

  return checks;
}

/**
 * Performs machine onboarding. Returns the same report the CLI prints so tests
 * and embedders can assert on it without parsing console output.
 */
export async function onboardMachine(
  opts: OnboardCommandOptions = {},
  probes: OnboardProbes = {},
): Promise<OnboardReport> {
  const home = resolveAnimusHome(opts.home);
  const existing = readMachineConfig(opts.home);
  const detected = (probes.detectHarnesses ?? detectAvailableHarnesses)();
  const installed = detected.filter((entry) => entry.installed);
  const now = (probes.now ?? (() => new Date()))();

  const checks = await collectOnboardChecks(opts, { ...probes, detectHarnesses: () => detected });
  const ghAuthenticated = checks.find((check) => check.id === "gh-auth")?.ok === true;

  // `onboard` owns the numbers the loop actually runs with. Flags and interactive
  // answers feed one block; the schedule cascade and per-repository setup inherit
  // it, so laps and parallelism are not configured in a second place.
  const automation = {
    ...(existing?.automation ?? {
      parallelJobs: 2,
      maxLaps: 3,
      pollInterval: 300,
      continuations: 1,
      limitWorkWindow: false,
      startTime: "20:00",
      endTime: "05:00",
      timezone: "Asia/Jakarta (UTC+7)",
      schedulePaused: false,
      globalBrake: false,
    }),
  };
  const automationProblems: string[] = [];
  const resolveCount = (
    label: string,
    raw: string | number | undefined,
    current: number,
  ): number => {
    if (raw === undefined) return current;
    const text = String(raw).trim();
    const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      automationProblems.push(`${label} must be a positive integer (received "${text}")`);
      return current;
    }
    return parsed;
  };
  automation.maxLaps = resolveCount("Max laps", opts.maxLaps, automation.maxLaps);
  automation.parallelJobs = resolveCount("Parallel jobs", opts.parallel, automation.parallelJobs);
  automation.pollInterval = resolveCount(
    "Poll interval",
    opts.intervalSeconds,
    automation.pollInterval,
  );
  let requestedWorkWindow = opts.workWindow;

  const interactive =
    !opts.nonInteractive &&
    !opts.json &&
    (probes.prompts !== undefined || (probes.isTTY ?? Boolean(process.stdin.isTTY)));

  const existingDefault = existing?.system.defaultProvider;
  let defaultProvider =
    opts.provider && isSupportedProvider(opts.provider)
      ? opts.provider
      : existingDefault &&
          isSupportedProvider(existingDefault) &&
          installed.some((entry) => entry.id === existingDefault)
        ? existingDefault
        : (installed[0]?.id ?? "pi");

  if (interactive) {
    const prompts = probes.prompts ?? new TerminalWizardPrompts();
    try {
      prompts.note(`Animus machine onboarding\nHome: ${home}`);
      if (installed.length > 0) {
        prompts.note(`Detected harnesses: ${installed.map((entry) => entry.id).join(", ")}`);
        const answer = await prompts.select(
          "Are all detected harnesses signed in?",
          [
            { value: "confirm", label: "All signed in" },
            { value: "cancel", label: "Stop; I will sign in first" },
          ],
          "confirm",
        );
        if (answer !== "confirm") {
          checks.push({
            id: "provider-auth",
            label: "Harness sign-in",
            ok: false,
            blocking: true,
            detail: "operator declined to confirm harness sign-in",
            fix: "Sign in to your harness, then re-run `animus onboard`",
          });
        } else {
          checks.push({
            id: "provider-auth",
            label: "Harness sign-in",
            ok: true,
            blocking: true,
            detail: `confirmed by operator: ${installed.map((entry) => entry.id).join(", ")}`,
          });
        }
      }
      if (opts.reconfigure || !existing) {
        const choice = await prompts.select(
          "Default harness",
          installed.map((entry) => ({ value: entry.id, label: entry.displayName })),
          defaultProvider,
        );
        if (isSupportedProvider(choice)) defaultProvider = choice;

        automation.maxLaps = resolveCount(
          "Max laps",
          await prompts.text("Max laps per issue", String(automation.maxLaps)),
          automation.maxLaps,
        );
        automation.parallelJobs = resolveCount(
          "Parallel jobs",
          await prompts.text("Parallel jobs", String(automation.parallelJobs)),
          automation.parallelJobs,
        );
        automation.pollInterval = resolveCount(
          "Poll interval",
          await prompts.text("Poll interval (seconds)", String(automation.pollInterval)),
          automation.pollInterval,
        );
        requestedWorkWindow = await prompts.text(
          "Work window (HH:MM-HH:MM or off)",
          automation.limitWorkWindow ? `${automation.startTime}-${automation.endTime}` : "off",
        );
      }
    } finally {
      prompts.close();
    }
  } else {
    checks.push({
      id: "provider-auth",
      label: "Harness sign-in",
      ok: opts.acceptUnverifiedAuth === true,
      blocking: true,
      detail: opts.acceptUnverifiedAuth
        ? "accepted as unverified (--accept-unverified-auth)"
        : "harness authentication cannot be verified automatically",
      fix: "Confirm sign-in interactively, or pass --accept-unverified-auth",
    });
  }

  if (requestedWorkWindow !== undefined) {
    try {
      const window = parseWorkWindow(requestedWorkWindow);
      if (window) {
        automation.limitWorkWindow = true;
        automation.startTime = window.start;
        automation.endTime = window.end;
      } else {
        automation.limitWorkWindow = false;
      }
    } catch (error) {
      automationProblems.push(error instanceof Error ? error.message : String(error));
    }
  }
  checks.push({
    id: "automation",
    label: "Automation policy",
    ok: automationProblems.length === 0,
    blocking: true,
    detail: automationProblems.length
      ? automationProblems.join("; ")
      : `${automation.maxLaps} laps, ${automation.parallelJobs} parallel, ${automation.pollInterval}s poll, work window ${automation.limitWorkWindow ? `${automation.startTime}-${automation.endTime}` : "off"}`,
    fix: "Use positive integers, and HH:MM-HH:MM or off for the work window",
  });

  const ok = checks.every((check) => check.ok || !check.blocking);
  if (!ok) return { ok: false, checks, configPath: machineConfigPath(opts.home) };

  const previousProviders = new Map(existing?.providers.map((item) => [item.id, item]) ?? []);
  const config: PlatformSettings = {
    schemaVersion: MACHINE_CONFIG_SCHEMA_VERSION,
    system: {
      ...(existing?.system ?? {
        remoteAccess: false,
        bindAddress: "127.0.0.1",
        vaultEnabled: true,
        hostOrigin: `http://127.0.0.1:${ENGINE_PORT}`,
        defaultProvider,
      }),
      defaultProvider,
      onboardedAt: now.toISOString(),
      ...((): { runtimeRoot?: string } => {
        try {
          const root = probes.runtimeRoot
            ? probes.runtimeRoot()
            : resolveRuntimeRoot({ cwd: opts.cwd });
          return { runtimeRoot: root };
        } catch {
          return {};
        }
      })(),
    },
    providers: detected.map((entry) => toProviderItem(entry, previousProviders.get(entry.id))),
    automation,
    github: {
      ...(existing?.github ?? {
        appId: "",
        appName: "",
        installationId: "",
        connected: false,
        lastChecked: "",
        pat: "",
        readyEvent: true,
        changeEvent: true,
        reviewEvent: true,
      }),
      connected: ghAuthenticated,
      lastChecked: now.toISOString(),
    },
  };

  writeMachineConfig(config, opts.home);
  return { ok: true, checks, configPath: machineConfigPath(opts.home), config };
}

function formatCheck(check: OnboardCheck): string {
  const status = check.ok ? "ok  " : check.blocking ? "FAIL" : "warn";
  const detail = check.detail ? ` — ${check.detail}` : "";
  const fix = !check.ok && check.fix ? `\n         fix: ${check.fix}` : "";
  return `  [${status}] ${check.label.padEnd(24)}${detail}${fix}`;
}

export async function runOnboardCommand(
  opts: OnboardCommandOptions = {},
  probes: OnboardProbes = {},
): Promise<number> {
  const report = await onboardMachine(opts, probes);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          configPath: report.configPath,
          onboardedAt: report.config?.system.onboardedAt,
          defaultProvider: report.config?.system.defaultProvider,
          providers: report.config?.providers.map((item) => ({
            id: item.id,
            installed: item.enabled,
            version: item.version,
          })),
          checks: report.checks,
        },
        null,
        2,
      ),
    );
    return report.ok ? 0 : 1;
  }

  console.log("Animus machine onboarding\n");
  console.log(`Home: ${resolveAnimusHome(opts.home)}\n`);
  for (const check of report.checks) console.log(formatCheck(check));

  if (!report.ok) {
    const failed = report.checks.filter((check) => !check.ok && check.blocking);
    console.error(
      `\nError: ${failed.length} blocking check${failed.length === 1 ? "" : "s"} failed. No configuration was written.`,
    );
    return 1;
  }

  const providers = report.config?.providers.filter((item) => item.enabled) ?? [];
  const ready = providers.filter((item) => item.status === "INSTALLED");
  const upcoming = providers.filter((item) => item.status === "COMING SOON");
  console.log(`\nOnboarded. Wrote ${report.configPath}`);
  console.log(`Providers: ${ready.map((item) => item.id).join(", ") || "none"}`);
  if (upcoming.length > 0) {
    console.log(`Coming soon: ${upcoming.map((item) => item.id).join(", ")}`);
  }
  console.log(`Default harness: ${report.config?.system.defaultProvider}`);
  console.log("\nNext:");
  console.log("  animus start                     # start backend, engine-host and console");
  console.log("  cd <repository> && animus setup  # configure one repository");
  return 0;
}
