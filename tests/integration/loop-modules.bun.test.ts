import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import {
  readArchonConfig,
  resolveModelTier,
  resolveModelForRole,
  resolveProviderForRole,
  resolveEffortForRole,
  resolveRoleConfig,
  SUPPORTED_PROVIDERS,
  EFFORT_LADDER,
  isEffortRung,
  clampEffort,
  PROVIDER_EFFORT_VOCABULARIES,
  getProviderDescriptor,
  isSupportedProvider,
  buildProviderArgv,
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
  runSchedulerTick,
  startSchedulerLoop,
  filterAdmittedIssues,
  isWithinWorkWindow,
  type BacklogCandidate,
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

test("10. Scheduler: evaluates brakes, work window, capacity slots, dependency admission, and autonomous dispatch", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "scheduler-"));
  tempDirs.push(tmp);

  // 1. Test Work Window logic
  const overnightWindow = {
    enabled: true,
    start_time: "20:00",
    end_time: "05:00",
    timezone: "UTC",
  };
  const atNight = new Date("2026-10-29T22:30:00Z");
  const inMorning = new Date("2026-10-29T10:00:00Z");
  expect(isWithinWorkWindow(overnightWindow, atNight)).toBe(true);
  expect(isWithinWorkWindow(overnightWindow, inMorning)).toBe(false);

  // 2. Test Issue Admission & Dependency Gating
  const candidates: BacklogCandidate[] = [
    {
      number: 1,
      title: "Closed ticket",
      state: "CLOSED",
      labels: ["ready-for-agent"],
      dependencies: [],
    },
    {
      number: 2,
      title: "No ready label",
      state: "OPEN",
      labels: ["bug"],
      dependencies: [],
    },
    {
      number: 3,
      title: "Has blocker",
      state: "OPEN",
      labels: ["ready-for-agent", "needs-info"],
      dependencies: [],
    },
    {
      number: 4,
      title: "Blocked by open #5",
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [5],
    },
    {
      number: 5,
      title: "Unblocked issue",
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [1], // Dep #1 is closed!
    },
    {
      number: 6,
      title: "Has active claim",
      state: "OPEN",
      labels: ["ready-for-agent"],
      dependencies: [],
      activeClaim: true,
    },
  ];

  const closedSet = new Set([1]);
  const admitted = filterAdmittedIssues(candidates, closedSet);
  expect(admitted).toHaveLength(1);
  expect(admitted[0]!.number).toBe(5);

  // 3. Test Brakes
  await mkdir(join(tmp, ".factory"), { recursive: true });
  await Bun.write(join(tmp, ".factory", "PAUSE"), "drain");

  let launched = false;
  const dummyLaunch = async (issue: BacklogCandidate) => {
    launched = true;
    return { runId: `run-${issue.number}` };
  };

  const pausedRes = await runSchedulerTick({
    root: tmp,
    fetchBacklog: async () => ({ issues: candidates, closedNumbers: closedSet }),
    launchLap: dummyLaunch,
  });
  expect(pausedRes.action).toBe("skipped");
  expect(pausedRes.reason).toBe("pause_brake_set");
  expect(launched).toBe(false);

  // Remove PAUSE brake
  await rm(join(tmp, ".factory", "PAUSE"));

  // 4. Test Capacity full
  const runsDir = join(tmp, "runs");
  await mkdir(join(runsDir, "run-1"), { recursive: true });
  await Bun.write(join(runsDir, "run-1", "state.json"), JSON.stringify({ status: "building" }));

  const capRes = await runSchedulerTick({
    root: tmp,
    runsDir,
    config: { parallel: 1 },
    fetchBacklog: async () => ({ issues: candidates, closedNumbers: closedSet }),
    launchLap: dummyLaunch,
  });
  expect(capRes.action).toBe("skipped");
  expect(capRes.reason).toBe("capacity_full");
  expect(capRes.activeLapsCount).toBe(1);
  expect(launched).toBe(false);

  // 5. Test Successful Autonomous Launch
  const successRes = await runSchedulerTick({
    root: tmp,
    runsDir,
    config: { parallel: 2 }, // Allow up to 2 parallel laps
    fetchBacklog: async () => ({ issues: candidates, closedNumbers: closedSet }),
    launchLap: dummyLaunch,
  });
  expect(successRes.action).toBe("launched");
  expect(successRes.reason).toBe("launch_successful");
  expect(successRes.targetIssueNumber).toBe(5);
  expect(successRes.runId).toBe("run-5");
  expect(launched).toBe(true);

  // 6. Test startSchedulerLoop lifecycle
  let loopTickCount = 0;
  const loop = startSchedulerLoop({
    root: tmp,
    runsDir,
    config: { parallel: 2 },
    intervalMs: 10,
    fetchBacklog: async () => ({ issues: candidates, closedNumbers: closedSet }),
    launchLap: dummyLaunch,
    onTick: () => {
      loopTickCount++;
    },
  });

  await Bun.sleep(35);
  loop.stop();
  await loop.done;
  expect(loopTickCount).toBeGreaterThanOrEqual(1);
});

