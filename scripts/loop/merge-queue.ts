import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git, assertCandidate, type AssertCandidateOptions } from "./worktree";
import { resolveAnimusStateDir } from "../../packages/contracts/src/paths";
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
import { assertInstallationNotHeldAtStateDir } from "../../apps/backend/src/restore/hold";

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

  const reasons: string[] = [...diffImpact.reasons];
  if (!judgement) {
    reasons.push(
      "Reviewer auto-merge judgement is missing; auto-merge requires explicit reviewer evaluation.",
    );
  }

  const reviewerRisk: AutoMergeRiskLevel = judgement?.risk_level ?? "high";
  const deterministicMinRisk: AutoMergeRiskLevel = diffImpact.hasCriticalImpact ? "high" : "trivial";
  const riskLevel: AutoMergeRiskLevel =
    RISK_ORDER[reviewerRisk] >= RISK_ORDER[deterministicMinRisk]
      ? reviewerRisk
      : deterministicMinRisk;

  const scopeAligned = judgement ? judgement.scope_aligned : false;

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
    Boolean(judgement) &&
    judgement?.eligible === true &&
    isIntegrationTarget &&
    readinessReady &&
    criticalImpacts.length === 0 &&
    outcome === "merge" &&
    scopeAligned &&
    (riskLevel === "trivial" || riskLevel === "low");

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
  db?: DatabaseSync;
  dbPath?: string;
  projectId?: string;
}

export interface RecordSubticketIntegrationOptions {
  root: string;
  issueNumber: number;
  branch: string;
  candidate: string;
  partOf?: number;
  finalIntegrationPr?: string;
  db?: DatabaseSync;
  dbPath?: string;
  projectId?: string;
}

/**
 * Record verified subticket integration into SQLite project_issue_integrations
 * and synchronize project_spec_coordinations truth when a project DB is attached.
 */
