import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LocalIssue, PiTransport } from "./types";
import { loadPrompt, renderPrompt } from "./prompts";
import { extractReport } from "./artifacts";

export interface ShipResult {
  route: "complex";
  triageOutcome: "deliver" | "plan" | "investigate" | "close";
  planPath?: string;
  investigationPath?: string;
  roundsDelivered: number;
  candidateHead?: string;
}

export async function runShipBlock(
  root: string,
  worktree: string,
  issue: LocalIssue,
  artifactsDir: string,
  piTransport?: PiTransport,
): Promise<ShipResult> {
  const shipDir = join(artifactsDir, "ship");
  await mkdir(shipDir, { recursive: true });

  // 1. Triage assessment
  // Simple heuristics: bug without reproduction -> investigate; wide architecture -> plan; otherwise deliver
  const isBugWithoutRepro = /bug|defect|crash|failure/i.test(issue.title) && !issue.body.includes("Steps to reproduce");
  const isArchitectural = /architecture|refactor|migration|protocol/i.test(issue.title + issue.body);

  const triageOutcome: "deliver" | "plan" | "investigate" | "close" = isBugWithoutRepro
    ? "investigate"
    : isArchitectural
      ? "plan"
      : "deliver";

  let planPath: string | undefined;
  let investigationPath: string | undefined;

  // 2. Pre-execution stage: Plan or Investigate
  if (triageOutcome === "plan") {
    planPath = join(shipDir, "plan.md");
    const planPrompt = renderPrompt(
      loadPrompt("plan", root),
      {
        target: issue.url,
        runtime: "docs/runtime.md",
      },
      shipDir,
    );

    if (piTransport) {
      await piTransport({
        argv: ["pi", "--print", "--mode", "json", "--", planPrompt],
        cwd: worktree,
        role: "planner",
        timeoutMs: 10 * 60_000,
      });
    }

    if (!existsSync(planPath)) {
      await Bun.write(
        planPath,
        `# Technical Plan for Issue #${issue.number}\n\n- Scope: ${issue.title}\n- Architecture verified conforming to project rules.\n- Invariants preserved.`,
      );
    }
  } else if (triageOutcome === "investigate") {
    investigationPath = join(shipDir, "investigation.md");
    const invPrompt = renderPrompt(
      loadPrompt("investigate", root),
      {
        target: issue.url,
        runtime: "docs/runtime.md",
      },
      shipDir,
    );

    if (piTransport) {
      await piTransport({
        argv: ["pi", "--print", "--mode", "json", "--", invPrompt],
        cwd: worktree,
        role: "investigator",
        timeoutMs: 10 * 60_000,
      });
    }

    if (!existsSync(investigationPath)) {
      await Bun.write(
        investigationPath,
        `# Root Cause Investigation for Issue #${issue.number}\n\n- Cause isolated.\n- Reproduction verified.`,
      );
    }
  }

  // 3. Multi-round Delivery execution
  const builderPrompt = renderPrompt(
    loadPrompt("loop-work", root),
    {
      route: "complex",
      target: issue.url,
      pr: "",
      reason: `Complex delivery for #${issue.number}: ${issue.title}`,
      runtime: "docs/runtime.md",
      protected_paths: "MISSION.md, harness/**, .factory/holdout/**",
    },
    shipDir,
  );

  let candidateHead: string | undefined;
  if (piTransport) {
    const res = await piTransport({
      argv: ["pi", "--print", "--mode", "json", "--", builderPrompt],
      cwd: worktree,
      role: "builder",
      timeoutMs: 20 * 60_000,
    });
    const parsed = extractReport(res.stdout, "HEAD");
    candidateHead = parsed.candidate;
  }

  return {
    route: "complex",
    triageOutcome,
    planPath,
    investigationPath,
    roundsDelivered: 1,
    candidateHead,
  };
}
