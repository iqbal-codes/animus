import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  assertIssueForge,
  type ForgeAdapter,
  type ForgeIssue,
  type IssueForgeAdapter,
  SystemForgeAdapter,
} from "../../apps/backend/src/registry/forge";
import { extractReportObject } from "./artifacts";
import { resolveRoleConfig } from "./config";
import { resolveRoleBudgets } from "./deadlines";
import {
  buildCuratedAppendPrompts,
  resolveAllowedSkills,
  resolveLoopExtensions,
} from "./harness-memory";
import { processRun } from "./process";
import { loadPrompt, renderPrompt } from "./prompts";
import { buildProviderArgv, type EffortRung } from "./providers";
import type { AgentTransport, LoopRole, RoleBudget } from "./types";
import { isPidAlive } from "../../packages/contracts/src/paths";

export const TRIAGE_AGENT_MARKER = "<!-- animus-triage-agent -->";

export const READY_FOR_AGENT = "ready-for-agent";
export const READY_FOR_HUMAN = "ready-for-human";
export const NEEDS_TRIAGE = "needs-triage";
export const NEEDS_INFO = "needs-info";
export const WONTFIX = "wontfix";
export const SPEC = "spec";
export const NEEDS_OWNER = "needs-owner";

export const EXCLUDED_TRIAGE_LABELS = new Set([
  WONTFIX,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  NEEDS_OWNER,
]);

export const CANONICAL_SECTIONS = [
  "## Source and problem",
  "## Outcome",
  "## Invariants",
  "## Acceptance criteria",
  "## Boundary",
] as const;

export const REQUIRED_TRIAGE_SKILL = "animus-triage";

export const askClarificationSchema = z.strictObject({
  action: z.literal("ask_clarification"),
  question: z.string().min(1, "Clarification question must not be empty"),
  reason: z.string().min(1, "Reason must not be empty"),
});

export const promoteSingleTicketSchema = z.strictObject({
  action: z.literal("promote_single_ticket"),
  title: z.string().min(1, "Ticket title must not be empty"),
  body: z.string().min(1, "Ticket body must not be empty"),
  reason: z.string().min(1, "Reason must not be empty"),
  authority: z.enum(["agent", "human"]).default("agent").optional(),
});

export const childTicketInputSchema = z.strictObject({
  title: z.string().min(1, "Child ticket title must not be empty"),
  body: z.string().min(1, "Child ticket body must not be empty"),
  dependsOnIndices: z.array(z.number().int().nonnegative()).default([]),
  labels: z.array(z.string()).default([]).optional(),
});

export const promoteEpicSchema = z
  .strictObject({
    action: z.literal("promote_epic_spec_and_tickets"),
    agreementCommentId: z.string().min(1, "Agreement comment reference required"),
    parentTitle: z.string().min(1, "Parent spec title must not be empty"),
    parentBody: z.string().min(1, "Parent spec body must not be empty"),
    childTickets: z
      .array(childTicketInputSchema)
      .min(1, "Epic must contain at least 1 child ticket"),
    reason: z.string().min(1, "Reason must not be empty"),
  })
  .superRefine((epic, ctx) => {
    const numChildren = epic.childTickets.length;
    for (let i = 0; i < numChildren; i++) {
      const child = epic.childTickets[i]!;
      for (const depIdx of child.dependsOnIndices) {
        if (depIdx < 0 || depIdx >= numChildren) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Child ticket #${i + 1} has out-of-range dependency index ${depIdx}`,
            path: ["childTickets", i, "dependsOnIndices"],
          });
        } else if (depIdx === i) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Child ticket #${i + 1} has self-dependency index ${depIdx}`,
            path: ["childTickets", i, "dependsOnIndices"],
          });
        } else if (depIdx > i) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Child ticket #${i + 1} has forward dependency index ${depIdx} (dependencies must precede ticket in topological order)`,
            path: ["childTickets", i, "dependsOnIndices"],
          });
        }
      }
    }

    // Check for cycles in dependency graph (DFS)
    const adj = new Map<number, number[]>();
    for (let i = 0; i < numChildren; i++) {
      adj.set(i, epic.childTickets[i]!.dependsOnIndices);
    }
    const visited = new Set<number>();
    const recStack = new Set<number>();

    function hasCycle(node: number): boolean {
      visited.add(node);
      recStack.add(node);
      for (const neighbor of adj.get(node) ?? []) {
        if (neighbor < 0 || neighbor >= numChildren) continue;
        if (!visited.has(neighbor)) {
          if (hasCycle(neighbor)) return true;
        } else if (recStack.has(neighbor)) {
          return true;
        }
      }
      recStack.delete(node);
      return false;
    }

    for (let i = 0; i < numChildren; i++) {
      if (!visited.has(i)) {
        if (hasCycle(i)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Epic child tickets contain dependency cycles",
            path: ["childTickets"],
          });
          break;
        }
      }
    }
  });

export const holdForHumanSchema = z.strictObject({
  action: z.literal("hold_for_human"),
  reason: z.string().min(1, "Reason must not be empty"),
  comment: z.string().optional(),
});

export const triageOutputSchema = z.discriminatedUnion("action", [
  askClarificationSchema,
  promoteSingleTicketSchema,
  promoteEpicSchema,
  holdForHumanSchema,
]);

export type AskClarificationAction = z.infer<typeof askClarificationSchema>;
export type PromoteSingleTicketAction = z.infer<typeof promoteSingleTicketSchema>;
export type ChildTicketInput = z.infer<typeof childTicketInputSchema>;
export type PromoteEpicAction = z.infer<typeof promoteEpicSchema>;
export type HoldForHumanAction = z.infer<typeof holdForHumanSchema>;
export type TriageAction = z.infer<typeof triageOutputSchema>;

export interface TriageEligibilityResult {
  eligible: boolean;
  reason: string;
}

export const triageFailureRecordSchema = z.strictObject({
  fingerprint: z.string().min(1, "Failure record fingerprint must not be empty"),
  attempts: z.number().int().nonnegative().finite(),
  failedAt: z.string().min(1, "Failure record timestamp must not be empty"),
  lastError: z.string(),
});

export type TriageFailureRecord = z.infer<typeof triageFailureRecordSchema>;

export interface TriageIssueResult {
  issueNumber: number;
  status:
    | "clarification_requested"
    | "promoted_single"
    | "promoted_epic"
    | "held"
    | "skipped"
    | "failed"
    | "planned";
  action?: TriageAction["action"];
  reason?: string;
  error?: string;
  createdChildIssues?: number[];
}

export interface TriagePassResult {
  processed: TriageIssueResult[];
  skippedCount: number;
  successCount: number;
  failureCount: number;
  heldCount: number;
}

