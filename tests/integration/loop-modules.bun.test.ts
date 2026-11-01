import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

import {
  readAnimusConfig,
  resolveModelTier,
  resolveModelForRole,
  resolveProviderForRole,
  resolveEffortForRole,
  resolveRoleConfig,
  SUPPORTED_PROVIDERS,
  ACTIVE_PROVIDERS,
  COMING_SOON_PROVIDERS,
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
  resolveAllowedSkills,
  resolveLoopExtensions,
  matchRelevantLessons,
  buildCuratedAppendPrompts,
  recordLapAttempt,
  shouldTriggerReflection,
  runPostIssueReflection,
  resolveVerificationProfile,
  getProfileInstructions,
  getIssuesWaitingApproval,
  countActiveLaps,
  type BacklogCandidate,
} from "../../scripts/loop/index";
import { findExistingWorktreeForBranch } from "../../scripts/local-loop";

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

  const cfg = readAnimusConfig(root);
  expect(cfg.assistant).toBe("pi");
  expect(cfg.tiers?.large?.model).toBeDefined();

  const reviewerModel = resolveModelForRole(root, "reviewer");
  expect(reviewerModel).toBe(cfg.aliases?.["@reasoning"]?.model ?? cfg.tiers?.large?.model);
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

  const greenfieldTickets = slicePrdDeterministic(prd, 5, { includeFoundationSlice: true });
  expect(greenfieldTickets).toHaveLength(3);
  expect(greenfieldTickets[0]!.key).toBe("architecture-and-shared-primitives");
  expect(greenfieldTickets[1]!.depends_on).toEqual(["architecture-and-shared-primitives"]);
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
  expect(SUPPORTED_PROVIDERS).toContain("omp");
  expect(SUPPORTED_PROVIDERS).toContain("codex");
  expect(SUPPORTED_PROVIDERS).toContain("opencode");
  expect(SUPPORTED_PROVIDERS).not.toContain("copilot");

  expect(ACTIVE_PROVIDERS).toEqual(["pi", "claude", "omp"]);
  expect(COMING_SOON_PROVIDERS).toEqual(["codex", "opencode"]);

  expect(isSupportedProvider("claude")).toBe(true);
  expect(isSupportedProvider("omp")).toBe(true);
  expect(isSupportedProvider("unknown-agent")).toBe(false);

  // 2. Check provider descriptors
  const claudeDesc = getProviderDescriptor("claude");
  expect(claudeDesc.displayName).toBe("Claude Code");
  expect(claudeDesc.builtIn).toBe(true);
  expect(claudeDesc.status).toBe("active");
  expect(claudeDesc.capabilities.nativeTools).toBe(true);

  const piDesc = getProviderDescriptor("pi");
  expect(piDesc.displayName).toBe("Pi");
  expect(piDesc.status).toBe("active");
  expect(piDesc.capabilities.sessionResume).toBe(true);

  const ompDesc = getProviderDescriptor("omp");
  expect(ompDesc.displayName).toBe("Oh-My-Pi (OMP)");
  expect(ompDesc.status).toBe("active");
  expect(ompDesc.capabilities.nativeTools).toBe(true);

  const codexDesc = getProviderDescriptor("codex");
  expect(codexDesc.status).toBe("coming_soon");

  const opencodeDesc = getProviderDescriptor("opencode");
  expect(opencodeDesc.status).toBe("coming_soon");

  // 3. Provider resolution from repository config
  const roleProvider = resolveProviderForRole(root, "reviewer");
  expect(roleProvider).toBe("pi");

  const roleConfig = resolveRoleConfig(root, "reviewer");
  expect(roleConfig.provider).toBe("pi");
  expect(roleConfig.model).toBe(resolveModelForRole(root, "reviewer"));
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

  // OMP argv
  const ompArgv = buildProviderArgv("omp", { prompt, model, sessionDir: "/tmp/session" });
  expect(ompArgv[0]).toBe("omp");
  expect(ompArgv).toContain("--session-dir");
  expect(ompArgv).toContain("--model");
  expect(ompArgv).toContain("gpt-5");
  expect(ompArgv).toContain("--auto-approve");
  expect(ompArgv[ompArgv.length - 1]).toBe(prompt);

  // Codex argv
  const codexArgv = buildProviderArgv("codex", { prompt, model });
  expect(codexArgv[0]).toBe("codex");
  expect(codexArgv).toContain("exec");
  expect(codexArgv).toContain("--json");
  expect(codexArgv).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(codexArgv[codexArgv.length - 1]).toBe(prompt);

  // OpenCode argv
  const opencodeArgv = buildProviderArgv("opencode", { prompt, model });
  expect(opencodeArgv[0]).toBe("opencode");
  expect(opencodeArgv).toContain("run");
  expect(opencodeArgv).toContain("--format");
  expect(opencodeArgv).toContain("json");
  expect(opencodeArgv).toContain("--auto");
  expect(opencodeArgv).toContain("--standalone");
  expect(opencodeArgv[opencodeArgv.length - 1]).toBe(prompt);

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

  // Provider argv with reasoning effort
  const piWithEffort = buildProviderArgv("pi", { prompt, model, effort: "high" });
  expect(piWithEffort).toContain("--thinking");
  expect(piWithEffort).toContain("high");

  const claudeWithEffort = buildProviderArgv("claude", { prompt, model, effort: "high" });
  expect(claudeWithEffort).toContain("--effort");
  expect(claudeWithEffort).toContain("high");

  const codexWithEffort = buildProviderArgv("codex", { prompt, model, effort: "ultra" });
  expect(codexWithEffort).toContain("-c");
  expect(codexWithEffort).toContain('model_reasoning_effort="ultra"');
});

