import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeQueuePlan } from "./types";
import { loadPrompt, renderPrompt } from "./prompts";

export interface AssessBatchOptions {
  method?: "merge" | "squash" | "rebase";
  protectedPaths?: string[];
  base?: string;
}

export function isPathProtected(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const cleanPattern = pattern.replace(/^\//, "").replace(/\*\*$/, "");
    if (path.startsWith(cleanPattern) || path === pattern) {
      return true;
    }
  }
  return false;
}

export function assessMergeBatchDeterministic(
  repo: string,
  baseBranch: string,
  liveBaseSha: string,
  candidates: { number: number; url: string; headSha: string; changedFiles: string[]; reviewApproved: boolean }[],
  options: AssessBatchOptions = {},
): MergeQueuePlan {
  const method = options.method ?? "squash";
  const protectedPatterns = options.protectedPaths ?? [
    "MISSION.md",
    "FACTORY_RULES.md",
    "FACTORY.md",
    ".claude/settings.json",
    "harness",
    ".factory/holdout",
  ];

  const reasons: string[] = [];
  const validPulls: { number: number; url: string; head_sha: string }[] = [];

  for (const pr of candidates) {
    if (!pr.reviewApproved) {
      reasons.push(`PR #${pr.number} lacks verified independent review approval.`);
      continue;
    }

    const protectedFilesTouched = pr.changedFiles.filter((f) => isPathProtected(f, protectedPatterns));
    if (protectedFilesTouched.length > 0) {
      reasons.push(
        `PR #${pr.number} modifies protected path (${protectedFilesTouched.join(", ")}): human merge required.`,
      );
      continue;
    }

    validPulls.push({
      number: pr.number,
      url: pr.url,
      head_sha: pr.headSha,
    });
  }

  const eligible = reasons.length === 0 && validPulls.length > 0;

  return {
    repository: repo,
    base: baseBranch,
    base_sha: liveBaseSha,
    method,
    pull_requests: validPulls,
    evidence: [],
    reasons,
    eligible,
  };
}

export async function generateMergePlan(
  root: string,
  candidates: { number: number; url: string; headSha: string; changedFiles: string[]; reviewApproved: boolean }[],
  options: AssessBatchOptions = {},
): Promise<{ plan: MergeQueuePlan; prompt: string }> {
  const configPath = join(root, "harness/harness.config.json");
  let protectedPaths = [
    "MISSION.md",
    "FACTORY_RULES.md",
    "FACTORY.md",
    ".claude/settings.json",
    "harness",
    ".factory/holdout",
  ];

  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.protected_paths) {
        protectedPaths = [...protectedPaths, ...String(cfg.protected_paths).split(",").map((s) => s.trim())];
      }
    } catch {}
  }

  const plan = assessMergeBatchDeterministic(
    "animus",
    options.base ?? "main",
    "HEAD",
    candidates,
    { ...options, protectedPaths },
  );

  const promptTemplate = loadPrompt("assess-merge-queue", root);
  const prompt = renderPrompt(
    promptTemplate,
    {
      prs: candidates.map((c) => c.url).join(", "),
      merge_method: plan.method,
      publish_holds: "false",
      ci_policy: "enforced",
      path_policy: "enforced",
    },
    join(root, ".factory-local-loop/merge-queue"),
  );

  return { plan, prompt };
}