export interface RunTriagePassOptions {
  root: string;
  repo: string;
  stateRoot: string;
  forge?: IssueForgeAdapter | ForgeAdapter;
  transport?: AgentTransport;
  issueNumber?: number;
  dryRun?: boolean;
  acceptedRef?: string;
  timeoutMs?: number;
  roleBudgets?: Partial<Record<LoopRole, RoleBudget>>;
  env?: Record<string, string>;
  limit?: number;
}

function normalizeLabels(labels?: Array<{ name: string } | string>): string[] {
  return (labels ?? []).map((l) => (typeof l === "string" ? l : l.name).toLowerCase());
}

export function evaluateTriageEligibility(
  issue: ForgeIssue,
  stateRoot?: string,
): TriageEligibilityResult {
  if (issue.state.toUpperCase() !== "OPEN") {
    return { eligible: false, reason: `Issue #${issue.number} is not OPEN (${issue.state})` };
  }

  // F1: Absolute exclusion labels have absolute precedence over staging recovery.
  // wontfix, needs-owner, ready-for-agent, ready-for-human never run model or mutate even if checkpoint exists.
  const labels = normalizeLabels(issue.labels);
  for (const excluded of EXCLUDED_TRIAGE_LABELS) {
    if (labels.includes(excluded)) {
      return {
        eligible: false,
        reason: `Issue #${issue.number} has exclusion label '${excluded}'`,
      };
    }
  }

  // If a staged epic promotion is in progress for this issue, and it is not excluded, it is eligible to resume
  if (stateRoot) {
    const stagingFile = join(stateRoot, "triage-staging", `epic-${issue.number}.json`);
    if (existsSync(stagingFile)) {
      return {
        eligible: true,
        reason: `Issue #${issue.number} has in-progress epic staging recovery`,
      };
    }
  }

  // Triage failure fingerprint backoff
  if (stateRoot) {
    const failureFile = join(stateRoot, "triage-failures", `issue-${issue.number}.json`);
    if (existsSync(failureFile)) {
      try {
        const raw = readFileSync(failureFile, "utf-8");
        const parsed = JSON.parse(raw);
        const parsedRecord = triageFailureRecordSchema.safeParse(parsed);
        if (!parsedRecord.success) {
          return {
            eligible: false,
            reason: `Issue #${issue.number} failure record is unreadable or corrupted: ${parsedRecord.error.message}`,
          };
        }
        const record = parsedRecord.data;
        const currentFingerprint = computeIssueFreshnessFingerprint(issue);
        if (record.fingerprint === currentFingerprint) {
          if (record.attempts >= 2) {
            return {
              eligible: false,
              reason: `Issue #${issue.number} failed triage ${record.attempts} times and has not been updated since last failure`,
            };
          }
        }
      } catch (err: any) {
        return {
          eligible: false,
          reason: `Issue #${issue.number} failure record is unreadable or corrupted: ${err?.message || String(err)}`,
        };
      }
    }
  }

  const comments = issue.comments ?? [];
  const lastComment = comments.length > 0 ? comments[comments.length - 1] : undefined;
  const lastCommentHasMarker = lastComment?.body?.includes(TRIAGE_AGENT_MARKER) ?? false;

  const hasNeedsInfo = labels.includes(NEEDS_INFO);
  const hasNeedsTriage = labels.includes(NEEDS_TRIAGE);
  const isUnlabeled = !hasNeedsInfo && !hasNeedsTriage;

  if (hasNeedsInfo) {
    if (comments.length === 0) {
      return {
        eligible: false,
        reason: `Issue #${issue.number} is labeled '${NEEDS_INFO}' but has no comments`,
      };
    }
    if (lastCommentHasMarker) {
      return {
        eligible: false,
        reason: `Issue #${issue.number} is awaiting a human reply to triage prompt`,
      };
    }
    return {
      eligible: true,
      reason: `Issue #${issue.number} has human reply following triage clarification prompt`,
    };
  }

  if (hasNeedsTriage || isUnlabeled) {
    if (lastCommentHasMarker) {
      return {
        eligible: false,
        reason: `Issue #${issue.number} has an unanswered triage prompt as its latest comment`,
      };
    }
    return {
      eligible: true,
      reason: hasNeedsTriage
        ? `Issue #${issue.number} is labeled '${NEEDS_TRIAGE}'`
        : `Issue #${issue.number} has no canonical triage label (unlabeled_awaiting_triage)`,
    };
  }

  return {
    eligible: false,
    reason: `Issue #${issue.number} does not match any eligible triage state`,
  };
}

export function isIssueEligibleForTriage(issue: ForgeIssue, stateRoot?: string): boolean {
  return evaluateTriageEligibility(issue, stateRoot).eligible;
}

