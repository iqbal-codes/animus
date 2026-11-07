import { computeExternalBlastRadius } from "./loop/blast-radius";
import {
  extractRequiredAcIds,
  validateIssue,
  formatEscalationHandoff,
  annotateDiffWithLineNumbers,
  assembleRolePromptContext,
} from "./loop/prompt-context";
import { renderPrompt, resolveAnimusCommandsDir } from "./loop/prompts";
import { parseAgentReport, extractReport } from "./loop/artifacts";
import { formatBuilderComment } from "./loop/pr-reporting";
import { executeSubticketAutoMerge, type ExecuteSubticketAutoMergeOptions } from "./loop/merge-queue";
import {
  git,
  inspectLocalLoop,
  findExistingWorktreeForBranch,
  acquireIssueLock,
  prepareLoopWorktree,
  assertCandidate as assertCandidateInWorktree,
  DEFAULT_PROTECTED_PATHS,
} from "./loop/worktree";
import {
  executeTerminalReflection,
  createBoundedReflectionTransport,
  type ExecuteTerminalReflectionOptions,
  type BoundedReflectionTransportOptions,
} from "./loop/reflector";
import { LoopPublisher } from "./loop/publisher";
import {
  LapSession,
  runAnimusLoop,
  runLocalLoop,
  resolveResumeBuilderSessionIdForLap,
  type TerminalDispositionInput,
} from "./loop/session";

// Re-export canonical orchestrator seam and domain types
export {
  runAnimusLoop,
  runLocalLoop,
  LapSession,
  resolveResumeBuilderSessionIdForLap,
  type TerminalDispositionInput,
};
export { LoopPublisher } from "./loop/publisher";
export type * from "./loop/types";
export type * from "./loop/prompt-context";
export type * from "./loop/blast-radius";
export type * from "./loop/worktree";
export type {
  PublicationRecord,
  PublicationErrorRecord,
} from "./loop/pr-publication";
export type {
  ExecuteSubticketAutoMergeOptions,
  ExecuteTerminalReflectionOptions,
  BoundedReflectionTransportOptions,
};

// Re-export domain utilities preserved from pre-existing local-loop public contract
export {
  resolveAnimusCommandsDir,
  renderPrompt,
  parseAgentReport,
  extractReport,
  formatBuilderComment,
  extractRequiredAcIds,
  validateIssue,
  formatEscalationHandoff,
  annotateDiffWithLineNumbers,
  assembleRolePromptContext,
  git,
  inspectLocalLoop,
  findExistingWorktreeForBranch,
  acquireIssueLock,
  prepareLoopWorktree,
  assertCandidateInWorktree as assertCandidate,
  DEFAULT_PROTECTED_PATHS,
  executeSubticketAutoMerge,
  executeTerminalReflection,
  createBoundedReflectionTransport,
  computeExternalBlastRadius,
};