export function recordSubticketIntegration(
  options: RecordSubticketIntegrationOptions,
): { integrated: boolean; projectId?: string; error?: string } {
  const { root, issueNumber, branch, candidate, partOf, finalIntegrationPr } = options;

  let db = options.db;
  let shouldClose = false;
  let dbAttached = Boolean(options.db || options.dbPath);

  if (!db) {
    let resolvedDbPath = options.dbPath;
    if (!resolvedDbPath) {
      const candidates = [join(resolveAnimusStateDir(), "console.db")];
      for (const cand of candidates) {
        if (existsSync(cand)) {
          resolvedDbPath = cand;
          break;
        }
      }
    }
    if (resolvedDbPath) {
      if (options.dbPath) {
        dbAttached = true;
      }
      if (existsSync(resolvedDbPath)) {
        try {
          db = new DatabaseSync(resolvedDbPath);
          shouldClose = true;
        } catch (err: any) {
          return {
            integrated: false,
            error: `Failed to open attached SQLite database at ${resolvedDbPath}: ${err.message}`,
          };
        }
      } else if (options.dbPath) {
        return {
          integrated: false,
          error: `Attached database at ${options.dbPath} does not exist`,
        };
      }
    }
  }

  if (!db) {
    if (dbAttached) {
      return {
        integrated: false,
        error: `Attached database does not exist or could not be opened`,
      };
    }
    return { integrated: false };
  }

  try {
    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='project_issue_integrations'",
      )
      .get() as { name?: string } | undefined;

    if (!tableExists) {
      if (dbAttached) {
        return {
          integrated: false,
          error: "Database attached but project_issue_integrations table does not exist",
        };
      }
      return { integrated: false };
    }

    let projectId = options.projectId;
    if (!projectId) {
      try {
        const projectsTable = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
          .get();
        if (projectsTable) {
          const allProjects = db
            .prepare("SELECT id, checkout_path FROM projects")
            .all() as Array<{ id: string; checkout_path: string }>;
          const match = allProjects.find(
            (p) => resolve(p.checkout_path) === resolve(root),
          );
          if (match) {
            projectId = match.id;
          }
        }
      } catch (err: any) {
        if (dbAttached) {
          return {
            integrated: false,
            error: `Failed to query projects table in attached database: ${err.message}`,
          };
        }
      }
    }

    if (!projectId) {
      if (dbAttached) {
        return {
          integrated: false,
          error: `Database attached but could not resolve projectId for root ${root}`,
        };
      }
      return { integrated: false };
    }

    db.exec("SAVEPOINT subticket_integration");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO project_issue_integrations (project_id, issue_number, branch, commit_sha, integrated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, issue_number) DO UPDATE SET
         branch = excluded.branch,
         commit_sha = excluded.commit_sha,
         integrated_at = excluded.integrated_at`,
    ).run(projectId, issueNumber, branch, candidate, now);

    // Synchronize project_spec_coordinations truth if spec coordination row exists
    if (partOf !== undefined) {
      try {
        const coordTable = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='project_spec_coordinations'",
          )
          .get();
        if (coordTable) {
          const coordRow = db
            .prepare(
              "SELECT * FROM project_spec_coordinations WHERE project_id = ? AND spec_issue_number = ?",
            )
            .get(projectId, partOf) as any;

          if (coordRow && coordRow.plan_snapshot) {
            const plan = JSON.parse(coordRow.plan_snapshot);
            plan.currentIntegrationSha = candidate;
            if (Array.isArray(plan.children)) {
              for (const child of plan.children) {
                if (child.number === issueNumber) {
                  child.status = "integrated_to_branch";
                  child.commitSha = candidate;
                }
              }
            }
            let prNum: number | null = null;
            if (finalIntegrationPr) {
              const prMatch = finalIntegrationPr.match(/\/pull\/(\d+)/);
              prNum = prMatch ? parseInt(prMatch[1]!, 10) : (partOf ?? 1);
              if (prNum <= 0) prNum = partOf ?? 1;
              plan.status = "completed";
              plan.finalPullRequest = {
                number: prNum,
                url: finalIntegrationPr,
                title: `Integrated delivery for spec #${partOf}`,
                head: branch,
                base: plan.baseBranch ?? "main",
              };
            }
            const columns = db
              .prepare("PRAGMA table_info(project_spec_coordinations)")
              .all() as Array<{ name: string }>;
            const hasPrNumber = columns.some((c) => c.name === "final_pr_number");

            if (hasPrNumber) {
              db.prepare(
                `UPDATE project_spec_coordinations
                 SET current_integration_sha = ?,
                     plan_snapshot = ?,
                     final_pr_number = COALESCE(?, final_pr_number),
                     final_pr_url = COALESCE(?, final_pr_url),
                     status = CASE WHEN ? IS NOT NULL THEN 'completed' ELSE status END,
                     updated_at = ?
                 WHERE project_id = ? AND spec_issue_number = ?`,
              ).run(
                candidate,
                JSON.stringify(plan),
                prNum,
                finalIntegrationPr ?? null,
                finalIntegrationPr ?? null,
                now,
                projectId,
                partOf,
              );
            } else {
              db.prepare(
                `UPDATE project_spec_coordinations
                 SET current_integration_sha = ?,
                     plan_snapshot = ?,
                     final_pr_url = COALESCE(?, final_pr_url),
                     status = CASE WHEN ? IS NOT NULL THEN 'completed' ELSE status END,
                     updated_at = ?
                 WHERE project_id = ? AND spec_issue_number = ?`,
              ).run(
                candidate,
                JSON.stringify(plan),
                finalIntegrationPr ?? null,
                finalIntegrationPr ?? null,
                now,
                projectId,
                partOf,
              );
            }
          }
        }
      } catch (err: any) {
        throw err;
      }
    }

    db.exec("RELEASE SAVEPOINT subticket_integration");
    return { integrated: true, projectId };
  } catch (err: any) {
    try {
      db.exec("ROLLBACK TO SAVEPOINT subticket_integration");
      db.exec("RELEASE SAVEPOINT subticket_integration");
    } catch {}
    if (dbAttached) {
      return {
        integrated: false,
        error: `SQLite integration record write failed: ${err.message}`,
      };
    }
    return { integrated: false };
  } finally {
    if (shouldClose && db) {
      try {
        db.close();
      } catch {}
    }
  }
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
  assertInstallationNotHeldAtStateDir();
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
  const journalDir = join(resolveAnimusStateDir(), "integration-recovery");
  const journalPath = join(journalDir, `${crypto.randomUUID()}.json`);
  const journal = {
    root, candidate, integrationBranch, targetBaseTip, issueNumber, partOf, pr,
    phase: "prepared", updatedAt: new Date().toISOString(), error: undefined as string | undefined,
  };
  const persistPhase = (phase: string, error?: string) => {
    journal.phase = phase;
    journal.error = error;
    journal.updatedAt = new Date().toISOString();
    mkdirSync(journalDir, { recursive: true });
    const temporary = `${journalPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(journal, null, 2));
    renameSync(temporary, journalPath);
  };

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

    const cleanRef = integrationBranch.startsWith("refs/heads/")
      ? integrationBranch
      : `refs/heads/${integrationBranch}`;

    // 1. Git Compare-and-Swap (CAS) ref update
    persistPhase("ref_update_pending");
    await gitCmd(root, "update-ref", cleanRef, candidate, targetBaseTip);
    persistPhase("database_sync_pending");

    // 2. Database synchronization BEFORE irreversible remote publication
    // Record verified integration in SQLite project_issue_integrations and synchronize coordination truth
    const isDbAttached = Boolean(options.db || options.dbPath);
    let syncError: string | undefined;
    try {
      const syncResult = recordSubticketIntegration({
        root,
        issueNumber,
        branch: integrationBranch,
        candidate,
        partOf,
        finalIntegrationPr,
        db: options.db,
        dbPath: options.dbPath,
        projectId: options.projectId,
      });
      if (syncResult.error && isDbAttached) {
        syncError = syncResult.error;
      }
    } catch (syncErr: unknown) {
      if (isDbAttached) {
        syncError = syncErr instanceof Error ? syncErr.message : String(syncErr);
      }
    }

    // If attached DB synchronization failed, roll back the Git ref update immediately!
    // Fail closed BEFORE executing any irreversible remote publication (push, PR merge, issue close).
    if (syncError) {
      let rollbackErr: Error | undefined;
      try {
        await gitCmd(root, "update-ref", cleanRef, targetBaseTip, candidate);
      } catch (err: any) {
        rollbackErr = err instanceof Error ? err : new Error(String(err));
      }

      if (rollbackErr) {
        // DB sync failed AND Git ref rollback failed: split-brain state detected!
        // Preserve observed SHA and report distinct explicit manual intervention error state!
        let observedSha = candidate;
        try {
          observedSha = (await gitCmd(root, "rev-parse", cleanRef)).trim();
        } catch {}

        persistPhase("manual_intervention_required", `${syncError}; rollback: ${rollbackErr.message}`);
        const errDetail = `Attached database synchronization failed (${syncError}) AND Git ref rollback failed: ${rollbackErr.message}. Observed ref at SHA ${observedSha}; explicit manual intervention required.`;
        return {
          success: false,
          evaluation: {
            ...autoMergeEval,
            authorized: false,
            decision: "hold_for_human",
            reasons: [...autoMergeEval.reasons, errDetail],
          },
          finalStatus: "manual_intervention_required",
          reviewOutcome: "approved",
          error: errDetail,
          finalIntegrationPr,
        };
      }

      persistPhase("rolled_back", syncError);
      return {
        success: false,
        evaluation: {
          ...autoMergeEval,
          authorized: false,
          decision: "hold_for_human",
          reasons: [...autoMergeEval.reasons, syncError],
        },
        finalStatus: "waiting_approval",
        reviewOutcome: "approved",
        error: syncError,
        finalIntegrationPr,
      };
    }

    persistPhase("publication_pending");
    // 3. Irreversible Remote Publication (only after CAS and DB sync succeeded)
    let publicationError: string | undefined;
    if (push !== false) {
      // Step A: gh pr merge
      if (pr) {
        try {
          persistPhase("pr_merge_pending");
          const prRes = await processCmd(
            ["gh", "pr", "merge", pr, "--squash", "--match-head-commit", candidate],
            worktree,
            30_000,
          );
          if (prRes.exitCode !== 0) {
            publicationError = `gh pr merge failed: ${prRes.stderr || prRes.stdout}`;
          }
        } catch (err: any) {
          publicationError = `gh pr merge failed: ${err.message}`;
        }
      }

      // Step B: git push origin (STOP if PR merge failed!)
      if (!publicationError && hasOrigin) {
        try {
          persistPhase("push_pending");
          await gitCmd(
            root,
            "push",
            "origin",
            `refs/heads/${integrationBranch}:refs/heads/${integrationBranch}`,
          );
        } catch (pushErr: any) {
          publicationError = `git push origin failed: ${pushErr.message}`;
        }
      }

      // Step C: gh issue close (STOP if PR merge or push failed!)
      if (!publicationError) {
        try {
          persistPhase("issue_close_pending");
          const closeRes = await processCmd(
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
          );
          if (closeRes.exitCode !== 0) {
            publicationError = `gh issue close failed: ${closeRes.stderr || closeRes.stdout}`;
          }
        } catch (err: any) {
          publicationError = `gh issue close failed: ${err.message}`;
        }
      }

      // Step D: Parent integration PR (STOP if any prior remote step failed!)
      if (!publicationError && partOf !== undefined) {
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

    if (publicationError) {
      // Remote publication failed: honest durable reconciliation state, NOT false completion or remote success!
      // Local branch ref was updated and DB record committed, but remote publication failed.
      persistPhase("remote_reconciliation_pending", publicationError);
      return {
        success: false,
        evaluation: {
          ...autoMergeEval,
          authorized: false,
          decision: "hold_for_human",
          reasons: [...autoMergeEval.reasons, publicationError],
        },
        finalStatus: "remote_reconciliation_pending",
        reviewOutcome: "approved",
        error: `Remote publication failed: ${publicationError}. Local git merged at commit \`${candidate}\` and database committed, remote pending durable reconciliation.`,
        finalIntegrationPr,
      };
    }

    persistPhase("completed");
    return {
      success: true,
      evaluation: autoMergeEval,
      finalStatus: "merged",
      reviewOutcome: "merged",
      finalIntegrationPr,
    };
  } catch (mergeErr: unknown) {
    const msg = `${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}; inspect recovery journal ${journalPath}`;
    const updatedEval: AutoMergeEvaluationResult = {
      ...autoMergeEval,
      authorized: false,
      decision: "hold_for_human",
      reasons: [...autoMergeEval.reasons, msg],
    };
    return {
      success: false,
      evaluation: updatedEval,
      finalStatus: journal.phase === "prepared" || journal.phase === "ref_update_pending"
        ? "waiting_approval"
        : "manual_intervention_required",
      reviewOutcome: "approved",
      error: msg,
    };
  }
}