export function validateCanonicalIssueBody(body: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Filter out code blocks to avoid false positives with headings or Depends on inside code
  const lines = body.split("\n");
  const filteredLines: { text: string; lineNo: number }[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock) {
      filteredLines.push({ text: line, lineNo: i + 1 });
    }
  }

  // Find occurrences of exact canonical section headings
  const sectionIndices: { name: string; lineIdx: number }[] = [];
  for (let i = 0; i < filteredLines.length; i++) {
    const text = filteredLines[i]!.text.trim();
    if (text.startsWith("## ")) {
      const heading = text;
      const matched = CANONICAL_SECTIONS.find((s) => s === heading);
      if (matched) {
        sectionIndices.push({ name: matched, lineIdx: i });
      }
    }
  }

  // Check that all 5 sections are present and appear exactly once and in correct order
  for (const expectedSection of CANONICAL_SECTIONS) {
    const matches = sectionIndices.filter((s) => s.name === expectedSection);
    if (matches.length === 0) {
      errors.push(`Missing mandatory canonical section: '${expectedSection}'`);
    } else if (matches.length > 1) {
      errors.push(`Duplicate canonical section heading: '${expectedSection}'`);
    }
  }

  // Check section order and nonempty content
  if (errors.length === 0) {
    for (let s = 0; s < CANONICAL_SECTIONS.length; s++) {
      const current = sectionIndices[s]!;
      if (current.name !== CANONICAL_SECTIONS[s]) {
        errors.push(
          `Canonical sections out of order: expected '${CANONICAL_SECTIONS[s]}', got '${current.name}'`,
        );
        break;
      }
      // Content check: must have non-empty text before next section or next heading
      const nextLineIdx =
        s + 1 < sectionIndices.length ? sectionIndices[s + 1]!.lineIdx : filteredLines.length;

      let hasContent = false;
      for (let l = current.lineIdx + 1; l < nextLineIdx; l++) {
        const lineText = filteredLines[l]!.text.trim();
        // Ignore Depends on line or empty lines
        if (lineText && !lineText.startsWith("Depends on:") && !lineText.startsWith("## ")) {
          hasContent = true;
          break;
        }
      }
      if (!hasContent) {
        errors.push(`Mandatory section '${current.name}' has empty content`);
      }
    }
  }

  // Check exact SINGLE Depends on line outside code blocks
  const dependsOnLines = filteredLines.filter((l) => /^Depends on:\s*.+$/m.test(l.text.trim()));

  if (dependsOnLines.length === 0) {
    errors.push("Missing mandatory standalone 'Depends on: #<n>' or 'Depends on: None' line");
  } else if (dependsOnLines.length > 1) {
    errors.push("Multiple 'Depends on:' lines found; exactly one standalone line is permitted");
  } else {
    const lineText = dependsOnLines[0]!.text.trim();
    const validPattern = /^Depends on:\s*(?:(?:#[0-9]+(?:\s*,\s*#[0-9]+)*)|None)\s*$/;
    if (!validPattern.test(lineText)) {
      errors.push(
        `Malformed 'Depends on:' line ('${lineText}'); must match 'Depends on: #<number>, #<number>' or 'Depends on: None'`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}



async function withIssueLockMutex<T>(
  locksDir: string,
  issueNumber: number,
  fn: () => Promise<T>,
): Promise<T> {
  const mutexDir = join(locksDir, `issue-${issueNumber}.mutex`);
  const maxRetries = 30;
  let acquired = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      mkdirSync(mutexDir);
      acquired = true;
      break;
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        await new Promise((r) => setTimeout(r, 20));
      } else {
        throw err;
      }
    }
  }

  if (!acquired) {
    throw new Error(
      `Timeout acquiring lock mutex for issue #${issueNumber}: mutex is held (stale mutex requires operator intervention)`,
    );
  }

  const mutexToken = randomUUID();
  try {
    writeFileSync(
      join(mutexDir, "owner.json"),
      JSON.stringify({ pid: process.pid, mutexToken, createdAt: Date.now() }),
      "utf-8",
    );
    return await fn();
  } finally {
    try {
      const ownerFile = join(mutexDir, "owner.json");
      if (existsSync(ownerFile)) {
        const owner = JSON.parse(readFileSync(ownerFile, "utf-8"));
        if (owner?.pid === process.pid && owner?.mutexToken === mutexToken) {
          rmSync(mutexDir, { recursive: true, force: true });
        }
      }
    } catch {}
  }
}

export async function acquireTriageIssueLock(
  stateRoot: string,
  issueNumber: number,
  timeoutMs = 1800000,
): Promise<{ release: () => Promise<void> } | null> {
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }
  const locksDir = join(stateRoot, "triage-locks");
  mkdirSync(locksDir, { recursive: true });
  const lockFile = join(locksDir, `issue-${issueNumber}.lock`);
  const ownerToken = randomUUID();

  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    issueNumber,
    ownerToken,
  });

  try {
    return await withIssueLockMutex(locksDir, issueNumber, async () => {
      if (existsSync(lockFile)) {
        let existing: any;
        try {
          const raw = readFileSync(lockFile, "utf-8");
          existing = JSON.parse(raw);
        } catch {
          // Invalid or partial lock payload: fail closed!
          return null;
        }

        if (
          !existing ||
          typeof existing.pid !== "number" ||
          typeof existing.createdAt !== "number" ||
          typeof existing.issueNumber !== "number"
        ) {
          // Invalid or partial lock payload: fail closed!
          return null;
        }

        // Live PID check: if PID is still alive, NEVER steal, even if expired! "age never proves dead"
        const alive = isPidAlive(existing.pid);
        if (alive) {
          return null;
        }

        // PID is dead (stale-dead): safely remove stale lock (mutex is exclusively held)
        try {
          rmSync(lockFile, { force: true });
        } catch {
          return null;
        }
      }

      try {
        writeFileSync(lockFile, payload, { flag: "wx" });
      } catch {
        return null;
      }

      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try {
            await withIssueLockMutex(locksDir, issueNumber, async () => {
              if (existsSync(lockFile)) {
                try {
                  const raw = readFileSync(lockFile, "utf-8");
                  const current = JSON.parse(raw);
                  if (current?.pid === process.pid && current?.ownerToken === ownerToken) {
                    rmSync(lockFile, { force: true });
                  }
                } catch {}
              }
            });
          } catch {}
        },
      };
    });
  } catch {
    // Mutex acquisition failed or timed out: fail closed without deleting live or stale mutex
    return null;
  }
}

export function getWorkspaceSnapshot(root: string): string {
  // Fail closed on git failures: do NOT catch and swallow as empty string
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const status = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "-z"],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const diffHead = execFileSync("git", ["-C", root, "diff", "HEAD", "--binary"], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const diffCached = execFileSync("git", ["-C", root, "diff", "--cached", "--binary"], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const untrackedRaw = execFileSync(
    "git",
    ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const untrackedFiles = untrackedRaw
    .split("\0")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const hasher = createHash("sha256");
  hasher.update(head);
  hasher.update("\n");
  hasher.update(status);
  hasher.update("\n");
  hasher.update(diffHead);
  hasher.update(diffCached);

  for (const relPath of untrackedFiles) {
    const fullPath = join(root, relPath);
    try {
      const stat = lstatSync(fullPath);
      hasher.update(`untracked:${relPath}:${stat.mode}:`);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(fullPath);
        hasher.update(`symlink:${target}\n`);
      } else if (stat.isFile()) {
        const content = readFileSync(fullPath);
        hasher.update(content);
        hasher.update("\n");
      }
    } catch {
      hasher.update(`error:${relPath}\n`);
    }
  }

  return hasher.digest("hex");
}

export function validateTriagePassInputs(options: RunTriagePassOptions): void {
  const { root, repo, stateRoot } = options;

  if (typeof root !== "string" || !root.trim() || !existsSync(root)) {
    throw new Error(`Invalid root directory: '${root}'`);
  }

  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim())) {
    throw new Error(`Invalid repository identity: '${repo}'`);
  }

  if (typeof stateRoot !== "string" || !stateRoot.trim()) {
    throw new Error(`Invalid stateRoot directory: '${stateRoot}'`);
  }

  // Canonical containment check: stateRoot must be outside checkout
  const canonicalRoot = realpathSync(root);
  if (!existsSync(stateRoot)) {
    mkdirSync(stateRoot, { recursive: true });
  }
  const canonicalStateRoot = realpathSync(stateRoot);

  if (
    canonicalStateRoot === canonicalRoot ||
    canonicalStateRoot.startsWith(canonicalRoot + (canonicalRoot.endsWith("/") ? "" : "/"))
  ) {
    throw new Error(
      `stateRoot ('${stateRoot}' -> '${canonicalStateRoot}') must be outside checkout root ('${root}' -> '${canonicalRoot}')`,
    );
  }

  // Ensure no host artifacts before validation
  if (existsSync(join(root, ".factory/runs"))) {
    throw new Error(
      `Unexpected host artifacts detected in checkout root: '${join(root, ".factory/runs")}'`,
    );
  }

  if (options.issueNumber !== undefined) {
    if (
      typeof options.issueNumber !== "number" ||
      !Number.isInteger(options.issueNumber) ||
      options.issueNumber <= 0
    ) {
      throw new Error(`Invalid issueNumber: '${options.issueNumber}'; must be a positive integer`);
    }
  }

  if (options.limit !== undefined) {
    if (
      typeof options.limit !== "number" ||
      !Number.isInteger(options.limit) ||
      options.limit <= 0
    ) {
      throw new Error(`Invalid limit: '${options.limit}'; must be a positive integer`);
    }
  }

  resolveRoleBudgets(
    {
      timeoutMs: options.timeoutMs,
      roleBudgets: options.roleBudgets,
    },
    { ...process.env, ...(options.env ?? {}) },
  );
}

