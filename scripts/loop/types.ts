export interface LocalIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  comments: string[];
  dependencies: { number: number; state: string }[];
  activeClaim: boolean;
}

export type LoopRole =
  | "builder"
  | "qa"
  | "reviewer"
  | "planner"
  | "investigator"
  | "manager"
  | "auditor"
  | "simplifier";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PiTransport = (request: {
  argv: string[];
  cwd: string;
  role: LoopRole;
  timeoutMs: number;
}) => Promise<ProcessResult>;

export interface LocalLoopOptions {
  pi?: PiTransport;
  model?: string;
  timeoutMs?: number;
  push?: boolean;
}

export interface LoopEvidence {
  kind: "pi" | "check";
  role?: LoopRole;
  round?: number;
  candidate: string;
  artifact: string;
  exitCode: number;
}

export interface LocalLoopResult {
  runId: string;
  issue: string;
  route: "simple" | "continue" | "complex";
  status:
    | "preparing"
    | "building"
    | "checking"
    | "qa"
    | "reviewing"
    | "waiting_approval"
    | "sent_back"
    | "needs_owner"
    | "failed";
  runDirectory: string;
  worktree: string;
  branch: string;
  base: string;
  candidate?: string;
  pr?: string;
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
