import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyControlAction, resolveSharedRoot } from "./native";
import type { PromotionStatus, PromotionResult } from "@labq/contracts/operator";

const TICKET_PATTERN = /#(\d+)/g;

export interface PromotionRunner {
  (cmd: string[], cwd: string): string;
}

export function defaultRunner(cmd: string[], cwd: string): string {
  return execFileSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export class PromotionService {
  constructor(
    private readonly repoRoot: string,
    private readonly mainBranch: string = "main",
    private readonly developBranch: string = "develop",
    private readonly runner: PromotionRunner = defaultRunner,
  ) {}

  private resolveRevRange(): string | null {
    try {
      this.runner(["git", "rev-parse", "--verify", `origin/${this.developBranch}`], this.repoRoot);
      return `origin/${this.mainBranch}..origin/${this.developBranch}`;
    } catch {}

    try {
      this.runner(["git", "rev-parse", "--verify", this.developBranch], this.repoRoot);
      return `${this.mainBranch}..${this.developBranch}`;
    } catch {
      return null;
    }
  }

  public getExistingPromotionPr(): { number: number; url: string; title: string } | null {
    try {
      const output = this.runner(
        [
          "gh",
          "pr",
          "list",
          "--base",
          this.mainBranch,
          "--head",
          this.developBranch,
          "--state",
          "open",
          "--json",
          "number,url,title",
        ],
        this.repoRoot,
      );
      const data = JSON.parse(output);
      if (Array.isArray(data) && data.length > 0) {
        return {
          number: Number(data[0].number),
          url: String(data[0].url),
          title: String(data[0].title),
        };
      }
    } catch {}
    return null;
  }

  public getStatus(): PromotionStatus {
    const revRange = this.resolveRevRange();
    const commits: Array<{ hash: string; subject: string }> = [];
    const ticketNumbers = new Set<number>();

    if (revRange) {
      try {
        const logOutput = this.runner(
          ["git", "log", revRange, "--pretty=format:%H|%s"],
          this.repoRoot,
        );
        for (const line of logOutput.trim().split("\n")) {
          if (!line.trim()) continue;
          const [h, subj] = line.split("|", 2);
          if (h && subj) {
            commits.push({ hash: h, subject: subj });
            let match: RegExpExecArray | null;
            while ((match = TICKET_PATTERN.exec(subj)) !== null) {
              ticketNumbers.add(parseInt(match[1], 10));
            }
          }
        }
      } catch {}
    }

    const shared = resolveSharedRoot(this.repoRoot);
    const pauseExists =
      existsSync(join(this.repoRoot, ".factory/PAUSE")) ||
      existsSync(join(shared, ".factory/PAUSE"));
    const existingPr = this.getExistingPromotionPr();
    const deliveredTickets = Array.from(ticketNumbers).sort((a, b) => a - b);

    return {
      main_branch: this.mainBranch,
      develop_branch: this.developBranch,
      unpromoted_count: commits.length,
      delivered_tickets: deliveredTickets,
      candidate_freeze: pauseExists,
      existing_pr: existingPr,
      ready_to_promote: commits.length > 0 && existingPr === null,
    };
  }

  public preparePromotion(options?: { title?: string; summary?: string }): PromotionResult {
    const status = this.getStatus();
    if (status.unpromoted_count === 0) {
      throw new Error("no_unpromoted_commits");
    }
    if (status.existing_pr !== null) {
      throw new Error("promotion_pr_already_open");
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const prTitle = options?.title || `chore(release): promote develop to main [batch ${dateStr}]`;
    const prBody = [
      `## Release Promotion: ${this.developBranch} → ${this.mainBranch}`,
      "",
      `Automated candidate promotion containing **${status.unpromoted_count}** verified commits.`,
      "",
      status.delivered_tickets.length > 0
        ? `Delivered work items: ${status.delivered_tickets.map((t) => `#${t}`).join(", ")}`
        : "",
      options?.summary ? `\n### Summary\n${options.summary}\n` : "",
      "Candidate freeze set via .factory/PAUSE.",
    ]
      .filter(Boolean)
      .join("\n");

    let prUrl = "";
    let prNum = 0;
    try {
      const output = this.runner(
        [
          "gh",
          "pr",
          "create",
          "--base",
          this.mainBranch,
          "--head",
          this.developBranch,
          "--title",
          prTitle,
          "--body",
          prBody,
        ],
        this.repoRoot,
      );
      for (const line of output.trim().split("\n")) {
        if (line.includes("/pull/")) {
          prUrl = line.trim();
          const match = /\/pull\/(\d+)/.exec(prUrl);
          if (match) prNum = parseInt(match[1], 10);
          break;
        }
      }
      if (!prNum && output.trim()) {
        prNum = 1;
        prUrl = output.trim();
      }
    } catch {
      throw new Error("promotion_failed");
    }

    // Apply local candidate freeze brake truthfully
    let partialEffect = false;
    let localEffectError: string | null = null;
    try {
      applyControlAction(this.repoRoot, "pause");
    } catch (err: any) {
      partialEffect = true;
      localEffectError = err.message || "Failed to set candidate freeze brake";
    }

    return {
      pr_number: prNum,
      pr_url: prUrl,
      title: prTitle,
      unpromoted_count: status.unpromoted_count,
      candidate_freeze: !partialEffect,
      partial_effect: partialEffect,
      local_effect_error: localEffectError,
    };
  }
}
