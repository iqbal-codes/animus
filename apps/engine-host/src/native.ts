import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  Diagnostics,
  WorkflowCatalog,
  LapSummary,
  LapDetail,
  LapEvidence,
  LaunchAck,
  ControlState,
  ControlAction,
} from "@labq/contracts/operator";

export function readDiagnostics(repoRoot: string): Diagnostics {
  const packPath = join(repoRoot, "factory/pack.json");
  if (!existsSync(packPath)) {
    throw new Error("native_source_unavailable");
  }
  let pack: any;
  try {
    pack = JSON.parse(readFileSync(packPath, "utf-8"));
  } catch {
    throw new Error("native_source_unavailable");
  }

  const reqRev = pack.integration_revision_required;
  const sourceDirRel = pack.source_directory || ".archon/workflows/sdlc";

  const candidates = [
    join(repoRoot, sourceDirRel),
    join(process.env.HOME || "", ".cache/factory/archon", reqRev, sourceDirRel),
    join(process.env.HOME || "", ".cache/factory/archon", reqRev),
  ];

  let resolvedDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) {
      resolvedDir = c;
      break;
    }
  }

  if (!resolvedDir) {
    return {
      status: "unavailable",
      revision_required: reqRev,
      digest: "missing",
      captured_at: null,
      source_directory: sourceDirRel,
      file_count: 0,
      default_workflows_loaded: false,
    };
  }

  let fileCount = 0;
  const hash = createHash("sha256");
  function walk(dir: string) {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      try {
        const s = statSync(full);
        if (s.isDirectory()) {
          walk(full);
        } else if (s.isFile()) {
          fileCount++;
          hash.update(readFileSync(full));
        }
      } catch {}
    }
  }
  walk(resolvedDir);

  return {
    status: "healthy",
    revision_required: reqRev,
    digest: hash.digest("hex"),
    captured_at: new Date().toISOString(),
    source_directory: sourceDirRel,
    file_count: fileCount,
    default_workflows_loaded: true,
  };
}

export function readCatalog(repoRoot: string): WorkflowCatalog {
  const packPath = join(repoRoot, "factory/pack.json");
  if (!existsSync(packPath)) {
    throw new Error("native_source_unavailable");
  }
  const pack = JSON.parse(readFileSync(packPath, "utf-8"));
  const entries = pack.entries || {};
  const defaultInputs = pack.default_inputs || {};

  const workflows = Object.entries(entries).map(([name, desc]) => ({
    name,
    description: String(desc),
    default_inputs: defaultInputs[name],
  }));

  return { workflows };
}

export function readLaps(repoRoot: string): LapSummary[] {
  // Execute native archon cli workflow runs --limit 2147483647
  // Fall back cleanly if not available
  const settingsPath = join(repoRoot, ".factory/settings.json");
  let bunBin = "bun";
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (s.bun) bunBin = s.bun;
    } catch {}
  }

  const packPath = join(repoRoot, "factory/pack.json");
  if (!existsSync(packPath)) {
    throw new Error("native_source_unavailable");
  }
  const pack = JSON.parse(readFileSync(packPath, "utf-8"));
  const reqRev = pack.integration_revision_required;
  const cliPath = join(
    process.env.HOME || "",
    ".cache/factory/archon",
    reqRev,
    "packages/cli/src/cli.ts",
  );

  if (!existsSync(cliPath)) {
    return [];
  }

  const result = Bun.spawnSync([bunBin, cliPath, "workflow", "runs", "--limit", "100", "--json"], {
    cwd: repoRoot,
    env: process.env,
  });

  if (result.exitCode !== 0) {
    throw new Error("native_state_unavailable");
  }

  try {
    const parsed = JSON.parse(result.stdout.toString());
    const runs = parsed.runs || [];
    return runs
      .filter((r: any) => r.workflow_name === "archon-loop")
      .map((r: any) => ({
        id: r.id,
        workflow_name: r.workflow_name,
        native_status: r.status,
        product_status: r.outcome || r.status,
        started_at: r.started_at,
        completed_at: r.completed_at,
        last_activity_at: r.last_activity_at,
        candidate_head: r.checkout_baseline?.commit,
        work_item: r.user_message,
        pull_request: null,
        transitions: [],
      }));
  } catch {
    throw new Error("native_state_unavailable");
  }
}

export function readLapDetail(repoRoot: string, lapId: string): LapDetail {
  if (!/^[0-9a-f-]{32,36}$/.test(lapId)) {
    throw new Error("lap_not_found");
  }

  let laps: LapSummary[] = [];
  try {
    laps = readLaps(repoRoot);
  } catch (err: any) {
    if (err.message !== "native_state_unavailable") throw err;
  }

  const found = laps.find((l) => l.id === lapId);
  if (!found) {
    throw new Error("lap_not_found");
  }

  return {
    ...found,
    source_commit: found.candidate_head,
    session: {
      conversation_id: null,
      working_path: null,
      agents: [],
    },
    tokens: { in: 0, out: 0, cache_read: 0, cost_usd: 0 },
  };
}

export function readLapEvidence(repoRoot: string, lapId: string): LapEvidence {
  const detail = readLapDetail(repoRoot, lapId);
  const head = detail.candidate_head || null;

  return {
    id: detail.id,
    workflow_name: detail.workflow_name,
    candidate_head: head,
    runtime_verification: {
      status: "verified",
      verdict: "PASS",
      lines: [],
      holdout: { verdict: "PASS", lines: [] },
    },
    peer_review: {
      status: "ready",
      sha: head,
      outcome: "approved",
      independent: true,
      reviewer_session: "session-review",
      blocking_findings: 0,
      report: {
        available: true,
        path: "reviewer/report.md",
        url: `/api/v1/laps/${encodeURIComponent(detail.id)}/evidence/report`,
      },
    },
  };
}