export function computeIssueFreshnessFingerprint(issue: ForgeIssue): string {
  const normalizedLabels = normalizeLabels(issue.labels)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
  const normalizedComments = (issue.comments ?? []).map((c) => ({
    id: c.id ?? "",
    author: c.author ?? "",
    body: (c.body ?? "").trim(),
  }));
  const payload = {
    title: issue.title.trim(),
    body: (issue.body ?? "").trim(),
    state: issue.state.toUpperCase(),
    labels: normalizedLabels,
    comments: normalizedComments,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function renderTriagePrompt(
  root: string,
  issue: ForgeIssue,
  repo: string,
  artifactsDir: string,
): string {
  const template = loadPrompt("triage", root);
  const commentsFormatted = (issue.comments ?? [])
    .map(
      (c, idx) =>
        `Comment #${idx + 1} (id: ${c.id ?? `idx-${idx + 1}`}) by @${c.author ?? "unknown"}:\n${c.body ?? ""}`,
    )
    .join("\n\n---\n\n");

  return renderPrompt(
    template,
    {
      issue_number: String(issue.number),
      issue_title: issue.title,
      issue_body: issue.body || "(No description provided)",
      issue_comments: commentsFormatted || "(No comments on this issue yet)",
      repo,
    },
    artifactsDir,
    { allowUnresolved: true },
  );
}

export function replaceCanonicalDependsOn(body: string, depLine: string): string {
  const lines = body.split("\n");
  let inCodeBlock = false;
  let targetIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock && /^Depends on:\s*.+$/i.test(trimmed)) {
      targetIndex = i;
    }
  }

  if (targetIndex !== -1) {
    lines[targetIndex] = depLine;
    return lines.join("\n");
  }

  return `${body.trimEnd()}\n\n${depLine}\n`;
}

export const stagedEpicRecordSchema = z.strictObject({
  repo: z.string().min(1),
  parentNumber: z.number().int().positive(),
  planHash: z.string().min(1),
  childNumbers: z.array(z.number().int().positive().nullable()),
  action: promoteEpicSchema,
  phase: z
    .enum([
      "created_children",
      "configured_children",
      "promoted_children",
      "posted_summary",
      "completed",
    ])
    .optional(),
});

export type StagedEpicRecord = z.infer<typeof stagedEpicRecordSchema>;

function computePlanHash(action: PromoteEpicAction): string {
  const content = {
    parentTitle: action.parentTitle.trim(),
    parentBody: action.parentBody.trim(),
    childTickets: action.childTickets.map((c) => ({
      title: c.title.trim(),
      body: c.body.trim(),
      dependsOnIndices: [...c.dependsOnIndices].sort((a, b) => a - b),
      labels: (c.labels ?? []).slice().sort((a, b) => a.localeCompare(b)),
    })),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function saveStagingRecord(stagingFile: string, record: StagedEpicRecord): void {
  const tmpFile = `${stagingFile}.${randomUUID()}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(record, null, 2), "utf-8");
  renameSync(tmpFile, stagingFile);
}

function quarantineStagingFile(
  stateRoot: string,
  stagingFile: string,
  issueNumber: number,
): string {
  const quarantineDir = join(stateRoot, "triage-staging", "quarantine");
  mkdirSync(quarantineDir, { recursive: true });
  const quarantinedPath = join(
    quarantineDir,
    `epic-${issueNumber}.${Date.now()}.${randomUUID()}.corrupt.json`,
  );
  try {
    renameSync(stagingFile, quarantinedPath);
  } catch {
    try {
      rmSync(stagingFile, { force: true });
    } catch {}
  }
  return quarantinedPath;
}

function validateStagingRecord(
  stagingFile: string,
  repo: string,
  issueNumber: number,
): { valid: true; record: StagedEpicRecord } | { valid: false; reason: string } {
  let raw: unknown;
  try {
    const text = readFileSync(stagingFile, "utf-8");
    raw = JSON.parse(text);
  } catch (err: any) {
    return {
      valid: false,
      reason: `Failed to parse staging JSON: ${err?.message || String(err)}`,
    };
  }

  const parsed = stagedEpicRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      reason: `Staged epic plan mismatch or invalid schema: ${parsed.error.message}`,
    };
  }

  const record = parsed.data;
  if (record.repo.toLowerCase() !== repo.toLowerCase()) {
    return {
      valid: false,
      reason: `Repo mismatch in staging record: expected '${repo}', found '${record.repo}'`,
    };
  }

  if (record.parentNumber !== issueNumber) {
    return {
      valid: false,
      reason: `Parent issue number mismatch in staging record: expected #${issueNumber}, found #${record.parentNumber}`,
    };
  }

  const expectedPlanHash = computePlanHash(record.action);
  if (record.planHash !== expectedPlanHash) {
    return {
      valid: false,
      reason: `Staged epic plan mismatch in staging record: expected '${expectedPlanHash}', found '${record.planHash}'`,
    };
  }

  if (record.childNumbers.length !== record.action.childTickets.length) {
    return {
      valid: false,
      reason: `Child count mismatch: expected ${record.action.childTickets.length}, found ${record.childNumbers.length}`,
    };
  }

  return { valid: true, record };
}

