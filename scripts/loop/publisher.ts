import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./worktree";
import { checkPrCiStatus, pollPrCiStatus, type PrCiAssessment } from "./ci";
import {
  renderCanonicalPrBody,
  renderEvidenceContent,
  formatBuilderComment,
} from "./pr-reporting";
import {
  appendPublicationRecord,
  loadPublicationRecords,
  recordPublicationError,
  defaultGhRunner,
  publishComment,
  publishPrEvidenceUpdate,
  publishPrReview,
  syncExistingEvidenceBindings,
  type PublicationRecord,
} from "./pr-publication";
import type {
  GhRunner,
  LocalIssue,
  LocalLoopResult,
  LocalLoopRoute,
} from "./types";
import type {
  CaptureRecord,
  HostBoundIdentities,
  ReviewFinding,
} from "./report-schema";

export interface LoopPublisherOptions {
  worktree: string;
  runDirectory: string;
  artifactsDir: string;
  issueNumber: number;
  push?: boolean;
  runner?: GhRunner;
}

export class LoopPublisher {
  readonly worktree: string;
  readonly runDirectory: string;
  readonly artifactsDir: string;
  readonly issueNumber: number;
  readonly push: boolean;
  readonly runner: GhRunner;

  constructor(options: LoopPublisherOptions) {
    this.worktree = options.worktree;
    this.runDirectory = options.runDirectory;
    this.artifactsDir = options.artifactsDir;
    this.issueNumber = options.issueNumber;
    this.push = options.push !== false;
    this.runner = options.runner || defaultGhRunner;
  }

  getRunner(): GhRunner {
    return this.runner;
  }

  getPublicationRecords(): PublicationRecord[] {
    return loadPublicationRecords(this.artifactsDir);
  }

  isDeduplicated(
    action: PublicationRecord["action"],
    target: string,
    candidate: string,
    commentType?: PublicationRecord["commentType"],
  ): boolean {
    const records = loadPublicationRecords(this.artifactsDir);
    return records.some(
      (r) =>
        r.action === action &&
        r.target === target &&
        r.candidate === candidate &&
        (commentType === undefined || r.commentType === commentType) &&
        r.success === true,
    );
  }

  async isPrOpen(pr: string | number): Promise<boolean> {
    try {
      const prView = await this.runner(
        ["gh", "pr", "view", String(pr), "--json", "state"],
        this.worktree,
        15_000,
      );
      if (prView.exitCode === 0) {
        const prData = JSON.parse(prView.stdout);
        if (prData.state && String(prData.state).toUpperCase() !== "OPEN") {
          return false;
        }
      }
    } catch {}
    return true;
  }

  async createPullRequest(options: {
    branch: string;
    title: string;
    body: string;
    base?: string;
    candidate: string;
  }): Promise<{ prUrl?: string; created: boolean; deduplicated?: boolean }> {
    const { branch, title, body, base = "main", candidate } = options;

    // Check deduplication
    const records = loadPublicationRecords(this.artifactsDir);
    const existing = records.find(
      (r) =>
        r.action === "pr_create" &&
        (r.target === branch || r.candidate === candidate) &&
        r.success === true,
    );
    if (existing && existing.targetKind === "pr" && existing.target.startsWith("http")) {
      return { prUrl: existing.target, created: false, deduplicated: true };
    }

    if (this.push === false) {
      return { created: false };
    }

    // Check if PR already exists
    try {
      const prView = await this.runner(
        ["gh", "pr", "view", branch, "--json", "url"],
        this.worktree,
        15_000,
      );
      if (prView.exitCode === 0) {
        try {
          const parsed = JSON.parse(prView.stdout);
          if (parsed.url) {
            appendPublicationRecord(this.artifactsDir, {
              timestamp: new Date().toISOString(),
              action: "pr_create",
              targetKind: "pr",
              target: parsed.url,
              candidate,
              success: true,
            });
            return { prUrl: parsed.url, created: false };
          }
        } catch {}
      }
    } catch {}

    const prCreate = await this.runner(
      [
        "gh",
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--head",
        branch,
        "--base",
        base,
      ],
      this.worktree,
      30_000,
    );

    if (prCreate.exitCode === 0) {
      const prUrl = prCreate.stdout.trim();
      appendPublicationRecord(this.artifactsDir, {
        timestamp: new Date().toISOString(),
        action: "pr_create",
        targetKind: "pr",
        target: prUrl,
        candidate,
        success: true,
      });

      const publicationLog = join(this.runDirectory, "evidence-publication.log");
      try {
        writeFileSync(
          publicationLog,
          JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              action: "pr_create",
              target: prUrl,
              candidate,
              success: true,
            },
            null,
            2,
          ) + "\n",
          { flag: "a" },
        );
      } catch {}