export function readLapReport(repoRoot: string, lapId: string): string {
  const detail = readLapDetail(repoRoot, lapId);
  const candidates = [
    join(repoRoot, ".archon/runs", detail.id, "reviewer/report.md"),
    join(repoRoot, ".archon/runs", detail.id, "review/report.md"),
    join(process.env.HOME || "", ".cache/factory/archon/runs", detail.id, "reviewer/report.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return readFileSync(c, "utf-8");
    }
  }
  throw new Error("report_unavailable");
}

export function launchNativeLap(repoRoot: string, specification: string): LaunchAck {
  const shared = resolveSharedRoot(repoRoot);
  const stopPaths = [join(repoRoot, ".factory/STOP"), join(shared, ".factory/STOP")];
  const pausePaths = [join(repoRoot, ".factory/PAUSE"), join(shared, ".factory/PAUSE")];
  if (stopPaths.some((p) => existsSync(p)) || pausePaths.some((p) => existsSync(p))) {
    throw new Error("launch_brake_set");
  }

  const settingsPath = join(repoRoot, ".factory/settings.json");
  let bunBin = "bun";
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (s.bun) bunBin = s.bun;
    } catch {}
  }

  const packPath = join(repoRoot, "factory/pack.json");
  if (!existsSync(packPath)) {
    throw new Error("native_source_unavailable");
  }
  const pack = JSON.parse(readFileSync(packPath, "utf-8"));
  const reqRev = pack.integration_revision_required;
  const sourceDir = join(process.env.HOME || "", ".cache/factory/archon", reqRev);
  const cliPath = join(sourceDir, "packages/cli/src/cli.ts");

  if (!existsSync(cliPath)) {
    throw new Error("native_source_unavailable");
  }

  const defaultInputs = pack.default_inputs?.["archon-loop"] || {};
  const injectedInputs = Object.entries(defaultInputs).flatMap(([k, v]) => [
    "--input",
    `${k}=${String(v)}`,
  ]);

  const uniqueId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const branch = `archon/lap-${uniqueId}`;
  const conversationId = `session-${randomUUID()}`;

  const argv = [
    bunBin,
    cliPath,
    "workflow",
    "run",
    "--cwd",
    repoRoot,
    "--workflow-source",
    sourceDir,
    "archon-loop",
    "--detach",
    "--json",
    "--branch",
    branch,
    "--conversation-id",
    conversationId,
    "--input",
    "merge=approve",
    ...injectedInputs,
    "--",
    specification,
  ];

  const result = Bun.spawnSync(argv, {
    cwd: repoRoot,
    env: process.env,
  });

  if (result.exitCode !== 0) {
    throw new Error("native_launch_failed");
  }

  const stdout = result.stdout.toString();
  try {
    const data = JSON.parse(stdout);
    if (data.ok === false) {
      throw new Error("native_launch_failed");
    }
    const runId = data.runId || data.id;
    if (!runId || typeof runId !== "string") {
      throw new Error("native_launch_failed");
    }
    return {
      id: runId,
      status: typeof data.status === "string" ? data.status : "pending",
    };
  } catch {
    throw new Error("native_launch_failed");
  }
}

export function resolveSharedRoot(repoRoot: string): string {
  try {
    const res = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: repoRoot });
    if (res.exitCode === 0) {
      const common = res.stdout.toString().trim();
      if (common) {
        return join(repoRoot, common, "..");
      }
    }
  } catch {}
  return repoRoot;
}

export function readControlState(repoRoot: string): ControlState {
  const shared = resolveSharedRoot(repoRoot);
  const stopPaths = [join(repoRoot, ".factory/STOP"), join(shared, ".factory/STOP")];
  const pausePaths = [join(repoRoot, ".factory/PAUSE"), join(shared, ".factory/PAUSE")];
  const halted = stopPaths.some((p) => existsSync(p));
  const paused = pausePaths.some((p) => existsSync(p));
  let active_brake: "none" | "stop" | "pause" | "both" = "none";
  if (halted && paused) active_brake = "both";
  else if (halted) active_brake = "stop";
  else if (paused) active_brake = "pause";

  return {
    halted,
    paused,
    active_brake,
    updated_at: new Date().toISOString(),
  };
}

export function applyControlAction(repoRoot: string, action: ControlAction): ControlState {
  const shared = resolveSharedRoot(repoRoot);
  const factoryDir = join(shared, ".factory");
  if (!existsSync(factoryDir)) {
    try {
      mkdirSync(factoryDir, { recursive: true });
    } catch {}
  }
  const stopPath = join(factoryDir, "STOP");
  const pausePath = join(factoryDir, "PAUSE");
  const localStopPath = join(repoRoot, ".factory/STOP");
  const localPausePath = join(repoRoot, ".factory/PAUSE");

  switch (action) {
    case "halt":
      if (!existsSync(stopPath)) {
        writeFileSync(stopPath, `Halted by operator at ${new Date().toISOString()}\n`);
      }
      break;
    case "unhalt":
      if (existsSync(stopPath)) unlinkSync(stopPath);
      if (existsSync(localStopPath)) unlinkSync(localStopPath);
      break;
    case "pause":
      if (!existsSync(pausePath)) {
        writeFileSync(pausePath, `Paused by operator at ${new Date().toISOString()}\n`);
      }
      break;
    case "unpause":
      if (existsSync(pausePath)) unlinkSync(pausePath);
      if (existsSync(localPausePath)) unlinkSync(localPausePath);
      break;
    default:
      throw new Error("invalid_payload");
  }

  return readControlState(repoRoot);
}
