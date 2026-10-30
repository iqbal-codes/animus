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
  | "simplifier";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type AgentTransport = (request: {
  argv: string[];
  cwd: string;
  role: LoopRole;
  provider?: string;
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
    | "sent_back"
    | "needs_owner"
    | "interrupted"
    | "failed";
  runDirectory: string;
  worktree: string;
  branch: string;
  base: string;
  candidate?: string;
  pr?: string;
  verificationProfile?: VerificationProfile;
  reviewCommentUrl?: string;
  evidence: LoopEvidence[];
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