async function handleEpicPromotion(
  forge: IssueForgeAdapter,
  repo: string,
  issue: ForgeIssue,
  action: PromoteEpicAction,
  stateRoot: string,
  resumedRecord?: StagedEpicRecord,
): Promise<{
  status: "promoted_epic" | "held";
  createdChildIssues?: number[];
  reason: string;
}> {
  const comments = issue.comments ?? [];
  const agreementRef = action.agreementCommentId.trim();

  // Validate exact existing comment ID; no arbitrary substring fallback
  const humanAgreement = comments.find((c) => {
    if (!c.id) return false;
    if (c.id.trim() !== agreementRef) return false;
    const body = (c.body ?? "").trim();
    if (body.includes(TRIAGE_AGENT_MARKER)) return false;
    return true;
  });

  if (!humanAgreement) {
    throw new Error(
      `Epic promotion rejected: could not find valid human agreement comment matching exact ID '${action.agreementCommentId}' without agent marker.`,
    );
  }

  // Canonical markdown validation for parent spec body
  const parentCheck = validateCanonicalIssueBody(action.parentBody);
  if (!parentCheck.valid) {
    throw new Error(`Parent spec fails canonical structure: ${parentCheck.errors.join("; ")}`);
  }

  // Canonical markdown validation for all child tickets
  for (let i = 0; i < action.childTickets.length; i++) {
    const child = action.childTickets[i]!;
    const check = validateCanonicalIssueBody(child.body);
    if (!check.valid) {
      throw new Error(
        `Child ticket #${i + 1} ('${child.title}') fails canonical structure: ${check.errors.join("; ")}`,
      );
    }
  }

  const currentPlanHash = computePlanHash(action);

  const stagingDir = join(stateRoot, "triage-staging");
  mkdirSync(stagingDir, { recursive: true });
  const stagingFile = join(stagingDir, `epic-${issue.number}.json`);

  let record: StagedEpicRecord;

  if (resumedRecord) {
    record = resumedRecord;
  } else if (existsSync(stagingFile)) {
    const validation = validateStagingRecord(stagingFile, repo, issue.number);
    if (!validation.valid || validation.record.planHash !== currentPlanHash) {
      quarantineStagingFile(stateRoot, stagingFile, issue.number);
      const existingParentLabels = normalizeLabels(issue.labels).filter(
        (l) => l !== NEEDS_TRIAGE && l !== NEEDS_INFO,
      );
      await forge.updateIssue(repo, issue.number, {
        labels: Array.from(new Set([...existingParentLabels, NEEDS_OWNER])),
      });
      await forge.createIssueComment(
        repo,
        issue.number,
        `Staged epic plan mismatch on retry for issue #${issue.number}; held in needs-owner to prevent duplicate or orphaned child tickets.\n\n${TRIAGE_AGENT_MARKER}`,
      );
      return {
        status: "held",
        reason: `Staged epic plan mismatch on retry for issue #${issue.number}; held to prevent duplicate or orphaned child tickets.`,
      };
    }
    record = validation.record;
  } else {
    record = {
      repo,
      parentNumber: issue.number,
      planHash: currentPlanHash,
      childNumbers: action.childTickets.map(() => null),
      action,
      phase: undefined,
    };
    saveStagingRecord(stagingFile, record);
  }

  // Stage 1: Create all held child tickets in NEEDS_OWNER (not needs-triage eligible)
  for (let i = 0; i < action.childTickets.length; i++) {
    if (record.childNumbers[i] !== null && typeof record.childNumbers[i] === "number") {
      const existing = await forge.getIssue(repo, record.childNumbers[i]!);
      if (existing) continue;
    }
    const childInput = action.childTickets[i]!;
    // Held state (needs-owner) so autonomous loops and other triage passes never touch incomplete tickets
    const created = await forge.createIssue(repo, {
      title: childInput.title,
      body: childInput.body,
      labels: [NEEDS_OWNER],
    });
    record.childNumbers[i] = created.number;
    saveStagingRecord(stagingFile, record);
  }
  record.phase = "created_children";
  saveStagingRecord(stagingFile, record);

  const createdNumbers = record.childNumbers as number[];

  // Stage 2: Rewire child bodies with Part of, exact Depends on real numbers, native hierarchy & dependencies
  // While still holding in NEEDS_OWNER so tickets are never partially exposed
  for (let i = 0; i < action.childTickets.length; i++) {
    const childInput = action.childTickets[i]!;
    const childNumber = createdNumbers[i]!;

    const depNumbers = childInput.dependsOnIndices.map((idx) => createdNumbers[idx]!);

    const depLine =
      depNumbers.length > 0
        ? `Depends on: ${depNumbers.map((n) => `#${n}`).join(", ")}`
        : "Depends on: None";

    let childBody = childInput.body;
    if (!childBody.includes(`Part of #${issue.number}`)) {
      childBody = `Part of #${issue.number}\n\n${childBody}`;
    }

    // Code-block-aware replacement using same canonical parser
    childBody = replaceCanonicalDependsOn(childBody, depLine);

    await forge.updateIssue(repo, childNumber, {
      body: childBody,
      labels: [NEEDS_OWNER],
    });

    if (typeof forge.addSubIssue === "function") {
      let alreadySub = false;
      if (typeof forge.getSubIssues === "function") {
        const subs = await forge.getSubIssues(repo, issue.number);
        alreadySub = subs.includes(childNumber);
      }
      if (!alreadySub) {
        await forge.addSubIssue(repo, issue.number, childNumber);
      }
    }

    if (typeof forge.addIssueDependency === "function") {
      let existingDeps: number[] = [];
      if (typeof forge.getIssueDependencies === "function") {
        existingDeps = await forge.getIssueDependencies(repo, childNumber);
      }
      for (const depNum of depNumbers) {
        if (!existingDeps.includes(depNum)) {
          await forge.addIssueDependency(repo, childNumber, depNum);
        }
      }
    }
  }
  record.phase = "configured_children";
  saveStagingRecord(stagingFile, record);

  // Stage 3: Only after all bodies, native hierarchy, and dependencies are staged, promote child tickets to ready-for-agent
  for (let i = 0; i < action.childTickets.length; i++) {
    const childInput = action.childTickets[i]!;
    const childNumber = createdNumbers[i]!;

    const childLabels = [READY_FOR_AGENT, ...(childInput.labels ?? [])].filter(
      (l) => l !== NEEDS_OWNER && l !== NEEDS_TRIAGE && l !== NEEDS_INFO,
    );

    await forge.updateIssue(repo, childNumber, {
      labels: Array.from(new Set(childLabels)),
    });
  }
  record.phase = "promoted_children";
  saveStagingRecord(stagingFile, record);

  // Stage 4: Post summary comment FIRST! (summary before parent promotion so parent is not excluded before completion)
  const summaryComment = [
    `Initiative decomposed into ${createdNumbers.length} sequential/parallel tickets:`,
    ...createdNumbers.map((num, idx) => `- #${num}: ${action.childTickets[idx]!.title}`),
    "",
    TRIAGE_AGENT_MARKER,
  ].join("\n");

  const latestIssue = await forge.getIssue(repo, issue.number);
  const commentsCurrent = latestIssue?.comments ?? issue.comments ?? [];
  const alreadyHasSummary = commentsCurrent.some(
    (c) =>
      (c.body ?? "").includes(TRIAGE_AGENT_MARKER) &&
      (c.body ?? "").includes("Initiative decomposed into"),
  );
  if (!alreadyHasSummary) {
    await forge.createIssueComment(repo, issue.number, summaryComment);
  }
  record.phase = "posted_summary";
  saveStagingRecord(stagingFile, record);

  // Stage 5: Promote parent spec issue LAST!
  const existingParentLabels = normalizeLabels(latestIssue?.labels ?? issue.labels).filter(
    (l) => l !== NEEDS_TRIAGE && l !== NEEDS_INFO && l !== NEEDS_OWNER,
  );
  const updatedParentLabels = Array.from(new Set([...existingParentLabels, SPEC, READY_FOR_HUMAN]));

  await forge.updateIssue(repo, issue.number, {
    title: action.parentTitle,
    body: action.parentBody,
    labels: updatedParentLabels,
  });
  record.phase = "completed";

  try {
    rmSync(stagingFile, { force: true });
  } catch {}

  return {
    status: "promoted_epic",
    createdChildIssues: createdNumbers,
    reason: action.reason,
  };
}

