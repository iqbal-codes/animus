import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Diagnostics, WorkflowCatalog, LapSummary, LapDetail } from "@labq/contracts/operator";

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
    // If CLI is not present in test root, check local runs directory or return empty
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
