import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import {
  readArchonConfig,
  resolveModelTier,
  resolveModelForRole,
  loadPrompt,
  renderPrompt,
  parsePrdSections,
  slicePrdDeterministic,
  parseHoldoutMarkdown,
  writeHoldoutScenarios,
  runManagerPass,
  assessMergeBatchDeterministic,
  analyzeDiffComplexity,
  verifyDeployment,
  auditDiscoveries,
} from "../../scripts/loop/index";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

test("1. Model Tiering: resolves roles to tiers and config models", async () => {
  const root = join(import.meta.dir, "../..");
  expect(resolveModelTier("builder")).toBe("medium");
  expect(resolveModelTier("reviewer")).toBe("large");
  expect(resolveModelTier("qa")).toBe("small");
  expect(resolveModelTier("manager")).toBe("large");

  const cfg = readArchonConfig(root);
  expect(cfg.assistant).toBe("pi");
  expect(cfg.tiers?.large?.model).toBe("router/cx/gpt-6.1-sol");

  const reviewerModel = resolveModelForRole(root, "reviewer");
  expect(reviewerModel).toBe("router/cx/gpt-6.1-sol");
});

test("2. Prompts: loads decoupled markdown files from scripts/prompts and interpolates", () => {
  const root = join(import.meta.dir, "../..");
  const workPrompt = loadPrompt("loop-work", root);
  expect(workPrompt).toContain("# Make the move");

  const qaPrompt = loadPrompt("loop-check-app", root);
  expect(qaPrompt).toContain("# Check the app as a user would");

  const rendered = renderPrompt(
    "Do $INPUTS.route in $ARTIFACTS_DIR",
    { route: "simple" },
    "/artifacts",
  );
  expect(rendered).toBe("Do simple in /artifacts");
});

test("3. Backlog Slicing: decomposes PRD into dependency-ordered issues with contracts", () => {
  const prd = `# Test PRD\n\n## Core Engine\nBuild the engine.\n\n## Web UI\nBuild the web console.\n`;
  const { title, sections } = parsePrdSections(prd);
  expect(title).toBe("Test PRD");
  expect(sections).toHaveLength(2);

  const tickets = slicePrdDeterministic(prd, 5);
  expect(tickets).toHaveLength(2);
  expect(tickets[0]!.key).toBe("core-engine");
  expect(tickets[0]!.depends_on).toEqual([]);
  expect(tickets[1]!.key).toBe("web-ui");
  expect(tickets[1]!.depends_on).toEqual(["core-engine"]);
});

test("4. Holdouts: authors and parses fenced acceptance scenarios", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "holdouts-"));
  tempDirs.push(tmp);
  const prdFile = join(tmp, "PRD.md");
  await Bun.write(prdFile, "# PRD\n\n## User Journey\nUser logs in and checks status.\n");

  const res = await writeHoldoutScenarios(tmp, prdFile, ".factory/holdout/HOLDOUT.md");
  expect(res.count).toBe(1);
  expect(existsSync(res.filePath)).toBe(true);

  const content = await Bun.file(res.filePath).text();
  expect(content).toContain("STRICT ACCESS POLICY");
  const parsed = parseHoldoutMarkdown(content);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]!.id).toBe("H-01");
});

test("5. Manager: sweeps expired locks and logs metrics line", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "manager-"));
  tempDirs.push(tmp);
  const stateRoot = join(tmp, ".factory-local-loop");
  const lock = join(stateRoot, "locks", "issue-99");
  await mkdir(lock, { recursive: true });

  const root = join(import.meta.dir, "../..");
  // Set expiry to 0 to simulate expired lock
  const rep = await runManagerPass(root, stateRoot, 0);
  expect(rep.actions.some((a: { action: string }) => a.action === "released_expired_lock")).toBe(
    true,
  );
  expect(rep.metricsLine).toContain("merged since last pass:");
  expect(existsSync(lock)).toBe(false);
});

test("6. Merge Queue: enforces review approval and protected paths", () => {
  const candidates = [
    {
      number: 10,
      url: "https://github.com/repo/pull/10",
      headSha: "abc",
      changedFiles: ["src/index.ts"],
      reviewApproved: true,
    },
    {
      number: 11,
      url: "https://github.com/repo/pull/11",
      headSha: "def",
      changedFiles: ["MISSION.md"], // Protected path!
      reviewApproved: true,
    },
    {
      number: 12,
      url: "https://github.com/repo/pull/12",
      headSha: "ghi",
      changedFiles: ["src/ui.ts"],
      reviewApproved: false, // Not approved!
    },
  ];

  const plan = assessMergeBatchDeterministic("owner/repo", "main", "sha-base", candidates);
  expect(plan.eligible).toBe(false);
  expect(plan.pull_requests).toHaveLength(1); // Only PR #10 is eligible
  expect(plan.reasons.some((r: string) => r.includes("MISSION.md"))).toBe(true);
  expect(plan.reasons.some((r: string) => r.includes("independent review"))).toBe(true);
});

test("7. Simplify: identifies duplicated helpers and empty catches", () => {
  const diff = `
+function helper() { return 1; }
+function helper() { return 2; }
+try { doWork(); } catch (e) {}
  `;
  const findings = analyzeDiffComplexity(diff);
  expect(findings.length).toBeGreaterThanOrEqual(2);
  expect(
    findings.some((f: { smallerShape: string }) => f.smallerShape.includes("Consolidate helper")),
  ).toBe(true);
  expect(findings.some((f: { smallerShape: string }) => f.smallerShape.includes("catch"))).toBe(
    true,
  );
});

test("8. Deploy: verifies health and candidate match", async () => {
  // Offline mock server test
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("OK", { status: 200 });
      if (url.pathname === "/build-id") return new Response("abc1234567890", { status: 200 });
      return new Response("Not Found", { status: 404 });
    },
  });

  try {
    const res = await verifyDeployment(`http://127.0.0.1:${server.port}`, "abc1234");
    expect(res.healthy).toBe(true);
    expect(res.status).toBe(200);
    expect(res.buildId).toBe("abc1234567890");
    expect(res.matchedHead).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("9. Discoveries: audits repository and prepares discovery records", async () => {
  const root = join(import.meta.dir, "../..");
  const res = await auditDiscoveries(root);
  expect(res.prompt).toContain("Classify discovery proposals");
});
