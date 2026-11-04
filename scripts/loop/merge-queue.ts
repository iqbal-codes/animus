import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, assertCandidate, type AssertCandidateOptions } from "./worktree";
import { processRun } from "./process";
import { parsePartOf } from "../../apps/backend/src/intake/parser";
import type {
  AutoMergeEvaluationResult,
  AutoMergeExecutionResult,
  AutoMergeRiskLevel,
  CriticalImpactCategory,
  DiffImpactAnalysis,
  MergeQueuePlan,
  ReviewerReport,
} from "./types";
import { loadPrompt, renderPrompt } from "./prompts";

export type { AutoMergeExecutionResult };

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

export interface AnalyzeDiffImpactOptions {
  protectedPaths?: string[];
  maxBoundedFiles?: number;
}

export interface EvaluateSubticketAutoMergeParams {
  isSubticket: boolean;
  targetBranch: string;
  baseBranch: string;
  readinessReady: boolean;
  reviewerReport?: ReviewerReport;
  changedFiles: string[];
  diffContent?: string;
  protectedPaths?: string[];
  maxBoundedFiles?: number;
}

const DEFAULT_PROTECTED_PATHS = [
  "MISSION.md",
  "FACTORY_RULES.md",
  "FACTORY.md",
  ".claude/settings.json",
  "harness",
  ".factory/holdout",
  ".factory/hooks",
];

