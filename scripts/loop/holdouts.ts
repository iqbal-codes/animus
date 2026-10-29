import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HoldoutScenario } from "./types";
import { loadPrompt, renderPrompt } from "./prompts";
import { parsePrdSections } from "./backlog";

export function formatHoldoutMarkdown(scenarios: HoldoutScenario[]): string {
  const parts = [
    "# Fenced Acceptance Holdouts",
    "",
    "> **STRICT ACCESS POLICY**: Only holdout-writer and holdout-verifier agents may read this file.",
    "> Builders and general agents are prohibited from reading this document.",
    "",
  ];

  for (const s of scenarios) {
    parts.push(
      `## ${s.id} ${s.title}`,
      `Protects: ${s.protects}`,
      `Touches: ${s.touches}`,
      `Setup: ${s.setup}`,
      `Steps: ${s.steps}`,
      `Expect: ${s.expect}`,
      `Author: ${s.author}`,
      "",
    );
  }

  return parts.join("\n");
}

export function parseHoldoutMarkdown(content: string): HoldoutScenario[] {
  const scenarios: HoldoutScenario[] = [];
  const blocks = content.split(/\n(?=##\s+H-)/);

  for (const block of blocks) {
    const headerMatch = /^##\s+(H-\d+)\s+(.+)$/m.exec(block);
    if (!headerMatch) continue;

    const id = headerMatch[1]!;
    const title = headerMatch[2]!.trim();
    const protects = /^Protects:\s*(.+)$/m.exec(block)?.[1]?.trim() || "";
    const touches = /^Touches:\s*(.+)$/m.exec(block)?.[1]?.trim() || "";
    const setup = /^Setup:\s*(.+)$/m.exec(block)?.[1]?.trim() || "";
    const steps = /^Steps:\s*(.+)$/m.exec(block)?.[1]?.trim() || "";
    const expectVal = /^Expect:\s*(.+)$/m.exec(block)?.[1]?.trim() || "";
    const author = /^Author:\s*(.+)$/m.exec(block)?.[1]?.trim() || "";

    scenarios.push({
      id,
      title,
      protects,
      touches,
      setup,
      steps,
      expect: expectVal,
      author,
    });
  }

  return scenarios;
}

export async function writeHoldoutScenarios(
  root: string,
  prdPath: string,
  holdoutRelPath = ".factory/holdout/HOLDOUT.md",
): Promise<{ count: number; scenarios: HoldoutScenario[]; filePath: string }> {
  const fullPrdPath = resolve(root, prdPath);
  const fullHoldoutPath = resolve(root, holdoutRelPath);

  if (!existsSync(fullPrdPath)) {
    throw new Error(`PRD document not found at ${fullPrdPath}`);
  }

  const content = readFileSync(fullPrdPath, "utf-8");
  const { title, sections } = parsePrdSections(content);
  const scenarios: HoldoutScenario[] = [];

  let idx = 1;
  for (const s of sections) {
    if (/^(non-goals|out of scope|background|overview)/i.test(s.heading)) continue;

    scenarios.push({
      id: `H-0${idx}`,
      title: `${s.heading} end-to-end user verification`,
      protects: `${title} Section: ${s.heading}`,
      touches: s.heading.toLowerCase(),
      setup: "Clean running test environment on localhost origin",
      steps: `Execute end-to-end user workflow for ${s.heading}`,
      expect: `System fulfills all stated requirements for ${s.heading} with 0 unhandled errors`,
      author: `writer, ${new Date().toISOString().slice(0, 10)}, initial product authoring`,
    });
    idx++;
  }

  await mkdir(dirname(fullHoldoutPath), { recursive: true });
  await Bun.write(fullHoldoutPath, formatHoldoutMarkdown(scenarios));

  return {
    count: scenarios.length,
    scenarios,
    filePath: fullHoldoutPath,
  };
}

export function buildVerifierPrompt(
  root: string,
  holdoutPath: string,
  targetWorktree: string,
  baseCommit: string,
  artifactsDir: string,
): string {
  const template = loadPrompt("holdout-verifier", root);
  return renderPrompt(
    template,
    {
      scenarios: holdoutPath,
      target: targetWorktree,
      base: baseCommit,
      scope: "all",
      runtime: "docs/runtime.md",
    },
    artifactsDir,
  );
}
