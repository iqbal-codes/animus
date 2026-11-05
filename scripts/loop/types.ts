import type { EffortRung } from "./providers";

export type VerificationProfile = "docs" | "ui" | "logic" | "api" | "core";

export interface LocalIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  comments: string[];
  dependencies: { number: number; state: string }[];
  activeClaim: boolean;
  labels?: string[];
  verificationProfile?: VerificationProfile;
  contractSha256?: string;
  sha256?: string;
  sections?: {
    partOf: number | null;
    sourceProblem: string;
    outcome: string;
    invariants: string[];
    acceptanceCriteria: string[];
    boundary: string;
    dependsOn: number[];
  };
}

export type LoopRole =
  | "builder"
  | "qa"
  | "reviewer"
  | "reflector"
  | "planner"
  | "investigator"
  | "manager"
  | "auditor"
  | "simplifier"
  | "triage";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type GhRunner = (
  args: string[],
  cwd?: string,
  timeoutMs?: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;

export type AgentTransport = (request: {
  argv: string[];
  cwd: string;
  role: LoopRole;
  provider?: string;
  model?: string;
  effort?: string;
  prompt?: string;
  skills?: string[];
  extensions?: string[];
  appendSystemPrompts?: string[];
  timeoutMs: number;
  env?: Record<string, string>;
}) => Promise<ProcessResult>;

export type PiTransport = AgentTransport;

export interface RoleBudget {
  softMs: number;
  hardMs: number;
}

export interface LocalLoopOptions {
  pi?: AgentTransport;
  transport?: AgentTransport;
  provider?: string;
  model?: string;
  effort?: EffortRung;
  /** Legacy per-attempt hard timeout override for every role; soft time is 80% of it. */
  timeoutMs?: number;
  /** Builder defaults 20m/25m; other roles 15m/20m. Overrides FACTORY_LOOP_<ROLE>_SOFT_MS/HARD_MS. */
  roleBudgets?: Partial<Record<LoopRole, RoleBudget>>;
  /** Additional attempts in the same role/worktree, 0..2 (default 1). */
  maxContinuations?: number;
  push?: boolean;
  baseBranch?: string;
  /** Seconds to poll PR CI checks before running reviewer (default 15s). */
  ciWaitSeconds?: number;
  /** Optional CI assessment injector for testing */
  checkPrCi?: (pr: string | number, options?: any) => Promise<any>;
  /** Injectable GitHub CLI runner port for offline testing and forge mocking. */
  ghRunner?: GhRunner;
  /** Optional custom state root directory override. */
  stateRoot?: string;
  /** Alias for stateRoot */
  stateDirectory?: string;
  /** Optional custom runs directory override. */
  runsDir?: string;
  customRunsDir?: string;
}

export interface LoopEvidence {
  kind: "pi" | "claude" | "omp" | "codex" | "opencode" | "agent" | "check";
  role?: LoopRole;
  round?: number;
  candidate: string;
  artifact: string;
  exitCode: number;
  provider?: string;
  effort?: EffortRung;
}

export interface LocalLoopResult {
  runId: string;
  pid?: number;
  lap?: number;
  issue: string;
  route: "simple" | "continue" | "complex";
  status:
    | "preparing"
    | "building"
    | "checking"
    | "qa"
    | "reviewing"
    | "reflecting"
    | "waiting_approval"
    | "merged"
    | "sent_back"
    | "needs_owner"
    | "interrupted"
    | "failed";
  runDirectory: string;
  worktree: string;
  branch: string;
  base: string;
  partOf?: number;
  integrationBranch?: string;
  finalIntegrationPr?: string;
  candidate?: string;
  pr?: string;
  verificationProfile?: VerificationProfile;
  reviewCommentUrl?: string;
  evidence: LoopEvidence[];
  error?: string;
  identities?: import("./report-schema").HostBoundIdentities;
  builderReport?: import("./report-schema").BuilderReport;
  qaReport?: import("./report-schema").QaReport;
  reviewerReport?: import("./report-schema").ReviewerReport;
  findings?: import("./report-schema").ReviewFinding[];
  autoMerge?: AutoMergeEvaluationResult;
}
export type LocalLoopRoute = LocalLoopResult["route"];
export type LocalLoopStatus = LocalLoopResult["status"];

export interface DiffImpactAnalysis {
  hasCriticalImpact: boolean;
  categories: import("./report-schema").CriticalImpactCategory[];
  reasons: string[];
  touchedDomains: string[];
}

export interface AutoMergeEvaluationResult {
  authorized: boolean;
  decision: "auto_merge" | "hold_for_human";
  isSubticket: boolean;
  targetBranch: string;
  baseBranch: string;
  riskLevel: import("./report-schema").AutoMergeRiskLevel;
  scopeAligned: boolean;
  criticalImpacts: import("./report-schema").CriticalImpactCategory[];
  deterministicImpacts: import("./report-schema").CriticalImpactCategory[];
  reviewerImpacts: import("./report-schema").CriticalImpactCategory[];
  reasons: string[];
  rationale?: string;
}

export interface AutoMergeExecutionResult {
  success: boolean;
  evaluation: AutoMergeEvaluationResult;
  finalStatus:
    | "merged"
    | "waiting_approval"
    | "remote_reconciliation_pending"
    | "manual_intervention_required";
  reviewOutcome: "merged" | "approved";
  finalIntegrationPr?: string;
  error?: string;
}

export type ModelTier = "small" | "medium" | "large";

export interface BacklogTicket {
  key: string;
  title: string;
  phase: string;
  body: string;
  depends_on: string[];
  depends_why: string;
  size: "small_bounded" | "risky" | "large";
}

export interface HoldoutScenario {
  id: string;
  title: string;
  protects: string;
  touches: string;
  setup: string;
  steps: string;
  expect: string;
  author: string;
}

export interface MergeQueuePlan {
  repository: string;
  base: string;
  base_sha: string;
  method: "merge" | "squash" | "rebase";
  pull_requests: { number: number; url: string; head_sha: string }[];
  evidence: { path: string; sha256?: string }[];
  reasons: string[];
  eligible: boolean;
}

export * from "./report-schema";