test("11. Multiple Provider Harness Support: resolves and formats argv for Pi, Claude Code, Codex, OpenCode, and Copilot", () => {
  const root = join(import.meta.dir, "../..");

  // 1. Check supported provider enumeration
  expect(SUPPORTED_PROVIDERS).toContain("pi");
  expect(SUPPORTED_PROVIDERS).toContain("claude");
  expect(SUPPORTED_PROVIDERS).toContain("codex");
  expect(SUPPORTED_PROVIDERS).toContain("opencode");
  expect(SUPPORTED_PROVIDERS).toContain("copilot");

  expect(isSupportedProvider("claude")).toBe(true);
  expect(isSupportedProvider("unknown-agent")).toBe(false);

  // 2. Check provider descriptors
  const claudeDesc = getProviderDescriptor("claude");
  expect(claudeDesc.displayName).toBe("Claude Code");
  expect(claudeDesc.builtIn).toBe(true);
  expect(claudeDesc.capabilities.nativeTools).toBe(true);

  const piDesc = getProviderDescriptor("pi");
  expect(piDesc.displayName).toBe("Pi");
  expect(piDesc.capabilities.sessionResume).toBe(true);

  // 3. Provider resolution from repository config
  const roleProvider = resolveProviderForRole(root, "reviewer");
  expect(roleProvider).toBe("pi");

  const roleConfig = resolveRoleConfig(root, "reviewer");
  expect(roleConfig.provider).toBe("pi");
  expect(roleConfig.model).toBe("router/cx/gpt-6.1-sol");

  // 4. Argv formatting across all harnesses
  const prompt = "Solve issue 99";
  const model = "gpt-5";

  // Pi argv
  const piArgv = buildProviderArgv("pi", { prompt, model, sessionDir: "/tmp/session" });
  expect(piArgv[0]).toBe("pi");
  expect(piArgv).toContain("--session-dir");
  expect(piArgv).toContain("--model");
  expect(piArgv).toContain("gpt-5");
  expect(piArgv[piArgv.length - 1]).toBe(prompt);

  // Claude Code argv
  const claudeArgv = buildProviderArgv("claude", { prompt, model });
  expect(claudeArgv[0]).toBe("claude");
  expect(claudeArgv).toContain("--output-format");
  expect(claudeArgv).toContain("json");
  expect(claudeArgv).toContain("-p");
  expect(claudeArgv).toContain(prompt);

  // Codex argv
  const codexArgv = buildProviderArgv("codex", { prompt, model });
  expect(codexArgv[0]).toBe("codex");
  expect(codexArgv).toContain("exec");
  expect(codexArgv).toContain("--json");
  expect(codexArgv).toContain("--prompt");

  // OpenCode argv
  const opencodeArgv = buildProviderArgv("opencode", { prompt, model });
  expect(opencodeArgv[0]).toBe("opencode");
  expect(opencodeArgv).toContain("run");
  expect(opencodeArgv).toContain("--format");

  // GitHub Copilot argv
  const copilotArgv = buildProviderArgv("copilot", { prompt, model });
  expect(copilotArgv[0]).toBe("copilot");
  expect(copilotArgv).toContain("--output-format");
  expect(copilotArgv).toContain("json");

  // 5. Reasoning Effort configuration, clamping, and flag formatting
  const reviewerEffort = resolveEffortForRole(root, "reviewer");
  expect(reviewerEffort).toBe("high");

  const qaEffort = resolveEffortForRole(root, "qa");
  expect(qaEffort).toBe("medium");

  const builderEffort = resolveEffortForRole(root, "builder");
  expect(builderEffort).toBe("high");

  expect(EFFORT_LADDER).toContain("minimal");
  expect(EFFORT_LADDER).toContain("max");
  expect(EFFORT_LADDER).toContain("ultra");
  expect(isEffortRung("high")).toBe(true);
  expect(isEffortRung("invalid-rung")).toBe(false);

  // Clamping down to weaker supported rung:
  expect(clampEffort("ultra", PROVIDER_EFFORT_VOCABULARIES.pi)).toBe("max");
  expect(clampEffort("persistent", PROVIDER_EFFORT_VOCABULARIES.codex)).toBe("ultra");
  expect(clampEffort("max", PROVIDER_EFFORT_VOCABULARIES.copilot)).toBe("xhigh");

  // Provider argv with reasoning effort
  const piWithEffort = buildProviderArgv("pi", { prompt, model, effort: "high" });
  expect(piWithEffort).toContain("--thinking");
  expect(piWithEffort).toContain("high");

  const claudeWithEffort = buildProviderArgv("claude", { prompt, model, effort: "high" });
  expect(claudeWithEffort).toContain("--effort");
  expect(claudeWithEffort).toContain("high");

  const codexWithEffort = buildProviderArgv("codex", { prompt, model, effort: "ultra" });
  expect(codexWithEffort).toContain("--effort");
  expect(codexWithEffort).toContain("ultra");
});