      return { prUrl, created: true };
    } else {
      recordPublicationError(this.artifactsDir, {
        timestamp: new Date().toISOString(),
        action: "pr_create",
        target: branch,
        candidate,
        error: `gh pr create failed on ${branch} (exit code ${prCreate.exitCode}): ${prCreate.stderr}`,
        stderr: prCreate.stderr,
      });
      return { created: false };
    }
  }

  async updatePrEvidence(options: {
    pr: string;
    candidate: string;
    newEvidenceContent: string;
  }): Promise<{ ok: boolean; prUrl: string; readbackVerified: boolean }> {
    return publishPrEvidenceUpdate({
      repoRoot: this.worktree,
      pr: options.pr,
      candidate: options.candidate,
      newEvidenceContent: options.newEvidenceContent,
      runDirectory: this.runDirectory,
      runner: this.runner,
    });
  }

  async publishComment(options: {
    target: { kind: "pr" | "issue"; idOrUrl: string | number };
    commentType: "builder" | "review" | "ci_check" | "escalation" | "qa_check";
    commentBody: string;
    candidate: string;
  }): Promise<{ ok: boolean; commentUrl?: string; message: string; deduplicated?: boolean }> {
    return publishComment({
      repoRoot: this.worktree,
      target: options.target,
      commentType: options.commentType,
      commentBody: options.commentBody,
      candidate: options.candidate,
      runDirectory: this.runDirectory,
      runner: this.runner,
    });
  }

  async publishReview(options: {
    pr: string;
    candidate: string;
    reviewBody: string;
    findings?: (ReviewFinding | string)[];
    rawDiff?: string;
  }): Promise<{ ok: boolean; commentUrl?: string; inlineCount: number; message: string; deduplicated?: boolean }> {
    return publishPrReview({
      repoRoot: this.worktree,
      pr: options.pr,
      candidate: options.candidate,
      reviewBody: options.reviewBody,
      findings: options.findings,
      rawDiff: options.rawDiff,
      runDirectory: this.runDirectory,
      runner: this.runner,
    });
  }

  async escalateToHuman(candidate?: string): Promise<{ ok: boolean; escalated: boolean; deduplicated?: boolean }> {
    const cand = candidate || "HEAD";
    const targetStr = String(this.issueNumber);

    // Check deduplication
    if (this.isDeduplicated("label_escalation", targetStr, cand, "escalation")) {
      return { ok: true, escalated: false, deduplicated: true };
    }

    if (this.push === false) {
      return { ok: true, escalated: false };
    }

    try {
      const res = await this.runner(
        [
          "gh",
          "issue",
          "edit",
          targetStr,
          "--add-label",
          "ready-for-human",
          "--remove-label",
          "ready-for-agent",
        ],
        this.worktree,
        15_000,
      );

      if (res.exitCode === 0) {
        appendPublicationRecord(this.artifactsDir, {
          timestamp: new Date().toISOString(),
          action: "label_escalation",
          targetKind: "issue",
          target: targetStr,
          commentType: "escalation",
          candidate: cand,
          success: true,
        });
        return { ok: true, escalated: true };
      } else {
        recordPublicationError(this.artifactsDir, {
          timestamp: new Date().toISOString(),
          action: "label_escalation",
          target: targetStr,
          candidate: cand,
          error: `gh issue edit failed on ${targetStr} (exit code ${res.exitCode}): ${res.stderr}`,
          stderr: res.stderr,
        });
        return { ok: false, escalated: false };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Warning: Failed to update GitHub issue labels on escalation:", msg);
      return { ok: false, escalated: false };
    }
  }

  async publishLoopComment(options: {
    pr?: string;
    commentType: "builder" | "qa_check" | "ci_check" | "review" | "escalation";
    commentBody: string;
    candidate: string;
  }): Promise<void> {
    if (options.pr) {
      try {
        await this.publishComment({
          target: { kind: "pr", idOrUrl: options.pr },
          commentType: options.commentType,
          commentBody: options.commentBody,
          candidate: options.candidate,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: Failed to publish ${options.commentType} comment on PR:`, msg);
      }
    } else if (this.push !== false) {
      try {
        await this.publishComment({
          target: { kind: "issue", idOrUrl: this.issueNumber },
          commentType: options.commentType,
          commentBody: options.commentBody,
          candidate: options.candidate,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: Failed to publish ${options.commentType} comment on issue:`, msg);
      }
    }
  }

  async syncAndPublishPrEvidence(options: {
    pr?: string;
    candidate: string;
    captures?: CaptureRecord[];
    identities?: HostBoundIdentities;
    qaReport?: any;
    builderReport?: any;
    outstanding?: string[];
    judgeAlterations?: string[];
    autoMerge?: any;
    stageName?: string;
  }): Promise<void> {
    if (options.pr && this.push !== false) {
      try {
        const syncedCaptures = syncExistingEvidenceBindings(
          options.captures || [],
          this.artifactsDir,
          options.candidate,
        );
        const identities = options.identities ?? {
          targetBaseTip: "unknown",
          mergeBase: "unknown",
          prHead: options.candidate,
          testedHead: options.candidate,
        };
        const newEvContent = renderEvidenceContent({
          identities,
          qaReport: options.qaReport,
          builderReport: options.builderReport,
          captures: syncedCaptures,
          outstanding: options.outstanding,
          judgeAlterations: options.judgeAlterations,
          autoMerge: options.autoMerge,
        });
        await this.updatePrEvidence({
          pr: options.pr,
          candidate: options.candidate,
          newEvidenceContent: newEvContent,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: ${options.stageName ?? "Stage"} stage PR evidence synchronization error:`, msg);
      }
    }
  }

  async publishBuilderDelivery(options: {
    branch: string;
    issue: LocalIssue;
    state: LocalLoopResult;
    builderReport: any;
    route: LocalLoopRoute;
    lap: number;
    handoffDir: string;
    integrationBranch?: string;
  }): Promise<void> {
    const {
      branch,
      issue,
      state,
      builderReport,
      route,
      lap,
      handoffDir,
      integrationBranch,
    } = options;

    await Bun.write(join(handoffDir, "builder.json"), JSON.stringify(builderReport, null, 2));
    await Bun.write(
      join(handoffDir, "builder.md"),
      `# Builder Report\n\nCandidate: ${state.candidate}\nVerdict: ${builderReport.verdict}\n\n` +
        (builderReport.checks
          ?.map((c: any) => `- ${c.criterion}: ${c.result} (${c.evidence})`)
          .join("\n") || "No explicit checks"),
    );

    if (this.push === false) return;

    try {
      try {
        await git(this.worktree, "push", "-u", "origin", branch);
      } catch (pushErr: unknown) {
        // If git push fails (e.g. offline test fixture without remote origin), log warning but proceed with forge runner
        const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        console.error("Warning: git push failed:", msg);
      }

      if (!state.pr) {
        const body = renderCanonicalPrBody({
          issue,
          identities: state.identities!,
          builderReport,
        });

        const created = await this.createPullRequest({
          branch,
          title: `fix(issue-${issue.number}): ${issue.title}`,
          body,
          base: integrationBranch ?? "main",
          candidate: state.candidate!,
        });
        if (created.prUrl) {
          state.pr = created.prUrl;
        }
      }

      if (state.pr) {
        await this.syncAndPublishPrEvidence({
          pr: state.pr,
          candidate: state.candidate!,
          identities: state.identities,
          builderReport,
          stageName: "Builder",
        });
        if (route === "continue" || lap > 1) {
          const builderComment = formatBuilderComment(
            builderReport,
            lap,
            route,
            state.candidate!,
          );
          await this.publishLoopComment({
            pr: state.pr,
            commentType: "builder",
            commentBody: builderComment,
            candidate: state.candidate!,
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Warning: Builder delivery push or PR creation failed:", msg);
    }
  }

  async checkPrCiStatus(pr: string | number): Promise<PrCiAssessment> {
    return checkPrCiStatus(pr, { cwd: this.worktree, run: this.runner });
  }

  async pollPrCiStatus(
    pr: string | number,
    options?: { maxWaitSeconds?: number; pollIntervalSeconds?: number },
  ): Promise<PrCiAssessment> {
    return pollPrCiStatus(pr, {
      cwd: this.worktree,
      run: this.runner,
      maxWaitSeconds: options?.maxWaitSeconds,
      pollIntervalSeconds: options?.pollIntervalSeconds,
    });
  }
}
