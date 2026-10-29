import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readDiagnostics, readControlState } from "../../../apps/engine-host/src/native";
import { checkArchitectureRules } from "../../health/check-architecture.mjs";

export interface DoctorCheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheckItem[];
}

export async function collectDoctorReport(repoRoot: string): Promise<DoctorReport> {
  const checks: DoctorCheckItem[] = [];

  // 1. Runtime check
  const runtimeVer =
    typeof Bun !== "undefined" ? `Bun v${Bun.version}` : `Node ${process.version}`;
  checks.push({
    name: "runtime",
    ok: true,
    detail: runtimeVer,
  });

  // 2. Git repository check
  const gitRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  const gitOk = gitRes.status === 0;
  checks.push({
    name: "git_repository",
    ok: gitOk,
    detail: gitOk ? `commit ${(gitRes.stdout || "").trim()}` : "not a valid git checkout",
  });

  // 3. Architecture boundary check
  try {
    const archRes = checkArchitectureRules(repoRoot);
    checks.push({
      name: "architecture_boundaries",
      ok: archRes.ok,
      detail: archRes.ok
        ? "packages/contracts, packages/client, apps/backend, apps/engine-host boundaries clean"
        : `${archRes.violations.length} violation(s) found`,
    });
  } catch (err: any) {
    checks.push({
      name: "architecture_boundaries",
      ok: false,
      detail: err?.message ?? "failed to run architecture check",
    });
  }

  // 4. Engine pack & workflow diagnostics
  try {
    const diag = readDiagnostics(repoRoot);
    checks.push({
      name: "engine_pack",
      ok: diag.status === "healthy" || existsSync(join(repoRoot, "factory/pack.json")),
      detail: `status=${diag.status} rev=${diag.revision_required.slice(0, 12)} files=${diag.file_count}`,
    });
  } catch (err: any) {
    checks.push({
      name: "engine_pack",
      ok: false,
      detail: err?.message ?? "native_source_unavailable",
    });
  }

  // 5. Operational brakes status
  try {
    const controls = readControlState(repoRoot);
    checks.push({
      name: "launch_brakes",
      ok: !controls.halted,
      detail: `active_brake=${controls.active_brake} (halted=${controls.halted}, paused=${controls.paused})`,
    });
  } catch (err: any) {
    checks.push({
      name: "launch_brakes",
      ok: false,
      detail: err?.message ?? "unable to read control state",
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

export async function runDoctorCommand(opts: {
  repoRoot: string;
  json?: boolean;
}): Promise<number> {
  const report = await collectDoctorReport(opts.repoRoot);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Factory Doctor Diagnostics:\n");
    for (const c of report.checks) {
      const badge = c.ok ? "[PASS]" : "[FAIL]";
      console.log(`  ${badge} ${c.name.padEnd(26)} ${c.detail}`);
    }
    console.log(`\nOverall: ${report.ok ? "HEALTHY" : "ISSUES DETECTED"}`);
  }
  return report.ok ? 0 : 1;
}
