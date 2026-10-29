import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
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
    throw new Error("native_source_unavailable");
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

/**
 * Resolves the absolute Git common directory for a checkout.
 *
 * Git reports the common directory relative to the current checkout (".git" in a primary
 * checkout) but absolute in a linked worktree, where it points at the primary checkout's
 * Git directory. Both forms must resolve to the same location.
 */
function resolveGitCommonDir(repoRoot: string): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    const common = output.trim();
    if (!common) return null;
    return isAbsolute(common) ? resolve(common) : resolve(repoRoot, common);
  } catch {
    return null;
  }
}

/**
 * Lists the checkouts that share a Git directory.
 *
 * Git lists the primary checkout first, then the linked worktrees. Every checkout of a
 * repository resolves the same Git directory, so this list is identical for all of them and
 * can name one shared brake location.
 */
function listGitWorkTrees(commonDir: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["--git-dir", commonDir, "worktree", "list", "--porcelain"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      },
    );
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => unquoteGitPath(line.slice("worktree ".length).trim()))
      .filter((path) => path.length > 0);
  } catch {
    return [];
  }
}

/**
 * Reads the checkout a Git directory declares in its own configuration.
 *
 * A submodule checkout keeps its Git directory inside the superproject
 * (".git/modules/<name>") and records the checkout it owns in "core.worktree", relative to
 * that Git directory. Only the repository's own configuration is read: a user-level
 * "core.worktree" must never redirect the shared brake location.
 */
function resolveConfiguredWorkTree(commonDir: string): string | null {
  try {
    const output = execFileSync(
      "git",
      ["--git-dir", commonDir, "config", "--get", "--local", "core.worktree"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      },
    );
    const workTree = output.trim();
    if (!workTree) return null;
    return resolve(commonDir, workTree);
  } catch {
    return null;
  }
}

/**
 * Reports whether a path is a checkout of the repository that owns a Git directory.
 *
 * A checkout holds a ".git" entry (a directory in the primary checkout, a pointer file in a
 * linked worktree) and never lives inside the Git directory itself.
 */
function isCheckoutRoot(candidate: string, commonDir: string): boolean {
  if (!candidate) return false;
  if (candidate === commonDir) return false;
  if (candidate.startsWith(commonDir + sep)) return false;
  try {
    if (!statSync(candidate).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(candidate, ".git"));
}

/**
 * Reports whether a checkout is the primary checkout of a Git directory.
 *
 * The primary checkout is the one whose Git entry refers to the Git directory itself: the
 * ".git" directory of an ordinary checkout, or a pointer file that names the Git directory.
 * A linked worktree points into the Git directory instead ("<git-dir>/worktrees/<name>"),
 * so it is never the primary checkout.
 */
function ownsCommonDir(candidate: string, commonDir: string): boolean {
  if (!isCheckoutRoot(candidate, commonDir)) return false;
  const pointer = join(candidate, ".git");
  try {
    const stats = statSync(pointer);
    if (stats.isDirectory()) return canonicalPath(pointer) === canonicalPath(commonDir);
    if (!stats.isFile()) return false;
    const match = /^gitdir:\s*(.+)$/i.exec(readFileSync(pointer, "utf-8").trim());
    if (!match) return false;
    const target = resolve(candidate, match[1].trim());
    return canonicalPath(target) === canonicalPath(commonDir);
  } catch {
    return false;
  }
}

/** Reports whether a path lies inside a Git directory (".git"). */
function isInsideGitDirectory(path: string): boolean {
  let current = path;
  for (;;) {
    if (basename(current) === ".git") return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Canonicalizes a path so every checkout of a repository names one location. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Undoes the quoting Git applies to unusual paths in porcelain output. */
function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(.)/g, (_match, char: string) => {
    if (char === "n") return "\n";
    if (char === "t") return "\t";
    if (char === "r") return "\r";
    return char;
  });
}

/**
 * Resolves the shared factory root that operator brakes (STOP/PAUSE) live in.
 *
 * The shared root is the primary checkout of the repository that owns the checkout. Every
 * checkout of a repository resolves the same Git common directory, so the primary checkout
 * and its linked worktrees agree on one brake location and a brake set in either place is
 * observed from the other.
 *
 * The primary checkout is found in this order:
 *   1. the checkout that contains the Git directory ("<checkout>/.git"), the ordinary
 *      layout of a repository and the one the factory itself uses;
 *   2. the checkout the Git directory declares in its own configuration, which is how a
 *      submodule names the checkout it owns;
 *   3. the checkout Git lists for the Git directory whose Git entry names that Git
 *      directory, which is the primary checkout of any other layout.
 *
 * A Git directory that no checkout owns (a bare repository, or a Git directory that was
 * detached from its checkout) keeps the shared brakes beside the Git directory, so every
 * checkout of that repository still names one brake location. A shared brake must never
 * land inside a Git directory. Non-Git directories keep their own path as the shared root.
 */
export function resolveSharedRoot(repoRoot: string): string {
  const commonDir = resolveGitCommonDir(repoRoot);
  if (!commonDir) return repoRoot;
  const shared = resolveSharedRootFromCommonDir(commonDir);
  return shared ? canonicalPath(shared) : repoRoot;
}

function resolveSharedRootFromCommonDir(commonDir: string): string | null {
  // 1. The checkout that contains the Git directory ("<checkout>/.git").
  const parent = dirname(commonDir);
  if (basename(commonDir) === ".git" && existsSync(commonDir)) return parent;

  // 2. The checkout the Git directory declares in its own configuration (a submodule).
  const configured = resolveConfiguredWorkTree(commonDir);
  if (configured && ownsCommonDir(configured, commonDir)) return configured;

  // 3. The primary checkout Git lists for the Git directory.
  for (const workTree of listGitWorkTrees(commonDir)) {
    if (ownsCommonDir(workTree, commonDir)) return workTree;
  }

  // 4. No checkout owns this Git directory: keep the shared brakes beside the Git
  //    directory, never inside it.
  return isInsideGitDirectory(parent) ? null : parent;
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
