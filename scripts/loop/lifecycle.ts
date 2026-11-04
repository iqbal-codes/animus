import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateIssue } from "./prompt-context";
import {
  git,
  inspectLocalLoop,
  findExistingWorktreeForBranch,
  acquireIssueLock,
} from "./worktree";
import { readAnimusConfig } from "./config";
import { parsePartOf } from "../../apps/backend/src/intake/parser";
import { resolveAnimusHome, getProjectSlug } from "../../packages/contracts/src/paths";
import { setupArtifactDirectories } from "./artifacts";
import { loadIssueDossier } from "./dossier";
import { resolveVerificationProfile } from "./profiles";
import { loadScheduleConfig } from "./scheduler";
import { loadPrompt } from "./prompts";
import { processRun } from "./process";
import type { LocalIssue, LocalLoopOptions, LocalLoopResult, VerificationProfile } from "./types";

export interface ExistingPrInfo {
  url: string;
  number: number;
  headRefName: string;
}

export interface LoopLifecycleContext {
  runId: string;
  stateRoot: string;
  runDirectory: string;
  artifactsDir: string;
  handoffDir: string;
  base: string;
  baseBranch: string;
  defaultBaseBranch: string;
  defaultBaseSha: string;
  integrationBranch?: string;
  partOf?: number;
  hasOrigin: boolean;
  route: "simple" | "continue";
  existingPr: ExistingPrInfo | null;
  branch: string;
  worktree: string;
  existingWorktree: string | null;
  checks: string[];
  protectedPaths: string[];
  lap: number;
  initialProfile: VerificationProfile;
  releaseLock: () => Promise<void>;
  state: LocalLoopResult;
  save: () => Promise<void>;
  builderTemplate: string;
  qaTemplate: string;
  reviewerTemplate: string;
  scheduleCfg: ReturnType<typeof loadScheduleConfig>;
  maxLaps: number;
  maxRejections: number;
  timeout: number;
}

/**
 * Initializes the entire lifecycle preflight for an autonomous loop lap:
 * - Validates issue contract
 * - Inspects git worktree and brakes
 * - Resolves base branches and integration branches (handling partOf subtickets)
 * - Fetches remotes and detects existing PRs (setting route to continue vs simple)
 * - Allocates state directories, artifacts, and handoff folders
 * - Acquires exclusive issue lock
 * - Initializes run state object and atomic persistence
 * - Loads prompt templates and schedule bounds
 */