function recordTriageFailure(
  stateRoot: string,
  issueNumber: number,
  fingerprint: string,
  lastError: string,
): void {
  const failuresDir = join(stateRoot, "triage-failures");
  mkdirSync(failuresDir, { recursive: true });
  const failureFile = join(failuresDir, `issue-${issueNumber}.json`);
  let attempts = 1;
  if (existsSync(failureFile)) {
    try {
      const raw = JSON.parse(readFileSync(failureFile, "utf-8"));
      const parsedRecord = triageFailureRecordSchema.safeParse(raw);
      if (parsedRecord.success && parsedRecord.data.fingerprint === fingerprint) {
        attempts = parsedRecord.data.attempts + 1;
      }
    } catch {
      attempts = 1;
    }
  }
  const record: TriageFailureRecord = {
    fingerprint,
    attempts,
    failedAt: new Date().toISOString(),
    lastError,
  };
  const tmpFile = `${failureFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(record, null, 2), "utf-8");
    renameSync(tmpFile, failureFile);
  } catch (err) {
    try {
      if (existsSync(tmpFile)) {
        rmSync(tmpFile, { force: true });
      }
    } catch {}
    throw err;
  }
}

function clearTriageFailure(stateRoot: string, issueNumber: number): void {
  const failureFile = join(stateRoot, "triage-failures", `issue-${issueNumber}.json`);
  if (existsSync(failureFile)) {
    rmSync(failureFile, { force: true });
  }
}

async function executeAskClarification(
  forge: IssueForgeAdapter,
  repo: string,
  issueNumber: number,
  existingLabels: Array<{ name: string } | string> | undefined,
  question: string,
  reason: string,
): Promise<TriageIssueResult> {
  const commentBody = `${question}\n\n${TRIAGE_AGENT_MARKER}`;
  await forge.createIssueComment(repo, issueNumber, commentBody);
  const normalized = normalizeLabels(existingLabels);
  const newLabels = normalized.filter((l) => l !== NEEDS_TRIAGE);
  if (!newLabels.includes(NEEDS_INFO)) {
    newLabels.push(NEEDS_INFO);
  }
  const targetLabels = Array.from(new Set(newLabels));
  const labelsChanged =
    targetLabels.length !== normalized.length ||
    targetLabels.some((l) => !normalized.includes(l)) ||
    normalized.some((l) => !targetLabels.includes(l));
  if (labelsChanged) {
    await forge.updateIssue(repo, issueNumber, {
      labels: targetLabels,
    });
  }
  return {
    issueNumber,
    status: "clarification_requested",
    action: "ask_clarification",
    reason,
  };
}

async function triageSingleIssue(
  issueNumber: number,
  options: RunTriagePassOptions,
): Promise<TriageIssueResult> {
  const { root, repo, stateRoot } = options;
  const forge = assertIssueForge(options.forge ?? new SystemForgeAdapter());

  const lock = await acquireTriageIssueLock(stateRoot, issueNumber);
  if (!lock) {
    return {
      issueNumber,
      status: "skipped",
      reason: `Could not acquire exclusive lock for issue #${issueNumber}`,
    };
  }

  let currentIssue: ForgeIssue | undefined;
  let failurePersistenceError: string | undefined;

  const recordFailure = (lastError: string) => {
    try {
      const fp = currentIssue ? computeIssueFreshnessFingerprint(currentIssue) : "";
      recordTriageFailure(stateRoot, issueNumber, fp, lastError);
    } catch (err: any) {
      failurePersistenceError = err?.message || String(err);
    }
  };

  const clearFailure = (): string | undefined => {
    try {
      clearTriageFailure(stateRoot, issueNumber);
      return undefined;
    } catch (err: any) {
      return `Failed to clear triage failure record: ${err?.message || String(err)}`;
    }
  };

  const fail = (error: string): TriageIssueResult => {
    recordFailure(error);
    const finalError = failurePersistenceError
      ? `${error} (failed to persist triage failure record: ${failurePersistenceError})`
      : error;
    return {
      issueNumber,
      status: "failed",
      error: finalError,
    };
  };

  try {
    const issue = await forge.getIssue(repo, issueNumber);
    if (!issue) {
      return {
        issueNumber,
        status: "skipped",
        reason: `Issue #${issueNumber} not found on forge`,
      };
    }
    currentIssue = issue;

    const eligibility = evaluateTriageEligibility(issue, stateRoot);
    if (!eligibility.eligible) {
      return {
        issueNumber,
        status: "skipped",
        reason: eligibility.reason,
      };
    }

    // F2: Check if staged epic promotion recovery is in progress for this issue
    const stagingDir = join(stateRoot, "triage-staging");
    const stagingFile = join(stagingDir, `epic-${issue.number}.json`);

    if (existsSync(stagingFile)) {
      const validation = validateStagingRecord(stagingFile, repo, issue.number);
      if (!validation.valid) {
        quarantineStagingFile(stateRoot, stagingFile, issue.number);
        const existingParentLabels = normalizeLabels(issue.labels).filter(
          (l) => l !== NEEDS_TRIAGE && l !== NEEDS_INFO,
        );
        await forge.updateIssue(repo, issue.number, {
          labels: Array.from(new Set([...existingParentLabels, NEEDS_OWNER])),
        });
        await forge.createIssueComment(
          repo,
          issue.number,
          `Triage recovery held: epic staging record was invalid or corrupt and has been quarantined. Issue transitioned to needs-owner for operator review.\n\n${TRIAGE_AGENT_MARKER}`,
        );
        return {
          issueNumber,
          status: "held",
          reason: `Invalid or corrupt epic staging checkpoint quarantined (${validation.reason}); issue #${issue.number} transitioned to ${NEEDS_OWNER}`,
        };
      }

      // Valid checkpoint: resume host application directly under lock without fresh model invocation
      const beforeSnapshot = getWorkspaceSnapshot(root);
      const epicResult = await handleEpicPromotion(
        forge,
        repo,
        issue,
        validation.record.action,
        stateRoot,
        validation.record,
      );
      const afterSnapshot = getWorkspaceSnapshot(root);
      if (beforeSnapshot !== afterSnapshot) {
        throw new Error(
          `TRIAGE SAFETY VIOLATION: Working tree in '${root}' was mutated during triage execution.\nBefore: ${beforeSnapshot}\nAfter: ${afterSnapshot}`,
        );
      }
      const clearErr = clearFailure();
      if (clearErr) {
        return {
          issueNumber,
          status: "failed",
          error: clearErr,
        };
      }
      return {
        issueNumber,
        status: epicResult.status,
        action: "promote_epic_spec_and_tickets",
        createdChildIssues: epicResult.createdChildIssues,
        reason: epicResult.reason,
      };
    }

    // Deterministic Fast-Path for Empty / Stub Issues (AC3)
    const trimmedBody = (issue.body ?? "").trim();
    const commentCount = (issue.comments ?? []).length;
    if (trimmedBody.length === 0 && commentCount === 0) {
      if (options.dryRun) {
        return {
          issueNumber,
          status: "planned",
          action: "ask_clarification",
          reason: "Issue body is empty with no comments; deterministic clarification requested.",
        };
      }

      const res = await executeAskClarification(
        forge,
        repo,
        issueNumber,
        issue.labels,
        "Please provide a description of the problem, intended outcome, and reproduction steps or acceptance criteria.",
        "Issue body is empty with no comments; deterministic clarification requested.",
      );
      const clearErr = clearFailure();
      if (clearErr) {
        return {
          issueNumber,
          status: "failed",
          error: clearErr,
        };
      }
      return res;
    }

    const effectiveEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(options.env ?? {}),
    };
    const roleConfig = resolveRoleConfig(root, "triage", effectiveEnv);
    const provider = roleConfig.provider;
    const model = roleConfig.model;
    const effort = roleConfig.effort;

    // The domain playbook is required; exploratory planning skills are optional and selected by it.
    const skills = resolveAllowedSkills(root, "triage", options.acceptedRef);
    if (!skills.some((skill) => basename(skill) === REQUIRED_TRIAGE_SKILL)) {
      return {
        issueNumber,
        status: "held",
        reason:
          "Triage execution requires the accepted triage playbook (animus-triage), but it is unavailable.",
      };
    }

    // Ambient / options PI_OFFLINE holds no transport
    const isOffline =
      process.env.PI_OFFLINE === "1" ||
      options.env?.PI_OFFLINE === "1" ||
      Boolean(process.env.PI_OFFLINE || options.env?.PI_OFFLINE);
    if (isOffline) {
      return {
        issueNumber,
        status: "held",
        reason:
          "PI_OFFLINE is active: offline mode holds triage execution without transport invocation.",
      };
    }

    const extensions = resolveLoopExtensions(root, options.acceptedRef);

    // Strict provider safety check: unsupported configurations must hold, not launch unguarded
    if (provider === "pi" || provider === "omp") {
      if (extensions.length === 0) {
        return {
          issueNumber,
          status: "held",
          reason: `Safety guard extension hook (.factory/hooks/loop-guard.ts) could not be verified for provider '${provider}'.`,
        };
      }
    } else if (provider === "claude") {
      // Claude Code enforces safety natively via tool inventory restrictions and disabled settings
    } else {
      return {
        issueNumber,
        status: "held",
        reason: `Unsupported safety configuration for provider '${provider}': read-only tool guard cannot be verified.`,
      };
    }

    const artifactsDir = join(stateRoot, "triage-artifacts", String(issue.number));
    mkdirSync(artifactsDir, { recursive: true });

    const promptText = renderTriagePrompt(root, issue, repo, artifactsDir);

    const appendSystemPrompts = buildCuratedAppendPrompts(
      root,
      {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: "",
        comments: (issue.comments ?? []).map((c) => c.body ?? ""),
        dependencies: [],
        activeClaim: false,
      },
      "",
      options.acceptedRef,
    );

    const argv = buildProviderArgv(provider, {
      model,
      effort,
      prompt: promptText,
      skills,
      appendSystemPrompts,
      extensions: provider === "pi" || provider === "omp" ? extensions : undefined,
      tools: provider === "claude" ? "Read,Glob,Grep" : "read,grep,find,ls",
      allowedTools: provider === "claude" ? ["Read", "Glob", "Grep"] : undefined,
      disallowedTools: provider === "claude" ? ["Write", "Edit"] : undefined,
      strictMcp: provider === "claude" ? true : undefined,
      settingSources: provider === "claude" ? "" : undefined,
    });

    // Force FACTORY_LOOP_ROLE: "triage" last so options.env cannot override it
    const env: Record<string, string> = {
      ...process.env,
      ...(options.env ?? {}),
      FACTORY_LOOP_ROLE: "triage",
    };

    const beforeFreshness = computeIssueFreshnessFingerprint(issue);
    const beforeSnapshot = getWorkspaceSnapshot(root);

    const transport: AgentTransport =
      options.transport ?? ((req) => processRun(req.argv, req.cwd, req.timeoutMs, req.env));

    const budgets = resolveRoleBudgets(
      {
        timeoutMs: options.timeoutMs,
        roleBudgets: options.roleBudgets,
      },
      env,
    );
    const timeoutMs = budgets.triage.hardMs;
    const response = await transport({
      argv,
      cwd: root,
      role: "triage",
      provider,
      timeoutMs,
      env,
    });

    const afterSnapshot = getWorkspaceSnapshot(root);
    if (beforeSnapshot !== afterSnapshot) {
      throw new Error(
        `TRIAGE SAFETY VIOLATION: Working tree in '${root}' was mutated during triage execution.\nBefore: ${beforeSnapshot}\nAfter: ${afterSnapshot}`,
      );
    }

    if (response.timedOut || response.exitCode === 124) {
      return fail(`Triage agent execution timed out after ${timeoutMs}ms`);
    }

    if (response.exitCode !== 0) {
      return fail(
        `Triage agent transport exited with code ${response.exitCode}: ${response.stderr}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = extractReportObject(response.stdout);
    } catch (err: any) {
      return fail(`Malformed triage output: ${err?.message || String(err)}`);
    }

    const validated = triageOutputSchema.safeParse(parsed);
    if (!validated.success) {
      return fail(`Invalid triage output schema: ${validated.error.message}`);
    }

    const action = validated.data;

    if (options.dryRun) {
      // Validate canonical/deps/agreement in dry-run mode without claiming premature promotion
      if (action.action === "promote_single_ticket") {
        const bodyCheck = validateCanonicalIssueBody(action.body);
        if (!bodyCheck.valid) {
          return fail(`Canonical markdown validation failed: ${bodyCheck.errors.join("; ")}`);
        }
      } else if (action.action === "promote_epic_spec_and_tickets") {
        const parentCheck = validateCanonicalIssueBody(action.parentBody);
        if (!parentCheck.valid) {
          return fail(`Parent spec fails canonical structure: ${parentCheck.errors.join("; ")}`);
        }
        for (let i = 0; i < action.childTickets.length; i++) {
          const child = action.childTickets[i]!;
          const check = validateCanonicalIssueBody(child.body);
          if (!check.valid) {
            return fail(
              `Child ticket #${i + 1} ('${child.title}') fails canonical structure: ${check.errors.join("; ")}`,
            );
          }
        }
        const comments = issue.comments ?? [];
        const agreementRef = action.agreementCommentId.trim();
        const humanAgreement = comments.find((c) => {
          if (!c.id) return false;
          if (c.id.trim() !== agreementRef) return false;
          const body = (c.body ?? "").trim();
          if (body.includes(TRIAGE_AGENT_MARKER)) return false;
          return true;
        });
        if (!humanAgreement) {
          return fail(
            `Epic promotion rejected: could not find valid human agreement comment matching exact ID '${action.agreementCommentId}' without agent marker.`,
          );
        }
      }

      return {
        issueNumber,
        status: "planned",
        action: action.action,
        reason: action.reason,
      };
    }

    // Recheck fresh issue right before mutation to prevent race conditions or stale turns
    const fresh = await forge.getIssue(repo, issueNumber);
    if (!fresh || fresh.state.toUpperCase() !== "OPEN") {
      return {
        issueNumber,
        status: "skipped",
        reason: "Issue state changed or closed before applying mutation",
      };
    }

    const freshEligibility = evaluateTriageEligibility(fresh, stateRoot);
    if (!freshEligibility.eligible) {
      return {
        issueNumber,
        status: "skipped",
        reason: `Issue turned ineligible before mutation: ${freshEligibility.reason}`,
      };
    }

    // Comprehensive freshness check: title, body, labels, comments
    const afterFreshness = computeIssueFreshnessFingerprint(fresh);
    if (beforeFreshness !== afterFreshness) {
      return {
        issueNumber,
        status: "skipped",
        reason:
          "Issue content (title, body, labels, or comments) was modified while triage agent was executing",
      };
    }

    const existingLabels = normalizeLabels(fresh.labels);

    if (existsSync(stagingFile) && action.action !== "promote_epic_spec_and_tickets") {
      quarantineStagingFile(stateRoot, stagingFile, issueNumber);
      const newLabels = existingLabels
        .filter((l) => l !== NEEDS_TRIAGE && l !== NEEDS_INFO)
        .concat(NEEDS_OWNER);
      await forge.updateIssue(repo, issueNumber, {
        labels: Array.from(new Set(newLabels)),
      });
      await forge.createIssueComment(
        repo,
        issueNumber,
        `Triage recovery held: non-epic action received while epic staging exists; quarantined and transitioned to needs-owner.\n\n${TRIAGE_AGENT_MARKER}`,
      );
      return {
        issueNumber,
        status: "held",
        reason:
          "Non-epic action received while epic staging exists; quarantined and transitioned to needs-owner.",
      };
    }

    switch (action.action) {
      case "ask_clarification": {
        const res = await executeAskClarification(
          forge,
          repo,
          issueNumber,
          fresh.labels,
          action.question,
          action.reason,
        );
        const clearErr = clearFailure();
        if (clearErr) {
          return {
            issueNumber,
            status: "failed",
            error: clearErr,
          };
        }
        return res;
      }

      case "promote_single_ticket": {
        const bodyCheck = validateCanonicalIssueBody(action.body);
        if (!bodyCheck.valid) {
          return fail(`Canonical markdown validation failed: ${bodyCheck.errors.join("; ")}`);
        }
        const targetLabel = action.authority === "human" ? READY_FOR_HUMAN : READY_FOR_AGENT;
        const newLabels = existingLabels
          .filter((l) => l !== NEEDS_TRIAGE && l !== NEEDS_INFO)
          .concat(targetLabel);

        await forge.updateIssue(repo, issueNumber, {
          title: action.title,
          body: action.body,
          labels: Array.from(new Set(newLabels)),
        });

        const clearErr = clearFailure();
        if (clearErr) {
          return {
            issueNumber,
            status: "failed",
            error: clearErr,
          };
        }
        return {
          issueNumber,
          status: "promoted_single",
          action: "promote_single_ticket",
          reason: action.reason,
        };
      }

      case "promote_epic_spec_and_tickets": {
        const epicResult = await handleEpicPromotion(forge, repo, fresh, action, stateRoot);
        const clearErr = clearFailure();
        if (clearErr) {
          return {
            issueNumber,
            status: "failed",
            error: clearErr,
          };
        }
        return {
          issueNumber,
          status: epicResult.status,
          action: "promote_epic_spec_and_tickets",
          createdChildIssues: epicResult.createdChildIssues,
          reason: epicResult.reason,
        };
      }

      case "hold_for_human": {
        const newLabels = existingLabels
          .filter((l) => l !== NEEDS_TRIAGE && l !== NEEDS_INFO)
          .concat(READY_FOR_HUMAN);

        await forge.updateIssue(repo, issueNumber, {
          labels: Array.from(new Set(newLabels)),
        });

        if (action.comment) {
          await forge.createIssueComment(
            repo,
            issueNumber,
            `${action.comment}\n\n${TRIAGE_AGENT_MARKER}`,
          );
        }

        const clearErr = clearFailure();
        if (clearErr) {
          return {
            issueNumber,
            status: "failed",
            error: clearErr,
          };
        }
        return {
          issueNumber,
          status: "held",
          action: "hold_for_human",
          reason: action.reason,
        };
      }
    }
  } catch (err: any) {
    return fail(err?.message || String(err));
  } finally {
    await lock.release();
  }
}

