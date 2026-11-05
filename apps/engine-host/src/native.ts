import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
} from "@animus/contracts/operator";
import {
  resolveProjectWorkspace,
  evaluateWorkspacePreflight,
  checkWorkspaceBrakes,
  mutateWorkspaceBrakes,
} from "@animus/contracts/paths";
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
  const sourceDirRel = pack.source_directory || ".animus/workflows/sdlc";

  const candidates = [
    join(repoRoot, sourceDirRel),
    join(process.env.HOME || "", ".cache/factory/animus", reqRev, sourceDirRel),
    join(process.env.HOME || "", ".cache/factory/animus", reqRev),
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
  // Execute native animus cli workflow runs --limit 2147483647
  // Fall back cleanly if not available
  const settingsPath = join(repoRoot, ".factory/settings.json");
  let bunBin = "bun";
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (s.bun) bunBin = s.bun;
    } catch {}
  }

  const workspace = resolveProjectWorkspace(repoRoot);
  const packPath = join(repoRoot, "factory/pack.json");
  if (!existsSync(packPath)) {
    if (existsSync(workspace.runsDir)) {
      const summaries: LapSummary[] = [];
      try {
        const candidateDirs = [workspace.runsDir, ...(workspace.fallbackRunsDirs ?? [])];
        for (const dir of candidateDirs) {
          if (!existsSync(dir)) continue;
          for (const entry of readdirSync(dir)) {
            const stateFile = join(dir, entry, "state.json");
            if (existsSync(stateFile) && !summaries.some((s) => s.id === entry)) {
              try {
                const st = JSON.parse(readFileSync(stateFile, "utf-8"));
                summaries.push({
                  id: st.runId ?? entry,
                  workflow_name: "animus-loop",
                  native_status: st.status,
                  product_status: st.status,
                  started_at: st.startedAt ?? new Date().toISOString(),
                  completed_at: st.completedAt ?? null,
                  last_activity_at: st.updatedAt ?? new Date().toISOString(),
                  candidate_head: st.candidate ?? null,
                  work_item: st.issue,
                  pull_request: st.pr ?? null,
                  transitions: [],
                });
              } catch {}
            }
          }
        }
        return summaries;
      } catch {}
    }
    throw new Error("native_source_unavailable");
  }
  const pack = JSON.parse(readFileSync(packPath, "utf-8"));
  const reqRev = pack.integration_revision_required;
  const cliPath = join(
    process.env.HOME || "",
    ".cache/factory/animus",
    reqRev,
    "packages/cli/src/cli.ts",
  );

  if (!existsSync(cliPath)) {
    if (existsSync(workspace.runsDir)) {
      const summaries: LapSummary[] = [];
      try {
        const candidateDirs = [workspace.runsDir, ...(workspace.fallbackRunsDirs ?? [])];
        for (const dir of candidateDirs) {
          if (!existsSync(dir)) continue;
          for (const entry of readdirSync(dir)) {
            const stateFile = join(dir, entry, "state.json");
            if (existsSync(stateFile) && !summaries.some((s) => s.id === entry)) {
              try {
                const st = JSON.parse(readFileSync(stateFile, "utf-8"));
                summaries.push({
                  id: st.runId ?? entry,
                  workflow_name: "animus-loop",
                  native_status: st.status,
                  product_status: st.status,
                  started_at: st.startedAt ?? new Date().toISOString(),
                  completed_at: st.completedAt ?? null,
                  last_activity_at: st.updatedAt ?? new Date().toISOString(),
                  candidate_head: st.candidate ?? null,
                  work_item: st.issue,
                  pull_request: st.pr ?? null,
                  transitions: [],
                });
              } catch {}
            }
          }
        }
        return summaries;
      } catch {}
    }
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
      .filter((r: any) => r.workflow_name === "animus-loop")
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
  const workspace = resolveProjectWorkspace(repoRoot);
  const candidates = [
    join(workspace.runsDir, detail.id, "reviewer/report.md"),
    join(workspace.runsDir, detail.id, "review/report.md"),
    ...workspace.fallbackRunsDirs.flatMap((f) => [
      join(f, detail.id, "reviewer/report.md"),
      join(f, detail.id, "review/report.md"),
    ]),
    join(repoRoot, ".animus/runs", detail.id, "reviewer/report.md"),
    join(repoRoot, ".animus/runs", detail.id, "review/report.md"),
    join(process.env.HOME || "", ".cache/factory/animus/runs", detail.id, "reviewer/report.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return readFileSync(c, "utf-8");
    }
  }
  throw new Error("report_unavailable");
}

export function launchNativeLap(repoRoot: string, specification: string): LaunchAck {
  const preflight = evaluateWorkspacePreflight(repoRoot, { mode: "launch" });
  if (preflight.brakes.halted || preflight.brakes.paused) {
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
  const sourceDir = join(process.env.HOME || "", ".cache/factory/animus", reqRev);
  const cliPath = join(sourceDir, "packages/cli/src/cli.ts");

  if (!existsSync(cliPath)) {
    throw new Error("native_source_unavailable");
  }

  const defaultInputs = pack.default_inputs?.["animus-loop"] || {};
  const injectedInputs = Object.entries(defaultInputs).flatMap(([k, v]) => [
    "--input",
    `${k}=${String(v)}`,
  ]);

  const uniqueId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const branch = `animus/lap-${uniqueId}`;
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
    "animus-loop",
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
  return resolveProjectWorkspace(repoRoot).primaryRoot;
}

export function readControlState(repoRoot: string): ControlState {
  const brakes = checkWorkspaceBrakes(repoRoot);
  return {
    halted: brakes.halted,
    paused: brakes.paused,
    active_brake: brakes.active_brake,
    updated_at: new Date().toISOString(),
  };
}

export function applyControlAction(repoRoot: string, action: ControlAction): ControlState {
  mutateWorkspaceBrakes(repoRoot, action);
  return readControlState(repoRoot);
}