export async function setupLoopLifecycle(
  root: string,
  issue: LocalIssue,
  options: LocalLoopOptions = {},
): Promise<LoopLifecycleContext> {
  validateIssue(issue);
  const timeout = options.timeoutMs ?? 20 * 60_000;
  const { common } = await inspectLocalLoop(root);
  const animusConfig = readAnimusConfig(root);
  const defaultBaseBranch = options.baseBranch ?? animusConfig.worktree?.baseBranch ?? "main";
  const parsedPartOf = parsePartOf([issue.body, ...(issue.comments ?? [])].join("\n"));
  const partOf =
    parsedPartOf !== null && parsedPartOf > 0 && parsedPartOf !== issue.number
      ? parsedPartOf
      : undefined;
  const integrationBranch = partOf !== undefined ? `factory/spec-${partOf}-integration` : undefined;
  const baseBranch = integrationBranch ?? defaultBaseBranch;

  let remotes: string[] = [];
  try {
    const remotesOut = await git(root, "remote");
    remotes = remotesOut
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
  } catch {}
  const hasOrigin = remotes.includes("origin");

  let defaultBaseSha = "";
  if (hasOrigin) {
    try {
      await git(root, "fetch", "origin", defaultBaseBranch);
      defaultBaseSha = await git(root, "rev-parse", `origin/${defaultBaseBranch}`);

      // Fast-forward root defaultBaseBranch if root is clean and on defaultBaseBranch
      try {
        const currentBranch = await git(root, "symbolic-ref", "--short", "HEAD");
        if (currentBranch === defaultBaseBranch) {
          const status = await git(root, "status", "--porcelain");
          if (!status.trim()) {
            await git(root, "merge", "--ff-only", `origin/${defaultBaseBranch}`);
          }
        }
      } catch {}
    } catch {}
  }

  if (!defaultBaseSha) {
    try {
      defaultBaseSha = await git(root, "rev-parse", defaultBaseBranch);
    } catch {
      defaultBaseSha = await git(root, "rev-parse", "HEAD");
    }
  }

  let base = "";
  if (integrationBranch) {
    if (hasOrigin) {
      try {
        await git(root, "fetch", "origin", integrationBranch);
        base = await git(root, "rev-parse", `origin/${integrationBranch}`);
        await git(root, "update-ref", `refs/heads/${integrationBranch}`, base);
      } catch {}
    }
    if (!base) {
      try {
        base = await git(root, "rev-parse", "--verify", `refs/heads/${integrationBranch}`);
      } catch {
        await git(root, "update-ref", `refs/heads/${integrationBranch}`, defaultBaseSha);
        base = defaultBaseSha;
      }
    }
    if (hasOrigin && options.push !== false) {
      try {
        await git(root, "push", "-u", "origin", `${integrationBranch}:${integrationBranch}`);
      } catch {}
    }
  } else {
    base = defaultBaseSha;
  }

  const harnessConfigPath = join(root, "harness/harness.config.json");
  const config = existsSync(harnessConfigPath)
    ? await Bun.file(harnessConfigPath).json()
    : {};
  const checks = [config.static, config.unit].filter(
    (s): s is string => typeof s === "string" && !!s.trim(),
  );
  if (!checks.length) throw new Error("No declared ordinary project checks");
  const protectedPaths = [
    ".factory/holdout/**",
    ".factory/hooks/**",
    ".claude/settings.json",
    "harness/**",
    ...String(config.protected_paths ?? "")
      .split(",")
      .map((p: string) => p.trim())
      .filter(Boolean),
  ];

  // DISCOVERY & ROUTING: Check if an open PR already exists for this issue
  let existingPr: ExistingPrInfo | null = null;
  try {
    const prSearch = await processRun(
      ["gh", "pr", "list", "--state", "open", "--json", "number,url,headRefName,body"],
      root,
      30_000,
    );
    if (prSearch.exitCode === 0) {
      const openPrs = JSON.parse(prSearch.stdout);
      for (const pr of openPrs) {
        if (
          pr.headRefName?.includes(`issue-${issue.number}`) ||
          pr.body?.includes(`Closes #${issue.number}`) ||
          pr.body?.includes(`Refs #${issue.number}`)
        ) {
          existingPr = { url: pr.url, number: pr.number, headRefName: pr.headRefName };
          break;
        }
      }
    }
  } catch {}

  const route: "simple" | "continue" = existingPr ? "continue" : "simple";
  if (route === "continue" && hasOrigin && existingPr) {
    try {
      await git(root, "fetch", "origin", existingPr.headRefName);
      base = await git(
        root,
        "merge-base",
        `origin/${baseBranch}`,
        `origin/${existingPr.headRefName}`,
      );
    } catch {}
  }

  const runId = randomUUID();
  const stateRoot =
    process.env.ANIMUS_HOME || process.env.ANIMUS_STATE_DIR || process.env.ANIMUS_RUNS_DIR
      ? join(resolveAnimusHome(), "projects", getProjectSlug(root))
      : join(common, "factory-local-loop");
  const runDirectory = join(stateRoot, "runs", runId);
  const { artifactsDir, handoffDir } = await setupArtifactDirectories(runDirectory);
  const releaseLock = await acquireIssueLock(stateRoot, issue.number, {
    runId,
    pid: process.pid,
    issue: issue.url,
    route,
    pr: existingPr?.url ?? existingPr?.headRefName,
    runDirectory,
    startedAt: new Date().toISOString(),
  });

  const branch = existingPr
    ? existingPr.headRefName
    : `local-loop/issue-${issue.number}-${runId.slice(0, 8)}`;
  const existingWorktree = await findExistingWorktreeForBranch(root, branch);
  const dossier = loadIssueDossier(stateRoot, issue.number);
  const lap = (dossier?.attempts.length ?? 0) + 1;
  const initialProfile = issue.verificationProfile ?? resolveVerificationProfile(issue);
  const state: LocalLoopResult = {
    runId,
    pid: process.pid,
    lap,
    issue: issue.url,
    route,
    status: "preparing",
    runDirectory,
    worktree: existingWorktree ?? join(stateRoot, "worktrees", runId),
    branch,
    base,
    partOf,
    integrationBranch,
    pr: existingPr?.url,
    verificationProfile: initialProfile,
    evidence: [],
  };

  const save = async () => {
    await Bun.write(join(runDirectory, "state.tmp"), JSON.stringify(state, null, 2));
    await rename(join(runDirectory, "state.tmp"), join(runDirectory, "state.json"));
  };

  await Bun.write(join(runDirectory, "issue.json"), JSON.stringify(issue, null, 2));
  await save();

  // Dynamic prompt loading with modular fallback
  const builderTemplate = loadPrompt("loop-work", root);
  const qaTemplate = loadPrompt("loop-check-app", root);
  const reviewerTemplate = loadPrompt("loop-review", root);

  const scheduleCfg = loadScheduleConfig(root);
  const maxLaps = scheduleCfg.max_laps ?? 3;
  const maxRejections = Math.max(1, maxLaps - 1);

  return {
    runId,
    stateRoot,
    runDirectory,
    artifactsDir,
    handoffDir,
    base,
    baseBranch,
    defaultBaseBranch,
    defaultBaseSha,
    integrationBranch,
    partOf,
    hasOrigin,
    route,
    existingPr,
    branch,
    worktree: state.worktree,
    existingWorktree,
    checks,
    protectedPaths,
    lap,
    initialProfile,
    releaseLock,
    state,
    save,
    builderTemplate,
    qaTemplate,
    reviewerTemplate,
    scheduleCfg,
    maxLaps,
    maxRejections,
    timeout,
  };
}