test("post-loop self-improving harness: curated injection, dossier terminal trigger, Jev curation, and skill promotion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-evolution-"));
  try {
    mkdirSync(join(dir, ".factory/hooks"), { recursive: true });
    mkdirSync(join(dir, ".agents/skills/tdd"), { recursive: true });
    mkdirSync(join(dir, ".agents/skills/animus-harness"), { recursive: true });
    mkdirSync(join(dir, ".agents/skills/writing-for-agents"), { recursive: true });
    mkdirSync(join(dir, ".agents/skills/skill-creator"), { recursive: true });
    writeFileSync(
      join(dir, ".agents/skills/tdd/SKILL.md"),
      "---\nname: tdd\ndescription: test\n---\n",
    );
    writeFileSync(
      join(dir, ".agents/skills/animus-harness/SKILL.md"),
      "---\nname: animus-harness\ndescription: harness\n---\n",
    );
    writeFileSync(
      join(dir, ".agents/skills/writing-for-agents/SKILL.md"),
      "---\nname: writing-for-agents\ndescription: writing\n---\n",
    );
    writeFileSync(
      join(dir, ".agents/skills/skill-creator/SKILL.md"),
      "---\nname: skill-creator\ndescription: creator\n---\n",
    );
    writeFileSync(join(dir, ".factory/hooks/loop-guard.ts"), "export default function() {}");
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Instructions\n- Post-lap memory & lesson synthesis: `/animus-harness`\n",
    );
    writeFileSync(
      join(dir, ".factory/lessons.jsonl"),
      JSON.stringify({
        id: "lsn-20261028-01",
        topic: "port-binding",
        trigger_patterns: ["apps/backend/*"],
        rule: "Assign an explicit non-zero port before passing FACTORY_HOST_URL.",
        evidence: "Lap #1 failed on port 0.",
        vetoed: false,
        occurrence_count: 2,
        created_at: "2026-10-28T00:00:00Z",
      }) + "\n",
    );

    // 1. Curated hermetic injection
    const builderSkills = resolveAllowedSkills(dir, "builder");
    expect(builderSkills.some((s) => s.endsWith(".agents/skills/tdd"))).toBe(true);

    const reflectorSkills = resolveAllowedSkills(dir, "reflector");
    expect(reflectorSkills.some((s) => s.endsWith("animus-harness"))).toBe(true);
    expect(reflectorSkills.some((s) => s.endsWith("writing-for-agents"))).toBe(true);
    expect(reflectorSkills.some((s) => s.endsWith("skill-creator"))).toBe(true);

    const exts = resolveLoopExtensions(dir);
    expect(exts).toHaveLength(1);

    // Verify deterministic codebase-rules.json enforcement in loop-guard.ts
    const { evaluateCodebaseRulesOnEdit } = await import("../../.factory/hooks/loop-guard");
    writeFileSync(
      join(dir, ".factory/codebase-rules.json"),
      JSON.stringify({
        rules: [
          {
            id: "no-explicit-any-in-features",
            description: "Avoid explicit any in feature components",
            file_glob: "src/features/**/*.tsx",
            forbid_regex: ":\\s*any\\b",
            replacement_hint: "Import or define explicit domain types in types.ts",
            mode: "block",
          },
          {
            id: "use-canonical-form-field",
            description: "Raw <input> inside feature forms is forbidden",
            file_glob: "src/features/**/*Form*.tsx",
            forbid_regex: "<input\\b",
            replacement_hint: "Use <FormField /> with TanStack Form useAppForm() hook",
            mode: "block",
          },
        ],
      }),
    );

    const anyCheck = evaluateCodebaseRulesOnEdit(
      dir,
      "src/features/users/UserForm.tsx",
      "export function UserForm(props: any) { return <input />; }",
    );
    expect(anyCheck.blocked).toBe(true);
    expect(anyCheck.reasons).toHaveLength(2);
    expect(anyCheck.reasons[0]).toContain("no-explicit-any-in-features");
    expect(anyCheck.reasons[1]).toContain("use-canonical-form-field");

    const matched = matchRelevantLessons(dir, ["apps/backend/src/config.ts"]);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.topic).toBe("port-binding");

    const appendPrompts = buildCuratedAppendPrompts(
      dir,
      {
        number: 42,
        url: "https://github.com/org/repo/issues/42",
        title: "Fix backend config",
        body: "Touches apps/backend/src/config.ts",
        comments: [],
        dependencies: [],
        activeClaim: false,
      },
      "apps/backend/src/config.ts",
    );
    expect(appendPrompts.length).toBeGreaterThanOrEqual(2);

    const argv = buildProviderArgv("pi", {
      prompt: "do work",
      skills: builderSkills,
      extensions: exts,
      appendSystemPrompts: appendPrompts,
    });
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--skill");
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("-e");
    expect(argv).toContain("--no-context-files");
    expect(argv).toContain("--append-system-prompt");

    // 2. Dossier & Contrastive Terminal Trigger
    const stateRoot = join(dir, ".factory-local-loop");
    const meta = {
      issueNumber: 42,
      issueTitle: "Fix backend config",
      issueUrl: "https://github.com/org/repo/issues/42",
      branch: "local-loop/issue-42",
    };

    // Lap 0: Sent back -> should NOT trigger reflection yet (waiting for resolution or exhaustion)
    const dossierAfterLap0 = recordLapAttempt(stateRoot, meta, {
      runId: "run-0",
      timestamp: "2026-10-29T01:00:00Z",
      status: "sent_back",
      changedFiles: ["apps/backend/src/config.ts"],
      failedStage: "reviewer",
      reviewFindings: ["Port 0 causes crash"],
      qaFailures: [],
    });
    expect(shouldTriggerReflection(dossierAfterLap0, { maxRejections: 2 })).toBe(false);

    // Lap 1: Approved after prior failure -> SHOULD trigger contrastive reflection!
    const dossierAfterLap1 = recordLapAttempt(stateRoot, meta, {
      runId: "run-1",
      timestamp: "2026-10-29T01:10:00Z",
      status: "waiting_approval",
      changedFiles: ["apps/backend/src/config.ts"],
      reviewFindings: [],
      qaFailures: [],
    });
    expect(shouldTriggerReflection(dossierAfterLap1, { maxRejections: 2 })).toBe(true);

    // 3. Run Post-Issue Reflection with mock transport & Jev curation
    const reflectionOutcome = await runPostIssueReflection({
      root: dir,
      worktree: dir,
      dossier: dossierAfterLap1,
      artifactsDir: join(dir, "artifacts"),
      transport: async ({ role }) => {
        expect(role).toBe("reflector");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            attribution: "helped",
            tool_guidance_updates: { verify: "bun harness/ci.ts" },
            component_registry_updates: {
              form: "Use useAppForm() and <FormField /> from @/components/ui/form",
            },
            candidate_lessons: [
              {
                topic: "port-binding",
                trigger_patterns: ["apps/launcher/*"],
                rule: "Resolve dynamic port before passing FACTORY_HOST_URL to backend.",
                evidence: "Lap 0 failed with port 0; Lap 1 succeeded with resolved port.",
              },
              {
                topic: "bad-negative-rule",
                trigger_patterns: ["*"],
                rule: "Do not ever write bad code in this repo.",
                evidence: "Guess",
              },
            ],
            skill_promotion: {
              skill_name: "port-resolution",
              description:
                "Use when configuring dynamic ports across launcher and backend services.",
              agents_md_pointer:
                "- When configuring dynamic ports across launcher and backend, read `.agents/skills/port-resolution/SKILL.md`.",
              skill_markdown:
                "---\nname: port-resolution\ndescription: Use when configuring dynamic ports.\n---\n\n# Port Resolution\n\n## Steps\n1. Bind port.\n   *Completion Criterion*: Port is > 0.\n",
            },
          }),
          stderr: "",
        };
      },
    });

    expect(reflectionOutcome.triggered).toBe(true);
    expect(reflectionOutcome.persistedLessons).toHaveLength(1);
    expect(reflectionOutcome.persistedLessons[0]?.occurrence_count).toBe(3); // Incremented from 2 -> 3
    expect(reflectionOutcome.rejectedLessons).toHaveLength(1); // Rejected negative phrasing rule
    expect(reflectionOutcome.updatedTools).toEqual(["verify"]);
    expect(reflectionOutcome.updatedComponents).toEqual(["form"]);
    expect(reflectionOutcome.promotedSkill?.skillName).toBe("port-resolution");
    expect(existsSync(join(dir, ".agents/skills/port-resolution/SKILL.md"))).toBe(true);
    const promotedSkillContent = readFileSync(
      join(dir, ".agents/skills/port-resolution/SKILL.md"),
      "utf-8",
    );
    expect(promotedSkillContent).toContain("origin: learned");

    // Promoted skill without disable-model-invocation is dynamically exposed to builder on next lap
    const builderSkillsAfterPromotion = resolveAllowedSkills(dir, "builder");
    expect(
      builderSkillsAfterPromotion.some((s) => s.endsWith(".agents/skills/port-resolution")),
    ).toBe(true);

    const updatedAgentsMd = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(updatedAgentsMd).toContain("port-resolution");
    expect(updatedAgentsMd.split("\n").length).toBeLessThanOrEqual(150);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("13. Verification Profiles: resolves appropriate profile and generates tuned instructions", () => {
  const root = join(import.meta.dir, "../..");

  // Explicit label: docs
  const docsIssue = {
    number: 101,
    url: "https://github.com/org/repo/issues/101",
    title: "Update API guide",
    body: "Please update docs",
    comments: [],
    dependencies: [],
    activeClaim: false,
    labels: ["profile:docs"],
  };
  expect(resolveVerificationProfile(docsIssue)).toBe("docs");
  const docsInst = getProfileInstructions("docs", root);
  expect(docsInst.depth).toBe("light");
  expect(docsInst.skipAppLaunch).toBe(true);
  expect(docsInst.runtimeInstructions).toContain("Documentation only");

  // Body directive: api
  const apiIssue = {
    number: 102,
    url: "https://github.com/org/repo/issues/102",
    title: "Add GET /api/v1/healthcheck endpoint",
    body: "Verification Profile: api\nImplement new endpoint",
    comments: [],
    dependencies: [],
    activeClaim: false,
    labels: [],
  };
  expect(resolveVerificationProfile(apiIssue)).toBe("api");
  const apiInst = getProfileInstructions("api", root);
  expect(apiInst.depth).toBe("normal");
  expect(apiInst.skipAppLaunch).toBe(false);
  expect(apiInst.runtimeInstructions).toContain("HTTP requests or curl");

  // Changed files: UI
  const genericIssue = {
    number: 103,
    url: "https://github.com/org/repo/issues/103",
    title: "Change button styling",
    body: "Make the button red",
    comments: [],
    dependencies: [],
    activeClaim: false,
    labels: [],
  };
  expect(
    resolveVerificationProfile(genericIssue, [
      "apps/web/src/Button.tsx",
      "apps/web/src/button.css",
    ]),
  ).toBe("ui");
  const uiInst = getProfileInstructions("ui", root);
  expect(uiInst.depth).toBe("normal");
  expect(uiInst.skipAppLaunch).toBe(false);
  expect(uiInst.runtimeInstructions).toContain("Frontend / UI change");
  expect(uiInst.runtimeInstructions).toContain("1440px");
  expect(uiInst.runtimeInstructions).toContain("390px");
  expect(uiInst.runtimeInstructions).toContain(".agents/skills/ui-quality/SKILL.md");

  const repoBuilderSkills = resolveAllowedSkills(root, "builder");
  expect(repoBuilderSkills.some((s) => s.endsWith(".agents/skills/unstick"))).toBe(true);
  expect(repoBuilderSkills.some((s) => s.endsWith(".agents/skills/blueprint"))).toBe(true);
  expect(repoBuilderSkills.some((s) => s.endsWith(".agents/skills/ui-quality"))).toBe(true);
  expect(
    repoBuilderSkills.some((s) => s.endsWith(".agents/skills/policy-verifier-regressions")),
  ).toBe(true);
  expect(repoBuilderSkills.some((s) => s.endsWith(".agents/skills/animus-brainstorm"))).toBe(false);
  expect(repoBuilderSkills.some((s) => s.endsWith(".agents/skills/animus-grill"))).toBe(false);
  expect(repoBuilderSkills.some((s) => s.endsWith(".agents/skills/animus-architecture"))).toBe(
    false,
  );

  for (const stageSkill of ["animus-brainstorm", "animus-grill", "animus-architecture"] as const) {
    const skillText = readFileSync(join(root, ".agents/skills", stageSkill, "SKILL.md"), "utf-8");
    expect(skillText).toContain("disable-model-invocation: true");
    expect(skillText).toContain("## When to Use");
    expect(skillText).toContain("## Steps");
    expect(skillText).toContain("*Completion Criterion*:");
  }

  const repoQaSkills = resolveAllowedSkills(root, "qa");
  expect(repoQaSkills.some((s) => s.endsWith(".agents/skills/ui-quality"))).toBe(true);

  const repoPlannerSkills = resolveAllowedSkills(root, "planner");
  expect(repoPlannerSkills.some((s) => s.endsWith(".agents/skills/blueprint"))).toBe(true);

  // Core auth / security
  const secIssue = {
    number: 104,
    url: "https://github.com/org/repo/issues/104",
    title: "Rotate auth JWT signature secret",
    body: "Update session token auth validation",
    comments: [],
    dependencies: [],
    activeClaim: false,
    labels: ["security"],
  };
  expect(resolveVerificationProfile(secIssue)).toBe("core");
  const coreInst = getProfileInstructions("core", root);
  expect(coreInst.depth).toBe("deep");
  expect(coreInst.skipAppLaunch).toBe(false);
  expect(coreInst.runtimeInstructions).toContain("Probe security");
});