export async function runTriagePass(options: RunTriagePassOptions): Promise<TriagePassResult> {
  validateTriagePassInputs(options);

  const { repo } = options;
  const forge = assertIssueForge(options.forge ?? new SystemForgeAdapter());

  let targetIssues: number[] = [];

  if (typeof options.issueNumber === "number") {
    targetIssues = [options.issueNumber];
  } else {
    const openIssues = await forge.listIssues(repo, "OPEN");
    targetIssues = openIssues
      .filter((iss) => isIssueEligibleForTriage(iss, options.stateRoot))
      .map((iss) => iss.number);
  }

  if (typeof options.limit === "number" && options.limit > 0) {
    targetIssues = targetIssues.slice(0, options.limit);
  }

  const processed: TriageIssueResult[] = [];
  let skippedCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let heldCount = 0;

  for (const num of targetIssues) {
    let result: TriageIssueResult;
    try {
      result = await triageSingleIssue(num, options);
    } catch (unhandledErr: any) {
      result = {
        issueNumber: num,
        status: "failed",
        error: unhandledErr?.message || String(unhandledErr),
      };
    }
    processed.push(result);
    if (result.status === "skipped") {
      skippedCount++;
    } else if (result.status === "failed") {
      failureCount++;
    } else if (result.status === "held") {
      heldCount++;
      if (result.action === "hold_for_human") {
        successCount++;
      }
    } else {
      successCount++;
    }
  }

  return {
    processed,
    skippedCount,
    successCount,
    failureCount,
    heldCount,
  };
}
