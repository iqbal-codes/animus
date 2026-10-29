import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadPrompt, renderPrompt } from "./prompts";

export interface ManagerHealthAction {
  action: "released_expired_lock" | "pruned_abandoned_run" | "noticed_defect_harvested";
  target: string;
  reason: string;
}

export interface ManagerPassReport {
  timestamp: string;
  activeRunsCount: number;
  stuckRunsCount: number;
  actions: ManagerHealthAction[];
  noticedDefects: string[];
  metricsLine: string;
  prompt: string;
}

export async function runManagerPass(
  root: string,
  stateRoot = join(root, ".factory-local-loop"),
  expiryHours = 6,
): Promise<ManagerPassReport> {
  const timestamp = new Date().toISOString();
  const actions: ManagerHealthAction[] = [];
  const noticedDefects: string[] = [];

  const locksDir = join(stateRoot, "locks");
  const runsDir = join(stateRoot, "runs");

  let activeRunsCount = 0;
  let stuckRunsCount = 0;
  const now = Date.now();

  // 1. Sweep expired locks
  if (existsSync(locksDir)) {
    for (const lockEntry of readdirSync(locksDir)) {
      const lockPath = join(locksDir, lockEntry);
      try {
        const stats = statSync(lockPath);
        const ageHours = (now - stats.mtimeMs) / (1000 * 60 * 60);
        if (expiryHours === 0 || ageHours >= expiryHours) {
          await rm(lockPath, { recursive: true, force: true });
          actions.push({
            action: "released_expired_lock",
            target: lockEntry,
            reason: `Lock age (${ageHours.toFixed(1)}h) exceeded limit of ${expiryHours}h`,
          });
        }
      } catch {}
    }
  }

  // 2. Scan runs for metrics, stuck runs, and noticed defects
  let mergedCount = 0;
  let sendBacksCount = 0;
  let waitingApprovalCount = 0;

  if (existsSync(runsDir)) {
    for (const runId of readdirSync(runsDir)) {
      const stateFile = join(runsDir, runId, "state.json");
      if (!existsSync(stateFile)) continue;

      try {
        const state = JSON.parse(readFileSync(stateFile, "utf-8"));
        if (state.status === "preparing" || state.status === "building" || state.status === "checking") {
          activeRunsCount++;
          const stats = statSync(stateFile);
          if (now - stats.mtimeMs > 3 * 60 * 60 * 1000) {
            stuckRunsCount++;
          }
        } else if (state.status === "waiting_approval") {
          waitingApprovalCount++;
        } else if (state.status === "sent_back") {
          sendBacksCount++;
        }

        // Harvest noticed items from QA report
        const qaFile = join(runsDir, runId, "artifacts", "app-check.json");
        if (existsSync(qaFile)) {
          const qaReport = JSON.parse(readFileSync(qaFile, "utf-8"));
          if (Array.isArray(qaReport.noticed)) {
            for (const n of qaReport.noticed) {
              if (typeof n === "string" && !noticedDefects.includes(n)) {
                noticedDefects.push(n);
                actions.push({
                  action: "noticed_defect_harvested",
                  target: runId,
                  reason: n,
                });
              }
            }
          }
        }
      } catch {}
    }
  }

  // Canonical Archon loop metrics line
  const metricsLine = `${timestamp} | merged since last pass: ${mergedCount} | waiting approval: ${waitingApprovalCount} | send-backs: ${sendBacksCount} | active: ${activeRunsCount} | stuck: ${stuckRunsCount} | health actions: ${actions.length}`;

  const promptTemplate = loadPrompt("manage", root);
  const prompt = renderPrompt(
    promptTemplate,
    {
      runtime: "docs/runtime.md",
      holdout: ".factory/holdout/HOLDOUT.md",
    },
    join(stateRoot, "manager"),
  );

  return {
    timestamp,
    activeRunsCount,
    stuckRunsCount,
    actions,
    noticedDefects,
    metricsLine,
    prompt,
  };
}
