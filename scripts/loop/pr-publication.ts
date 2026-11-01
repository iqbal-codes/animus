import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processRun } from "./process";
import { updatePrBodyEvidence, type AmbiguousEvidenceBoundaryError } from "./pr-reporting";
import type { CaptureRecord, EvidenceUrlMapping } from "./report-schema";

export type GhRunner = (
  args: string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;

export const defaultGhRunner: GhRunner = async (args, cwd, timeoutMs = 30_000) => {
  return processRun(args, cwd, timeoutMs);
};

export interface PublicationRecord {
  timestamp: string;
  action: "pr_evidence_update" | "comment" | "pr_create";
  targetKind: "pr" | "issue";
  target: string;
  commentType?: "builder" | "review" | "ci_check" | "escalation";
  candidate: string;
  commentUrl?: string;
  success: boolean;
  contentHash?: string;
  error?: string;
}

export interface PublicationErrorRecord {
  timestamp: string;
  action: string;
  target: string;
  candidate: string;
  error: string;
  stderr?: string;
  migrationPreview?: string;
}

function ensureArtifactsDir(artifactsDir: string): void {
  if (!existsSync(artifactsDir)) {
    try {
      mkdirSync(artifactsDir, { recursive: true });
    } catch {}
  }
}

function loadPublicationRecords(artifactsDir: string): PublicationRecord[] {
  const file = join(artifactsDir, "publication-records.json");
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function appendPublicationRecord(artifactsDir: string, record: PublicationRecord): void {
  ensureArtifactsDir(artifactsDir);
  const records = loadPublicationRecords(artifactsDir);
  records.push(record);
  try {
    writeFileSync(
      join(artifactsDir, "publication-records.json"),
      JSON.stringify(records, null, 2),
      "utf-8",
    );
  } catch {}
}

function recordPublicationError(artifactsDir: string, errorRecord: PublicationErrorRecord): void {
  ensureArtifactsDir(artifactsDir);
  const file = join(artifactsDir, "publication-errors.json");
  let list: PublicationErrorRecord[] = [];
  if (existsSync(file)) {
    try {
      list = JSON.parse(readFileSync(file, "utf-8"));
    } catch {}
  }
  list.push(errorRecord);
  try {
    writeFileSync(file, JSON.stringify(list, null, 2), "utf-8");
  } catch {}
}

/**
 * Applies existing manual evidence mappings to captures if mapping file exists for candidate.
 */
export function syncExistingEvidenceBindings(
  captures: CaptureRecord[],
  artifactsDir: string,
  candidate: string,
): CaptureRecord[] {
  const mappingPath = join(artifactsDir, "evidence-mapping.json");
  if (!existsSync(mappingPath)) return captures;

  try {
    const mapping: EvidenceUrlMapping = JSON.parse(readFileSync(mappingPath, "utf-8"));
    if (mapping.candidate && mapping.candidate !== candidate) {
      return captures;
    }

    for (const cap of captures) {
      const bound = mapping.mappings[cap.id];
      if (bound) {
        if (bound.beforeUrl) cap.beforeHostedUrl = bound.beforeUrl;
        if (bound.afterUrl) cap.afterHostedUrl = bound.afterUrl;
        cap.hostedUrlStatus = "supplied_unverified";
      }
    }
  } catch {}

  return captures;
}

/**
 * Centralized pipeline for publishing evidence updates to a GitHub Pull Request.
 * - Reads current PR body and headRefOid
 * - Rejects stale candidates
 * - Updates only bounded evidence section, preserving human edits
 * - Re-reads before write to detect concurrent modifications
 * - Checks exit code on edit
 * - Reads back to verify publication
 * - Persists intended output, records, and errors locally
 */
export async function publishPrEvidenceUpdate(params: {
  repoRoot: string;
  pr: string;
  candidate: string;
  newEvidenceContent: string;
  runDirectory?: string;
  runner?: GhRunner;
}): Promise<{ ok: boolean; prUrl: string; message: string; readbackVerified: boolean }> {
  const { repoRoot, pr, candidate, newEvidenceContent, runDirectory } = params;
  const runner = params.runner || defaultGhRunner;
  const artifactsDir = runDirectory ? join(runDirectory, "artifacts") : join(repoRoot, "artifacts");

  // 1. Fetch existing PR
  const viewRes = await runner(
    ["gh", "pr", "view", pr, "--json", "body,headRefOid"],
    repoRoot,
    30_000,
  );
  if (viewRes.exitCode !== 0) {
    const errMsg = `Failed to fetch PR ${pr}: ${viewRes.stderr || "exit " + viewRes.exitCode}`;
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "pr_view",
      target: pr,
      candidate,
      error: errMsg,
      stderr: viewRes.stderr,
    });
    throw new Error(errMsg);
  }

  let prData: { body?: string; headRefOid?: string };
  try {
    prData = JSON.parse(viewRes.stdout);
  } catch (err: any) {
    const errMsg = `Failed to parse gh pr view output: ${err.message}`;
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "pr_view_parse",
      target: pr,
      candidate,
      error: errMsg,
    });
    throw new Error(errMsg);
  }

  // 2. Reject stale candidate head
  if (!prData.headRefOid || prData.headRefOid !== candidate) {
    const errMsg = `Refusing PR evidence publication: PR head has changed to '${prData.headRefOid}' (run candidate is '${candidate}'). Re-run verification on the new head.`;
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "stale_head_check",
      target: pr,
      candidate,
      error: errMsg,
    });
    throw new Error(errMsg);
  }

  const existingBody = prData.body || "";

  // 3. Compute updated body and validate boundaries
  let updatedBody: string;
  try {
    updatedBody = updatePrBodyEvidence(existingBody, newEvidenceContent);
  } catch (err: any) {
    const preview = (err as AmbiguousEvidenceBoundaryError).migrationPreview;
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "update_pr_body_evidence",
      target: pr,
      candidate,
      error: err.message,
      migrationPreview: preview,
    });
    throw err;
  }

  // 4. Concurrency check: re-read before write
  const concurRes = await runner(
    ["gh", "pr", "view", pr, "--json", "body,headRefOid"],
    repoRoot,
    15_000,
  );
  try {
    if (concurRes.exitCode !== 0)
      throw new Error(`Cannot verify current PR state: ${concurRes.stderr}`);
    const concurData = JSON.parse(concurRes.stdout);
    if (concurData.body !== existingBody || concurData.headRefOid !== candidate) {
      throw new Error(
        `Concurrent modification detected on PR ${pr} before write; aborting update to prevent data loss.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "concurrency_check",
      target: pr,
      candidate,
      error: message,
    });
    throw new Error(message);
  }
  ensureArtifactsDir(artifactsDir);
  writeFileSync(
    join(artifactsDir, "evidence-publication-intent.json"),
    JSON.stringify({ candidate, pr, body: updatedBody }, null, 2),
    "utf-8",
  );

  // 5. Execute PR update
  const editRes = await runner(["gh", "pr", "edit", pr, "--body", updatedBody], repoRoot, 30_000);
  if (editRes.exitCode !== 0) {
    const errMsg = `gh pr edit failed on ${pr} (exit code ${editRes.exitCode}): ${editRes.stderr}`;
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "pr_edit",
      target: pr,
      candidate,
      error: errMsg,
      stderr: editRes.stderr,
    });
    throw new Error(errMsg);
  }

  // 6. Read back update to confirm
  const verifyRes = await runner(
    ["gh", "pr", "view", pr, "--json", "body,headRefOid"],
    repoRoot,
    15_000,
  );
  if (verifyRes.exitCode !== 0) {
    const errMsg = `Readback verification failed after gh pr edit on ${pr}: ${verifyRes.stderr}`;
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "readback_verification",
      target: pr,
      candidate,
      error: errMsg,
      stderr: verifyRes.stderr,
    });
    throw new Error(errMsg);
  }

  try {
    const verifyData = JSON.parse(verifyRes.stdout);
    const bodyText = verifyData.body || "";
    if (bodyText !== updatedBody || verifyData.headRefOid !== candidate) {
      const errMsg = `Readback verification failed: updated PR body does not contain expected evidence boundaries.`;
      recordPublicationError(artifactsDir, {
        timestamp: new Date().toISOString(),
        action: "readback_boundary_check",
        target: pr,
        candidate,
        error: errMsg,
      });
      throw new Error(errMsg);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "readback_verification",
      target: pr,
      candidate,
      error: message,
    });
    throw new Error(`Readback verification failed: ${message}`);
  }

  // 7. Persist intended output and audit records
  ensureArtifactsDir(artifactsDir);
  const publishRecordPath = join(artifactsDir, "evidence-publish.json");
  try {
    writeFileSync(
      publishRecordPath,
      JSON.stringify(
        {
          publishedAt: new Date().toISOString(),
          prUrl: pr,
          candidate,
          readbackVerified: true,
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch {}

  appendPublicationRecord(artifactsDir, {
    timestamp: new Date().toISOString(),
    action: "pr_evidence_update",
    targetKind: "pr",
    target: pr,
    candidate,
    success: true,
  });

  return {
    ok: true,
    prUrl: pr,
    message: `PR evidence section updated successfully on ${pr}`,
    readbackVerified: true,
  };
}

/**
 * Centralized pipeline for publishing PR or Issue comments with idempotency checks.
 */
export async function publishComment(params: {
  repoRoot: string;
  target: { kind: "pr" | "issue"; idOrUrl: string | number };
  commentType: "builder" | "review" | "ci_check" | "escalation";
  commentBody: string;
  candidate: string;
  runDirectory?: string;
  runner?: GhRunner;
}): Promise<{ ok: boolean; commentUrl?: string; message: string }> {
  const { repoRoot, target, commentType, commentBody, candidate, runDirectory } = params;
  const runner = params.runner || defaultGhRunner;
  const artifactsDir = runDirectory ? join(runDirectory, "artifacts") : join(repoRoot, "artifacts");

  const targetStr = String(target.idOrUrl);

  // Check local audit trail for duplicates
  const existingRecords = loadPublicationRecords(artifactsDir);
  const duplicate = existingRecords.find(
    (r) =>
      r.action === "comment" &&
      r.targetKind === target.kind &&
      r.target === targetStr &&
      r.commentType === commentType &&
      r.candidate === candidate &&
      r.success === true,
  );
  if (duplicate) {
    return {
      ok: true,
      commentUrl: duplicate.commentUrl,
      message: `Comment of type '${commentType}' already published for candidate '${candidate}'.`,
    };
  }

  const cmd =
    target.kind === "pr"
      ? ["gh", "pr", "comment", targetStr, "--body", commentBody]
      : ["gh", "issue", "comment", targetStr, "--body", commentBody];

  const commentRes = await runner(cmd, repoRoot, 30_000);
  if (commentRes.exitCode !== 0) {
    const errMsg = `gh ${target.kind} comment failed on ${targetStr} (exit code ${commentRes.exitCode}): ${commentRes.stderr}`;
    recordPublicationError(artifactsDir, {
      timestamp: new Date().toISOString(),
      action: "comment_post",
      target: targetStr,
      candidate,
      error: errMsg,
      stderr: commentRes.stderr,
    });
    throw new Error(errMsg);
  }

  const commentUrl = commentRes.stdout.trim() || undefined;

  appendPublicationRecord(artifactsDir, {
    timestamp: new Date().toISOString(),
    action: "comment",
    targetKind: target.kind,
    target: targetStr,
    commentType,
    candidate,
    commentUrl,
    success: true,
  });

  return {
    ok: true,
    commentUrl,
    message: `Comment published successfully on ${target.kind} ${targetStr}`,
  };
}