test("14. Scheduler waiting_approval protection: prevents re-dispatching delivered items awaiting human review", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "scheduler-waiting-"));
  try {
    const runsDir = join(tmp, "runs");
    mkdirSync(join(runsDir, "run-99"), { recursive: true });
    writeFileSync(
      join(runsDir, "run-99", "state.json"),
      JSON.stringify({
        runId: "run-99",
        issue: "https://github.com/org/repo/issues/99",
        status: "waiting_approval",
      }),
    );

    mkdirSync(join(runsDir, "interrupted-98"));
    writeFileSync(
      join(runsDir, "interrupted-98", "state.json"),
      JSON.stringify({ issue: "https://github.com/org/repo/issues/98", status: "interrupted" }),
    );
    const waitingSet = getIssuesWaitingApproval(runsDir);
    expect(waitingSet.has(99)).toBe(true);
    expect(waitingSet.has(98)).toBe(true);

    const candidates: BacklogCandidate[] = [
      {
        number: 98,
        title: "Interrupted work preserved for manual resumption",
        state: "OPEN",
        labels: ["ready-for-agent"],
        dependencies: [],
      },
      {
        number: 99,
        title: "Feature 99 awaiting human approval",
        state: "OPEN",
        labels: ["ready-for-agent"],
        dependencies: [],
      },
      {
        number: 100,
        title: "Next unblocked feature",
        state: "OPEN",
        labels: ["ready-for-agent"],
        dependencies: [],
      },
    ];

    const admitted = filterAdmittedIssues(candidates, new Set(), {
      waitingApprovalIssueNumbers: waitingSet,
    });
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.number).toBe(100); // 99 is cleanly skipped!
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("15. Scheduler capacity liveness: ignores abandoned runs with dead PIDs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "scheduler-liveness-"));
  try {
    const runsDir = join(tmp, "runs");
    await mkdir(join(runsDir, "run-alive"), { recursive: true });
    await mkdir(join(runsDir, "run-dead"), { recursive: true });
    await mkdir(join(runsDir, "run-no-pid"), { recursive: true });

    // Current process is alive
    await Bun.write(
      join(runsDir, "run-alive", "state.json"),
      JSON.stringify({ status: "building", pid: process.pid }),
    );
    // PID 9999999 is definitely dead
    await Bun.write(
      join(runsDir, "run-dead", "state.json"),
      JSON.stringify({ status: "building", pid: 9999999 }),
    );
    // Backward compatibility for runs without pid
    await Bun.write(
      join(runsDir, "run-no-pid", "state.json"),
      JSON.stringify({ status: "building" }),
    );

    const active = countActiveLaps(runsDir);
    expect(active).toBe(2); // run-alive and run-no-pid, dead run is omitted
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("16. Worktree reuse: finds existing worktree holding branch ref", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "worktree-reuse-test-"));
  try {
    const repo = join(tmp, "repo");
    const extraWorktree = join(tmp, "extra-tree");
    await mkdir(repo, { recursive: true });

    await Bun.spawn(["git", "init", "-b", "main"], { cwd: repo }).exited;
    await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: repo }).exited;
    await Bun.spawn(["git", "config", "user.email", "test@test.local"], { cwd: repo }).exited;
    await Bun.write(join(repo, "README.md"), "test");
    await Bun.spawn(["git", "add", "README.md"], { cwd: repo }).exited;
    await Bun.spawn(["git", "commit", "-m", "init"], { cwd: repo }).exited;

    await Bun.spawn(["git", "branch", "feature-x"], { cwd: repo }).exited;
    await Bun.spawn(["git", "worktree", "add", extraWorktree, "feature-x"], { cwd: repo }).exited;

    const found = await findExistingWorktreeForBranch(repo, "feature-x");
    expect(found).not.toBeNull();
    expect(existsSync(found!)).toBe(true);

    const nonExistent = await findExistingWorktreeForBranch(repo, "non-existent-branch-123456");
    expect(nonExistent).toBeNull();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("17. Scheduler needs_owner escalation: prevents re-dispatching items escalated to owner", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "scheduler-needs-owner-"));
  try {
    const runsDir = join(tmp, "runs");
    await mkdir(join(runsDir, "run-escalated"), { recursive: true });
    writeFileSync(
      join(runsDir, "run-escalated", "state.json"),
      JSON.stringify({
        runId: "run-escalated",
        issue: "https://github.com/org/repo/issues/85",
        status: "needs_owner",
      }),
    );
    const waitingSet = getIssuesWaitingApproval(runsDir);
    expect(waitingSet.has(85)).toBe(true);

    const candidates: BacklogCandidate[] = [
      {
        number: 85,
        title: "Escalated feature",
        state: "OPEN",
        labels: ["ready-for-agent"],
        dependencies: [],
      },
      {
        number: 86,
        title: "Next feature",
        state: "OPEN",
        labels: ["ready-for-agent"],
        dependencies: [],
      },
    ];

    const admitted = filterAdmittedIssues(candidates, new Set(), {
      waitingApprovalIssueNumbers: waitingSet,
    });
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.number).toBe(86);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("18. Scheduler dossier max_laps gate: drops candidates whose dossier attempts reached maxLaps", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "scheduler-max-laps-"));
  try {
    const stateRoot = join(tmp, "stateRoot");
    await mkdir(join(stateRoot, "dossiers"), { recursive: true });

    // Create dossier for issue 85 with 3 attempts
    recordLapAttempt(
      stateRoot,
      {
        issueNumber: 85,
        issueTitle: "Feature 85",
        issueUrl: "https://github.com/org/repo/issues/85",
        branch: "local-loop/issue-85-abc",
      },
      {
        runId: "run-1",
        timestamp: new Date().toISOString(),
        status: "sent_back",
        changedFiles: [],
        reviewFindings: ["findings"],
        qaFailures: [],
      },
    );
    recordLapAttempt(
      stateRoot,
      {
        issueNumber: 85,
        issueTitle: "Feature 85",
        issueUrl: "https://github.com/org/repo/issues/85",
        branch: "local-loop/issue-85-abc",
      },
      {
        runId: "run-2",
        timestamp: new Date().toISOString(),
        status: "sent_back",
        changedFiles: [],
        reviewFindings: ["findings"],
        qaFailures: [],
      },
    );
    recordLapAttempt(
      stateRoot,
      {
        issueNumber: 85,
        issueTitle: "Feature 85",
        issueUrl: "https://github.com/org/repo/issues/85",
        branch: "local-loop/issue-85-abc",
      },
      {
        runId: "run-3",
        timestamp: new Date().toISOString(),
        status: "sent_back",
        changedFiles: [],
        reviewFindings: ["findings"],
        qaFailures: [],
      },
    );

    const candidates: BacklogCandidate[] = [
      {
        number: 85,
        title: "Feature 85 with 3 attempts",
        state: "OPEN",
        labels: ["ready-for-agent"],
        dependencies: [],
      },
      {
        number: 86,
        title: "Feature 86 fresh",
        state: "OPEN",
        labels: ["ready-for-agent"],
        dependencies: [],
      },
    ];

    // Filter with maxLaps = 3
    const admitted = filterAdmittedIssues(candidates, new Set(), {
      stateRoot,
      maxLaps: 3,
    });
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.number).toBe(86);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