function extractDomainBucket(filePath: string): string | null {
  const normalized = filePath.replace(/^\.?\//, "");
  if (
    normalized.startsWith("tests/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized) ||
    normalized.startsWith("docs/")
  ) {
    return null;
  }
  const parts = normalized.split("/");
  if (parts.length >= 2 && (parts[0] === "apps" || parts[0] === "packages" || parts[0] === "scripts")) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

export function analyzeCriticalDiffImpact(
  changedFiles: string[],
  diffContent?: string,
  options: AnalyzeDiffImpactOptions = {},
): DiffImpactAnalysis {
  const protectedPatterns = options.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const maxBoundedFiles = options.maxBoundedFiles ?? 12;

  const categories = new Set<CriticalImpactCategory>();
  const reasons: string[] = [];

  const nonTestFiles = changedFiles.filter(
    (f) => !f.startsWith("tests/") && !/\.(test|spec)\.[cm]?[jt]sx?$/i.test(f),
  );

  // 1. Database / state migration / schema DDL
  const dbFiles = nonTestFiles.filter(
    (f) =>
      /(?:^|\/|_|-)(?:db|database|migration|migrations|schema|sqlite)(?:\/|_|-|\.|$)/i.test(f) ||
      /\.sql$/i.test(f),
  );
  const hasDdlInDiff =
    typeof diffContent === "string" &&
    /^\+.*\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+INDEX|DROP\s+INDEX|PRAGMA\s+user_version)\b/im.test(
      diffContent,
    );

  if (dbFiles.length > 0 || hasDdlInDiff) {
    categories.add("database_or_state_migration");
    const details = [
      ...(dbFiles.length > 0 ? [`files: ${dbFiles.join(", ")}`] : []),
      ...(hasDdlInDiff ? ["SQL DDL statements detected in diff"] : []),
    ].join("; ");
    reasons.push(`Database or state persistence impact detected (${details}).`);
  }

  // 2. Cross-domain refactor or shared contract mutation
  const sharedContractFiles = nonTestFiles.filter(
    (f) => f.startsWith("packages/contracts/") || f.startsWith("packages/client/"),
  );
  const touchedDomains = Array.from(
    new Set(changedFiles.map(extractDomainBucket).filter((d): d is string => Boolean(d))),
  );

  if (
    sharedContractFiles.length > 0 ||
    touchedDomains.length > 2 ||
    nonTestFiles.length > maxBoundedFiles
  ) {
    categories.add("cross_domain_or_shared_contract");
    if (sharedContractFiles.length > 0) {
      reasons.push(
        `Shared contract or client interface modified (${sharedContractFiles.join(", ")}).`,
      );
    }
    if (touchedDomains.length > 2) {
      reasons.push(
        `Cross-domain blast radius spans ${touchedDomains.length} domain modules (${touchedDomains.join(", ")}).`,
      );
    }
    if (nonTestFiles.length > maxBoundedFiles) {
      reasons.push(
        `Change modifies ${nonTestFiles.length} non-test files (exceeds bounded subticket limit of ${maxBoundedFiles}).`,
      );
    }
  }

  // 3. Security, auth, sanitization, or trust boundary
  const securityFiles = nonTestFiles.filter(
    (f) =>
      /(?:^|\/|_|-)(?:security|auth|sanitizer|permissions|holdout_fence|loop-guard)(?:\/|_|-|\.|$)/i.test(
        f,
      ) || f.startsWith(".factory/hooks/"),
  );
  if (securityFiles.length > 0) {
    categories.add("security_auth_or_trust_boundary");
    reasons.push(`Security, auth, or trust-boundary files modified (${securityFiles.join(", ")}).`);
  }

  // 4. Dependency, toolchain, CI workflow, or protected governance paths
  const infraFiles = changedFiles.filter(
    (f) =>
      /(?:^|\/)(?:package\.json|bun\.lock|package-lock\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|vite\.config\.ts|renovate\.json|Dockerfile|install\.sh)$/i.test(
        f,
      ) ||
      f.startsWith(".github/workflows/") ||
      isPathProtected(f, protectedPatterns),
  );
  if (infraFiles.length > 0) {
    categories.add("dependency_toolchain_or_infra");
    reasons.push(
      `Dependency, build toolchain, CI workflow, or protected path modified (${infraFiles.join(", ")}).`,
    );
  }

  const categoryList = Array.from(categories);
  return {
    hasCriticalImpact: categoryList.length > 0,
    categories: categoryList,
    reasons,
    touchedDomains,
  };
}

const RISK_ORDER: Record<AutoMergeRiskLevel, number> = {
  trivial: 0,
  low: 1,
  moderate: 2,
  high: 3,
};

export function evaluateSubticketAutoMerge(
  params: EvaluateSubticketAutoMergeParams,
): AutoMergeEvaluationResult {
  const {
    isSubticket,
    targetBranch,
    baseBranch,
    readinessReady,
    reviewerReport,
    changedFiles,
    diffContent,
    protectedPaths,
    maxBoundedFiles,
  } = params;

  const diffImpact = analyzeCriticalDiffImpact(changedFiles, diffContent, {
    protectedPaths,
    maxBoundedFiles,
  });

  const judgement = reviewerReport?.auto_merge_judgement;
  const reviewerImpacts: CriticalImpactCategory[] = judgement?.critical_impacts ?? [];
  const criticalImpacts = Array.from(new Set([...diffImpact.categories, ...reviewerImpacts]));

  const reviewerRisk: AutoMergeRiskLevel = judgement?.risk_level ?? "low";
  const deterministicMinRisk: AutoMergeRiskLevel = diffImpact.hasCriticalImpact ? "high" : "trivial";
  const riskLevel: AutoMergeRiskLevel =
    RISK_ORDER[reviewerRisk] >= RISK_ORDER[deterministicMinRisk]
      ? reviewerRisk
      : deterministicMinRisk;

  const scopeAligned = judgement ? judgement.scope_aligned : true;
  const reasons: string[] = [...diffImpact.reasons];

  const isIntegrationTarget =
    isSubticket &&
    targetBranch !== baseBranch &&
    /^factory\/spec-\d+-integration$/.test(targetBranch);

  if (!isIntegrationTarget) {
    reasons.push(
      `Auto-merge is restricted to subticket PRs targeting a spec integration branch (current target: '${targetBranch}').`,
    );
  }

  if (!readinessReady) {
    reasons.push("Host readiness verification did not pass all quality, QA, CI, and review gates.");
  }

  const outcome = reviewerReport?.outcome;
  if (outcome !== "merge") {
    reasons.push(
      `Reviewer outcome is '${outcome ?? "unknown"}' (requires 'merge' for automatic integration landing).`,
    );
  }

  if (judgement) {
    if (!judgement.eligible) {
      reasons.push(
        `Reviewer marked PR ineligible for auto-merge${judgement.rationale ? `: ${judgement.rationale}` : "."}`,
      );
    }
    if (!judgement.scope_aligned) {
      reasons.push("Reviewer detected changes outside the bounded subticket contract scope.");
    }
    if (judgement.risk_level === "moderate" || judgement.risk_level === "high") {
      reasons.push(
        `Reviewer rated change risk as '${judgement.risk_level}' (only 'trivial' or 'low' risk subtickets may auto-merge).`,
      );
    }
    if (reviewerImpacts.length > 0) {
      reasons.push(
        `Reviewer flagged critical impact categories requiring human review: ${reviewerImpacts.join(", ")}.`,
      );
    }
  }

  const authorized =
    isIntegrationTarget &&
    readinessReady &&
    criticalImpacts.length === 0 &&
    outcome === "merge" &&
    scopeAligned &&
    (riskLevel === "trivial" || riskLevel === "low") &&
    (judgement ? judgement.eligible === true : true);

  return {
    authorized,
    decision: authorized ? "auto_merge" : "hold_for_human",
    isSubticket,
    targetBranch,
    baseBranch,
    riskLevel,
    scopeAligned,
    criticalImpacts,
    deterministicImpacts: diffImpact.categories,
    reviewerImpacts,
    reasons,
    rationale: judgement?.rationale || reviewerReport?.reason,
  };
}

export interface ExecuteSubticketAutoMergeOptions {
  root: string;
  candidate: string;
  integrationBranch: string;
  targetBaseTip: string;
  worktree: string;
  issueNumber: number;
  partOf?: number;
  defaultBaseBranch: string;
  pr?: string;
  hasOrigin?: boolean;
  push?: boolean;
  autoMergeEval: AutoMergeEvaluationResult;
  assertCandidateFn?: (options: AssertCandidateOptions) => Promise<unknown> | unknown;
  gitFn?: typeof git;
  processRunFn?: typeof processRun;
  parsePartOfFn?: (text: string) => number | null;
}

/**
 * Execute subticket auto-merge mechanics:
 * 1. Verifies candidate commit integrity via assertCandidate.
 * 2. Checks integration branch drift fail-closed (must match targetBaseTip).
 * 3. Updates target integration branch ref with candidate commit.
 * 4. Merges PR via gh pr merge --squash --match-head-commit.
 * 5. Pushes updated integration branch to origin and closes GitHub subticket issue.
 * 6. Checks remaining open sibling subtickets; creates final parent integration PR when all complete.
 */
export async function executeSubticketAutoMerge(
  options: ExecuteSubticketAutoMergeOptions,
): Promise<AutoMergeExecutionResult> {
  const {
    root,
    candidate,
    integrationBranch,
    targetBaseTip,
    worktree,
    issueNumber,
    partOf,
    defaultBaseBranch,
    pr,
    hasOrigin,
    push,
    autoMergeEval,
  } = options;

  const gitCmd = options.gitFn ?? git;
  const processCmd = options.processRunFn ?? processRun;
  const assertCandidateCmd = options.assertCandidateFn ?? assertCandidate;
  const parsePartOfCmd = options.parsePartOfFn ?? parsePartOf;

  let finalIntegrationPr: string | undefined;

  try {
    await assertCandidateCmd({
      root,
      worktree,
      expectedCandidate: candidate,
      base: targetBaseTip,
    });
    const currentIntTip = (
      await gitCmd(root, "rev-parse", `refs/heads/${integrationBranch}`)
    ).trim();
    if (currentIntTip !== targetBaseTip) {
      throw new Error(
        `Integration branch '${integrationBranch}' drifted from '${targetBaseTip}' to '${currentIntTip}' during verification; holding for human merge.`,
      );
    }

    const rootHeadBranch = await gitCmd(root, "symbolic-ref", "--short", "HEAD").catch(() => "");
    if (rootHeadBranch === integrationBranch) {
      await gitCmd(root, "merge", "--ff-only", candidate);
    } else {
      await gitCmd(
        root,
        "update-ref",
        `refs/heads/${integrationBranch}`,
        candidate,
        targetBaseTip,
      );
    }

    if (push !== false) {
      if (pr) {
        await processCmd(
          ["gh", "pr", "merge", pr, "--squash", "--match-head-commit", candidate],
          worktree,
          30_000,
        ).catch(() => {});
      }
      if (hasOrigin) {
        await gitCmd(
          root,
          "push",
          "origin",
          `refs/heads/${integrationBranch}:refs/heads/${integrationBranch}`,
        ).catch(() => {});
      }
      await processCmd(
        [
          "gh",
          "issue",
          "close",
          String(issueNumber),
          "--comment",
          `Auto-merged into integration branch \`${integrationBranch}\` at commit \`${candidate}\`.`,
        ],
        worktree,
        15_000,
      ).catch(() => {});

      if (partOf !== undefined) {
        try {
          const openIssuesRes = await processCmd(
            ["gh", "issue", "list", "--state", "open", "--json", "number,body"],
            root,
            15_000,
          );
          if (openIssuesRes.exitCode === 0) {
            const openIssues = JSON.parse(openIssuesRes.stdout) as Array<{
              number: number;
              body?: string;
            }>;
            const remainingSiblings = openIssues.filter(
              (i) =>
                i.number !== issueNumber &&
                i.number !== partOf &&
                parsePartOfCmd(i.body ?? "") === partOf,
            );
            if (remainingSiblings.length === 0) {
              const existingFinalPr = await processCmd(
                [
                  "gh",
                  "pr",
                  "list",
                  "--state",
                  "open",
                  "--head",
                  integrationBranch,
                  "--base",
                  defaultBaseBranch,
                  "--json",
                  "url",
                ],
                root,
                15_000,
              );
              let finalPrUrl: string | undefined;
              if (existingFinalPr.exitCode === 0) {
                const parsedPrs = JSON.parse(existingFinalPr.stdout) as Array<{ url?: string }>;
                finalPrUrl = parsedPrs[0]?.url;
              }
              if (!finalPrUrl) {
                const createFinal = await processCmd(
                  [
                    "gh",
                    "pr",
                    "create",
                    "--base",
                    defaultBaseBranch,
                    "--head",
                    integrationBranch,
                    "--title",
                    `feat(spec-${partOf}): integrated delivery for spec #${partOf}`,
                    "--body",
                    `Closes #${partOf}\n\nAll subticket PRs for spec #${partOf} have been verified and integrated into \`${integrationBranch}\`. Ready for human review.`,
                  ],
                  root,
                  30_000,
                );
                if (createFinal.exitCode === 0) {
                  finalPrUrl = createFinal.stdout.trim();
                }
              }
              if (finalPrUrl) {
                finalIntegrationPr = finalPrUrl;
              }
            }
          }
        } catch {}
      }
    }

    return {
      success: true,
      evaluation: autoMergeEval,
      finalStatus: "merged",
      reviewOutcome: "merged",
      finalIntegrationPr,
    };
  } catch (mergeErr: unknown) {
    const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    const updatedEval: AutoMergeEvaluationResult = {
      ...autoMergeEval,
      authorized: false,
      decision: "hold_for_human",
      reasons: [...autoMergeEval.reasons, msg],
    };
    return {
      success: false,
      evaluation: updatedEval,
      finalStatus: "waiting_approval",
      reviewOutcome: "approved",
      error: msg,
    };
  }
}

